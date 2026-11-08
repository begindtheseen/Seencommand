// Data health: the one drain loop, the scan summary, the cleanup runner + daily schedule, the routes, and the
// assistant's act verbs. Seen's admin API is ALWAYS a stub here — nothing in this file reaches seenjobs.io.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  drain, isTransient, seenError, summarize, autoDue, describeRun, lookalikeKey,
  createDataHealth, createDataHealthRoutes, DRAIN_LIMITS, AUTO_EVERY_MS, AUTO_RETRY_MS,
} from './data-health.mjs';
import { needsYouItems, changesList } from './home.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const httpErr = (status, body) => Object.assign(new Error((body && body.error) || `HTTP ${status}`), { status, body });
const seq = (answers) => { let i = 0; const calls = []; const fn = async () => { const a = answers[Math.min(i, answers.length - 1)]; i++; calls.push(i); if (a instanceof Error) throw a; return typeof a === 'function' ? a() : a; }; fn.calls = calls; return fn; };
const did = (d) => d.deleted || 0;
const left = (d) => (typeof d.remaining === 'number' ? d.remaining : null);

// ---------------------------------------------------------------------------------------------- drain
test('drain repeats until Seen says complete and adds up what each round did', async () => {
  const call = seq([{ ok: true, deleted: 1000, remaining: 1400, complete: false }, { ok: true, deleted: 1000, remaining: 400, complete: false }, { ok: true, deleted: 400, remaining: 0, complete: true }]);
  const rounds = [];
  const r = await drain({ call, did, left, onRound: (o) => rounds.push(o.done) });
  assert.equal(r.ok, true); assert.equal(r.complete, true); assert.equal(r.done, 2400); assert.equal(r.left, 0);
  assert.equal(r.rounds, 3); assert.equal(r.stopped, 'complete');
  assert.deepEqual(rounds, [1000, 2000, 2400], 'live progress after every round');
});

test('drain stops when a round claims more work but did none (never spins)', async () => {
  const call = seq([{ ok: true, deleted: 50, remaining: 10, complete: false }, { ok: true, deleted: 0, remaining: 10, complete: false }, { ok: true, deleted: 10, complete: true }]);
  const r = await drain({ call, did, left });
  assert.equal(r.stopped, 'no_progress'); assert.equal(r.complete, false); assert.equal(r.done, 50); assert.equal(r.left, 10); assert.equal(call.calls.length, 2);
});

test('drain retries at most two lost rounds in a row, then stops with the reason', async () => {
  const lost = httpErr(504, null);
  const r = await drain({ call: seq([lost, lost, lost, { ok: true, deleted: 9, complete: true }]), did, left });
  assert.equal(r.ok, false); assert.equal(r.lostRounds, 2); assert.equal(r.rounds, 3); assert.match(r.error, /504/);
  // two lost, then an answer: the count resets and the run finishes
  const ok = await drain({ call: seq([lost, Object.assign(new Error('fetch failed'), { status: undefined }), { ok: true, deleted: 7, complete: true }]), did, left });
  assert.equal(ok.ok, true); assert.equal(ok.complete, true); assert.equal(ok.done, 7); assert.equal(ok.lostRounds, 2);
});

test('an explicit refusal stops at once, keeps earlier work, and carries Seen\'s own words', async () => {
  const refusal = httpErr(500, { error: 'Failed to remove duplicates', detail: 'delete failed (HTTP 500): statement timeout', deleted: 120, remaining: 80 });
  const r = await drain({ call: seq([{ ok: true, deleted: 300, remaining: 200, complete: false }, refusal]), did, left });
  assert.equal(r.ok, false); assert.equal(r.done, 420, 'the 120 deleted before the failure count'); assert.equal(r.left, 80);
  assert.equal(r.error, 'Failed to remove duplicates: delete failed (HTTP 500): statement timeout');
  assert.equal(isTransient(Object.assign(new Error('x'), { permanent: true })), false, 'not-configured is never retried');
  assert.equal(isTransient(httpErr(403, { error: 'Insufficient role' })), false);
  assert.equal(isTransient(httpErr(500, {})), true, 'an empty body (HTML error page) is transit');
  assert.equal(seenError(httpErr(500, { error: 'Same', detail: 'Same' })), 'Same');
});

