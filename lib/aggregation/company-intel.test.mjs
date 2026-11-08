import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCapabilities, validateConfig, command, interpret, readiness, previewTargets, isSlugLike, targetsUrl, fetchCatalog, catalogUrl } from './company-intel.mjs';
import { INTEL_SOURCE, fakeRepo, okProbes } from './testkit.mjs';

const caps = discoverCapabilities(INTEL_SOURCE);

test('capability discovery verifies the identity + provenance guards in the real collector source', () => {
  assert.equal(caps.found, true);
  assert.deepEqual(caps.sources, ['reddit']);
  assert.equal(caps.companyLimitMax, 100);
  assert.equal(caps.companyLimitDefault, 10);
  assert.equal(caps.postsPerCompanyMax, 10);
  assert.equal(caps.dryRun, true);
  assert.equal(caps.explicitTargets, false);
  assert.equal(caps.existingCompaniesOnly, true);
  assert.equal(caps.noModelCalls, true);
  assert.equal(caps.keepsSourceUrl, true);
  assert.equal(caps.redaction, true);
  assert.equal(discoverCapabilities(INTEL_SOURCE.replace('require_existing: true', 'require_existing: false')).existingCompaniesOnly, false);
  assert.equal(discoverCapabilities(`${INTEL_SOURCE}\nimport Anthropic from '@anthropic-ai/sdk';`).noModelCalls, false);
});

test('only options the collector supports are accepted — no company list, no other sources', () => {
  assert.equal(validateConfig({ mode: 'import', companyLimit: 5, postsPerCompany: 3 }, caps).ok, true);
  const bad = validateConfig({ mode: 'scrape', companyLimit: 101, postsPerCompany: 0, companies: ['Acme'], sources: ['glassdoor'] }, caps);
  assert.equal(bad.ok, false);
  const t = bad.errors.join(' | ');
  assert.match(t, /mode must be dry_run or import/);
  assert.match(t, /companies per run/);
  assert.match(t, /posts per company/);
  assert.match(t, /cannot take a company list — git pull/, 'a checkout without the company-list option refuses one');
  assert.match(t, /unsupported option: sources/);
  assert.equal(validateConfig({}, caps).config.mode, 'dry_run'); // safe default
});

test('the collector gets explicit argv + env', () => {
  const { config } = validateConfig({ mode: 'dry_run', companyLimit: 5, postsPerCompany: 2 }, caps);
  const c = command(config, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 'tok', GITHUB_TOKEN: 'nope' });
  assert.deepEqual(c.args, ['--dry-run']);
  assert.deepEqual(Object.keys(c.env).sort(), ['COMPANY_INTEL_COMPANY_LIMIT', 'COMPANY_INTEL_POSTS_PER_COMPANY', 'SEEN_COMPANY_INTEL_INGEST_TOKEN']);
  assert.deepEqual(command({ ...config, mode: 'import' }, {}).args, []);
  assert.equal(targetsUrl('https://seen.example/api/ingest-local-company-intel', 7), 'https://seen.example/api/local-company-intel-targets?limit=7');
});

const STDOUT = '[collect] Acme Corp: 4 raw excerpts\n[collect] greenhouseboard: 1 raw excerpts\n' + JSON.stringify({ ok: true, targets: 3, collected: 5, dry_run: false, imported_reports: 2, commentary: 2, duplicates: 1, rejected: 0 }, null, 2);

test('import results: per-company progress, source failures, identity review, unmatched = unreported', () => {
  const stderr = '[skip] Beta Inc: search failed: Command failed: opencli reddit search (Browser Bridge extension is not connected)\n';
  const r = interpret({ code: 0, stdout: STDOUT, stderr, config: { mode: 'import' } });
  assert.equal(r.status, 'partial');
  assert.equal(r.metrics.companiesTargeted, 3);
  assert.equal(r.metrics.importedReports, 2);
  assert.equal(r.metrics.commentary, 2);
  assert.equal(r.metrics.accepted, 4);
  assert.equal(r.metrics.duplicates, 1);
  assert.equal(r.metrics.unmatchedIdentities, null);
  assert.equal(r.metrics.searchFailures, 1);
  assert.equal(r.diagnostics.perCompany.length, 2);
  assert.deepEqual(r.diagnostics.identityReview.map((x) => x.company), ['greenhouseboard']);
  assert.match(r.diagnostics.provenance, /not summarized or rewritten/);
  assert.equal(r.diagnostics.failureCategories[0].category, 'browser_bridge');
});

