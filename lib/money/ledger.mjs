// The live money picture for seenjobs.io: revenue, costs, margin, burn, runway — every number carries its
// source or formula in `trace`, and anything that cannot be measured says so instead of showing a guess.
//
// Seen sells ONE-TIME products since 2026-10-25 (Interview Prep $9.99, the 30-day Job Search Pass $19.99,
// employer SKUs). Nothing renews, so there is no MRR/ARR/churn in the main picture:
//
//   consumer sales   Seen's revenue funnel (admin-stats ?action=revenue_funnel → raw.revenue_funnel): purchases
//                    by product in the last 30 days, from credit_transactions purchase_<sku>; else Stripe Checkout
//   employer sales   Stripe Checkout (employer SKUs), else Seen's employer_purchases table; last 30 days
//   legacy           subscriptions started before 2026-10-25 (admin-stats monetization.mrr) — real cash while
//                    they last, shown on their own line and labelled "ends as they cancel"
//   month revenue    consumer + employer + legacy subscriptions
//   paying           distinct paying customers in 30 days (the funnel)
//   average sale     consumer revenue ÷ consumer purchases
//   take rate        Interview Prep purchases ÷ cards that saw the Prep offer (the funnel)
//   payment fees     2.9% + $0.30 per charge — Stripe's standard US card rate, an ASSUMPTION (yours may differ)
//   gross margin     (month revenue − cost of serving: infra + product AI + payment fees) ÷ month revenue
//   net              month revenue − every known monthly cost;  burn = −net when negative
//   runway           cash on hand (owner-entered) ÷ burn, in months
// Pure: buildLedger() takes already-fetched readings. California time.
import { formatPT, ptDate } from '../time-pt.mjs';
import { COGS_CATEGORIES } from './store.mjs';
import { skuMetrics, employerFromAdmin, MIN_SAMPLE } from './sales.mjs';

export const STRIPE_FEE = { pct: 0.029, fixed: 0.30, source: "Stripe's standard US card rate (2.9% + $0.30) — assumption; check your Stripe pricing" };
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const usd = (x) => (x == null ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: x % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);

// Normalise admin-stats: accepts the connector summary() (with .raw) or the raw GET body.
export function adminRaw(admin) {
  if (!admin || admin.error || admin.notConfigured) return null;
  return admin.raw || admin;
}

