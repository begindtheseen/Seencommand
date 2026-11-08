// Tests for engine/forge/planner.mjs + engine/forge/lessons.mjs.
// Every external dependency is FAKED (reasonFn / factsFn / recordFn) — no network, no model, no
// Ollama, no vault. rankFacts is imported for real in one case because it is pure (keeper.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTask, formatPlan } from './planner.mjs';
import { recordLesson, lessonsFor, stableShortHash, LESSONS_SUBJECT } from './lessons.mjs';

// A reasonFn that returns a canned reply and captures what it was called with.
function fakeReason(reply, engine = 'ollama') {
  const calls = [];
  const fn = async (args) => { calls.push(args); return { text: reply, engine }; };
  fn.calls = calls;
  return fn;
}

const GOOD_JSON = JSON.stringify({
  approach: 'wire the new endpoint end to end',
  steps: [
    { title: 'add the route handler', doneMeans: 'GET /api/x returns 200 with the payload', targetFiles: ['app/api/x/route.ts'], hints: 'mirror app/api/y' },
    { title: 'cover it with a test', doneMeans: 'node --test passes with the new case', targetFiles: [] },
  ],
  risks: ['route name collides with the legacy page'],
});

// ---- planTask: model-planned paths -------------------------------------------------------------

test('planTask: good JSON → validated steps with renumbered ids and passthrough engine', async () => {
  const rf = fakeReason(GOOD_JSON, 'groq');
  const plan = await planTask({ task: 'add the x endpoint', context: 'CTX', lessons: ['copy SEARCH text verbatim'], reasonFn: rf });
  assert.equal(plan.engine, 'groq');
  assert.equal(plan.approach, 'wire the new endpoint end to end');
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map((s) => s.id), ['s1', 's2']);
  assert.equal(plan.steps[0].title, 'add the route handler');
  assert.equal(plan.steps[0].doneMeans, 'GET /api/x returns 200 with the payload');
  assert.deepEqual(plan.steps[0].targetFiles, ['app/api/x/route.ts']);
  assert.deepEqual(plan.steps[1].targetFiles, []); // defaults to [] when absent/empty
  assert.deepEqual(plan.risks, ['route name collides with the legacy page']);
  // the reason call carries the exact routing contract
  const call = rf.calls[0];
  assert.equal(call.deptId, 'product');
  assert.equal(call.competence, 'plan');
  assert.equal(call.maxTokens, 1500);
  assert.equal(call.fallback, '');
  assert.ok(call.prompt.includes('add the x endpoint'));
  assert.ok(call.prompt.includes('CTX'));
  assert.ok(call.prompt.includes('1. copy SEARCH text verbatim')); // lessons are numbered into the prompt
});

test('planTask: fenced + prose-wrapped JSON still parses', async () => {
  const dirty = 'Sure! Here is the plan you asked for:\n```json\n' + GOOD_JSON + '\n```\nLet me know if you need anything else.';
  const plan = await planTask({ task: 't', reasonFn: fakeReason(dirty) });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].id, 's1');
  assert.notEqual(plan.engine, 'deterministic');
});

test('planTask: braces inside JSON strings do not truncate the block', async () => {
  const tricky = JSON.stringify({ approach: 'a', steps: [{ title: 'print it', doneMeans: 'stdout shows "}" exactly once', targetFiles: [] }], risks: [] });
  const plan = await planTask({ task: 't', reasonFn: fakeReason('noise ' + tricky + ' trailing') });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].doneMeans, 'stdout shows "}" exactly once');
});

test('planTask: snake_case drift (done_means/target_files) is accepted', async () => {
  const drifted = JSON.stringify({ approach: 'a', steps: [{ title: 't1', done_means: 'observable thing', target_files: ['x.mjs'] }] });
  const plan = await planTask({ task: 't', reasonFn: fakeReason(drifted) });
  assert.equal(plan.steps[0].doneMeans, 'observable thing');
  assert.deepEqual(plan.steps[0].targetFiles, ['x.mjs']);
});

