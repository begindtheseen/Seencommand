// WIRING CHECK — does the change connect to anything that RUNS?
//
// The most expensive recurring failure in this repo is not bad code; it is good code nothing calls.
// HANDOFF 2026-08-15: "well-tested helpers whose integration could be deleted while the full suite
// stayed green". A pure helper plus its unit test is green by construction, the lint's "new module
// nothing imports" rule counted a TEST as an importer, and the only layer that could notice was a
// probabilistic reviewer. These two rules are deterministic, and they compare STATES, not text:
//
//   unwired-export   the change adds an export that no non-test module consumes and the module itself
//                    never uses. The helper exists; the feature does not.
//   orphaned-export  an export that had a real caller at the base has none after the change, and is
//                    still exported. The integration was deleted; the helper and its tests remain.
//
// Both fail a build, so both resolve every ambiguity toward "wired" (see code-graph.mjs). Entrypoints
// by convention (scripts/, framework routes, main/server/index) need no importer.
import { execFileSync } from 'node:child_process';
import { buildGraph, consumersOf, usedInternally, isEntrypoint, isSource, isTest, parseModule, blankLiterals } from './code-graph.mjs';
import { addedLines } from './lint.mjs';

const showAt = (root, ref, path) => {
  try { return execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; } // absent at the ref → a new file
};

// Compare two states of one tree. `after` is the graph of the tree as it stands; `before` is the same
// tree with every touched file swapped back to its content at `baseRef`.
export function wiringFindings({ repoRoot, touched = [], baseRef = 'HEAD', graphs = null } = {}) {
  const sources = touched.filter((f) => isSource(f) && !isTest(f));
  if (!sources.length && !touched.some(isSource)) return [];
  let after; let before;
  if (graphs) ({ after, before } = graphs);
  else {
    after = buildGraph({ root: repoRoot });
    const overrides = {};
    for (const f of touched.filter(isSource)) overrides[f] = showAt(repoRoot, baseRef, f); // null → did not exist
    before = buildGraph({ root: repoRoot, files: [...after.modules.keys()], overrides });
  }
  const findings = [];
  const prod = (g, path, name) => consumersOf(g, path, name, { tests: false });

  // unwired-export — judged on the files this change touched.
  for (const path of sources) {
    const now = after.modules.get(path);
    if (!now || isEntrypoint(path)) continue;
    const was = before.modules.get(path);
    const had = new Set(was ? was.exports : []);
    for (const name of now.exports) {
      if (had.has(name) || name === 'default' || name === '*cjs*') continue;
      // Only CALLABLE exports: an unused constant is untidy, not a missing behaviour. `_name` is this
      // repo's convention for a seam exported purely so a test can reach it.
      if ((now.kinds || {})[name] !== 'callable' || name.startsWith('_')) continue;
      if (usedInternally(now.text, name)) continue;
      if (prod(after, path, name).length) continue;
      const onlyTests = consumersOf(after, path, name, { tests: true });
      findings.push({ rule: 'unwired-export', file: path, name,
        reason: `${path} adds the export \`${name}\`, but no module that runs imports it${onlyTests.length ? ` (only ${onlyTests.join(', ')} does — a test is not a caller)` : ''} and ${path} never uses it itself. A helper nothing calls changes no behaviour: wire \`${name}\` into the code path the task is about, in this same change.` });
    }
  }

  // orphaned-export — any export, anywhere, whose LAST real caller lived in a touched file.
  const touchedSet = new Set(touched);
  for (const [path, was] of before.modules) {
    if (isTest(path) || isEntrypoint(path)) continue;
    const now = after.modules.get(path);
    if (!now) continue; // the module itself was removed — deleting dead code is fine
    for (const name of was.exports) {
      if (name === 'default' || name === '*cjs*' || !now.exports.includes(name)) continue;
      const callersBefore = prod(before, path, name);
      if (!callersBefore.length || !callersBefore.some((c) => touchedSet.has(c))) continue;
      if (prod(after, path, name).length || usedInternally(now.text, name)) continue;
      findings.push({ rule: 'orphaned-export', file: path, name,
        reason: `\`${name}\` (exported by ${path}) was called from ${callersBefore.join(', ')} before this change and is called from nowhere after it — but it is still exported and its tests still pass. The integration was removed, not the feature. Restore the call, or delete \`${name}\` and its tests if the behaviour is genuinely being retired.` });
    }
  }
  return findings;
}

