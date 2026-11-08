// Orchestrator tests — every collaborator injected via deps, so this proves the PIPELINE (ground →
// plan → per-step implement/verify → final whole-task gate → lessons), not the modules (each has its
// own suite). No model, no network, no real gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeTask } from './index.mjs';

function baseDeps(overrides = {}) {
  const calls = { lessons: [], steps: [], verifies: 0 };
  const deps = {
    retrieveFn: () => ({ blocks: [{ path: 'a.mjs', start: 1, text: 'const x = 1;' }], files: ['a.mjs'] }),
    repoMapForFn: async () => ({ files: [] }),
    repoMapSummaryFn: () => 'engine/ — 3 files',
    lessonsForFn: () => ['never edit generated files directly'],
    planTaskFn: async () => ({
      approach: 'two small steps', engine: 'plan-test',
      steps: [
        { id: 's1', title: 'add helper', doneMeans: 'helper exported', targetFiles: ['lib/h.mjs'] },
        { id: 's2', title: 'wire helper', doneMeans: 'route uses helper', targetFiles: ['engine/server.mjs'] },
      ],
      risks: [],
    }),
    implementStepFn: async ({ step, context }) => { calls.steps.push({ id: step.id, context }); return { touched: [`file-${step.id}.mjs`], candidate: 1, engine: 'local-test' }; },
    verifyStepFn: () => ({ green: true, errors: [], notes: [] }),
    buildSelfReviewerFn: () => async () => 'APPROVE',
    recordLessonFn: (l) => calls.lessons.push(l),
    ...overrides,
  };
  return { deps, calls };
}
const greenGate = () => ({ green: true, errors: [] });

test('happy path: plans, implements each step, final gate, success lesson, aggregate result', async () => {
  const { deps, calls } = baseDeps();
  const events = [];
  const touched = [];
  const r = await forgeTask({
    task: 'build the thing', repoRoot: '/tmp/x', gate: greenGate, assertWritable: () => {},
    onEvent: (m) => events.push(m), onTouched: (p) => touched.push(p), deps,
  });
  assert.deepEqual(r.touched.sort(), ['file-s1.mjs', 'file-s2.mjs']);
  assert.match(r.engine, /^forge:plan-test\+local-test$/);
  assert.match(r.summary, /2 step\(s\), 2 file\(s\)/);
  assert.deepEqual(touched.sort(), ['file-s1.mjs', 'file-s2.mjs'], 'onTouched fired per file for builder cleanup');
  assert.equal(calls.steps.length, 2, 'both steps implemented in order');
  assert.equal(calls.lessons.length, 1);
  assert.equal(calls.lessons[0].kind, 'success');
  assert.ok(events.some((e) => /grounded:/.test(e)) && events.some((e) => /DONE ✓/.test(e)), 'narrates ground + done');
});

test('grounding context (map + retrieval + lessons) reaches the implementer prompt context', async () => {
  const { deps, calls } = baseDeps();
  await forgeTask({ task: 't', repoRoot: '/tmp/x', gate: greenGate, assertWritable: () => {}, deps });
  const ctx = calls.steps[0].context;
  assert.match(ctx, /REPO MAP/);
  assert.match(ctx, /RELEVANT CODE/);
  assert.match(ctx, /LESSONS FROM PRIOR RUNS/);
  assert.match(ctx, /never edit generated files directly/);
});

test('a step exhausting its candidates fails the WHOLE task honestly + records a failure lesson', async () => {
  const { deps, calls } = baseDeps({
    implementStepFn: async ({ step }) => {
      if (step.id === 's2') throw new Error('all 3 candidates red (first errors: SYNTAX x)');
      return { touched: ['ok.mjs'], candidate: 1, engine: 'local-test' };
    },
  });
  await assert.rejects(
    () => forgeTask({ task: 't', repoRoot: '/tmp/x', gate: greenGate, assertWritable: () => {}, deps }),
    /step "wire helper" could not reach green after 3 verified candidates/,
  );
  assert.equal(calls.lessons.length, 1);
  assert.equal(calls.lessons[0].kind, 'failure');
  assert.match(calls.lessons[0].lesson, /wire helper/);
});

