import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsForRun, scheduleFact, healthClass, subjectFor } from './memory.mjs';

const bridge = [{ category: 'browser_bridge', count: 2, blocking: true }];
const run = (status, extra = {}) => ({ id: `agg-indeed-20261020T060000Z-${Math.random().toString(16).slice(2, 8)}`, pipeline: 'indeed', status, endedAt: '2026-10-20T06:10:00Z', metrics: { written: 40, uniqueListings: 44 }, diagnostics: { failureCategories: [] }, ...extra });

test('Chronos gets a fact only when the health class changes — never one per run', () => {
  let s = {};
  let r = factsForRun(run('completed'), s); assert.equal(r.facts.length, 1); assert.equal(r.facts[0].subject, subjectFor('indeed')); assert.match(r.facts[0].object, /^healthy since 2026-10-20/); s = r.state;
  r = factsForRun(run('completed'), s); assert.equal(r.facts.length, 0, 'a second healthy run is not news'); s = r.state;
  r = factsForRun(run('partial', { reason: '3 details failed' }), s); assert.equal(r.facts.length, 1); assert.match(r.facts[0].object, /^degraded/); s = r.state;
  assert.equal(factsForRun(run('cancelled'), s).facts.length, 0);
  assert.equal(healthClass('interrupted'), null);
});

test('a blocker becomes a persistent_blocker fact only after 2 consecutive runs, then is cleared', () => {
  let s = { lastClass: 'healthy' };
  let r = factsForRun(run('blocked', { reason: 'bridge', diagnostics: { failureCategories: bridge } }), s);
  assert.deepEqual(r.facts.map((f) => f.predicate), ['health']); s = r.state;
  r = factsForRun(run('blocked', { reason: 'bridge', diagnostics: { failureCategories: bridge } }), s);
  assert.deepEqual(r.facts.map((f) => f.predicate), ['persistent_blocker']);
  assert.match(r.facts[0].object, /Chrome Browser Bridge disconnected — blocked 2 consecutive runs/); s = r.state;
  r = factsForRun(run('blocked', { reason: 'bridge', diagnostics: { failureCategories: bridge } }), s);
  assert.equal(r.facts.length, 0, 'the third run does not re-record the same blocker'); s = r.state;
  r = factsForRun(run('completed'), s);
  assert.deepEqual(r.facts.map((f) => f.predicate).sort(), ['health', 'persistent_blocker']);
  assert.match(r.facts.find((f) => f.predicate === 'persistent_blocker').object, /^cleared 2026-10-20/);
});

test('facts never carry collected records — only conclusions', () => {
  const r = factsForRun(run('completed', { pipeline: 'company_intel', metrics: { dryRun: false, importedReports: 3, commentary: 9, companiesTargeted: 5 } }), {});
  assert.match(r.facts[0].object, /3 applicant reports \+ 9 commentary excerpts imported for 5 companies/);
  assert.ok(r.facts[0].object.length < 400);
  const f = scheduleFact('company_intel', { enabled: true, frequency: 'weekly', time: '07:00', weekday: 1 }, '2026-10-20');
  assert.equal(f.predicate, 'schedule');
  assert.match(f.object, /enabled by the owner on 2026-10-20: weekly on Monday at 07:00/);
  assert.match(scheduleFact('indeed', { enabled: false }, '2026-10-20').object, /disabled/);
});
