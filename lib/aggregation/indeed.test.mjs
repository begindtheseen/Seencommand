import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCapabilities, validateConfig, estimateWork, buildEnv, command, interpret, readiness } from './indeed.mjs';
import { INDEED_SOURCE, fakeRepo, okProbes } from './testkit.mjs';

const caps = discoverCapabilities(INDEED_SOURCE);

test('capability discovery reads the checked-out CLI, not assumptions', () => {
  assert.equal(caps.found, true);
  assert.equal(caps.resultsPerSearchMax, 25);
  assert.equal(caps.resultsPerSearchDefault, 20);
  assert.equal(caps.pagination, true);
  assert.equal(caps.maxPagesMax, 100);
  assert.equal(caps.pageStep, 10);
  assert.equal(caps.detailConcurrencyMax, 1);
  assert.equal(caps.retryAttempts, 2);
  assert.equal(caps.structuredMetrics, true);
  assert.equal(caps.defaultEndpoint, 'https://seen.example/api/ingest-local-indeed');
  // An older CLI without pagination: max pages collapses to 1 and a request for more is rejected.
  const old = discoverCapabilities("const limit = parsePositiveInt(env.INDEED_RESULTS_PER_SEARCH, 'INDEED_RESULTS_PER_SEARCH', { fallback: 20, max: 25 });");
  assert.equal(old.pagination, false);
  assert.equal(validateConfig({ searches: [{ query: 'x' }], maxPages: 3 }, old).ok, false);
  assert.equal(discoverCapabilities(null).found, false);
});

test('configuration validation is strict and normalizes', () => {
  const ok = validateConfig({ searches: [{ query: ' data analyst ', location: '' }], resultsPerSearch: 25, maxPages: 3, maxSearches: 1 }, caps);
  assert.equal(ok.ok, true, ok.errors.join());
  assert.deepEqual(ok.config.searches, [{ query: 'data analyst', location: 'Remote' }]);
  const bad = validateConfig({ searches: [{ query: '' }, { query: 'a\nb' }, { query: 'x', location: 'L' }, { query: 'X', location: 'l' }], resultsPerSearch: 26, maxPages: 0, maxSearches: 9 }, caps);
  assert.equal(bad.ok, false);
  const text = bad.errors.join(' | ');
  assert.match(text, /query is empty/);
  assert.match(text, /control characters/);
  assert.match(text, /duplicates an earlier search/);
  assert.match(text, /results per search must be a whole number from 1 to 25/);
  assert.match(text, /max pages/);
  assert.match(text, /max searches/);
  assert.equal(validateConfig({ searches: [] }, caps).ok, false);
});

test('work estimate flags large runs and overlapping pages', () => {
  const { config } = validateConfig({ searches: Array.from({ length: 10 }, (_, i) => ({ query: `q${i}` })), resultsPerSearch: 25, maxPages: 3 }, caps);
  const e = estimateWork(config, caps);
  assert.equal(e.searchCalls, 30);
  assert.equal(e.maxDetailCalls, 10 * (25 + 20));
  assert.equal(e.large, true);
  assert.equal(e.overlappingPages, true);
  assert.equal(estimateWork(validateConfig({ searches: [{ query: 'a' }] }, caps).config, caps).large, false);
});

test('the CLI gets ONLY its documented environment — never the parent env', () => {
  const { config } = validateConfig({ searches: [{ query: 'pm', location: 'Remote' }], resultsPerSearch: 10, maxPages: 2, maxSearches: 1 }, caps);
  const env = buildEnv(config, { SEEN_LOCAL_INGEST_TOKEN: 'tok-123456', GITHUB_TOKEN: 'ghp_shouldnotleak', SUPABASE_SERVICE_KEY: 'svc' });
  assert.deepEqual(Object.keys(env).sort(), ['INDEED_DETAIL_CONCURRENCY', 'INDEED_MAX_PAGES', 'INDEED_MAX_SEARCHES', 'INDEED_RESULTS_PER_SEARCH', 'INDEED_SEARCHES_JSON', 'SEEN_LOCAL_INGEST_TOKEN']);
  assert.equal(env.INDEED_DETAIL_CONCURRENCY, '1');
  assert.deepEqual(JSON.parse(env.INDEED_SEARCHES_JSON), [{ query: 'pm', location: 'Remote' }]);
  const cmd = command(config, {});
  assert.equal(cmd.script, 'scripts/ingest-indeed-opencli.mjs');
  assert.deepEqual(cmd.args, []);
  // An endpoint override is honoured only when it is https (or plain http to this machine).
  assert.equal(buildEnv(config, { SEEN_LOCAL_INGEST_URL: 'http://evil.example/x' }).SEEN_LOCAL_INGEST_URL, '');
  assert.equal(buildEnv(config, { SEEN_LOCAL_INGEST_URL: 'https://preview.vercel.app/api/ingest-local-indeed' }).SEEN_LOCAL_INGEST_URL, 'https://preview.vercel.app/api/ingest-local-indeed');
});