export function buildLedger({ admin = null, stripeSubs = null, sales = null, employer = null, usage = null, money = {}, now = new Date() } = {}) {
  const raw = adminRaw(admin);
  const m = raw?.monetization || {};
  const trace = {}; const notes = []; const unavailable = [];
  if (!raw) unavailable.push(admin?.notConfigured ? 'admin-stats is not connected (set SEEN_ADMIN_USERNAME / SEEN_ADMIN_PASSWORD) — users and revenue are unknown' : `admin-stats did not answer${admin?.error ? ` (${admin.error})` : ''} — users and revenue are unknown`);
  if (raw?.data_quality?.degraded) notes.push(`admin-stats reported ${raw.data_quality.failed_query_count ?? 'some'} failed queries — some counts may read 0 when they are not`);

  const users = num(raw?.users?.total);
  trace.users = 'admin-stats users.total (profiles count)';

  // ---- consumer one-time sales, last 30 days ---------------------------------------------------------
  const f = raw?.revenue_funnel && raw.revenue_funnel.ok === true ? raw.revenue_funnel : null;
  const step = (k) => { const x = (f?.steps || []).find((st) => st.key === k); return x ? num(x.n) : null; };
  const sku = sales?.sessions?.rows ? skuMetrics(sales.sessions.rows, { now }) : null;
  let consumer = null; let purchases = { interview: null, pass30: null, legacyPack: null, total: null };
  if (f && f.revenue && f.revenue.total != null) {
    purchases = { interview: step('prep_purchases'), pass30: num(f.revenue.pass_count), legacyPack: num(f.revenue.credit_pack_count) };
    purchases.total = [purchases.interview, purchases.pass30, purchases.legacyPack].some((x) => x != null) ? (purchases.interview || 0) + (purchases.pass30 || 0) + (purchases.legacyPack || 0) : null;
    consumer = num(f.revenue.total);
    trace.consumer = `Seen revenue funnel, last ${f.days || 30} days (credit_transactions purchase_<sku>): ${purchases.interview ?? '?'} Interview Prep (${usd(num(f.revenue.interview_prep))}) + ${purchases.pass30 ?? '?'} Job Search Pass (${usd(num(f.revenue.job_search_pass))})${purchases.legacyPack ? ` + ${purchases.legacyPack} legacy Credit Pack (${usd(num(f.revenue.credit_pack))})` : ''}`;
  } else if (sku) {
    const by = sku.consumer.bySku || {};
    purchases = { interview: by.interview?.count ?? 0, pass30: by.pass30?.count ?? 0, legacyPack: by.credits20?.count ?? 0, total: sku.consumer.count };
    consumer = sku.consumer.revenue;
    trace.consumer = `Stripe Checkout, paid one-time consumer sessions in 30 days: ${sku.consumer.count} (${usd(sku.consumer.revenue)})${sales.sessions.complete ? '' : ' — first 500 sessions only'}; Seen's revenue funnel not readable${admin?.revenue?.funnelError ? ` (${admin.revenue.funnelError})` : ''}`;
  } else {
    trace.consumer = `unknown — Seen's revenue funnel not readable${admin?.revenue?.funnelError ? ` (${admin.revenue.funnelError})` : ''} and Stripe Checkout not readable here`;
    if (raw) unavailable.push('Interview Prep / Job Search Pass sales are unknown — Seen\'s revenue funnel did not answer and Stripe is not readable here');
  }

  // ---- employer one-time sales, last 30 days ---------------------------------------------------------
  let employer30 = null; let employerCount = 0;
  if (sku) { employer30 = sku.employer.revenue; employerCount = sku.employer.count; trace.employer = `Stripe Checkout, paid employer sessions in 30 days: ${sku.employer.count} (${usd(sku.employer.revenue)})`; }
  else if (employer && !employer.error) { const e = employerFromAdmin(employer, { now }); employer30 = e.revenue; employerCount = e.count; trace.employer = `Seen employer_purchases, paid in 30 days: ${e.count} (${usd(e.revenue)})`; }
  else trace.employer = 'unknown — Stripe Checkout and Seen employer purchases not readable';

  // ---- legacy subscriptions (before 2026-10-25) ------------------------------------------------------
  let legacyMrr = num(m.mrr);
  trace.legacy = legacyMrr != null ? 'admin-stats monetization.mrr — subscriptions started before 2026-10-25, still billing; ends as they cancel (Seen starts no new ones)' : null;
  const stripeMrr = stripeSubs && !stripeSubs.error ? num(stripeSubs.mrr) : null;
  if (legacyMrr == null && stripeMrr != null) { legacyMrr = stripeMrr; trace.legacy = 'Stripe active subscriptions (legacy, before 2026-10-25), normalised to monthly; ends as they cancel'; }
  if (legacyMrr == null) trace.legacy = 'unknown (Stripe not connected on seenjobs.io)';
  const legacy = { mrr: r2(legacyMrr), subscribers: num(m.active_paid), pastDue: num(m.past_due), canceling: num(m.canceling), note: 'subscriptions started before 2026-10-25 — they end as they cancel; Seen starts no new ones' };

  // ---- totals ----------------------------------------------------------------------------------------
  const parts = [consumer, employer30, legacyMrr];
  const monthRevenue = parts.every((x) => x == null) ? null : parts.reduce((n, x) => n + (x || 0), 0);
  trace.monthRevenue = 'consumer one-time sales + employer sales (last 30 days) + legacy subscriptions';
  if (consumer == null && monthRevenue != null) notes.push('Month revenue excludes Interview Prep / Job Search Pass sales — they could not be read');

  let paying = f?.revenue ? num(f.revenue.paying_customers) : null;
  trace.paying = paying != null ? `Seen revenue funnel: distinct customers with a purchase in the last ${f.days || 30} days (a comped account or a free Pro window is never counted)` : 'unknown — needs Seen\'s revenue funnel';
  const buyerShare = paying != null && users > 0 ? paying / users : null;
  trace.buyerShare = buyerShare != null ? `${paying} paying in 30 days ÷ ${users} accounts` : 'unknown';
  const proShare = num(m.conversion_pct); trace.proShare = 'admin-stats conversion_pct (accounts with Pro today ÷ all accounts — bought, comped or legacy)';

  const avgSale = consumer != null && purchases.total > 0 ? consumer / purchases.total : null;
  trace.avgSale = avgSale != null ? `${usd(r2(consumer))} ÷ ${purchases.total} consumer purchase${purchases.total === 1 ? '' : 's'}` : 'needs at least one consumer purchase';
  const revenuePerUser = monthRevenue != null && users > 0 ? monthRevenue / users : null;

  // ---- the funnel: interview moment → offer → purchase ----------------------------------------------
  let funnel = null;
  if (f) {
    const shown = step('prep_offer_shown'); const bought = step('prep_purchases');
    const takeRate = shown >= MIN_SAMPLE && bought != null
      ? { rate: bought / shown, purchases: bought, shown, enough: true, formula: `${bought} Interview Prep purchase${bought === 1 ? '' : 's'} ÷ ${shown} cards that saw the offer (${f.days || 30} days)` }
      : { rate: null, purchases: bought, shown, enough: false, formula: `not enough data: ${shown ?? 0} card${shown === 1 ? '' : 's'} saw the Prep offer in ${f.days || 30} days (need ${MIN_SAMPLE})` };
    const imp = f.implied || null;
    funnel = {
      days: f.days || 30, recording: !!f.recording, interviews: step('interviews'), offerShown: shown, offerClicked: step('prep_offer_clicked'),
      checkoutsStarted: step('checkout_started'), checkoutsCompleted: step('checkout_completed'), takeRate,
      implied: imp ? { ...imp, formula: `${imp.interviews_per_month} interviews/month × ${imp.take_rate_pct}% take rate × ${usd(9.99)} (Seen's funnel, at today's rates)` } : null,
      steps: Array.isArray(f.steps) ? f.steps.map((x) => ({ key: x.key, label: x.label, n: x.n ?? null })) : [],
      legacyMarkedPro: num(f.revenue?.legacy_subscriptions_marked_pro),
    };
    if (!f.recording) notes.push('Seen\'s funnel events are not recording yet — offer and checkout steps read "—" until its migration is applied');
  }

  // ---- costs -----------------------------------------------------------------------------------------
  const costs = (money.costs || []).map((c) => ({ ...c, monthly: c.monthly == null ? null : Number(c.monthly) }));
  const known = costs.filter((c) => Number.isFinite(c.monthly));
  const missing = costs.filter((c) => !Number.isFinite(c.monthly)).map((c) => c.name);
  const recurring = known.reduce((n, c) => n + c.monthly, 0);
  const aiOps = usage?.total ? Number(usage.total.costUsd) || 0 : null;
  const charges = (purchases.total || 0) + employerCount + (legacy.subscribers || 0);
  const fees = monthRevenue ? monthRevenue * STRIPE_FEE.pct + charges * STRIPE_FEE.fixed : 0;
  const cogs = known.filter((c) => COGS_CATEGORIES.has(c.category)).reduce((n, c) => n + c.monthly, 0) + fees;
  const total = recurring + (aiOps || 0) + fees;
  trace.costs = `${known.length} entered recurring cost${known.length === 1 ? '' : 's'} (${usd(recurring)})${aiOps != null ? ` + Seen Command's own AI spend, last 30 days (${usd(r2(aiOps))}, observed)` : ''} + payment fees on ${charges} charge${charges === 1 ? '' : 's'} (${usd(r2(fees))}, ${STRIPE_FEE.source})${missing.length ? ` — not entered: ${missing.join(', ')}` : ''}`;
  const grossMargin = monthRevenue > 0 ? (monthRevenue - cogs) / monthRevenue : null;
  trace.grossMargin = grossMargin != null ? `(${usd(r2(monthRevenue))} − cost of serving ${usd(r2(cogs))}: infra + product AI + fees) ÷ ${usd(r2(monthRevenue))}` : 'needs revenue';
  const net = monthRevenue == null ? -total : monthRevenue - total;
  trace.net = `${monthRevenue == null ? 'revenue unknown (counted as $0)' : `month revenue ${usd(r2(monthRevenue))}`} − known costs ${usd(r2(total))}`;
  const burn = net < 0 ? -net : 0;
  const cash = money.cash && Number.isFinite(Number(money.cash.amount)) ? Number(money.cash.amount) : null;
  let runway;
  if (burn === 0) runway = { months: null, label: 'not burning — revenue covers every known cost', state: 'ok' };
  else if (cash == null) runway = { months: null, label: 'enter cash on hand to see runway', state: 'unknown' };
  else { const mo = cash / burn; runway = { months: r1(mo), label: `${r1(mo)} months at ${usd(r2(burn))}/mo burn`, state: mo < 3 ? 'act' : mo < 6 ? 'soon' : 'ok' }; }
  trace.runway = cash != null ? `cash ${usd(cash)} (as of ${money.cash.asOf || 'unknown date'}) ÷ burn ${usd(r2(burn))}/mo` : 'cash on hand is owner-entered';
  if (missing.length) notes.push(`${missing.length} cost${missing.length === 1 ? ' is' : 's are'} not entered yet (${missing.join(', ')}) — totals count only what is entered`);
  if (aiOps != null) notes.push("AI spend here is Seen Command's own model calls; seenjobs.io's product AI calls are a separate cost line");

  return {
    at: now.toISOString(), atPT: formatPT(now, { now }), date: ptDate(now), model: 'one-time',
    users, paying, buyerShare: buyerShare == null ? null : Math.round(buyerShare * 1e4) / 1e4, proShare,
    stripeConnectedOnSeen: raw ? !!m.stripe_connected : null,
    revenue: { month: r2(monthRevenue), consumer30d: r2(consumer), employer30d: r2(employer30), legacyMrr: legacy.mrr, avgSale: r2(avgSale), perUser: revenuePerUser == null ? null : Math.round(revenuePerUser * 1000) / 1000, sku },
    purchases, funnel, legacy,
    costs: { list: costs, recurring: r2(recurring), aiOps: r2(aiOps), fees: r2(fees), cogs: r2(cogs), total: r2(total), missing },
    grossMargin: grossMargin == null ? null : Math.round(grossMargin * 1000) / 1000,
    net: r2(net), burn: r2(burn), cash, runway,
    signupsChart: Array.isArray(m.signups_chart) ? m.signups_chart : null,
    trace, notes, unavailable,
  };
}

// One-line plain-language read of a ledger (chat, the Board Room).
export function ledgerLine(l) {
  if (!l) return 'Money picture unavailable.';
  const p = l.purchases || {};
  const parts = [`revenue ${usd(l.revenue.month)} in 30 days (one-time)`, `${l.paying ?? '—'} paying`, `${p.interview ?? '—'} Interview Prep · ${p.pass30 ?? '—'} Job Search Pass`];
  if (l.revenue.employer30d) parts.push(`employer ${usd(l.revenue.employer30d)}`);
  if (l.legacy?.mrr) parts.push(`legacy subscriptions ${usd(l.legacy.mrr)}/mo (ending)`);
  if (l.funnel?.takeRate?.rate != null) parts.push(`take rate ${Math.round(l.funnel.takeRate.rate * 1000) / 10}%`);
  parts.push(`known costs ${usd(l.costs.total)}/mo`, `net ${usd(l.net)}/mo`, `runway: ${l.runway.label}`);
  return parts.join(' · ');
}
