import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the writable home BEFORE importing the builds store (reconcile marks records there), and
// point the activity-ledger's repo dir at the same temp so reconcile's logActivity writes land in the
// throwaway dir, never in the real repo's data/activity/ that Claude reads.
process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'seen-reconcile-'));
process.env.SEEN_COMMAND_REPO_DIR = process.env.SEEN_HOME;
const { reconcileMergedTasks, prCoords } = await import('./reconcile.mjs');
const { writeBuild, readBuild, reconcileStaleBuilds } = await import('../lib/builds.mjs');

// The real reaper with the process table stubbed — tests never ask the kernel about a live pid.
const sweepWith = (isAlive) => (o) => reconcileStaleBuilds({ ...o, isAlive });

const TOOL = 'begindtheseen/seen-command';
const rec = (id, over = {}) => ({
  id, repo: 'tool', status: 'pr_ready', updatedAt: 't1',
  pr: `https://github.com/${TOOL}/pull/46`, prNumber: 46,
  issue: { repo: TOOL, number: 44 },
  ...over,
});

test('prCoords reads the PR repo from the recorded URL (product PR, tool task)', () => {
  assert.deepEqual(prCoords({ pr: 'https://github.com/begindtheseen/Seen/pull/181' }), { repo: 'begindtheseen/Seen', number: 181 });
  assert.equal(prCoords({ pr: 'not a url' }), null);
  assert.equal(prCoords({}), null);
});

test('a task whose PR merged is closed and its record marked reconciled', async () => {
  writeBuild('task-44', rec('task-44'));
  const closedCalls = [];
  const r = await reconcileMergedTasks({
    builds: [readBuild('task-44')],
    prInfo: async () => ({ merged: true }),
    closeIssue: async (a) => closedCalls.push(a),
  });
  assert.deepEqual(r.closed, [`${TOOL}#44`]);
  assert.equal(closedCalls[0].number, 44);
  assert.match(closedCalls[0].comment, /MERGED/);
  const b = readBuild('task-44');
  assert.equal(b.status, 'merged');
  assert.equal(b.reconciled, true);
});

test('an unmerged PR leaves the task open; a merged sweep is not repeated', async () => {
  const calls = [];
  // unmerged → untouched
  const r1 = await reconcileMergedTasks({
    builds: [rec('task-50', { pr: `https://github.com/${TOOL}/pull/50`, issue: { repo: TOOL, number: 50 } })],
    prInfo: async () => ({ merged: false }),
    closeIssue: async (a) => calls.push(a),
  });
  assert.deepEqual(r1.closed, []);
  // already reconciled → skipped without any API reads
  const r2 = await reconcileMergedTasks({
    builds: [rec('task-51', { reconciled: true, issue: { repo: TOOL, number: 51 } })],
    prInfo: async () => { throw new Error('must not be called'); },
    closeIssue: async (a) => calls.push(a),
  });
  assert.deepEqual(r2.closed, []);
  assert.equal(calls.length, 0);
});

test('a pr_ready record whose PR is CLOSED-unmerged is flipped to pr_closed; the task stays open', async () => {
  // Seen #194: task #93's card lingered on "✅ PR ready" after the PR was closed without merging.
  writeBuild('task-93', rec('task-93', { status: 'pr_ready', pr: `https://github.com/${TOOL}/pull/194`, prNumber: 194, issue: { repo: TOOL, number: 93 } }));
  const closeCalls = [];
  const r = await reconcileMergedTasks({
    builds: [readBuild('task-93')],
    prInfo: async () => ({ state: 'closed', merged: false }),
    closeIssue: async (a) => closeCalls.push(a),
  });
  assert.deepEqual(r.closed, []);                    // task NOT closed — the work still needs doing
  assert.deepEqual(r.prClosed, [`${TOOL}#93`]);      // record flipped
  assert.equal(closeCalls.length, 0);                // the issue is never touched
  const b = readBuild('task-93');
  assert.equal(b.status, 'pr_closed');
  assert.match(b.prClosedReason, /closed without merging/i);
});

