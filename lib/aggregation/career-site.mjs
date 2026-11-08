// Career Sites (Chrome) adapter — drives Seen's local career-site collector
// (`scripts/collect-career-site.mjs`, Seen PR 2026-10-20). It reads a company's own career site through
// this Mac's Chrome (OpenCLI Browser Bridge) when the site's job pages need a full browser (for example,
// they are rendered client-side in JavaScript). The collector sends each page's own
// schema.org JobPosting data to Seen's /api/ingest-local-career-jobs, which applies every check itself
// (right employer, US/remote, not expired, quality gate).
//
// Like the other two adapters this only discovers what the checked-out script supports, validates a
// configuration, builds the script's documented environment and interprets its one JSON summary.
//
// Verified against Seen commit c07a5c3: env SEEN_LOCAL_INGEST_TOKEN / SEEN_LOCAL_INGEST_URL /
// CAREER_SITE_TARGETS_JSON ([{ company, url }], 1–10, https) / CAREER_SITE_LIMIT (1–60, default 20);
// flag --dry-run; prints `[collect] …` / `[postings] …` / `[skip] …` lines and one JSON summary
// { ok, dry_run, targets, pages_read, postings_found, saved, sites: [...] }.
// Since Seen 2026-10-20 (harvest): CAREER_SITE_MAX_JOBS (1–5000, default 3000) = jobs read INSIDE the open
// page (the site's own job list or scrolling, then each job's data by in-page fetch); each site reports
// method (tesla_feed | page_scroll | pages), detail, listed, no_data, failed and notes (fallbacks used).

import { probeSeenRepo, readSource, probeOpenCli, probeIngestAuth, safeEndpoint } from './probes.mjs';
import { classifyFailure, tallyFailures, parseTrailingJson, FAILURE_CATEGORIES } from './failures.mjs';

