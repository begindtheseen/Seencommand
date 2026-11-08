// Run: node --test lib/aggregation/applicant-reports.test.mjs
// The Applicant Reports adapter: capabilities, config, the exact env it hands Seen's collector, and the
// honest reading of the collector's summary. No network, no Seen, no archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapter, discoverCapabilities, validateConfig, command, interpret, readiness, RUN_BUDGET_MINUTES, SCRIPT } from './applicant-reports.mjs';
import { ARCHIVE_SOURCE, ARCHIVE_IMPORTS, fakeRepo, okProbes } from './testkit.mjs';
import { readDirectImports } from './probes.mjs';

const caps = discoverCapabilities(ARCHIVE_SOURCE, ARCHIVE_IMPORTS);

test('capabilities come from the script’s own bounds (and match the real Seen checkout when present)', () => {
  assert.deepEqual(caps.goal, { min: 0, max: 100000, def: 10 });
  assert.deepEqual(caps.years, { min: 1, max: 10, def: 5 });
  assert.deepEqual(caps.minutesPerCompany, { min: 1, max: 240, def: 20 });
  assert.deepEqual(caps.fillBelow, { min: 1, max: 10000 });
  assert.equal(caps.maxCompanies, 500);
  assert.equal(caps.runBudget, true);
  assert.equal(caps.existingCompaniesOnly, true);
  assert.equal(caps.noModelCalls, true);
  assert.equal(caps.keepsSourceUrl, true, 'the link is kept in the shared module the script imports');
  assert.equal(caps.redaction, true);
  assert.equal(adapter.resources.length, 0, 'no Browser Bridge');
  // The sibling Seen checkout, when this machine has one: the real script must read the same way.
  for (const dir of [process.env.SEEN_PRODUCT_REPO_DIR, join(import.meta.dirname, '..', '..', '..', 'Seen'), join(import.meta.dirname, '..', '..', '..', 'seen')]) {
    if (!dir || !existsSync(join(dir, SCRIPT))) continue;
    const real = discoverCapabilities(readFileSync(join(dir, SCRIPT), 'utf8'), readDirectImports(dir, SCRIPT));
    assert.deepEqual({ ...real, defaultEndpoint: null }, { ...caps, defaultEndpoint: null }, `the testkit copy drifted from ${dir}/${SCRIPT}`);
    break;
  }
});

test('provenance: evidence may live in a direct import; a model client in an import is caught, a comment is not', () => {
  assert.equal(discoverCapabilities(ARCHIVE_SOURCE).keepsSourceUrl, false, 'the script alone no longer carries the link');
  const comment = [...ARCHIVE_IMPORTS, { path: 'lib/reports/notes.js', source: '// the old pipeline was LLM-classified; this one is not' }];
  assert.equal(discoverCapabilities(ARCHIVE_SOURCE, comment).noModelCalls, true);
  const sdk = [...ARCHIVE_IMPORTS, { path: 'lib/reports/x.js', source: "const r = await fetch('https://api.anthropic.com/v1/messages')" }];
  assert.equal(discoverCapabilities(ARCHIVE_SOURCE, sdk).noModelCalls, false);
  const llm = [...ARCHIVE_IMPORTS, { path: 'lib/server/llm.js', source: 'export const x = 1;' }];
  assert.equal(discoverCapabilities(ARCHIVE_SOURCE, llm).noModelCalls, false);
});

