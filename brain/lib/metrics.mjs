// METRIC FACTS — the brain's volatile readings, named once.
//
// The board meeting and brain-sync record live KPIs (users, MRR, active jobs…) as bi-temporal facts, and
// that is deliberate: the KPI reconcile reads the CURRENT value from the open fact, and the writer
// supersedes correctly (134 `active_jobs` facts, exactly one open — they never contradict one another).
// The cost is attention, not correctness: each refresh is a "new fact", so every "what changed?" view was
// led by metric churn ("Newest: active_jobs 12000, 11800, 11900") while the knowledge a session actually
// needs sat underneath. These are READINGS of a moving number, not things the system LEARNED. This module
// names them so every view can lead with knowledge and fold the readings into one line.
// (It lives in brain/lib because the session hook runs from the packaged app, which bundles only this dir.)
export const METRIC_KEYS = new Set([
  'seen|users_total', 'seen|users_new_today', 'seen|revenue_30d', 'seen|paying_customers_30d', 'seen|active_jobs', 'seen|errors_today',
  'seen|mrr', 'seen|paid_users', // legacy readings (subscriptions, before the 2026-10-25 one-time model) still fold as metrics
  'seen repo|open_prs', 'seen deploy|state', 'supabase|health',
]);
const keyOf = (f) => `${String(f.subject || '').trim().toLowerCase()}|${String(f.predicate || '').trim().toLowerCase()}`;
export const isMetricFact = (f) => METRIC_KEYS.has(keyOf(f));

const when = (f) => String(f.recorded_at || f.recorded || '');
export const newestFirst = (a, b) => when(b).localeCompare(when(a));

// Split facts into what was LEARNED (newest first) and the metric READINGS (latest per metric, with how
// many readings it folds). Nothing is dropped: `readings` counts every one.
export function splitMetrics(facts = []) {
  const knowledge = []; const latest = new Map();
  for (const f of facts) {
    if (!isMetricFact(f)) { knowledge.push(f); continue; }
    const k = keyOf(f); const cur = latest.get(k);
    if (!cur) latest.set(k, { fact: f, readings: 1 });
    else { cur.readings++; if (when(f).localeCompare(when(cur.fact)) >= 0) cur.fact = f; }
  }
  knowledge.sort(newestFirst);
  const metrics = [...latest.values()].sort((a, b) => keyOf(a.fact).localeCompare(keyOf(b.fact)));
  return { knowledge, metrics };
}

// One line for all of them: "KPI readings (9 across 3 metrics): active_jobs 12000 · mrr $100 · …"
export function metricsLine(metrics) {
  if (!metrics.length) return '';
  const total = metrics.reduce((n, m) => n + m.readings, 0);
  return `KPI readings (${total} across ${metrics.length} metric${metrics.length === 1 ? '' : 's'} — latest shown): ${metrics.map((m) => `${m.fact.predicate} ${String(m.fact.object).slice(0, 24)}`).join(' · ')}`;
}

// The readings both KPI writers record. ONE list: the board meeting (engine/run.mjs) and brain-sync
// each carried their own copy, "kept in step" by a comment.
export function kpiObservations(admin) {
  return [
    { subject: 'Seen', predicate: 'users_total', object: String(admin.users?.total ?? 0), confidence: 'high' },
    { subject: 'Seen', predicate: 'users_new_today', object: String(admin.users?.newToday ?? 0), confidence: 'high' },
    // Seen sells one-time products (2026-10-25): revenue is one-time sales in the last 30 days from its
    // revenue funnel. An unknown reading (older Seen, funnel failed) is left out, never recorded as $0.
    ...(admin.revenue?.month != null ? [{ subject: 'Seen', predicate: 'revenue_30d', object: `$${admin.revenue.month}`, confidence: 'high' }] : []),
    ...(admin.revenue?.payingCustomers != null ? [{ subject: 'Seen', predicate: 'paying_customers_30d', object: String(admin.revenue.payingCustomers), confidence: 'high' }] : []),
    { subject: 'Seen', predicate: 'active_jobs', object: String(admin.jobs?.active ?? 0), confidence: 'high' },
    { subject: 'Seen', predicate: 'errors_today', object: String(admin.errors?.today ?? 0), confidence: 'high' },
  ];
}
