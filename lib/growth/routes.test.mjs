// Run: node --test lib/growth/routes.test.mjs — the /api/growth/* contract with stubbed admin-stats, model,
// brain and notifications (no network, no vault).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setGrowthDir } from './store.mjs';
import { createGrowthRoutes, isLocal } from './routes.mjs';

const SUMMARY = { users: { total: 50, newToday: 2, dau: 5 }, revenue: { month: 0, payingCustomers: 0, prepPurchases: 0, passPurchases: 0, interviews: 3 }, jobs: { active: 1000 }, flywheel: { reportsTotal: 500, shares: 3 }, dataQuality: { degraded: false },
  raw: { users: { new_this_week: 5 }, monetization: { active_paid: 0, mrr: 0, pro_users: 1, trialing: 0 }, reports: { this_week: 20 }, applications: { total: 10 }, companies: { with_scores: 100 } } };
const CALLOUTS = { ok: true, asOf: '2026-10-21', agencies: [{ name: 'Acme Staffing', isAgency: true, reports: 20, ghostPct: 60, responsePct: 40, confidence: 'Moderate confidence', url: 'https://seenjobs.io/agencies', line: 'Acme Staffing: 60% ghost rate across 20 applicant reports', sourceLine: 'seenjobs.io · 20 applicant reports, trust-weighted · moderate confidence · as of 2026-10-21 PT' }], companies: [], mostResponsive: [], mostGhosting: [] };
let facts, notes, handle;
beforeEach(() => {
  setGrowthDir(mkdtempSync(join(tmpdir(), 'growth-routes-')));
  facts = []; notes = [];
  handle = createGrowthRoutes({ stats: async () => SUMMARY, reasonFn: null, recordFact: async (f) => { facts.push(f); return { ok: true }; }, notify: async (n) => notes.push(n), callouts: async () => CALLOUTS, now: () => new Date('2026-10-21T18:00:00Z') });
});

async function call(method, path, body, { remote = '127.0.0.1', origin = 'http://127.0.0.1:4720' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: path, socket: { remoteAddress: remote }, headers: { host: '127.0.0.1:4720', ...(origin ? { origin } : {}) } });
  const out = { code: 0, headers: {}, body: null };
  const res = { writeHead(c, h) { out.code = c; out.headers = h || {}; }, end(b) { out.raw = b; try { out.body = JSON.parse(String(b)); } catch { out.body = b; } } };
  const u = new URL(path, 'http://x');
  const handled = await handle(req, res, u.pathname, u.searchParams);
  return { handled, ...out };
}

