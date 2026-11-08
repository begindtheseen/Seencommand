// THE GATE — one definition of "green", for every path that ships code.
//
// There were six: the builder's tool and product gates, self-update, pr-rescue, base-health, the agentic
// coder's own test runner and the intelligence slice's — each spawning `node --test` with its own
// environment, timeout and idea of which files count. A safeguard added to one protected that one. This
// module owns the steps; callers choose a profile, never re-implement a step.
//
// Order, cheapest and most specific first, so the coder is told the most actionable thing:
//   syntax → fence → lint (phantom references) → structure (wiring, schema, routes) → types →
//   tests → proof (the focused test must FAIL without the change) → production build
//
// FAIL CLOSED. A step that cannot run is not a step that passed. A missing TypeScript toolchain, a
// disabled production build, a check that threw: each is reported, never silently skipped. Steps an
// operator switched off are returned in `unproven` — a gate can be green AND unproven, and the builder
// will not push an unproven change.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { lintDiff } from './lint.mjs';
import { wiringErrors } from './wiring.mjs';
import { schemaErrors } from './schema-refs.mjs';
import { routeErrors } from './route-refs.mjs';
import { isSource, isTest } from './code-graph.mjs';
import { codeLines } from './semantic-gate.mjs';

export function listFiles(root, exclude, acc = [], base = root) {
  for (const name of readdirSync(root)) {
    if (exclude.includes(name)) continue;
    const full = join(root, name);
    let s; try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) listFiles(full, exclude, acc, base);
    else acc.push(relative(base, full));
  }
  return acc;
}

// A source file whose FIRST line is a markdown code fence is a coder artifact that reached disk. The
// NEWFILE de-fencing in coder.mjs strips these at write time; this is the cheap, deterministic backstop
// that also catches the EDIT path, and runs in EVERY gate (no subprocess). No real source file begins
// with a ``` fence. Only compiled sources are checked — .md is excluded (it isn't compiled and may
// legitimately lead with a fence).
const FENCE_LINE = /^\s*`{3,}[\w-]*\s*$/;
export function fenceErrors(repoRoot, touched) {
  const errors = [];
  for (const f of touched.filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))) {
    let first = '';
    try { first = readFileSync(join(repoRoot, f), 'utf8').split('\n', 1)[0] || ''; } catch { continue; }
    if (FENCE_LINE.test(first)) errors.push(`FENCE ${f}: first line is a markdown code fence (\`${first.trim().slice(0, 24)}\`) — a source file must never begin with a \`\`\` fence; strip the coder's wrapper (Seen #194)`);
  }
  return errors;
}

// STRUCTURE, before tests — both gates, identically. A green suite proves nothing is broken; these prove
// the change is CONNECTED: every new callable export has a real caller, no integration was deleted out
// from under a still-tested helper (wiring.mjs), no code calls a database function the schema does not
// have (schema-refs.mjs), and no link points at a page that does not exist (route-refs.mjs). Cheap, deterministic, and fed back into the coder's retry loop by name.
// `partial` — the change is ONE STEP of a larger plan (Forge builds logic first, its test and its caller in
// later steps). "Has a caller", "has a biting test", "the route exists" are properties of the FINISHED
// change; demanding them of step 1 rejects every multi-step plan at its first step (measured on the first
// real-model run, 2026-09-18: three Forge candidates reverted for "includes no test" before the test step
// could run). A partial gate keeps only what must hold at every instant: it parses, it references nothing
// that does not exist, it imports what it calls, and the suite is green. The whole-change rules run at the
// lane's finale and again at the builder's commit boundary — nothing ships on a partial verdict.
export function structuralErrors(repoRoot, touched, { partial = false } = {}) {
  if (!touched.length) return []; // the baseline run gates the untouched base — nothing to compare
  if (partial) return wiringErrors(repoRoot, touched, { callsOnly: true });
  return [...wiringErrors(repoRoot, touched), ...schemaErrors(repoRoot, touched), ...routeErrors(repoRoot, touched)];
}

// ---- the shared steps -----------------------------------------------------------------------------
const TEST_EXCLUDE = ['node_modules', '.git', '.claude', 'dist', 'data', 'public', '.DS_Store']; // .claude holds session worktrees — their duplicate test trees are not this repo's gate
export const PER_TEST_TIMEOUT_MS = 120000; // CI's per-file `timeout 120`, as a per-test bound that NAMES the hang