test('planTask: invalid steps are dropped and survivors renumbered', async () => {
  const mixed = JSON.stringify({ approach: 'a', steps: [
    { title: '', doneMeans: 'has done but no title' },
    { title: 'no doneMeans at all' },
    { title: 'the only real step', doneMeans: 'gate is green' },
  ] });
  const plan = await planTask({ task: 't', reasonFn: fakeReason(mixed) });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, 's1'); // renumbered — not s3
  assert.equal(plan.steps[0].title, 'the only real step');
});

test('planTask: maxSteps caps the plan', async () => {
  const many = JSON.stringify({ approach: 'a', steps: Array.from({ length: 7 }, (_, i) => ({ title: `step ${i + 1}`, doneMeans: `check ${i + 1}` })) });
  const plan = await planTask({ task: 't', reasonFn: fakeReason(many), maxSteps: 3 });
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((s) => s.id), ['s1', 's2', 's3']);
});

// ---- planTask: deterministic degradation -------------------------------------------------------

test('planTask: garbage text → deterministic single step', async () => {
  const plan = await planTask({ task: 'fix the thing that is broken', reasonFn: fakeReason('I would suggest refactoring for clarity.') });
  assert.equal(plan.engine, 'deterministic');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, 's1');
  assert.equal(plan.steps[0].title, 'fix the thing that is broken');
  assert.equal(plan.steps[0].doneMeans, 'the change is implemented, wired in, and the full gate is green');
  assert.deepEqual(plan.steps[0].targetFiles, []);
});

test('planTask: reason fallback (no lane answered) → deterministic', async () => {
  const plan = await planTask({ task: 'x'.repeat(200), reasonFn: async () => ({ text: '', engine: 'fallback' }) });
  assert.equal(plan.engine, 'deterministic');
  assert.equal(plan.steps[0].title.length, 120); // title clamps to 120 chars
});

test('planTask: zero valid steps in otherwise-valid JSON → deterministic', async () => {
  const plan = await planTask({ task: 't', reasonFn: fakeReason('{"approach":"a","steps":[{"title":"no done"}],"risks":[]}') });
  assert.equal(plan.engine, 'deterministic');
});

test('planTask: a throwing reasonFn never escapes — deterministic instead', async () => {
  const plan = await planTask({ task: 't', reasonFn: async () => { throw new Error('lane exploded'); } });
  assert.equal(plan.engine, 'deterministic');
  assert.equal(plan.steps.length, 1);
});

test('formatPlan: compact, includes ids, done-conditions, files, risks', async () => {
  const plan = await planTask({ task: 't', reasonFn: fakeReason(GOOD_JSON, 'groq') });
  const s = formatPlan(plan);
  assert.ok(s.includes('[groq]'));
  assert.ok(s.includes('s1. add the route handler'));
  assert.ok(s.includes('done means: GET /api/x returns 200'));
  assert.ok(s.includes('app/api/x/route.ts'));
  assert.ok(s.includes('risks:'));
  assert.equal(formatPlan(null), '(no plan)');
});

// ---- lessons: recordLesson ---------------------------------------------------------------------

test('recordLesson: emits exactly one fact in the brain-writer shape, with a stable predicate', () => {
  const got = [];
  const recordFn = (facts) => { got.push(...facts); return { written: 1 }; };
  const r = recordLesson({ kind: 'failure', repo: 'tool', task: 'fix the gate', lesson: 'never trust an ungated diff', detail: 'round 3 shipped red', recordFn });
  assert.equal(got.length, 1);
  const f = got[0];
  assert.equal(f.subject, LESSONS_SUBJECT);
  assert.match(f.predicate, /^failure-[0-9a-f]{8}$/);
  assert.equal(f.object, 'never trust an ungated diff');
  assert.equal(f.confidence, 'high'); // failure lessons are gate-observed
  assert.ok(f.source.includes('repo=tool'));
  assert.ok(f.source.includes('fix the gate'));
  assert.ok(f.source.includes('round 3 shipped red'));
  assert.equal(r.predicate, f.predicate);
  assert.equal(r.written, 1);
});

