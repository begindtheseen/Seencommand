import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEEN_ADMIN_USERNAME = 'admin';
process.env.SEEN_ADMIN_PASSWORD = 'pw';
process.env.SEEN_BASE_URL = 'https://seenjobs.io';
const admin = await import('./adminStats.mjs');

const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };

const SNAPSHOT = {
  users: { total: 1200, new_today: 8, dau: 40 },
  monetization: { mrr: 149, active_paid: 3, conversion_pct: 2, trialing: 1, past_due: 0, stripe_connected: true },
  job_health: { active: 5000, stale: 100, active_pct: 98, crisis: false },
  jobs: { stale_or_expired: 100, added_today: 30 },
  errors: { today: 1, this_week: 4 },
  reports: { total: 500, today: 3, outcome_breakdown: {} },
  flywheel: { job_searches_30d: 200 },
  applications: { ghost_rate_pct: 60 },
};

const FUNNEL = { ok: true, days: 30, recording: true,
  steps: [{ key: 'interviews', n: 12 }, { key: 'prep_offer_shown', n: 10 }, { key: 'prep_offer_clicked', n: 5 }, { key: 'prep_purchases', n: 3 }, { key: 'pass_purchases', n: 1 }],
  rates: { offer_click: 50, checkout: 60 },
  revenue: { interview_prep: 29.97, job_search_pass: 19.99, pass_count: 1, total: 49.95, paying_customers: 4, legacy_subscriptions_marked_pro: 2 },
  implied: { interviews_per_month: 12, take_rate_pct: 30, dollars: 35.96 } };

test('summary() logs in then shapes the snapshot for the engine', async () => {
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'POST') return { ok: true, status: 200, json: async () => ({ token: 'tok', role: 'super_admin' }), text: async () => '' };
    if (String(url).includes('action=revenue_funnel')) return { ok: true, status: 200, json: async () => FUNNEL, text: async () => '' };
    return { ok: true, status: 200, json: async () => SNAPSHOT, text: async () => '' }; // GET stats
  };
  const s = await admin.summary();
  restore();
  assert.equal(s.users.total, 1200);
  assert.equal(s.revenue.model, 'one-time');
  assert.equal(s.revenue.month, 49.95);
  assert.equal(s.revenue.payingCustomers, 4);
  assert.equal(s.revenue.prepPurchases, 3);
  assert.equal(s.revenue.passPurchases, 1);
  assert.equal(s.revenue.interviews, 12);
  assert.deepEqual(s.revenue.legacy, { mrr: 149, subscribers: 3, markedPro: 2 });
  assert.equal(s.raw.revenue_funnel.ok, true);
  assert.equal(s.jobs.active, 5000);
  assert.equal(s.errors.today, 1);
  assert.equal(s.revenue.stripeConnected, true);
});

test('summary(): a Seen without the revenue funnel leaves revenue unknown (null), never $0', async () => {
  const fresh = await import('./adminStats.mjs?nofunnel=' + Date.now());
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'POST') return { ok: true, status: 200, json: async () => ({ token: 'tok' }), text: async () => '' };
    if (String(url).includes('action=revenue_funnel')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 200, json: async () => SNAPSHOT, text: async () => '' };
  };
  const s = await fresh.summary();
  restore();
  assert.equal(s.revenue.month, null);
  assert.equal(s.revenue.payingCustomers, null);
  assert.match(s.revenue.funnelError, /404/);
  assert.equal(s.revenue.legacy.mrr, 149);
});

test('login throws a clear error when credentials are rejected', async () => {
  // bust the 7h token cache by re-importing a fresh module instance
  const fresh = await import('./adminStats.mjs?bust=' + Date.now());
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'Invalid credentials' });
  await assert.rejects(() => fresh.login(), /admin_login/);
  restore();
});