export function syntaxErrors(repoRoot, touched) {
  const errors = []; const nr = nodeRunner();
  for (const f of touched.filter((f) => /\.(mjs|js)$/.test(f))) {
    if (!existsSync(join(repoRoot, f))) continue; // a deletion has no syntax
    try { execFileSync(nr.bin, ['--check', join(repoRoot, f)], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env: nr.env }); }
    catch (e) { errors.push(`SYNTAX ${f}:\n${String(e.stderr || e.message).slice(0, 800)}`); }
  }
  return errors;
}

// Run node:test files. ONE runner for every caller, so the environment (NODE_TEST_CONTEXT stripped — a
// nested runner that inherits it reports RED as GREEN), the per-test timeout and the output shape are
// identical everywhere. A batch is kept: measured 2026-09-18, `node --test a b` exits 1 when a file dies
// before registering a test, so batching hides nothing — what it lacked was a NAMED hang, and
// --test-timeout gives that without paying ~100ms of node startup per file, serially, across 140 files.
// HOW to launch node:test — the one definition. Callers that need their own error classification
// (base-health's ran-red vs could-not-run, self-update's stage failures) spawn this command themselves;
// everything else uses runNodeTests. Either way the binary, the environment and the flags are the same.
export function nodeTestCommand(files) {
  const nr = nodeRunner();
  return { bin: nr.bin, args: ['--test', `--test-timeout=${PER_TEST_TIMEOUT_MS}`, ...files], env: hermeticEnv(nr.env) };
}

export function runNodeTests(repoRoot, files, { timeoutMs = 300000, execFn = execFileSync } = {}) {
  if (!files.length) return { ok: true, output: '' };
  const cmd = nodeTestCommand(files);
  try {
    const output = execFn(cmd.bin, cmd.args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, env: cmd.env, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, output: String(output || '') };
  } catch (e) {
    const hung = e && (e.killed || e.signal === 'SIGTERM') ? `\n(the whole run exceeded ${Math.round(timeoutMs / 1000)}s and was killed)` : '';
    // NAME the failures first. The tail of a runner's output is the last assertion's diff; the failing test
    // names sit above it and were being cut off — so the coder (and the log) saw a slice of a string
    // comparison instead of WHICH test failed (seen live 2026-09-18).
    const full = String(e.stdout || '');
    const names = [...new Set(full.split('\n').map((l) => l.trim()).filter((l) => /^(✖|not ok\s+\d+\s+-)\s/.test(l) && !/failing tests:/.test(l))
      .map((l) => l.replace(/^(✖|not ok\s+\d+\s+-)\s*/, '').replace(/\s*\(\d[\d.]*ms\)$/, '')))].slice(0, 8);
    const head = names.length ? `${names.map((n) => `✖ ${n}`).join('\n')}\n` : '';
    return { ok: false, output: `${head}${full.slice(-1800)}\n${String(e.stderr || e.message).slice(-500)}${hung}` };
  }
}

export const testFilesOf = (repoRoot) => listFiles(repoRoot, TEST_EXCLUDE).filter((f) => f.endsWith('.test.mjs'));

// Tool gate: the dependency-free pure-Node repo.
export function toolGate(repoRoot, touched, opts = {}) {
  const errors = [...syntaxErrors(repoRoot, touched)];
  errors.push(...fenceErrors(repoRoot, touched)); // first-line fence artifact — belt-and-braces with coder de-fencing
  errors.push(...lintDiff(repoRoot, touched)); // phantom references red the gate BEFORE tests
  errors.push(...structuralErrors(repoRoot, touched, opts));
  if (!errors.length) {
    const r = runNodeTests(repoRoot, testFilesOf(repoRoot), { timeoutMs: 300000 });
    if (!r.ok) errors.push(`TESTS:\n${r.output}`);
  }
  if (!errors.length && !opts.partial) errors.push(...proofErrors(repoRoot, touched, opts));
  return { green: errors.length === 0, errors, unproven: [] };
}