export const SCRIPT = 'scripts/collect-career-site.mjs';
const DEFAULT_INGEST = 'https://seen.example/api/ingest-local-indeed';
const LARGE_RUN_PAGES = 300;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function discoverCapabilities(source) {
  if (!source) return { found: false };
  const num = (re) => { const m = re.exec(source); return m ? Number(m[1]) : null; };
  return {
    found: true,
    limitMax: num(/Math\.min\((\d+), Math\.max\(1, Number\(process\.env\.CAREER_SITE_LIMIT/) ?? 60,
    limitDefault: num(/CAREER_SITE_LIMIT\) \|\| (\d+)/) ?? 20,
    maxTargets: num(/filter\(\(t\) => t\.company && t\.url\)\.slice\(0, (\d+)\)/) ?? 10,
    harvest: /CAREER_SITE_MAX_JOBS/.test(source),
    maxJobsMax: num(/Math\.min\((\d+), Math\.max\(1, Number\(process\.env\.CAREER_SITE_MAX_JOBS/) ?? null,
    maxJobsDefault: num(/CAREER_SITE_MAX_JOBS\) \|\| (\d+)/) ?? null,
    targetsList: /CAREER_SITE_TARGETS_JSON/.test(source),
    dryRun: /--dry-run/.test(source),
    // The navigator (Seen 2026-10-21): finds the job list itself (start page optional), uses the site's own
    // search + United States filter, pages through everything, and re-runs a partial site itself (2 passes).
    navigator: /CAREER_SITE_PASSES/.test(source),
    keywords: /keywords\?/.test(source),
    ...(() => { const m = /int\(process\.env\.CAREER_SITE_MAX_JOBS, (\d+), (\d+), (\d+)\)/.exec(source); return m ? { maxJobsMax: Number(m[2]), maxJobsDefault: Number(m[3]) } : {}; })(),
  };
}
// The navigator collector re-runs a partial site itself, so the manager must not add more runs on top.
export const retriesItself = (caps = {}) => !!caps.navigator;

export function defaults(caps = {}) {
  return { targets: [], limit: caps.limitDefault || 20, ...(caps.harvest ? { maxJobs: caps.maxJobsDefault || 3000 } : {}) };
}

// An https start page on a public host. Returns the normalized URL or null.
export function cleanStartUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 500 || CONTROL.test(s)) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
  u.hash = '';
  return u.toString();
}

export function validateConfig(input = {}, caps = {}) {
  const errors = [];
  const max = caps.maxTargets || 10;
  const raw = Array.isArray(input.targets) ? input.targets : [];
  if (!raw.length) errors.push('add at least one career site');
  if (raw.length > max) errors.push(`at most ${max} career sites per run`);
  const seen = new Set();
  const targets = raw.slice(0, max).map((t, i) => {
    const company = String(t?.company ?? '').trim();
    const rawUrl = String(t?.url ?? '').trim();
    const url = rawUrl ? cleanStartUrl(rawUrl) : null;
    const keywords = String(t?.keywords ?? '').replace(/\s+/g, ' ').trim();
    const website = String(t?.website ?? '').trim();
    if (!company) errors.push(`site ${i + 1}: company is empty`);
    else if (company.length > 120 || CONTROL.test(company)) errors.push(`site ${i + 1}: company must be a plain name up to 120 characters`);
    if (rawUrl && !url) errors.push(`site ${i + 1}: the start page must be an https address`);
    if (!rawUrl && !caps.navigator) errors.push(`site ${i + 1}: this Seen checkout needs a start page — git pull it to let Seen find the job list itself`);
    if (keywords && (keywords.length > 300 || CONTROL.test(keywords))) errors.push(`site ${i + 1}: keywords must be plain text up to 300 characters`);
    if (website && (website.length > 200 || CONTROL.test(website))) errors.push(`site ${i + 1}: website must be a plain address`);
    const key = `${url || company.toLowerCase()}|${keywords.toLowerCase()}`; // the same page with the same keywords is the same job list
    if (seen.has(key)) errors.push(`site ${i + 1} repeats an earlier site`);
    seen.add(key);
    return { company, url: url || '', ...(keywords ? { keywords } : {}), ...(website ? { website } : {}) };
  });
  const lmax = caps.limitMax || 60;
  let limit = caps.limitDefault || 20;
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n < 1 || n > lmax) errors.push(`job pages per site must be a whole number from 1 to ${lmax}`);
    else limit = n;
  }
  let maxJobs;
  if (caps.harvest) {
    const jmax = caps.maxJobsMax || 5000;
    maxJobs = caps.maxJobsDefault || 3000;
    if (input.maxJobs !== undefined && input.maxJobs !== null && input.maxJobs !== '') {
      const n = Number(input.maxJobs);
      if (!Number.isInteger(n) || n < 1 || n > jmax) errors.push(`jobs per site must be a whole number from 1 to ${jmax}`);
      else maxJobs = n;
    }
  }
  return { ok: errors.length === 0, errors, config: { targets, limit, ...(maxJobs ? { maxJobs } : {}) } };
}

// Each site: its start page plus up to `limit` job pages, opened one at a time in Chrome.
export function estimateWork(cfg) {
  const pages = cfg.targets.length * (1 + cfg.limit);
  // Tabs opened are what is slow and visible; harvested jobs are in-page fetches in one tab.
  return { sites: cfg.targets.length, maxPages: pages, maxDetailCalls: pages, maxHarvestJobs: cfg.maxJobs ? cfg.targets.length * cfg.maxJobs : 0, large: pages > LARGE_RUN_PAGES };
}

export function endpoint(env = process.env) {
  return safeEndpoint(env.SEEN_LOCAL_INGEST_URL, DEFAULT_INGEST);
}
export const ingestUrl = (base) => `${String(base).replace(/\/api\/ingest-local-indeed\/?$/, '')}/api/ingest-local-career-jobs`;

export function buildEnv(cfg, env = process.env) {
  const out = {
    SEEN_LOCAL_INGEST_TOKEN: String(env.SEEN_LOCAL_INGEST_TOKEN || ''),
    CAREER_SITE_TARGETS_JSON: JSON.stringify(cfg.targets.map((t) => ({ company: t.company, ...(t.url ? { url: t.url } : {}), ...(t.keywords ? { keywords: t.keywords } : {}), ...(t.website ? { website: t.website } : {}) }))),
    CAREER_SITE_LIMIT: String(cfg.limit),
  };
  if (cfg.maxJobs) out.CAREER_SITE_MAX_JOBS = String(cfg.maxJobs);
  if (String(env.SEEN_LOCAL_INGEST_URL || '').trim()) out.SEEN_LOCAL_INGEST_URL = endpoint(env) || '';
  return out;
}

export function command(cfg, env = process.env) {
  return { script: SCRIPT, args: [], env: buildEnv(cfg, env) };
}

