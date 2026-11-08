import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowStore } from './workflow-store.mjs';
import { runVerticalSlice } from './orchestrator.mjs';
import { intelligenceRuntimeStatus } from './runtime-status.mjs';

const store = () => new WorkflowStore({ dir: mkdtempSync(join(tmpdir(), 'wf-')) });
const contract = { kind: 'behaviour', grounded: true, targets: [{ path: 'lib/feed.mjs' }], allowedFiles: ['lib/feed.mjs', 'lib/feed.test.mjs'], completion: ['CI green on the PR'] };
const okBuild = (extra = {}) => async ({ task, dryRun, onEvent }) => {
  onEvent('[builder] contract: behaviour · 1 target(s), 2 writable file(s)');
  onEvent('[builder] reviewer (stub) accepted the diff ✓');
  return { ok: true, dryRun, summary: task, touched: ['lib/feed.mjs', 'lib/feed.test.mjs'], engine: 'stub', stat: ' lib/feed.mjs | 4 ++++', contract, ...extra };
};

test('a slice is a workflow record around the ONE pipeline — it delegates every coding decision to runBuild', async () => {
  const s = store(); let seen = null;
  const wf = await runVerticalSlice({ objective: 'Add a cutoff to lib/feed.mjs', repoRoot: '/nowhere', store: s, buildFn: async (o) => { seen = o; return okBuild()(o); } });
  assert.equal(seen.task, 'Add a cutoff to lib/feed.mjs');
  assert.equal(seen.repo, 'tool');
  assert.equal(seen.dryRun, true, 'local-only by default: nothing is pushed');
  assert.equal(wf.state, 'COMPLETED');
  assert.deepEqual(wf.history.map((h) => h.to), ['RECEIVED', 'CONTEXT_BUILDING', 'CONTEXT_READY', 'PLANNING', 'QUEUED', 'EXECUTING', 'TESTING', 'REVIEWING', 'SECURITY_CHECK', 'READY_FOR_PR', 'COMPLETED']);
  assert.equal(wf.tasks.length, 1, 'one change was built, so one task is recorded — no decorative subtasks');
  assert.deepEqual(wf.artifacts.prPackage.contract.allowedFiles, ['lib/feed.mjs', 'lib/feed.test.mjs']);
});

test('a REAL build is not COMPLETED by opening a PR — it waits at READY_FOR_PR for observed proof', async () => {
  const wf = await runVerticalSlice({ objective: 'Add a cutoff to lib/feed.mjs', store: store(), dryRun: false, buildFn: okBuild({ pr: 'https://github.com/x/y/pull/1' }) });
  assert.equal(wf.state, 'READY_FOR_PR');
  assert.equal(wf.artifacts.prPackage.pr, 'https://github.com/x/y/pull/1');
});

test('a failure is recorded with the builder\'s own owner-actionable reason, and rethrown', async () => {
  const s = store();
  await assert.rejects(runVerticalSlice({ objective: 'Make it better', store: s, workflowId: 'wf-x',
    buildFn: async () => { const e = new Error('refusing to build: this task cannot be grounded: it names no file'); e.refusal = true; throw e; } }), /cannot be grounded/);
  const wf = s.read('wf-x');
  assert.equal(wf.state, 'FAILED');
  assert.equal(wf.history.at(-1).evidence.kind, 'ungrounded_task');
  assert.equal(wf.history.at(-1).evidence.refusal, true);
  assert.match(wf.error, /names no file, function or entrypoint/);
});

test('the repo-dir seam is restored whatever happens', async () => {
  process.env.SEEN_COMMAND_REPO_DIR = '/original';
  try {
    let during = null;
    await runVerticalSlice({ objective: 'x', repoRoot: '/slice/target', store: store(), buildFn: async (o) => { during = process.env.SEEN_COMMAND_REPO_DIR; return okBuild()(o); } });
    assert.equal(during, '/slice/target');
    assert.equal(process.env.SEEN_COMMAND_REPO_DIR, '/original');
  } finally { delete process.env.SEEN_COMMAND_REPO_DIR; }
});

test('runtime status finally USES workflowStateCounts — the helper nine model runs were spent on and nothing called', () => {
  const status = intelligenceRuntimeStatus({ workflows: [{ state: 'FAILED' }, { state: 'FAILED' }, { state: 'COMPLETED' }], config: { runtime: {}, routing: {}, budget: {} }, registry: { hardware: null, models: [] } });
  assert.deepEqual(status.workflows.byState, { total: 3, FAILED: 2, COMPLETED: 1 });
});