test('a still-OPEN pr_ready record is left alone (not marked pr_closed)', async () => {
  const r = await reconcileMergedTasks({
    builds: [rec('task-95', { status: 'pr_ready', issue: { repo: TOOL, number: 95 } })],
    prInfo: async () => ({ state: 'open', merged: false }),
    closeIssue: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.prClosed, []);
});

test('several records for one task → the NEWEST speaks, one close only', async () => {
  const calls = [];
  const newest = rec('task-44-manual', { pr: `https://github.com/${TOOL}/pull/46` });
  const older = rec('task-44-old', { pr: `https://github.com/${TOOL}/pull/40` });
  const r = await reconcileMergedTasks({
    builds: [newest, older], // listBuilds order: newest first
    prInfo: async ({ number }) => ({ merged: number === 46 }),
    closeIssue: async (a) => calls.push(a),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(r.closed, [`${TOOL}#44`]);
});

test('an unreadable PR or a failed close is skipped honestly, never thrown', async () => {
  const r = await reconcileMergedTasks({
    builds: [
      rec('task-60', { pr: `https://github.com/${TOOL}/pull/60`, issue: { repo: TOOL, number: 60 } }),
      rec('task-61', { pr: `https://github.com/${TOOL}/pull/61`, issue: { repo: TOOL, number: 61 } }),
    ],
    prInfo: async ({ number }) => { if (number === 60) throw new Error('boom'); return { merged: true }; },
    closeIssue: async ({ number }) => { if (number === 61) throw new Error('no perms'); },
  });
  assert.deepEqual(r.closed, []);
  assert.equal(r.skipped.length, 2);
});

// ---- zombie sweep: the case the PR walk structurally cannot reach ---------------------------------

test('a build that died before opening a PR is reaped — the PR walk can never see it', async () => {
  // No `pr` means `if (!pr) continue` skips this record forever, so before the sweep the dashboard
  // painted "building…" for a runner that exited days ago. Only a NEW build used to clear it.
  writeBuild('task-77', { id: 'task-77', status: 'building', pid: 999999, pr: null, issue: { repo: TOOL, number: 77 }, updatedAt: 't9' });
  const r = await reconcileMergedTasks({
    builds: [readBuild('task-77')],
    staleSweep: sweepWith(() => false),                 // that pid is definitively gone
    prInfo: async () => { throw new Error('must not be called — the record has no PR'); },
    closeIssue: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r.reaped, ['task-77']);
  assert.deepEqual(r.closed, []);                        // reaping a build never closes its task
  const b = readBuild('task-77');
  assert.equal(b.status, 'failed');                      // no longer a lie on the dashboard
  assert.equal(b.reapedFrom, 'building');
  assert.match(b.error, /pid 999999/);                   // actionable, not a reasonless red line
});

test('a build whose runner is still alive is left alone — a slow build is not a dead one', async () => {
  writeBuild('task-78', { id: 'task-78', status: 'building', pid: 4242, pr: null, issue: { repo: TOOL, number: 78 }, updatedAt: 't9' });
  const r = await reconcileMergedTasks({
    builds: [readBuild('task-78')],
    staleSweep: sweepWith(() => true),
    prInfo: async () => { throw new Error('must not be called'); },
    closeIssue: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r.reaped, []);
  assert.equal(readBuild('task-78').status, 'building'); // untouched
});

test('a failing stale sweep never aborts the merge reconcile', async () => {
  const r = await reconcileMergedTasks({
    builds: [rec('task-79', { pr: `https://github.com/${TOOL}/pull/79`, issue: { repo: TOOL, number: 79 } })],
    staleSweep: () => { throw new Error('process table unreadable'); },
    prInfo: async () => ({ merged: true }),
    closeIssue: async () => {},
  });
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.closed, [`${TOOL}#79`]);            // the merge work still happened
});

test('records without an issue or without a PR are ignored', async () => {
  const r = await reconcileMergedTasks({
    builds: [rec('x1', { issue: null }), rec('x2', { pr: null, issue: { repo: TOOL, number: 70 } }), { id: 'x3' }],
    prInfo: async () => { throw new Error('must not be called'); },
    closeIssue: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r.closed, []);
});