// ---- interpretation ----------------------------------------------------------------------------
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const nOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function interpret({ code, signal, stdout, stderr, cancelled = false, timedOut = false }) {
  const m = parseTrailingJson(stdout);
  const ok = m && typeof m === 'object' && Array.isArray(m.sites);
  const stderrText = String(stderr || '').trim();
  const warnings = stderrText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('[skip]')).slice(-50);
  const fatal = code !== 0 ? (stderrText.split(/\r?\n/).filter((l) => /Error|failed|must|Set |Give |ENOENT/i.test(l)).slice(-1)[0] || stderrText.split(/\r?\n/).slice(-1)[0] || `exit ${code}${signal ? ` (${signal})` : ''}`) : null;

  const sites = ok ? m.sites.slice(0, 20).map((s) => ({
    company: String(s?.company || '').slice(0, 120), startUrl: String(s?.start_url || '').slice(0, 300),
    method: s?.method ? String(s.method).slice(0, 30) : null, detail: s?.detail ? String(s.detail).slice(0, 30) : null,
    listed: n0(s?.listed), noData: n0(s?.no_data), failed: n0(s?.failed),
    notes: (Array.isArray(s?.notes) ? s.notes : []).slice(0, 5).map((e) => String(e).slice(0, 200)),
    linksFound: n0(s?.links_found), pagesRead: n0(s?.pages_read ?? s?.pages_opened), postingsFound: n0(s?.postings_found), saved: n0(s?.saved),
    listingUrl: s?.listing_url ? String(s.listing_url).slice(0, 300) : null, siteTotal: nOrNull(s?.site_total), keywords: Array.isArray(s?.keywords) ? s.keywords.slice(0, 10).map(String) : [],
    complete: typeof s?.complete === 'boolean' ? s.complete : null, passes: nOrNull(s?.passes), listPages: nOrNull(s?.list_pages), duplicates: n0(s?.duplicates), outsideMarket: n0(s?.outside_market),
    missing: (Array.isArray(s?.missing) ? s.missing : []).slice(0, 5).map((e) => String(e).slice(0, 200)),
    filters: (Array.isArray(s?.filters) ? s.filters : []).slice(0, 10).map((f) => ({ term: f?.term || null, applied: (f?.applied || []).slice(0, 4).map((a) => `${a.what}: ${a.how}`.slice(0, 120)), missed: (f?.missed || []).slice(0, 4).map((x) => String(x).slice(0, 160)) })),
    skipped: Object.fromEntries(Object.entries(s?.skipped || {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 40), n0(v)])),
    errors: (Array.isArray(s?.errors) ? s.errors : []).slice(0, 5).map((e) => String(e).slice(0, 300)),
  })) : [];
  const skipped = {};
  for (const s of sites) for (const [k, v] of Object.entries(s.skipped)) skipped[k] = (skipped[k] || 0) + v;
  const metrics = ok ? {
    dryRun: m.dry_run === true, sites: nOrNull(m.targets), linksFound: sites.reduce((a, s) => a + s.linksFound, 0),
    pagesRead: nOrNull(m.pages_read), postingsFound: nOrNull(m.postings_found), saved: nOrNull(m.saved),
    listed: sites.reduce((a, s) => a + s.listed, 0), noData: sites.reduce((a, s) => a + s.noData, 0),
    methods: [...new Set(sites.map((s) => s.method).filter(Boolean))],
    skipped: Object.values(skipped).reduce((a, v) => a + v, 0),
    sitesFailed: sites.filter((s) => s.errors.length && s.pagesRead === 0).length,
    siteTotal: sites.some((s) => s.siteTotal != null) ? sites.reduce((a, s) => a + (s.siteTotal || 0), 0) : null,
    sitesIncomplete: sites.filter((s) => s.complete === false).length, duplicatesSkipped: sites.reduce((a, s) => a + s.duplicates, 0),
  } : { sitesFailed: null };
  const errorTexts = [...sites.flatMap((s) => s.errors), ...(fatal ? [fatal] : [])];
  const failureCategories = tallyFailures(errorTexts);

  let status; let reason = null;
  if (cancelled) { status = 'cancelled'; reason = 'cancelled by the operator — jobs already sent to Seen stay stored'; }
  else if (timedOut) { status = 'failed'; reason = 'the run exceeded Seen Command’s wall-clock limit and was stopped'; }
  else if (code !== 0 || !ok) {
    const cat = classifyFailure(fatal || stderrText);
    status = FAILURE_CATEGORIES[cat].blocking ? 'blocked' : 'failed';
    reason = `${FAILURE_CATEGORIES[cat].label}: ${String(fatal || 'no summary printed').slice(0, 220)}`;
  } else if (sites.length && sites.every((s) => s.pagesRead === 0 && s.postingsFound === 0)) {
    const b = failureCategories.find((f) => f.blocking);
    status = b ? 'blocked' : 'failed';
    reason = `no career site could be opened${b ? ` (${b.label})` : ''}`;
  } else if (sites.some((s) => s.complete === false)) {
    // The navigator already ran each partial site twice; what is still missing is named per site.
    status = 'partial';
    reason = sites.filter((s) => s.complete === false).map((s) => `${s.company}: ${s.missing.join('; ') || 'incomplete'}`).join(' · ').slice(0, 400);
  } else if (sites.some((s) => s.errors.length && s.complete !== true)) {
    status = 'partial';
    reason = `${sites.filter((s) => s.errors.length).length} of ${sites.length} sites had errors (pages skipped or the send to Seen failed)`;
  } else {
    status = 'completed';
    reason = metrics.postingsFound === 0
      ? (metrics.listed ? `completed — ${metrics.listed} jobs were listed but none carried job data (schema.org JobPosting) Seen can read` : 'completed — the pages opened but carried no job data (schema.org JobPosting) Seen can read')
      : null;
  }
  return {
    status, reason, metrics,
    diagnostics: {
      failureCategories, perSite: sites, skipped, warnings, fatal,
      note: 'Every posting is checked by Seen: it must name this company as the employer, be in the US or remote, not be expired, and pass the quality gate. Skipped counts are Seen’s reasons.',
    },
  };
}

