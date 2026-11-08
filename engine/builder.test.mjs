import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileFor, assertWritable, closesRef, screenBuildTask, fenceErrors, tscErrors, refusalError, chooseBuildBase, productBuildErrors } from './builder.mjs';

test('chooseBuildBase always bases off the PR base — never the current feature branch (#243)', () => {
  // origin reachable → fresh origin/<base>
  const calls = [];
  const okAll = (...a) => { calls.push(a.join(' ')); return true; };
  assert.equal(chooseBuildBase(okAll, 'main'), 'origin/main');
  assert.ok(calls.some((c) => c === 'fetch origin main'), 'fetches the base first');

  // offline (fetch fails) but a local base ref exists → local base, still NOT current HEAD
  const localOnly = (...a) => a[0] !== 'fetch' && !(a[0] === 'rev-parse' && a[2] === 'origin/main');
  assert.equal(chooseBuildBase(localOnly, 'main'), 'main');

  // nothing resolvable → null (caller warns + last-resorts to HEAD). It must NEVER return a branch name
  // derived from the checkout's current position.
  const nothing = () => false;
  assert.equal(chooseBuildBase(nothing, 'main'), null);
});

// task-31 died because brain/mcp/server.mjs was outside the tool repo's safe paths — brain/ is tool
// code under the same test gate, so ALL of it is writable now. The hard boundaries stay hard.
test('tool repo safe paths cover ALL brain/ code (the task-31 refusal)', () => {
  const P = profileFor('tool');
  for (const ok of ['brain/mcp/server.mjs', 'brain/lib/cloud.mjs', 'brain/main.js', 'engine/run.mjs', 'lib/builds.mjs', 'HANDOFF.md']) {
    assert.doesNotThrow(() => assertWritable(ok, P.safePath), ok);
  }
  for (const bad of ['package.json', '.mcp.json', '.env', 'lib/../.env', 'node_modules/x/index.js', 'data/state.json', '.git/config']) {
    assert.throws(() => assertWritable(bad, P.safePath), /refused/, bad);
  }
});

test('product repo safe paths still exclude config, lockfiles, env, and migrations', () => {
  const P = profileFor('product');
  assert.doesNotThrow(() => assertWritable('api/reports.js', P.safePath));
  assert.doesNotThrow(() => assertWritable('app/ghost-report/page.tsx', P.safePath));
  assert.throws(() => assertWritable('supabase/migrations/041_x.sql', P.safePath), /refused/);
  assert.throws(() => assertWritable('package-lock.json', P.safePath), /refused/);
  assert.throws(() => assertWritable('.env.local', P.safePath), /refused/);
});

test('both profiles tell the coder its boundaries up front', () => {
  assert.match(profileFor('tool').allowedNote, /brain\//);
  assert.match(profileFor('product').allowedNote, /NEVER/);
});

// Merging a task's PR must close the task INSTANTLY, whoever merges — GitHub does it natively when
// the PR body carries the closing keyword. Same-repo tasks use #N; product PRs close tool-repo tasks
// with the cross-repo owner/repo#N form.
test('closesRef wires the PR to its task for auto-close on merge', () => {
  assert.equal(closesRef('begindtheseen/seen-command', { repo: 'begindtheseen/seen-command', number: 45 }), '\n\nCloses #45');
  assert.equal(closesRef('begindtheseen/Seen', { repo: 'begindtheseen/seen-command', number: 33 }), '\n\nCloses begindtheseen/seen-command#33');
  assert.equal(closesRef('begindtheseen/Seen', null), '');
  assert.equal(closesRef('begindtheseen/Seen', { repo: 'begindtheseen/seen-command' }), '');
});

// ---- effectiveness gate: comment-only diffs never ship ---------------------------------------------
const { effectiveLines, hasEffectiveChange } = await import('./builder.mjs');
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

test('effectiveLines sees code, not comments', () => {
  assert.equal(effectiveLines('// a comment\n/* block */\n* mid\n\n').length, 0);
  assert.equal(effectiveLines('// note\nconst x = 1;\n').length, 1);
  assert.ok(effectiveLines('#!/usr/bin/env node\n').length, 'shebang is real'); // #! is not a # comment
});

test('hasEffectiveChange refuses comment-only edits, accepts real ones (the PR #50 class)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-eff-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.mjs'), 'const x = 1;\nexport { x };\n');
  g('add', '-A'); g('commit', '-m', 'seed');

  writeFileSync(join(dir, 'a.mjs'), '// Updated to use the latest Chronos SDK features\nconst x = 1;\nexport { x };\n');
  assert.equal(hasEffectiveChange(dir, ['a.mjs']), false, 'comment-only edit must not ship');

  writeFileSync(join(dir, 'a.mjs'), '// note\nconst x = 2;\nexport { x };\n');
  assert.equal(hasEffectiveChange(dir, ['a.mjs']), true, 'a real change ships');

  writeFileSync(join(dir, 'new-comments.mjs'), '// only\n// comments\n');
  assert.equal(hasEffectiveChange(dir, ['new-comments.mjs']), false, 'an all-comment NEW file must not ship');
  writeFileSync(join(dir, 'new-real.mjs'), '// header\nexport const Y = 1;\n');
  assert.equal(hasEffectiveChange(dir, ['new-real.mjs']), true, 'a real new file ships');
});