// Product gate: syntax-check touched JS/MJS + tsc + `npm test` (the product's own node:test suite) +
// the REAL `next build`. We used to skip `next build` (too slow) and let the Vercel preview be the only
// backstop — which is exactly how broken PRs shipped ("it has never pushed a non-broken PR", Brandon
// 2026-08-03). Now the production build runs locally BEFORE any push, so a non-compiling route / bad
// import / RSC-boundary violation reds the gate and NO PR is opened. Slow-but-correct beats fast-broken;
// PRODUCT_BUILD_GATE=0 opts out. npm/next are resolved by PROBE with an augmented PATH — the packaged app
// runs on launchd's bare PATH where a plain 'npm' is ENOENT (which would count as a confusing red gate).
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const binPath = (name) => BIN_PATHS.map((p) => join(p, name)).find((f) => existsSync(f)) || name;
// NODE_TEST_CONTEXT is dropped too: a `node --test` child that inherits it believes it is a SUBTEST of
// the parent runner, streams its results upward and exits 0 — so a gate invoked from inside any test
// (this repo's own suite, the eval harness) reported a RED fixture as GREEN. The gate's verdict must
// never depend on who launched it.
// A TEST child must be hermetic. The gate handed it the whole process environment — including the
// owner's real .env — and the product suite defaults its config from env
// (`process.env.SUPABASE_URL || 'https://example.supabase.co'`), so the owner's live URL replaced the
// fixture URL its fetch mock matches on: 8 of 14 timeline tests failed, the baseline read RED, and EVERY
// product build was refused with "the base branch's own test suite is red" (live, 2026-09-21 — the base
// is green: 921/921 with a clean env). Two reasons to strip, not one: a suite whose verdict depends on
// whose machine it runs on is not a gate, and a live service key has no business inside a test process.
// Only credentials and service endpoints go; PATH, HOME, SEEN_* and NODE_* stay, so paths still resolve.
export const TEST_ENV_STRIP = /^(SUPABASE_|BRAIN_API|BRAIN_CLIENT|CHRONOS_VAULT|VERCEL_|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_|OPENAI_|GROQ_|CEREBRAS_|GEMINI_|GOOGLE_|XAI_|MISTRAL_|OLLAMA_|STRIPE_|RESEND_|SENTRY_)/;
export function hermeticEnv(base = gateEnv()) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (TEST_ENV_STRIP.test(k)) delete env[k];
  return env;
}

export const gateEnv = () => { const e = { ...process.env, PATH: [...BIN_PATHS, process.env.PATH || ''].join(':') }; delete e.ELECTRON_RUN_AS_NODE; delete e.NODE_TEST_CONTEXT; return e; };

// How to spawn a NODE child that works in every launch context. A bare 'node' resolves from PATH —
// and an app launched from Finder/Dock gets launchd's bare PATH (no homebrew), so the child dies
// instantly with EMPTY output ("baseline tests are already red … TESTS: <nothing>", 2026-07-10).
// Probe the usual homes for a real node binary (drop the Electron shim var for it); only when none
// exists fall back to process.execPath KEEPING ELECTRON_RUN_AS_NODE — under the packaged app that
// execPath is Electron, and without the var it would launch the GUI instead of running as node.
export function nodeRunner() {
  const real = BIN_PATHS.map((p) => join(p, 'node')).find((f) => existsSync(f));
  if (real) return { bin: real, env: gateEnv() };
  const env = { ...process.env, PATH: [...BIN_PATHS, process.env.PATH || ''].join(':') }; delete env.NODE_TEST_CONTEXT;
  return { bin: process.execPath, env };
}

// TypeScript type-check for the product repo. node --check only sees .mjs/.js — a non-compiling .tsx
// sailed the local gate and only died at Vercel (Seen #194). It only runs when a .ts/.tsx is touched.
// tsc ABSENT used to mean "no error" — fail-open on the one step that can see a type error, with the
// preview deploy as the only backstop, AFTER a PR already claimed to be ready. A change that cannot be
// type-checked has not been type-checked: say so, and let the owner install the toolchain.
export function tscErrors(repoRoot, touched) {
  if (!touched.some((f) => /\.(ts|tsx)$/.test(f))) return []; // nothing TypeScript in this change
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) {
    return [`TSC: this change touches TypeScript, but ${relative(process.cwd(), tsc) || tsc} does not exist, so it cannot be type-checked here — run \`npm install\` in the product checkout (the build worktree links its node_modules). An unchecked change is not a passing change.`];
  }
  try { execFileSync(tsc, ['--noEmit'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 240000, env: gateEnv() }); return []; }
  catch (e) { return [`TSC:\n${String(e.stdout || '').slice(-1800)}\n${String(e.stderr || e.message).slice(-500)}`]; }
}

