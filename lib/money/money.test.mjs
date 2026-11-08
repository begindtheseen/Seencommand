// Run: node --test lib/money/money.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLedger, STRIPE_FEE } from './ledger.mjs';
import { allocate, stageFor, setOverride, validateOverride, STAGES, BUCKETS } from './allocate.mjs';
import { unitEconomics, scenario, defaultScenarios, growthChannels } from './units.mjs';
import { etaHours, statusFor, growthRate, storageReading, scaleWatch, factContradictions, readinessList, ASSUMED_DB_RATE } from './scale.mjs';
import { subsMetrics, skuMetrics, employerFromAdmin } from './sales.mjs';
import { simulationInputsFrom, observedWeeklyGrowth, costFromQuestion, isMoneyQuestion } from './inputs.mjs';
import { defaultMoney, setCost, removeCost, setCash, setPlan, setReadiness, parseAmount, recordSnapshot, readHistory, loadMoney, saveMoney } from './store.mjs';
import { moneyPicture, moneyDeptBlock, numbersFor, simulationInputs, _resetPictureCache } from './live.mjs';
import { simulateNumbers } from '../simulate.mjs';

const NOW = new Date('2026-10-21T17:00:00Z'); // 10:00 AM in California
const sec = (d) => Math.floor(+d / 1000);
const DAY = 86400;
const chart = (perDay, days = 30) => Array.from({ length: days }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, count: typeof perDay === 'function' ? perDay(i) : perDay }));
// Seen's revenue funnel (lib/server/revenueFunnel.js shape): 8 Interview Prep + 2 Job Search Pass in 30 days.
const FUNNEL = { ok: true, days: 30, recording: true,
  steps: [{ key: 'signups', label: 'Sign-ups', n: 120 }, { key: 'interviews', label: 'Cards at an interview now', n: 40 }, { key: 'prep_offer_shown', label: 'Saw the Interview Prep offer on a card', n: 50 }, { key: 'prep_offer_clicked', label: 'Pressed it', n: 15 }, { key: 'checkout_started', label: 'Opened a checkout', n: 12 }, { key: 'checkout_completed', label: 'Completed a checkout', n: 10 }, { key: 'prep_purchases', label: 'Bought Interview Prep', n: 8 }, { key: 'pass_purchases', label: 'Bought the Job Search Pass', n: 2 }],
  rates: { offer_click: 30, checkout: 53 },
  revenue: { interview_prep: 79.92, job_search_pass: 39.98, pass_count: 2, credit_pack: 0, credit_pack_count: 0, total: 119.9, paying_customers: 9, legacy_subscriptions_marked_pro: 3 },
  implied: { interviews_per_month: 40, take_rate_pct: 16, dollars: 63.94 } };
const admin = (o = {}) => ({ raw: { users: { total: 1000 }, revenue_funnel: FUNNEL, monetization: { mrr: 19.98, active_paid: 2, pro_users: 12, conversion_pct: 1.2, trialing: 0, past_due: 0, canceling: 1, stripe_connected: true, signups_chart: chart(10) }, storage: { db_bytes: 437 * 1048576, max_mb: 470, blocking: false, enabled: true }, errors: { today: 3, this_week: 21 }, issues: { open: 1 }, held_reports: { pending: 2 }, employer_purchases: { unfulfilled: 0 }, job_health: { active: 70000, active_pct: 92, crisis: false }, ...o } });
const money = (o = {}) => ({ ...defaultMoney(), costs: [{ name: 'Vercel Pro', monthly: 20, category: 'infra' }, { name: 'Supabase', monthly: 0, category: 'infra' }, { name: 'Figma', monthly: 15, category: 'tools' }, { name: 'Domain', monthly: null, category: 'infra' }], ...o });

