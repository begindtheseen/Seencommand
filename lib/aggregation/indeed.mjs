// Indeed Job Collection adapter — drives the EXISTING Seen CLI (`scripts/ingest-indeed-opencli.mjs`,
// what `npm run ingest:indeed` runs). It never scrapes, retries, dedupes or paginates by itself: the
// CLI owns OpenCLI + the Chrome Browser Bridge, its retry/backoff, its sequential detail extraction,
// and its structured metrics. This adapter only (1) discovers what the checked-out CLI supports,
// (2) validates a configuration against that, (3) builds the CLI's documented environment, and
// (4) interprets the CLI's own JSON metrics + stderr into an honest run status.
//
// Verified against Seen commit c7e2cd0 ("Harden Indeed ingestion diagnostics and deduplication"):
// env INDEED_SEARCHES_JSON / INDEED_RESULTS_PER_SEARCH (1–25) / INDEED_MAX_PAGES (1–100) /
// INDEED_MAX_SEARCHES / INDEED_DETAIL_CONCURRENCY (max 1) / SEEN_LOCAL_INGEST_TOKEN / SEEN_LOCAL_INGEST_URL;
// prints ONE JSON metrics object on success; throws (exit 1, no JSON) when a Seen ingest batch fails.

import { probeSeenRepo, readSource, probeOpenCli, probeIngestAuth, safeEndpoint } from './probes.mjs';
import { classifyFailure, tallyFailures, parseTrailingJson, FAILURE_CATEGORIES } from './failures.mjs';

export const SCRIPT = 'scripts/ingest-indeed-opencli.mjs';
const DEFAULT_ENDPOINT = 'https://seen.example/api/ingest-local-indeed';
const LARGE_RUN_DETAIL_CALLS = 300;
const CONTROL = /[\u0000-\u001f\u007f]/;

