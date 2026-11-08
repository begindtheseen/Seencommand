// The ONE adapter shape for Seen's applicant-report collectors. They share Seen's run loop
// (lib/reports/collectorRun.js), its summary JSON and its env grammar `<PREFIX>_<SETTING>`:
//   • applicant_reports → scripts/collect-archive-reports.mjs (ARCHIVE_REPORTS_*: the Reddit archive,
//     plain Node, no browser) — lib/aggregation/applicant-reports.mjs
//   • web_reports       → scripts/collect-web-reports.mjs (WEB_REPORTS_*: Google in this Mac's Chrome, takes
//     the Browser Bridge) — lib/aggregation/web-reports.mjs
// A spec names what differs (script, prefix, extra numeric settings, an optional source list, resources,
// readiness probes, wording); everything else — capability discovery from the script's own
// `int(process.env.X, lo, hi, default)` bounds, validation, the exact env, the honest reading of the
// summary — lives here once.
//
// Summary contract (collectorRun.js): { ok, dry_run, goal, sources, targets, found, imported_reports,
// published_reports, downgraded, duplicates, rejected, ingest_error, stopped_early, not_reached,
// rejection_reasons, companies: [{ company, found, imported, published, duplicates, downgraded, rejected,
// threads_read, searches, failed_searches, search_errors, company_subs, stopped_by, by_source, error }] }.

import { probeSeenRepo, readSource, readDirectImports, probeIngestAuth, probeIntelMigration, safeEndpoint } from './probes.mjs';
import { classifyFailure, tallyFailures, parseTrailingJson, FAILURE_CATEGORIES } from './failures.mjs';
import { redact } from './store.mjs';

const DEFAULT_ENDPOINT = 'https://seen.example/api/ingest-local-company-intel';
const CONTROL = /[\u0000-\u001f\u007f]/;
const LARGE_IMPORT_COMPANIES = 50;
// The collector stops itself cleanly before Seen Command's 4-hour wall clock would kill it.
export const RUN_BUDGET_MINUTES = 230;
const nOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const STOPPED = { goal: 'reached the goal', exhausted: 'read every source', time: 'out of time', unsearchable_name: 'name too short to search', error: 'error', google_blocked: 'Google asked for a CAPTCHA (stopped)' };

/**
 * spec = { id, label, description, executes, script, prefix, resources, minutesDefault, excludeSources?,
 *   extras: [{ key, env, label, fallback }], sources?: { all: [...], label: {id: text} },
 *   readinessExtra?: async ({ env, deps, caps }) => checks[], failedSearchWord, provenance, cancelNote }
 */
