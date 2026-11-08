// Tests for task decomposition. The requirement is not "produce subtasks" — it is "produce subtasks
// whose union IS the original task, or refuse honestly". So the assertions that matter are: every
// piece carries the full original text (no scope-shaving is structurally possible), an atomic task
// is refused rather than ritually split, a reviewer-rejection history reorders the core first, and
// the model lane stays OFF here (these tests run offline) with its failures falling back to the
// deterministic split instead of erroring. Everything external is injected; nothing spawns.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { splitTask, _internals } from './task-split.mjs';

// A fake `claude` child: emits one stdout payload then closes. Shaped like the real spawn so the
// model lane's parser is exercised, not bypassed.
function fakeSpawn({ stdout = '', code = 0, failStart = false }, calls = []) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (failStart) throw new Error('no such binary');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
}

const CONJUNCTION_TASK = 'Add a /api/health endpoint that returns real uptime data and wire the dashboard tile to it, then document the check in HANDOFF.md';

const CRITERIA_TASK = `Ship the failures panel end to end. Acceptance criteria:
1. render the open failures from data/failures/*.jsonl on the dashboard
2. add a resolve button that appends a resolution line
3. record every resolution in the brain`;

const SEAMLESS_TASK = 'Make the overnight digest reliable enough that Brandon trusts it every morning without checking anything by hand';

const GREEN_GATE_HISTORY = [
  { at: '2026-08-12T01:00:00Z', reason: 'could not reach a green gate in 6/8 rounds', errorKind: 'coder', blocked: false },
];
const REVIEWER_HISTORY = [
  { at: '2026-08-12T02:00:00Z', reason: 'the reviewer rejected the change twice — needs a human', errorKind: 'reviewer', blocked: false },
];

test('a task with conjoined deliverables splits into 2-4 pieces plus integration', async () => {
  const r = await splitTask({ task: CONJUNCTION_TASK });
  assert.ok(r.subtasks.length >= 2 && r.subtasks.length <= 4, `got ${r.subtasks.length} subtasks`);
  assert.match(r.reason, /conjoined deliverables/);
  // The three clauses each became a piece, in the author's order.
  assert.match(r.subtasks[0].task, /DELIVERABLE 1 of 3: Add a \/api\/health endpoint/);
  assert.match(r.subtasks[1].task, /wire the dashboard tile/);
  assert.match(r.subtasks[2].task, /document the check/);
  // Integration is always last, and every piece carries a scope fence.
  assert.match(r.subtasks.at(-1).title, /Integration/);
  for (const s of r.subtasks.slice(0, -1)) assert.match(s.task, /SCOPE: ONLY this deliverable/);
});

test('numbered acceptance criteria are the strongest seam', async () => {
  const r = await splitTask({ task: CRITERIA_TASK });
  assert.equal(r.subtasks.length, 4, '3 criteria + integration');
  assert.match(r.reason, /3 listed acceptance criteria/);
  assert.match(r.subtasks[0].task, /render the open failures/);
  assert.match(r.subtasks[1].task, /resolve button/);
  assert.match(r.subtasks[2].task, /record every resolution in the brain/);
});

// The no-scope-shaving guarantee is structural: every subtask embeds the FULL original task, and the
// integration tail re-verifies the whole — so the union of any split covers the original by
// construction, not by model goodwill. Assert it as a property over every split shape.
test('union covers the original on every split', async () => {
  const splits = [
    await splitTask({ task: CONJUNCTION_TASK }),
    await splitTask({ task: CRITERIA_TASK }),
    await splitTask({ task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY }),
  ];
  for (const r of splits) {
    assert.ok(r.subtasks.length >= 2 && r.subtasks.length <= 4);
    for (const s of r.subtasks) {
      assert.ok(s.title && s.task, 'every subtask has a title and a task');
      assert.ok(s.task.includes(CONJUNCTION_TASK) || s.task.includes(CRITERIA_TASK.trim()) || s.task.includes(SEAMLESS_TASK),
        'every subtask carries the full original task text');
    }
    assert.match(r.subtasks.at(-1).task, /union of the split must never be less than the whole/);
  }
});

