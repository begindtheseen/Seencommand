// Stripe reads for the money picture — READ-ONLY (GET only; no charge, refund or change is possible here).
// Seen sells ONE-TIME products since 2026-10-25 (owner decisions, Seen lib/server/creditRules.js): Interview
// Prep and the 30-day Job Search Pass, plus employer SKUs — all Stripe Checkout mode 'payment'. Nothing
// renews. Seen's revenue funnel (via admin-stats) is the primary count; Stripe adds:
//   • one-time sales in the last 30 days from Checkout Sessions (a cross-check, and employer sales)
//   • legacy subscriptions (started before 2026-10-25): cancellations, read from each one's own dates
//   • readiness: charges/payouts enabled on the account, Stripe Tax status
// The metric functions are pure and unit-tested; the fetcher is injected.
import { config } from '../config.mjs';

const DAY = 864e5;
// Seen's consumer SKUs (owner-locked prices, Seen lib/server/creditRules.js ONE_TIME_SKUS, read 2026-10-27 at
// next-migration f67a052). SELLABLE: interview + pass30. credits20 is fulfilled only for checkouts opened before
// the change (legacy) — it is never offered again.
export const CONSUMER_SKUS = {
  interview: { name: 'Interview Prep', price: 9.99, proDays: 14 },
  pass30: { name: 'Job Search Pass', price: 19.99, proDays: 30 },
  credits20: { name: 'Credit Pack (legacy)', price: 4.99, legacy: true },
};
export const SELLABLE_SKUS = ['interview', 'pass30'];
export const EMPLOYER_SKUS = { featured30: { name: 'Featured Placement', price: 79 }, verified90: { name: 'Transparency Verified', price: 249 }, sponsor30: { name: 'Ghost Index Sponsor', price: 299 } };

async function stripeGet(path, { key, fetchFn }) {
  const res = await fetchFn(`https://api.stripe.com/v1${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Stripe ${path.split('?')[0]} → ${res.status}`);
  return res.json();
}
async function stripeList(path, opts, maxPages = 5) {
  const out = []; let after = null;
  for (let i = 0; i < maxPages; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const j = await stripeGet(`${path}${sep}limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`, opts);
    out.push(...(j.data || []));
    if (!j.has_more || !j.data?.length) return { rows: out, complete: true };
    after = j.data[j.data.length - 1].id;
  }
  return { rows: out, complete: false };
}

// Everything the money picture needs from Stripe, each part guarded (one failing read never hides the rest).
export async function stripeSales({ key = config.stripeKey(), fetchFn = fetch, now = new Date() } = {}) {
  if (!key) return { configured: false };
  const opts = { key, fetchFn };
  const since = Math.floor((+now - 90 * DAY) / 1000);
  const part = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
  const [subs, sessions, account, tax] = await Promise.all([
    part(() => stripeList('/subscriptions?status=all', opts)),
    part(() => stripeList(`/checkout/sessions?status=complete&created[gte]=${since}`, opts)),
    part(() => stripeGet('/account', opts)),
    part(() => stripeGet('/tax/settings', opts)),
  ]);
  return {
    configured: true,
    subs: subs.error ? subs : { rows: subs.rows.map(slimSub), complete: subs.complete },
    sessions: sessions.error ? sessions : { rows: sessions.rows.map(slimSession), complete: sessions.complete },
    account: account.error ? account : { charges_enabled: !!account.charges_enabled, payouts_enabled: !!account.payouts_enabled, details_submitted: !!account.details_submitted, country: account.country || null },
    tax: tax.error ? tax : { status: tax.status || null },
  };
}
const slimSub = (s) => ({ id: s.id, status: s.status, created: s.created, trial_end: s.trial_end || null, canceled_at: s.canceled_at || null, cancel_at_period_end: !!s.cancel_at_period_end });
const slimSession = (s) => ({ id: s.id, mode: s.mode, payment_status: s.payment_status, amount_total: s.amount_total, created: s.created, sku: s.metadata?.sku || null, employer_sku: s.metadata?.employer_sku || null, kind: s.metadata?.kind || null });

// ---- pure metrics ----------------------------------------------------------------------------------
const confidenceOf = (n) => (n >= 30 ? 'high' : n >= 10 ? 'medium' : 'low');
export const MIN_SAMPLE = 5; // below this a rate is "not enough data", never a number