// ---- commitTouched: stage ONLY the coder's files; the diffstat mirrors the REAL commit (the #243 fix)
// PR #243 was meant to touch 2 files but shipped +2213/-64 across the whole vault: the product checkout
// is permanently dirty (the brain rewrites tracked memory/ every board meeting), and a broad add swept
// it in — while the PR body's diffstat counted only the 2 intended files, so it read "small + green".
// commitTouched closes both holes: per-path `-- <file>` staging + a diffstat from startRef..HEAD.
const { commitTouched } = await import('./builder.mjs');
test('commitTouched stages ONLY touched files — a dirty vault is NEVER swept into the commit (the #243 fix)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-stage-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  // seed a base commit: a tracked "vault" file + a code file
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'timeline.md'), 'original\n');
  writeFileSync(join(dir, 'api-stats.js'), 'export const v = 1;\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  const startRef = g('rev-parse', 'HEAD');
  // make the tree DIRTY exactly like a board meeting churns the vault, AND have the coder touch one file
  writeFileSync(join(dir, 'memory', 'timeline.md'), 'original\nboard-meeting churn\n');
  writeFileSync(join(dir, 'api-stats.js'), 'export const v = 2;\n');
  const gitFn = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

  const stat = commitTouched(gitFn, { touched: ['api-stats.js'], message: 'bump v', startRef });

  // the commit contains ONLY the touched file — the dirty vault is not in it
  const committed = g('diff', '--name-only', startRef, 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(committed, ['api-stats.js'], 'the commit must hold ONLY the touched file, never the dirty vault');
  // the vault churn is still UNcommitted in the working tree (untouched, not wiped, not shipped)
  assert.match(g('status', '--porcelain'), /memory\/timeline\.md/, 'the dirty vault stays uncommitted in the working tree');
  // the returned diffstat (what the PR body quotes) mirrors the REAL commit — only the touched file
  assert.match(stat, /api-stats\.js/);
  assert.doesNotMatch(stat, /timeline\.md/, 'the body diffstat must never mention the un-committed vault file (the #243 lie)');
});

test('commitTouched refuses an EMPTY touched set — an honest "nothing to ship", never a broad add', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-stage2-'));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  const gitFn = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  assert.throws(() => commitTouched(gitFn, { touched: [], message: 'x', startRef: 'HEAD' }), /nothing to commit/);
});

test('assertWritable refuses the protected intent files (the PR #56 class)', () => {
  const P = profileFor('tool');
  for (const p of ['org/focus.mjs', 'org/capabilities.mjs', 'engine/policy.mjs']) {
    assert.throws(() => assertWritable(p, P.safePath), /PROTECTED/, p);
  }
  assert.doesNotThrow(() => assertWritable('engine/run.mjs', P.safePath)); // ordinary code stays writable
});

test('nodeRunner always yields a spawnable node (bare PATH killed every gate, 2026-07-10)', async () => {
  const { nodeRunner } = await import('./builder.mjs');
  const nr = nodeRunner();
  assert.ok(nr.bin && typeof nr.bin === 'string');
  assert.match(nr.env.PATH, /\/usr\/bin/); // PATH is augmented, never bare
  // the chosen binary actually runs
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(nr.bin, ['-e', 'console.log("ok")'], { encoding: 'utf8', env: nr.env }).trim();
  assert.equal(out, 'ok');
});

test('duplicateOpenPR flags a task that matches an open builder PR (the #189/#190 class)', async () => {
  const { duplicateOpenPR } = await import('./builder.mjs');
  const open = [
    { number: 189, title: 'Add Chronos live connector with broadcast and subscribe functionality' },
    { number: 42, title: 'Fix greeting string in Command Center' },
  ];
  const dup = duplicateOpenPR('Develop Live Connector for Chronos and Seen Command with broadcast support', open);
  assert.ok(dup && dup.number === 189, JSON.stringify(dup));
  assert.equal(duplicateOpenPR('Rework the Ghost Report ranking table', open), null);
  assert.equal(duplicateOpenPR('anything', []), null);
});