test('more pieces than fit are MERGED into the third, never dropped', async () => {
  const task = `Rework settings. Acceptance criteria:
- show the GitHub token status
- show the Vercel token status
- show the Supabase token status
- show the Stripe token status
- show the AI lane status
- add a refresh button`;
  const r = await splitTask({ task });
  assert.equal(r.subtasks.length, 4, 'capped at 3 pieces + integration');
  assert.match(r.subtasks[2].task, /none dropped/);
  for (const crit of ['Stripe token', 'AI lane', 'refresh button']) {
    assert.ok(r.subtasks[2].task.includes(crit), `overflow criterion "${crit}" survives in the merged piece`);
  }
});

test('an atomic task with no history refuses honestly instead of renaming the failure', async () => {
  const r = await splitTask({ task: 'Fix the off-by-one in the clip helper' });
  assert.deepEqual(r.subtasks, []);
  assert.match(r.reason, /already atomic — a split would just rename the failure/);
});

// The history says WHERE it died. A reviewer rejection means the coder shipped something that did
// nothing — so the core deliverable must come first and polish last, with the first piece told to
// make the thing exist and return real data before anything else.
test('a reviewer-rejection history reorders the split core-first', async () => {
  const task = 'Polish the dashboard styling and add a /api/status endpoint that returns real queue data';
  const plain = await splitTask({ task });
  assert.match(plain.subtasks[0].task, /DELIVERABLE 1 of 2: Polish the dashboard styling/, 'no history keeps the author\'s order');

  const biased = await splitTask({ task, history: REVIEWER_HISTORY });
  assert.match(biased.subtasks[0].task, /\/api\/status endpoint/, 'the core piece moved first');
  assert.match(biased.subtasks[0].task, /smallest verifiable core/);
  assert.match(biased.subtasks[0].task, /return real data, with tests that prove it/);
  assert.match(biased.reason, /reviewer rejected earlier attempts/);
});

test('a seamless task with real failure history gets the staged core-first split', async () => {
  const r = await splitTask({ task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY });
  assert.equal(r.subtasks.length, 3, 'core + remainder + integration');
  assert.match(r.subtasks[0].task, /smallest verifiable core/);
  assert.match(r.subtasks[1].task, /remaining behavior/);
  assert.match(r.subtasks.at(-1).title, /Integration/);
  assert.match(r.reason, /no textual seams, but 1 prior failure/);
});

// Pieces of a task starved of credit starve identically — a fully blocked history refuses to split,
// and the reason names the blocker so Brandon knows the fix is his, not the coder's.
test('a history that is entirely blocked-on-owner refuses to split', async () => {
  const r = await splitTask({
    task: CONJUNCTION_TASK, // seams exist, and still: splitting cannot outrun a dead lane
    history: [{ reason: 'the Anthropic lane is out of credit', blocked: true }],
  });
  assert.deepEqual(r.subtasks, []);
  assert.match(r.reason, /blocked on the owner/);
  assert.match(r.reason, /out of credit/);
  assert.match(r.reason, /clear the blocker/);
});

// These tests run offline: with TASK_SPLIT_MODEL unset and no explicit opt-in, the lane must never
// spawn — even on the exact branch (seamless + history) that would consult it.
test('the model lane is OFF by default — nothing spawns in tests', async () => {
  delete process.env.TASK_SPLIT_MODEL;
  const calls = [];
  const r = await splitTask(
    { task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY },
    { spawnFn: fakeSpawn({ stdout: 'should never run' }, calls) },
  );
  assert.equal(calls.length, 0, 'the claude CLI was not spawned');
  assert.equal(r.subtasks.length, 3, 'the deterministic staged split answered instead');
});