// unimported-call — the change CALLS a function that another module exports, but this file neither imports
// nor declares it. `node --check` passes (it is a runtime ReferenceError, not a syntax error) and the
// phantom-reference lint passes (the function exists — somewhere). Recorded twice here: PR #46
// (selfUpdateCheck, crashed every board meeting) and self-update's deployability sweep, which "was CALLED
// but never imported — the sweep silently skipped every run". Often the throw lands inside a try/catch
// and becomes a quiet log line, which is worse than a crash.
// FP-safe by construction: it fires only when the name is an export of some repo module AND, in this
// file, appears NOWHERE except in call position — no import, no declaration, no assignment, no
// destructuring, no property, no parameter. Any other appearance at all means "declared somehow".
export function unimportedCalls({ repoRoot, touched = [], graph = null, addedLinesFn = null } = {}) {
  const g = graph || buildGraph({ root: repoRoot });
  const exportedSomewhere = new Set();
  for (const m of g.modules.values()) if (!isTest(m.path)) for (const e of m.exports) if (e !== 'default' && e !== '*cjs*' && e.length >= 4) exportedSomewhere.add(e);
  const findings = [];
  for (const f of touched.filter((p) => isSource(p) && !isTest(p))) {
    const mod = g.modules.get(f);
    if (!mod) continue;
    // Prose is not code: 'failureBrief() now tells a retry…' inside a string is not a call. A real lexer
    // blanks literal and comment contents (code-graph.mjs blankLiterals — a regex version made it WORSE).
    const code = blankLiterals(mod.text);
    const added = addedLinesFn ? blankLiterals(addedLinesFn(f).join('\n')) : code;
    const seen = new Set();
    // Not part of a longer identifier and not a MEMBER access — but `...name(` is a spread, not a member.
    for (const m of added.matchAll(/(?<![\w$])(?<!(?:^|[^.])\.)([A-Za-z_$][\w$]{3,})\s*\(/g)) {
      const name = m[1];
      if (seen.has(name) || !exportedSomewhere.has(name)) continue;
      seen.add(name);
      const every = [...code.matchAll(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))];
      const onlyCalls = every.every((x) => /^\s*\(/.test(code.slice(x.index + name.length, x.index + name.length + 4)) && !(code[x.index - 1] === '.' && code[x.index - 2] !== '.')
        && !/\b(?:function\*?|class|new)\s+$/.test(code.slice(Math.max(0, x.index - 12), x.index)));
      if (!onlyCalls) continue;
      // `name(args) {` is a method or function-shorthand DEFINITION, not a call (the fifth false positive).
      if (new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${name.replace(/\$/g, '\\$')}\\s*\\([^()]*\\)\\s*\\{`).test(code)) continue;
      const homes = [...g.modules.values()].filter((x) => !isTest(x.path) && x.exports.includes(name)).map((x) => x.path);
      findings.push({ rule: 'unimported-call', file: f, name,
        reason: `${f} calls \`${name}()\` but never imports or declares it — it is exported by ${homes.slice(0, 2).join(' / ')}. This passes \`node --check\` and throws ReferenceError the moment that line runs (PR #46; self-update's sweep that "was called but never imported"). Add the import.` });
    }
  }
  return findings;
}

// Gate-shaped: error strings, like lintDiff. WIRING_CHECK=0 disables (an escape hatch, same as CODER_LINT=0).
export function wiringErrors(repoRoot, touched, opts = {}) {
  if (process.env.WIRING_CHECK === '0') return [];
  try {
    const calls = unimportedCalls({ repoRoot, touched, addedLinesFn: (f) => addedLines(repoRoot, f) });
    const { callsOnly = false, ...rest } = opts; // callsOnly: a partial (step) gate — state comparisons wait for the finished change
    return [...(callsOnly ? [] : wiringFindings({ repoRoot, touched, ...rest })), ...calls].map((f) => `WIRING ${f.file}: ${f.reason}`);
  }
  catch (e) { return [`WIRING: the wiring check could not run (${String(e.message).slice(0, 160)}) — it fails closed; fix the check or the tree`]; }
}

export { parseModule };