// ---- entrance screen: phantom + closed tasks never reach the coder (the #81 class) ----------------
// #81 ("Integrate the Chronos SDK …") was CLOSED, then a build ran on it anyway; the coder fabricated
// lib/chronos/client.mjs to satisfy the phantom premise and the deterministic gate went green — only
// the LLM reviewer caught it. screenBuildTask refuses both shapes at the entrance, before the coder runs.
test('screenBuildTask refuses a phantom-premise task, naming the phantom', () => {
  const r = screenBuildTask({ task: 'Integrate the Chronos SDK for real-time data exchange' });
  assert.ok(r, 'a phantom task must be refused');
  assert.match(r, /Chronos SDK/);
  assert.match(r, /does not exist|fabricate/);
});

test('screenBuildTask refuses a CLOSED task (its live state is closed), naming the repo', () => {
  const r = screenBuildTask({ task: 'Fix the export button', issue: { repo: 'begindtheseen/seen-command', number: 81 },
    issueState: 'closed' });
  assert.ok(r, 'a closed task must be refused');
  assert.match(r, /#81 is closed on begindtheseen\/seen-command/);
});

test('screenBuildTask allows an OPEN task and fails OPEN when the issue state is unknown', () => {
  // live state 'open' → build it
  assert.equal(screenBuildTask({ task: 'Fix the export button', issue: { repo: 'r', number: 81 }, issueState: 'open' }), null);
  // fetch failed (issueState null = unknown) → never block an honest build on a GitHub outage
  assert.equal(screenBuildTask({ task: 'Fix the export button', issue: { repo: 'r', number: 81 }, issueState: null }), null);
  // no issue threaded through (overnight/CLI) → only the phantom check applies
  assert.equal(screenBuildTask({ task: 'Fix the export button' }), null);
});

// The false-refusal this guard was rebuilt to kill: approve→file→build fires the build ~1s after the
// issue is filed, and GitHub's LIST endpoint is eventually consistent, so the just-filed issue is
// often ABSENT from it. The old guard read that absence as "closed" and refused OPEN issues #86/#87.
// The DIRECT per-issue GET (issueStateFor) is read-your-writes consistent — a just-filed issue reads
// 'open' and builds. The guard no longer consults the list, so list-absence can never refuse again.
test('screenBuildTask never refuses a just-filed OPEN issue off list-absence (the #86/#87 race)', () => {
  assert.equal(screenBuildTask({ task: 'Fix the export button', issue: { repo: 'begindtheseen/seen-command', number: 87 }, issueState: 'open' }), null);
});

test('screenBuildTask refuses a phantom task regardless of issueState (premise beats state)', () => {
  // The phantom premise is checked FIRST and refuses even when the issue is live/open — the phantom
  // is in the premise, not the issue's existence.
  for (const issueState of ['open', 'closed', null]) {
    const r = screenBuildTask({ task: 'Integrate the Chronos SDK for real-time data exchange', issue: { repo: 'r', number: 5 }, issueState });
    assert.ok(r, `a phantom task must refuse with issueState=${issueState}`);
    assert.match(r, /Chronos SDK/);
  }
});

test('screenBuildTask passes a legit task and does NOT false-positive on a REAL third-party SDK', () => {
  assert.equal(screenBuildTask({ task: 'Fix the login redirect bug' }), null);
  // PHANTOM_CONCEPTS are PAIRED phrases (our own dependency-free components + SDK), never the bare word
  // "SDK" — a real vendor SDK in the product repo must build freely.
  assert.equal(screenBuildTask({ task: 'Upgrade the Supabase SDK in the product' }), null);
});

// ---- first-line fence check: a .tsx whose first line is ``` reds the gate, by name (the Seen #194 hole)
// The coder's NEWFILE stub was a literal markdown fence written verbatim; node --check never saw the
// .tsx and it only died at Vercel. fenceErrors is the deterministic backstop across every gate.
test('fenceErrors reds the gate for a SOURCE file whose first line is a ``` fence, naming it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-fence-'));
  writeFileSync(join(dir, 'page.tsx'), '```typescript\nimport x from "y";\nexport default function P(){ return null; }\n```\n');
  writeFileSync(join(dir, 'ok.ts'), 'import x from "y";\nexport const a = 1;\n'); // real first line → no error
  writeFileSync(join(dir, 'notes.md'), '```md\n# wrapped\n```\n');                // .md is not a compiled source → skipped
  const errs = fenceErrors(dir, ['page.tsx', 'ok.ts', 'notes.md']);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /page\.tsx/);
  assert.match(errs[0], /fence/i);
});