test('recordLesson: SAME lesson twice → same predicate (dedup no-op); DIFFERENT lessons never collide', () => {
  const preds = [];
  const recordFn = (facts) => { preds.push(facts[0].predicate); return { written: 0 }; };
  recordLesson({ kind: 'failure', lesson: 'copy SEARCH text verbatim', recordFn });
  recordLesson({ kind: 'failure', lesson: '  copy   SEARCH text verbatim \n', recordFn }); // whitespace drift = same lesson
  recordLesson({ kind: 'failure', lesson: 'cap retrieval windows', recordFn });
  assert.equal(preds[0], preds[1]);
  assert.notEqual(preds[0], preds[2]);
  // same TEXT under a different kind is a different predicate too — success and failure coexist
  const r = recordLesson({ kind: 'success', lesson: 'copy SEARCH text verbatim', recordFn });
  assert.match(r.predicate, /^success-[0-9a-f]{8}$/);
  assert.notEqual(r.predicate, preds[0]);
});

test('recordLesson: object caps at 300 chars; empty lesson is a no-op; recordFn throw is swallowed', () => {
  const got = [];
  const recordFn = (facts) => { got.push(...facts); return { written: 1 }; };
  recordLesson({ lesson: 'L'.repeat(500), recordFn });
  assert.equal(got[0].object.length, 300);
  const empty = recordLesson({ lesson: '   ', recordFn });
  assert.equal(empty.written, 0);
  assert.equal(empty.predicate, null);
  assert.equal(got.length, 1); // the empty lesson never reached the writer
  const boom = recordLesson({ lesson: 'ok', recordFn: () => { throw new Error('vault gone'); } });
  assert.equal(boom.written, 0);
  assert.match(boom.predicate, /^failure-[0-9a-f]{8}$/); // predicate still reported for the caller's ledger
});

test('stableShortHash: deterministic, 8 hex chars, input-sensitive', () => {
  assert.equal(stableShortHash('abc'), stableShortHash('abc'));
  assert.match(stableShortHash('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(stableShortHash('abc'), stableShortHash('abd'));
  assert.match(stableShortHash(''), /^[0-9a-f]{8}$/);
});

// ---- lessons: lessonsFor -----------------------------------------------------------------------

const FACTS = [
  { subject: 'Seen Command', predicate: 'current_focus', object: 'not a lesson' },
  { subject: LESSONS_SUBJECT, predicate: 'failure-aaaaaaaa', object: 'retrieval windows must be capped for big files' },
  { subject: LESSONS_SUBJECT, predicate: 'failure-bbbbbbbb', object: 'gate errors must be quoted verbatim to the model' },
  { subject: LESSONS_SUBJECT, predicate: 'success-cccccccc', object: 'small steps with observable done conditions land' },
  { subject: 'Forge lessons extra', predicate: 'x', object: 'wrong subject — must not leak' },
];

test('lessonsFor: filters to the Forge subject and ranks by task overlap (real rankFacts)', () => {
  const out = lessonsFor('the gate errors are not shown to the model', { factsFn: () => FACTS });
  assert.ok(out.length >= 1);
  assert.equal(out[0], 'gate errors must be quoted verbatim to the model'); // most term overlap wins
  assert.ok(!out.includes('not a lesson'));
  assert.ok(!out.includes('wrong subject — must not leak'));
});

test('lessonsFor: limit is respected and a custom rankFn is honored', () => {
  const rankFn = (facts, q, n) => facts.slice().reverse().slice(0, n); // deterministic fake ordering
  const out = lessonsFor('anything', { limit: 2, factsFn: () => FACTS, rankFn });
  assert.equal(out.length, 2);
  assert.equal(out[0], 'small steps with observable done conditions land'); // reversed order proves rankFn ran
});

test('lessonsFor: zero-overlap task falls back to most recent lessons instead of []', () => {
  const out = lessonsFor('zzz qqq vvv', { limit: 2, factsFn: () => FACTS });
  assert.equal(out.length, 2); // recency fallback: the last 2 Forge-subject lessons
  assert.deepEqual(out, [
    'gate errors must be quoted verbatim to the model',
    'small steps with observable done conditions land',
  ]);
});

test('lessonsFor: empty brain and throwing factsFn both yield []', () => {
  assert.deepEqual(lessonsFor('t', { factsFn: () => [] }), []);
  assert.deepEqual(lessonsFor('t', { factsFn: () => { throw new Error('no vault'); } }), []);
});