test('per-step greens but a red FINAL gate fails honestly (a later step broke an earlier one)', async () => {
  const { deps, calls } = baseDeps();
  const gate = (root, touched) => (touched.length >= 2 ? { green: false, errors: ['TESTS: integration broke'] } : { green: true, errors: [] });
  await assert.rejects(
    () => forgeTask({ task: 't', repoRoot: '/tmp/x', gate, assertWritable: () => {}, deps }),
    /COMBINED change fails the full gate/,
  );
  assert.equal(calls.lessons[0].kind, 'failure');
  assert.match(calls.lessons[0].lesson, /combined change failed the gate/);
});

test('grounding failures never kill a run (no map, no brain, empty retrieval → still builds)', async () => {
  const { deps } = baseDeps({
    retrieveFn: () => { throw new Error('git grep exploded'); },
    repoMapForFn: async () => { throw new Error('no map'); },
    lessonsForFn: () => { throw new Error('no vault'); },
  });
  const r = await forgeTask({ task: 't', repoRoot: '/tmp/x', gate: greenGate, assertWritable: () => {}, deps });
  assert.equal(r.touched.length, 2, 'the pipeline ran on the plan alone');
});

test('lesson-write failures never mask the real outcome', async () => {
  const { deps } = baseDeps({ recordLessonFn: () => { throw new Error('brain offline'); } });
  const r = await forgeTask({ task: 't', repoRoot: '/tmp/x', gate: greenGate, assertWritable: () => {}, deps });
  assert.ok(r.summary, 'success still returned when the success-lesson write failed');
});

test('input contract: task, gate, assertWritable are required', async () => {
  await assert.rejects(() => forgeTask({ gate: greenGate, assertWritable: () => {} }), /needs a task/);
  await assert.rejects(() => forgeTask({ task: 't', assertWritable: () => {} }), /needs a gate/);
  await assert.rejects(() => forgeTask({ task: 't', gate: greenGate }), /needs assertWritable/);
});

// Attempt-2 lesson: steps that name targetFiles must SEE those files' real text (SEARCH blocks demand
// exact current content — without it every candidate dies "nothing applied").
const { targetFileContext } = await import('./index.mjs');
test('targetFileContext feeds each step the REAL current text of its target files', async () => {
  const files = { '/r/lib/small.mjs': 'export const a = 1;\n', '/r/lib/big.mjs': Array.from({ length: 300 }, (_, i) => (i === 200 ? 'function recordBoardMeeting() { return 1; }' : `// line ${i}`)).join('\n') };
  const readFn = (p) => { if (files[p] == null) { const e = new Error('ENOENT'); throw e; } return files[p]; };
  const step = { title: 'modify recordBoardMeeting timestamp', doneMeans: 'recordBoardMeeting includes generatedAt', targetFiles: ['lib/small.mjs', 'lib/big.mjs', 'lib/absent.mjs'] };
  const ctx = targetFileContext('/r', step, { readFn });
  assert.match(ctx, /CURRENT CONTENT OF lib\/small\.mjs/);
  assert.match(ctx, /export const a = 1;/, 'small file shipped whole');
  assert.match(ctx, /recordBoardMeeting\(\) \{ return 1; \}/, 'big file windowed AROUND the step keyword, not just the head');
  assert.match(ctx, /lib\/absent\.mjs — DOES NOT EXIST yet/, 'missing target flagged for NEWFILE');
});

test('per-step grounding reaches the implementer and re-reads AFTER earlier steps edit', async () => {
  const seen = [];
  const { deps } = baseDeps({
    implementStepFn: async ({ step, context }) => { seen.push({ id: step.id, hasLive: /LIVE-MARKER/.test(context) }); return { touched: ['x.mjs'], candidate: 1, engine: 'e' }; },
  });
  const { mkdtempSync: mkd, writeFileSync: wf } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { join: j } = await import('node:path');
  const dir = mkd(j(td(), 'forge-stepctx-'));
  wf(j(dir, 'target.mjs'), 'export const LIVE_MARKER = "LIVE-MARKER";\n');
  const twoStep = async () => ({ approach: 'a', engine: 'p', risks: [], steps: [
    { id: 's1', title: 't1', doneMeans: 'd1', targetFiles: ['target.mjs'] },
    { id: 's2', title: 't2', doneMeans: 'd2', targetFiles: ['target.mjs'] } ] });
  await forgeTask({ task: 't', repoRoot: dir, gate: () => ({ green: true, errors: [] }), assertWritable: () => {}, deps: { ...deps, planTaskFn: twoStep } });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.hasLive), 'both steps saw the target file\'s real text');
});