const METRICS = { ok: true, searches_requested: 2, searches_attempted: 2, searches_successful: 2, searches_failed: 0, raw_search_hits: 40, unique_indeed_ids: 30, duplicate_search_hits: 10,
  detail_requests_attempted: 30, detail_requests_successful: 30, detail_requests_failed: 0, jobs_submitted: 28, jobs_inserted: null, jobs_updated: null, jobs_rejected: 2, jobs_deduplicated: 1, upserted: 27, errors: {}, lastErrors: {}, duration_ms: 1234 };

test('a clean run is completed and keeps unreported metrics null (never zero)', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify(METRICS, null, 2), stderr: '', caps });
  assert.equal(r.status, 'completed');
  assert.equal(r.metrics.written, 27);
  assert.equal(r.metrics.uniqueListings, 30);
  assert.equal(r.metrics.inserted, null);
  assert.equal(r.metrics.updated, null);
  assert.equal(r.diagnostics.duplicates.source, 10);
  assert.equal(r.diagnostics.duplicates.server, 1);
  assert.equal(r.diagnostics.duplicates.alreadyInDatabase, null);
});

test('partial detail failures are partial — never an unqualified success', () => {
  const m = { ...METRICS, detail_requests_successful: 27, detail_requests_failed: 3, errors: { detail: 3 }, lastErrors: { detail: 'OpenCLI returned non-JSON output for: opencli indeed job x' } };
  const stderr = 'Skipping Indeed job aaaaaaaaaaaaaaaa: OpenCLI returned non-JSON output\nSkipping Indeed job bbbbbbbbbbbbbbbb: timed out\nSkipping Indeed job cccccccccccccccc: timed out\n';
  const r = interpret({ code: 0, stdout: JSON.stringify(m), stderr, caps });
  assert.equal(r.status, 'partial');
  assert.equal(r.metrics.detailsFailed, 3);
  assert.equal(r.diagnostics.retryExhausted.details, 3);
  assert.equal(r.diagnostics.retryExhausted.attemptsPerCall, 2);
  const cats = Object.fromEntries(r.diagnostics.failureCategories.map((c) => [c.category, c.count]));
  assert.equal(cats.timeout, 2);
  assert.ok(cats.opencli_output >= 1);
});

test('a disconnected Browser Bridge that fails every search is BLOCKED with recovery steps', () => {
  const m = { ...METRICS, searches_successful: 0, searches_failed: 2, raw_search_hits: 0, unique_indeed_ids: 0, detail_requests_attempted: 0, detail_requests_successful: 0, jobs_submitted: 0, upserted: 0, lastErrors: { search: 'Browser Bridge extension is not connected' } };
  const stderr = 'Skipping search "a": Browser Bridge extension is not connected\nSkipping search "b": Browser Bridge extension is not connected\n';
  const r = interpret({ code: 0, stdout: JSON.stringify(m), stderr, caps });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /every search failed/);
  assert.equal(r.diagnostics.failureCategories[0].category, 'browser_bridge');
  assert.match(r.diagnostics.failureCategories[0].fix, /Chrome/);
});