test('fenceErrors is silent when no touched source leads with a fence (mid-file fences are irrelevant)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-fence2-'));
  writeFileSync(join(dir, 'a.mjs'), 'export const A = 1;\n// ``` a fence-looking comment, not line 1\n');
  assert.deepEqual(fenceErrors(dir, ['a.mjs', 'gone.tsx']), []); // unreadable/missing file is skipped, not an error
});

// ---- tsc probe: type-check .ts/.tsx when the repo ships a tsc; FAIL OPEN when it doesn't -------------
test('tscErrors is a no-op with no .ts/.tsx touched, and FAILS CLOSED when the repo ships no tsc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-tsc-'));
  writeFileSync(join(dir, 'page.tsx'), 'export default function P(){ return null; }\n');
  assert.deepEqual(tscErrors(dir, ['lib/x.mjs']), []);   // no TypeScript in the change → skip entirely
  // .tsx touched but node_modules/.bin/tsc ABSENT: it used to pass silently, with the preview deploy as the
  // only backstop — AFTER a PR had already claimed to be ready. An unchecked change is not a passing change.
  const errs = tscErrors(dir, ['page.tsx']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^TSC: this change touches TypeScript, but .*tsc does not exist/);
  assert.match(errs[0], /npm install/);
});

test('tscErrors runs the repo tsc and surfaces its failure as a TSC gate error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-tsc2-'));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  // a stand-in tsc: ignores --noEmit, prints a diagnostic to stdout, exits non-zero (like a type error)
  writeFileSync(join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\necho "page.tsx(2,1): error TS2322: not assignable"\nexit 2\n', { mode: 0o755 });
  writeFileSync(join(dir, 'page.tsx'), 'export const a: number = "no";\n');
  const errs = tscErrors(dir, ['page.tsx']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^TSC:/);
  assert.match(errs[0], /TS2322/);
});

// ---- refusals render calm, not red -----------------------------------------------------------------
// An honest refusal is the builder declining a build BY DESIGN — a phantom/closed premise, or a
// duplicate of an already-open PR — where the fix is an OWNER action, not a retry. runBuild throws
// these via refusalError, so the runner records status 'refused' (amber "⏸ Not built — needs your
// review") instead of 'failed' (red "⚠ Build failed"): the owner kept misreading healthy refusals as
// breakage — yesterday's #88 duplicate-of-open-PR refusal was read as a build failure.
test('refusalError tags an honest refusal and preserves its guidance message', () => {
  const e = refusalError('not building this — do X instead');
  assert.ok(e instanceof Error, 'a real Error so it throws/catches like any other');
  assert.equal(e.refusal, true, 'the .refusal flag is what the runner keys off to record "refused"');
  assert.equal(e.message, 'not building this — do X instead', 'the guidance survives to the record + dashboard');
});

test('a genuine failure Error is NOT refusal-tagged — the runner must still paint it red', () => {
  // The runner does `e.refusal ? 'refused' : 'failed'`; an ordinary throw (red gate, push error,
  // reviewer double-reject) carries no .refusal and stays 'failed'. Guards against accidental tagging.
  assert.notEqual(new Error('push failed').refusal, true);
  assert.notEqual(new Error('baseline tests are already red').refusal, true);
});

test('runBuild REFUSES a phantom-premise task with a .refusal-tagged error (the real throw site)', async () => {
  // The phantom screen runs before any branch cut, gate, or network (no issue → no state fetch), so
  // this exercises the actual `throw refusalError(screenBuildTask(...))` wiring with zero side effects.
  const { runBuild } = await import('./builder.mjs');
  await assert.rejects(
    runBuild({ task: 'Integrate the Chronos SDK for real-time data exchange' }),
    (e) => {
      assert.equal(e.refusal, true, 'the phantom refusal must be tagged, not read as a bare failure');
      assert.match(e.message, /Chronos SDK/);
      return true;
    },
  );
});