test('drain honours the round cap and the time budget', async () => {
  const more = () => ({ ok: true, deleted: 1, remaining: 99, complete: false });
  const capped = await drain({ call: seq([more]), did, left, limits: { maxRounds: 5 } });
  assert.equal(capped.rounds, 5); assert.equal(capped.stopped, 'max_rounds'); assert.equal(capped.done, 5);
  let t = 0; const clock = () => t;
  const timed = await drain({ call: async () => { t += 100_000; return more(); }, did, left, now: clock });
  assert.equal(timed.stopped, 'time_budget'); assert.equal(timed.rounds, 3, `budget ${DRAIN_LIMITS.budgetMs} ms = 3 rounds of 100 s`);
  assert.equal(DRAIN_LIMITS.maxRounds, 40); assert.equal(DRAIN_LIMITS.maxLostInARow, 2);
});

test('a round that never answers is a lost round, not a hang', async () => {
  const never = () => new Promise(() => {});
  const r = await drain({ call: never, did, left, limits: { roundTimeoutMs: 20 } });
  assert.equal(r.ok, false); assert.equal(r.lostRounds, 2); assert.match(r.error, /no answer from Seen/);
});

// --------------------------------------------------------------------------------------------- summary
const JOBS = { ok: true, value: { ok: true, suspected: 312, groups: 140, protected: 4, total: 50000, sample: [{ keep: { id: 'a', title: 'Barista', company: 'Starbucks', location: 'Austin, TX', source: 'adzuna' }, remove: [{ id: 'b', title: 'Barista', company: 'Starbucks', location: 'Austin TX', source: 'adzuna' }], kept: [] }] } };
const REPORTS = { ok: true, value: { ok: true, total: 3000, groups: 70, suspected: 150, by_company: { 'Acme Corp': 90, Globex: 60 } } };
const COMPANIES = { ok: true, value: { ok: true, total: 1718, duplicates: [
  { key: 'initech', auto: true, companies: [{ id: 1, name: 'Initech', report_count: 4 }, { id: 2, name: 'Initech, LLC', report_count: 1 }] },
  { key: 'umbrella', auto: false, companies: [{ id: 3, name: 'Umbrella Group', report_count: 9 }, { id: 4, name: 'Umbrella', report_count: 2 }] },
] } };
const STATS = { ok: true, value: { jobs: { stale_clearable: 2000, expired_kept: 12, stale_overdue: 40, active: 45000 }, job_health: { active: 45000 }, data_quality: { degraded: false } } };

test('the summary reads every check in plain words, without inventing numbers', () => {
  const s = summarize({ jobs: JOBS, reports: REPORTS, companies: COMPANIES, stats: STATS });
  assert.equal(s.sections.job_dupes.count, 312); assert.match(s.sections.job_dupes.line, /312 duplicate listings in 140 groups/);
  assert.match(s.sections.job_dupes.line, /4 more copies stay/);
  assert.equal(s.sections.stale.count, 2000); assert.match(s.sections.stale.line, /40 of them are overdue/);
  assert.equal(s.sections.report_dupes.count, 150); assert.deepEqual(s.sections.report_dupes.byCompany[0], { company: 'Acme Corp', copies: 90 });
  assert.equal(s.sections.company_dupes.count, 1); assert.equal(s.sections.company_dupes.lookalikesWaiting, 1);
  assert.deepEqual(s.sections.company_dupes.autoSample, [{ keep: 'Initech', merge: ['Initech, LLC'] }]);
  assert.equal(s.toClean, 312 + 2000 + 150 + 1); assert.equal(s.failed, 0);
  // a look-alike the owner already reviewed stays quiet
  const reviewed = summarize({ jobs: JOBS, reports: REPORTS, companies: COMPANIES, stats: STATS }, { reviewed: [lookalikeKey(COMPANIES.value.duplicates[1])] });
  assert.equal(reviewed.sections.company_dupes.lookalikesWaiting, 0); assert.match(reviewed.sections.company_dupes.line, /reviewed/);
});