test('a CLI that dies on a Seen batch reports what is known and says earlier batches may be stored', () => {
  const unauth = interpret({ code: 1, stdout: '', stderr: 'Skipping Indeed job aaaaaaaaaaaaaaaa: timed out\nError: Seen ingest failed (401): Unauthorized\n    at runIndeedImport', caps });
  assert.equal(unauth.status, 'blocked');
  assert.match(unauth.reason, /rejected the ingest token/);
  assert.match(unauth.reason, /may already be stored/);
  assert.equal(unauth.metrics.written, undefined);
  assert.equal(unauth.metrics.detailsFailed, 1);
  const storage = interpret({ code: 1, stdout: '', stderr: 'Error: Seen ingest failed (503): Job storage is unavailable.', caps });
  assert.equal(storage.status, 'blocked');
  assert.match(storage.reason, /Vercel Supabase env/);
  const config = interpret({ code: 1, stdout: '', stderr: 'Error: Set SEEN_LOCAL_INGEST_TOKEN to the Vercel LOCAL_INDEED_INGEST_SECRET.', caps });
  assert.equal(config.status, 'blocked');
  const cancelled = interpret({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', cancelled: true, caps });
  assert.equal(cancelled.status, 'cancelled');
});

test('readiness reports the real checks and blocks only on verified problems', async () => {
  const repoDir = fakeRepo();
  const ok = await readiness({ repoDir, env: { SEEN_LOCAL_INGEST_TOKEN: 'x' }, deps: okProbes });
  const by = Object.fromEntries(ok.checks.map((c) => [c.id, c]));
  assert.equal(by.repo.status, 'ok');
  assert.equal(by['ingest-auth'].status, 'ok');
  assert.equal(by['remote-storage'].informational, true);
  assert.equal(by.opencli.blocking, false);
  const bridgeDown = await readiness({ repoDir, env: {}, deps: { ...okProbes, probeOpenCli: async () => ({ installed: true, bridge: 'disconnected', status: 'broken', detail: 'no bridge' }) } });
  assert.equal(bridgeDown.checks.find((c) => c.id === 'opencli').blocking, true);
  const noRepo = await readiness({ repoDir: '/nonexistent/seen', env: {}, deps: okProbes });
  assert.equal(noRepo.checks.find((c) => c.id === 'repo').status, 'missing');
});

test('Seen presets are fetched with the Indeed token and cleaned (control characters dropped)', async () => {
  const { fetchPresets, presetsUrl } = await import('./indeed.mjs');
  let seen = null;
  const body = { maintenance: { week: 43, per_niche: 2, searches: [{ query: 'CNA', location: 'Houston, TX', niche: 'Healthcare entry level' }, { query: 'bad\u0007', location: 'x' }] },
    niches: [{ id: 'trades', label: 'Trades', searches: [{ query: 'Electrician', location: 'Phoenix, AZ' }] }, { id: '', label: 'x', searches: [] }],
    demand: { days: 90, searches: [{ query: 'Budtender', location: 'Tustin, California', searches: 4, avg_results: 10 }] }, thin: { below_results: 10, searches: [] } };
  const r = await fetchPresets({ env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async (url, o) => { seen = { url, auth: o.headers.Authorization }; return { ok: true, status: 200, async json() { return body; } }; } });
  assert.equal(seen.url, 'https://seen.example/api/local-indeed-presets');
  assert.equal(seen.auth, 'Bearer tok');
  assert.equal(r.ok, true);
  assert.deepEqual(r.maintenance.searches, [{ query: 'CNA', location: 'Houston, TX', niche: 'Healthcare entry level' }]);
  assert.equal(r.niches.length, 1);
  assert.deepEqual(r.demand.searches[0], { query: 'Budtender', location: 'Tustin, California', searches: 4, avgResults: 10 });
  const old = await fetchPresets({ env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async () => ({ ok: false, status: 404, async json() { return {}; } }) });
  assert.match(old.error, /needs the 2026-10-20 deploy/);
  assert.equal(presetsUrl('https://p.example/api/ingest-local-indeed'), 'https://p.example/api/local-indeed-presets');
});

test('employer-board pull: validates, posts to Seen with the ingest token, normalizes the counts', async () => {
  const { pullEmployerBoards, validateBoardPull, boardsUrl } = await import('./indeed.mjs');
  assert.equal(boardsUrl('https://p.example/api/ingest-local-indeed'), 'https://p.example/api/refresh-employer-boards');
  assert.equal(validateBoardPull({ companies: [] }).ok, false);
  assert.equal(validateBoardPull({ companies: Array.from({ length: 51 }, (_, i) => `C${i}`) }).ok, false);
  assert.equal(validateBoardPull({ limit: 401 }).ok, false);
  assert.deepEqual(validateBoardPull({ companies: ['Soylent', 'soylent', ' Acme\u0007 '] }).body, { companies: ['Soylent', 'Acme'] }, 'case-insensitive dedupe keeps the first spelling; control chars stripped');
  assert.deepEqual(validateBoardPull({}).body, { limit: 200 });

  let seen = null;
  const body = { boards: 3, synced: 2, failed: 1, fetched: 40, kept: 25, dropped_outside_market: 15, upserted: 24, by_provider: { greenhouse: { boards: 3, fetched: 40, kept: 25 } }, not_found: ['Acme'], out_of_time: false };
  const r = await pullEmployerBoards({ companies: ['Soylent', 'Acme'] }, { env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async (url, o) => { seen = { url, o }; return { ok: true, status: 200, async json() { return body; } }; } });
  assert.equal(seen.url, 'https://seen.example/api/refresh-employer-boards');
  assert.equal(seen.o.method, 'POST');
  assert.equal(seen.o.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.o.body), { companies: ['Soylent', 'Acme'] });
  assert.equal(r.ok, true);
  assert.equal(r.saved, 24);
  assert.equal(r.droppedOutsideMarket, 15);
  assert.deepEqual(r.notFound, ['Acme']);
  assert.deepEqual(r.byProvider.greenhouse, { boards: 3, fetched: 40, kept: 25 });

  const old = await pullEmployerBoards({}, { env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async () => ({ ok: false, status: 404, async json() { return {}; } }) });
  assert.match(old.error, /needs its 2026-10-20 boards deploy/);
  const noTok = await pullEmployerBoards({}, { env: {}, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.match(noTok.error, /SEEN_LOCAL_INGEST_TOKEN/);
  const bad = await pullEmployerBoards({ limit: 0 }, { env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' } });
  assert.equal(bad.code, 400);
});

test('company job pull: validated names and websites, cleaned reply, honest errors', async () => {
  const { pullCompanyJobs, validateCompanyJobs, cleanWebsite, companyJobsUrl } = await import('./indeed.mjs');
  assert.equal(companyJobsUrl('https://p.example/api/ingest-local-indeed'), 'https://p.example/api/local-company-jobs');
  assert.equal(cleanWebsite('https://www.BigHardware.com/careers'), 'bighardware.com');
  assert.equal(cleanWebsite('not a site'), null);
  assert.equal(cleanWebsite('localhost'), null);
  assert.equal(validateCompanyJobs({ companies: Array.from({ length: 11 }, (_, i) => `C${i}`) }).ok, false);
  assert.equal(validateCompanyJobs({ companies: ['A'], siteLimit: 151 }).ok, false);
  assert.deepEqual(validateCompanyJobs({ companies: ['Vandelay', 'vandelay'], websites: { vandelay: 'vandelay.example', Other: 'x.com' } }).body, { companies: ['Vandelay'], site_limit: 40, websites: { Vandelay: 'vandelay.example' } });

  const reply = { ok: true, saved: 15, results: [{ company: 'Big Hardware', saved: 15, boards: { status: 'none' }, career_site: { status: 'ok', host: 'careers.bighardware.com', read: 15, kept: 15, saved: 15, skipped: { expired: 2 }, note: '<b>x</b>' }, adzuna: { status: 'unavailable', note: 'Adzuna is not configured' } }],
    needs_browser: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers', reason: 'blocked' }, { company: 'Evil', url: 'javascript:alert(1)' }] };
  const r = await pullCompanyJobs({ companies: ['Big Hardware'] }, { env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async () => ({ ok: true, status: 200, async json() { return reply; } }) });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].careerSite.saved, 15);
  assert.deepEqual(r.results[0].careerSite.skipped, { expired: 2 });
  assert.equal(r.results[0].adzuna.status, 'unavailable');
  assert.deepEqual(r.needsBrowser.map((x) => x.company), ['Vandelay'], 'only https start pages reach the Chrome collector');
  const old = await pullCompanyJobs({ companies: ['A'] }, { env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async () => ({ ok: false, status: 404, async json() { return {}; } }) });
  assert.match(old.error, /company-jobs deploy/);
  const failed = await pullCompanyJobs({ companies: ['A'] }, { env: { SEEN_LOCAL_INGEST_TOKEN: 'tok' }, fetchImpl: async () => ({ ok: false, status: 401, async json() { return { error: 'Unauthorized' }; } }) });
  assert.match(failed.error, /HTTP 401: Unauthorized/);
});
