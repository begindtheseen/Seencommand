// The aggregation manager, hermetically: a temp store, a fake Seen checkout, FAKE child processes and
// fake readiness probes. No real collector, OpenCLI, Chrome, network, Seen or Chronos vault is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAggregationManager } from './aggregation-manager.mjs';
import { createStore } from '../lib/aggregation/store.mjs';
import { fakeRepo, fakeSpawn, okProbes, until } from '../lib/aggregation/testkit.mjs';

const TOKEN = 'indeed-secret-value-123';
const INDEED_OK = JSON.stringify({ ok: true, searches_requested: 1, searches_attempted: 1, searches_successful: 1, searches_failed: 0, raw_search_hits: 5, unique_indeed_ids: 5, duplicate_search_hits: 0, detail_requests_attempted: 5, detail_requests_successful: 5, detail_requests_failed: 0, jobs_submitted: 5, jobs_inserted: null, jobs_updated: null, jobs_rejected: 0, jobs_deduplicated: 0, upserted: 5, errors: {}, lastErrors: {}, duration_ms: 50 }, null, 2);
const INTEL_OK = '[collect] Acme Corp: 2 raw excerpts\n' + JSON.stringify({ ok: true, targets: 1, collected: 2, dry_run: true, imported_reports: 0, commentary: 0, duplicates: 0, rejected: 0 }, null, 2);

function setup({ probes = okProbes, now = () => new Date('2026-10-20T13:00:00Z'), extraEnv = {}, fetchImpl, notify } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'agg-mgr-'));
  const store = createStore({ base });
  const repo = fakeRepo();
  store.writeConfig({ seenRepoDir: repo, pipelines: {} });
  const sp = fakeSpawn();
  const facts = []; const acts = [];
  const env = { HOME: '/Users/tester', SEEN_LOCAL_INGEST_TOKEN: TOKEN, SEEN_COMPANY_INTEL_INGEST_TOKEN: 'intel-token-xyz', GITHUB_TOKEN: 'ghp_mustnotleak', SUPABASE_SERVICE_KEY: 'svc-must-not-leak', ...extraEnv };
  const mgr = createAggregationManager({ store, spawnImpl: sp.spawnImpl, env: () => env, now, execPath: '/usr/bin/node-test', readinessDeps: probes,
    recordFacts: (f) => { facts.push(...f); return { written: f.length }; }, logActivity: (e) => acts.push(e), killGraceMs: 20, ...(fetchImpl ? { fetchImpl } : {}), ...(notify ? { notify } : {}) });
  return { mgr, store, repo, sp, facts, acts, env };
}

test('all five collectors are registered with capabilities discovered from the checkout', () => {
  const { mgr } = setup();
  const cs = mgr.collectors();
  assert.deepEqual(cs.map((c) => c.id), ['company_intel', 'indeed', 'career_site', 'applicant_reports', 'web_reports']);
  assert.deepEqual(cs.find((c) => c.id === 'web_reports').resources, ['browser-bridge'], 'Google runs in Chrome, so it takes turns');
  const ar = cs.find((c) => c.id === 'applicant_reports');
  assert.deepEqual(ar.resources, [], 'the archive collector does not take the Browser Bridge');
  assert.deepEqual(ar.capabilities.goal, { min: 0, max: 100000, def: 10 });
  assert.deepEqual(ar.capabilities.fillBelow, { min: 1, max: 10000 });
  assert.equal(ar.capabilities.goalCountsNew, true);
  assert.equal(ar.capabilities.noModelCalls, true);
  assert.deepEqual(cs.find((c) => c.id === 'career_site').capabilities, { found: true, limitMax: 60, limitDefault: 20, maxTargets: 10, harvest: true, maxJobsMax: 5000, maxJobsDefault: 3000, targetsList: true, dryRun: true, navigator: false, keywords: false });
  assert.equal(cs.find((c) => c.id === 'indeed').capabilities.resultsPerSearchMax, 25);
  assert.equal(cs.find((c) => c.id === 'company_intel').capabilities.existingCompaniesOnly, true);
  assert.deepEqual(cs[0].resources, ['browser-bridge']);
});

