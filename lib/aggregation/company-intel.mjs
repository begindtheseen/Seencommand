// Company Intelligence Collection adapter — drives the EXISTING Seen collector
// `scripts/collect-reddit-company-intel.mjs` (what `npm run ingest:reddit-intel` runs). The collector
// asks Seen which companies to target (/api/local-company-intel-targets — companies Seen ALREADY
// knows), searches Reddit through OpenCLI + the local Chrome Browser Bridge, keeps raw source-
// attributed excerpts (redacted, never AI-written), and imports them with `require_existing: true`
// so no company is ever created from a search.
//
// What this adapter deliberately does NOT expose: the manual `npm run ingest:company-intel` path.
// It posts hand-entered items WITHOUT require_existing, so an unknown company name would be created
// (api/ingest-local-company-intel.js → resolveOrCreateCompany). That violates the identity rule.
//
// Verified against Seen 16c2f7d / aa4af62 / b22c6a2 (2026-10-19): env SEEN_COMPANY_INTEL_INGEST_TOKEN,
// SEEN_COMPANY_INTEL_INGEST_URL, COMPANY_INTEL_COMPANY_LIMIT (1–100), COMPANY_INTEL_POSTS_PER_COMPANY
// (1–10), flag --dry-run; stdout "[collect] <company>: N raw excerpts" lines then ONE JSON summary;
// stderr "[skip] <company>: search failed: …" / "[skip] <company> post <id>: …".

import { probeSeenRepo, readSource, probeOpenCli, probeIngestAuth, probeIntelMigration, safeEndpoint } from './probes.mjs';
import { classifyFailure, tallyFailures, parseTrailingJson, FAILURE_CATEGORIES } from './failures.mjs';
import { redact } from './store.mjs';

export const SCRIPT = 'scripts/collect-reddit-company-intel.mjs';
const DEFAULT_ENDPOINT = 'https://seen.example/api/ingest-local-company-intel';
const LARGE_IMPORT_COMPANIES = 25;
export const MAX_COMPANIES = 100;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Same rule Seen's targets endpoint uses to deprioritize ATS board slugs: a lowercase, spaceless
// identifier is usually a board slug, not a verified employer display name.
export const isSlugLike = (name) => { const s = String(name || ''); return !!s && s === s.toLowerCase() && !/\s/.test(s) && /[a-z]/.test(s); };