// ---- readiness ---------------------------------------------------------------------------------
export async function readiness({ repoDir, env = process.env, deps = {} } = {}) {
  const checks = [];
  const repo = probeSeenRepo(repoDir, [SCRIPT]);
  checks.push({ id: 'repo', label: 'Seen checkout + career-site collector', blocking: true, ...repo,
    ...(repo.status === 'missing' && /lacks/.test(repo.detail || '') ? { fix: 'git pull the Seen checkout (the career-site collector landed on next-migration on 2026-10-20).' } : {}) });
  const caps = repo.status === 'ok' ? discoverCapabilities(readSource(repoDir, SCRIPT)) : { found: false };
  const token = String(env.SEEN_LOCAL_INGEST_TOKEN || '').trim();
  const base = endpoint(env);
  const auth = await (deps.probeIngestAuth || probeIngestAuth)({ url: base ? ingestUrl(base) : null, token, emptyBody: { company: '', items: [] } });
  checks.push({ id: 'ingest-auth', label: 'Seen ingest token (LOCAL_INDEED_INGEST_SECRET)', blocking: ['missing', 'unauthorized', 'not_deployed', 'invalid'].includes(auth.status), ...auth });
  const cli = await (deps.probeOpenCli || probeOpenCli)();
  checks.push({ id: 'opencli', label: 'OpenCLI + Chrome Browser Bridge', blocking: cli.status === 'missing' || cli.bridge === 'disconnected' || cli.status === 'broken', ...cli });
  checks.push({ id: 'experimental', label: 'Browser commands', blocking: false, informational: true, status: 'unknown',
    detail: 'New: the collector uses OpenCLI’s general browser commands (open / eval / close), not a site adapter. If the installed OpenCLI disagrees, the run reports its exact error.' });
  return { checks, caps, endpoint: base ? ingestUrl(base) : null, environment: 'local' };
}

export const adapter = {
  id: 'career_site',
  label: 'Career Sites (Chrome)',
  description: 'Reads company career sites that need a full browser, through the local Chrome Browser Bridge, and sends each page’s own job data to Seen’s checks.',
  environment: 'local',
  executes: 'Runs on this Mac (OpenCLI + Chrome); writes go to Seen’s /api/ingest-local-career-jobs.',
  resources: ['browser-bridge'],
  script: SCRIPT,
  cancellable: true,
  cancelNote: 'Safe: reading is plain browsing; jobs already sent to Seen stay stored.',
  discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness, retriesItself,
};