test('a check that failed says so with Seen\'s reason; the others still count', () => {
  const s = summarize({ jobs: { ok: false, error: 'scan did not finish in time' }, reports: REPORTS, companies: COMPANIES, stats: { ok: true, value: { jobs: { stale_clearable: null } } } });
  assert.equal(s.sections.job_dupes.ok, false); assert.match(s.sections.job_dupes.line, /could not be checked — scan did not finish in time/);
  assert.equal(s.sections.stale.ok, false, 'a null stale count is not zero'); assert.match(s.sections.stale.line, /could not be counted/);
  assert.equal(s.failed, 2); assert.equal(s.toClean, 151); assert.match(s.headline, /2 checks could not run/);
  const none = summarize({ jobs: { ok: false, error: 'x' }, reports: { ok: false, error: 'x' }, companies: { ok: false, error: 'x' }, stats: { ok: false, error: 'x' } });
  assert.equal(none.headline, 'Seen could not be checked right now.');
});

// -------------------------------------------------------------------------------------- runner + state
function harness({ answers = {}, configured = true, start = '2026-10-21T13:00:00Z' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dh-'));
  let t = new Date(start).getTime();
  const log = { activity: [], notes: [], failures: [], resolved: [], calls: [], finished: 0 };
  const dh = createDataHealth({
    action: async (b) => { log.calls.push(b.action); const a = answers[b.action]; if (!a) throw httpErr(400, { error: `Unknown action: ${b.action}` }); return a(); },
    stats: async () => STATS.value, configured: () => configured, file: () => join(dir, 'data-health.json'),
    logActivity: (e) => log.activity.push(e), notify: (n) => log.notes.push(n), recordFailure: (f) => log.failures.push(f), resolveFailure: (f) => log.resolved.push(f),
    onFinished: () => { log.finished++; }, now: () => new Date(t),
  });
  return { dh, log, dir, advance: (ms) => { t += ms; }, file: join(dir, 'data-health.json') };
}
const once = (v) => () => v;

test('a manual cleanup runs to the end, records history + activity, and never notifies', async () => {
  let n = 0;
  const h = harness({ answers: { dedupe_jobs: () => (++n < 3 ? { ok: true, deleted: 1000, remaining: 3000 - n * 1000, complete: false } : { ok: true, deleted: 1000, remaining: 0, complete: true }) } });
  const r = h.dh.clean('job_dupes');
  assert.equal(r.ok, true); assert.equal(r.run.running, true);
  assert.equal(h.dh.clean('stale').code, 409, 'one cleanup at a time');
  const rec = await r.done;
  assert.equal(rec.status, 'completed'); assert.equal(rec.removed, 3000); assert.equal(rec.steps[0].left, 0);
  assert.equal(rec.summary, '3,000 duplicate listings removed · 0 left');
  assert.equal(h.log.activity.length, 1); assert.equal(h.log.activity[0].kind, 'data-health'); assert.match(h.log.activity[0].summary, /^Cleanup: 3,000 duplicate listings removed/);
  assert.equal(h.log.notes.length, 0, 'the owner pressed it and is looking at the result');
  assert.equal(h.log.finished, 1);
  const saved = JSON.parse(readFileSync(h.file, 'utf8'));
  assert.equal(saved.history.length, 1); assert.equal(h.dh.history()[0].id, rec.id); assert.match(h.dh.history()[0].when, /Oct 21, 6:00 AM/, 'California time');
  assert.equal(h.dh.progress().running, false); assert.equal(h.dh.progress().status, 'completed');
});

test('"all" runs stale, duplicates, reports and Inc/LLC merges; one failure makes it partial, not lost', async () => {
  const h = harness({ answers: {
    purge_stale_jobs: once({ ok: true, removed: 900, remaining: 0, complete: true }),
    dedupe_jobs: once({ ok: true, deleted: 12, remaining: 0, complete: true }),
    dedupe_reports: () => { throw httpErr(403, { error: 'Insufficient role' }); },
    auto_merge: once({ ok: true, merged: 3, remaining: 0, complete: true }),
  } });
  const rec = await h.dh.clean('all').done;
  assert.deepEqual(h.log.calls, ['purge_stale_jobs', 'dedupe_jobs', 'dedupe_reports', 'auto_merge']);
  assert.equal(rec.status, 'partial'); assert.equal(rec.removed, 915);
  assert.match(rec.summary, /duplicate reports: failed — Insufficient role/);
  assert.equal(h.dh.clean('everything').code, 400);
});

test('the automatic cleanup: duplicates + stale only, a notification only when it did something or failed', async () => {
  const quiet = harness({ answers: { purge_stale_jobs: once({ ok: true, removed: 0, complete: true }), dedupe_jobs: once({ ok: true, deleted: 0, complete: true }), dedupe_reports: once({ ok: true, marked: 0, complete: true }) } });
  const r0 = quiet.dh.tick(); assert.equal(r0.ok, true, 'never ran → due now');
  await r0.done;
  assert.deepEqual(quiet.log.calls, ['purge_stale_jobs', 'dedupe_jobs', 'dedupe_reports'], 'company merges are never automatic');
  assert.equal(quiet.log.notes.length, 0, 'nothing removed → no notification');
  assert.equal(quiet.dh.tick().skipped, true, 'not due again for a day');
  quiet.advance(AUTO_EVERY_MS); const again = quiet.dh.tick(); assert.equal(again.ok, true, 'due after 24 h'); await again.done;

  const busy = harness({ answers: { purge_stale_jobs: once({ ok: true, removed: 40, complete: true }), dedupe_jobs: once({ ok: true, deleted: 2, complete: true }), dedupe_reports: once({ ok: true, marked: 0, complete: true }) } });
  await busy.dh.tick().done;
  assert.equal(busy.log.notes.length, 1); assert.equal(busy.log.notes[0].level, 'success'); assert.match(busy.log.notes[0].title, /42 cleaned/);
  assert.equal(busy.log.failures.length, 0);

  const broken = harness({ answers: { purge_stale_jobs: () => { throw httpErr(500, { error: 'Failed to clear stale listings', detail: 'canceling statement due to statement timeout' }); }, dedupe_jobs: once({ ok: true, deleted: 0, complete: true }), dedupe_reports: once({ ok: true, marked: 0, complete: true }) } });
  await broken.dh.tick().done;
  assert.equal(broken.log.notes[0].level, 'error');
  assert.equal(broken.log.failures.length, 1, 'fed to the failure queue'); assert.equal(broken.log.failures[0].id, 'data-health-auto');
  assert.match(broken.log.failures[0].reason, /statement timeout/);
  assert.equal(broken.dh.needsYou()[0].level, 'error', 'a failed cleanup reaches Home');
  assert.equal(broken.dh.tick().skipped, true); broken.advance(AUTO_RETRY_MS); const retry = broken.dh.tick(); assert.equal(retry.ok, true, 'a failed run is retried after 6 h'); await retry.done;
});

test('the next good automatic run resolves the open failure', async () => {
  let fail = true;
  const h = harness({ answers: { purge_stale_jobs: () => { if (fail) throw httpErr(500, { error: 'boom' }); return { ok: true, removed: 0, complete: true }; }, dedupe_jobs: once({ ok: true, deleted: 0, complete: true }), dedupe_reports: once({ ok: true, marked: 0, complete: true }) } });
  await h.dh.tick().done; assert.equal(h.log.failures.length, 1);
  fail = false; h.advance(AUTO_RETRY_MS); await h.dh.tick().done;
  assert.equal(h.log.resolved.length, 1); assert.equal(h.log.resolved[0].id, 'data-health-auto');
});

test('the daily schedule decision', () => {
  const now = Date.parse('2026-10-21T20:00:00Z');
  assert.equal(autoDue({ now }), true, 'never ran');
  assert.equal(autoDue({ enabled: false, now }), false, 'the switch is off');
  assert.equal(autoDue({ lastAttemptAt: new Date(now - 23 * 3600e3).toISOString(), now }), false);
  assert.equal(autoDue({ lastAttemptAt: new Date(now - 25 * 3600e3).toISOString(), now }), true, 'more than a day — catch up on start');
  assert.equal(autoDue({ lastAttemptAt: new Date(now - 7 * 3600e3).toISOString(), lastOk: false, now }), true);
  const off = harness({ answers: {} }); off.dh.setAuto(false); assert.equal(off.dh.tick().skipped, true);
  assert.equal(off.dh.autoStatus().enabled, false); assert.equal(off.dh.settings().auto, false);
  assert.equal(harness({ configured: false }).dh.tick().skipped, true, 'no admin credentials → nothing to do, no failure noise');
});

test('scan: four checks in parallel, cached for two minutes, look-alikes reach Home until reviewed', async () => {
  const h = harness({ answers: { scan_job_dupes: once(JOBS.value), scan_report_dupes: once(REPORTS.value), find_duplicates: once(COMPANIES.value) } });
  const a = await h.dh.scan();
  assert.equal(a.toClean, 312 + 2000 + 150 + 1); assert.equal(h.log.calls.length, 3);
  await h.dh.scan(); assert.equal(h.log.calls.length, 3, 'cached');
  h.advance(121_000); await h.dh.scan(); assert.equal(h.log.calls.length, 6, 're-checked after 2 minutes');
  await h.dh.scan({ refresh: true }); assert.equal(h.log.calls.length, 9);
  assert.match(h.dh.needsYou()[0].title, /1 look-alike company group to review/);
  h.dh.review(a.sections.company_dupes.lookalikeList[0].key);
  await h.dh.scan(); assert.equal(h.dh.needsYou().length, 0, 'reviewed → quiet');
  const off = await harness({ configured: false }).dh.scan(); assert.equal(off.configured, false); assert.match(off.headline, /Settings/);
});

test('describeRun words a run plainly', () => {
  assert.equal(describeRun({ steps: [{ kind: 'stale', done: 1200, left: 0 }, { kind: 'report_dupes', done: 0, left: null, error: 'Insufficient role' }] }), '1,200 stale listings cleared · 0 left · duplicate reports: failed — Insufficient role');
});

// -------------------------------------------------------------------------------------------- routes
function routeHarness(local = true) {
  const h = harness({ answers: { scan_job_dupes: once(JOBS.value), scan_report_dupes: once(REPORTS.value), find_duplicates: once(COMPANIES.value), purge_stale_jobs: once({ ok: true, removed: 5, complete: true }) } });
  const json = (res, code, body) => { res.code = code; res.body = body; };
  const route = createDataHealthRoutes({ dh: h.dh, json, readBody: async (req) => req.body, localOnly: (req) => req.local === true });
  const call = async (method, path, body, qs = '') => { const res = {}; const handled = await route({ method, body, local }, res, path, new URLSearchParams(qs)); return { handled, ...res }; };
  return { h, call };
}

test('routes: reads open to the window, every change answers this Mac only', async () => {
  const remote = routeHarness(false);
  for (const p of ['/api/data-health/clean', '/api/data-health/settings', '/api/data-health/review']) {
    const r = await remote.call('POST', p, { kind: 'stale', auto: false, key: 'k' });
    assert.equal(r.code, 403, p); assert.match(r.body.error, /this Mac only/);
  }
  assert.equal(remote.h.log.calls.length, 0, 'a refused request never reached Seen');
  assert.equal((await remote.call('GET', '/api/data-health')).code, 200, 'the panel can read');

  const local = routeHarness(true);
  const scan = await local.call('GET', '/api/data-health');
  assert.equal(scan.code, 200); assert.equal(scan.body.sections.stale.count, 2000); assert.equal(scan.body.auto.enabled, true);
  const started = await local.call('POST', '/api/data-health/clean', { kind: 'stale' });
  assert.equal(started.code, 202); assert.equal(started.body.run.kind, 'stale'); assert.equal('done' in started.body, false);
  assert.equal((await local.call('POST', '/api/data-health/clean', { kind: 'nope' })).code, 400);
  assert.equal((await local.call('POST', '/api/data-health/settings', { auto: 'yes' })).code, 400);
  assert.equal((await local.call('POST', '/api/data-health/settings', { auto: false })).body.auto.enabled, false);
  assert.equal((await local.call('GET', '/api/data-health/history')).code, 200);
  assert.equal((await local.call('GET', '/api/jobs')).handled, false, 'other routes pass through');
});

// --------------------------------------------------------------------------------------------- Home
test('Home lists data-health items and shows cleanups in recent changes (the ledger stamps ts)', () => {
  const items = needsYouItems({ state: {}, seen: null, runs: null, cloud: null, dataHealth: [{ kind: 'data-health', level: 'info', title: '2 look-alike company groups to review' }] });
  assert.deepEqual(items.map((i) => i.kind), ['data-health']);
  const c = changesList({ activity: [{ ts: '2026-10-21T12:00:00Z', kind: 'data-health', status: 'completed', summary: 'Cleanup: 3,000 duplicate listings removed' }] });
  assert.equal(c.length, 1); assert.equal(c[0].kind, 'data-health');
});

// ----------------------------------------------------------------------------------------- act verbs
async function stubApp(handler) {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin, body: b ? JSON.parse(b) : null });
      const [code, body] = handler(req.method, req.url, b ? JSON.parse(b) : null, seen.length);
      res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}
