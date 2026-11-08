// admin-stats connector — the primary live business-truth source. Two-step custom auth:
// POST {action:'admin_login', username, password} → { token } (valid 8h), then every call sends
// X-Admin-Token. The token is cached in-process (and can be persisted by the caller). This is where
// users / revenue / jobs / errors / funnel come from — the numbers the exec team steers on.
//
// Seen's money model (Seen lib/server/creditRules.js, owner decisions 2026-10-25): two ONE-TIME products —
// Interview Prep $9.99 (+14 days Pro) and the 30-day Job Search Pass $19.99. Nothing renews; monthly/yearly
// Pro, the no-card trial, the Credit Pack and the Interview Sprint are retired. So revenue is "one-time
// sales in the last 30 days", read from Seen's revenue funnel (GET ?action=revenue_funnel), never MRR.
// monetization.mrr / active_paid now describe only subscriptions started before the change (legacy).

import { config } from '../config.mjs';

let cached = null; // { token, at }

function base() { return config.seenBaseUrl(); }

async function post(body, token) {
  const res = await fetch(`${base()}/api/admin-stats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
    body: JSON.stringify(body),
  });
  return res;
}

export async function login() {
  const creds = config.adminCreds();
  if (!creds) throw Object.assign(new Error('admin-stats not configured (set SEEN_ADMIN_USERNAME / SEEN_ADMIN_PASSWORD)'), { permanent: true });
  if (cached && Date.now() - cached.at < 7 * 3600 * 1000) return cached.token; // reuse within 7h (token lives 8h)
  const res = await post({ action: 'admin_login', username: creds.username, password: creds.password });
  if (!res.ok) throw Object.assign(new Error(`admin_login → ${res.status}: ${(await res.text()).slice(0, 120)}`), { permanent: res.status < 500 });
  const json = await res.json();
  if (!json.token) throw new Error('admin_login returned no token');
  cached = { token: json.token, at: Date.now() };
  return cached.token;
}

// Full business snapshot (GET with X-Admin-Token).
export async function stats() {
  const token = await login();
  const res = await fetch(`${base()}/api/admin-stats`, { headers: { 'x-admin-token': token } });
  if (res.status === 401 || res.status === 403) { cached = null; throw new Error('admin session expired'); }
  if (!res.ok) throw new Error(`admin-stats GET → ${res.status}`);
  return res.json();
}

// Seen's revenue funnel (lib/server/revenueFunnel.js): purchases by product, paying customers, every step
// from sign-up to checkout, and the monthly revenue the measured rates imply. Read-only.
export async function revenueFunnel(days = 30) {
  const token = await login();
  const res = await fetch(`${base()}/api/admin-stats?action=revenue_funnel&days=${encodeURIComponent(days)}`, { headers: { 'x-admin-token': token } });
  if (res.status === 401 || res.status === 403) { cached = null; throw new Error('admin session expired'); }
  if (!res.ok) throw new Error(`revenue_funnel → ${res.status}`);
  const j = await res.json();
  if (!j || j.ok !== true) throw new Error('revenue_funnel answered without ok — Seen may predate the funnel');
  return j;
}

/** The engine-facing revenue picture from the funnel (or null) + the legacy subscription fields. Pure. */
export function revenueFrom(funnel, m = {}) {
  const step = (k) => { const x = (funnel?.steps || []).find((st) => st.key === k); return x ? x.n ?? null : null; };
  const r = funnel?.revenue || null;
  return {
    model: 'one-time',
    days: funnel?.days ?? 30,
    month: r ? r.total ?? null : null,                    // $ of one-time purchases in the window
    payingCustomers: r ? r.paying_customers ?? null : null,
    prepPurchases: funnel ? step('prep_purchases') : null,
    passPurchases: r ? r.pass_count ?? null : null,
    prepRevenue: r ? r.interview_prep ?? null : null,
    passRevenue: r ? r.job_search_pass ?? null : null,
    interviews: funnel ? step('interviews') : null,       // cards at an interview now = the moment Prep sells
    offerShown: funnel ? step('prep_offer_shown') : null,
    offerClicked: funnel ? step('prep_offer_clicked') : null,
    checkoutsStarted: funnel ? step('checkout_started') : null,
    checkoutsCompleted: funnel ? step('checkout_completed') : null,
    rates: funnel?.rates || null,
    impliedMonthly: funnel?.implied || null,               // { interviews_per_month, take_rate_pct, dollars } | null
    recording: funnel ? !!funnel.recording : null,
    // Subscriptions started before 2026-10-25 that still run. Shown on their own line, never added to revenue.
    legacy: { mrr: m.mrr ?? null, subscribers: m.active_paid ?? null, markedPro: r ? r.legacy_subscriptions_marked_pro ?? null : null },
    proShare: m.conversion_pct ?? null,                    // % of accounts with Pro today (bought, comped or legacy)
    stripeConnected: !!m.stripe_connected,
  };
}

// Real-time cursor feed of new events (reports/apps/signups/employer sales).
export async function recentEvents(since) {
  const token = await login();
  const res = await post({ action: 'recent_events', since }, token);
  if (!res.ok) throw new Error(`recent_events → ${res.status}`);
  return res.json();
}

// Condensed, engine-friendly view of the snapshot (the fields depts reason over + KPI tiles).
export async function summary() {
  // The funnel is a second read; an older Seen deploy (or a failure) leaves revenue unknown, never zero.
  const [s, fr] = await Promise.all([stats(), revenueFunnel(30).then((v) => ({ v }), (e) => ({ e: String(e.message || e).slice(0, 160) }))]);
  const m = s.monetization || {};
  const jh = s.job_health || {};
  const jb = s.jobs || {};
  return {
    users: { total: s.users?.total ?? 0, newToday: s.users?.new_today ?? 0, dau: s.users?.dau ?? 0 },
    revenue: { ...revenueFrom(fr.v || null, m), funnelError: fr.e || null },
    jobs: { active: jh.active ?? jb.active ?? 0, stale: jb.stale_or_expired ?? jh.stale ?? 0,
      activePct: jh.active_pct ?? null, crisis: !!jh.crisis, addedToday: jb.added_today ?? jb.new_today ?? 0 },
    errors: { today: s.errors?.today ?? 0, thisWeek: s.errors?.this_week ?? 0 },
    flywheel: { shares: m.outcome_card_shares ?? 0, searches30d: s.flywheel?.job_searches_30d ?? 0,
      reportsTotal: s.reports?.total ?? 0, reportsToday: s.reports?.today ?? 0 },
    funnel: { outcomeBreakdown: s.reports?.outcome_breakdown ?? {}, ghostRatePct: s.applications?.ghost_rate_pct ?? null },
    // Whether the numbers above are measurements or partly fabricated zeros. The endpoint's `db()`
    // helper does not throw and its counts collapse to 0 on any failure, so `degraded` is the ONLY way
    // to tell "no rows" from "the query failed". Anything that records or displays these must check it.
    dataQuality: s.data_quality
      ? { degraded: !!s.data_quality.degraded, failedCount: s.data_quality.failed_query_count ?? 0,
        failed: s.data_quality.failed_queries ?? [] }
      : null, // older deploys of the product endpoint do not report it
    raw: { ...s, revenue_funnel: fr.v || null },
  };
}

export const snapshot = summary; // registry uses .snapshot() uniformly
export const configured = () => !!config.adminCreds();

// Any admin action ({ action, ... } → Seen's JSON). A 401 means the cached session ran out (8 h): sign in
// once more and repeat, so a long-open app never shows "session expired" for a click. Seen's own error
// text comes back as the thrown message (e.g. "salary_min must be a whole number…").
export async function adminAction(body, { _retried = false } = {}) {
  const token = await login();
  const res = await post(body, token);
  if (res.status === 401 && !_retried) { cached = null; return adminAction(body, { _retried: true }); }
  let json = null; try { json = await res.json(); } catch { /* not JSON */ }
  // `body` carries Seen's whole answer (its `detail` names the specific cause; cleanup actions also say how
  // much they did before failing), and an absent body marks a gateway/HTML error page (lib/data-health.mjs).
  if (!res.ok) { const e = new Error((json && json.error) || `${body.action} → HTTP ${res.status}`); e.status = res.status; e.body = json; throw e; }
  return json;
}