export function discoverCapabilities(source) {
  if (!source) return { found: false };
  const pair = (env) => { const m = new RegExp(`Math\\.min\\((\\d+),\\s*Math\\.max\\(1,\\s*Number\\(process\\.env\\.${env}\\)\\s*\\|\\|\\s*(\\d+)\\)\\)`).exec(source); return m ? { max: Number(m[1]), def: Number(m[2]) } : null; };
  const companies = pair('COMPANY_INTEL_COMPANY_LIMIT');
  const posts = pair('COMPANY_INTEL_POSTS_PER_COMPANY');
  return {
    found: true,
    sources: /\['reddit',\s*'search'/.test(source) ? ['reddit'] : [],
    companyLimitMax: companies?.max ?? 100, companyLimitDefault: companies?.def ?? 10,
    postsPerCompanyMax: posts?.max ?? 10, postsPerCompanyDefault: posts?.def ?? 3,
    dryRun: /--dry-run/.test(source),
    explicitTargets: /COMPANY_INTEL_COMPANIES_JSON/.test(source), // Seen 2026-10-20+: a chosen company list (1–100)
    existingCompaniesOnly: /require_existing:\s*true/.test(source),
    relevanceFilter: /rankAndFilter/.test(source),
    redaction: /censorExcerpt/.test(source),
    keepsSourceUrl: /source_url/.test(source),
    noModelCalls: !/anthropic|openai|generativeai|groq|cerebras|\bllm\b|reason\(|claude/i.test(source),
    defaultEndpoint: (/SEEN_COMPANY_INTEL_INGEST_URL \|\| '([^']+)'/.exec(source) || [])[1] || DEFAULT_ENDPOINT,
  };
}

export function defaults(caps = {}) {
  return { mode: 'dry_run', companyLimit: Math.min(5, caps.companyLimitDefault || 10), postsPerCompany: caps.postsPerCompanyDefault || 3, companies: [] };
}

export function validateConfig(input = {}, caps = {}) {
  const errors = [];
  const mode = input.mode === undefined ? 'dry_run' : input.mode;
  if (!['dry_run', 'import'].includes(mode)) errors.push('mode must be dry_run or import');
  if (mode === 'dry_run' && caps.dryRun === false) errors.push('this collector has no --dry-run mode');
  const int = (v, lo, hi, name, fb) => {
    if (v === undefined || v === null || v === '') return fb;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number from ${lo} to ${hi}`); return fb; }
    return n;
  };
  let companyLimit = int(input.companyLimit, 1, caps.companyLimitMax || 100, 'companies per run', 5);
  const postsPerCompany = int(input.postsPerCompany, 1, caps.postsPerCompanyMax || 10, 'posts per company', caps.postsPerCompanyDefault || 3);
  for (const k of Object.keys(input)) if (!['mode', 'companyLimit', 'postsPerCompany', 'companies'].includes(k)) errors.push(`unsupported option: ${k} (the collector has no such setting)`);
  // A chosen company list (the picker). Empty = Seen chooses its most active companies. Names are only
  // a request: the import sends require_existing, so Seen rejects any name it does not already know.
  let companies = [];
  if (input.companies !== undefined && input.companies !== null) {
    if (!Array.isArray(input.companies)) errors.push('companies must be a list of names');
    else if (input.companies.length && caps.explicitTargets === false) errors.push('this collector cannot take a company list — git pull the Seen checkout (next-migration, 2026-10-20 or later)');
    else {
      const seen = new Set();
      for (const raw of input.companies) {
        const name = String(raw ?? '').trim();
        if (!name || name.length > 120 || CONTROL.test(name)) { errors.push(`company "${name.slice(0, 40)}" is not a plain name of 1–120 characters`); continue; }
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase()); companies.push(name);
      }
      if (companies.length > MAX_COMPANIES) errors.push(`choose at most ${MAX_COMPANIES} companies per run (${companies.length} chosen)`);
      if (companies.length) companyLimit = Math.min(companies.length, MAX_COMPANIES);
    }
  }
  return { ok: errors.length === 0, errors, config: { mode, companyLimit, postsPerCompany, companies } };
}

export function estimateWork(cfg) {
  return { companies: cfg.companyLimit, searchCalls: cfg.companyLimit, maxThreadReads: cfg.companyLimit * cfg.postsPerCompany,
    large: cfg.mode === 'import' && cfg.companyLimit > LARGE_IMPORT_COMPANIES };
}

export function endpoint(env = process.env, caps = {}) {
  return safeEndpoint(env.SEEN_COMPANY_INTEL_INGEST_URL, caps.defaultEndpoint || DEFAULT_ENDPOINT);
}
export const targetsUrl = (ingestUrl, limit) => `${String(ingestUrl).replace(/\/api\/ingest-local-company-intel\/?$/, '')}/api/local-company-intel-targets?limit=${limit}`;

export function command(cfg, env = process.env) {
  const out = {
    SEEN_COMPANY_INTEL_INGEST_TOKEN: String(env.SEEN_COMPANY_INTEL_INGEST_TOKEN || ''),
    COMPANY_INTEL_COMPANY_LIMIT: String(cfg.companyLimit),
    COMPANY_INTEL_POSTS_PER_COMPANY: String(cfg.postsPerCompany),
  };
  if ((cfg.companies || []).length) out.COMPANY_INTEL_COMPANIES_JSON = JSON.stringify(cfg.companies);
  // Pause between Reddit searches (the Seen collector defaults to 4 s, with one retry after a longer
  // pause, because Reddit throttles back-to-back searches). Passed through only as a whole number of
  // milliseconds, 0–60000 — an operator tuning knob, and 0 for tests.
  const gap = String(env.COMPANY_INTEL_SEARCH_GAP_MS ?? '').trim();
  if (/^\d{1,5}$/.test(gap) && Number(gap) <= 60000) out.COMPANY_INTEL_SEARCH_GAP_MS = gap;
  if (String(env.SEEN_COMPANY_INTEL_INGEST_URL || '').trim()) out.SEEN_COMPANY_INTEL_INGEST_URL = endpoint(env) || '';
  return { script: SCRIPT, args: cfg.mode === 'dry_run' ? ['--dry-run'] : [], env: out };
}

// ---- interpretation ----------------------------------------------------------------------------
export function parseProgress(stdout, stderr) {
  const perCompany = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\[collect\] (.+): (\d+) raw excerpts$/.exec(line.trim());
    if (m) perCompany.push({ company: m[1], excerpts: Number(m[2]), slugLike: isSlugLike(m[1]) });
  }
  // execFile errors are multi-line ("Command failed: opencli …" + the tool's stderr): the cause is on the
  // continuation lines, so each [skip] entry absorbs the following lines up to the next log line.
  const searchFailures = []; const threadFailures = []; let lastEntry = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const t = line.trim();
    let m = /^\[skip\] (.+?): search failed: (.*)$/.exec(t);
    if (m) { lastEntry = { company: m[1], error: m[2] }; searchFailures.push(lastEntry); continue; }
    m = /^\[skip\] (.+?) post ([A-Za-z0-9_]+): (.*)$/.exec(t);
    if (m) { lastEntry = { company: m[1], post: m[2], error: m[3] }; threadFailures.push(lastEntry); continue; }
    if (lastEntry && t && !/^(?:\[|Error|at )/.test(t)) lastEntry.error = `${lastEntry.error} ${t}`.slice(0, 600);
    else lastEntry = null;
  }
  for (const f of [...searchFailures, ...threadFailures]) f.error = redact(f.error).slice(0, 300);
  return { perCompany, searchFailures, threadFailures };
}

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function interpret({ code, signal, stdout, stderr, cancelled = false, timedOut = false, config: cfg = {} }) {
  const summary = parseTrailingJson(stdout);
  const progress = parseProgress(stdout, stderr);
  const stderrText = String(stderr || '').trim();
  const fatal = code !== 0 ? (stderrText.split(/\r?\n/).filter((l) => /Error|failed|Set |ENOENT/i.test(l) && !/^\[skip\]/.test(l.trim())).slice(-1)[0] || `exit ${code}${signal ? ` (${signal})` : ''}`) : null;
  const dry = summary ? summary.dry_run === true : cfg.mode === 'dry_run';
  const reasons = Array.isArray(summary?.rejection_reasons)
    ? summary.rejection_reasons.map((r) => String(r).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)).filter(Boolean).slice(0, 10)
    : null;
  const failedCompanies = new Set(progress.searchFailures.map((f) => f.company));
  const sourceQueried = progress.perCompany.length + failedCompanies.size;

  const metrics = {
    companiesTargeted: num(summary?.targets),
    sourcesQueried: summary || progress.perCompany.length ? ['reddit'] : [],
    companiesSearched: sourceQueried || null,
    excerptsCollected: num(summary?.collected) ?? (progress.perCompany.length ? progress.perCompany.reduce((a, c) => a + c.excerpts, 0) : null),
    // Dry runs send nothing — import counts are not zero, they do not exist.
    importedReports: dry ? null : num(summary?.imported_reports),
    commentary: dry ? null : num(summary?.commentary),
    duplicates: dry ? null : num(summary?.duplicates),
    rejected: dry ? null : num(summary?.rejected),
    accepted: dry || !summary ? null : (num(summary.imported_reports) || 0) + (num(summary.commentary) || 0),
    // Seen's distinct rejection reasons (collector 2026-10-20+). "unknown company: X" names the
    // companies Seen refused; older collectors report only the total, so this stays null for them.
    unmatchedIdentities: reasons ? reasons.filter((r) => /^unknown company: /i.test(r)).length : null,
    searchFailures: progress.searchFailures.length, threadFailures: progress.threadFailures.length,
    dryRun: dry,
  };
  const errorTexts = [...progress.searchFailures.map((f) => f.error), ...progress.threadFailures.map((f) => f.error), ...(fatal ? [fatal] : [])];
  const failureCategories = tallyFailures(errorTexts);

  let status; let reason = null;
  if (cancelled) { status = 'cancelled'; reason = dry ? 'cancelled — dry run, nothing was sent' : 'cancelled — any batch already imported stays (the registry dedupes a re-run)'; }
  else if (timedOut) { status = 'failed'; reason = 'the run exceeded Seen Command’s wall-clock limit and was stopped'; }
  else if (code !== 0 || !summary) {
    const cat = classifyFailure(fatal || stderrText);
    status = FAILURE_CATEGORIES[cat].blocking ? 'blocked' : 'failed';
    reason = `${FAILURE_CATEGORIES[cat].label}: ${String(fatal || 'no summary printed').slice(0, 220)}`;
    if (/ingest failed/i.test(fatal || '')) reason += ' — earlier batches may already be imported; the collector does not report them after a failed batch';
  } else if ((metrics.companiesTargeted || 0) > 0 && failedCompanies.size >= metrics.companiesTargeted) {
    const b = failureCategories.find((f) => f.blocking);
    status = b ? 'blocked' : 'failed'; reason = `every company search failed${b ? ` (${b.label})` : ''}`;
  } else if (progress.searchFailures.length || progress.threadFailures.length) {
    status = 'partial'; reason = `${failedCompanies.size} company search(es) and ${progress.threadFailures.length} thread read(s) failed`;
  } else {
    status = 'completed';
    reason = metrics.companiesTargeted === 0 ? 'Seen returned no target companies' : dry ? 'dry run — nothing was imported' : null;
  }
  const identities = progress.perCompany.filter((c) => c.slugLike).map((c) => ({ company: c.company, reason: 'ATS-style slug (lowercase, no spaces) — not a verified employer display name' }));
  return {
    status, reason, metrics,
    diagnostics: {
      failureCategories, perCompany: progress.perCompany.slice(0, 100),
      sourceFailures: [...progress.searchFailures.map((f) => ({ ...f, stage: 'search' })), ...progress.threadFailures.map((f) => ({ ...f, stage: 'thread' }))].slice(0, 100),
      identityReview: identities,
      duplicates: { source: null, database: metrics.duplicates, note: 'database = excerpts Seen already holds (company_intel_imports registry by source URL + excerpt hash). The collector also drops repeats inside a run before sending, but does not count them.' },
      rejectionReasons: reasons,
      unmatched: reasons
        ? { count: metrics.unmatchedIdentities, names: reasons.filter((r) => /^unknown company: /i.test(r)).map((r) => r.replace(/^unknown company: /i, '')), note: 'Companies Seen does not know. They are rejected, never created.' }
        : { count: null, note: 'Not reported by this collector version (git pull the Seen checkout). Unknown companies are rejected, never created.' },
      provenance: 'Raw public excerpts with their source URL; emails/phones/profanity masked; not summarized or rewritten. First-person hiring outcomes become low-trust imported reports; everything else stays under "What people are saying online".',
      fatal,
    },
  };
}

// ---- readiness ---------------------------------------------------------------------------------
export async function readiness({ repoDir, env = process.env, deps = {} } = {}) {
  const checks = [];
  const repo = probeSeenRepo(repoDir, [SCRIPT]);
  checks.push({ id: 'repo', label: 'Seen checkout + Reddit collector', blocking: true, ...repo });
  const caps = repo.status === 'ok' ? discoverCapabilities(readSource(repoDir, SCRIPT)) : { found: false };
  if (caps.found) {
    checks.push(caps.existingCompaniesOnly
      ? { id: 'identity', label: 'Existing companies only', blocking: false, status: 'ok', detail: 'Verified in the collector source: imports send require_existing:true, so Seen rejects unknown companies instead of creating them.' }
      : { id: 'identity', label: 'Existing companies only', blocking: true, modes: ['import'], status: 'broken', detail: 'This collector does not send require_existing:true — an import could create companies from search text.', fix: 'Update the Seen checkout; imports stay disabled until the guard is present.' });
    checks.push(caps.noModelCalls && caps.keepsSourceUrl
      ? { id: 'provenance', label: 'Source provenance', blocking: false, status: 'ok', detail: `Verified in the collector source: no model calls; every item carries its source URL${caps.redaction ? '; excerpts are redacted, not rewritten' : ''}.` }
      : { id: 'provenance', label: 'Source provenance', blocking: true, modes: ['import'], status: 'broken', detail: 'Could not verify that the collector keeps raw source text with its URL and makes no model calls.', fix: 'Inspect scripts/collect-reddit-company-intel.mjs before importing.' });
  }
  const token = String(env.SEEN_COMPANY_INTEL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  const auth = await (deps.probeIngestAuth || probeIngestAuth)({ url: ep, token, emptyBody: { items: [] } });
  checks.push({ id: 'ingest-auth', label: 'Seen ingest token (LOCAL_COMPANY_INTEL_INGEST_SECRET)', blocking: ['missing', 'unauthorized', 'not_deployed', 'invalid'].includes(auth.status), ...auth });
  const mig = await (deps.probeIntelMigration || probeIntelMigration)({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
  checks.push({ id: 'migration', label: `Migration ${mig.migration || '20261019160000_company_intel_imports.sql'}`, blocking: mig.status === 'missing', modes: ['import'], ...mig });
  checks.push({ id: 'remote-storage', label: 'Seen storage (Vercel Supabase env)', blocking: false, informational: true, status: 'unknown',
    detail: 'Not checkable without a real read of targets: a run reports "storage unavailable" (HTTP 503) explicitly if Vercel lacks SUPABASE_URL / SUPABASE_SERVICE_KEY.' });
  const cli = await (deps.probeOpenCli || probeOpenCli)();
  checks.push({ id: 'opencli', label: 'OpenCLI + Chrome Browser Bridge', blocking: cli.status === 'missing' || cli.bridge === 'disconnected' || cli.status === 'broken', ...cli });
  return { checks, caps, endpoint: ep, environment: 'local' };
}

// Preview the companies Seen would hand the collector (read-only GET on Seen's targets endpoint).
export async function previewTargets({ limit = 10, env = process.env, caps = {}, fetchImpl = fetch } = {}) {
  const token = String(env.SEEN_COMPANY_INTEL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  if (!token) return { ok: false, error: 'SEEN_COMPANY_INTEL_INGEST_TOKEN is not set (Settings → Aggregation).' };
  if (!ep) return { ok: false, error: 'The company-intel endpoint override is not an https URL.' };
  const n = Math.min(100, Math.max(1, Number(limit) || 10));
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetchImpl(targetsUrl(ep, n), { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: `Seen answered HTTP ${r.status}: ${redact(body.error || 'unknown error').slice(0, 160)}` };
    const companies = (Array.isArray(body.companies) ? body.companies : []).slice(0, n).map((c) => ({
      company: String(c.company || '').slice(0, 120), activeListings: num(c.active_listings), existingReports: num(c.existing_reports),
      slugLike: isSlugLike(c.company),
    }));
    return { ok: true, companies, scannedActiveCompanies: num(body.scanned_active_companies), fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Seen did not answer within 60s' : redact(e.message).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

// Every company Seen knows, with its counts (GET /api/local-company-intel-targets?catalog=1), for the
// company picker. Read-only. A count Seen did not send stays null — never shown as 0.
export const catalogUrl = (ingestUrl) => `${String(ingestUrl).replace(/\/api\/ingest-local-company-intel\/?$/, '')}/api/local-company-intel-targets?catalog=1`;
export async function fetchCatalog({ env = process.env, caps = {}, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  const token = String(env.SEEN_COMPANY_INTEL_INGEST_TOKEN || '').trim();
  const ep = endpoint(env, caps);
  if (!token) return { ok: false, error: 'SEEN_COMPANY_INTEL_INGEST_TOKEN is not set (Settings → Aggregation).' };
  if (!ep) return { ok: false, error: 'The company-intel endpoint override is not an https URL.' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(catalogUrl(ep), { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const body = await r.json().catch(() => ({}));
    if (r.status === 404) return { ok: false, status: 404, error: 'Seen does not serve the company catalog yet — it needs the 2026-10-20 deploy.' };
    if (!r.ok) return { ok: false, status: r.status, error: `Seen answered HTTP ${r.status}: ${redact(body.error || 'unknown error').slice(0, 160)}` };
    if (!Array.isArray(body.companies)) return { ok: false, error: 'Seen answered without a company list — it needs the 2026-10-20 deploy.' };
    const companies = body.companies.map((c) => ({
      company: String(c.company || '').slice(0, 120), activeListings: num(c.active_listings), applicantReports: num(c.applicant_reports ?? c.existing_reports),
      employeeReviews: num(c.employee_reviews), mentions: num(c.mentions), graded: c.graded === true, reportsNeeded: num(c.reports_needed), slugLike: isSlugLike(c.company),
    })).filter((c) => c.company);
    return { ok: true, companies, total: companies.length, employeeReviewCounts: body.employee_review_counts !== false, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Seen did not answer within ${Math.round(timeoutMs / 1000)}s` : redact(e.message).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

export const adapter = {
  id: 'company_intel',
  label: 'Company Intelligence',
  description: 'Collects raw, source-attributed public applicant experiences from Reddit for companies Seen already knows.',
  environment: 'local',
  executes: 'Runs on this Mac (OpenCLI + Chrome); targets come from and imports go to Seen’s local-company-intel endpoints.',
  resources: ['browser-bridge'],
  modes: ['dry_run', 'import'],
  script: SCRIPT,
  cancellable: true,
  cancelNote: 'Safe: collection is read-only browsing; an import batch already sent stays, and Seen’s registry dedupes a re-run.',
  discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness, previewTargets, fetchCatalog,
};