// ---- ledger --------------------------------------------------------------------------------------
test('ledger: one-time revenue from Seen\'s funnel + legacy subscriptions on their own line; fees, margin, net, runway', () => {
  const l = buildLedger({ admin: admin(), usage: { total: { costUsd: 5 } }, money: money({ cash: { amount: 1000, asOf: '2026-10-21' } }), now: NOW });
  assert.equal(l.model, 'one-time');
  assert.equal(l.revenue.consumer30d, 119.9);
  assert.equal(l.revenue.legacyMrr, 19.98); assert.equal(l.legacy.subscribers, 2); assert.match(l.legacy.note, /end as they cancel/);
  assert.equal(l.revenue.employer30d, null);
  assert.equal(l.revenue.month, 139.88, 'consumer + legacy (employer unknown)');
  assert.deepEqual(l.purchases, { interview: 8, pass30: 2, legacyPack: 0, total: 10 });
  assert.equal(l.revenue.avgSale, 11.99);
  assert.equal(l.paying, 9); assert.equal(l.buyerShare, 0.009);
  assert.equal(l.funnel.takeRate.rate, 8 / 50); assert.match(l.funnel.takeRate.formula, /8 Interview Prep purchases ÷ 50 cards/);
  assert.equal(l.funnel.implied.dollars, 63.94); assert.equal(l.funnel.interviews, 40);
  const fees = 139.88 * STRIPE_FEE.pct + (10 + 0 + 2) * STRIPE_FEE.fixed;
  assert.equal(l.costs.fees, Math.round(fees * 100) / 100);
  assert.equal(l.costs.recurring, 35);
  assert.equal(l.costs.total, Math.round((35 + 5 + fees) * 100) / 100);
  assert.deepEqual(l.costs.missing, ['Domain']);
  assert.equal(l.grossMargin, Math.round(((139.88 - 20 - fees) / 139.88) * 1000) / 1000);
  assert.equal(l.net, Math.round((139.88 - 35 - 5 - fees) * 100) / 100);
  assert.equal(l.runway.state, 'ok'); assert.match(l.runway.label, /not burning/);
  assert.match(l.trace.consumer, /Seen revenue funnel/); assert.match(l.trace.legacy, /ends as they cancel/);
  assert.equal(l.atPT, 'Oct 21, 10:00 AM');
  for (const k of ['arr', 'arpu', 'mrr']) assert.equal(l.revenue[k], undefined, `no ${k} in the one-time picture`);
  assert.equal(l.churn, undefined); assert.equal(l.trialToPaid, undefined);
});

test('ledger: an unreadable funnel leaves sales unknown (null, never $0) and says so; burning → runway', () => {
  const noFunnel = admin({ revenue_funnel: null, monetization: { mrr: 0, active_paid: 0, stripe_connected: true, signups_chart: chart(1) } });
  const a = buildLedger({ admin: { raw: noFunnel.raw, revenue: { funnelError: 'revenue_funnel → 404' } }, money: money({ cash: { amount: 700, asOf: '2026-10-01' } }), now: NOW });
  assert.equal(a.revenue.consumer30d, null); assert.equal(a.paying, null); assert.equal(a.funnel, null);
  assert.equal(a.revenue.month, 0, 'legacy subscriptions read $0 — measured');
  assert.match(a.trace.consumer, /404/); assert.ok(a.unavailable.some((u) => /Interview Prep \/ Job Search Pass sales are unknown/.test(u)));
  assert.equal(a.net, -35); assert.equal(a.burn, 35); assert.equal(a.runway.months, 20);
  const b = buildLedger({ admin: noFunnel, money: money({ cash: { amount: 70 } }), now: NOW });
  assert.equal(b.runway.months, 2); assert.equal(b.runway.state, 'act');
  const c = buildLedger({ admin: noFunnel, money: money(), now: NOW });
  assert.equal(c.runway.state, 'unknown'); assert.match(c.runway.label, /enter cash/);
  assert.equal(c.revenue.avgSale, null); assert.equal(c.grossMargin, null);
  const none = buildLedger({ admin: { notConfigured: true }, money: money(), now: NOW });
  assert.equal(none.users, null); assert.equal(none.revenue.month, null);
  assert.match(none.unavailable[0], /not connected/);
});

