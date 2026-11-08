// Tests for the failure loop. The requirement is not "log an error" — it is "a failure must never be
// a dead end", so the assertions that matter are the ones proving a failure SURVIVES partial outages:
// the on-disk queue is written before anything networked is attempted, and a brain write that throws
// still leaves an actionable record behind. Everything is injected; nothing touches the real vault.

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFailure, resolveFailure, openFailures, failureBrief, failureHistory } from './failure-loop.mjs';

function harness(over = {}) {
  const files = new Map();
  const calls = { facts: [], timeline: [], activity: [] };
  return {
    files, calls,
    deps: {
      dir: '/tmp/fake-failures',
      append: (p, line) => files.set(p, (files.get(p) || '') + line),
      facts: (f) => { calls.facts.push(f); return { written: 1 }; },
      timeline: (t) => { calls.timeline.push(t); return { recorded: true }; },
      activity: (a) => calls.activity.push(a),
      ...over,
    },
  };
}

const readerFor = (files) => ({
  dir: '/tmp/fake-failures',
  list: () => [...files.keys()].map((p) => p.split('/').pop()),
  read: (p) => files.get(p) ?? files.get(`/tmp/fake-failures/${p.split('/').pop()}`) ?? '',
});

test('a failure lands in the queue, the brain, and the activity ledger', () => {
  const h = harness();
  const r = recordFailure({
    kind: 'build', id: 'task-99', repo: 'tool', title: 'Wire the thing',
    reason: 'the coder produced an empty file', errorKind: 'coder', source: 'test',
  }, h.deps);

  assert.equal(r.ok, true);
  assert.equal(r.brain.ok, true);
  const line = JSON.parse([...h.files.values()][0].trim());
  assert.equal(line.id, 'task-99');
  assert.equal(line.resolved, false);
  assert.match(line.reason, /empty file/);
  // Chronos gets both an episode and an OPEN typed fact, so it is visible and queryable.
  assert.match(h.calls.timeline[0].heading, /Failure — build task-99/);
  assert.equal(h.calls.facts[0][0].subject, 'Seen Command failure task-99');
  assert.match(h.calls.facts[0][0].object, /^OPEN/);
  assert.equal(h.calls.activity[0].kind, 'failure');
});

test('a blocked failure is marked as the owner\'s to clear, not the coder\'s fault', () => {
  const h = harness();
  recordFailure({ id: 'task-111', reason: 'the Anthropic lane is out of credit', blocked: true }, h.deps);
  const line = JSON.parse([...h.files.values()][0].trim());
  assert.equal(line.blocked, true);
  assert.match(h.calls.facts[0][0].object, /blocked on owner/);
  assert.match(h.calls.timeline[0].text, /only Brandon can clear this/);
  assert.equal(h.calls.activity[0].status, 'blocked');
});

// The whole point: a failure must not be lost because a downstream system is down.
test('a brain outage never loses the failure — the queue still holds it', () => {
  const h = harness({ timeline: () => { throw new Error('vault unreachable'); } });
  const r = recordFailure({ id: 'task-7', reason: 'boom' }, h.deps);
  assert.equal(r.ok, true, 'the failure is still recorded');
  assert.equal(r.brain.ok, false);
  assert.match(r.brain.error, /vault unreachable/);
  assert.match([...h.files.values()][0], /task-7/);
});

test('a vault that silently accepts nothing is reported, not counted as success', () => {
  const h = harness({ timeline: () => null, facts: () => ({ written: 0 }) });
  const r = recordFailure({ id: 'task-8', reason: 'boom' }, h.deps);
  assert.equal(r.brain.ok, false);
  assert.match(r.brain.error, /accepted nothing/);
});

test('a failure without an id or reason is rejected rather than queued as junk', () => {
  const h = harness();
  assert.equal(recordFailure({ reason: 'x' }, h.deps).ok, false);
  assert.equal(recordFailure({ id: 'a' }, h.deps).ok, false);
  assert.equal(h.files.size, 0);
});

