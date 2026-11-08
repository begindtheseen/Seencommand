// Google Reports adapter — drives Seen's `scripts/collect-web-reports.mjs` (`npm run ingest:web-reports`):
// applicant-story searches on Google and every open page Google returns, searched and read in THIS Mac's
// Chrome (OpenCLI Browser Bridge) at a slow, rate-limited pace. It takes the Browser
// Bridge (one Chrome collector at a time). Review sites (Glassdoor, Indeed, LinkedIn, Facebook, X, TikTok)
// and Reddit are skipped by the collector; a Google CAPTCHA stops Google for the rest of the run — never
// solved. Seen re-checks every account and publishes passes as "Public review · <host>" (weight 0.3,
// trust_reason web_rule_match). Shared shape: lib/aggregation/reports-adapter.mjs.
//
// Verified against Seen 0fd4462 (2026-10-20): WEB_REPORTS_{COMPANIES_JSON (1–500), COMPANY_LIMIT, BELOW,
// GOAL (0 = no cap), MINUTES_PER_COMPANY, TOTAL_MINUTES, SEARCH_GAP_SECONDS (10–600), PAGES_PER_COMPANY (1–200)};
// --dry-run; the summary adds google_blocked and opencli_form.

import { probeOpenCli } from './probes.mjs';
import { createReportsAdapter, RUN_BUDGET_MINUTES } from './reports-adapter.mjs';

export const SCRIPT = 'scripts/collect-web-reports.mjs';
export { RUN_BUDGET_MINUTES };

const built = createReportsAdapter({
  id: 'web_reports',
  label: 'Google Reports (Chrome)',
  description: 'Searches Google for each company’s applicant stories and reads the open pages it finds, in this Mac’s Chrome — free, at a slow, rate-limited pace.',
  executes: 'Runs on this Mac (OpenCLI + Chrome); searches google.com, reads result pages, writes to Seen’s /api/ingest-local-company-intel.',
  script: SCRIPT, prefix: 'WEB_REPORTS', resources: ['browser-bridge'], minutesDefault: 10, repoLabel: 'Google report collector',
  extras: [
    { key: 'searchGapSeconds', env: 'SEARCH_GAP_SECONDS', label: 'seconds between Google searches', fallback: { min: 10, max: 600, def: 25 } },
    { key: 'pagesPerCompany', env: 'PAGES_PER_COMPANY', label: 'result pages per company', fallback: { min: 1, max: 200, def: 30 } },
  ],
  failedSearchWord: 'Google search',
  cancelNote: 'Safe: reading is plain browsing; reports already sent stay in Seen, and a re-run skips them.',
  provenance: 'Word-for-word text from open web pages Google found (contact details masked), each with its link. Reddit and the review sites (Glassdoor, Indeed, LinkedIn, Facebook, X, TikTok) are not read. Only first-hand applicant accounts that pass Seen’s rules are sent, and Seen re-checks every one. Published reports are labelled “Public review · <site>”, carry the low trust weight (0.3) and the tag web_rule_match, so they can be removed in bulk.',
  readinessExtra: async ({ deps }) => {
    const cli = await (deps.probeOpenCli || probeOpenCli)();
    return [
      { id: 'opencli', label: 'OpenCLI + Chrome Browser Bridge', blocking: cli.status === 'missing' || cli.bridge === 'disconnected' || cli.status === 'broken', ...cli },
      { id: 'google-pace', label: 'Google at a slow, rate-limited pace', blocking: false, informational: true, status: 'ok', detail: 'Searches run 25 s apart by default in your own Chrome. If Google ever asks for a CAPTCHA, Google stops for the run and the run says so — it is never solved.' },
    ];
  },
});

export const { adapter, discoverCapabilities, defaults, validateConfig, estimateWork, command, interpret, readiness } = built;
