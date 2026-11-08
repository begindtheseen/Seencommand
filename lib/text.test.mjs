import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameWork, findDuplicate, titleSimilarity, CONCRETE_ANCHOR } from './text.mjs';

// The REAL duplicate clusters from Brandon's task list (2026-07-09) — these must all be caught.
test('catches the ghost-report-alignment cluster (#26/#29/#36)', () => {
  assert.ok(sameWork('[product] Fix Ghost Report Table Alignment', 'Fix Ghost Report Table Alignment'));
  assert.ok(sameWork('Fix Ghost Report Table Alignment', 'Investigate and Optimize Ghost Report Table Alignment'));
});

test('catches the optimization-plan cluster (#31/#35/#37)', () => {
  assert.ok(sameWork('Chronos and Seen Command Optimization Plan', 'Chronos and Seen Command Optimization Plan Review'));
});

test('catches the error-monitoring cluster (#32/#34/#38)', () => {
  assert.ok(sameWork('Error Monitoring and Logging Feature PR',
    'Review and Merge Error Monitoring and Logging Feature PR'));
  assert.ok(sameWork('Error Monitoring and Logging Feature PR', 'Error Monitoring and Logging Feature PR Build'));
});

test('does NOT merge genuinely different work', () => {
  assert.ok(!sameWork('Fix Ghost Report Table Alignment', 'Error Monitoring and Logging Feature PR'),
    'Different tasks should not be considered the same work');
  assert.ok(!sameWork('Launch Reddit outreach campaign', 'Tiered pricing for the autonomous suite'));
  assert.ok(!sameWork('Ghost Report — 2026-07-10: acme tops the index', 'Weekly Progress Report Automation'));
});

test('findDuplicate returns the first matching open task', () => {
  const open = ['[product] Fix Ghost Report Table Alignment', '[product] Weekly Progress Report Automation'];
  assert.equal(findDuplicate('Optimize Ghost Report Table Alignment', open), open[0]);
  assert.equal(findDuplicate('Employer outreach to staffing agencies', open), null);
});

test('similarity is symmetric-ish sanity', () => {
  const a = 'Chronos and Seen Command Capabilities Audit';
  const b = 'Chronos and Seen Command Optimization Plan';
  assert.equal(titleSimilarity(a, b), titleSimilarity(b, a));
});

// CONCRETE_ANCHOR moved here from engine/run.mjs so engine/builder.mjs can route the coding lane by
// it (anchored → patch-coder, feature-shaped → agentic) without importing the meeting engine. run.mjs
// re-exports it, so agenda.test.mjs stays green; this pins the behavior at its new home.
test('CONCRETE_ANCHOR matches paths + known file types, not bare prose', () => {
  for (const s of ['app/employers/page.tsx', 'scripts/foo.mjs', 'api/refresh-jobs', 'command-center.html', 'run.mjs', 'add a 0007_jobs.sql migration']) {
    assert.ok(CONCRETE_ANCHOR.test(s), `${s} should read as a concrete anchor`);
  }
  for (const s of ['Develop the Employer Dashboard', 'optimize the job posting workflow', 'improve analytics overall']) {
    assert.equal(CONCRETE_ANCHOR.test(s), false, `${s} should NOT read as a concrete anchor`);
  }
});