test('an enabled model lane proposes pieces, wrapped by the same union-preserving assembly', async () => {
  const calls = [];
  const stdout = JSON.stringify({
    result: JSON.stringify([
      { title: 'core', task: 'make the digest generator produce one real digest from live data' },
      { title: 'schedule', task: 'run it nightly and record the outcome in the brain' },
    ]),
  });
  const r = await splitTask(
    { task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY },
    { model: true, spawnFn: fakeSpawn({ stdout }, calls) },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-2), ['--output-format', 'json'], 'bounded single-shot, not an agent run');
  assert.equal(r.model.ok, true);
  assert.equal(r.subtasks.length, 3, '2 model pieces + integration');
  assert.match(r.subtasks[0].task, /digest generator/);
  for (const s of r.subtasks) assert.ok(s.task.includes(SEAMLESS_TASK), 'model pieces still carry the full original');
});

// The caller asked for a split and gets one — a model failure falls back to the deterministic
// answer, and (silent-zero rule) the dead lane is NAMED in the verdict, never absorbed quietly.
test('a model failure falls back to the deterministic split and says so', async () => {
  const r = await splitTask(
    { task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY },
    { model: true, spawnFn: fakeSpawn({ stdout: '', code: 1 }) },
  );
  assert.equal(r.subtasks.length, 3, 'the staged split still answered');
  assert.equal(r.model.ok, false);
  assert.match(r.model.error, /exited 1/);
  assert.match(r.reason, /model lane failed .* deterministic split was used/);
});

test('a model that answers junk instead of JSON falls back the same way', async () => {
  const r = await splitTask(
    { task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY },
    { model: true, spawnFn: fakeSpawn({ stdout: 'sure! here are some ideas…' }) },
  );
  assert.equal(r.subtasks.length, 3);
  assert.equal(r.model.ok, false);
  assert.match(r.model.error, /without a JSON array/);
});

test('a spawn that cannot start is a named model failure, not a crash', async () => {
  const r = await splitTask(
    { task: SEAMLESS_TASK, history: GREEN_GATE_HISTORY },
    { model: true, spawnFn: fakeSpawn({ failStart: true }) },
  );
  assert.equal(r.subtasks.length, 3);
  assert.match(r.model.error, /could not start the claude CLI/);
});

test('an empty task is invalid usage and throws, never an empty verdict', async () => {
  await assert.rejects(() => splitTask({ task: '' }), TypeError);
  await assert.rejects(() => splitTask({}), TypeError);
});

test('the reason callback narrates decisions, and a broken callback cannot break the split', async () => {
  const notes = [];
  const r = await splitTask({ task: CONJUNCTION_TASK, reason: (line) => notes.push(line) });
  assert.ok(notes.length >= 1);
  assert.match(notes[0], /conjoined deliverables/);
  assert.ok(r.subtasks.length >= 2);

  const r2 = await splitTask({ task: CONJUNCTION_TASK, reason: () => { throw new Error('ui gone'); } });
  assert.ok(r2.subtasks.length >= 2, 'the split still lands');
});

test('history rows may be bare strings — the failureBrief lines callers already hold', async () => {
  const r = await splitTask({ task: SEAMLESS_TASK, history: ['could not reach a green gate in 6/8 rounds'] });
  assert.equal(r.subtasks.length, 3, 'string history still triggers the staged split');
});

// Seam internals pinned directly — the split's quality is exactly the seam detector's quality.
test('conjunction clauses re-merge fragments that are not instructions of their own', () => {
  const clauses = _internals.conjunctionClauses('Harden the read and write path so it retries');
  assert.equal(clauses.length, 1, '"read and write path" is a noun phrase, not two deliverables');
});

test('multiple named files are the weakest seam and need a long task to fire', async () => {
  const short = await splitTask({ task: 'Touch engine/run.mjs and lib/brain.mjs' });
  assert.deepEqual(short.subtasks, [], 'two files alone do not make two deliverables');
  const long = await splitTask({
    task: 'Rework the activity pipeline so engine/run.mjs stamps run ids while lib/activity.mjs folds duplicate lines because the ledger currently double-counts board meetings',
  });
  assert.ok(long.subtasks.length >= 3, 'a long task naming two files splits per file');
  assert.match(long.reason, /named files/);
});