// ---- capability discovery (read the CLI that is actually checked out) --------------------------
export function discoverCapabilities(source) {
  if (!source) return { found: false };
  const num = (re) => { const m = re.exec(source); return m ? Number(m[1]) : null; };
  return {
    found: true,
    resultsPerSearchMax: num(/INDEED_RESULTS_PER_SEARCH'[^)]*max:\s*(\d+)/) ?? 25,
    resultsPerSearchDefault: num(/INDEED_RESULTS_PER_SEARCH'[^)]*fallback:\s*(\d+)/) ?? 20,
    pagination: /INDEED_MAX_PAGES/.test(source),
    maxPagesMax: num(/INDEED_MAX_PAGES'[^)]*max:\s*(\d+)/) ?? (/INDEED_MAX_PAGES/.test(source) ? 100 : 1),
    pageStep: num(/page \* (\d+)/) ?? 10,
    maxSearchesOption: /INDEED_MAX_SEARCHES/.test(source),
    detailConcurrencyMax: num(/INDEED_DETAIL_CONCURRENCY'[^)]*max:\s*(\d+)/) ?? 1,
    retryAttempts: num(/attempts\s*=\s*(\d+)/) ?? null,
    structuredMetrics: /detail_requests_failed/.test(source),
    externalIdPreserved: /externalId|external_id/.test(source) || /id: hit\.id/.test(source),
    defaultEndpoint: (/SEEN_LOCAL_INGEST_URL \|\| '([^']+)'/.exec(source) || [])[1] || DEFAULT_ENDPOINT,
  };
}

export function defaults(caps = {}) {
  return {
    searches: [{ query: 'software engineer', location: 'Remote' }],
    resultsPerSearch: caps.resultsPerSearchDefault || 20,
    maxPages: 1,
    maxSearches: null,
    presets: [],
  };
}

function cleanSearch(s, i, errors) {
  const query = String(s?.query ?? '').trim();
  const location = String(s?.location ?? '').trim() || 'Remote';
  if (!query) errors.push(`search ${i + 1}: query is empty`);
  else if (query.length > 160) errors.push(`search ${i + 1}: query is longer than 160 characters`);
  if (location.length > 120) errors.push(`search ${i + 1}: location is longer than 120 characters`);
  if (CONTROL.test(query) || CONTROL.test(location)) errors.push(`search ${i + 1}: control characters are not allowed`);
  return { query, location };
}

function intIn(v, lo, hi, name, errors, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number from ${lo} to ${hi}`); return fallback; }
  return n;
}

// Validate a configuration against what the checked-out CLI supports. Returns the normalized config.
export function validateConfig(input = {}, caps = {}) {
  const errors = [];
  const raw = Array.isArray(input.searches) ? input.searches : [];
  if (!raw.length) errors.push('add at least one search');
  if (raw.length > 200) errors.push('at most 200 searches per configuration');
  const searches = raw.slice(0, 200).map((s, i) => cleanSearch(s, i, errors));
  const seen = new Set();
  searches.forEach((s, i) => { const k = `${s.query.toLowerCase()}\n${s.location.toLowerCase()}`; if (seen.has(k)) errors.push(`search ${i + 1} duplicates an earlier search`); seen.add(k); });
  const resultsPerSearch = intIn(input.resultsPerSearch, 1, caps.resultsPerSearchMax || 25, 'results per search', errors, caps.resultsPerSearchDefault || 20);
  const pagesMax = caps.pagination === false ? 1 : (caps.maxPagesMax || 100);
  const maxPages = intIn(input.maxPages, 1, pagesMax, caps.pagination === false ? 'pages (this CLI has no pagination)' : 'max pages', errors, 1);
  let maxSearches = null;
  if (input.maxSearches !== undefined && input.maxSearches !== null && input.maxSearches !== '') {
    if (caps.maxSearchesOption === false) errors.push('this CLI has no INDEED_MAX_SEARCHES option');
    else maxSearches = intIn(input.maxSearches, 1, Math.max(1, searches.length), 'max searches', errors, null);
  }
  const presets = (Array.isArray(input.presets) ? input.presets : []).slice(0, 50).map((p, i) => {
    const name = String(p?.name || '').trim().slice(0, 60);
    if (!name || CONTROL.test(name)) errors.push(`preset ${i + 1}: needs a plain name`);
    const pe = [];
    const list = (Array.isArray(p?.searches) ? p.searches : []).slice(0, 200).map((s, j) => cleanSearch(s, j, pe));
    if (!list.length) pe.push('has no searches');
    pe.forEach((e) => errors.push(`preset "${name || i + 1}": ${e}`));
    return { name, searches: list };
  });
  return { ok: errors.length === 0, errors, config: { searches, resultsPerSearch, maxPages, maxSearches, presets } };
}

// Upper bound of Browser Bridge detail calls a configuration can cause (pages advance by `pageStep`,
// so with more than pageStep results per page consecutive pages OVERLAP; the CLI dedupes those).
export function estimateWork(cfg, caps = {}) {
  const step = caps.pageStep || 10;
  const n = Math.min(cfg.searches.length, cfg.maxSearches || Infinity);
  const perSearch = cfg.resultsPerSearch + step * Math.max(0, cfg.maxPages - 1);
  return { searches: n, searchCalls: n * cfg.maxPages, maxDetailCalls: n * perSearch, large: n * perSearch > LARGE_RUN_DETAIL_CALLS,
    overlappingPages: cfg.maxPages > 1 && cfg.resultsPerSearch > step };
}

export function endpoint(env = process.env, caps = {}) {
  return safeEndpoint(env.SEEN_LOCAL_INGEST_URL, caps.defaultEndpoint || DEFAULT_ENDPOINT);
}

// The CLI's documented environment — explicit keys only, never the whole parent environment.
export function buildEnv(cfg, env = process.env) {
  const out = {
    SEEN_LOCAL_INGEST_TOKEN: String(env.SEEN_LOCAL_INGEST_TOKEN || ''),
    INDEED_SEARCHES_JSON: JSON.stringify(cfg.searches.map((s) => ({ query: s.query, location: s.location }))),
    INDEED_RESULTS_PER_SEARCH: String(cfg.resultsPerSearch),
    INDEED_MAX_PAGES: String(cfg.maxPages),
    INDEED_DETAIL_CONCURRENCY: '1', // sequential: concurrent Browser Bridge calls are not verified safe
  };
  if (cfg.maxSearches) out.INDEED_MAX_SEARCHES = String(cfg.maxSearches);
  if (String(env.SEEN_LOCAL_INGEST_URL || '').trim()) out.SEEN_LOCAL_INGEST_URL = endpoint(env) || '';
  return out;
}

export function command(cfg, env = process.env) {
  return { script: SCRIPT, args: [], env: buildEnv(cfg, env) };
}

// ---- interpretation ----------------------------------------------------------------------------
const nOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// One entry per "Skipping …" warning. Node's execFile errors are MULTI-LINE ("Command failed: opencli …"
// then the tool's own stderr on the next lines), and the cause lives on those continuation lines — so a
// warning keeps every following line up to the next warning or the next non-indented log line.
export function warningLines(stderr) {
  const out = [];
  for (const raw of String(stderr || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (/^Skipping (?:search|Indeed job)\b/.test(l)) out.push(l);
    else if (out.length && l && !/^(?:Error|\[|at )/.test(l)) out[out.length - 1] = `${out[out.length - 1]} ${l}`.slice(0, 600);
  }
  return out;
}

export function interpret({ code, signal, stdout, stderr, cancelled = false, timedOut = false, caps = {} }) {
  const raw = parseTrailingJson(stdout);
  const warnings = warningLines(stderr);
  const searchWarnings = warnings.filter((w) => w.startsWith('Skipping search'));
  const detailWarnings = warnings.filter((w) => w.startsWith('Skipping Indeed job'));
  const stderrText = String(stderr || '').trim();
  const fatal = code !== 0 ? (stderrText.split(/\r?\n/).filter((l) => /Error|failed|must|Set |ENOENT/i.test(l)).slice(-1)[0] || stderrText.split(/\r?\n/).slice(-1)[0] || `exit ${code}${signal ? ` (${signal})` : ''}`) : null;

  const m = raw && typeof raw === 'object' ? raw : null;
  const metrics = m ? {
    searchesRequested: nOrNull(m.searches_requested), searchesAttempted: nOrNull(m.searches_attempted),
    searchesSuccessful: nOrNull(m.searches_successful), searchesFailed: nOrNull(m.searches_failed),
    rawSearchHits: nOrNull(m.raw_search_hits), uniqueListings: nOrNull(m.unique_indeed_ids),
    sourceDuplicates: nOrNull(m.duplicate_search_hits),
    detailsAttempted: nOrNull(m.detail_requests_attempted), detailsSucceeded: nOrNull(m.detail_requests_successful),
    detailsFailed: nOrNull(m.detail_requests_failed),
    accepted: nOrNull(m.jobs_submitted), rejected: nOrNull(m.jobs_rejected), serverDeduplicated: nOrNull(m.jobs_deduplicated),
    written: nOrNull(m.upserted), inserted: nOrNull(m.jobs_inserted), updated: nOrNull(m.jobs_updated),
    durationMs: nOrNull(m.duration_ms), detailConcurrency: nOrNull(m.detail_concurrency),
  } : {
    // The CLI died before printing metrics (a Seen batch failed, or config/launch failed). Only what
    // its stderr proves is known; everything else is unavailable, never zero.
    searchesFailed: searchWarnings.length || null, detailsFailed: detailWarnings.length || null,
  };
  // Each failure counted once: the per-item warnings when the CLI printed them, else its per-stage
  // lastErrors (which repeat the newest warning of that stage, so never both).
  const warned = new Set([...(searchWarnings.length ? ['search'] : []), ...(detailWarnings.length ? ['detail'] : [])]);
  const stageLast = Object.entries(m?.lastErrors || {}).filter(([stage]) => !warned.has(stage)).map(([, v]) => v);
  const errorTexts = [...warnings.map((w) => w.replace(/^Skipping (?:search "[^"]*"|Indeed job \S+):\s*/, '')), ...stageLast, ...(fatal ? [fatal] : [])];
  const failureCategories = tallyFailures(errorTexts);
  const stageErrors = m?.errors && typeof m.errors === 'object' ? m.errors : {};

  let status; let reason = null;
  if (cancelled) { status = 'cancelled'; reason = 'cancelled by the operator — listings already submitted in earlier batches stay stored'; }
  else if (timedOut) { status = 'failed'; reason = 'the run exceeded Seen Command’s wall-clock limit and was stopped'; }
  else if (code !== 0 || !m) {
    const cat = classifyFailure(fatal || stderrText);
    status = FAILURE_CATEGORIES[cat].blocking ? 'blocked' : 'failed';
    reason = `${FAILURE_CATEGORIES[cat].label}: ${String(fatal || 'no metrics printed').slice(0, 220)}`;
    if (/Seen ingest failed/i.test(fatal || '')) reason += ' — batches sent before this one may already be stored; the CLI does not report them after a failed batch';
  } else {
    const blockingCat = failureCategories.find((f) => f.blocking);
    const noSearch = (metrics.searchesAttempted || 0) > 0 && metrics.searchesSuccessful === 0;
    const noDetail = (metrics.detailsAttempted || 0) > 0 && metrics.detailsSucceeded === 0;
    if (noSearch || noDetail) {
      status = blockingCat ? 'blocked' : 'failed';
      reason = noSearch ? `every search failed${blockingCat ? ` (${blockingCat.label})` : ''}` : `every listing detail failed${blockingCat ? ` (${blockingCat.label})` : ''}`;
    } else if ((metrics.searchesFailed || 0) > 0 || (metrics.detailsFailed || 0) > 0) {
      status = 'partial';
      reason = `${metrics.searchesFailed || 0} search(es) and ${metrics.detailsFailed || 0} listing detail(s) failed after retries`;
    } else {
      status = 'completed';
      reason = metrics.uniqueListings === 0 ? 'completed — the searches returned no listings' : null;
    }
  }
  const retryAttempts = caps.retryAttempts ?? null;
  return {
    status, reason, metrics,
    diagnostics: {
      failureCategories, stageErrors,
      lastErrors: m?.lastErrors || {},
      retryExhausted: { searches: metrics.searchesFailed, details: metrics.detailsFailed, attemptsPerCall: retryAttempts,
        note: retryAttempts ? `each counted failure exhausted ${retryAttempts} attempts with backoff (the CLI's own retry)` : 'retry attempts per call not discovered from the CLI source' },
      duplicates: {
        source: metrics.sourceDuplicates ?? null,
        server: metrics.serverDeduplicated ?? null,
        alreadyInDatabase: null,
        note: 'source = the same Indeed job key seen again across searches/pages; server = rows Seen merged inside a batch. Seen does not report whether a written row was new or already stored (inserted/updated are null by design).',
      },
      warnings: warnings.slice(-50),
      fatal,
    },
  };
}

// ---- readiness ---------------------------------------------------------------------------------
export async function readiness({ repoDir, env = process.env, deps = {} } = {}) {
  const checks = [];
  const repo = probeSeenRepo(repoDir, [SCRIPT]);
  checks.push({ id: 'repo', label: 'Seen checkout + Indeed CLI', blocking: true, ...repo });
  const caps = repo.status === 'ok' ? discoverCapabilities(readSource(repoDir, SCRIPT)) : { found: false };
  if (repo.status === 'ok' && !caps.structuredMetrics) {
    checks.push({ id: 'cli-version', label: 'Structured metrics', blocking: false, status: 'degraded', detail: 'This checkout predates the structured-metrics CLI (c7e2cd0); results will be coarse.', fix: 'git pull the Seen checkout.' });
  }
  const token = String(env.SEEN_LOCAL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  const auth = await (deps.probeIngestAuth || probeIngestAuth)({ url: ep, token, emptyBody: { jobs: [] } });
  checks.push({ id: 'ingest-auth', label: 'Seen ingest token (LOCAL_INDEED_INGEST_SECRET)', blocking: ['missing', 'unauthorized', 'not_deployed', 'invalid'].includes(auth.status), ...auth });
  checks.push({ id: 'remote-storage', label: 'Seen job storage (Vercel Supabase env)', blocking: false, informational: true, status: 'unknown',
    detail: 'Not checkable without writing: the endpoint verifies storage only after accepting real rows. A run that hits it reports "storage unavailable" (HTTP 503) explicitly.' });
  const cli = await (deps.probeOpenCli || probeOpenCli)();
  checks.push({ id: 'opencli', label: 'OpenCLI + Chrome Browser Bridge', blocking: cli.status === 'missing' || cli.bridge === 'disconnected' || cli.status === 'broken', ...cli });
  return { checks, caps, endpoint: ep, environment: 'local' };
}

// Preset searches from Seen (GET /api/local-indeed-presets, same token as the ingest): this week's
// maintenance rotation (2 searches from each niche), the niche list the job-refresh cron keeps fresh,
// what users actually searched, and the thin subset. Read-only.
export const presetsUrl = (ingestUrl) => `${String(ingestUrl).replace(/\/api\/ingest-local-indeed\/?$/, '')}/api/local-indeed-presets`;
const cleanList = (list) => (Array.isArray(list) ? list : []).map((x) => ({ query: String(x?.query || '').slice(0, 160), location: String(x?.location || 'Remote').slice(0, 120), ...(x?.niche ? { niche: String(x.niche).slice(0, 60) } : {}), ...(Number.isFinite(Number(x?.searches)) ? { searches: Number(x.searches) } : {}), ...(Number.isFinite(Number(x?.avg_results)) ? { avgResults: Number(x.avg_results) } : {}) })).filter((x) => x.query && !CONTROL.test(x.query) && !CONTROL.test(x.location));
export async function fetchPresets({ env = process.env, caps = {}, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const token = String(env.SEEN_LOCAL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  if (!token) return { ok: false, error: 'SEEN_LOCAL_INGEST_TOKEN is not set (Settings → Aggregation).' };
  if (!ep) return { ok: false, error: 'The Indeed endpoint override is not an https URL.' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(presetsUrl(ep), { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const body = await r.json().catch(() => ({}));
    if (r.status === 404) return { ok: false, status: 404, error: 'Seen does not serve Indeed presets yet — it needs the 2026-10-20 deploy.' };
    if (!r.ok) return { ok: false, status: r.status, error: `Seen answered HTTP ${r.status}: ${String(body.error || 'unknown error').slice(0, 160)}` };
    return {
      ok: true, fetchedAt: new Date().toISOString(),
      maintenance: { week: Number(body.maintenance?.week) || null, perNiche: Number(body.maintenance?.per_niche) || null, searches: cleanList(body.maintenance?.searches) },
      niches: (Array.isArray(body.niches) ? body.niches : []).map((n) => ({ id: String(n?.id || '').slice(0, 60), label: String(n?.label || '').slice(0, 60), searches: cleanList(n?.searches) })).filter((n) => n.id && n.searches.length),
      demand: { days: Number(body.demand?.days) || null, searches: cleanList(body.demand?.searches), error: body.demand?.error ? String(body.demand.error).slice(0, 160) : null },
      thin: { belowResults: Number(body.thin?.below_results) || null, searches: cleanList(body.thin?.searches), error: body.thin?.error ? String(body.thin.error).slice(0, 160) : null },
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Seen did not answer within ${Math.round(timeoutMs / 1000)}s` : String(e.message || e).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

// Employer boards (Greenhouse/Lever/Ashby/…) that Seen has registered, pulled server-side by Seen's
// /api/refresh-employer-boards (Seen PR 2026-10-20). Same address and token as the Indeed import:
// it is one "local operator" secret. { companies: [..≤50] } pulls those companies' boards;
// { limit: 1..400 } pulls that many of the stalest boards. Seen keeps only US/remote openings.
export const boardsUrl = (ingestUrl) => `${String(ingestUrl).replace(/\/api\/ingest-local-indeed\/?$/, '')}/api/refresh-employer-boards`;
export const MAX_BOARD_COMPANIES = 50;
export const MAX_BOARD_LIMIT = 400;

export function validateBoardPull(input = {}) {
  if (input.companies !== undefined) {
    const list = Array.isArray(input.companies) ? input.companies : null;
    if (!list) return { ok: false, error: 'companies must be a list of names' };
    const byKey = new Map();
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
      if (n && !byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), n); // first spelling wins
    }
    const names = [...byKey.values()];
    if (!names.length || names.length > MAX_BOARD_COMPANIES) return { ok: false, error: `choose 1–${MAX_BOARD_COMPANIES} companies` };
    return { ok: true, body: { companies: names } };
  }
  const limit = input.limit === undefined ? 200 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOARD_LIMIT) return { ok: false, error: `limit must be 1–${MAX_BOARD_LIMIT}` };
  return { ok: true, body: { limit } };
}

export async function pullEmployerBoards(input = {}, { env = process.env, caps = {}, fetchImpl = fetch, timeoutMs = 300_000 } = {}) {
  const v = validateBoardPull(input);
  if (!v.ok) return { ok: false, code: 400, error: v.error };
  const token = String(env.SEEN_LOCAL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  if (!token) return { ok: false, error: 'SEEN_LOCAL_INGEST_TOKEN is not set (Settings → Aggregation).' };
  if (!ep) return { ok: false, error: 'The Indeed endpoint override is not an https URL.' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(boardsUrl(ep), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v.body), signal: ctl.signal });
    const b = await r.json().catch(() => ({}));
    if (r.status === 404) return { ok: false, status: 404, error: 'Seen does not have the employer-board pull yet — it needs its 2026-10-20 boards deploy.' };
    if (!r.ok) return { ok: false, status: r.status, error: `Seen answered HTTP ${r.status}: ${String(b.error || 'unknown error').slice(0, 160)}` };
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const byProvider = {};
    for (const [k, p] of Object.entries(b.by_provider || {})) byProvider[String(k).slice(0, 30)] = { boards: n(p?.boards), fetched: n(p?.fetched), kept: n(p?.kept) };
    return {
      ok: true, at: new Date().toISOString(), request: v.body,
      boards: n(b.boards), synced: n(b.synced), failed: n(b.failed), fetched: n(b.fetched), kept: n(b.kept),
      droppedOutsideMarket: n(b.dropped_outside_market), saved: n(b.upserted), byProvider,
      notFound: Array.isArray(b.not_found) ? b.not_found.map((x) => String(x).slice(0, 120)).slice(0, 50) : [],
      outOfTime: b.out_of_time === true,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Seen did not finish within ${Math.round(timeoutMs / 1000)}s` : String(e.message || e).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

// Company-first job pull (Seen /api/local-company-jobs, Seen PR 2026-10-20). For each named company Seen
// reads, server-side: its job boards (finding and registering them when it has none), its own career
// site (sitemap + schema.org job data), and Adzuna filtered to that employer. A career site that
// needs a full browser comes back in `needsBrowser` for the Chrome collector. Same address and token as
// the Indeed import. Indeed itself is not here — it is handled by the separate local Indeed collector.
export const companyJobsUrl = (ingestUrl) => `${String(ingestUrl).replace(/\/api\/ingest-local-indeed\/?$/, '')}/api/local-company-jobs`;
export const MAX_JOB_COMPANIES = 10;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

// "example.com", "https://www.example.com/careers" → "example.com"; anything else → null.
export function cleanWebsite(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 200 || CONTROL.test(s)) return null;
  let host; try { host = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname; } catch { return null; }
  host = host.replace(/^www\./i, '').toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

export function validateCompanyJobs(input = {}) {
  const list = Array.isArray(input.companies) ? input.companies : null;
  if (!list) return { ok: false, error: 'companies must be a list of names' };
  const byKey = new Map();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    if (n && !byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), n);
  }
  const companies = [...byKey.values()];
  if (!companies.length || companies.length > MAX_JOB_COMPANIES) return { ok: false, error: `choose 1–${MAX_JOB_COMPANIES} companies` };
  const siteLimit = input.siteLimit === undefined || input.siteLimit === null ? 40 : Number(input.siteLimit);
  if (!Number.isInteger(siteLimit) || siteLimit < 1 || siteLimit > 150) return { ok: false, error: 'career-site pages must be 1–150' };
  const websites = {};
  if (input.websites !== undefined) {
    if (!input.websites || typeof input.websites !== 'object' || Array.isArray(input.websites)) return { ok: false, error: 'websites must map a company to its website' };
    for (const [name, site] of Object.entries(input.websites)) {
      const co = companies.find((c) => c.toLowerCase() === String(name).trim().toLowerCase());
      if (!co) continue;
      const host = cleanWebsite(site);
      if (!host) return { ok: false, error: `the website for ${co} is not a web address` };
      websites[co] = host;
    }
  }
  return { ok: true, body: { companies, site_limit: siteLimit, ...(Object.keys(websites).length ? { websites } : {}) } };
}

const short = (v, n = 160) => (v == null ? null : String(v).slice(0, n));
const numOr = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
function cleanSkipped(o) { return Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 40), Number(v) || 0])); }
// Keep only the fields the dashboard shows; Seen's reply is data, never trusted as markup.
export function cleanCompanyReport(r = {}) {
  const b = r.boards || null; const c = r.career_site || null; const a = r.adzuna || null;
  return {
    company: short(r.company, 120), saved: Number(r.saved) || 0, skipped: short(r.skipped),
    boards: b && {
      status: short(b.status, 20), registered: short(b.registered, 20), note: short(b.note),
      boards: (Array.isArray(b.boards) ? b.boards : []).slice(0, 6).map((x) => ({ provider: short(x?.provider, 30), tenant: short(x?.tenant, 80), nameUnverified: x?.name_unverified === true })),
      fetched: numOr(b.fetched), kept: numOr(b.kept), outsideMarket: numOr(b.outside_market), saved: numOr(b.saved),
    },
    careerSite: c && {
      status: short(c.status, 20), host: short(c.host, 120), url: short(c.url, 300), note: short(c.note),
      listed: numOr(c.listed), read: numOr(c.read), kept: numOr(c.kept), skipped: cleanSkipped(c.skipped), saved: numOr(c.saved),
    },
    adzuna: a && { status: short(a.status, 20), note: short(a.note), found: numOr(a.found), thisCompany: numOr(a.this_company), saved: numOr(a.saved) },
  };
}

export async function pullCompanyJobs(input = {}, { env = process.env, caps = {}, fetchImpl = fetch, timeoutMs = 300_000 } = {}) {
  const v = validateCompanyJobs(input);
  if (!v.ok) return { ok: false, code: 400, error: v.error };
  const token = String(env.SEEN_LOCAL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  if (!token) return { ok: false, error: 'SEEN_LOCAL_INGEST_TOKEN is not set (Settings → Aggregation).' };
  if (!ep) return { ok: false, error: 'The Indeed endpoint override is not an https URL.' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(companyJobsUrl(ep), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v.body), signal: ctl.signal });
    const b = await r.json().catch(() => ({}));
    if (r.status === 404) return { ok: false, status: 404, error: 'Seen does not have the company job pull yet — it needs its 2026-10-20 company-jobs deploy.' };
    if (!r.ok) return { ok: false, status: r.status, error: `Seen answered HTTP ${r.status}: ${String(b.error || 'unknown error').slice(0, 160)}` };
    return {
      ok: true, at: new Date().toISOString(), request: v.body,
      results: (Array.isArray(b.results) ? b.results : []).slice(0, MAX_JOB_COMPANIES).map(cleanCompanyReport),
      saved: Number(b.saved) || 0,
      needsBrowser: (Array.isArray(b.needs_browser) ? b.needs_browser : []).slice(0, MAX_JOB_COMPANIES)
        .map((x) => ({ company: short(x?.company, 120), url: short(x?.url, 300), host: short(x?.host, 120), reason: short(x?.reason, 20) }))
        .filter((x) => x.company && /^https:\/\//i.test(x.url || '')),
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Seen did not finish within ${Math.round(timeoutMs / 1000)}s` : String(e.message || e).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

export const adapter = {
  id: 'indeed',
  label: 'Indeed Jobs',
  description: 'Discovers real Indeed listings through OpenCLI + the local Chrome Browser Bridge and imports them through Seen’s quality checks.',
  environment: 'local',
  executes: 'Runs on this Mac (OpenCLI + Chrome); writes go to Seen’s /api/ingest-local-indeed.',
  resources: ['browser-bridge'],
  script: SCRIPT,
  cancellable: true,
  cancelNote: 'Safe: extraction is read-only browsing; listings already submitted in earlier batches stay stored.',
  discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness, fetchPresets, pullEmployerBoards, pullCompanyJobs,
};