test('readiness: provenance passes on a checkout whose script imports the source module', async () => {
  const r = await readiness({ repoDir: fakeRepo(), env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' }, deps: okProbes });
  const p = r.checks.find((c) => c.id === 'provenance');
  assert.equal(p.status, 'ok', p.detail);
});

test('config: fill-to-K or a chosen list; goal 0 is “no cap”; out-of-range values are refused', () => {
  const ok = validateConfig({ mode: 'import', fillBelow: 10, companyLimit: 50, goal: 0, years: 3, minutesPerCompany: 15 }, caps);
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.config.goal, 0);
  const bad = validateConfig({ goal: -1, years: 11, companies: 'Vandelay', extra: 1 }, caps);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
  const many = validateConfig({ companies: Array.from({ length: 501 }, (_, i) => `Co ${i}`) }, caps);
  assert.match(many.errors.join(), /at most 500/);
  const old = validateConfig({ fillBelow: 10 }, { ...caps, fillBelow: null });
  assert.match(old.errors.join(), /git pull/);
});

test('command: the documented env only, a run budget under the wall clock, and the list OR the fill queue', () => {
  const fill = command(validateConfig({ mode: 'import', fillBelow: 10, companyLimit: 40, goal: 25 }, caps).config, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't', GITHUB_TOKEN: 'no' });
  assert.deepEqual(fill.args, []);
  assert.deepEqual(fill.env, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't', ARCHIVE_REPORTS_GOAL: '25', ARCHIVE_REPORTS_YEARS: '5', ARCHIVE_REPORTS_MINUTES_PER_COMPANY: '10',
    ARCHIVE_REPORTS_TOTAL_MINUTES: String(RUN_BUDGET_MINUTES), ARCHIVE_REPORTS_SOURCES: 'reddit', ARCHIVE_REPORTS_COMPANY_LIMIT: '40', ARCHIVE_REPORTS_BELOW: '10' });
  assert.ok(RUN_BUDGET_MINUTES < 240, 'stops itself before the 4-hour kill');
  const list = command(validateConfig({ companies: ['Vandelay', 'vandelay', 'Globex'] }, caps).config, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' });
  assert.deepEqual(list.args, ['--dry-run']);
  assert.equal(list.env.ARCHIVE_REPORTS_COMPANIES_JSON, '["Vandelay","Globex"]');
  assert.equal(list.env.ARCHIVE_REPORTS_BELOW, undefined, 'a chosen list is not filtered');
});

const row = (company, extra = {}) => ({ company, found: 12, imported: 10, published: 10, duplicates: 2, downgraded: 0, rejected: 0, threads_read: 30, searches: 8, failed_searches: 0, company_subs: ['Umbrella'], stopped_by: 'goal', outcomes: { offer: 4, ghosted: 6 }, ...extra });
const summary = (extra = {}) => `[company] Umbrella: 12 first-hand accounts (goal)\n${JSON.stringify({ ok: true, dry_run: false, goal: 10, years: 5, targets: 2, found: 20, imported_reports: 16, published_reports: 16, downgraded: 1, duplicates: 3, rejected: 0, ingest_error: null, stopped_early: null, not_reached: [], rejection_reasons: [], companies: [row('Umbrella'), row('Hooli', { found: 8, imported: 6, published: 6, stopped_by: 'exhausted' })], ...extra }, null, 2)}`;

test('interpret: totals per company and per stop reason; a held-for-review deploy is named; dry runs report no import counts', () => {
  const r = interpret({ code: 0, stdout: summary(), stderr: '' });
  assert.equal(r.status, 'completed');
  assert.equal(r.metrics.newReports, 16);
  assert.equal(r.metrics.reachedGoal, 1);
  assert.equal(r.metrics.exhausted, 1);
  assert.equal(r.diagnostics.perCompany[1].stoppedBy, 'exhausted');
  const held = interpret({ code: 0, stdout: summary({ published_reports: 0 }), stderr: '' });
  assert.match(held.reason, /held these reports for review/);
  const dry = interpret({ code: 0, stdout: summary({ dry_run: true }), stderr: '' });
  assert.equal(dry.metrics.newReports, null);
  assert.equal(dry.diagnostics.perCompany[0].newReports, null);
  assert.match(dry.reason, /dry run/);
});

test('interpret: out of time and a stopped ingest are partial with the reason; a crash fails', () => {
  const time = interpret({ code: 0, stdout: summary({ stopped_early: 'time', not_reached: ['Wonka', 'Target'] }), stderr: '' });
  assert.equal(time.status, 'partial');
  assert.match(time.reason, /2 companies not reached/);
  const ingest = interpret({ code: 0, stdout: summary({ ok: false, ingest_error: 'Seen ingest failed (401): Unauthorized', stopped_early: 'ingest_error' }), stderr: '' });
  assert.equal(ingest.status, 'partial', 'reports already sent count');
  assert.match(ingest.reason, /sending to Seen stopped/);
  const crash = interpret({ code: 1, stdout: '', stderr: 'Error: Set SEEN_COMPANY_INTEL_INGEST_TOKEN first.' });
  assert.ok(['failed', 'blocked'].includes(crash.status));
  assert.match(crash.reason, /SEEN_COMPANY_INTEL_INGEST_TOKEN/);
});

