// Scale-readiness watch: the limits seenjobs.io WILL hit as it grows, each with its live reading, the limit,
// the likely date at the current rate, what the fix costs, and what to do — OK / SOON (with ETA) / ACT NOW.
// A reading Seen Command cannot get says "unavailable" and where to look; it is never filled in.
//
// Rates: measured from this app's own snapshot history (data/money-history.jsonl) once there are ≥3 readings
// over ≥2 hours; until then the database growth uses the 2026-10-21 measurement (~5–6 MB/hour from the
// employer-board sync, recorded by a Seen session) and says it is assumed.
// Vendor limits are public list prices/limits as of 2026-10 — each says "confirm" where it matters.
import { formatPT } from '../time-pt.mjs';

const HOUR = 36e5;
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

export const LIMITS = {
  supabase: {
    free: { dbMb: 500, mau: 50_000, egressGb: 5, backups: false, price: 0 },
    pro: { dbMb: 8 * 1024, mau: 100_000, egressGb: 250, backups: true, price: 25 },
    source: 'Supabase public pricing (Free: 500 MB database, 50,000 MAU, 5 GB egress, no backups; Pro $25/mo: 8 GB, 100,000 MAU, 250 GB egress, daily backups) — confirm on supabase.com/pricing',
  },
  resend: { freePerDay: 100, freePerMonth: 3000, source: 'Resend free plan (100 emails/day, 3,000/month) — confirm your plan' },
};
// Measured 2026-10-21 (Seen CLAUDE.md session notes + the owner brief), used only until this app measures its own.
export const ASSUMED_DB_RATE = { low: 5, likely: 5.5, high: 6, source: 'measured 2026-10-21 by a Seen session (employer-board sync ~5–6 MB/hour) — not yet measured by Seen Command' };

// Least-squares slope of `key` per hour over the last `hours` of history.
export function growthRate(history = [], key, { hours = 72, minPoints = 3, minSpanHours = 2, now = new Date() } = {}) {
  const cut = +now - hours * HOUR;
  const pts = history.filter((h) => Number.isFinite(h?.[key]) && +new Date(h.at) >= cut).map((h) => [(+new Date(h.at) - cut) / HOUR, Number(h[key])]);
  if (pts.length < minPoints) return { perHour: null, points: pts.length, spanHours: 0, reason: `${pts.length} reading${pts.length === 1 ? '' : 's'} (need ${minPoints})` };
  const span = pts[pts.length - 1][0] - pts[0][0];
  if (span < minSpanHours) return { perHour: null, points: pts.length, spanHours: r1(span), reason: `readings span ${r1(span)} h (need ${minSpanHours})` };
  const n = pts.length; const mx = pts.reduce((a, p) => a + p[0], 0) / n; const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0); const sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  return { perHour: sxx ? sxy / sxx : 0, points: n, spanHours: r1(span) };
}

// Hours until `current` reaches `limit` at `perHour` (null when not growing). Already past → 0.
export function etaHours({ current, limit, perHour }) {
  if (!Number.isFinite(current) || !Number.isFinite(limit)) return null;
  if (current >= limit) return 0;
  if (!Number.isFinite(perHour) || perHour <= 0) return null;
  return (limit - current) / perHour;
}
export function statusFor({ blocking = false, eta = null, actHours = 48, soonHours = 14 * 24 } = {}) {
  if (blocking) return 'act';
  if (eta == null) return 'ok';
  return eta <= actHours ? 'act' : eta <= soonHours ? 'soon' : 'ok';
}
export function etaText(hours, { now = new Date() } = {}) {
  if (hours == null) return 'not growing at the current rate';
  if (hours === 0) return 'already reached';
  if (hours > 24 * 730) return 'over 2 years away at the current rate';
  const when = formatPT(new Date(+now + hours * HOUR), { now });
  const span = hours < 48 ? `~${Math.max(1, Math.round(hours))} h` : hours < 24 * 120 ? `~${Math.round(hours / 24)} days` : `~${Math.round(hours / 24 / 30)} months`;
  return `${span} (${when} PT)`;
}