test('the duplicate-of-open-PR refusal is tagged and names the PR to review (the #88 class)', async () => {
  // The duplicate guard sits behind a clean-tree + full-gate + live-PR-list fence, so its throw site
  // can't be driven from a unit test; pin the exact message shape runBuild wraps in refusalError.
  const { duplicateOpenPR } = await import('./builder.mjs');
  const dup = duplicateOpenPR('Develop Live Connector for Chronos with broadcast support',
    [{ number: 189, title: 'Add Chronos live connector with broadcast and subscribe functionality' }]);
  assert.ok(dup, 'the guard first finds the open-PR duplicate');
  const e = refusalError(`duplicate of open PR #${dup.number} ("${String(dup.title).slice(0, 80)}") — review/merge that PR instead of building the same work again`);
  assert.equal(e.refusal, true);
  assert.match(e.message, /duplicate of open PR #189/);
  assert.match(e.message, /review\/merge that PR/);
});

// ---- coding lane routing: which coder leads, and when the other rescues ----------------------------
// Two coders sit behind the builder now: the local patch-coder (anchored fixes) and the agentic loop
// (feature-scale work the patch-coder provably exhausts on — #93-#96). generateChange picks the lead by
// task shape and runs the fallback ladder. It's injectable (patchFn/agenticFn), so these pin the exact
// routing seam the runner depends on with ZERO git/LLM/PR — the reviewer + downstream gates are untouched.
const { generateChange } = await import('./builder.mjs');

// Lane stand-ins that record the order they ran in. Each returns a distinct engine tag so we know who won.
function laneSpies() {
  const order = [];
  const patchFn = async () => { order.push('patch'); return { summary: 'patch', touched: ['a.mjs'], engine: 'patch' }; };
  const agenticFn = async () => { order.push('agentic'); return { summary: 'agentic', touched: ['b.mjs'], engine: 'agentic:x' }; };
  return { order, patchFn, agenticFn };
}

test('routing: a feature-shaped task (no concrete anchor) + agenticOk runs the AGENTIC lane first', async () => {
  const { order, patchFn, agenticFn } = laneSpies();
  const r = await generateChange({ task: 'Develop the Employer Dashboard', agenticOk: true, patchFn, agenticFn });
  assert.deepEqual(order, ['agentic'], 'agentic leads; the patch-coder is not touched');
  assert.equal(r.engine, 'agentic:x');
});

test('routing: an anchored task uses the PATCH-CODER first (agentic never runs)', async () => {
  const { order, patchFn, agenticFn } = laneSpies();
  const r = await generateChange({ task: 'Fix the greeting in engine/run.mjs', agenticOk: true, patchFn, agenticFn });
  assert.deepEqual(order, ['patch'], 'a concrete anchor stays on the patch-coder');
  assert.equal(r.engine, 'patch');
});

test('routing: agenticOk=false (CODER_AGENTIC=0 / no key) NEVER runs agentic, even feature-shaped', async () => {
  const { order, patchFn, agenticFn } = laneSpies();
  const r = await generateChange({ task: 'Develop the Employer Dashboard', agenticOk: false, patchFn, agenticFn });
  assert.deepEqual(order, ['patch'], 'the kill switch keeps it patch-only, as before the lane existed');
  assert.equal(r.engine, 'patch');
});

test('routing: the patch-coder EXHAUSTING an anchored task triggers ONE agentic rescue (from a clean base)', async () => {
  let resets = 0;
  const { order, agenticFn } = laneSpies();
  const patchFn = async () => { order.push('patch'); throw new Error('coder could not reach a green gate in 8 rounds'); };
  const r = await generateChange({ task: 'Fix engine/run.mjs alignment', agenticOk: true, patchFn, agenticFn, onLaneReset: () => { resets += 1; } });
  assert.deepEqual(order, ['patch', 'agentic'], 'exhaustion escalates to the agentic rescue');
  assert.equal(resets, 1, 'the touched set is reset before the rescue so it starts from a clean base');
  assert.equal(r.engine, 'agentic:x');
});

test('routing: a NON-exhaustion patch error is NOT rescued — it propagates honestly', async () => {
  const { order, agenticFn } = laneSpies();
  const patchFn = async () => { order.push('patch'); throw new Error('push failed: 403'); };
  await assert.rejects(() => generateChange({ task: 'Fix engine/run.mjs', agenticOk: true, patchFn, agenticFn }), /push failed/);
  assert.deepEqual(order, ['patch'], 'a real failure is not silently retried on the agentic lane');
});

test('routing: an agentic BUDGET stop on a feature task is honest — no fallback to the patch-coder', async () => {
  const { order, patchFn } = laneSpies();
  const agenticFn = async () => { order.push('agentic'); throw new Error('agentic budget exhausted (600001 tokens, 40 turns) — needs a human or a bigger budget'); };
  await assert.rejects(() => generateChange({ task: 'Develop the Employer Dashboard', agenticOk: true, patchFn, agenticFn }), /agentic budget exhausted/);
  assert.deepEqual(order, ['agentic'], 'budget exhaustion aborts; the patch-coder is not burned on the same whole feature');
});

test('routing: a NON-budget agentic error on a feature task falls back to the patch-coder', async () => {
  let resets = 0;
  const { order, patchFn } = laneSpies();
  const agenticFn = async () => { order.push('agentic'); throw new Error('Anthropic API call failed — HTTP 529: overloaded'); };
  const r = await generateChange({ task: 'Develop the Employer Dashboard', agenticOk: true, patchFn, agenticFn, onLaneReset: () => { resets += 1; } });
  assert.deepEqual(order, ['agentic', 'patch'], 'a transient agentic error degrades to the patch-coder');
  assert.equal(resets, 1, 'the reset runs before the fallback so it starts clean');
  assert.equal(r.engine, 'patch');
});

test('routing: a reviewer correction uses the stronger agentic lane instead of repeating a gate-green semantic failure', async () => {
  const { order, patchFn, agenticFn } = laneSpies();
  const r = await generateChange({ task: 'Fix engine/run.mjs', correction: true, agenticOk: true, forgeOk: true,
    patchFn, agenticFn, forgeFn: async () => { order.push('forge'); return { engine: 'forge' }; } });
  assert.equal(r.engine, 'agentic:x');
  assert.deepEqual(order, ['agentic']);
});

test('routing: reviewer correction falls from agentic to Forge, then patch only as a last resort', async () => {
  const order = [];
  const r = await generateChange({ task: 'Fix engine/run.mjs', correction: true, agenticOk: true, forgeOk: true,
    agenticFn: async () => { order.push('agentic'); throw new Error('cline unavailable'); },
    forgeFn: async () => { order.push('forge'); return { engine: 'forge:local' }; },
    patchFn: async () => { order.push('patch'); return { engine: 'patch' }; },
    onLaneReset: () => order.push('reset') });
  assert.equal(r.engine, 'forge:local');
  assert.deepEqual(order, ['agentic', 'reset', 'forge']);
});

// The no-broken-PR lever (Brandon 2026-08-03: "it has never pushed a non-broken PR"): the product gate
// now runs the REAL production build. A red `npm run build` is EXACTLY the broken PR — caught locally,
// before any push. execFn is injected so no real npm/next runs here.
test('productBuildErrors: a failing production build reds the gate; a repo with no build script has nothing to build', async () => {
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'buildgate-'));
  wf(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'next build' } }));

  // failing build → one BUILD error naming the failure
  const boom = () => { const e = new Error('exit 1'); e.stdout = 'Failed to compile.\napp/page.tsx: Unexpected token'; throw e; };
  const errs = productBuildErrors(dir, boom);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /BUILD \(npm run build/);
  assert.match(errs[0], /Failed to compile/);

  // green build → no errors
  assert.deepEqual(productBuildErrors(dir, () => ''), []);

  // PRODUCT_BUILD_GATE=0 is no longer decided here: productGate reports the skipped build as UNPROVEN
  // (gate.test.mjs), and the builder refuses to push an unproven change.

  // no build script → fail open (nothing to prove locally)
  wf(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
  assert.deepEqual(productBuildErrors(dir, boom), []);
});

