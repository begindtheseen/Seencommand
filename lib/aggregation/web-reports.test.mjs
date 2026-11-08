// Run: node --test lib/aggregation/web-reports.test.mjs — the Google Reports (Chrome) adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapter, discoverCapabilities, validateConfig, command, interpret, readiness, SCRIPT, RUN_BUDGET_MINUTES } from './web-reports.mjs';
import { WEB_SOURCE, fakeRepo, okProbes } from './testkit.mjs';

const caps = discoverCapabilities(WEB_SOURCE);

test('capabilities from the script (and the real Seen checkout when present); it takes the Browser Bridge', () => {
  assert.deepEqual(caps.searchGapSeconds, { min: 10, max: 600, def: 25 });
  assert.deepEqual(caps.pagesPerCompany, { min: 1, max: 200, def: 30 });
  assert.deepEqual(caps.fillBelow, { min: 1, max: 10000 });
  assert.equal(caps.sources, undefined, 'one source: Google');
  assert.deepEqual(adapter.resources, ['browser-bridge']);
  for (const dir of [process.env.SEEN_PRODUCT_REPO_DIR, join(import.meta.dirname, '..', '..', '..', 'Seen'), join(import.meta.dirname, '..', '..', '..', 'seen')]) {
    if (!dir || !existsSync(join(dir, SCRIPT))) continue;
    const real = discoverCapabilities(readFileSync(join(dir, SCRIPT), 'utf8'));
    assert.deepEqual({ ...real, defaultEndpoint: null }, { ...caps, defaultEndpoint: null }, `the testkit copy drifted from ${dir}/${SCRIPT}`);
    break;
  }
});

test('config → the exact WEB_REPORTS_* env; the pause between searches has a floor', () => {
  const v = validateConfig({ mode: 'import', fillBelow: 10, companyLimit: 20, goal: 10, searchGapSeconds: 40, pagesPerCompany: 50 }, caps);
  assert.equal(v.ok, true, v.errors.join());
  assert.deepEqual(command(v.config, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' }).env, { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't', WEB_REPORTS_GOAL: '10', WEB_REPORTS_MINUTES_PER_COMPANY: '10',
    WEB_REPORTS_TOTAL_MINUTES: String(RUN_BUDGET_MINUTES), WEB_REPORTS_SEARCH_GAP_SECONDS: '40', WEB_REPORTS_PAGES_PER_COMPANY: '50', WEB_REPORTS_COMPANY_LIMIT: '20', WEB_REPORTS_BELOW: '10' });
  assert.match(validateConfig({ searchGapSeconds: 2 }, caps).errors.join(), /seconds between Google searches must be a whole number from 10 to 600/);
});

test('a Google CAPTCHA is named in the result, never hidden as “completed”', () => {
  const s = JSON.stringify({ ok: true, dry_run: false, goal: 10, sources: ['google'], targets: 2, found: 4, imported_reports: 4, published_reports: 4, downgraded: 0, duplicates: 0, rejected: 0, ingest_error: null, stopped_early: null, not_reached: [], rejection_reasons: [], google_blocked: true, opencli_form: 'flag',
    companies: [{ company: 'Umbrella', found: 4, imported: 4, published: 4, searches: 8, failed_searches: 0, stopped_by: 'exhausted' }, { company: 'Hooli', found: 0, imported: 0, searches: 1, failed_searches: 0, stopped_by: 'google_blocked' }] });
  const r = interpret({ code: 0, stdout: s, stderr: '' });
  assert.equal(r.status, 'partial');
  assert.match(r.reason, /CAPTCHA/);
  assert.match(r.reason, /never solved/);
  assert.equal(r.metrics.googleBlocked, true);
});

test('readiness needs the Browser Bridge (not the archive)', async () => {
  const r = await readiness({ repoDir: fakeRepo(), env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' }, deps: okProbes });
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by.opencli.status, 'ok');
  assert.equal(by.archive, undefined);
  const down = await readiness({ repoDir: fakeRepo(), env: { SEEN_COMPANY_INTEL_INGEST_TOKEN: 't' }, deps: { ...okProbes, probeOpenCli: async () => ({ installed: true, bridge: 'disconnected', status: 'broken', detail: 'bridge down' }) } });
  assert.equal(down.checks.find((c) => c.id === 'opencli').blocking, true);
});
