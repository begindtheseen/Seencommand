// Unit economics for seenjobs.io's ONE-TIME sales (Interview Prep $9.99, Job Search Pass $19.99 — nothing
// renews since 2026-10-25). What one sale is worth, what it costs to get a buyer, how many sales a month cover
// the costs, and how many interviews that takes. Formulas:
//
//   contribution / sale   = average sale × gross margin   (average sale measured; else the Interview Prep price,
//                           assumed; margin from the ledger, else price minus the payment fee)
//   CAC (channel)         = spend ÷ paying customers from it; with signups but no buyers yet,
//                           spend ÷ signups ÷ buyer share is shown as a PROJECTION
//   payback (sales)       = CAC ÷ contribution per sale — how many sales one buyer must make to pay back
//   break-even sales      = known fixed monthly costs ÷ contribution per sale, every month
//   break-even interviews = break-even sales ÷ take rate (Prep purchases ÷ cards that saw the offer)
// Scenario levers are projections with their assumptions listed.
import { STRIPE_FEE, usd } from './ledger.mjs';
import { CONSUMER_SKUS, EMPLOYER_SKUS } from './sales.mjs';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const fee = (amount) => amount * STRIPE_FEE.pct + STRIPE_FEE.fixed;

// The Growth Studio (lib/growth/*) is built on another branch. Read its channel numbers when it is here;
// otherwise say so and fall back to what the owner entered. Never throws.
const GROWTH_MODULES = ['../growth/index.mjs', '../growth/studio.mjs', '../growth/channels.mjs', '../growth/ledger.mjs'];
const GROWTH_FNS = ['channelEconomics', 'channelStats', 'channelSummary', 'channels'];
export async function growthChannels({ importFn = (p) => import(p) } = {}) {
  for (const p of GROWTH_MODULES) {
    let mod; try { mod = await importFn(new URL(p, import.meta.url).href); } catch { continue; }
    for (const fn of GROWTH_FNS) {
      if (typeof mod?.[fn] !== 'function') continue;
      try {
        const out = await mod[fn]();
        const list = Array.isArray(out) ? out : Array.isArray(out?.channels) ? out.channels : null;
        if (!list) continue;
        const rows = list.map((c) => ({ name: String(c.name || c.channel || c.id || '').slice(0, 60), spend30d: num(c.spend30d ?? c.spend), signups30d: num(c.signups30d ?? c.signups), paid30d: num(c.paid30d ?? c.paid ?? c.customers) })).filter((c) => c.name);
        return { available: true, source: `Growth Studio (${p.replace('../', 'lib/')} ${fn}())`, rows };
      } catch (e) { return { available: false, reason: `Growth Studio ${fn}() failed: ${e.message}` }; }
    }
  }
  return { available: false, reason: 'the Growth Studio (lib/growth) is not on this build — enter each channel\'s 30-day spend and signups here, or ask Brandon for them' };
}
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function unitEconomics({ ledger, channels = [], growth = null } = {}) {
  const l = ledger || {}; const assumptions = []; const trace = {};
  const observed = l.revenue?.avgSale ?? null;
  const price = observed ?? CONSUMER_SKUS.interview.price;
  if (observed == null) assumptions.push(`average sale assumed at the Interview Prep price ${usd(CONSUMER_SKUS.interview.price)} — no consumer purchases measured yet`);
  trace.avgSale = observed != null ? 'observed: consumer revenue ÷ consumer purchases (30 days)' : 'assumed: Interview Prep price';
  const gm = l.grossMargin != null ? l.grossMargin : (price - fee(price)) / price;
  if (l.grossMargin == null) assumptions.push('gross margin assumed as price minus the payment fee only (no revenue yet to measure it)');
  const contribution = price * gm;
  trace.contribution = `${usd(r2(price))} × ${Math.round(gm * 100)}% gross margin`;

  // CAC per channel, payback counted in sales.
  const buyerShare = l.buyerShare > 0 ? l.buyerShare : null;
  const rows = (growth?.available ? growth.rows : channels) || [];
  const cac = rows.map((c) => {
    const spend = num(c.spend30d), su = num(c.signups30d), pd = num(c.paid30d);
    const perSignup = spend != null && su > 0 ? spend / su : null;
    let value = null, basis = null, projected = false;
    if (spend != null && pd > 0) { value = spend / pd; basis = `${usd(spend)} ÷ ${pd} paying`; }
    else if (perSignup != null && buyerShare) { value = perSignup / buyerShare; basis = `${usd(r2(perSignup))} per signup ÷ ${r1(buyerShare * 100)}% buyer share`; projected = true; }
    else if (spend === 0 && su > 0) { value = 0; basis = 'no spend (organic)'; }
    const payback = value != null && contribution > 0 ? r1(value / contribution) : null;
    return { name: c.name, spend30d: spend, signups30d: su, paid30d: pd, costPerSignup: r2(perSignup), cac: r2(value), projected, basis: basis || 'needs spend and signups', paybackSales: payback };
  });

  // Break-even, in sales a month and the interviews that takes.
  const costs = l.costs || {};
  const fixed = Math.max(0, (Number(costs.total) || 0) - (Number(costs.fees) || 0));
  const perSale = price - fee(price);
  const salesNeeded = fixed > 0 ? Math.ceil(fixed / perSale) : 0;
  const tr = l.funnel?.takeRate || null;
  const interviewsNeeded = tr?.enough && tr.rate > 0 ? Math.ceil(salesNeeded / tr.rate) : null;
  const breakEven = { fixedMonthly: r2(fixed), perSale: r2(perSale), sales: salesNeeded, interviews: interviewsNeeded,
    formula: `${usd(r2(fixed))} known monthly costs ÷ ${usd(r2(perSale))} per sale after fees = ${salesNeeded} sale${salesNeeded === 1 ? '' : 's'} a month${interviewsNeeded != null ? `; at the measured ${r1(tr.rate * 100)}% take rate that is ${interviewsNeeded.toLocaleString('en-US')} tracked interviews a month` : ` (interviews needed: ${tr ? tr.formula : 'Seen\'s revenue funnel not readable'})`}`,
    missing: costs.missing?.length ? `excludes costs not entered: ${costs.missing.join(', ')}` : null };

  return { avgSale: r2(price), avgSaleObserved: observed != null, grossMargin: Math.round(gm * 1000) / 1000, contribution: r2(contribution),
    takeRate: tr, cac, channelsSource: growth?.available ? growth.source : 'owner-entered channels', growthNote: growth && !growth.available ? growth.reason : null,
    breakEven, note: 'One-time sales: every month starts from zero, so revenue follows how many tracked applications reach an interview and how many of those buy. Break-even is counted in sales a month.', assumptions, trace };
}

