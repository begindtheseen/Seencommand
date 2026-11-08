// WIRING, not units: reviewer.test.mjs proves reviewDiff fails closed. This proves runBuild OBEYS it —
// the recurring failure in this repo is a guard that is green in its own test and ignored by its caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'builder-wiring-'));
process.env.SEEN_COMMAND_REPO_DIR = root;
const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib/core.mjs'), 'export const A = 1;\n');
g('add', '-A'); g('commit', '-m', 'seed');

const { runBuild, explainBuildFailure } = await import('./builder.mjs');

// GROUNDED by a real path, so the outcome never depends on which coding agents this machine has installed
// (CI has none: an ungrounded task is — correctly — refused there, and this test once passed only on a Mac with `claude`).
const TASK = 'add constant B to lib/core.mjs';
const greenGate = () => ({ green: true, errors: [] });
// A coding lane that writes one real, effective change into the build tree and reports it.
function lane(calls) {
  return async ({ patchFn }) => {
    calls.n++;
    // generateChange's contract: the lane returns only on a green gate, with what it touched.
    const dir = lane.workRoot(patchFn);
    writeFileSync(join(dir, 'lib/core.mjs'), 'export const A = 1;\nexport const B = 2;\n');
    return { touched: ['lib/core.mjs'], summary: 'add B', engine: 'stub-lane' };
  };
}
// The build tree is private to runBuild; recover it from the gate seam, which is handed the path.
let seenWorkRoot = null;
lane.workRoot = () => seenWorkRoot;
const gateSpy = (dir) => { seenWorkRoot = dir; return greenGate(); };
const branches = () => g('branch', '--list', 'exec/*');

test('a BLOCKED review stops the build: no commit, no coder retry, an owner-action reason', async () => {
  const calls = { n: 0 };
  await assert.rejects(
    runBuild({ task: TASK, dryRun: true, seams: {
      gate: gateSpy, generateFn: lane(calls),
      reviewFn: async () => ({ ship: false, defects: [], engine: 'unavailable', blocked: 'no reviewer lane answered' }),
    } }),
    (e) => {
      assert.match(e.message, /semantic review blocked: no reviewer lane answered/);
      assert.match(e.message, /NOT shipped/);
      const why = explainBuildFailure(e);
      assert.equal(why.kind, 'review_blocked');
      assert.equal(why.blocked, true, 'an owner-action blocker, not a task failure');
      return true;
    },
  );
  assert.equal(calls.n, 1, 'blocked is not a rejection — the coder is NOT asked to try again');
  assert.equal(branches(), '', 'the work branch was dropped');
  assert.equal(g('log', '--oneline').split('\n').length, 1, 'nothing was committed');
});

test('a REJECTED review does retry the coder with the named defects, then aborts on the second', async () => {
  const calls = { n: 0 }; const contexts = [];
  await assert.rejects(
    runBuild({ task: TASK, dryRun: true, seams: {
      gate: gateSpy,
      generateFn: async (o) => { contexts.push(o.extraContext); return lane(calls)(o); },
      reviewFn: async () => ({ ship: false, defects: ['lib.mjs: B is unused'], engine: 'stub' }),
    } }),
    /reviewer rejected the change twice/,
  );
  assert.equal(calls.n, 2);
  assert.match(contexts[1], /B is unused/, 'the second attempt is taught the defect');
});

test('an explicit approval is the ONLY thing that reaches the commit boundary', async () => {
  const calls = { n: 0 };
  const out = await runBuild({ task: TASK, dryRun: true, seams: {
    gate: gateSpy, generateFn: lane(calls), reviewFn: async () => ({ ship: true, defects: [], engine: 'stub' }),
  } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.touched, ['lib/core.mjs']);
});

test('CODER_REVIEW=0 can exercise a DRY RUN, and can never push', async () => {
  const disabled = async () => ({ ship: false, defects: [], engine: 'disabled', blocked: 'semantic review is disabled (CODER_REVIEW=0)' });
  const dry = await runBuild({ task: TASK, dryRun: true, seams: { gate: gateSpy, generateFn: lane({ n: 0 }), reviewFn: disabled } });
  assert.equal(dry.dryRun, true);
  // A real (non-dry) build with review off must die at the review, before any push or PR call.
  await assert.rejects(
    runBuild({ task: TASK, dryRun: false, seams: { gate: gateSpy, generateFn: lane({ n: 0 }), reviewFn: disabled } }),
    /semantic review blocked: semantic review is disabled/,
  );
  assert.equal(existsSync(join(root, '.git')), true);
});

test('an approval from the SAME model that wrote the change is not a review: blocked, unless knowingly opted in', async () => {
  const selfApprove = async () => ({ ship: true, defects: [], engine: 'local:stub-lane' });
  const authoredBy = (calls) => async (o) => ({ ...(await lane(calls)(o)), engine: 'local:stub-lane' });
  await assert.rejects(
    runBuild({ task: TASK, dryRun: true, seams: { gate: gateSpy, generateFn: authoredBy({ n: 0 }), reviewFn: selfApprove } }),
    (e) => { assert.match(e.message, /semantic review blocked: the only reviewer available \(local:stub-lane\) is the same model that wrote the change/); assert.equal(explainBuildFailure(e).kind, 'review_blocked'); return true; },
  );
  process.env.REVIEW_SAME_MODEL_OK = '1';
  try { assert.equal((await runBuild({ task: TASK, dryRun: true, seams: { gate: gateSpy, generateFn: authoredBy({ n: 0 }), reviewFn: selfApprove } })).ok, true); }
  finally { delete process.env.REVIEW_SAME_MODEL_OK; }
});