const act = (url, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(REPO, 'scripts', 'act.mjs'), ...args], { env: { ...process.env, SEEN_COMMAND_URL: url, ACT_POLL_MS: '5' } });
  let out = ''; p.stdout.on('data', (c) => { out += c; }); p.on('exit', (code) => resolve({ code, out: JSON.parse(out) }));
});

test('act data-health and act clean drive the app routes and wait for the cleanup to finish', async () => {
  const scan = summarize({ jobs: JOBS, reports: REPORTS, companies: COMPANIES, stats: STATS });
  let polls = 0;
  const app = await stubApp((method, url, body) => {
    if (method === 'GET' && url.startsWith('/api/data-health/run')) {
      polls++;
      return [200, { run: polls < 3 ? { running: true, steps: [{ kind: 'stale', label: 'Stale listings', done: polls * 100, status: 'running' }] } : { running: false, status: 'completed', summary: '300 stale listings cleared · 0 left', steps: [{ kind: 'stale', label: 'Stale listings', done: 300, left: 0, status: 'done' }] } }];
    }
    if (method === 'GET' && url.startsWith('/api/data-health')) return [200, { configured: true, ...scan, run: null, auto: { enabled: true } }];
    if (method === 'POST' && url === '/api/data-health/clean') return body.kind === 'stale' ? [202, { ok: true, run: { running: true, steps: [] } }] : [400, { error: 'bad kind' }];
    return [404, { error: 'no' }];
  });
  try {
    const s = await act(app.url, ['data-health']);
    assert.equal(s.code, 0); assert.equal(s.out.checks.job_dupes.count, 312); assert.deepEqual(s.out.checks.company_dupes.lookalikes, ['Umbrella Group · Umbrella']);
    const c = await act(app.url, ['clean', 'stale']);
    assert.equal(c.code, 0); assert.equal(c.out.status, 'completed'); assert.equal(c.out.steps[0].done, 300); assert.equal(polls, 3);
    const post = app.seen.find((x) => x.method === 'POST');
    assert.equal(post.origin, app.url, 'sends the app origin so the local-only gate lets it through');
    const bad = await act(app.url, ['clean', 'companies']);
    assert.equal(bad.code, 1); assert.match(bad.out.error, /clean <job_dupes\|stale/);
  } finally { await app.close(); }
});