// ---- scenario levers (projections) -----------------------------------------------------------------
// levers: { interviews (tracked applications at an interview per month), takeRate (0–1, share of those that buy),
//           passShare (0–1, share of buyers who pick the Pass), prepPrice, passPrice,
//           employerFeatured, employerVerified, employerSponsor (sales per month), legacyMrr (held as today) }
export function scenario(base = {}, levers = {}) {
  const v = { ...base, ...Object.fromEntries(Object.entries(levers).filter(([, x]) => x != null && x !== '')) };
  const n = (k) => Number(v[k]) || 0;
  const sales = n('interviews') * n('takeRate');
  const mix = (1 - n('passShare')) * n('prepPrice') + n('passShare') * n('passPrice');
  const consumer = sales * mix;
  const employer = n('employerFeatured') * EMPLOYER_SKUS.featured30.price + n('employerVerified') * EMPLOYER_SKUS.verified90.price + n('employerSponsor') * EMPLOYER_SKUS.sponsor30.price;
  const legacy = n('legacyMrr');
  const month = consumer + employer + legacy;
  return { inputs: v, sales: r1(sales), consumer: r2(consumer), employer: r2(employer), legacy: r2(legacy), month: r2(month), projection: true };
}

// The default lever set, built from the ledger. Each scenario names what it assumes.
export function defaultScenarios(ledger) {
  const l = ledger || {}; const f = l.funnel || {}; const p = l.purchases || {};
  const perMonth = f.implied?.interviews_per_month ?? null;
  const interviews = perMonth != null ? perMonth : (f.interviews ?? 0);
  const takeRate = f.takeRate?.rate ?? 0;
  const passShare = p.total > 0 && p.pass30 != null ? p.pass30 / p.total : 0;
  const base = { interviews, takeRate, passShare, prepPrice: CONSUMER_SKUS.interview.price, passPrice: CONSUMER_SKUS.pass30.price, employerFeatured: 0, employerVerified: 0, employerSponsor: 0, legacyMrr: l.legacy?.mrr || 0 };
  const today = scenario(base);
  const basis = [perMonth != null ? `${interviews} interviews/month (Seen's funnel)` : f.interviews != null ? `${interviews} cards at an interview now, used as a month's volume (assumed)` : 'interview volume unknown (0)',
    f.takeRate?.rate != null ? `measured ${r1(takeRate * 100)}% take rate` : 'take rate not measured yet (0)'];
  const list = [
    { id: 'today', title: 'Today\'s rates', assumes: [...basis, `${Math.round(passShare * 100)}% of buyers pick the Pass`, 'legacy subscriptions held as today'], ...today },
    { id: 'take10', title: 'Take rate on the Prep offer reaches 10%', assumes: ['assumption: 1 in 10 interview cards buys', basis[0]], ...scenario(base, { takeRate: 0.10 }) },
    { id: 'interviews2x', title: 'Twice as many tracked applications reach an interview', assumes: ['assumption: interview volume doubles', basis[1]], ...scenario(base, { interviews: interviews * 2 }) },
    { id: 'pass20', title: '1 in 5 buyers picks the Pass', assumes: ['assumption: 20% of buyers choose the $19.99 Pass', 'same number of buyers'], ...scenario(base, { passShare: 0.2 }) },
    { id: 'employer', title: '2 Featured + 1 Verified employer sales a month', assumes: ['assumption: 3 employer sales/mo', `Featured ${usd(EMPLOYER_SKUS.featured30.price)}, Verified ${usd(EMPLOYER_SKUS.verified90.price)}`, 'buys reach or a badge — never changes a score'], ...scenario(base, { employerFeatured: 2, employerVerified: 1 }) },
  ];
  for (const s of list) s.delta = r2(s.month - today.month);
  return { base, scenarios: list, note: 'Projections, not forecasts: each line changes one lever and holds everything else at today\'s measured values. Prices are owner decisions (Interview Prep $9.99, Job Search Pass $19.99); a change in where the offer appears usually moves the take rate, which these lines do not model.' };
}
