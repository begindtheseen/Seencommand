// Run: node --test lib/money/routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoneyRoutes, handleMoney } from './routes.mjs';
import { defaultMoney } from './store.mjs';
import { moneyPicture } from './live.mjs';

const NOW = new Date('2026-10-21T17:00:00Z');
const FUNNEL = { ok: true, days: 30, recording: true, steps: [{ key: 'interviews', label: 'Cards at an interview now', n: 20 }, { key: 'prep_offer_shown', label: 'Saw the offer', n: 20 }, { key: 'prep_purchases', label: 'Bought Interview Prep', n: 5 }], revenue: { interview_prep: 49.95, job_search_pass: 0, pass_count: 0, credit_pack_count: 0, total: 49.95, paying_customers: 5 }, implied: { interviews_per_month: 20, take_rate_pct: 25, dollars: 49.95 } };
const admin = { raw: { users: { total: 500 }, revenue_funnel: FUNNEL, monetization: { mrr: 0, active_paid: 0, stripe_connected: true }, storage: { db_bytes: 437 * 1048576, max_mb: 470, blocking: false } } };

function harness({ local = true } = {}) {
  let stored = defaultMoney(); let saves = 0; let invalidated = 0; const activity = [];
  const routes = createMoneyRoutes({
    json: (res, code, body) => { res.code = code; res.body = body; },
    readBody: async (req) => req.body || {},
    localOnly: () => local,
    getPicture: async () => moneyPicture({ admin, money: stored, now: NOW }),
    simulationInputs: async ({ weeks, question }) => ({ users: 500, weeks, question }),
    load: () => stored,
    save: (m) => { saves++; stored = m; return m; },
    invalidate: () => { invalidated++; },
    logActivity: (a) => activity.push(a),
  });
  const call = async (method, path, body, qs = '') => { const res = {}; const handled = await routes({ method, body }, res, path, new URLSearchParams(qs)); return { handled, ...res }; };
  return { call, get stored() { return stored; }, get saves() { return saves; }, get invalidated() { return invalidated; }, activity };
}

test('routes: GET the picture and each slice; other paths are not ours', async () => {
  const h = harness();
  const all = await h.call('GET', '/api/money');
  assert.equal(all.code, 200); assert.equal(all.body.ledger.revenue.month, 49.95); assert.equal(all.body.ledger.purchases.interview, 5); assert.equal(all.body.ledger.funnel.takeRate.rate, 0.25); assert.ok(all.body.scale.items.length);
  assert.equal((await h.call('GET', '/api/money/scale')).body.items.find((i) => i.id === 'storage-guard').status, 'act');
  assert.match((await h.call('GET', '/api/money/allocate')).body.headline, /This month/);
  assert.ok((await h.call('GET', '/api/money/units')).body.scenarios.scenarios.length);
  const costs = await h.call('GET', '/api/money/costs');
  assert.equal(costs.body.costs.length, defaultMoney().costs.length); assert.ok(costs.body.totals.total >= 0);
  assert.deepEqual((await h.call('GET', '/api/money/simulation-inputs', null, 'weeks=8&question=x')).body, { users: 500, weeks: 8, question: 'x' });
  assert.equal((await h.call('GET', '/api/money/nope')).code, 404);
  assert.equal((await h.call('DELETE', '/api/money')).code, 405);
  assert.equal((await h.call('GET', '/api/jobs')).handled, false);
  assert.equal(await handleMoney({ method: 'GET' }, {}, '/api/moneyball', null, {}), false);
});

test('routes: writes save, invalidate the cache and log; bad input is a 400 that saves nothing', async () => {
  const h = harness();
  const ok = await h.call('POST', '/api/money/costs', { name: 'Figma', monthly: '15', category: 'tools' });
  assert.equal(ok.code, 200); assert.ok(h.stored.costs.some((c) => c.name === 'Figma' && c.monthly === 15));
  assert.equal(h.saves, 1); assert.equal(h.invalidated, 1); assert.match(h.activity[0].summary, /Figma/);
  assert.equal((await h.call('POST', '/api/money/costs', { name: 'Figma', monthly: 'lots' })).code, 400);
  assert.equal(h.saves, 1);
  assert.equal((await h.call('POST', '/api/money/costs', { name: 'Figma', remove: true })).code, 200);
  assert.ok(!h.stored.costs.some((c) => c.name === 'Figma'));
  assert.equal((await h.call('POST', '/api/money/cash', { amount: 1500 })).code, 200); assert.equal(h.stored.cash.amount, 1500);
  const bad = await h.call('POST', '/api/money/allocate', { stage: 'pre', pcts: { profit: 90, owner: 90 } });
  assert.equal(bad.code, 400); assert.match(bad.body.error, /add up to 180/);
  assert.equal((await h.call('POST', '/api/money/allocate', { stage: 'pre', pcts: { profit: 5, owner: 0, tax: 10, operating: 65, growth: 15, reserve: 5 } })).code, 200);
  assert.equal(h.stored.allocationOverrides.pre.profit, 5);
  const pic = await h.call('GET', '/api/money/allocate');
  assert.equal(pic.body.overridden, true);
  assert.equal((await h.call('POST', '/api/money/allocate', { stage: 'pre', reset: true })).code, 200); assert.equal(h.stored.allocationOverrides.pre, undefined);
  assert.equal((await h.call('POST', '/api/money/readiness', { id: 'status', done: true })).code, 200); assert.equal(h.stored.readiness.status.done, true);
  assert.equal((await h.call('POST', '/api/money/plan', { service: 'supabase', plan: 'pro' })).code, 200); assert.equal(h.stored.plans.supabase.plan, 'pro');
  assert.equal((await h.call('POST', '/api/money/channels', { name: 'reddit', spend30d: 0, signups30d: 12 })).code, 200); assert.equal(h.stored.channels[0].signups30d, 12);
});

test('routes: every write answers this Mac only; a scenario is read-only and allowed', async () => {
  const h = harness({ local: false });
  for (const p of ['/api/money/costs', '/api/money/cash', '/api/money/allocate', '/api/money/readiness', '/api/money/plan', '/api/money/channels']) {
    const r = await h.call('POST', p, { name: 'x', monthly: 1 });
    assert.equal(r.code, 403, p);
  }
  assert.equal(h.saves, 0);
  const sc = await h.call('POST', '/api/money/scenario', { levers: { takeRate: 0.5 } });
  assert.equal(sc.code, 200); assert.equal(sc.body.projection, true); assert.equal(sc.body.sales, 10); assert.equal(sc.body.consumer, 99.9);
  assert.equal(h.saves, 0);
});