export function productGate(repoRoot, touched, opts = {}) {
  const errors = [...syntaxErrors(repoRoot, touched)];
  const unproven = [];
  errors.push(...fenceErrors(repoRoot, touched)); // a .ts/.tsx/.js first-line fence artifact — deterministic, no subprocess
  errors.push(...lintDiff(repoRoot, touched)); // phantom references red the gate BEFORE the slow checks
  errors.push(...structuralErrors(repoRoot, touched, opts));
  if (!errors.length) errors.push(...tscErrors(repoRoot, touched)); // TS type-check (Seen #194) before the suite
  if (!errors.length) {
    // `npm test`, hermetically: the owner's .env must not decide whether the base branch is green.
    try { execFileSync(binPath('npm'), ['test'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 600000, env: hermeticEnv() }); }
    catch (e) { errors.push(`TESTS (npm test):\n${String(e.stdout || '').slice(-1800)}\n${String(e.stderr || e.message).slice(-500)}`); }
  }
  if (!errors.length && !opts.partial) errors.push(...proofErrors(repoRoot, touched, opts));
  if (!errors.length) {
    // The REAL production build — last (slowest), the no-broken-PR lever. Switched off, it is UNPROVEN,
    // not passed: the gate stays green so a coder can iterate, and the builder refuses to push.
    if (process.env.PRODUCT_BUILD_GATE === '0') unproven.push('the production build was skipped (PRODUCT_BUILD_GATE=0)');
    else errors.push(...productBuildErrors(repoRoot));
  }
  return { green: errors.length === 0, errors, unproven };
}

// The real production build (`next build`), run via the repo's own build script. This is what Vercel
// runs; a change that fails it WOULD be a broken PR, so it reds the gate BEFORE any push. Slow (~1-3min)
// but definitive. PRODUCT_BUILD_GATE=0 is honoured by productGate as UNPROVEN (green to iterate on, never
// pushable). A repo with no build script has nothing to build, which is a fact about the repo, not a skip.
export function productBuildErrors(repoRoot, execFn = execFileSync) {
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')); } catch { return []; }
  if (!pkg || !pkg.scripts || !pkg.scripts.build) return []; // no build script → nothing to prove locally
  try {
    // NOT hermetic, deliberately: this mimics Vercel, which builds WITH the project's env (NEXT_PUBLIC_*
    // values are inlined at build time), so stripping them here would invent failures instead of finding them.
    execFn(binPath('npm'), ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 900000, env: gateEnv() });
    return [];
  } catch (e) {
    return [`BUILD (npm run build — this is what production runs; a red here IS the broken PR, caught before the push):\n${String(e.stdout || '').slice(-1800)}\n${String(e.stderr || e.message).slice(-600)}`];
  }
}


// ---- proof: the focused test must FAIL without the change ------------------------------------------
// "All tests pass" is asked to prove the wrong thing. It proves nothing already covered broke. It says
// nothing about whether the REQUESTED behaviour exists: a change can add a function, add a test that
// re-asserts something the base already did, and go green. The only test that proves a change is one
// that is RED without it. So: take the change's own test files, put every source file it touched back
// to its base content (new files removed), and run just those tests. They must fail. Then restore.
//
// What needs this proof is decided by the task CONTRACT (deterministic, from the task text) — never by
// the model that wrote the change:
//   behaviour  (default) logic modules changed → a test file in the change must bite
//   refactor   no behaviour may change, so no test can bite — instead the touched modules' export
//              surface must be IDENTICAL to the base (and the suite, above, is already green)
//   docs / ui  no unit proof here; a `ui` change is proven at runtime (engine/completion.mjs)
// A logic module is a source file that is not a CLI script, a routed page or a React component — those
// are exercised by running them, not by a unit test (and the product repo does not unit-test its .tsx).
const isLogic = (f) => isSource(f) && !isTest(f) && !/\.(tsx|jsx)$/.test(f)
  && !/^(scripts|app|components|hooks|pages|public|styles)\//.test(f);

