// Applicant Reports adapter — drives Seen's free applicant-report collector
// `scripts/collect-archive-reports.mjs` (`npm run ingest:archive-reports`): the Arctic Shift Reddit archive
// (each company's own subreddits + the job subreddits, every thread's post and comment tree), with ONE goal of
// new reports per company. Hacker News is NEVER a source (owner decision: its threads are not a reliable source of first-hand
// applicant reports) — EXCLUDED_SOURCES drops it even when an older
// Seen checkout still offers it, and Seen's ingest refuses it.
// Seen re-checks every account
// with the same strict rules and publishes it (Reddit tier or "Public review · <host>", weight 0.3). No model,
// no spend, no browser: it does NOT take the Chrome Browser Bridge, so it runs alongside the Chrome collectors.
// The shape (capabilities, validation, env, interpretation, readiness) is shared: lib/aggregation/reports-adapter.mjs.
//
// Verified against Seen 6ee8071 (2026-10-20): ARCHIVE_REPORTS_{COMPANIES_JSON (1–500), COMPANY_LIMIT, BELOW,
// GOAL (0 = no cap), SOURCES (reddit), YEARS, MINUTES_PER_COMPANY, TOTAL_MINUTES}; --dry-run.

import { redact } from './store.mjs';
import { createReportsAdapter, RUN_BUDGET_MINUTES } from './reports-adapter.mjs';

export const SCRIPT = 'scripts/collect-archive-reports.mjs';
export const ARCHIVE_BASE = 'https://arctic-shift.photon-reddit.com';
export { RUN_BUDGET_MINUTES };

async function probe(url, what, fetchImpl, timeoutMs) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': 'SeenCommand/1.0 readiness check' } });
    if (r.ok) return { status: 'ok', detail: `${what} answered (read-only check).` };
    if (r.status === 429) return { status: 'degraded', detail: `${what} is rate-limiting right now; a run waits and retries.` };
    return { status: 'degraded', detail: `${what} answered HTTP ${r.status}; a run may fail its searches.` };
  } catch (e) {
    return { status: 'degraded', detail: `Could not reach ${what} (${e.name === 'AbortError' ? 'timed out' : redact(e.message).slice(0, 120)}).`, fix: 'Check this Mac’s internet connection; these are free public services and are sometimes down for a while.' };
  } finally { clearTimeout(timer); }
}
export const probeArchive = ({ fetchImpl = fetch, timeoutMs = 15000 } = {}) => probe(`${ARCHIVE_BASE}/api/subreddits/search?subreddit_prefix=jobs&limit=1`, 'The Arctic Shift Reddit archive', fetchImpl, timeoutMs);
export const EXCLUDED_SOURCES = ['hackernews'];

const built = createReportsAdapter({
  id: 'applicant_reports',
  label: 'Applicant Reports',
  description: 'Finds first-hand applicant accounts for every company in the free Reddit archive and sends them to Seen’s checks — no Chrome, no spend.',
  executes: 'Runs on this Mac (plain Node, no browser); reads the Arctic Shift Reddit archive and writes to Seen’s /api/ingest-local-company-intel.',
  script: SCRIPT, prefix: 'ARCHIVE_REPORTS', resources: [], minutesDefault: 10, repoLabel: 'applicant-report collector',
  extras: [{ key: 'years', env: 'YEARS', label: 'years of history', fallback: { min: 1, max: 10, def: 5 } }],
  sources: true, excludeSources: EXCLUDED_SOURCES,
  failedSearchWord: 'archive search',
  provenance: 'Word-for-word public Reddit posts/comments (contact details masked), each with its link. Only first-hand applicant accounts that pass Seen’s rules are sent, and Seen re-checks every one. Published reports are labelled public discussion, carry the low trust weight (0.3) and the tag reddit_rule_match, so they can be removed in bulk.',
  readinessExtra: async ({ deps, caps }) => {
    const out = [];
    const want = caps.sources || ['reddit'];
    if (want.includes('reddit')) out.push({ id: 'archive', label: 'Reddit archive (Arctic Shift)', blocking: false, ...(await (deps.probeArchive || probeArchive)()) });
    out.push({ id: 'no-browser', label: 'Chrome not needed', blocking: false, informational: true, status: 'ok', detail: 'Reads public APIs directly, so it runs at the same time as the Chrome collectors.' });
    return out;
  },
});

export const { adapter, discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness } = built;