test('openFailures folds resolutions and reports the actionable/blocked split', () => {
  const h = harness();
  recordFailure({ id: 'a', reason: 'first', at: '2026-08-13T01:00:00Z' }, h.deps);
  recordFailure({ id: 'b', reason: 'blocked one', blocked: true, at: '2026-08-13T02:00:00Z' }, h.deps);
  recordFailure({ id: 'c', reason: 'third', at: '2026-08-13T03:00:00Z' }, h.deps);
  resolveFailure({ id: 'a', how: 'patched the coder prompt' }, { ...h.deps, at: '2026-08-13T04:00:00Z' });

  const out = openFailures({ ...readerFor(h.files), now: Date.parse('2026-08-13T05:00:00Z') });
  assert.deepEqual(out.open.map((r) => r.id), ['c', 'b'], 'newest first, resolved excluded');
  assert.equal(out.resolved, 1);
  assert.equal(out.blocked, 1);
  assert.equal(out.actionable, 1);
});

// A fix that did not hold is not a resolved failure.
test('the same id failing again after a resolution REOPENS it', () => {
  const h = harness();
  recordFailure({ id: 'x', reason: 'first break', at: '2026-08-13T01:00:00Z' }, h.deps);
  resolveFailure({ id: 'x', how: 'thought it was fixed' }, { ...h.deps, at: '2026-08-13T02:00:00Z' });
  recordFailure({ id: 'x', reason: 'broke again', at: '2026-08-13T03:00:00Z' }, h.deps);

  const out = openFailures({ ...readerFor(h.files), now: Date.parse('2026-08-13T04:00:00Z') });
  assert.equal(out.open.length, 1);
  assert.match(out.open[0].reason, /broke again/);
});

test('resolving supersedes the open fact instead of deleting the history', () => {
  const h = harness();
  resolveFailure({ id: 'task-99', how: 'fixed the premise guard' }, h.deps);
  assert.equal(h.calls.facts[0][0].subject, 'Seen Command failure task-99');
  assert.match(h.calls.facts[0][0].object, /^RESOLVED/);
  assert.equal(h.calls.activity[0].status, 'resolved');
});

test('an unreadable queue returns empty rather than throwing', () => {
  const out = openFailures({ dir: '/tmp/fake-failures', list: () => { throw new Error('gone'); } });
  assert.deepEqual(out.open, []);
});

// A retry that repeats a known failure is wasted money and time — the coder must be told what
// already failed, and told DIFFERENTLY when the blocker is one only Brandon can clear.
test('failureBrief hands the next attempt what already failed', () => {
  const h = harness();
  recordFailure({ id: 'task-5', reason: 'created an empty file to satisfy the test', errorKind: 'coder', at: '2026-08-13T01:00:00Z' }, h.deps);
  recordFailure({ id: 'task-5', reason: 'the reviewer rejected the patch twice', errorKind: 'reviewer', at: '2026-08-13T02:00:00Z' }, h.deps);
  recordFailure({ id: 'other', reason: 'unrelated', at: '2026-08-13T02:30:00Z' }, h.deps);

  const brief = failureBrief('task-5', { ...readerFor(h.files), now: Date.parse('2026-08-13T03:00:00Z') });
  assert.match(brief, /FAILED 2 time\(s\)/);
  assert.match(brief, /empty file/);
  assert.match(brief, /reviewer rejected/);
  assert.doesNotMatch(brief, /unrelated/, 'must not leak another task history');
  assert.match(brief, /genuinely different approach/);
});

test('a blocked history tells the coder to STOP rather than retry the work', () => {
  const h = harness();
  recordFailure({ id: 'task-6', reason: 'the Anthropic lane is out of credit', blocked: true, at: '2026-08-13T01:00:00Z' }, h.deps);
  const brief = failureBrief('task-6', { ...readerFor(h.files), now: Date.parse('2026-08-13T02:00:00Z') });
  assert.match(brief, /BLOCKED ON THE OWNER/);
  assert.match(brief, /stop and say so/);
});

test('a task with no history gets an empty brief, so callers can append unconditionally', () => {
  const h = harness();
  assert.equal(failureBrief('never-failed', { ...readerFor(h.files) }), '');
  assert.deepEqual(failureHistory('', {}), []);
});
