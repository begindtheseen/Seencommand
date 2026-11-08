import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the writable home to a throwaway dir BEFORE importing the store (paths reads SEEN_HOME
// lazily, so setting it here keeps the real data/ dir untouched).
process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'seen-builds-'));
const { writeBuild, queueBuild, readBuild, appendBuildLog, listBuilds } = await import('./builds.mjs');

test('writeBuild creates then merges a record without losing prior fields', () => {
  writeBuild('run-x-a1', { id: 'run-x-a1', repo: 'tool', status: 'building', startedAt: 't0' });
  writeBuild('run-x-a1', { status: 'pr_ready', pr: 'https://example/pr/1', prNumber: 1 });
  const b = readBuild('run-x-a1');
  assert.equal(b.status, 'pr_ready');
  assert.equal(b.repo, 'tool');            // preserved across the merge
  assert.equal(b.startedAt, 't0');
  assert.equal(b.prNumber, 1);
});

test('appendBuildLog accumulates and is bounded', () => {
  for (let i = 0; i < 60; i++) appendBuildLog('run-x-a2', `line ${i}`);
  const b = readBuild('run-x-a2');
  assert.ok(b.log.length <= 40);           // MAX_LOG cap
  assert.ok(b.log[b.log.length - 1].includes('line 59'));
});

test('listBuilds returns every build written', () => {
  const ids = listBuilds().map((b) => b.id);
  assert.ok(ids.includes('run-x-a1'));
  assert.ok(ids.includes('run-x-a2'));
});

test('readBuild returns null for an unknown id', () => {
  assert.equal(readBuild('nope-nope'), null);
});

// ---- the build slot ------------------------------------------------------------------------------
const { acquireBuildSlot, releaseBuildSlot, buildSlotHolder, buildsDir } = await import('./builds.mjs');
const { writeFileSync } = await import('node:fs');

test('acquireBuildSlot takes a free slot and releaseBuildSlot frees it', async () => {
  assert.equal(buildSlotHolder(), null);
  await acquireBuildSlot('slot-a', null, { pollMs: 5 });
  const h = buildSlotHolder();
  assert.equal(h.id, 'slot-a');
  assert.equal(h.pid, process.pid);
  releaseBuildSlot();
  assert.equal(buildSlotHolder(), null);
});