// Two current facts with the same subject + predicate and different values = the brain disagrees with itself.
export function factContradictions(facts = []) {
  const g = new Map();
  for (const f of facts) { if (!f?.subject || !f?.predicate) continue; const k = `${String(f.subject).toLowerCase()}␟${String(f.predicate).toLowerCase()}`; const e = g.get(k) || { subject: f.subject, predicate: f.predicate, values: [] }; if (!e.values.some((v) => String(v.object) === String(f.object))) e.values.push({ object: String(f.object).slice(0, 200), since: f.valid_from || null }); g.set(k, e); }
  return [...g.values()].filter((e) => e.values.length > 1);
}

export function storageReading(raw) {
  const s = raw?.storage;
  if (!s) return null;
  const mb = Number.isFinite(Number(s.db_bytes)) ? Number(s.db_bytes) / 1048576 : Number.isFinite(Number(s.mb)) ? Number(s.mb) : null;
  const maxMb = Number.isFinite(Number(s.max_mb)) ? Number(s.max_mb) : Number.isFinite(Number(s.maxMb)) ? Number(s.maxMb) : null;
  return mb == null ? null : { mb: r1(mb), maxMb, blocking: !!s.blocking, enabled: s.enabled !== false };
}

const item = (o) => ({ reading: null, limit: null, eta: null, etaText: null, fixCost: null, source: null, ...o });