const showAt = (repoRoot, ref, path) => {
  try { return execFileSync('git', ['show', `${ref}:${path}`], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; } // absent at the base → the change created it
};
const exportsOf = (text) => [...String(text ?? '').matchAll(/^[ \t]*export\s+(?:default\b|(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+))/gm)].map((m) => m[1] || 'default').sort();

export function proofErrors(repoRoot, touched, { kind = 'behaviour', baseRef = 'HEAD', runTests = runNodeTests } = {}) {
  if (process.env.PROOF_CHECK === '0' || !touched.length || kind === 'docs' || kind === 'ui') return [];
  // Only sources whose CODE changed. A comment-only edit or an empty new file is not behaviour to prove —
  // and the layers that own those shapes (comment-only, empty-new-file) give the coder the reason that
  // actually helps, which "you have no test" would bury.
  const changedCode = (f) => {
    const abs = join(repoRoot, f);
    const now = existsSync(abs) ? codeLines(readFileSync(abs, 'utf8')).join('\n') : '';
    return now !== codeLines(showAt(repoRoot, baseRef, f) ?? '').join('\n');
  };
  const sources = touched.filter(isLogic).filter(changedCode);
  if (!sources.length) return []; // tests, docs, config, UI, or no real code change — nothing a unit test could prove

  if (kind === 'refactor') {
    const errors = [];
    for (const f of sources) {
      const base = showAt(repoRoot, baseRef, f);
      if (base === null || !existsSync(join(repoRoot, f))) continue; // moved/created/deleted files are judged by the wiring check
      const was = exportsOf(base); const now = exportsOf(readFileSync(join(repoRoot, f), 'utf8'));
      if (was.join() !== now.join()) errors.push(`PROOF ${f}: this task is a refactor, so it may not change what the module exports — before: [${was.join(', ')}], after: [${now.join(', ')}]. Keep the surface identical, or this is a behaviour change and needs a test that fails without it.`);
    }
    return errors;
  }

  const tests = touched.filter((f) => /\.test\.(mjs|js)$/.test(f) && existsSync(join(repoRoot, f)));
  if (!tests.length) {
    return [`PROOF: the change edits ${sources.join(', ')} but includes no test — nothing connects the requested behaviour to an assertion, so a green suite proves only that old behaviour still works. Add or extend a co-located *.test.mjs whose assertions FAIL without this change.`];
  }

  // Swap the touched sources back to base, run ONLY the change's tests, restore — always.
  const saved = new Map();
  try {
    for (const f of sources) {
      const abs = join(repoRoot, f);
      saved.set(f, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
      const base = showAt(repoRoot, baseRef, f);
      if (base === null) rmSync(abs, { force: true }); else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, base); }
    }
    const r = runTests(repoRoot, tests, { timeoutMs: 180000 });
    if (r.ok) {
      return [`PROOF: ${tests.join(', ')} PASS against the base code — they do not fail without this change, so they do not prove it. Assert the NEW behaviour (what ${sources.join(', ')} now does that it did not do before), so the test is red on the base and green with the change.`];
    }
    return [];
  } finally {
    for (const [f, text] of saved) {
      const abs = join(repoRoot, f);
      if (text === null) rmSync(abs, { force: true }); else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }
    }
  }
}

// ---- one verdict per tree state ---------------------------------------------------------------------
// The builder used to TRUST that a lane "returns only on a green gate". It now re-runs the gate itself
// at the commit boundary — and so that costs nothing when the lane was honest, a verdict is remembered
// per exact tree state (base commit + every tracked and untracked byte that differs from it).
export function treeKey(repoRoot) {
  const git = (...a) => { try { return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', maxBuffer: 128 * 1024 * 1024 }); } catch (e) { return String(e.stdout || ''); } };
  const h = createHash('sha256');
  h.update(git('rev-parse', 'HEAD')); h.update(git('diff', 'HEAD'));
  for (const f of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).sort()) {
    h.update(f); try { h.update(readFileSync(join(repoRoot, f))); } catch { /* vanished mid-read */ }
  }
  return h.digest('hex');
}
export function memoGate(gateFn, opts = {}) {
  const seen = new Map();
  const make = (extra, tag) => (repoRoot, touched = []) => {
    const key = `${tag}|${treeKey(repoRoot)}|${[...touched].sort().join(',')}`;
    if (!seen.has(key)) seen.set(key, gateFn(repoRoot, touched, { ...opts, ...extra }));
    return seen.get(key);
  };
  const gate = make({}, 'full');
  gate.partial = make({ partial: true }, 'partial'); // a STEP of a multi-step plan — never a shipping verdict
  return gate;
}