test('a dry run reports import counts as nonexistent, not zero', () => {
  const out = '[collect] Acme Corp: 3 raw excerpts\n' + JSON.stringify({ ok: true, targets: 1, collected: 3, dry_run: true, imported_reports: 0, commentary: 0, duplicates: 0, rejected: 0 });
  const r = interpret({ code: 0, stdout: out, stderr: '', config: { mode: 'dry_run' } });
  assert.equal(r.status, 'completed');
  assert.equal(r.metrics.excerptsCollected, 3);
  for (const k of ['importedReports', 'commentary', 'duplicates', 'rejected', 'accepted']) assert.equal(r.metrics[k], null, k);
});

test('every company search failing is blocked/failed; a dead collector is honest about earlier batches', () => {
  const out = JSON.stringify({ ok: true, targets: 2, collected: 0, dry_run: false, imported_reports: 0, commentary: 0, duplicates: 0, rejected: 0 });
  const stderr = '[skip] A: search failed: Browser Bridge not connected\n[skip] B: search failed: Browser Bridge not connected\n';
  assert.equal(interpret({ code: 0, stdout: out, stderr, config: { mode: 'import' } }).status, 'blocked');
  const dead = interpret({ code: 1, stdout: '[collect] A: 2 raw excerpts\n', stderr: 'Error: ingest failed (503): Company-intelligence storage is unavailable.', config: { mode: 'import' } });
  assert.equal(dead.status, 'blocked');
  assert.match(dead.reason, /may already be imported/);
  const targets401 = interpret({ code: 1, stdout: '', stderr: 'Error: /api/local-company-intel-targets?limit=5 failed (401): Unauthorized', config: { mode: 'dry_run' } });
  assert.equal(targets401.status, 'blocked');
  assert.match(targets401.reason, /rejected the ingest token/);
});

test('readiness: a missing migration blocks IMPORT only; a missing identity guard blocks import', async () => {
  const repoDir = fakeRepo();
  const r = await readiness({ repoDir, env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' }, deps: { ...okProbes, probeIntelMigration: async () => ({ status: 'missing', migration: '20261019160000_company_intel_imports.sql', detail: 'absent', fix: 'apply it (owner approval)' }) } });
  const mig = r.checks.find((c) => c.id === 'migration');
  assert.equal(mig.status, 'missing'); assert.equal(mig.blocking, true); assert.deepEqual(mig.modes, ['import']);
  const unsafe = fakeRepo({ intel: INTEL_SOURCE.replace('require_existing: true', '') });
  const u = await readiness({ repoDir: unsafe, env: {}, deps: okProbes });
  const id = u.checks.find((c) => c.id === 'identity');
  assert.equal(id.status, 'broken'); assert.equal(id.blocking, true); assert.deepEqual(id.modes, ['import']);
});

test('target preview is a read-only GET and flags ATS-style slugs as unverified identities', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return new Response(JSON.stringify({ ok: true, scanned_active_companies: 900, companies: [{ company: 'Acme Corp', active_listings: 12, existing_reports: 3 }, { company: 'acmeboard', active_listings: 2, existing_reports: 0 }] }), { status: 200 }); };
  const r = await previewTargets({ limit: 2, env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 'tok' }, caps, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen.opts.method, undefined); // GET
  assert.match(seen.url, /\/api\/local-company-intel-targets\?limit=2$/);
  assert.deepEqual(r.companies.map((c) => c.slugLike), [false, true]);
  assert.equal(isSlugLike('Acme Corp'), false);
  assert.equal(isSlugLike('acme-careers'), true);
  assert.equal((await previewTargets({ env: {}, caps, fetchImpl })).ok, false);
});

// Seen 2026-10-20+: the collector reads COMPANY_INTEL_COMPANIES_JSON.
const capsList = discoverCapabilities(`${INTEL_SOURCE}\nconst raw = process.env.COMPANY_INTEL_COMPANIES_JSON;`);