test('a stale lock (dead holder pid) is cleared, not waited on', async () => {
  // pid 1 exists but is not signalable by us on macOS/Linux? Use an impossibly-high dead pid instead.
  writeFileSync(join(buildsDir(), '.runner.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, id: 'crashed-build', at: 't0' }));
  await acquireBuildSlot('slot-b', null, { pollMs: 5, timeoutMs: 500 }); // must NOT time out
  assert.equal(buildSlotHolder().id, 'slot-b');
  releaseBuildSlot();
});

test('a held slot makes the next acquire wait, then succeed on release', async () => {
  await acquireBuildSlot('slot-c', null, { pollMs: 5 });
  let waited = 0;
  const pending = acquireBuildSlot('slot-d', () => { waited++; }, { pollMs: 10, timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 40));
  releaseBuildSlot(); // slot-c lets go — but same pid holds; the lock is per-process so re-take works
  await pending;
  assert.ok(waited >= 1, 'second build reported waiting');
  assert.equal(buildSlotHolder().id, 'slot-d');
  releaseBuildSlot();
});

test('a live foreign holder is honored until timeout', async () => {
  writeFileSync(join(buildsDir(), '.runner.lock'), JSON.stringify({ pid: process.pid, id: 'other-build', at: 't0' }));
  await assert.rejects(
    () => acquireBuildSlot('slot-e', null, { pollMs: 10, timeoutMs: 60 }),
    /gave up waiting for the build slot/,
  );
  releaseBuildSlot(); // same-pid cleanup
});

// ---- pid liveness --------------------------------------------------------------------------------
const { pidAlive, staleBuildReason, reconcileStaleBuilds, NON_TERMINAL_BUILD } = await import('./builds.mjs');

test('pidAlive reads EPERM as ALIVE — a root-owned builder must not have its lock yanked', () => {
  // kill(pid,0) throwing EPERM means "the process exists, you just may not signal it". The old
  // `catch → dead` treated that as a corpse, cleared a LIVE holder's lock, and let a second builder
  // into the same checkout — the corruption the slot exists to prevent.
  const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
  const esrch = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
  assert.equal(pidAlive(999, eperm), true, 'EPERM = exists but not ours');
  assert.equal(pidAlive(999, esrch), false, 'ESRCH = genuinely gone');
  assert.equal(pidAlive(999, () => {}), true, 'no throw = alive');
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(undefined), false);
});

// ---- zombie builds -------------------------------------------------------------------------------
// A build record only reaches a terminal status if the runner LIVED to write one. Quit the app
// mid-build and the record freezes at 'building' — the dashboard then shows "building…" forever for a
// process that has not existed for days. engine/reconcile.mjs cannot catch this: it skips any record
// without a PR, and a build that died before opening one has none.
const T0 = Date.parse('2026-08-13T12:00:00.000Z');
const dead = () => false;
const alive = () => true;

test('a build whose runner pid is GONE is reaped, not shown as in-flight forever', () => {
  const b = { id: 'zombie-1', status: 'building', pid: 4242, updatedAt: '2026-08-13T11:59:00.000Z' };
  const reason = staleBuildReason(b, { now: T0, isAlive: dead });
  assert.match(reason, /pid 4242/);
  assert.match(reason, /exited without recording an outcome/);
  assert.match(reason, /Nothing was shipped/, 'says plainly that nothing shipped');
});

test('a build whose runner pid is STILL ALIVE is left alone — slow is not dead', () => {
  const b = { id: 'live-1', status: 'building', pid: 4242, updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(staleBuildReason(b, { now: T0, isAlive: alive }), null, 'a long build must not be reaped out from under itself');
});

test('a pid-less record falls back to a staleness age, so old records still get a verdict', () => {
  const old = { id: 'zombie-2', status: 'queued', updatedAt: '2026-08-10T12:00:00.000Z' }; // 72h
  assert.match(staleBuildReason(old, { now: T0, isAlive: dead }), /no progress for 72h/);
  const recent = { id: 'fresh-1', status: 'queued', updatedAt: '2026-08-13T11:30:00.000Z' }; // 30min
  assert.equal(staleBuildReason(recent, { now: T0, isAlive: dead }), null);
  const undatable = { id: 'weird-1', status: 'building' };
  assert.equal(staleBuildReason(undatable, { now: T0, isAlive: dead }), null, 'never guess without a date');
});

test('terminal records are never touched by the sweep', () => {
  for (const status of ['failed', 'refused', 'pr_ready', 'merged', 'updated', 'preview_failed', 'pr_closed']) {
    assert.equal(NON_TERMINAL_BUILD.has(status), false, status);
    assert.equal(staleBuildReason({ id: 'x', status, pid: 4242 }, { now: T0, isAlive: dead }), null, status);
  }
});

test('reconcileStaleBuilds marks a dead build FAILED with an actionable reason — never leaves it green or in-flight', () => {
  const written = [];
  const builds = [
    { id: 'zombie-3', status: 'building', pid: 77, updatedAt: '2026-08-13T11:00:00.000Z' },
    { id: 'running-ok', status: 'building', pid: 78, updatedAt: '2026-08-13T11:00:00.000Z' },
    { id: 'done', status: 'pr_ready', pid: 79, updatedAt: '2026-08-13T11:00:00.000Z' },
  ];
  const reaped = reconcileStaleBuilds({
    builds, now: T0,
    isAlive: (pid) => pid === 78,                       // only 'running-ok' still exists
    write: (id, patch) => written.push({ id, patch }),
  });
  assert.deepEqual(reaped.map((r) => r.id), ['zombie-3'], 'exactly the dead one');
  assert.equal(written.length, 1);
  assert.equal(written[0].patch.status, 'failed', 'a dead build is FAILED — never left in-flight');
  assert.equal(written[0].patch.reapedFrom, 'building', 'keeps what it was reaped from');
  assert.ok(written[0].patch.error && written[0].patch.error.length > 20, 'carries a real reason, not an empty string');
  assert.ok(written[0].patch.endedAt, 'gets a terminal timestamp');
});

test('reconcileStaleBuilds survives a write failure without aborting the sweep', () => {
  const seen = [];
  const builds = [
    { id: 'z-a', status: 'building', pid: 1, updatedAt: '2026-08-13T11:00:00.000Z' },
    { id: 'z-b', status: 'building', pid: 2, updatedAt: '2026-08-13T11:00:00.000Z' },
  ];
  const reaped = reconcileStaleBuilds({
    builds, now: T0, isAlive: dead, log: (m) => seen.push(m),
    write: (id) => { if (id === 'z-a') throw new Error('disk full'); },
  });
  assert.deepEqual(reaped.map((r) => r.id), ['z-b'], 'one bad write does not stop the rest');
  assert.ok(seen.some((m) => /could not reap z-a/.test(m)), 'the failure is logged, not swallowed');
});

// Live on 2026-09-21: three tasks were kicked, two were reaped as "zombie build reaped — was 'queued'
// with no live process" ONE SECOND later, and both then ran normally — so the dashboard showed a failed
// card for a healthy build. The reaped pids (50117, 50147) belonged to runs that had ended earlier.
test('re-queuing a stable build id wears NONE of the last run\'s verdict — above all not its pid', () => {
  const dead = 999999; // a pid that cannot be alive
  writeBuild('task-176', { id: 'task-176', repo: 'product', task: 'old', status: 'failed', pid: dead,
    error: 'the base branch is red', errorKind: 'base_red', blocked: true, endedAt: '2026-07-19T00:00:00.000Z',
    pr: 'https://github.com/o/r/pull/1', prNumber: 1, merged: true, summary: 'last time', touched: ['a.mjs'],
    proof: { state: 'failed', conditions: [] }, log: ['old line'] });

  const queued = queueBuild('task-176', { id: 'task-176', repo: 'product', task: 'fresh run' });
  assert.equal(queued.pid, null, 'a dead pid from the last run is what got fresh builds reaped');
  for (const [k, v] of Object.entries({ status: 'queued', error: null, errorKind: null, blocked: false, endedAt: null, pr: null, prNumber: null, merged: false, summary: null, proof: null })) {
    assert.deepEqual(queued[k], v, `${k} must not carry over`);
  }
  assert.deepEqual(queued.log, []);
  assert.equal(queued.task, 'fresh run');

  // The exact sweep that reaped it: a just-queued record must survive it.
  assert.equal(staleBuildReason(queued, { isAlive: () => false }), null);
  assert.deepEqual(reconcileStaleBuilds({ builds: [queued], isAlive: () => false, write: () => {} }), []);
  // …while a record whose OWN run really died is still reaped.
  const running = queueBuild('task-176', { pid: dead });
  assert.match(staleBuildReason(running, { isAlive: () => false }) || '', new RegExp(`pid ${dead}`));
});

// The bug was in the CALLERS: queueBuild's contract is useless if a queue site still uses writeBuild.
test('both places that queue a build use queueBuild — the server kick and the runner', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  for (const f of ['engine/server.mjs', 'engine/build-runner.mjs']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.match(src, /queueBuild\(id, \{/, `${f} must queue through queueBuild (it is what clears the last run's pid)`);
    assert.doesNotMatch(src, /writeBuild\(id, \{\s*\n?\s*id,[^}]*status: 'queued'/, `${f} must not hand-roll a queued record`);
  }
});
