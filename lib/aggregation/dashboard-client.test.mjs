// The dashboard's pure renderers, loaded exactly as the page loads them (the same file, in a vm with
// a bare `window` and no `document`, so the controller half stays inert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(import.meta.dirname, 'dashboard-client.js'), 'utf8');
const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(src, ctx);
const UI = ctx.window.AggUI;

const pipe = (id, label, extra = {}) => ({ id, label, state: 'ready', executes: 'runs here', recent: { value: null, commentary: null }, problems: [], actions: [], schedule: { enabled: false }, ...extra });

test('overview shows both pipelines as visually distinct cards with real state labels', () => {
  const html = UI.renderOverview({ checkedAt: '2026-10-20T06:00:00Z', sharedResource: 'one bridge', pipelines: {
    company_intel: pipe('company_intel', 'Company Intelligence', { state: 'blocked', problems: [{ label: 'Migration', detail: 'missing', blocking: true, status: 'missing' }], actions: ['Apply the migration (owner approval)'] }),
    indeed: pipe('indeed', 'Indeed Jobs', { state: 'partial', lastRun: { status: 'partial', endedAt: '2026-10-20T05:00:00Z', reason: '3 details failed' }, recent: { value: 0 } }),
  } });
  assert.match(html, /agg-card agg-ci/); assert.match(html, /agg-card agg-in/);
  assert.match(html, />Blocked</); assert.match(html, />Partially completed</);
  assert.match(html, /Outstanding problems/); assert.match(html, /What you need to do/);
  assert.match(html, /3 details failed/);
  assert.match(html, /<span>Recent imports<\/span><span>0 <small>/, 'a reported zero renders as 0');
});

test('unreported metrics render as an explained dash — never as 0', () => {
  const html = UI.indeedResults({ id: 'agg-indeed-20261020T060000Z-abcdef', pipeline: 'indeed', status: 'blocked', trigger: 'manual', metrics: { detailsFailed: 2 }, diagnostics: { duplicates: {}, failureCategories: [] } });
  assert.match(html, /class="agg-na" title="not reported — the CLI stopped before printing metrics">—/);
  assert.match(html, /Seen does not report the insert\/update split/);
  assert.doesNotMatch(html, /<b>0<\/b><span>Rows written/);
  const dry = UI.intelResults({ id: 'x', pipeline: 'company_intel', status: 'completed', trigger: 'manual', mode: 'dry_run', metrics: { dryRun: true, excerptsCollected: 4, importedReports: null }, diagnostics: { provenance: 'raw' } });
  assert.match(dry, /dry run — nothing was sent to Seen/);
});