test('ledger: Stripe Checkout fills consumer sales when the funnel is missing; employer sales from Checkout, else Seen', () => {
  const noFunnel = admin({ revenue_funnel: null, monetization: { mrr: null, active_paid: null, stripe_connected: false } });
  const l = buildLedger({ admin: noFunnel, stripeSubs: { mrr: 20 }, money: money(), now: NOW });
  assert.equal(l.revenue.legacyMrr, 20); assert.match(l.trace.legacy, /Stripe active subscriptions \(legacy/);
  const sessions = [
    { mode: 'payment', payment_status: 'paid', amount_total: 999, created: sec(NOW) - 2 * DAY, sku: 'interview' },
    { mode: 'payment', payment_status: 'paid', amount_total: 1999, created: sec(NOW) - 2 * DAY, sku: 'pass30' },
    { mode: 'payment', payment_status: 'paid', amount_total: 7900, created: sec(NOW) - 3 * DAY, kind: 'employer', employer_sku: 'featured30' },
    { mode: 'payment', payment_status: 'unpaid', amount_total: 999, created: sec(NOW) - DAY, sku: 'interview' },
    { mode: 'payment', payment_status: 'paid', amount_total: 999, created: sec(NOW) - 40 * DAY, sku: 'interview' },
    { mode: 'subscription', payment_status: 'paid', amount_total: 999, created: sec(NOW) - DAY },
  ];
  const s = buildLedger({ admin: noFunnel, sales: { configured: true, sessions: { rows: sessions, complete: true }, subs: { rows: [] } }, money: money(), now: NOW });
  assert.equal(s.revenue.consumer30d, 29.98); assert.equal(s.revenue.employer30d, 79); assert.equal(s.revenue.month, 108.98);
  assert.deepEqual(s.purchases, { interview: 1, pass30: 1, legacyPack: 0, total: 2 });
  assert.match(s.trace.consumer, /Stripe Checkout/);
  const e = buildLedger({ admin: admin(), employer: { purchases: [{ amount_cents: 24900, status: 'paid', created_at: '2026-10-15T00:00:00Z' }, { amount_cents: 7900, status: 'paid', created_at: '2026-08-01T00:00:00Z' }], total_cents: 32800 }, money: money(), now: NOW });
  assert.equal(e.revenue.employer30d, 249); assert.equal(e.revenue.month, 119.9 + 249 + 19.98);
});

// ---- Stripe metrics -------------------------------------------------------------------------------
test('legacy subscriptions: cancellations derived from their own dates, "not enough data" under 5', () => {
  const n = sec(NOW);
  const paid = (i) => ({ id: `a${i}`, status: 'active', trial_end: n - 60 * DAY, canceled_at: null });
  const rows = [...Array.from({ length: 8 }, (_, i) => paid(i)),
    { id: 'c1', status: 'canceled', trial_end: n - 50 * DAY, canceled_at: n - 5 * DAY }, // paid, then cancelled → churn
    { id: 'c2', status: 'canceled', trial_end: n - 20 * DAY, canceled_at: n - 20 * DAY }, // cancelled at trial end → not churn
    { id: 'c3', status: 'canceled', trial_end: null, canceled_at: n - 45 * DAY }]; // outside 30 days
  const m = subsMetrics(rows, { now: NOW });
  assert.equal(m.churn.cancels, 1); assert.equal(m.churn.base, 9); assert.equal(Math.round(m.churn.rate * 1000), 111); assert.equal(m.churn.confidence, 'low');
  // trials ended in 90 days: 8 active (converted) + c1 (converted) + c2 (not) → 9/10? c1 trial_end 50d, c2 20d, actives 60d
  assert.equal(m.trials.ended, 10); assert.equal(m.trials.converted, 9);
  const few = subsMetrics(rows.slice(0, 2), { now: NOW });
  assert.equal(few.churn.rate, null); assert.match(few.churn.formula, /not enough data: 2 paid subscriptions/);
  assert.equal(few.trials.rate, null);
});

test('employer purchases from Seen: only paid rows in the last 30 days', () => {
  const e = employerFromAdmin({ purchases: [{ amount_cents: 7900, status: 'paid', created_at: '2026-10-20T00:00:00Z' }, { amount_cents: 29900, status: 'pending', created_at: '2026-10-20T00:00:00Z' }], total_cents: 37800 }, { now: NOW });
  assert.deepEqual(e, { count: 1, revenue: 79, allTime: 378 });
  assert.equal(skuMetrics([], { now: NOW }).total, 0);
});

// ---- allocation -----------------------------------------------------------------------------------
test('allocation: stage by monthly revenue; percentages sum to 100 in every stage', () => {
  assert.equal(stageFor(0).id, 'pre'); assert.equal(stageFor(999.99).id, 'pre'); assert.equal(stageFor(1000).id, '1k');
  assert.equal(stageFor(4999).id, '1k'); assert.equal(stageFor(5000).id, '5k'); assert.equal(stageFor(10000).id, '10k'); assert.equal(stageFor(250000).id, '10k');
  for (const s of STAGES) assert.equal(Object.values(s.pct).reduce((a, b) => a + b, 0), 100, s.id);
  for (const s of STAGES) assert.deepEqual(Object.keys(s.pct).sort(), BUCKETS.map((b) => b.id).sort());
  // profit and owner pay grow with the stage; operating falls
  assert.ok(STAGES[3].pct.owner > STAGES[0].pct.owner && STAGES[3].pct.operating < STAGES[0].pct.operating);
});

test('allocation: "this month" splits actual revenue to the cent and checks Operating against the costs', () => {
  const a = allocate({ revenue: 2000, monthlyCosts: 300 });
  assert.equal(a.stage.id, '1k');
  assert.deepEqual(Object.fromEntries(a.buckets.map((b) => [b.id, b.amount])), { profit: 100, owner: 200, tax: 300, operating: 900, growth: 400, reserve: 100 });
  assert.match(a.headline, /^This month: \$100\.00 to profit \(5%\)/);
  assert.equal(a.check.state, 'ok'); assert.equal(a.next.needed, 3000);
  const odd = allocate({ revenue: 33.33, monthlyCosts: 40 });
  assert.equal(Math.round(odd.buckets.reduce((n, b) => n + b.amount, 0) * 100), 3333, 'cents add up exactly');
  assert.equal(odd.check.state, 'short'); assert.match(odd.check.text, /short/);
  const pre = allocate({ revenue: 0, monthlyCosts: 20 });
  assert.equal(pre.check.state, 'pre'); assert.equal(pre.lines.length, 0); assert.match(pre.headline, /no revenue/);
});

test('allocation overrides: validated, remembered per stage, used for that stage only, and resettable', () => {
  assert.match(validateOverride({ profit: 50, owner: 60 }), /add up to 110/);
  assert.match(validateOverride({ profit: -1, owner: 101 }), /between 0 and 100/);
  assert.match(validateOverride({ bonus: 100 }), /unknown bucket/);
  assert.equal(setOverride(defaultMoney(), 'nope', { profit: 100 }).ok, false);
  const pcts = { profit: 10, owner: 20, tax: 15, operating: 35, growth: 15, reserve: 5 };
  const r = setOverride(defaultMoney(), '1k', pcts);
  assert.equal(r.ok, true);
  const a = allocate({ revenue: 2000, overrides: r.money.allocationOverrides });
  assert.equal(a.overridden, true); assert.equal(a.buckets.find((b) => b.id === 'profit').amount, 200);
  assert.equal(allocate({ revenue: 6000, overrides: r.money.allocationOverrides }).overridden, false, 'another stage keeps its defaults');
  const back = setOverride(r.money, '1k', null);
  assert.equal(back.money.allocationOverrides['1k'], undefined);
});

// ---- unit economics -------------------------------------------------------------------------------
test('units: contribution per sale, CAC with payback in sales, break-even in sales and interviews', () => {
  const l = buildLedger({ admin: admin(), money: money(), now: NOW }); // average sale 11.99, buyer share 0.9%, take rate 16%
  const u = unitEconomics({ ledger: l, channels: [{ name: 'reddit', spend30d: 0, signups30d: 40 }, { name: 'ads', spend30d: 100, signups30d: 50, paid30d: 2 }, { name: 'tiktok', spend30d: 60, signups30d: 30 }, { name: 'empty' }] });
  assert.equal(u.avgSale, 11.99); assert.equal(u.avgSaleObserved, true);
  assert.equal(u.contribution, Math.round(11.99 * l.grossMargin * 100) / 100);
  const by = Object.fromEntries(u.cac.map((c) => [c.name, c]));
  assert.equal(by.reddit.cac, 0);
  assert.equal(by.ads.cac, 50); assert.equal(by.ads.projected, false);
  assert.equal(by.ads.paybackSales, Math.round((50 / u.contribution) * 10) / 10);
  assert.equal(by.tiktok.cac, Math.round((2 / 0.009) * 100) / 100); assert.equal(by.tiktok.projected, true, '$2/signup ÷ 0.9% buyer share');
  assert.equal(by.empty.cac, null);
  const perSale = 11.99 - (11.99 * STRIPE_FEE.pct + STRIPE_FEE.fixed);
  const fixed = l.costs.total - l.costs.fees;
  assert.equal(u.breakEven.sales, Math.ceil(fixed / perSale));
  assert.equal(u.breakEven.interviews, Math.ceil(u.breakEven.sales / 0.16));
  assert.match(u.breakEven.formula, /sales? a month; at the measured 16% take rate/);
  assert.equal(u.ltv, undefined, 'no subscription lifetime value');
  // no purchases measured → priced at Interview Prep, said so; no take rate → interviews unknown
  const pre = unitEconomics({ ledger: buildLedger({ admin: admin({ revenue_funnel: null, monetization: { mrr: 0, active_paid: 0 } }), money: money(), now: NOW }) });
  assert.equal(pre.avgSaleObserved, false); assert.equal(pre.avgSale, 9.99); assert.match(pre.assumptions[0], /Interview Prep price/);
  assert.equal(pre.breakEven.interviews, null);
});

test('units: scenario levers are projections that change one thing', () => {
  const s = scenario({ interviews: 40, takeRate: 0.1, passShare: 0.25, prepPrice: 10, passPrice: 20, legacyMrr: 5 }, { employerFeatured: 1 });
  assert.equal(s.sales, 4); assert.equal(s.consumer, 50); assert.equal(s.employer, 79); assert.equal(s.legacy, 5); assert.equal(s.month, 134); assert.equal(s.projection, true);
  const d = defaultScenarios(buildLedger({ admin: admin(), money: money(), now: NOW }));
  assert.equal(d.base.interviews, 40); assert.equal(d.base.takeRate, 0.16); assert.equal(d.base.passShare, 0.2);
  assert.equal(d.scenarios[0].id, 'today'); assert.equal(d.scenarios[0].delta, 0);
  assert.deepEqual(d.scenarios.map((x) => x.id), ['today', 'take10', 'interviews2x', 'pass20', 'employer']);
  assert.ok(d.scenarios.find((x) => x.id === 'interviews2x').delta > 0);
  assert.ok(d.scenarios.every((x) => x.assumes.length));
  assert.ok(d.scenarios.find((x) => x.id === 'employer').assumes.some((a) => /never changes a score/.test(a)));
});

test('units: the Growth Studio is optional — absent says so, present is read, broken never throws', async () => {
  const none = await growthChannels({ importFn: async () => { throw new Error('ENOENT'); } });
  assert.equal(none.available, false); assert.match(none.reason, /not on this build/);
  const yes = await growthChannels({ importFn: async (p) => (p.endsWith('/growth/index.mjs') ? { channelStats: () => [{ channel: 'reddit', spend: 10, signups: 5 }] } : {}) });
  assert.equal(yes.available, true); assert.deepEqual(yes.rows[0], { name: 'reddit', spend30d: 10, signups30d: 5, paid30d: null });
  const bad = await growthChannels({ importFn: async () => ({ channels: () => { throw new Error('boom'); } }) });
  assert.equal(bad.available, false); assert.match(bad.reason, /boom/);
});

// ---- scale watch ----------------------------------------------------------------------------------
test('threshold ETA: the 470 MB storage guard from 437 MB at 5.5 MB/hour is 6 hours away → act now', () => {
  assert.equal(etaHours({ current: 437, limit: 470, perHour: 5.5 }), 6);
  assert.equal(etaHours({ current: 470, limit: 470, perHour: 5.5 }), 0);
  assert.equal(etaHours({ current: 400, limit: 470, perHour: 0 }), null);
  assert.equal(statusFor({ eta: 6 }), 'act'); assert.equal(statusFor({ eta: 49 }), 'soon'); assert.equal(statusFor({ eta: 14 * 24 + 1 }), 'ok');
  assert.equal(statusFor({ eta: null }), 'ok'); assert.equal(statusFor({ blocking: true, eta: null }), 'act');
  const s = scaleWatch({ admin: admin(), now: NOW });
  const g = s.items.find((i) => i.id === 'storage-guard');
  assert.equal(g.status, 'act'); assert.equal(g.etaHours, 6); assert.equal(g.reading, '437 MB'); assert.equal(g.limit, '470 MB');
  assert.match(g.rate, /5\.5 MB\/hour \(assumed\)/); assert.equal(g.rateSource, ASSUMED_DB_RATE.source);
  assert.match(g.etaText, /Oct 21, 4:00 PM PT/); assert.match(g.fixCost, /\$25\/mo/);
  assert.equal(s.items[0].status, 'act', 'act-now items first');
});

test('scale: a measured rate replaces the assumed one; storage readings in both shapes; blocking is act now', () => {
  const hist = [0, 1, 2, 3].map((h) => ({ at: new Date(+NOW - (3 - h) * 36e5).toISOString(), dbMb: 400 + h * 2 }));
  assert.equal(Math.round(growthRate(hist, 'dbMb', { now: NOW }).perHour * 100) / 100, 2);
  assert.equal(growthRate(hist.slice(0, 2), 'dbMb', { now: NOW }).perHour, null);
  const s = scaleWatch({ admin: admin(), history: hist, now: NOW });
  const g = s.items.find((i) => i.id === 'storage-guard');
  assert.equal(g.etaHours, 16.5); assert.match(g.rateSource, /measured by Seen Command: 4 readings/);
  assert.deepEqual(storageReading({ storage: { mb: 455, maxMb: 470, blocking: true } }), { mb: 455, maxMb: 470, blocking: true, enabled: true });
  assert.equal(storageReading({}), null);
  const blocked = scaleWatch({ admin: admin({ storage: { db_bytes: 480 * 1048576, max_mb: 470, blocking: true } }), now: NOW });
  const b = blocked.items.find((i) => i.id === 'storage-guard');
  assert.equal(b.status, 'act'); assert.match(b.etaText, /reached/);
  const unk = scaleWatch({ admin: admin({ storage: null }), now: NOW }).items.find((i) => i.id === 'storage-guard');
  assert.equal(unk.status, 'unknown'); assert.match(unk.reading, /unavailable/);
});

test('scale: Free plan → backups act now + 500 MB cap; Pro plan → no cap item, backups ok', () => {
  const free = scaleWatch({ admin: admin(), money: { plans: { supabase: { plan: 'free' } } }, now: NOW });
  assert.equal(free.items.find((i) => i.id === 'backups').status, 'act');
  assert.match(free.items.find((i) => i.id === 'backups').action, /npm run backup:supabase/);
  assert.equal(free.items.find((i) => i.id === 'plan-cap').limit, '500 MB');
  const pro = scaleWatch({ admin: admin(), money: { plans: { supabase: { plan: 'pro' } } }, now: NOW });
  assert.equal(pro.items.find((i) => i.id === 'plan-cap'), undefined);
  assert.equal(pro.items.find((i) => i.id === 'backups').status, 'ok');
  assert.equal(pro.items.find((i) => i.id === 'mau').limit, '100,000');
});

test('scale: the brain contradicting itself about the Supabase plan is flagged; unreadable brain says so', () => {
  const facts = [{ subject: 'Seen', predicate: 'supabase_plan', object: 'Free', valid_from: '2026-10-21' }, { subject: 'Seen', predicate: 'supabase_plan', object: 'Pro', valid_from: '2026-10-01' }, { subject: 'Seen', predicate: 'domain', object: 'seenjobs.io' }];
  assert.equal(factContradictions(facts).length, 1);
  const s = scaleWatch({ admin: admin(), facts, now: NOW });
  const c = s.items.find((i) => i.id === 'plan-facts');
  assert.equal(c.status, 'soon'); assert.match(c.reading, /"Free" \(since 2026-10-21\) vs "Pro" \(since 2026-10-01\)/);
  assert.equal(scaleWatch({ admin: admin(), facts: [facts[0]], now: NOW }).items.find((i) => i.id === 'plan-facts'), undefined, 'resolved → no item');
  assert.equal(scaleWatch({ admin: admin(), facts: null, now: NOW }).items.find((i) => i.id === 'plan-facts').status, 'unknown');
});

test('scale: unreadable vendors say unavailable; past-due, unfulfilled employer orders and job crisis are act now', () => {
  const s = scaleWatch({ admin: admin({ monetization: { past_due: 2, signups_chart: chart(10) }, employer_purchases: { unfulfilled: 1 }, job_health: { active: 100, active_pct: 10, crisis: true } }), sales: { configured: false }, now: NOW });
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  for (const id of ['egress', 'vercel', 'email', 'stripe-payouts', 'stripe-tax']) assert.equal(by[id].status, 'unknown', id);
  assert.match(by['stripe-payouts'].reading, /not connected/);
  assert.equal(by['past-due'].status, 'act'); assert.equal(by.support.status, 'act'); assert.equal(by['job-board'].status, 'act');
  const ok = scaleWatch({ admin: admin(), sales: { configured: true, account: { charges_enabled: true, payouts_enabled: true, details_submitted: true }, tax: { status: 'pending' } }, now: NOW });
  assert.equal(ok.items.find((i) => i.id === 'stripe-payouts').status, 'ok');
  assert.equal(ok.items.find((i) => i.id === 'stripe-tax').status, 'soon');
  // MAU: 1,000 users growing 70/week vs 50,000 → months away → ok
  assert.equal(ok.items.find((i) => i.id === 'mau').status, 'ok');
});

test('readiness: states from probes, plan and Stripe; owner check-offs win; due/overdue by users', () => {
  const r = readinessList({ users: 300, plan: 'free', probes: { terms: { ok: true, status: 200 }, privacy: { ok: false, status: 404 } }, money: { readiness: { support: { done: true } } } });
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.equal(by.legal.state, 'todo'); assert.match(by.legal.evidence, /privacy 404/);
  assert.equal(by.deletion.state, 'done'); assert.equal(by.backups.state, 'partial'); assert.equal(by.dbplan.state, 'todo');
  assert.equal(by.support.state, 'done'); assert.match(by.support.evidence, /owner/);
  assert.equal(by.legal.due, 'overdue'); assert.equal(by.alerts.due, 'due soon'); assert.equal(by.status.due, null);
  assert.equal(by.deletion.due, null, 'done items are never due');
  assert.equal(readinessList({ users: null }).every((x) => x.due === null), true);
});

// ---- simulation inputs ----------------------------------------------------------------------------
test('simulationInputs: exactly simulateNumbers()\'s shape from live data, with assumptions', () => {
  const l = buildLedger({ admin: admin(), money: money(), now: NOW });
  const inp = simulationInputsFrom({ ledger: l, weeks: 12 });
  assert.deepEqual(Object.keys(inp).sort(), ['assumptions', 'monthlyCost', 'paidShare', 'price', 'users', 'weeks', 'weeklyGrowth'].sort());
  for (const k of ['weeklyGrowth', 'paidShare', 'price', 'monthlyCost']) { const r = inp[k]; assert.ok(r.low <= r.likely && r.likely <= r.high, k); }
  assert.equal(inp.users, 1000); assert.equal(inp.weeks, 12);
  assert.match(inp.assumptions.join('\n'), /observed over the last 4 weeks/);
  assert.equal(inp.paidShare.likely, 0.009); assert.match(inp.assumptions.join('\n'), /buyer share: observed 0\.9% of accounts bought/);
  assert.equal(inp.price.likely, 11.99); assert.equal(inp.price.low, 9.99); assert.equal(inp.price.high, 19.99);
  assert.ok(inp.monthlyCost.high > inp.monthlyCost.likely, 'a missing cost widens the high end');
  const sim = simulateNumbers(inp);
  assert.equal(sim.ok, true); assert.ok(sim.summary.users.p50 > 1000);
  // no history, no payers → wide ranges flagged as assumed
  const bare = simulationInputsFrom({ ledger: { users: 50, paying: 0, revenue: {}, costs: { total: 20, missing: [] }, signupsChart: null } });
  assert.deepEqual(bare.weeklyGrowth, { low: 0, likely: 0.02, high: 0.1 });
  assert.match(bare.assumptions.join('\n'), /ASSUMED 0–10%\/week/); assert.match(bare.assumptions.join('\n'), /ASSUMED 0–3%/);
  assert.equal(simulateNumbers(bare).ok, true);
  const extra = simulationInputsFrom({ ledger: l, extra: { monthly: 25 } });
  assert.equal(extra.monthlyCost.likely, Math.round((l.costs.total + 25) * 100) / 100 || extra.monthlyCost.likely);
  assert.equal(simulationInputsFrom({ ledger: l, extra: { oneTime: 500 } }).oneTime.cost, 500);
});

test('observed weekly growth = signups in each 7-day window ÷ accounts at its start', () => {
  const g = observedWeeklyGrowth(chart(10), 1000);
  assert.equal(g.length, 4);
  assert.equal(Math.round(g[0] * 1e4), Math.round((70 / 930) * 1e4));
  assert.equal(Math.round(g[3] * 1e4), Math.round((70 / 720) * 1e4));
  assert.deepEqual(observedWeeklyGrowth(null, 10), []); assert.deepEqual(observedWeeklyGrowth(chart(1), 0), []);
});

test('a decision\'s own amount: "$25/mo" is monthly, "$500 on ads" one-time; money questions are recognised', () => {
  assert.deepEqual(costFromQuestion('Upgrade Supabase to Pro at $25/mo'), { monthly: 25 });
  assert.deepEqual(costFromQuestion('spend $1.2k a month on ads'), { monthly: 1200 });
  assert.deepEqual(costFromQuestion('spend $500 on reddit ads'), { oneTime: 500 });
  assert.equal(costFromQuestion('add a status page'), null);
  assert.equal(isMoneyQuestion('Can we afford Supabase Pro?'), true);
  assert.equal(isMoneyQuestion('raise the Pro price'), true);
  assert.equal(isMoneyQuestion('rename the jobs tab'), false);
});

test('numbersFor: a money decision gets live numbers, anything else (or one with numbers) gets null', async () => {
  _resetPictureCache();
  const deps = { admin: () => admin(), stripeSubs: () => null, sales: () => ({ configured: false }), employer: () => null, usage: () => ({ total: { costUsd: 0 } }), money: () => money(), history: () => [], facts: () => [], probes: () => null, growth: () => ({ available: false, reason: 'x' }), record: () => null };
  assert.equal(await numbersFor({ question: 'rename the jobs tab' }, { deps }), null);
  assert.equal(await numbersFor({ question: 'spend on ads', numbers: { users: 1 } }, { deps }), null);
  const n = await numbersFor({ question: 'Upgrade Supabase to Pro at $25/mo' }, { deps });
  assert.equal(n.users, 1000); assert.match(n.assumptions.join(' '), /includes the decision's \$25\/mo/);
  assert.equal(simulateNumbers(n).ok, true);
  const direct = await simulationInputs({ weeks: 8, deps });
  assert.equal(direct.weeks, 8);
  _resetPictureCache();
});

test('simulations: a queued money decision with no numbers is simulated with numbersFor\'s numbers', async () => {
  process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'sim-home-'));
  const { createSimulations } = await import('../simulations.mjs');
  const seen = [];
  const sims = createSimulations({ loadState: () => ({}), reasonFn: async () => ({ text: '' }), numbersFor: async (job) => ({ users: 7, from: job.question }), simulate: async (o) => { seen.push(o.numbers); return { ok: true, question: o.question, verdict: 'go', passes: {}, numbers: null }; } });
  sims.enqueue({ question: 'Upgrade Supabase at $25/mo' });
  sims.enqueue({ question: 'with own numbers', numbers: { users: 1 } });
  for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [{ users: 7, from: 'Upgrade Supabase at $25/mo' }, { users: 1 }]);
  const plain = createSimulations({ loadState: () => ({}), reasonFn: async () => ({}), simulate: async (o) => { seen.push(o.numbers); return { ok: false }; } });
  plain.enqueue({ question: 'no numbersFor given' });
  for (let i = 0; i < 50 && seen.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen[2], null, 'backward compatible: without numbersFor nothing changes');
});