test('a run spawns the REAL script path with explicit argv and only its documented env, then records history', async () => {
  const { mgr, sp, store, repo } = setup();
  const r = await mgr.startRun({ pipeline: 'indeed' });
  assert.equal(r.ok, true, r.error);
  assert.equal(sp.calls.length, 1);
  const { cmd, args, opts } = sp.calls[0];
  assert.equal(cmd, '/usr/bin/node-test');
  assert.deepEqual(args, [join(repo, 'scripts/ingest-indeed-opencli.mjs')]);
  assert.equal(opts.cwd, repo);
  assert.equal(opts.shell, undefined, 'never a shell');
  assert.equal(opts.env.SEEN_LOCAL_INGEST_TOKEN, TOKEN);
  assert.equal(opts.env.GITHUB_TOKEN, undefined, 'unrelated secrets never reach the collector');
  assert.equal(opts.env.SUPABASE_SERVICE_KEY, undefined);
  assert.equal(opts.env.INDEED_DETAIL_CONCURRENCY, '1');
  assert.ok(opts.env.PATH);
  sp.calls[0].child.finish(0, { stdout: INDEED_OK, stderr: `debug Bearer ${TOKEN} at /Users/tester/seen\n` });
  const done = await until(() => { const x = store.readRun(r.run.id); return x && x.status !== 'running' && x; });
  assert.equal(done.status, 'completed');
  assert.equal(done.metrics.written, 5);
  assert.ok(done.durationMs >= 0);
  const blob = JSON.stringify(done);
  assert.doesNotMatch(blob, new RegExp(TOKEN), 'tokens are redacted from stored tails');
  assert.doesNotMatch(blob, /\/Users\/tester/);
  assert.equal(mgr.listRuns({ pipeline: 'indeed' }).length, 1);
  assert.equal(mgr.listRuns({ pipeline: 'company_intel' }).length, 0, 'histories are independent');
  assert.equal(mgr.listRuns({ source: 'indeed', status: 'completed' }).length, 1);
});

test('one active run per pipeline; the two pipelines share the Browser Bridge, so the second QUEUES', async () => {
  const { mgr, sp, store } = setup();
  const a = await mgr.startRun({ pipeline: 'indeed' });
  const dup = await mgr.startRun({ pipeline: 'indeed' });
  assert.equal(dup.ok, false); assert.equal(dup.code, 409);
  const b = await mgr.startRun({ pipeline: 'company_intel' });
  assert.equal(b.ok, true);
  assert.equal(sp.calls.length, 1, 'company intel must not start while Indeed holds the bridge');
  assert.equal(store.readRun(b.run.id).status, 'queued');
  assert.equal(store.readRun(b.run.id).waitingFor, 'browser-bridge');
  sp.calls[0].child.finish(0, { stdout: INDEED_OK });
  await until(() => sp.calls.length === 2);
  assert.deepEqual(sp.calls[1].args.slice(1), ['--dry-run'], 'the queued run starts with its own argv');
  sp.calls[1].child.finish(0, { stdout: INTEL_OK });
  const done = await until(() => { const x = store.readRun(b.run.id); return x.status === 'completed' && x; });
  assert.equal(done.metrics.excerptsCollected, 2);
  assert.equal(done.metrics.importedReports, null);
  assert.equal(store.readRun(a.run.id).status, 'completed');
});