// LEGACY subscriptions only (started before 2026-10-25; Seen starts no new ones). A subscription that was ever
// PAID outlived its trial by more than a day (or never had one).
const wasPaid = (s, nowSec) => { const end = s.canceled_at || nowSec; return !s.trial_end || end > s.trial_end + 86400; };

// How the legacy subscriptions are winding down: paid ones cancelled in the last 30 days ÷ (alive + those
// cancelled), and how their old trials ended. Kept for the legacy line only — not part of the one-time picture.
export function subsMetrics(rows = [], { now = new Date() } = {}) {
  const nowSec = Math.floor(+now / 1000); const d30 = nowSec - 30 * 86400; const d90 = nowSec - 90 * 86400;
  const alivePaid = rows.filter((s) => ['active', 'past_due'].includes(s.status) && wasPaid(s, nowSec)).length;
  const cancels = rows.filter((s) => s.status === 'canceled' && s.canceled_at >= d30 && wasPaid(s, nowSec)).length;
  const base = alivePaid + cancels;
  const churn = base >= MIN_SAMPLE
    ? { rate: cancels / base, cancels, base, enough: true, confidence: confidenceOf(base), formula: `${cancels} paid cancellations in 30 days ÷ ${base} paid subscriptions (alive now + cancelled)` }
    : { rate: null, cancels, base, enough: false, confidence: null, formula: `not enough data: ${base} paid subscription${base === 1 ? '' : 's'} in the window (need ${MIN_SAMPLE})` };
  const ended = rows.filter((s) => s.trial_end && s.trial_end < nowSec && s.trial_end >= d90);
  const converted = ended.filter((s) => ['active', 'past_due', 'unpaid'].includes(s.status) || (s.status === 'canceled' && s.canceled_at > s.trial_end + 86400)).length;
  const trials = ended.length >= MIN_SAMPLE
    ? { rate: converted / ended.length, converted, ended: ended.length, enough: true, confidence: confidenceOf(ended.length), formula: `${converted} of ${ended.length} trials that ended in the last 90 days went on to pay` }
    : { rate: null, converted, ended: ended.length, enough: false, confidence: null, formula: `not enough data: ${ended.length} trial${ended.length === 1 ? '' : 's'} ended in 90 days (need ${MIN_SAMPLE})` };
  return { churn, trials };
}

// One-time revenue in the last 30 days from completed, paid Checkout Sessions (mode=payment).
export function skuMetrics(rows = [], { now = new Date() } = {}) {
  const d30 = Math.floor(+now / 1000) - 30 * 86400;
  const paid = rows.filter((s) => s.mode === 'payment' && s.payment_status === 'paid' && s.created >= d30);
  const out = { consumer: { count: 0, revenue: 0, bySku: {} }, employer: { count: 0, revenue: 0, bySku: {} }, other: { count: 0, revenue: 0 }, total: 0, count: paid.length };
  for (const s of paid) {
    const amt = (Number(s.amount_total) || 0) / 100;
    const bucket = s.kind === 'employer' || s.employer_sku ? out.employer : s.sku ? out.consumer : out.other;
    bucket.count++; bucket.revenue += amt;
    const k = s.employer_sku || s.sku;
    if (k && bucket.bySku) { bucket.bySku[k] = bucket.bySku[k] || { count: 0, revenue: 0 }; bucket.bySku[k].count++; bucket.bySku[k].revenue += amt; }
    out.total += amt;
  }
  for (const b of [out.consumer, out.employer, out.other]) b.revenue = Math.round(b.revenue * 100) / 100;
  out.total = Math.round(out.total * 100) / 100;
  return out;
}

// Employer purchases from Seen's own table (admin action list_employer_purchases) — used when Stripe
// Checkout Sessions cannot be read. Only paid rows in the last 30 days count.
export function employerFromAdmin(list, { now = new Date() } = {}) {
  const cut = +now - 30 * DAY;
  const rows = (list?.purchases || []).filter((p) => (!p.status || /paid|fulfilled|complete/i.test(p.status)) && +new Date(p.created_at) >= cut);
  const revenue = Math.round(rows.reduce((n, p) => n + (Number(p.amount_cents) || 0), 0)) / 100;
  return { count: rows.length, revenue, allTime: list?.total_cents != null ? Number(list.total_cents) / 100 : null };
}