// ---- store ----------------------------------------------------------------------------------------
test('store: costs are set, replaced, removed; bad amounts refused; nothing entered stays null', () => {
  assert.equal(parseAmount('$1,200.50'), 1200.5); assert.equal(parseAmount(''), null); assert.ok(Number.isNaN(parseAmount('abc'))); assert.ok(Number.isNaN(parseAmount(-5)));
  const m = defaultMoney();
  assert.equal(m.costs.find((c) => c.name.startsWith('Domain')).monthly, null);
  const r = setCost(m, { name: 'vercel pro', monthly: '40', note: 'two seats' }, { now: NOW });
  assert.equal(r.ok, true); assert.equal(r.previous.monthly, 20);
  const v = r.money.costs.find((c) => c.name === 'Vercel Pro');
  assert.equal(v.monthly, 40); assert.equal(v.confirmed, true); assert.equal(v.category, 'infra');
  assert.equal(setCost(m, { name: 'X', monthly: 'lots' }).ok, false);
  assert.equal(setCost(m, { name: '', monthly: 1 }).ok, false);
  assert.equal(setCost(m, { name: 'Figma', monthly: 15 }).money.costs.length, m.costs.length + 1);
  assert.equal(removeCost(r.money, 'Vercel Pro').money.costs.some((c) => c.name === 'Vercel Pro'), false);
  assert.equal(removeCost(m, 'nope').ok, false);
  assert.deepEqual(setCash(m, { amount: '2,500' }, { now: NOW }).money.cash, { amount: 2500, asOf: '2026-10-21' });
  assert.equal(setCash(m, { amount: null }).money.cash, null);
  assert.equal(setPlan(m, { service: 'supabase', plan: 'pro' }, { now: NOW }).money.plans.supabase.plan, 'pro');
  assert.equal(setPlan(m, { service: 'vercel', plan: 'pro' }).ok, false);
  assert.deepEqual(setReadiness(m, { id: 'status', done: true }, { now: NOW }).money.readiness.status.done, true);
});

