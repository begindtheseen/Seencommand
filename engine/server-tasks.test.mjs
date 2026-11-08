// Tests for deleting a tracked task (engine/server.mjs deleteTask).
//
// The requirement Brandon set is not "remove the row" — it is "make it known to brain that its
// deleted". So the assertions that matter here are the dishonest-success ones: a close GitHub
// refused, a close that did not actually take effect, and a brain write that failed must all be
// reported as such. A task that silently vanishes is indistinguishable from one never filed, and the
// next board meeting would happily re-propose the work.
//
// server.mjs is import-safe (it only listens when it is the main module), so this imports the real
// function and injects every external call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTask } from './server.mjs';

function deps(over = {}) {
  const calls = { closed: [], recorded: [], activity: [], writes: [] };
  return {
    calls,
    d: {
      issueInfo: async () => ({ title: 'Wire the forge status skill' }),
      closeIssue: async (args) => { calls.closed.push(args); return { ok: true }; },
      issueState: async () => 'closed',
      recordBrainNote: async (n) => { calls.recorded.push(n); return { ok: true, kind: 'timeline' }; },
      logActivity: (a) => calls.activity.push(a),
      readBuild: () => null,
      writeBuild: (id, patch) => calls.writes.push({ id, patch }),
      ...over,
    },
  };
}

test('deleting a task closes the issue and records the reason in the brain', async () => {
  const { calls, d } = deps();
  const r = await deleteTask({ number: 42, reason: 'superseded by the ops master-kit' }, d);
  assert.equal(r.ok, true);
  assert.equal(r.recordedToBrain, true);
  assert.equal(calls.closed[0].number, 42);
  assert.match(calls.closed[0].comment, /superseded by the ops master-kit/);
  // The brain entry must carry the reason AND the do-not-re-propose signal.
  assert.match(calls.recorded[0].heading, /Task deleted/);
  assert.match(calls.recorded[0].text, /superseded by the ops master-kit/);
  assert.match(calls.recorded[0].text, /do not re-propose/i);
  assert.equal(calls.activity[0].kind, 'task-delete');
});

test('a missing reason is recorded honestly rather than left blank', async () => {
  const { calls, d } = deps();
  const r = await deleteTask({ number: 7 }, d);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no reason given');
  assert.match(calls.recorded[0].text, /no reason given/);
});

test('a GitHub refusal is an error, never a cheerful success', async () => {
  const { calls, d } = deps({ closeIssue: async () => { throw new Error('403 not authorized'); } });
  const r = await deleteTask({ number: 9, reason: 'x' }, d);
  assert.equal(r.ok, false);
  assert.match(r.error, /403 not authorized/);
  assert.equal(calls.recorded.length, 0, 'nothing may be written to the brain when the close failed');
  assert.equal(calls.activity.length, 0);
});

// The silent-failure class this repo keeps hitting: the API returns 200 but the state did not change.
test('a close that did not take effect is reported, not assumed', async () => {
  const { calls, d } = deps({ issueState: async () => 'open' });
  const r = await deleteTask({ number: 11, reason: 'x' }, d);
  assert.equal(r.ok, false);
  assert.match(r.error, /still open/);
  assert.equal(calls.recorded.length, 0);
});

test('a failed brain write is surfaced, not swallowed', async () => {
  const { d } = deps({ recordBrainNote: async () => ({ ok: false, error: 'no vault' }) });
  const r = await deleteTask({ number: 12, reason: 'x' }, d);
  assert.equal(r.ok, true);              // the issue really did close
  assert.equal(r.recordedToBrain, false); // but the UI must be able to say the brain missed it
  assert.equal(r.brainError, 'no vault');
});

test('an in-flight build for the deleted task is cancelled with a reason', async () => {
  const { calls, d } = deps({ readBuild: () => ({ id: 'task-20', status: 'building' }) });
  const r = await deleteTask({ number: 20, reason: 'wrong premise' }, d);
  assert.equal(r.cancelledBuild, true);
  assert.equal(calls.writes[0].id, 'task-20');
  assert.equal(calls.writes[0].patch.status, 'failed');
  assert.match(calls.writes[0].patch.error, /deleted by Brandon.*wrong premise/);
});

test('a finished build is left alone', async () => {
  const { calls, d } = deps({ readBuild: () => ({ id: 'task-21', status: 'pr_ready' }) });
  const r = await deleteTask({ number: 21, reason: 'done another way' }, d);
  assert.equal(r.cancelledBuild, false);
  assert.equal(calls.writes.length, 0);
});

test('a bad task number is rejected before anything is touched', async () => {
  const { calls, d } = deps();
  for (const n of [undefined, 0, -3, 'abc']) {
    const r = await deleteTask({ number: n, reason: 'x' }, d);
    assert.equal(r.ok, false);
    assert.match(r.error, /task number is required/);
  }
  assert.equal(calls.closed.length, 0);
});

// A 100KB paste went straight to a model lane: the request hung for minutes and the spend was real.
// The cap must REJECT rather than silently truncate — answering half a question is worse than saying
// the message is too long.
test('chat messages are bounded, and the limit is stated honestly', async () => {
  const { _chatLimits } = await import('./server.mjs');
  assert.equal(_chatLimits.tooLong('a normal question'), null);
  assert.equal(_chatLimits.tooLong('x'.repeat(_chatLimits.MAX_CHAT_CHARS)), null, 'exactly at the cap is allowed');
  const over = _chatLimits.tooLong('x'.repeat(_chatLimits.MAX_CHAT_CHARS + 1));
  assert.ok(over, 'one character over is rejected');
  assert.match(over, /20,001 characters/, 'says how long the message actually was');
  assert.match(over, /Trim it/, 'tells the user what to do instead');
});