test('readiness: the checkout, the token (both modes), the archive; Chrome is not required', async () => {
  const repo = fakeRepo();
  const r = await readiness({ repoDir: repo, env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' }, deps: okProbes });
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by.repo.status, 'ok');
  assert.equal(by.identity.status, 'ok');
  assert.equal(by.archive.status, 'ok');
  assert.equal(by['ingest-auth'].modes, undefined, 'the collector needs the token even for a preview');
  assert.equal(by.opencli, undefined, 'no OpenCLI / Chrome check');
  const down = await readiness({ repoDir: repo, env: {}, deps: { ...okProbes, probeIngestAuth: async () => ({ status: 'missing', detail: 'no token' }), probeArchive: async () => ({ status: 'degraded', detail: 'timed out' }) } });
  const d = Object.fromEntries(down.checks.map((c) => [c.id, c]));
  assert.equal(d['ingest-auth'].blocking, true);
  assert.equal(d.archive.blocking, false, 'an archive hiccup warns; a run retries');
});

test('interpret: when every search fails, the reason names the archive’s actual error', () => {
  const s = JSON.stringify({ ok: true, dry_run: false, goal: 3, years: 5, targets: 1, found: 0, imported_reports: 0, published_reports: 0, downgraded: 0, duplicates: 0, rejected: 0, ingest_error: null, stopped_early: null, not_reached: [], rejection_reasons: [],
    companies: [{ company: 'Umbrella', found: 0, imported: 0, searches: 15, failed_searches: 15, search_errors: ['network: fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)'], stopped_by: 'time' }] });
  const r = interpret({ code: 0, stdout: s, stderr: '' });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
  assert.equal(r.diagnostics.perCompany[0].searchErrors.length, 1);
});


test('sources: discovered from the script; chosen ones run in the collector’s own order; unknown ones are refused', () => {
  assert.deepEqual(caps.sources, ['reddit']);
  const one = validateConfig({ sources: ['reddit'] }, caps);
  assert.equal(one.ok, true);
  assert.equal(command(one.config, {}).env.ARCHIVE_REPORTS_SOURCES, 'reddit');
  assert.match(validateConfig({ sources: ['glassdoor'] }, caps).errors.join(), /unknown source: glassdoor/);
  assert.match(validateConfig({ sources: [] }, caps).errors.join(), /at least one source/);
  const old = discoverCapabilities(ARCHIVE_SOURCE.replace(/const SOURCE_IDS = .*\n/, ''));
  assert.equal(old.sources, null);
  assert.match(validateConfig({ sources: ['reddit'] }, old).errors.join(), /git pull/);
});

test('Hacker News is never offered or run, even by an older Seen checkout that still has it (owner decision)', () => {
  const older = discoverCapabilities(ARCHIVE_SOURCE.replace("const SOURCE_IDS = ['reddit'];", "const SOURCE_IDS = ['reddit', 'hackernews'];"));
  assert.deepEqual(older.sources, ['reddit']);
  assert.match(validateConfig({ sources: ['hackernews'] }, older).errors.join(), /unknown source: hackernews/);
  assert.equal(command(validateConfig({}, older).config, {}).env.ARCHIVE_REPORTS_SOURCES, 'reddit', 'the default never includes it');
});

test('per-source totals from the summary’s by_source', () => {
  const s = JSON.stringify({ ok: true, dry_run: false, goal: 10, sources: ['reddit'], targets: 1, found: 12, imported_reports: 11, published_reports: 11, downgraded: 0, duplicates: 1, rejected: 0, ingest_error: null, stopped_early: null, not_reached: [], rejection_reasons: [],
    companies: [{ company: 'Massive Dynamic', found: 12, imported: 11, published: 11, duplicates: 1, searches: 9, failed_searches: 0, stopped_by: 'goal', by_source: { reddit: { found: 12, new_reports: 11, stopped_by: 'goal' } } }] });
  const r = interpret({ code: 0, stdout: s, stderr: '' });
  assert.deepEqual(r.metrics.bySource, { reddit: { found: 12, newReports: 11 } });
  assert.deepEqual(r.metrics.sources, ['reddit']);
});