test('only this Mac; writes also need a same-origin Origin; other paths are not handled', async () => {
  assert.equal((await call('GET', '/api/growth/rules', undefined, { remote: '10.0.0.5' })).code, 403);
  assert.equal((await call('POST', '/api/growth/daily', { status: 'done' }, { origin: null })).code, 403);
  assert.equal((await call('GET', '/api/growth/rules', undefined, { origin: null })).code, 200, 'a same-origin GET carries no Origin header');
  assert.equal((await call('GET', '/api/jobs')).handled, false);
  assert.equal((await call('GET', '/api/growth/nope')).code, 404);
  assert.equal(isLocal({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.com' } }), false);
});

test('overview + plan: real numbers in, targets out, the baseline set once, the snapshot recorded', async () => {
  const o = await call('GET', '/api/growth/overview');
  assert.equal(o.code, 200); assert.equal(o.body.today, '2026-10-21'); assert.equal(o.body.check.actuals.users, 50);
  assert.equal(o.body.plan.baseline.users, 50); assert.ok(o.body.daily.item.title); assert.equal(o.body.calendar.days.length, 7);
  const p = await call('GET', '/api/growth/plan');
  assert.equal(p.body.targets.length, 26); assert.equal(p.body.phases.length, 3); assert.ok(p.body.history[1]);
  const re = await call('POST', '/api/growth/plan', { start: '2026-10-26', weeks: 30 });
  assert.equal(re.code, 200); assert.equal(re.body.plan.start, '2026-10-26'); assert.equal(re.body.plan.weeks, 30); assert.equal(facts.at(-1).subject, 'growth:plan');
  assert.equal((await call('POST', '/api/growth/plan', { start: 'next week' })).code, 400);
});

test('an off-track week notifies once per week', async () => {
  handle = createGrowthRoutes({ stats: async () => ({ ...SUMMARY, users: { total: 1, dau: 0 } }), reasonFn: null, recordFact: async () => ({ ok: true }), notify: async (n) => notes.push(n), callouts: async () => CALLOUTS, now: () => new Date('2026-11-20T18:00:00Z') });
  await call('POST', '/api/growth/plan', { start: '2026-10-19' });
  await call('GET', '/api/growth/overview');
  assert.ok(notes.some((n) => n.kind === 'growth' && /off-track|behind/.test(n.title) && n.tab === 'growth' && n.key));
});

test('admin-stats unreachable → targets with unknown actuals, said plainly', async () => {
  handle = createGrowthRoutes({ stats: async () => null, reasonFn: null, recordFact: async () => ({ ok: true }), notify: async () => {}, callouts: async () => CALLOUTS, now: () => new Date('2026-10-21T18:00:00Z') });
  const o = await call('GET', '/api/growth/overview');
  assert.equal(o.body.check.overall, 'unknown'); assert.match(o.body.statsError, /not configured/);
});

test('calendar → draft → approve → post → results, end to end', async () => {
  const g = await call('POST', '/api/growth/calendar/generate', { weeks: 6 });
  assert.equal(g.code, 200); assert.ok(g.body.added > 20); assert.deepEqual(g.body.violations, []);
  const all = await call('GET', '/api/growth/calendar?all=1');
  const it = all.body.items.find((i) => i.channel === 'x');
  const d = await call('POST', `/api/growth/copy/${encodeURIComponent(it.id)}/draft`, {});
  assert.equal(d.code, 200); assert.equal(d.body.variants.length, 3); assert.equal(d.body.engine, 'templates');
  assert.equal((await call('GET', `/api/growth/copy/${encodeURIComponent(it.id)}`)).body.item.status, 'drafted');
  const ad = await call('POST', `/api/growth/copy/${encodeURIComponent(it.id)}/draft`, { format: 'ad' });
  assert.ok(ad.body.variants.every((v) => v.parts.headline.length <= 40)); assert.equal((await call('GET', `/api/growth/copy/${encodeURIComponent(it.id)}`)).body.draft.format, 'x-thread', 'ad copy is stored beside, not over');
  const ap = await call('POST', `/api/growth/copy/${encodeURIComponent(it.id)}/approve`, { variant: 1 });
  assert.equal(ap.code, 200); assert.equal(facts.at(-1).predicate, 'approved-x-thread');
  assert.equal((await call('POST', `/api/growth/calendar/${encodeURIComponent(it.id)}/status`, { status: 'posted' })).code, 200);
  const r = await call('POST', `/api/growth/calendar/${encodeURIComponent(it.id)}/results`, { impressions: 4200, sessions: 61 });
  assert.equal(r.code, 200); assert.equal(r.body.item.status, 'measured');
  assert.equal((await call('POST', '/api/growth/copy/not-an-item/draft', {})).code, 404);
  const wk = await call('GET', '/api/growth/calendar?week=2026-10-28');
  assert.equal(wk.body.weekStart, '2026-10-26');
});

test('daily: today\'s item, mark done, streak; brand save; assets, ads, templates, meeting', async () => {
  const d = await call('GET', '/api/growth/daily'); assert.equal(d.code, 200); assert.ok(d.body.item.id); assert.equal(d.body.streak.current, 0);
  const m = await call('POST', '/api/growth/daily', { status: 'done', note: 'did it' }); assert.equal(m.body.streak.current, 1);
  assert.equal((await call('POST', '/api/growth/daily', { status: 'done', day: '2026-12-25' })).body.item.day, '2026-10-21', 'a future day cannot be marked');
  const b = await call('POST', '/api/growth/brand', { patch: { tagline: 'Know who answers before you apply.' }, note: 'test' });
  assert.equal(b.body.version, 1); assert.equal(facts.at(-1).subject, 'growth:brand');
  const bg = await call('GET', '/api/growth/brand'); assert.equal(bg.body.version, 1); assert.ok(bg.body.liveProof.some((p) => p.id === 'scored'));
  const as = await call('GET', '/api/growth/assets?week=3'); assert.equal(as.body.week, 3); assert.ok(as.body.angles.length === 4 && as.body.assets.length >= 5);
  const ads = await call('GET', '/api/growth/ads'); assert.match(ads.body.note, /no spend/); assert.ok(ads.body.simulate.t1.question);
  const t = await call('GET', '/api/growth/templates'); assert.equal(Object.keys(t.body.sizes).length, 5);
  assert.equal((await call('GET', '/api/growth/templates/quote')).body.template.id, 'quote');
  const mt = await call('GET', '/api/growth/meeting?dept=strategy'); assert.match(mt.body.block, /GROWTH STUDIO/);
  assert.equal((await call('GET', '/api/growth/positioning')).body.category.short, 'Employer response record');
});

test('library: saves a PNG, lists it, serves it; refuses anything else; fonts are served', async () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const s = await call('POST', '/api/growth/library', { png, name: 'Acme Staffing card', template: 'data-callout', size: 'square' });
  assert.equal(s.code, 200); assert.match(s.body.item.file, /^2026-10-21-[0-9a-f]{8}\.png$/);
  assert.equal((await call('GET', '/api/growth/library')).body.items[0].name, 'Acme Staffing card');
  const img = await call('GET', s.body.item.url); assert.equal(img.headers['content-type'], 'image/png'); assert.equal(img.raw[0], 0x89);
  assert.equal((await call('POST', '/api/growth/library', { png: 'data:text/html;base64,PGI+' })).code, 400);
  assert.equal((await call('GET', '/api/growth/library/..%2F..%2Fetc.png')).code, 404);
  const f = await call('GET', '/api/growth/fonts/Syne.woff2'); assert.equal(f.headers['content-type'], 'font/woff2'); assert.equal(String(f.raw.subarray(0, 4)), 'wOF2');
  assert.equal((await call('GET', '/api/growth/fonts/secret.txt')).code, 404);
});

test('the act verbs exist for the assistant (growth, daily, calendar, draft, approve-copy, brand, positioning, ad)', async () => {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try { execFileSync(process.execPath, [new URL('../../scripts/act.mjs', import.meta.url).pathname], { encoding: 'utf8' }); } catch (e) { out = e.stdout; }
  const verbs = JSON.parse(out).verbs;
  for (const v of ['growth', 'daily', 'calendar', 'draft', 'approve-copy', 'brand', 'positioning', 'ad']) assert.ok(verbs.includes(v), v);
});