test('applicant reports (the archive) needs no browser: it runs WHILE a Chrome collector holds the bridge', async () => {
  const { mgr, sp, store, repo } = setup({ extraEnv: { NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem', HTTPS_PROXY: 'http://proxy.corp:3128' } });
  const chrome = await mgr.startRun({ pipeline: 'indeed' });
  const ar = await mgr.startRun({ pipeline: 'applicant_reports', overrides: { mode: 'import', fillBelow: 10, companyLimit: 25, goal: 0 } });
  assert.equal(ar.ok, true, ar.error);
  assert.equal(sp.calls.length, 2, 'started at once, not queued');
  const { args, opts } = sp.calls[1];
  assert.deepEqual(args, [join(repo, 'scripts/collect-archive-reports.mjs')], 'import mode: no --dry-run');
  assert.equal(opts.env.SEEN_COMPANY_INTEL_INGEST_TOKEN, 'intel-token-xyz');
  assert.equal(opts.env.ARCHIVE_REPORTS_BELOW, '10');
  assert.equal(opts.env.ARCHIVE_REPORTS_GOAL, '0', 'no cap');
  assert.equal(opts.env.SEEN_LOCAL_INGEST_TOKEN, undefined, 'only its own documented env');
  assert.equal(opts.env.NODE_EXTRA_CA_CERTS, '/etc/corp-ca.pem', 'network settings reach a collector that goes online');
  assert.equal(opts.env.HTTPS_PROXY, 'http://proxy.corp:3128');
  sp.calls[1].child.finish(0, { stdout: JSON.stringify({ ok: true, dry_run: false, goal: 0, years: 5, targets: 1, found: 40, imported_reports: 37, published_reports: 37, downgraded: 1, duplicates: 2, rejected: 0, ingest_error: null, stopped_early: null, not_reached: [],
    rejection_reasons: [], companies: [{ company: 'Chipotle', found: 40, imported: 37, published: 37, duplicates: 2, downgraded: 1, rejected: 0, threads_read: 90, searches: 30, failed_searches: 0, company_subs: ['Chipotle'], stopped_by: 'exhausted', outcomes: {} }] }) });
  const done = await until(() => { const x = store.readRun(ar.run.id); return x.status === 'completed' && x; });
  assert.equal(done.metrics.newReports, 37);
  assert.equal(done.mode, 'import');
  const st = await mgr.status();
  assert.equal(st.pipelines.applicant_reports.recent.value, 37);
  assert.deepEqual(Object.keys(st.pipelines.applicant_reports.modes), ['dry_run', 'import']);
  assert.equal(store.readRun(chrome.run.id).status, 'running', 'the Chrome collector was never disturbed');
});

test('cancellation signals only the owned child; queued runs cancel without starting', async () => {
  const { mgr, sp, store } = setup();
  const a = await mgr.startRun({ pipeline: 'indeed' });
  const b = await mgr.startRun({ pipeline: 'company_intel' });
  const cq = mgr.cancelRun(b.run.id);
  assert.equal(cq.ok, true); assert.equal(store.readRun(b.run.id).status, 'cancelled');
  const child = sp.calls[0].child;
  child.onKill = (sig) => { if (sig === 'SIGTERM') child.finish(null, { signal: 'SIGTERM' }); };
  const c = mgr.cancelRun(a.run.id);
  assert.equal(c.ok, true); assert.match(c.note, /stay stored/);
  const done = await until(() => { const x = store.readRun(a.run.id); return x.status === 'cancelled' && x; });
  assert.deepEqual(child.killed.slice(0, 1), ['SIGTERM']);
  assert.match(done.reason, /already submitted/);
  assert.equal(sp.calls.length, 1, 'the cancelled queued run never started');
  assert.equal(mgr.cancelRun(a.run.id).code, 409);
  assert.equal(mgr.cancelRun('agg-indeed-20261020T000000Z-000000').code, 404);
});

test('a blocked pipeline refuses to start and says why; the other pipeline is unaffected', async () => {
  const probes = { ...okProbes, probeIntelMigration: async () => ({ status: 'missing', migration: 'm.sql', detail: 'company_intel_imports does not exist', fix: 'apply (owner approval)' }) };
  const { mgr, sp, store } = setup({ probes });
  store.writeConfig({ ...store.readConfig(), pipelines: { company_intel: { mode: 'import', companyLimit: 5, postsPerCompany: 3 } } });
  const r = await mgr.startRun({ pipeline: 'company_intel' });
  assert.equal(r.ok, false); assert.equal(r.code, 422);
  assert.ok(r.blockers.some((b) => b.id === 'migration'));
  assert.equal(sp.calls.length, 0);
  const dry = await mgr.startRun({ pipeline: 'company_intel', overrides: { mode: 'dry_run' } });
  assert.equal(dry.ok, true, 'a dry run does not need the migration');
  const st = await mgr.status();
  assert.equal(st.pipelines.company_intel.modes.import, 'blocked');
  assert.equal(st.pipelines.company_intel.modes.dry_run, 'ready');
  assert.notEqual(st.pipelines.indeed.state, 'blocked', 'an intel failure never blocks Indeed');
});

test('a disconnected bridge blocks start with the recovery step; invalid overrides are rejected', async () => {
  const { mgr } = setup({ probes: { ...okProbes, probeOpenCli: async () => ({ installed: true, bridge: 'disconnected', status: 'broken', detail: 'Browser Bridge not connected', fix: 'Open Chrome with the extension connected' }) } });
  const r = await mgr.startRun({ pipeline: 'indeed' });
  assert.equal(r.code, 422); assert.match(r.blockers[0].fix, /Chrome/);
  const bad = await mgr.startRun({ pipeline: 'indeed', overrides: { searches: [{ query: '$(rm -rf ~)' }], resultsPerSearch: 999 } });
  assert.equal(bad.code, 422); assert.match(bad.errors.join(), /results per search/);
  assert.equal((await mgr.startRun({ pipeline: 'shell' })).code, 400);
});

test('a large run needs explicit confirmation from the operator', async () => {
  const { mgr, sp } = setup();
  const big = { searches: Array.from({ length: 20 }, (_, i) => ({ query: `role ${i}` })), resultsPerSearch: 25, maxPages: 2 };
  const r = await mgr.startRun({ pipeline: 'indeed', overrides: big });
  assert.equal(r.code, 409); assert.equal(r.needsConfirmation, true);
  assert.equal(sp.calls.length, 0);
  assert.equal((await mgr.startRun({ pipeline: 'indeed', overrides: big, confirmLarge: true })).ok, true);
});

test('restart recovery: an orphaned running run is interrupted (not adopted); a stale queued run expires', () => {
  const { mgr, store } = setup();
  const base = { pipeline: 'indeed', label: 'Indeed Jobs', resources: ['browser-bridge'], events: [], config: {} };
  store.writeRun({ ...base, id: 'agg-indeed-20261020T100000Z-aaaaaa', status: 'running', createdAt: '2026-10-20T10:00:00Z', pid: 999999 });
  store.writeRun({ ...base, pipeline: 'company_intel', id: 'agg-company_intel-20261020T090000Z-bbbbbb', status: 'queued', createdAt: '2026-10-20T09:00:00Z' });
  mgr.recover();
  assert.equal(store.readRun('agg-indeed-20261020T100000Z-aaaaaa').status, 'interrupted');
  assert.match(store.readRun('agg-indeed-20261020T100000Z-aaaaaa').reason, /not adopted/);
  assert.equal(store.readRun('agg-company_intel-20261020T090000Z-bbbbbb').status, 'cancelled');
});

test('schedules: off by default, independent, persisted; a due slot runs, a missed one runs ONCE on wake', async () => {
  let clock = new Date('2026-10-20T05:00:00');
  const { mgr, sp, store, facts } = setup({ now: () => clock });
  assert.equal(mgr.getSchedules().indeed.enabled, false);
  assert.equal(mgr.getSchedules().company_intel.enabled, false);
  const s = await mgr.putSchedule('indeed', { enabled: true, frequency: 'daily', time: '06:00' });
  assert.equal(s.ok, true);
  assert.equal(new Date(s.schedule.nextRunAt).getHours(), 6);
  assert.equal(store.readSchedules().company_intel?.enabled ?? false, false, 'enabling one leaves the other off');
  assert.ok(facts.some((f) => f.predicate === 'schedule' && /enabled by the owner/.test(f.object)), 'the owner decision is remembered');
  assert.equal((await mgr.putSchedule('indeed', { frequency: 'hourly' })).code, 422);
  clock = new Date('2026-10-20T06:00:30');
  const ran = await mgr.tick();
  assert.deepEqual(ran.map((x) => x.action), ['run']);
  assert.equal(sp.calls.length, 1);
  assert.equal(mgr.listRuns({ pipeline: 'indeed' })[0].trigger, 'schedule');
  sp.calls[0].child.finish(0, { stdout: INDEED_OK });
  await until(() => store.readSchedules().indeed.lastOutcome === 'completed');
  // The app is closed for three days: ONE catch-up run on wake, never three.
  clock = new Date('2026-10-23T09:00:00');
  const later = await mgr.tick();
  assert.deepEqual(later.map((x) => x.action), ['missed']);
  assert.equal(sp.calls.length, 2);
  assert.equal(mgr.listRuns({ pipeline: 'indeed' })[0].trigger, 'catchup');
  assert.ok(new Date(mgr.getSchedules().indeed.nextRunAt) > clock);
  assert.deepEqual((await mgr.tick()).map((x) => x.action), [], 'a second tick does not start another');
});

test('a partial run re-runs itself once with the same settings, then stops; every end is a notification', async () => {
  const notes = [];
  const { mgr, sp, store } = setup({ notify: (n) => notes.push(n) });
  const PARTIAL = INDEED_OK.replace('"searches_failed": 0', '"searches_failed": 1').replace('"searches_successful": 1', '"searches_successful": 1');
  const first = await mgr.startRun({ pipeline: 'indeed' });
  sp.calls[0].child.finish(0, { stdout: PARTIAL });
  await until(() => sp.calls.length === 2);
  const second = mgr.listRuns({ pipeline: 'indeed' }).find((r) => r.id !== first.run.id);
  assert.equal(store.readRun(first.run.id).status, 'partial');
  assert.equal(second.trigger, 'retry');
  assert.equal(store.readRun(second.id).retryOf, first.run.id);
  assert.equal(store.readRun(second.id).attempt, 2);
  assert.deepEqual(sp.calls[1].args.slice(1), sp.calls[0].args.slice(1), 'the re-run uses the same settings');
  sp.calls[1].child.finish(0, { stdout: PARTIAL });
  await until(() => store.readRun(second.id).status === 'partial');
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(sp.calls.length, 2, 'two runs in total, then it stops');
  assert.equal(notes.length, 2);
  assert.match(notes[0].title, /finished partly/);
  assert.match(notes[0].body, /Re-running it automatically \(run 2 of 2\)/);
  assert.match(notes[1].title, /\(run 2 of 2\)/);
  assert.match(notes[1].body, /Still partial after 2 runs/);
  assert.equal(notes[0].level, 'warning');
});

test('Chronos receives meaningful outcomes only, through the injected canonical writer', async () => {
  const { mgr, sp, store, facts } = setup();
  for (let i = 0; i < 2; i++) {
    const r = await mgr.startRun({ pipeline: 'indeed' });
    sp.calls[i].child.finish(0, { stdout: INDEED_OK });
    await until(() => store.readRun(r.run.id).status === 'completed');
    await new Promise((x) => setTimeout(x, 10));
  }
  const health = facts.filter((f) => f.predicate === 'health');
  assert.equal(health.length, 1, 'two healthy runs → one fact');
  assert.equal(health[0].subject, 'seen:aggregation:indeed');
  assert.doesNotMatch(JSON.stringify(facts), /indeed\.com\/viewjob/, 'no collected record is written to Chronos');
});

test('configuration: strict validation, an absolute repo path, and nothing executable', () => {
  const { mgr } = setup();
  assert.equal(mgr.putConfig({ seenRepoDir: 'relative/seen' }).code, 400);
  assert.equal(mgr.putConfig({ command: 'rm -rf /' }).code, 400);
  assert.equal(mgr.putConfig({ pipelines: { indeed: { searches: [] } } }).code, 422);
  const ok = mgr.putConfig({ pipelines: { indeed: { searches: [{ query: 'nurse', location: 'Austin, TX' }], resultsPerSearch: 10, maxPages: 2, presets: [{ name: 'Health', searches: [{ query: 'nurse' }] }] } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.pipelines.indeed.config.presets[0].name, 'Health');
  assert.equal(ok.config.pipelines.indeed.estimate.searchCalls, 2);
});

test('employer-board pull runs one at a time, keeps the last result, and logs plain activity lines', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url, o) => {
    calls++;
    assert.match(String(url), /\/api\/refresh-employer-boards$/);
    assert.equal(o.headers.Authorization, `Bearer ${TOKEN}`);
    await gate;
    return { ok: true, status: 200, async json() { return { boards: 200, synced: 180, failed: 20, fetched: 4000, kept: 2300, dropped_outside_market: 1700, upserted: 2290, by_provider: {} }; } };
  };
  const { mgr, acts } = setup({ fetchImpl });
  const a = mgr.pullBoards({ limit: 200 });
  const b = mgr.pullBoards({ limit: 200 });
  assert.equal(mgr.boardsStatus().running, true);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1, 'a second press while one runs joins it');
  assert.equal(ra, rb);
  assert.equal(ra.saved, 2290);
  assert.deepEqual(mgr.boardsStatus(), { running: false, last: ra });
  assert.ok(acts.some((e) => /180\/200 boards answered, 2290 US\/remote listings saved/.test(e.summary)));
  const bad = await mgr.pullBoards({ companies: [] });
  assert.equal(bad.ok, false);
  assert.equal(mgr.boardsStatus().last, ra, 'a failed pull never replaces the last good result');
});

test('company job pull: Indeed searches the names now, Seen pulls server-side, unreadable sites queue for Chrome', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const sent = [];
  const fetchImpl = async (url, o) => {
    sent.push({ url: String(url), body: JSON.parse(o.body) });
    assert.equal(o.headers.Authorization, `Bearer ${TOKEN}`);
    await gate;
    return { ok: true, status: 200, async json() {
      return { ok: true, saved: 1015, results: [
        { company: 'Globex', saved: 1000, boards: { status: 'ok', registered: 'existing', boards: [{ provider: 'greenhouse', tenant: 'globex' }], fetched: 1200, kept: 1000, outside_market: 200, saved: 1000 }, career_site: { status: 'none', saved: 0 }, adzuna: { status: 'ok', found: 50, this_company: 15, saved: 15 } },
        { company: 'Initech', saved: 0, boards: { status: 'none', saved: 0 }, career_site: { status: 'blocked', host: 'www.initech.example', url: 'https://www.initech.example/careers', saved: 0 }, adzuna: { status: 'ok', found: 50, this_company: 0, saved: 0 }, needs_browser: { url: 'https://www.initech.example/careers', host: 'www.initech.example', reason: 'blocked' } },
      ], needs_browser: [{ company: 'Initech', url: 'https://www.initech.example/careers', host: 'www.initech.example', reason: 'blocked' }] };
    } };
  };
  const { mgr, sp, store, acts } = setup({ fetchImpl });
  assert.equal((await mgr.companyJobs({ companies: [] })).code, 400);
  assert.equal((await mgr.companyJobs({ companies: ['Initech'], websites: { Initech: 'not a site' } })).code, 400);

  const r = await mgr.companyJobs({ companies: ['Globex', 'Initech', 'initech'], websites: { Initech: 'https://www.initech.example/careers' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.indeedRun.ok, true, 'the Indeed run starts before Seen answers');
  assert.equal((await mgr.companyJobs({ companies: ['Acme'] })).code, 409, 'one pull at a time');
  assert.equal(sp.calls.length, 1);
  const indeedEnv = sp.calls[0].opts.env;
  assert.deepEqual(JSON.parse(indeedEnv.INDEED_SEARCHES_JSON), [{ query: 'Globex', location: 'United States' }, { query: 'Initech', location: 'United States' }]);
  assert.equal(indeedEnv.INDEED_RESULTS_PER_SEARCH, '25');
  assert.equal(mgr.companyJobsStatus().running, true);

  release();
  await until(() => !mgr.companyJobsStatus().running);
  assert.deepEqual(sent[0].body, { companies: ['Globex', 'Initech'], site_limit: 40, websites: { Initech: 'initech.example' } });
  assert.match(sent[0].url, /\/api\/local-company-jobs$/);
  const st = mgr.companyJobsStatus().last;
  assert.equal(st.seen.saved, 1015);
  assert.equal(st.seen.results[0].boards.saved, 1000);
  assert.equal(st.seen.results[1].careerSite.status, 'blocked');
  assert.equal(st.careerRun.ok, true);
  const career = store.readRun(st.careerRun.id);
  assert.equal(career.status, 'queued', 'Chrome is busy with the Indeed run, so the career-site run waits');
  assert.deepEqual(career.config.targets, [{ company: 'Initech', url: 'https://www.initech.example/careers' }]);
  assert.ok(acts.some((e) => /company jobs: Seen saved 1015 listings for 2 companies; Indeed run started; 1 career site/.test(e.summary)));

  sp.calls[0].child.finish(0, { stdout: INDEED_OK });
  await until(() => sp.calls.length === 2);
  assert.match(sp.calls[1].args[0], /scripts\/collect-career-site\.mjs$/);
  assert.equal(sp.calls[1].opts.env.CAREER_SITE_TARGETS_JSON, JSON.stringify([{ company: 'Initech', url: 'https://www.initech.example/careers' }]));
  assert.equal(sp.calls[1].opts.env.GITHUB_TOKEN, undefined);
  sp.calls[1].child.finish(0, { stdout: '[collect] Initech: 2 job links on www.initech.example\n' + JSON.stringify({ ok: true, dry_run: false, targets: 1, pages_read: 3, postings_found: 2, saved: 2, sites: [{ company: 'Initech', start_url: 'https://www.initech.example/careers', links_found: 2, pages_read: 3, postings_found: 2, saved: 2, skipped: {}, errors: [] }] }, null, 2) });
  const done = await until(() => { const x = store.readRun(st.careerRun.id); return x && x.status === 'completed' && x; });
  assert.equal(done.metrics.saved, 2);
  assert.equal((await mgr.status()).pipelines.career_site.recent.value, 2, 'the overview counts jobs saved from career sites');
});

test('company job pull without Chrome sources: no runs start, and a failed Seen pull is reported, not hidden', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, async json() { return {}; } });
  const { mgr, sp } = setup({ fetchImpl });
  const r = await mgr.companyJobs({ companies: ['Initech'], indeed: false });
  assert.equal(r.ok, true);
  await until(() => !mgr.companyJobsStatus().running);
  const st = mgr.companyJobsStatus().last;
  assert.equal(sp.calls.length, 0);
  assert.equal(st.indeedRun, null);
  assert.match(st.seen.error, /needs its 2026-10-20 company-jobs deploy/);
  assert.match(st.careerRun.error, /Seen’s pull failed/);
});