test('store: the file round-trips; history keeps one reading per 20 minutes and never an empty one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-'));
  const path = join(dir, 'money.json');
  assert.equal(loadMoney({ path }).costs.length, defaultMoney().costs.length, 'missing file → defaults');
  saveMoney({ ...defaultMoney(), cash: { amount: 9, asOf: '2026-10-21' } }, { path, now: NOW });
  assert.equal(loadMoney({ path }).cash.amount, 9); assert.equal(loadMoney({ path }).plans.supabase.plan, 'free');
  const hp = join(dir, 'h.jsonl');
  assert.ok(recordSnapshot({ users: 1, dbMb: 437 }, { path: hp, now: NOW }));
  assert.equal(recordSnapshot({ users: 2 }, { path: hp, now: new Date(+NOW + 5 * 60_000) }), null);
  assert.ok(recordSnapshot({ users: 3 }, { path: hp, now: new Date(+NOW + 25 * 60_000) }));
  assert.equal(recordSnapshot({}, { path: hp, now: new Date(+NOW + 60 * 60_000) }), null);
  assert.deepEqual(readHistory({ path: hp, now: new Date(+NOW + 60 * 60_000) }).map((h) => h.users), [1, 3]);
});

// ---- board meeting blocks -------------------------------------------------------------------------
test('meeting blocks: revenue and reliability get compact live blocks; other departments get nothing', () => {
  const live = { admin_stats: admin(), stripe: { subscriptions: { activeCount: 2, mrr: 19.98 } } };
  const read = { money: () => money(), usage: () => ({ total: { costUsd: 1 } }), history: () => [], facts: () => [], record: () => null };
  const rev = moneyDeptBlock('revenue', live, { now: NOW, read });
  assert.match(rev, /^MONEY \(live, Oct 21, 10:00 AM PT/);
  assert.match(rev, /revenue \$139\.88 in 30 days \(one-time\) · 9 paying · 8 Interview Prep · 2 Job Search Pass/); assert.match(rev, /legacy subscriptions \$19\.98\/mo \(ending\)/);
  assert.match(rev, /take rate 16%/); assert.match(rev, /break-even \d+ sales a month/); assert.match(rev, /Stage \$1k|Stage Pre-revenue/); assert.match(rev, /never changes a score/);
  assert.doesNotMatch(rev, /MRR|trial|churn|LTV/);
  const rel = moneyDeptBlock('reliability', live, { now: NOW, read });
  assert.match(rel, /SCALE WATCH/); assert.match(rel, /ACT NOW: Storage guard/); assert.match(rel, /ETA ~6 h/);
  assert.equal(moneyDeptBlock('growth', live, { now: NOW, read }), '');
  assert.equal(moneyDeptBlock('revenue', null, { now: NOW, read: { money: () => { throw new Error('x'); } } }).startsWith('MONEY'), true, 'a failing read degrades, never throws');
  const p = moneyPicture({ admin: admin(), money: money(), now: NOW });
  assert.deepEqual(Object.keys(p).sort(), ['allocation', 'at', 'atPT', 'inputs', 'ledger', 'rule', 'scale', 'scenarios', 'units'].sort());
});
