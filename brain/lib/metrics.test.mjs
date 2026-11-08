import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMetricFact, splitMetrics, metricsLine, kpiObservations, METRIC_KEYS } from './metrics.mjs';

const f = (subject, predicate, object, recorded_at) => ({ subject, predicate, object, recorded_at });

test('what was LEARNED leads, newest first by time; KPI readings fold to the latest per metric — counted, never dropped', () => {
  const facts = [
    f('Seen', 'active_jobs', '11800', '2026-09-18T08:00:00Z'),
    f('Seen brain gateway', 'mirror_only_fact_hazard', 'rpc deletes mirror-only rows', '2026-09-18T07:00:00Z'),
    f('Seen', 'active_jobs', '12000', '2026-09-18T12:00:00Z'),
    f('Seen', 'active_jobs', '11900', '2026-09-18T10:00:00Z'),
    f('Seen', 'mrr', '$100', '2026-09-18T12:00:00Z'),
    f('Seen production database', 'brain_migrations_applied_through', 'two migrations applied', '2026-09-18T13:00:00Z'),
  ];
  const { knowledge, metrics } = splitMetrics(facts);
  assert.deepEqual(knowledge.map((x) => x.predicate), ['brain_migrations_applied_through', 'mirror_only_fact_hazard']);
  assert.deepEqual(metrics.map((m) => [m.fact.predicate, m.fact.object, m.readings]), [['active_jobs', '12000', 3], ['mrr', '$100', 1]]);
  assert.equal(metricsLine(metrics), 'KPI readings (4 across 2 metrics — latest shown): active_jobs 12000 · mrr $100');
  assert.equal(metricsLine([]), '');
});

test('a metric is a (subject, predicate) PAIR — a fact that merely shares a predicate word is knowledge', () => {
  assert.equal(isMetricFact(f('Seen', 'active_jobs', '1')), true);
  assert.equal(isMetricFact(f(' seen ', 'ACTIVE_JOBS', '1')), true);
  assert.equal(isMetricFact(f('Seen deploy', 'state', 'READY')), true);
  assert.equal(isMetricFact(f('Seen Command', 'state', 'P1 shipped')), false);
  assert.equal(isMetricFact(f('Seen', 'active_jobs_definition', 'jobs with status=active')), false);
});

test('both KPI writers record from ONE list, and every reading in it is recognised as a metric', () => {
  const unknown = kpiObservations({ users: { total: 120, newToday: 5 }, revenue: { month: null, payingCustomers: null }, jobs: { active: 12000 }, errors: { today: 0 } });
  assert.deepEqual(unknown.map((o) => o.predicate), ['users_total', 'users_new_today', 'active_jobs', 'errors_today'], 'unknown revenue is never recorded as $0');
  const obs = kpiObservations({ users: { total: 120, newToday: 5 }, revenue: { month: 250, payingCustomers: 10 }, jobs: { active: 12000 }, errors: { today: 0 } });
  assert.deepEqual(obs.map((o) => `${o.predicate}=${o.object}`), ['users_total=120', 'users_new_today=5', 'revenue_30d=$250', 'paying_customers_30d=10', 'active_jobs=12000', 'errors_today=0']);
  assert.ok(obs.every(isMetricFact), 'a reading the writers record but the views do not fold would lead every briefing again');
  assert.ok(METRIC_KEYS.size >= obs.length);
});