test('collected text is escaped (a company name cannot inject markup)', () => {
  const html = UI.intelResults({ id: 'x', pipeline: 'company_intel', status: 'partial', trigger: 'manual', metrics: {}, diagnostics: { identityReview: [{ company: '<img src=x onerror=alert(1)>', reason: 'slug' }], perCompany: [] } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
});

test('health renders "unknown" as unverified, not missing; schedules explain the no-replay rule', () => {
  const h = UI.renderHealth({ checkedAt: '2026-10-20T06:00:00Z', seenRepoDir: '~/seen', pipelines: {
    company_intel: { status: 'degraded', modes: { dry_run: 'ready', import: 'degraded' }, endpoint: 'https://seenjobs.io/x', checks: [{ id: 'migration', label: 'Migration', status: 'unknown', blocking: false, modes: ['import'], detail: 'Not verified: no Supabase credentials' }] },
    indeed: { status: 'ready', modes: { run: 'ready' }, checks: [] },
  } }, { seenRepoDir: null });
  assert.match(h, /Not verified/); assert.match(h, /not verifiable from here, not missing/);
  const s = UI.renderSchedules({ company_intel: { enabled: false, frequency: 'daily', time: '06:00', weekday: 1 }, indeed: { enabled: true, frequency: 'weekly', time: '07:00', weekday: 2, nextRunAt: '2026-10-21T14:00:00Z' } }, {});
  assert.match(s, /skipped, not replayed/); assert.match(s, /Manual only/); assert.match(s, /Scheduled/);
});

test('history rows carry their pipeline colour and filters cover pipeline, status, source and dates', () => {
  const h = UI.renderHistory([{ id: 'agg-indeed-20261020T060000Z-abcdef', pipeline: 'indeed', status: 'completed', trigger: 'schedule', metrics: { written: 3, uniqueListings: 4, detailsFailed: 0 } }], {});
  for (const id of ['agg-f-pipe', 'agg-f-status', 'agg-f-source', 'agg-f-since', 'agg-f-until']) assert.match(h, new RegExp(`id="${id}"`));
  assert.match(h, /agg-tr agg-in/);
});

const presets = { ok: true, maintenance: { week: 43, perNiche: 2, searches: [{ query: 'CNA', location: 'Houston, TX' }, { query: 'Welder', location: 'Tulsa, OK' }] },
  niches: [{ id: 'trades', label: 'Trades', searches: [{ query: 'Welder', location: 'Tulsa, OK' }, { query: 'Electrician', location: 'Phoenix, AZ' }] }],
  demand: { days: 90, searches: [{ query: 'Budtender', location: 'Tustin, CA' }] }, thin: { belowResults: 10, searches: [] } };

test('Indeed sets combine without duplicates; removed rows stay out; your own searches are kept', () => {
  const sets = UI.indeedSets(presets, [{ name: 'Mine', searches: [{ query: 'Valet', location: 'Tustin, CA' }] }]);
  assert.deepEqual(Array.from(sets, (s) => s.key), ['maintenance', 'demand', 'thin', 'niche:trades', 'saved:Mine']);
  assert.equal(sets.find((s) => s.key === 'thin').disabled, true, 'an empty set cannot be picked');
  const ui = { picked: ['maintenance', 'niche:trades'], extra: [{ query: 'Forklift', location: 'Dallas, TX' }], removed: ['cna|houston, tx'] };
  const list = UI.buildIndeedSearches(ui, sets);
  assert.deepEqual(Array.from(list, (s) => s.query), ['Welder', 'Electrician', 'Forklift'], 'Welder once; CNA removed');
  assert.equal(list[2].from, 'added by you');
});

test('the Indeed tool renders steps, tappable sets, the search list and a start button that counts', () => {
  const cfg = { pipelines: { indeed: { config: { searches: [], resultsPerSearch: 20, maxPages: 1, maxSearches: null, presets: [] }, capabilities: { found: true, resultsPerSearchMax: 25, pageStep: 10 } } } };
  const status = { pipelines: { indeed: { state: 'ready' }, company_intel: { state: 'ready' } } };
  const html = UI.renderIndeed(cfg, status, null, null, presets, { picked: ['maintenance'], extra: [], removed: [], rps: 20, pages: 1 });
  assert.match(html, /Pick what to refresh/);
  assert.match(html, /data-agg-set="maintenance" aria-pressed="true"/);
  assert.match(html, /Searches in this run \(2\)/);
  assert.match(html, />Start — 2 searches</);
  assert.match(html, /Opens up to <b>40<\/b> Indeed listings/);
  assert.match(html, /agg-seg-b on[^>]*data-agg-depth="standard"/);
  const off = UI.renderIndeed(cfg, status, null, null, { ok: false, error: 'HTTP 404' }, { picked: [], extra: [], removed: [], rps: 20, pages: 1 });
  assert.match(off, /presets are unavailable \(HTTP 404\)/);
  assert.match(off, /Pick some searches first/);
});

const catalog = { ok: true, total: 5, employeeReviewCounts: true, companies: [
  { company: 'Globex', activeListings: 851, applicantReports: 11, employeeReviews: 45, graded: true, reportsNeeded: 0, slugLike: false },
  { company: 'Initech', activeListings: 190, applicantReports: 1, employeeReviews: 0, graded: false, reportsNeeded: 3.5, slugLike: false },
  { company: 'Wonka', activeListings: 102, applicantReports: 33, employeeReviews: 0, graded: true, reportsNeeded: 0, slugLike: false },
  { company: 'greenhouse-slug', activeListings: 900, applicantReports: 0, employeeReviews: 0, graded: false, reportsNeeded: 5, slugLike: true },
  { company: 'Tiny Co', activeListings: 2, applicantReports: 0, employeeReviews: 0, graded: false, reportsNeeded: 5, slugLike: false } ] };

test('quick picks: major = most open jobs, need a grade = jobs but no grade, least covered = 10+ jobs fewest reports; slugs never auto-picked', () => {
  assert.deepEqual(Array.from(UI.quickPick(catalog.companies, 'major', 2)), ['Globex', 'Initech']);
  assert.deepEqual(Array.from(UI.quickPick(catalog.companies, 'needs', 25)), ['Initech']);
  assert.deepEqual(Array.from(UI.quickPick(catalog.companies, 'least', 25)), ['Initech', 'Globex', 'Wonka']);
  assert.deepEqual(Array.from(UI.filterCatalog(catalog.companies, { q: 'onk', hideSlugs: true }), (c) => c.company), ['Wonka']);
  assert.equal(UI.filterCatalog(catalog.companies, { hideSlugs: false })[0].company, 'greenhouse-slug');
  assert.deepEqual(Array.from(UI.filterCatalog(catalog.companies, { hideSlugs: true, sort: 'fewest' }), (c) => c.company).slice(0, 2), ['Tiny Co', 'Initech'], 'fewest reports first');
});

test('the company tool shows every company with its counts, selection chips and an honest start label', () => {
  const cfg = { pipelines: { company_intel: { config: { mode: 'dry_run', companyLimit: 5, postsPerCompany: 3, companies: [] }, capabilities: { explicitTargets: true, postsPerCompanyMax: 10, companyLimitMax: 100 } } } };
  const status = { pipelines: { indeed: { state: 'ready' }, company_intel: { state: 'ready', modes: { dry_run: 'ready', import: 'ready' } } } };
  const html = UI.renderIntel(cfg, status, null, null, catalog, { picked: ['Globex', 'Wonka'], q: '', sort: 'jobs', hideSlugs: true, show: 50, mode: 'import', posts: 5, companyLimit: 5 });
  assert.match(html, /4 of 5 companies/);
  assert.match(html, /<span class="agg-cat-n">Globex<\/span><span>851<\/span><span>11<\/span><span>45<\/span>/);
  assert.match(html, /needs 3.5 more/);
  assert.match(html, /<b>2 selected<\/b>/);
  assert.match(html, />Import — 2 companies</);
  assert.match(html, /Reads up to <b>10<\/b> Reddit threads/);
  const none = UI.renderIntel(cfg, status, null, null, null, { picked: [], mode: 'dry_run', posts: 3, companyLimit: 5 });
  assert.match(none, /Loading every company Seen knows/);
  assert.match(none, />Preview — Seen picks 5</);
  const old = UI.renderIntel({ pipelines: { company_intel: { ...cfg.pipelines.company_intel, capabilities: { explicitTargets: false } } } }, status, null, null, catalog, { picked: [], mode: 'dry_run', posts: 3 });
  assert.match(old, /can’t take a company list yet — git pull/);
});

test('overview quick starts are one tap and say exactly what they run', () => {
  const status = { pipelines: { indeed: { state: 'ready' }, company_intel: { state: 'ready' } } };
  const q = UI.renderQuick(status, presets, catalog);
  assert.match(q, /Run this week’s Indeed maintenance/);
  assert.match(q, /2 searches · 2 from every niche/);
  assert.match(q, /Preview the top 10 major companies/);
  assert.match(q, /Globex, Initech, Wonka…/);
  assert.match(UI.renderQuick({ pipelines: { indeed: { state: 'blocked' }, company_intel: { state: 'ready' } } }, presets, catalog), /data-agg-quick="indeed-maintenance" disabled/);
  assert.equal(UI.lastRunSentence({ pipeline: 'indeed', metrics: { written: 412, searchesSuccessful: 26, searchesFailed: 0, detailsFailed: 0 } }), '412 listings written or refreshed from 26 searches');
});

test('employer boards card: buttons follow the selection and a running pull; the result reads as one sentence', () => {
  const idle = UI.renderBoards({ last: null }, []);
  assert.match(idle, /data-agg-boards="picked" disabled/);
  assert.match(idle, /data-agg-boards="stalest"(?! disabled)/);
  const picked = UI.renderBoards({}, ['Soylent', 'Acme']);
  assert.match(picked, /Pull boards for the 2 selected/);
  const busy = UI.renderBoards({ pulling: true }, ['Soylent']);
  assert.match(busy, /data-agg-boards="stalest" disabled/);
  assert.match(busy, /Pulling…/);
  const done = UI.renderBoards({ last: { at: '2026-10-20T12:00:00Z', request: { companies: ['Soylent'] }, boards: 1, synced: 1, saved: 24, droppedOutsideMarket: 15, notFound: ['Acme'] } }, []);
  assert.match(done, /1 chosen company: 1 of 1 boards answered · <b>24<\/b> US\/remote listings saved · 15 outside the US skipped/);
  assert.match(done, /No job board registered for: Acme/);
  const err = UI.renderBoards({ error: 'Seen answered HTTP 502' }, []);
  assert.match(err, /agg-out bad/);
});

test('company intel results list Seen\'s rejection reasons', () => {
  const html = UI.intelResults({ pipeline: 'company_intel', status: 'completed', metrics: { rejected: 2 }, diagnostics: { rejectionReasons: ['unknown company: Beta Inc'] } });
  assert.match(html, /Why Seen rejected items/);
  assert.match(html, /unknown company: Beta Inc/);
  assert.doesNotMatch(UI.intelResults({ pipeline: 'company_intel', status: 'completed', metrics: {}, diagnostics: {} }), /Why Seen rejected/);
});

test('company jobs: one name per line with an optional website; results say what each source did', () => {
  const p = UI.parseCompanyLines('Vandelay\n\nBig Hardware | bighardware.com\nvandelay\n');
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { companies: ['Vandelay', 'Big Hardware'], websites: { 'Big Hardware': 'bighardware.com' }, errors: [] });
  assert.match(UI.parseCompanyLines(Array.from({ length: 11 }, (_, i) => 'C' + i).join('\n')).errors[0], /Up to 10/);

  const status = { pipelines: { indeed: { state: 'running', activeRun: { id: 'agg-indeed-20261020T060000Z-abcdef', status: 'running', pipeline: 'indeed', metrics: null } }, career_site: { state: 'queued', activeRun: { id: 'agg-career_site-20261020T060000Z-abcdef', status: 'queued', waitingFor: 'browser-bridge' } } } };
  const st = { running: false, startedAt: '2026-10-20T06:00:00Z', request: { companies: ['Globex', 'Vandelay'], indeed: true, browser: true },
    indeedRun: { ok: true, id: 'agg-indeed-20261020T060000Z-abcdef', status: 'running' },
    careerRun: { ok: true, id: 'agg-career_site-20261020T060000Z-abcdef', status: 'queued' },
    seen: { ok: true, saved: 2775, results: [
      { company: 'Globex', saved: 2760, boards: { status: 'ok', registered: 'existing', boards: [{ provider: 'greenhouse', tenant: 'globex' }], fetched: 3100, kept: 2760, saved: 2760 }, careerSite: { status: 'none' }, adzuna: { status: 'ok', found: 50, thisCompany: 15, saved: 15 } },
      { company: 'Vandelay<script>', saved: 0, boards: { status: 'none' }, careerSite: { status: 'blocked', host: 'www.vandelay.example' }, adzuna: { status: 'unavailable', note: 'Adzuna is not configured' } },
    ], needsBrowser: [] } };
  const html = UI.renderCompanyJobsResult(st, status);
  assert.match(html, /Seen saved <b>2,775<\/b>/);
  assert.match(html, /greenhouse/);
  assert.match(html, /needs a full browser → Chrome/);
  assert.match(html, /no job board found/);
  assert.match(html, /Adzuna is not configured/);
  assert.match(html, /waiting for the Browser Bridge/);
  assert.doesNotMatch(html, /<script>/, 'Seen’s reply is escaped');

  const failed = UI.renderCompanyJobsResult({ ...st, seen: { ok: false, error: 'Seen answered HTTP 500' }, careerRun: { ok: false, error: 'not started: Seen’s pull failed' } }, status);
  assert.match(failed, /Seen’s pull failed: Seen answered HTTP 500/);
  assert.match(failed, /not started — not started: Seen’s pull failed/);

  const tab = UI.renderCompanyJobs(status, null, null, { text: 'Vandelay' }, ['A', 'B']);
  assert.match(tab, /Find jobs for 1 company/);
  assert.match(tab, /Use the 2 companies selected/);
  assert.match(UI.renderCompanyJobs(status, null, { running: true }, { text: 'Vandelay' }, []), /Pulling…<\/button>/);
});

test('career-site results say how each site was read and count jobs without data as such', () => {
  const run = { id: 'agg-career_site-20261020T080000Z-abcdef', pipeline: 'career_site', status: 'completed', trigger: 'manual',
    metrics: { sites: 1, listed: 2400, pagesRead: 1, postingsFound: 2390, saved: 1700, skipped: 690, noData: 10, sitesFailed: 0, methods: ['tesla_feed'] },
    diagnostics: { failureCategories: [], perSite: [{ company: 'Vandelay', startUrl: 'https://www.vandelay.example/careers/search/?site=US', method: 'tesla_feed', listed: 2400, postingsFound: 2390, noData: 10, saved: 1700, errors: [], notes: [] }], skipped: { outside_market: 690 } } };
  assert.equal(UI.lastRunSentence(run), '1,700 jobs saved from 2,400 jobs listed on 1 career site (the site’s own job feed)');
  const html = UI.careerResults(run);
  assert.match(html, /Jobs listed/); assert.match(html, /No job data/);
  assert.match(html, /the site’s own job feed · 2400 listed · 2390 with job data · 10 without/);
});

test('applicant reports: coverage counts only companies with open jobs; the fill queue is most-jobs-first under K', () => {
  const cos = [
    { company: 'Big Co', activeListings: 900, applicantReports: 2 }, { company: 'Mid Co', activeListings: 50, applicantReports: 12 },
    { company: 'Small Co', activeListings: 3, applicantReports: 0 }, { company: 'Gone Co', activeListings: 0, applicantReports: 40 },
    { company: 'bigslug', activeListings: 999, applicantReports: 0, slugLike: true }, { company: 'Unknown Co', activeListings: 10, applicantReports: null },
  ];
  const c = UI.coverage(cos, 10);
  assert.equal(c.companies, 4, 'no listings → not counted; unknown report count → not counted as 0');
  assert.equal(c.reports, 14);
  assert.equal(c.atK, 1); assert.equal(c.under, 3); assert.equal(c.none, 2);
  assert.equal(c.shortfall, 8 + 10 + 10);
  assert.deepEqual([...UI.thinnest(cos, 10, 5)], ['Big Co', 'Small Co'], 'unverified slugs are never auto-picked');
  const p = UI.parseNameLines('Umbrella\numbrella\n\n Hooli ');
  assert.deepEqual([...p.companies], ['Umbrella', 'Hooli']);
});

const arStatus = (extra = {}) => ({ pipelines: { applicant_reports: { id: 'applicant_reports', label: 'Applicant Reports', state: 'ready', modes: { dry_run: 'ready', import: 'ready' }, ...extra },
  indeed: { id: 'indeed', state: 'running', activeRun: { id: 'agg-indeed-1', status: 'running' } } } });
const arCfg = { pipelines: { applicant_reports: { config: {}, capabilities: { found: true, fillBelow: { min: 1, max: 10000 }, goal: { min: 0, max: 100000 }, years: { max: 10 }, minutesPerCompany: { max: 240 }, companyLimit: { max: 100 } } } } };

test('applicant reports tab: the ratio against the 5–10× goal, fill or name companies, “No cap”, and it never queues behind Chrome', () => {
  const catalog = { ok: true, total: 3, companies: [{ company: 'Big Co', activeListings: 900, applicantReports: 2 }, { company: 'Mid Co', activeListings: 50, applicantReports: 12 }] };
  const html = UI.renderReports(arCfg, arStatus(), null, null, catalog, { how: 'fill', fillBelow: 10, companyLimit: 25, mode: 'import', goal: 0, years: 5, minutes: 10 });
  assert.match(html, /<b>7×<\/b>/, '14 reports over 2 companies');
  assert.match(html, /goal: 5–10×/);
  assert.match(html, /Next up: Big Co/);
  assert.match(html, /aria-checked="true" data-agg-argoal="0"><b>No cap/);
  assert.match(html, /Collect and import — the 25 thinnest/);
  assert.doesNotMatch(html, /queues behind/, 'Indeed is running, but this collector does not use Chrome');
  const list = UI.renderReports(arCfg, arStatus(), null, null, catalog, { how: 'list', text: '', mode: 'dry_run', goal: 10 });
  assert.match(list, /Name some companies first/);
  assert.match(list, /Use the 1 with the most open jobs under 10 reports/);
});

test('applicant reports results: per-company new / found / already had / why it stopped; previews never show import counts', () => {
  const run = { id: 'agg-applicant_reports-20261020T130000Z-abcdef', pipeline: 'applicant_reports', status: 'partial', trigger: 'manual', mode: 'import',
    metrics: { dryRun: false, companiesDone: 2, accountsFound: 30, newReports: 25, published: 25, duplicates: 4, downgraded: 1, threadsRead: 80, failedSearches: 0, reachedGoal: 1, exhausted: 1, notReached: 1 },
    diagnostics: { perCompany: [{ company: 'Umbrella', newReports: 10, found: 12, duplicates: 2, stoppedBy: 'goal', companySubs: ['Umbrella'] }, { company: '<b>x</b>', newReports: 15, found: 18, duplicates: 2, stoppedBy: 'exhausted', companySubs: [] }], notReached: ['Wonka'], failureCategories: [] } };
  const html = UI.reportsResults(run);
  assert.match(html, /reached the goal/); assert.match(html, /no more to find/);
  assert.match(html, /Not reached before the run budget ran out.*Wonka/);
  assert.match(html, /r\/Umbrella/);
  assert.doesNotMatch(html, /<b>x<\/b>/, 'escaped');
  assert.match(UI.lastRunSentence(run), /^25 new applicant reports for 2 companies · 1 reached the goal · 1 had no more to find · 4 already in Seen · 1 not reached/);
  const dry = UI.reportsResults({ ...run, metrics: { ...run.metrics, dryRun: true, newReports: null }, diagnostics: { perCompany: [{ company: 'A', newReports: null, found: 3, duplicates: null, stoppedBy: 'goal' }] } });
  assert.match(dry, /preview — nothing was sent to Seen/);
});

test('applicant reports: the Sources step decides which collectors one press starts', () => {
  const archive = { found: true, sources: ['reddit'] }; const web = { found: true };
  assert.deepEqual(JSON.parse(JSON.stringify(UI.reportsPlan({ src: { reddit: true, google: false } }, archive, web))), { archive: ['reddit'], google: false });
  assert.deepEqual(JSON.parse(JSON.stringify(UI.reportsPlan({ src: { reddit: false, google: true } }, archive, web))), { archive: [], google: true });
  assert.equal(UI.reportsPlan({ src: { google: true } }, archive, { found: false }).google, false, 'no Google collector in the checkout → never started');
  assert.deepEqual([...UI.reportsPlan({}, { found: true }, web).archive], ['reddit'], 'an older checkout: Reddit only');
});

test('applicant reports tab: two sources (no Hacker News), the review-site note, Google settings, one button naming what runs', () => {
  const cfg = { pipelines: { applicant_reports: arCfg.pipelines.applicant_reports, web_reports: { config: {}, capabilities: { found: true, searchGapSeconds: { min: 10, max: 600 }, pagesPerCompany: { max: 200 } } } } };
  cfg.pipelines.applicant_reports = { config: {}, capabilities: { ...arCfg.pipelines.applicant_reports.capabilities, sources: ['reddit'] } };
  const st = arStatus(); st.pipelines.web_reports = { id: 'web_reports', state: 'ready', modes: {} };
  const html = UI.renderReports(cfg, st, null, null, null, { how: 'fill', fillBelow: 10, companyLimit: 25, mode: 'import', goal: 10, src: { reddit: true, google: true }, gap: 30 });
  assert.match(html, /data-agg-arsrc="reddit" checked/);
  assert.doesNotMatch(html, /data-agg-arsrc="hackernews"/, 'Hacker News is never offered (owner decision)');
  assert.match(html, /data-agg-arsrc="google" checked/);
  assert.match(html, /30 s between searches/);
  assert.match(html, /Not read: Hacker News \(not an applicant-review source\), Glassdoor, Indeed, LinkedIn/);
  assert.match(html, /never solved/);
  assert.match(html, /id="agg-ar-gap"/);
  assert.match(html, /Collect and import — the 25 thinnest · Reddit \+ Google/);
  const none = UI.renderReports(cfg, st, null, null, null, { how: 'fill', mode: 'import', goal: 10, src: { reddit: false, google: false } });
  assert.match(none, /id="agg-ar-go" disabled title="Tick at least one source"/);
});

test('a Google run that hit a CAPTCHA says so in its sentence and results', () => {
  const run = { id: 'agg-web_reports-20261020T130000Z-abcdef', pipeline: 'web_reports', status: 'partial', trigger: 'manual', mode: 'import',
    metrics: { dryRun: false, companiesDone: 3, accountsFound: 4, newReports: 4, published: 4, duplicates: 0, googleBlocked: true, bySource: { google: { found: 4, newReports: 4 } }, threadsRead: 2 },
    diagnostics: { perCompany: [{ company: 'Hooli', newReports: 0, found: 0, duplicates: 0, stoppedBy: 'google_blocked' }], failureCategories: [] } };
  assert.match(UI.lastRunSentence(run), /4 new applicant reports for 3 companies.*Google asked for a CAPTCHA and was stopped/);
  const html = UI.reportsResults(run);
  assert.match(html, /Google CAPTCHA — stopped/);
  assert.match(html, /Pages read/);
  assert.match(html, /never solved/);
});