export function scaleWatch({ admin = null, history = [], money = {}, sales = null, facts = null, probes = null, now = new Date() } = {}) {
  const raw = admin?.raw || (admin && !admin.error && !admin.notConfigured ? admin : null);
  const plan = (money.plans?.supabase?.plan || 'free').toLowerCase();
  const lim = LIMITS.supabase[plan === 'free' ? 'free' : 'pro'];
  const items = [];

  // --- database size: the storage guard and the plan cap -------------------------------------------
  const st = storageReading(raw);
  const measured = growthRate(history, 'dbMb', { now });
  const rate = measured.perHour != null ? { likely: measured.perHour, low: measured.perHour, high: measured.perHour, observed: true, source: `measured by Seen Command: ${measured.points} readings over ${measured.spanHours} h` } : { ...ASSUMED_DB_RATE, observed: false };
  const dbItem = (id, title, limitMb, blocking, fix) => {
    if (!st) return item({ id, title, status: 'unknown', reading: 'unavailable — admin-stats has no storage reading (migration 20261021130000 not applied, or admin-stats not connected)', limit: `${limitMb} MB`, action: 'Check the database size in Supabase → Reports → Database.', fixCost: fix.cost });
    const eta = etaHours({ current: st.mb, limit: limitMb, perHour: rate.likely });
    const etaLate = etaHours({ current: st.mb, limit: limitMb, perHour: rate.low }); const etaEarly = etaHours({ current: st.mb, limit: limitMb, perHour: rate.high });
    return item({ id, title, status: statusFor({ blocking, eta }), reading: `${st.mb} MB`, value: st.mb, limit: `${limitMb} MB`, limitValue: limitMb, rate: `${r1(rate.likely)} MB/hour${rate.observed ? '' : ' (assumed)'}`, rateSource: rate.source,
      eta: eta == null ? null : new Date(+now + eta * HOUR).toISOString(), etaHours: eta == null ? null : r1(eta), etaText: blocking ? 'reached — new listings are being skipped' : etaText(eta, { now }) + (!rate.observed && eta ? ` · range ${etaText(etaEarly, { now }).split(' (')[0]}–${etaText(etaLate, { now }).split(' (')[0]}` : ''),
      fixCost: fix.cost, action: fix.action, source: 'admin-stats storage (RPC jobs_storage_status: pg_database_size vs jobs_storage_guard.max_mb)' });
  };
  if (st?.maxMb != null || !st) {
    items.push(dbItem('storage-guard', 'Storage guard — new job listings stop being saved', st?.maxMb ?? 470, !!st?.blocking, plan === 'free'
      ? { cost: '$25/mo (Supabase Pro, 8 GB)', action: 'Upgrade Supabase to Pro and raise jobs_storage_guard.max_mb; or reclaim space now (descriptions are most of the jobs table; VACUUM FULL jobs reclaims dead rows — owner OK needed).' }
      : { cost: '$0 (raise the guard)', action: 'You are on a paid plan: raise jobs_storage_guard.max_mb toward the plan size.' }));
  }
  if (plan === 'free') items.push(dbItem('plan-cap', 'Supabase Free database cap', LIMITS.supabase.free.dbMb, st ? st.mb >= LIMITS.supabase.free.dbMb : false, { cost: '$25/mo (Supabase Pro)', action: 'Past 500 MB Supabase can restrict a Free project. Move to Pro before the guard is lifted.' }));

  // --- backups ------------------------------------------------------------------------------------
  items.push(item({ id: 'backups', title: 'Database backups', status: lim.backups ? 'ok' : 'act', reading: lim.backups ? `daily backups on the ${plan} plan` : 'none on the Free plan (pitr_enabled false, empty backup list — 2026-10-21)', limit: 'at least daily', fixCost: lim.backups ? null : '$25/mo (Supabase Pro: daily backups)', action: lim.backups ? 'Test a restore once a quarter.' : 'Upgrade to Pro for daily backups. Until then run `npm run backup:supabase <dir>` in the Seen repo weekly (a full restore of it was verified 2026-10-21).', source: LIMITS.supabase.source }));

  // --- the brain disagreeing about the plan -------------------------------------------------------
  const contra = facts ? factContradictions(facts) : null;
  const planContra = contra ? contra.filter((c) => /supabase/i.test(`${c.subject} ${c.predicate}`) && /plan/i.test(c.predicate)) : null;
  if (planContra == null) items.push(item({ id: 'plan-facts', title: 'Brain: which Supabase plan are we on?', status: 'unknown', reading: 'brain not readable from here', action: 'Last known: the brain held "Free" (2026-10-21) and "Pro" (2026-10-01) as current facts. Confirm in Supabase → Billing and supersede the wrong one.' }));
  else if (planContra.length) items.push(item({ id: 'plan-facts', title: 'Brain disagrees about the Supabase plan', status: 'soon', reading: planContra.map((c) => c.values.map((v) => `"${v.object}"${v.since ? ` (since ${v.since})` : ''}`).join(' vs ')).join('; '), action: 'Treating Free as current (it was measured). Confirm in Supabase → Billing, then supersede the wrong fact (node scripts/act.mjs fact …).', source: 'brain current facts' }));

  // --- users vs auth MAU limit --------------------------------------------------------------------
  const users = Number(raw?.users?.total);
  const chart = raw?.monetization?.signups_chart;
  const week = Array.isArray(chart) ? chart.slice(-7).reduce((n, d) => n + (Number(d.count) || 0), 0) : null;
  const usersRate = growthRate(history, 'users', { now, hours: 24 * 14 });
  const perHour = usersRate.perHour != null ? usersRate.perHour : week != null ? week / (7 * 24) : null;
  if (Number.isFinite(users)) {
    const eta = etaHours({ current: users, limit: lim.mau, perHour });
    items.push(item({ id: 'mau', title: `Supabase monthly active users (${plan} plan)`, status: statusFor({ eta, soonHours: 60 * 24 }), reading: `≤ ${users.toLocaleString('en-US')} (all accounts — an upper bound on MAU)`, value: users, limit: lim.mau.toLocaleString('en-US'), rate: perHour != null ? `${r1(perHour * 24 * 7)} signups/week` : null, eta: eta == null ? null : new Date(+now + eta * HOUR).toISOString(), etaText: etaText(eta, { now }), fixCost: plan === 'free' ? '$25/mo (Pro: 100,000 MAU)' : 'usage-based above the included MAU', action: 'Nothing to do until the ETA is within two months.', source: `admin-stats users.total; growth from ${usersRate.perHour != null ? 'this app\'s readings' : 'the last 7 days of signups'}` }));
  } else items.push(item({ id: 'mau', title: 'Supabase monthly active users', status: 'unknown', reading: 'unavailable — admin-stats not connected', limit: lim.mau.toLocaleString('en-US') }));

  items.push(item({ id: 'egress', title: 'Supabase egress (data out)', status: 'unknown', reading: 'unavailable — not exposed to Seen Command', limit: `${lim.egressGb} GB/month`, action: 'Check Supabase → Usage once a week; job search pages are the heaviest readers.', source: LIMITS.supabase.source }));
  items.push(item({ id: 'vercel', title: 'Vercel usage (function time, bandwidth)', status: 'unknown', reading: 'unavailable — the Vercel connector reads deployments only', limit: 'Pro plan included usage', fixCost: 'usage-based above the included amounts', action: 'Check Vercel → Usage; set a spend limit in Vercel → Settings → Billing.' }));
  items.push(item({ id: 'email', title: 'Email sending (Resend)', status: 'unknown', reading: 'unavailable — send counts are in the Resend dashboard', limit: `${LIMITS.resend.freePerDay}/day, ${LIMITS.resend.freePerMonth.toLocaleString('en-US')}/month on the free plan`, action: 'Each tracked application can trigger day-7/14/30 follow-ups; check Resend → Usage before 1,000 users.', source: LIMITS.resend.source }));

  // --- Stripe readiness ---------------------------------------------------------------------------
  const acct = sales?.account && !sales.account.error ? sales.account : null;
  if (acct) items.push(item({ id: 'stripe-payouts', title: 'Stripe can charge and pay out', status: acct.charges_enabled && acct.payouts_enabled ? 'ok' : 'act', reading: `charges ${acct.charges_enabled ? 'on' : 'OFF'} · payouts ${acct.payouts_enabled ? 'on' : 'OFF'}${acct.details_submitted ? '' : ' · account details incomplete'}`, action: acct.charges_enabled && acct.payouts_enabled ? 'Nothing to do.' : 'Finish the Stripe account setup (Settings → Business details, bank account).', source: 'Stripe GET /v1/account' }));
  else items.push(item({ id: 'stripe-payouts', title: 'Stripe can charge and pay out', status: 'unknown', reading: sales?.configured === false ? 'unavailable — Stripe is not connected to Seen Command (STRIPE_SECRET_KEY)' : `unavailable${sales?.account?.error ? ` (${sales.account.error})` : ''}`, action: 'Check Stripe → Settings → Payouts.' }));
  const tax = sales?.tax && !sales.tax.error ? sales.tax : null;
  items.push(item({ id: 'stripe-tax', title: 'Sales tax (Stripe Tax)', status: tax ? (tax.status === 'active' ? 'ok' : 'soon') : 'unknown', reading: tax ? `Stripe Tax ${tax.status || 'not set up'}` : 'unavailable', action: tax?.status === 'active' ? 'Nothing to do.' : 'Decide with a tax professional whether you must collect sales tax on digital products (Interview Prep, the Job Search Pass) in your customers\' states; Stripe Tax can calculate and collect it.', source: tax ? 'Stripe GET /v1/tax/settings' : null }));
  const pastDue = Number(raw?.monetization?.past_due);
  if (Number.isFinite(pastDue)) items.push(item({ id: 'past-due', title: 'Failed payments on legacy subscriptions', status: pastDue > 0 ? 'act' : 'ok', reading: `${pastDue} past due (subscriptions started before 2026-10-25)`, value: pastDue, limit: '0', action: pastDue > 0 ? 'Turn on Stripe\'s automatic card-retry emails (Settings → Billing → Revenue recovery) and email the customer.' : 'Nothing to do.', source: 'admin-stats monetization.past_due' }));

  // --- errors, support load, the job board --------------------------------------------------------
  const errToday = Number(raw?.errors?.today), errWeek = Number(raw?.errors?.this_week);
  if (Number.isFinite(errToday)) {
    const avg = Number.isFinite(errWeek) ? errWeek / 7 : null;
    const spike = avg != null && errToday >= 10 && errToday > 2 * avg;
    items.push(item({ id: 'errors', title: 'Server errors', status: spike ? 'soon' : errToday >= 100 ? 'act' : 'ok', reading: `${errToday} today${avg != null ? ` (7-day average ${r1(avg)}/day)` : ''}`, value: errToday, limit: 'under 2× the weekly average', action: spike || errToday >= 100 ? 'Open Seen admin → Errors and fix the top route.' : 'Nothing to do.', source: 'admin-stats errors' }));
  } else items.push(item({ id: 'errors', title: 'Server errors', status: 'unknown', reading: 'unavailable' }));
  const q = { issues: Number(raw?.issues?.open), held: Number(raw?.held_reports?.pending), disputes: Number(raw?.listing_disputes?.open), claims: Number(raw?.employer_claims?.pending), unfulfilled: Number(raw?.employer_purchases?.unfulfilled) };
  if (Object.values(q).some(Number.isFinite)) {
    const total = Object.values(q).filter(Number.isFinite).reduce((a, b) => a + b, 0);
    const unpaid = Number.isFinite(q.unfulfilled) && q.unfulfilled > 0;
    items.push(item({ id: 'support', title: 'Support and review queue', status: unpaid ? 'act' : total > 25 ? 'soon' : 'ok', reading: [Number.isFinite(q.issues) && `${q.issues} open issues`, Number.isFinite(q.held) && `${q.held} held reports`, Number.isFinite(q.disputes) && `${q.disputes} listing disputes`, Number.isFinite(q.claims) && `${q.claims} employer claims`, Number.isFinite(q.unfulfilled) && `${q.unfulfilled} paid employer orders not delivered`].filter(Boolean).join(' · '), value: total, limit: 'under 25 waiting, 0 unfulfilled paid orders', action: unpaid ? 'An employer paid and has not received what they bought — fulfil it in Seen admin → Employers today.' : total > 25 ? 'Clear the queue in Seen admin before it becomes a trust problem.' : 'Nothing to do.', source: 'admin-stats issues / held_reports / listing_disputes / employer_claims / employer_purchases' }));
  }
  if (raw?.job_health) items.push(item({ id: 'job-board', title: 'Job board health', status: raw.job_health.crisis ? 'act' : 'ok', reading: `${Number(raw.job_health.active || 0).toLocaleString('en-US')} active (${raw.job_health.active_pct ?? '—'}% of all)`, action: raw.job_health.crisis ? 'Run the jobs steward: the board looks dead to users.' : 'Nothing to do.', source: 'admin-stats job_health' }));

  const readiness = readinessList({ users: Number.isFinite(users) ? users : null, plan, sales, probes, money });
  const order = { act: 0, soon: 1, unknown: 2, ok: 3 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  const counts = items.reduce((c, i) => { c[i.status] = (c[i.status] || 0) + 1; return c; }, {});
  return { at: now.toISOString(), atPT: formatPT(now, { now }), plan, items, counts, readiness, contradictions: contra, dbRate: rate };
}

// ---- first 100 / 500 / 1,000 users ------------------------------------------------------------------
export const READINESS = [
  { id: 'legal', milestone: 100, title: 'Terms of service and privacy policy are live', how: 'seenjobs.io/terms and /privacy' },
  { id: 'deletion', milestone: 100, title: 'Users can delete their account and data', how: 'Seen api/user-sync.js action delete_account (verified in the Seen repo 2026-10-21)', state: 'done' },
  { id: 'backups', milestone: 100, title: 'Backups exist and a restore has been tested', how: 'Supabase Pro daily backups, or `npm run backup:supabase` weekly (a restore was verified 2026-10-21)' },
  { id: 'payouts', milestone: 100, title: 'Stripe can charge and pay out', how: 'Stripe → Settings → Payouts' },
  { id: 'ratelimits', milestone: 500, title: 'Rate limits on public APIs', how: 'Seen lib/server/ratelimit.js, used by 5 api/ handlers (verified 2026-10-21)', state: 'done' },
  { id: 'abuse', milestone: 500, title: 'Fake-report and abuse defenses', how: 'held-report review queue + anti-gaming holds (Seen lib/server/reportReview.js)', state: 'done' },
  { id: 'support', milestone: 500, title: 'A support inbox answered within a day', how: 'owner confirms' },
  { id: 'alerts', milestone: 500, title: 'Error alerts reach you, not just a dashboard', how: 'owner confirms (e.g. Vercel or Seen Command notifications)' },
  { id: 'status', milestone: 1000, title: 'A public status page', how: 'none found in the Seen repo (2026-10-21)', state: 'todo' },
  { id: 'dbplan', milestone: 1000, title: 'Database plan sized for growth', how: 'Supabase Pro: 8 GB + daily backups, $25/mo' },
  { id: 'email', milestone: 1000, title: 'Email plan sized for outcome follow-ups', how: 'Resend → Usage vs plan' },
  { id: 'tax', milestone: 1000, title: 'Sales tax decided', how: 'Stripe Tax on, or a written reason it is not needed yet' },
  { id: 'incident', milestone: 1000, title: 'Incident runbook: who does what when the site is down', how: 'owner confirms' },
];

export function readinessList({ users = null, plan = 'free', sales = null, probes = null, money = {} } = {}) {
  const auto = {
    legal: probes ? (probes.terms?.ok && probes.privacy?.ok ? { state: 'done', evidence: 'both pages answered 200' } : { state: 'todo', evidence: `terms ${probes.terms?.status ?? 'no answer'}, privacy ${probes.privacy?.status ?? 'no answer'}` }) : { state: 'unknown', evidence: 'not probed' },
    backups: plan === 'free' ? { state: 'partial', evidence: 'manual backup + restore verified once (2026-10-21); no automatic backups on Free' } : { state: 'done', evidence: `daily backups on ${plan}` },
    payouts: sales?.account && !sales.account.error ? { state: sales.account.charges_enabled && sales.account.payouts_enabled ? 'done' : 'todo', evidence: 'Stripe account' } : { state: 'unknown', evidence: 'Stripe not readable' },
    dbplan: plan === 'free' ? { state: 'todo', evidence: 'on Free (500 MB, no backups)' } : { state: 'done', evidence: `on ${plan}` },
    tax: sales?.tax && !sales.tax.error ? { state: sales.tax.status === 'active' ? 'done' : 'todo', evidence: `Stripe Tax ${sales.tax.status || 'not set up'}` } : { state: 'unknown', evidence: 'Stripe not readable' },
  };
  return READINESS.map((r) => {
    const owner = money.readiness?.[r.id];
    const a = auto[r.id] || (r.state ? { state: r.state, evidence: r.how } : { state: 'unknown', evidence: 'owner confirms' });
    const state = owner ? (owner.done ? 'done' : 'todo') : a.state;
    const due = state === 'done' || users == null ? null : users >= r.milestone ? 'overdue' : users >= r.milestone / 2 ? 'due soon' : null;
    return { ...r, state, evidence: owner ? `marked ${owner.done ? 'done' : 'not done'} by the owner` : a.evidence, due };
  });
}