// A real model client in source: an API host or an SDK import (not the word in a comment).
const MODEL_CLIENT_RE = /api\.anthropic\.com|@anthropic-ai\/|api\.openai\.com|from\s+['"]openai['"]|generativelanguage\.googleapis\.com|api\.groq\.com|api\.cerebras\.ai/i;

export function createReportsAdapter(spec) {
  const P = spec.prefix;
  const extras = spec.extras || [];
  function bounds(source) {
    const out = {};
    const re = new RegExp(`int\\(process\\.env\\.(${P}_\\w+), (\\d+), (\\d+), (\\w+)\\)`, 'g');
    for (const m of source.matchAll(re)) out[m[1]] = { min: Number(m[2]), max: Number(m[3]), def: m[4] === 'null' ? null : Number(m[4]) };
    return out;
  }
  // `imports` = the script's direct relative imports ([{ path, source }], probes.readDirectImports). Evidence a
  // collector keeps each link / redacts may live in a module it imports; "no model calls" stays strict on the
  // script's own text and, for its imports, looks for a real model client (an API host, an SDK, Seen's llm
  // module) rather than words in comments.
  function discoverCapabilities(source, imports = []) {
    if (!source) return { found: false };
    const all = [source, ...imports.map((x) => x.source || '')].join('\n');
    const importCallsModel = imports.some((x) => /(^|\/)(llm|anthropic|openai)[^/]*$/i.test(x.path || '') || MODEL_CLIENT_RE.test(x.source || ''));
    const b = bounds(source);
    const g = (k, f) => b[`${P}_${k}`] || f;
    const caps = {
      found: true,
      goal: g('GOAL', { min: 0, max: 100000, def: 10 }),
      minutesPerCompany: g('MINUTES_PER_COMPANY', { min: 1, max: 240, def: spec.minutesDefault || 20 }),
      companyLimit: g('COMPANY_LIMIT', { min: 1, max: 100, def: 10 }),
      fillBelow: b[`${P}_BELOW`] ? { min: b[`${P}_BELOW`].min, max: b[`${P}_BELOW`].max } : null,
      runBudget: !!b[`${P}_TOTAL_MINUTES`],
      maxCompanies: Number((/must name 1–(\d+) companies/.exec(source) || [])[1]) || 500,
      goalCountsNew: /new_reports|runCollection/.test(source),
      dryRun: /--dry-run/.test(source),
      existingCompaniesOnly: /require_existing:\s*true/.test(source),
      keepsSourceUrl: /source_url/.test(all),
      redaction: /censorExcerpt/.test(all),
      noModelCalls: !/anthropic|openai|generativeai|groq|cerebras|\bllm\b|claude/i.test(source) && !importCallsModel,
      defaultEndpoint: (/SEEN_COMPANY_INTEL_INGEST_URL \|\| '([^']+)'/.exec(source) || [])[1] || DEFAULT_ENDPOINT,
    };
    for (const x of extras) caps[x.key] = g(x.env, x.fallback);
    if (spec.sources) {
      const m = /const SOURCE_IDS = \[([^\]]*)\]/.exec(source);
      const found = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null; // null = this checkout has one fixed source
      // A source the owner ruled out is never offered, even by an older Seen checkout that still has it.
      caps.sources = found ? found.filter((x) => !(spec.excludeSources || []).includes(x)) : null;
    }
    return caps;
  }
  function defaults(caps = {}) {
    const d = { mode: 'dry_run', companies: [], companyLimit: 25, fillBelow: caps.fillBelow ? 10 : 0, goal: caps.goal?.def ?? 10, minutesPerCompany: Math.min(spec.minutesDefault || 10, caps.minutesPerCompany?.max || 240) };
    for (const x of extras) d[x.key] = caps[x.key]?.def ?? x.fallback.def;
    if (spec.sources && caps.sources) d.sources = caps.sources.slice();
    return d;
  }
  function validateConfig(input = {}, caps = {}) {
    const errors = [];
    const allowed = ['mode', 'companies', 'companyLimit', 'fillBelow', 'goal', 'minutesPerCompany', ...extras.map((x) => x.key), ...(spec.sources ? ['sources'] : [])];
    for (const k of Object.keys(input)) if (!allowed.includes(k)) errors.push(`unsupported option: ${k} (the collector has no such setting)`);
    const mode = input.mode === undefined ? 'dry_run' : input.mode;
    if (!['dry_run', 'import'].includes(mode)) errors.push('mode must be dry_run or import');
    if (mode === 'dry_run' && caps.dryRun === false) errors.push('this collector has no --dry-run mode');
    const int = (v, b, name, fb) => {
      if (v === undefined || v === null || v === '') return fb;
      const n = Number(v);
      if (!Number.isInteger(n) || n < b.min || n > b.max) { errors.push(`${name} must be a whole number from ${b.min} to ${b.max}`); return fb; }
      return n;
    };
    const d = defaults(caps);
    const cfg = { mode };
    cfg.goal = int(input.goal, caps.goal || { min: 0, max: 100000 }, 'new reports per company (0 = no cap)', d.goal);
    cfg.minutesPerCompany = int(input.minutesPerCompany, caps.minutesPerCompany || { min: 1, max: 240 }, 'minutes per company', d.minutesPerCompany);
    cfg.companyLimit = int(input.companyLimit, caps.companyLimit || { min: 1, max: 100 }, 'companies Seen picks', d.companyLimit);
    for (const x of extras) cfg[x.key] = int(input[x.key], caps[x.key] || x.fallback, x.label, d[x.key]);
    cfg.fillBelow = 0;
    if (input.fillBelow !== undefined && input.fillBelow !== null && input.fillBelow !== '' && Number(input.fillBelow) !== 0) {
      if (!caps.fillBelow) errors.push('this collector cannot fill companies below a report count — git pull the Seen checkout (next-migration, 2026-10-20 or later)');
      else cfg.fillBelow = int(input.fillBelow, caps.fillBelow, 'fill companies under this many reports', 0);
    }
    cfg.companies = [];
    if (input.companies !== undefined && input.companies !== null) {
      if (!Array.isArray(input.companies)) errors.push('companies must be a list of names');
      else {
        const seen = new Set();
        for (const raw of input.companies) {
          const name = String(raw ?? '').trim();
          if (!name || name.length > 120 || CONTROL.test(name)) { errors.push(`company "${name.slice(0, 40)}" is not a plain name of 1–120 characters`); continue; }
          if (seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase()); cfg.companies.push(name);
        }
        const max = caps.maxCompanies || 500;
        if (cfg.companies.length > max) errors.push(`choose at most ${max} companies per run (${cfg.companies.length} chosen)`);
      }
    }
    if (spec.sources) {
      const avail = caps.sources || null;
      if (input.sources === undefined || input.sources === null) cfg.sources = avail ? avail.slice() : null;
      else if (!Array.isArray(input.sources) || !input.sources.length) errors.push('choose at least one source');
      else if (!avail) errors.push('this collector cannot choose sources — git pull the Seen checkout (next-migration, 2026-10-20 or later)');
      else {
        const bad = input.sources.filter((x) => !avail.includes(x));
        if (bad.length) errors.push(`unknown source: ${bad.join(', ')} (this collector has ${avail.join(', ')})`);
        cfg.sources = avail.filter((x) => input.sources.includes(x)); // the collector's own order
      }
    }
    return { ok: errors.length === 0, errors, config: cfg };
  }
  function estimateWork(cfg) {
    const companies = cfg.companies.length || cfg.companyLimit;
    return { companies, maxMinutes: Math.min(companies * cfg.minutesPerCompany, RUN_BUDGET_MINUTES), runBudgetMinutes: RUN_BUDGET_MINUTES,
      large: cfg.mode === 'import' && companies > LARGE_IMPORT_COMPANIES };
  }
  const endpoint = (env = process.env, caps = {}) => safeEndpoint(env.SEEN_COMPANY_INTEL_INGEST_URL, caps.defaultEndpoint || DEFAULT_ENDPOINT);
  function command(cfg, env = process.env) {
    const out = {
      SEEN_COMPANY_INTEL_INGEST_TOKEN: String(env.SEEN_COMPANY_INTEL_INGEST_TOKEN || ''),
      [`${P}_GOAL`]: String(cfg.goal),
      [`${P}_MINUTES_PER_COMPANY`]: String(cfg.minutesPerCompany),
      [`${P}_TOTAL_MINUTES`]: String(RUN_BUDGET_MINUTES),
    };
    for (const x of extras) out[`${P}_${x.env}`] = String(cfg[x.key]);
    if (spec.sources && cfg.sources) out[`${P}_SOURCES`] = cfg.sources.join(',');
    if (cfg.companies.length) out[`${P}_COMPANIES_JSON`] = JSON.stringify(cfg.companies);
    else {
      out[`${P}_COMPANY_LIMIT`] = String(cfg.companyLimit);
      if (cfg.fillBelow) out[`${P}_BELOW`] = String(cfg.fillBelow);
    }
    if (String(env.SEEN_COMPANY_INTEL_INGEST_URL || '').trim()) out.SEEN_COMPANY_INTEL_INGEST_URL = endpoint(env) || '';
    return { script: spec.script, args: cfg.mode === 'dry_run' ? ['--dry-run'] : [], env: out };
  }

  function interpret({ code, signal, stdout, stderr, cancelled = false, timedOut = false, config: cfg = {} }) {
    const m = parseTrailingJson(stdout);
    const ok = m && typeof m === 'object' && Array.isArray(m.companies);
    const stderrText = String(stderr || '').trim();
    const fatal = code !== 0 ? (stderrText.split(/\r?\n/).filter((l) => /Error|failed|Set |must|ENOENT/i.test(l) && !/^\[skip\]/.test(l.trim())).slice(-1)[0] || `exit ${code}${signal ? ` (${signal})` : ''}`) : null;
    const dry = ok ? m.dry_run === true : cfg.mode === 'dry_run';
    const companies = ok ? m.companies.slice(0, 500).map((c) => ({
      company: String(c?.company || '').slice(0, 120), found: n0(c?.found), newReports: dry ? null : nOrNull(c?.imported),
      published: dry ? null : nOrNull(c?.published), duplicates: dry ? null : nOrNull(c?.duplicates), downgraded: dry ? null : nOrNull(c?.downgraded),
      rejected: dry ? null : nOrNull(c?.rejected), threadsRead: n0(c?.threads_read), searches: n0(c?.searches), failedSearches: n0(c?.failed_searches),
      companySubs: (Array.isArray(c?.company_subs) ? c.company_subs : []).slice(0, 4).map((s) => String(s).slice(0, 60)),
      stoppedBy: c?.stopped_by ? String(c.stopped_by).slice(0, 30) : null,
      searchErrors: (Array.isArray(c?.search_errors) ? c.search_errors : []).slice(0, 3).map((e) => redact(String(e)).slice(0, 220)),
      bySource: Object.fromEntries(Object.entries(c?.by_source || {}).slice(0, 6).map(([k, v]) => [String(k).slice(0, 20), { found: n0(v?.found), newReports: dry ? null : nOrNull(v?.new_reports), stoppedBy: v?.stopped_by ? String(v.stopped_by).slice(0, 30) : null }])),
      outcomes: Object.fromEntries(Object.entries(c?.outcomes || {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 20), n0(v)])),
      error: c?.error ? redact(String(c.error)).slice(0, 200) : null,
    })) : [];
    const notReached = ok && Array.isArray(m.not_reached) ? m.not_reached.slice(0, 500).map((s) => String(s).slice(0, 120)) : [];
    const reasons = ok && Array.isArray(m.rejection_reasons) ? m.rejection_reasons.map((r) => String(r).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)).slice(0, 10) : [];
    const count = (s) => companies.filter((c) => c.stoppedBy === s).length;
    const bySource = {};
    for (const c of companies) for (const [k, v] of Object.entries(c.bySource)) {
      const t = bySource[k] || (bySource[k] = { found: 0, newReports: dry ? null : 0 });
      t.found += v.found; if (!dry) t.newReports += v.newReports || 0;
    }
    const metrics = ok ? {
      dryRun: dry, goal: nOrNull(m.goal), years: nOrNull(m.years), companiesTargeted: nOrNull(m.targets), companiesDone: companies.length,
      sources: Array.isArray(m.sources) ? m.sources.map((s) => String(s).slice(0, 20)) : null, bySource,
      accountsFound: nOrNull(m.found),
      newReports: dry ? null : nOrNull(m.imported_reports), published: dry ? null : nOrNull(m.published_reports),
      duplicates: dry ? null : nOrNull(m.duplicates), downgraded: dry ? null : nOrNull(m.downgraded), rejected: dry ? null : nOrNull(m.rejected),
      reachedGoal: count('goal'), exhausted: count('exhausted'), outOfTime: count('time'), companyErrors: count('error'),
      googleBlocked: m.google_blocked === true, notReached: notReached.length, failedSearches: companies.reduce((a, c) => a + c.failedSearches, 0),
      threadsRead: companies.reduce((a, c) => a + c.threadsRead, 0),
    } : { dryRun: dry };
    const errorTexts = [...companies.map((c) => c.error).filter(Boolean), ...companies.flatMap((c) => c.searchErrors), ...(ok && m.ingest_error ? [String(m.ingest_error)] : []), ...(fatal ? [fatal] : [])];
    const failureCategories = tallyFailures(errorTexts);

    let status; let reason = null;
    if (cancelled) { status = 'cancelled'; reason = dry ? 'cancelled — dry run, nothing was sent' : 'cancelled — reports already sent stay in Seen (a re-run skips them)'; }
    else if (timedOut) { status = 'failed'; reason = 'the run exceeded Seen Command’s wall-clock limit and was stopped — reports already sent stay in Seen'; }
    else if (code !== 0 || !ok) {
      const cat = classifyFailure(fatal || stderrText);
      status = FAILURE_CATEGORIES[cat].blocking ? 'blocked' : 'failed';
      reason = `${FAILURE_CATEGORIES[cat].label}: ${String(fatal || 'no summary printed').slice(0, 220)}`;
    } else if (m.ingest_error) {
      const cat = classifyFailure(String(m.ingest_error));
      status = companies.some((c) => (c.newReports || 0) > 0) ? 'partial' : (FAILURE_CATEGORIES[cat].blocking ? 'blocked' : 'failed');
      reason = `sending to Seen stopped: ${redact(String(m.ingest_error)).slice(0, 200)}${notReached.length ? ` — ${notReached.length} companies not reached` : ''}`;
    } else if (metrics.googleBlocked) {
      status = companies.some((c) => c.found > 0) ? 'partial' : 'failed';
      reason = 'Google asked this Mac for a CAPTCHA (“unusual traffic”), so Google stopped for this run — it is never solved. Wait an hour or two, or raise the pause between searches, then run again.';
    } else if (companies.length && companies.every((c) => c.searches > 0 && c.failedSearches >= c.searches)) {
      const why = companies.flatMap((c) => c.searchErrors)[0];
      status = 'failed';
      reason = why ? `every ${spec.failedSearchWord || 'search'} failed: ${why}` : `every ${spec.failedSearchWord || 'search'} failed — try again later`;
    } else if (notReached.length || metrics.companyErrors) {
      status = 'partial';
      reason = [notReached.length ? `the ${RUN_BUDGET_MINUTES}-minute run budget ran out: ${notReached.length} companies not reached (start another run to continue)` : '',
        metrics.companyErrors ? `${metrics.companyErrors} companies stopped on an error` : ''].filter(Boolean).join(' · ');
    } else {
      status = 'completed';
      if (!companies.length) reason = 'Seen returned no target companies';
      else if (dry) reason = 'dry run — nothing was sent to Seen';
      else if ((metrics.newReports || 0) > 0 && metrics.published === 0) reason = 'Seen held these reports for review instead of publishing them — deploy Seen 2026-10-20 or later (its ingest re-checks and publishes these accounts)';
    }
    return { status, reason, metrics, diagnostics: { failureCategories, perCompany: companies, notReached, rejectionReasons: reasons, fatal, stoppedLabels: STOPPED, provenance: spec.provenance } };
  }

  async function readiness({ repoDir, env = process.env, deps = {} } = {}) {
    const checks = [];
    const repo = probeSeenRepo(repoDir, [spec.script]);
    checks.push({ id: 'repo', label: `Seen checkout + ${spec.repoLabel || 'collector'}`, blocking: true, ...repo,
      ...(repo.status === 'missing' && /lacks/.test(repo.detail || '') ? { fix: 'git pull the Seen checkout (this collector landed on 2026-10-20).' } : {}) });
    const caps = repo.status === 'ok' ? discoverCapabilities(readSource(repoDir, spec.script), readDirectImports(repoDir, spec.script)) : { found: false };
    if (caps.found) {
      checks.push(caps.existingCompaniesOnly
        ? { id: 'identity', label: 'Existing companies only', blocking: false, status: 'ok', detail: 'Verified in the collector source: imports send require_existing:true, so Seen rejects unknown companies instead of creating them.' }
        : { id: 'identity', label: 'Existing companies only', blocking: true, modes: ['import'], status: 'broken', detail: 'This collector does not send require_existing:true — an import could create companies.', fix: 'Update the Seen checkout; imports stay disabled until the guard is present.' });
      checks.push(caps.noModelCalls && caps.keepsSourceUrl
        ? { id: 'provenance', label: 'Free and source-linked', blocking: false, status: 'ok', detail: 'Verified in the collector source: no model calls (no spend); every account keeps its link.' }
        : { id: 'provenance', label: 'Free and source-linked', blocking: true, modes: ['import'], status: 'broken', detail: 'Could not verify that the collector makes no model calls and keeps each source link.', fix: `Inspect ${spec.script} before importing.` });
      if (!caps.goalCountsNew) checks.push({ id: 'goal', label: 'Goal counts new reports', blocking: false, status: 'degraded', detail: 'This collector counts every account it finds toward the goal, so a re-run can stop on accounts Seen already has.', fix: 'git pull the Seen checkout (next-migration, 2026-10-20 or later).' });
    }
    const token = String(env.SEEN_COMPANY_INTEL_INGEST_TOKEN || '').trim();
    const ep = endpoint(env, caps);
    const auth = await (deps.probeIngestAuth || probeIngestAuth)({ url: ep, token, emptyBody: { items: [] } });
    // Both modes need it: the collector refuses to start without it, and a preview asks Seen for its targets.
    checks.push({ id: 'ingest-auth', label: 'Seen ingest token (LOCAL_COMPANY_INTEL_INGEST_SECRET)', blocking: ['missing', 'unauthorized', 'not_deployed', 'invalid'].includes(auth.status), ...auth });
    const mig = await (deps.probeIntelMigration || probeIntelMigration)({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
    checks.push({ id: 'migration', label: `Migration ${mig.migration || '20261019160000_company_intel_imports.sql'}`, blocking: mig.status === 'missing', modes: ['import'], ...mig });
    if (spec.readinessExtra) checks.push(...(await spec.readinessExtra({ env, deps, caps })));
    return { checks, caps, endpoint: ep, environment: 'local' };
  }

  const adapter = {
    id: spec.id, label: spec.label, description: spec.description, environment: 'local', executes: spec.executes,
    resources: spec.resources || [], modes: ['dry_run', 'import'], script: spec.script, cancellable: true,
    cancelNote: spec.cancelNote || 'Safe: reading is read-only; reports already sent stay in Seen, and a re-run skips them.',
    discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness,
  };
  return { adapter, discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness, endpoint };
}