// ---- forge lane routing: the OWNED engine leads feature work; failures fall DOWN the ladder ------
test('feature-shaped + forgeOk → FORGE leads; its failure falls to agentic, then patch', async () => {
  const order = [];
  const mk = (name, fail) => async () => { order.push(name); if (fail) throw new Error(`${name} could not finish`); return { summary: name, touched: [], engine: name }; };
  // forge wins outright
  let r = await generateChange({ task: 'build a whole new thing', forgeOk: true, agenticOk: true,
    forgeFn: mk('forge'), agenticFn: mk('agentic'), patchFn: mk('patch') });
  assert.equal(r.engine, 'forge');
  assert.deepEqual(order, ['forge']);
  // forge fails → agentic; resets between lanes so a half-attempt never leaks into the next
  order.length = 0; const resets = [];
  r = await generateChange({ task: 'build a whole new thing', forgeOk: true, agenticOk: true,
    forgeFn: mk('forge', true), agenticFn: mk('agentic'), patchFn: mk('patch'),
    onLaneReset: () => resets.push(1) });
  assert.equal(r.engine, 'agentic');
  assert.deepEqual(order, ['forge', 'agentic']);
  assert.equal(resets.length, 1, 'the failed forge attempt was reset before agentic ran');
  // forge + agentic fail → patch
  order.length = 0;
  r = await generateChange({ task: 'build a whole new thing', forgeOk: true, agenticOk: true,
    forgeFn: mk('forge', true), agenticFn: mk('agentic', true), patchFn: mk('patch') });
  assert.equal(r.engine, 'patch');
  assert.deepEqual(order, ['forge', 'agentic', 'patch']);
});

