// Real numbers for a simulation. simulationInputs() returns exactly the shape lib/simulate.mjs
// simulateNumbers() takes — { users, weeks, weeklyGrowth{low,likely,high}, paidShare{…}, price{…},
// monthlyCost{…}, oneTime? } — built from LIVE data. Seen sells one-time products (nothing renews), so
// `paidShare` is the share of accounts that BUY in a month and `price` is the average sale — the simulator's
// users × share × price is then a month of one-time revenue. Built plus an `assumptions` array saying where each range
// came from and which parts are assumed. A money decision's simulation gets these instead of nothing.
import { CONSUMER_SKUS } from './sales.mjs';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Weekly growth rates from the 30-day daily signups chart and today's total: for each of the last four
// 7-day windows, signups in the window ÷ accounts at its start (total − signups since then).
export function observedWeeklyGrowth(signupsChart, total) {
  if (!Array.isArray(signupsChart) || !(Number(total) > 0)) return [];
  const days = signupsChart.map((d) => Number(d.count) || 0);
  const out = [];
  for (let w = 0; w < 4; w++) {
    const end = days.length - w * 7; const start = end - 7;
    if (start < 0) break;
    const inWeek = days.slice(start, end).reduce((a, b) => a + b, 0);
    const since = days.slice(start).reduce((a, b) => a + b, 0);
    const atStart = Number(total) - since;
    if (atStart > 0) out.push(inWeek / atStart);
  }
  return out;
}

const range = (low, likely, high) => { const l = Math.min(low, likely, high), h = Math.max(low, likely, high); return { low: l, likely: Math.min(h, Math.max(l, likely)), high: h }; };

export function simulationInputsFrom({ ledger, weeks = 12, extra = null } = {}) {
  const l = ledger || {}; const assumptions = [];
  const users = Number(l.users) > 0 ? Number(l.users) : 0;
  assumptions.push(users ? `users: ${users.toLocaleString('en-US')} accounts today (admin-stats)` : 'users: unknown (admin-stats not connected) — simulated from 0');

  const g = observedWeeklyGrowth(l.signupsChart, users);
  let weeklyGrowth;
  if (g.length >= 3) { weeklyGrowth = range(r4(Math.min(...g)), r4(median(g)), r4(Math.max(...g))); assumptions.push(`weekly growth: observed over the last ${g.length} weeks of signups (${g.map((x) => `${r2(x * 100)}%`).join(', ')}) — low/likely/high = min/median/max`); }
  else { weeklyGrowth = { low: 0, likely: 0.02, high: 0.10 }; assumptions.push('weekly growth: ASSUMED 0–10%/week (likely 2%) — fewer than 3 weeks of signup history to measure'); }

  let paidShare;
  if (l.paying >= 5 && users) { const p = l.paying / users; paidShare = range(r4(p * 0.7), r4(p), r4(p * 1.3)); assumptions.push(`buyer share: observed ${r2(p * 100)}% of accounts bought in the last 30 days (${l.paying} of ${users}); ±30% spread is assumed`); }
  else if (l.paying > 0 && users) { const p = l.paying / users; paidShare = range(0, r4(p), r4(Math.max(p * 2, 0.03))); assumptions.push(`buyer share: observed ${r2(p * 100)}% from only ${l.paying} paying in 30 days — range widened to 0–${r2(Math.max(p * 2, 0.03) * 100)}% (assumed)`); }
  else { paidShare = { low: 0, likely: 0.01, high: 0.03 }; assumptions.push('buyer share: ASSUMED 0–3% of accounts buy each month (likely 1%) — no purchases measured yet'); }

  const lo = CONSUMER_SKUS.interview.price, hi = CONSUMER_SKUS.pass30.price;
  const avg = l.revenue?.avgSale;
  const price = avg != null ? range(Math.min(avg, lo), avg, Math.max(avg, hi)) : { low: lo, likely: lo, high: hi };
  assumptions.push(avg != null ? `price: observed average sale $${avg}, bounded by Seen's prices ($${lo} Interview Prep to $${hi} Job Search Pass)` : `price: Seen's prices ($${lo} Interview Prep, likely, to $${hi} Job Search Pass) — no sales measured yet`);

  let cost = Number(l.costs?.total) || 0;
  const missing = l.costs?.missing || [];
  if (extra?.monthly) { cost += extra.monthly; assumptions.push(`monthly cost includes the decision's $${extra.monthly}/mo`); }
  const monthlyCost = missing.length ? range(cost, cost, r2(cost * 1.2 + 0)) : { low: cost, likely: cost, high: cost };
  assumptions.push(`monthly cost: $${r2(cost)} known (entered costs + observed AI + fees)${missing.length ? `; high +20% because ${missing.length} cost${missing.length === 1 ? ' is' : 's are'} not entered (${missing.join(', ')}) — assumed headroom` : ''}`);

  const out = { users, weeks: Number(weeks) || 12, weeklyGrowth, paidShare, price, monthlyCost };
  if (extra?.oneTime) { out.oneTime = { cost: extra.oneTime }; assumptions.push(`one-time cost: $${extra.oneTime} (from the decision's wording)`); }
  out.assumptions = assumptions;
  return out;
}

// Money in the decision's words: "$25/mo", "$500 on ads", "$1.2k a month". The first amount only.
export function costFromQuestion(q) {
  const m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\b\s*(\/\s*mo(?:nth)?|a month|per month|monthly|\/\s*month|each month)?/i.exec(String(q || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[3] ? { monthly: n } : { oneTime: n };
}

const MONEY_WORDS = /\b(pric(?:e|es|ing)|charg\w*|spend\w*|budget\w*|ads?|paid|cost\w*|afford\w*|hir(?:e|ing)|upgrad\w*|plan|subscri\w*|revenue|mrr|profit|cash|runway|invest\w*|salary|contractor|discount\w*|refund\w*|sku|sponsor\w*)\b|\$\s?\d/i;
export const isMoneyQuestion = (q) => MONEY_WORDS.test(String(q || ''));