test('company job pull: a pasted careers page is where Chrome starts; a company whose boards delivered gets no Chrome run', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, async json() {
    return { ok: true, saved: 990, results: [
      { company: 'Initech', saved: 0, boards: { status: 'none', saved: 0 }, career_site: { status: 'blocked', host: 'www.initech.example', url: 'https://www.initech.example/careers', saved: 0 }, adzuna: { status: 'ok', found: 50, this_company: 0, saved: 0 } },
      { company: 'Globex', saved: 990, boards: { status: 'ok', registered: 'existing', boards: [{ provider: 'greenhouse', tenant: 'globex' }], fetched: 1010, kept: 990, saved: 990 }, career_site: { status: 'none', saved: 0 }, adzuna: { status: 'ok', found: 50, this_company: 0, saved: 0 } },
    ], needs_browser: [{ company: 'Initech', url: 'https://www.initech.example/careers', host: 'www.initech.example', reason: 'blocked' }] };
  } });
  const { mgr, store, sp } = setup({ fetchImpl });
  const r = await mgr.companyJobs({ companies: ['Initech', 'Globex'], indeed: false,
    websites: { Initech: 'https://www.initech.example/careers/search/?site=US', Globex: 'https://www.globex.example/careers/jobs' } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.state.request.websites, { Initech: 'initech.example', Globex: 'globex.example' }, 'Seen’s server gets the host');
  await until(() => !mgr.companyJobsStatus().running);
  const st = mgr.companyJobsStatus().last;
  assert.equal(st.careerRun.ok, true, st.careerRun.error);
  assert.deepEqual(st.careerRun.targets, [{ company: 'Initech', url: 'https://www.initech.example/careers/search/?site=US' }], 'Chrome starts at the pasted page; Globex came from its boards');
  await until(() => sp.calls.length === 1);
  const env = sp.calls[0].opts.env;
  assert.equal(env.CAREER_SITE_TARGETS_JSON, JSON.stringify([{ company: 'Initech', url: 'https://www.initech.example/careers/search/?site=US' }]));
  assert.equal(env.CAREER_SITE_MAX_JOBS, '3000');
  const summary = { ok: true, dry_run: false, targets: 1, pages_read: 1, listed: 600, postings_found: 600, saved: 450,
    sites: [{ company: 'Initech', start_url: 'https://www.initech.example/careers/search/?site=US', method: 'page_scroll', detail: 'job_page', listed: 600, links_found: 25, pages_read: 1, postings_found: 600, no_data: 0, failed: 0, saved: 450, skipped: { outside_market: 150 }, errors: [], notes: ['/api/careers/state answered 403'] }] };
  sp.calls[0].child.finish(0, { stdout: '[harvest] Initech: 600 jobs listed (page_scroll)\n' + JSON.stringify(summary, null, 2) });
  const done = await until(() => { const x = store.readRun(st.careerRun.id); return x && x.status !== 'running' && x.status !== 'queued' && x; });
  assert.equal(done.status, 'completed', 'a feed that fell back to scrolling is a note, not a partial run');
  assert.equal(done.metrics.listed, 600);
  assert.deepEqual(done.metrics.methods, ['page_scroll']);
  assert.equal(done.diagnostics.perSite[0].notes[0], '/api/careers/state answered 403');
});