test('anchored task: patch leads; exhaustion → forge rescue → agentic rescue', async () => {
  const order = [];
  const exhausted = async () => { order.push('patch'); throw new Error('could not reach a green gate'); };
  const mk = (name, fail) => async () => { order.push(name); if (fail) throw new Error(`${name} failed`); return { summary: name, touched: [], engine: name }; };
  // forge rescues the exhausted patch-coder
  let r = await generateChange({ task: 'fix engine/server.mjs line 12', forgeOk: true, agenticOk: true,
    forgeFn: mk('forge'), agenticFn: mk('agentic'), patchFn: exhausted });
  assert.equal(r.engine, 'forge');
  assert.deepEqual(order, ['patch', 'forge']);
  // forge rescue fails → agentic rescue still runs
  order.length = 0;
  r = await generateChange({ task: 'fix engine/server.mjs line 12', forgeOk: true, agenticOk: true,
    forgeFn: mk('forge', true), agenticFn: mk('agentic'), patchFn: exhausted });
  assert.equal(r.engine, 'agentic');
  assert.deepEqual(order, ['patch', 'forge', 'agentic']);
});

test('forgeOk=false (CODER_FORGE=0) → exactly the pre-forge routing, forgeFn never called', async () => {
  const order = [];
  const mk = (name) => async () => { order.push(name); return { summary: name, touched: [], engine: name }; };
  const r = await generateChange({ task: 'build a whole new thing', forgeOk: false, agenticOk: true,
    forgeFn: mk('forge'), agenticFn: mk('agentic'), patchFn: mk('patch') });
  assert.equal(r.engine, 'agentic');
  assert.ok(!order.includes('forge'));
});

// ---- honest failure reasons ----------------------------------------------------------------------
// Audit of every build record (2026-08-13) found `error` was routinely a raw provider payload the
// owner could not act on. These pin the real strings that were recorded, so the regression is exact.
const { explainBuildFailure, failureProvider, baselineRedMessage } = await import('./builder.mjs');

test('the Anthropic out-of-credit failure reads as a BILLING action, not a stack trace (task-111)', () => {
  // Verbatim shape of run-202607190818-a1 and task-111 (2026-07-19).
  const raw = 'agentic coder: Anthropic API call failed — HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
  const x = explainBuildFailure(new Error(raw));
  assert.equal(x.kind, 'lane_credit');
  assert.equal(x.blocked, true, 'only the owner can clear this — it is not a coder failure');
  assert.match(x.reason, /out of credit/);
  assert.match(x.reason, /Anthropic/);
  assert.ok(!x.reason.includes('{'), 'no raw JSON in the human-facing reason');
  assert.equal(x.detail, raw, 'the original error is preserved verbatim, never swallowed');
});

test('a rate-limited lane names the provider and says to wait (run-202608032029-a1)', () => {
  const raw = 'agentic coder (groq): model call failed — HTTP 429: {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand`"}}';
  const x = explainBuildFailure(new Error(raw));
  assert.equal(x.kind, 'lane_rate_limit');
  assert.equal(x.blocked, true);
  assert.match(x.reason, /groq/, 'names which lane, not a generic "the model"');
  assert.match(x.reason, /rate-limited/);
  assert.equal(failureProvider(raw), 'groq');
});

test('a rejected API key is reported as a credential action, not breakage', () => {
  const x = explainBuildFailure(new Error('agentic coder: Anthropic API call failed — HTTP 401: {"error":{"message":"invalid x-api-key"}}'));
  assert.equal(x.kind, 'lane_auth');
  assert.equal(x.blocked, true);
  assert.match(x.reason, /refresh that key in \.env/);
});

test('a missing local coder tells the owner the exact command to run (chat-mreai2wv)', () => {
  const x = explainBuildFailure(new Error('no LOCAL coder is served — pull one (e.g. `ollama pull qwen2.5-coder:14b`) and set it in LOCAL_MODELS; the coding agent makes NO API calls'));
  assert.equal(x.kind, 'lane_missing');
  assert.equal(x.blocked, true);
  assert.match(x.reason, /ollama pull/);
});

test('a red base branch is BLOCKED and explicitly not blamed on the task (task-176)', () => {
  const x = explainBuildFailure(new Error('baseline tests are already red — fix next-migration first:\nTESTS (npm test):\n✖ two different episodes…'));
  assert.equal(x.kind, 'base_red');
  assert.equal(x.blocked, true);
  assert.match(x.reason, /this task is not at fault/);
});

test('coder-quality failures stay UNblocked — those are real work failures, not owner blockers', () => {
  const reject = explainBuildFailure(new Error('the reviewer rejected the change twice — needs a human: the diff does not accomplish the task'));
  assert.equal(reject.kind, 'reviewer_reject');
  assert.equal(reject.blocked, false, 'the coder tried and failed — the owner is not the blocker');
  const exhausted = explainBuildFailure(new Error('coder could not reach a green gate in 8 rounds (local + hosted lanes both tried)'));
  assert.equal(exhausted.kind, 'coder_exhausted');
  assert.equal(exhausted.blocked, false);
  assert.match(exhausted.reason, /split it or name a concrete file/, 'tells the owner how to make it buildable');
});