test('a chosen company list (the picker) is validated, de-duplicated and passed as JSON; empty = Seen chooses', () => {
  assert.equal(capsList.explicitTargets, true);
  const v = validateConfig({ mode: 'import', companies: ['Globex', 'globex', ' Massive Dynamic ', 'Wonka'], postsPerCompany: 5, companyLimit: 7 }, capsList);
  assert.equal(v.ok, true, v.errors.join(' | '));
  assert.deepEqual(v.config.companies, ['Globex', 'Massive Dynamic', 'Wonka']);
  assert.equal(v.config.companyLimit, 3, 'the list size is the company count');
  const c = command(v.config, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 'tok' });
  assert.equal(c.env.COMPANY_INTEL_COMPANIES_JSON, '["Globex","Massive Dynamic","Wonka"]');
  assert.equal(c.env.COMPANY_INTEL_COMPANY_LIMIT, '3');
  const none = command(validateConfig({ mode: 'dry_run', companies: [] }, capsList).config, {});
  assert.equal(none.env.COMPANY_INTEL_COMPANIES_JSON, undefined, 'no list = Seen chooses');
  const bad = validateConfig({ companies: ['ok', 'x'.repeat(121), 'a\nb', ...Array.from({ length: 101 }, (_, i) => `Co ${i}`)] }, capsList);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' | '), /plain name of 1–120/);
  assert.match(bad.errors.join(' | '), /at most 100 companies/);
});

test('the company catalog is read with the ingest token and mapped honestly (missing counts stay null)', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, auth: opts.headers.Authorization }; return { ok: true, status: 200, async json() { return { ok: true, companies: [{ company: 'Globex', active_listings: 851, applicant_reports: 11, employee_reviews: 45, mentions: 20, graded: true, reports_needed: 0 }, { company: 'acme', active_listings: 3 }] }; } }; };
  const r = await fetchCatalog({ env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 'tok' }, caps: capsList, fetchImpl });
  assert.equal(seen.url, 'https://seen.example/api/local-company-intel-targets?catalog=1');
  assert.equal(seen.auth, 'Bearer tok');
  assert.equal(r.ok, true);
  assert.deepEqual(r.companies[0], { company: 'Globex', activeListings: 851, applicantReports: 11, employeeReviews: 45, mentions: 20, graded: true, reportsNeeded: 0, slugLike: false });
  assert.equal(r.companies[1].applicantReports, null);
  assert.equal(r.companies[1].slugLike, true);
  const old = await fetchCatalog({ env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 'tok' }, fetchImpl: async () => ({ ok: false, status: 404, async json() { return {}; } }) });
  assert.match(old.error, /needs the 2026-10-20 deploy/);
  assert.equal((await fetchCatalog({ env: {} })).ok, false);
  assert.equal(catalogUrl('https://preview.example/api/ingest-local-company-intel'), 'https://preview.example/api/local-company-intel-targets?catalog=1');
});

test('rejection reasons from Seen are shown, and "unknown company" names count as unmatched', () => {
  const out = '[collect] Acme Corp: 3 raw excerpts\n' + JSON.stringify({ ok: true, targets: 2, collected: 3, dry_run: false, imported_reports: 0, commentary: 1, duplicates: 0, rejected: 2,
    rejection_reasons: ['unknown company: Beta Inc', 'invalid item: needs a company, an https source link and an excerpt of 20+ characters\u0007'] }, null, 2);
  const r = interpret({ code: 0, stdout: out, stderr: '', config: { mode: 'import' } });
  assert.equal(r.metrics.unmatchedIdentities, 1);
  assert.deepEqual(r.diagnostics.unmatched.names, ['Beta Inc']);
  assert.equal(r.diagnostics.rejectionReasons.length, 2);
  assert.ok(!/\u0007/.test(r.diagnostics.rejectionReasons[1]), 'control characters stripped');
  // An older collector without reasons keeps "not reported".
  const old = interpret({ code: 0, stdout: STDOUT, stderr: '', config: { mode: 'import' } });
  assert.equal(old.metrics.unmatchedIdentities, null);
  assert.match(old.diagnostics.unmatched.note, /git pull/);
});

test('search gap passes through only as a whole number of ms up to 60000', () => {
  const cfg = { mode: 'import', companyLimit: 2, postsPerCompany: 1, companies: [] };
  assert.equal(command(cfg, { COMPANY_INTEL_SEARCH_GAP_MS: '0' }).env.COMPANY_INTEL_SEARCH_GAP_MS, '0');
  assert.equal(command(cfg, { COMPANY_INTEL_SEARCH_GAP_MS: '6000' }).env.COMPANY_INTEL_SEARCH_GAP_MS, '6000');
  for (const bad of ['abc', '-1', '99999', '1e3', '; rm -rf /']) assert.equal(command(cfg, { COMPANY_INTEL_SEARCH_GAP_MS: bad }).env.COMPANY_INTEL_SEARCH_GAP_MS, undefined, bad);
  assert.equal('COMPANY_INTEL_SEARCH_GAP_MS' in command(cfg, {}).env, false);
});