test('an unrecognized failure keeps its OWN text — never a fabricated diagnosis', () => {
  const x = explainBuildFailure(new Error('git push rejected: non-fast-forward'));
  assert.equal(x.kind, 'unknown');
  assert.equal(x.reason, 'git push rejected: non-fast-forward');
  assert.equal(x.detail, 'git push rejected: non-fast-forward');
});

test('an EMPTY error is reported as a reporter bug — never as a silent or successful build', () => {
  const x = explainBuildFailure(new Error(''));
  assert.equal(x.kind, 'empty');
  assert.match(x.reason, /without reporting any reason/);
  assert.match(x.reason, /not a verdict on the task/);
  assert.equal(explainBuildFailure(undefined).kind, 'empty');
});

test('baselineRedMessage never emits a blank evidence section (task-63/task-65 shipped "TESTS: " and nothing)', () => {
  // Both records recorded exactly 'baseline tests are already red — fix main first:\nTESTS: ' — a
  // failure message naming no failure, which is unactionable and looks like the task's fault.
  const blank = baselineRedMessage('main', ['']);
  assert.match(blank, /produced NO output/);
  assert.match(blank, /broken gate, not a broken test/);
  assert.equal(baselineRedMessage('main', []), blank, 'no errors at all reads the same');
  const real = baselineRedMessage('next-migration', ['TESTS (npm test):\n✖ timeline test failed']);
  assert.match(real, /✖ timeline test failed/, 'real evidence is kept');
  assert.match(real, /is not the cause/, 'and the task is still exonerated');
});

test('a GitHub 403/429 is NOT misdiagnosed as a coding-lane credential problem', () => {
  // Bare status codes are ambiguous. Blaming "your Anthropic key" for a GitHub permissions error
  // would send the owner to fix an account that is perfectly fine.
  const gh403 = explainBuildFailure(new Error('GitHub API 403: Resource not accessible by integration'));
  assert.equal(gh403.kind, 'unknown');
  assert.equal(gh403.blocked, false);
  assert.match(gh403.reason, /Resource not accessible/, 'keeps the real GitHub message');
  const gh429 = explainBuildFailure(new Error('GitHub API 429: You have exceeded a secondary rate limit'));
  assert.equal(gh429.kind, 'unknown', 'no lane context → not a lane verdict');
});

test('sameEngine sees the same MODEL through different lane labels, and never matches an unknown', async () => {
  const { sameEngine } = await import('./builder.mjs');
  assert.equal(sameEngine('local:qwen2.5-coder-32b', 'local:qwen2.5-coder-32b'), true);
  assert.equal(sameEngine('local:qwen2.5-coder:32b', 'agentic:ollama:qwen2.5-coder-32b'), true);
  assert.equal(sameEngine('groq', 'local:qwen2.5-coder-32b'), false);
  assert.equal(sameEngine('local:qwen2.5-coder-14b', 'local:qwen2.5-coder-32b'), false, 'a different local model IS a second opinion');
  assert.equal(sameEngine('', 'local:x'), false);
  assert.equal(sameEngine(undefined, undefined), false);
});

// PR Seen#293 was titled "- No brain/memory write-back: the `brain` MCP server failed to connect this
// session (credential denied)." — the last line of the claude-cli agent's prose report, used verbatim as
// the commit subject and PR title. A subject is one short imperative line or it is the task.
test('commitSubject never lets a lane\'s prose become the PR title', async () => {
  const { commitSubject } = await import('./builder.mjs');
  const task = '[product] Verify Deployment and Build Number';
  assert.equal(commitSubject('- No brain/memory write-back: the `brain` MCP server failed to connect this session (credential denied).', task), task, 'the exact Seen#293 shape');
  assert.equal(commitSubject('**Scope:** I keyed the dedup by endpoint\n- and a footnote', task), task, 'a report, not a subject');
  assert.equal(commitSubject('I implemented the change across three files', task), task);
  assert.equal(commitSubject('Note: the preview was not verified', task), task);
  // A real subject survives, however it is announced.
  assert.equal(commitSubject('SUMMARY: read the real Vercel commit env var in the admin build stamp', task), 'read the real Vercel commit env var in the admin build stamp');
  assert.equal(commitSubject('Add checkout.ahead reporting and test case', task), 'Add checkout.ahead reporting and test case');
  // Bounded, and never empty.
  const long = commitSubject(`x${'y'.repeat(200)}`, task);
  assert.ok(long.length <= 72 && long.endsWith('…'), long);
  assert.equal(commitSubject('', ''), 'autonomous change');
  assert.equal(commitSubject(null, 'Fix the off-by-one in lib/feed.mjs'), 'Fix the off-by-one in lib/feed.mjs');
});
