// The career-site (Chrome) adapter: capability discovery from Seen's real script, validation, the
// documented env, and an honest reading of the collector's JSON summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverCapabilities, validateConfig, buildEnv, interpret, estimateWork, cleanStartUrl, ingestUrl, readiness, retriesItself } from './career-site.mjs';
import { CAREER_SOURCE, fakeRepo, okProbes } from './testkit.mjs';

test('capabilities come from the checked-out script', () => {
  assert.deepEqual(discoverCapabilities(CAREER_SOURCE), { found: true, limitMax: 60, limitDefault: 20, maxTargets: 10, harvest: true, maxJobsMax: 5000, maxJobsDefault: 3000, targetsList: true, dryRun: true, navigator: false, keywords: false });
  assert.deepEqual(discoverCapabilities(null), { found: false });
  // When the Seen checkout sits next to this repo, check the real file too.
  const real = join(import.meta.dirname, '..', '..', '..', 'Seen', 'scripts', 'collect-career-site.mjs');
  if (existsSync(real)) {
    const c = discoverCapabilities(readFileSync(real, 'utf8'));
    assert.equal(c.found, true); assert.equal(c.targetsList, true); assert.equal(c.dryRun, true);
    if (c.navigator) { assert.equal(c.keywords, true); assert.equal(c.maxJobsMax, 20000); assert.equal(c.maxJobsDefault, 5000); }
  }
});

test('the navigator: start page optional, keywords and website pass through, and it re-runs partial sites itself', () => {
  const caps = { ...discoverCapabilities(CAREER_SOURCE), navigator: true, keywords: true };
  const v = validateConfig({ targets: [{ company: 'Vandelay', keywords: 'technician' }, { company: 'Wonka', website: 'wonka.com' }] }, caps);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(JSON.parse(buildEnv(v.config, { SEEN_LOCAL_INGEST_TOKEN: 't' }).CAREER_SITE_TARGETS_JSON), [{ company: 'Vandelay', keywords: 'technician' }, { company: 'Wonka', website: 'wonka.com' }]);
  assert.match(validateConfig({ targets: [{ company: 'Vandelay' }] }, discoverCapabilities(CAREER_SOURCE)).errors.join(' '), /needs a start page/);
  assert.equal(retriesItself(caps), true);
  const out = interpret({ code: 0, stdout: JSON.stringify({ ok: true, targets: 1, sites: [{ company: 'Vandelay', pages_opened: 9, postings_found: 300, saved: 290, listed: 320, site_total: 340, complete: false, passes: 2,
    missing: ['20 of the 340 jobs the site says it has were not listed'], filters: [{ term: 'technician', applied: [{ what: 'keywords', how: 'search box + Enter' }], missed: [] }], errors: [] }] }) });
  assert.equal(out.status, 'partial');
  assert.match(out.reason, /Vandelay: 20 of the 340 jobs/);
  assert.equal(out.metrics.siteTotal, 340);
  assert.deepEqual(out.diagnostics.perSite[0].filters[0].applied, ['keywords: search box + Enter']);
});

test('validation: https start pages only, 1–10 sites, no repeats, a bounded page count', () => {
  const caps = discoverCapabilities(CAREER_SOURCE);
  assert.equal(validateConfig({ targets: [] }, caps).ok, false);
  const bad = validateConfig({ targets: [{ company: 'Vandelay', url: 'http://www.vandelay.example/careers' }, { company: '', url: 'https://a.example/' }, { company: 'X', url: 'https://user:pw@x.example/' }], limit: 61 }, caps);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
  const dup = validateConfig({ targets: [{ company: 'A', url: 'https://a.example/jobs#x' }, { company: 'B', url: 'https://a.example/jobs' }] }, caps);
  assert.match(dup.errors.join(' '), /repeats/);
  const ok = validateConfig({ targets: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers' }], limit: 5 }, caps);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config, { targets: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers' }], limit: 5, maxJobs: 3000 });
  assert.deepEqual(estimateWork(ok.config), { sites: 1, maxPages: 6, maxDetailCalls: 6, maxHarvestJobs: 3000, large: false });
  assert.equal(validateConfig({ targets: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers' }], maxJobs: 5001 }, caps).ok, false);
  assert.equal(validateConfig({ targets: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers' }], maxJobs: 1200 }, caps).config.maxJobs, 1200);
  const old = discoverCapabilities(CAREER_SOURCE.replace(/.*CAREER_SITE_MAX_JOBS.*\n/, ''));
  assert.equal(old.harvest, false, 'an older Seen checkout without the harvest');
  assert.equal(validateConfig({ targets: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers' }] }, old).config.maxJobs, undefined, 'no cap is passed to a collector that does not read one');
  assert.equal(cleanStartUrl('javascript:alert(1)'), null);
  assert.equal(ingestUrl('https://seen.example/api/ingest-local-indeed'), 'https://seen.example/api/ingest-local-career-jobs');
});

test('env: only the documented keys', () => {
  const env = buildEnv({ targets: [{ company: 'Vandelay', url: 'https://www.vandelay.example/careers' }], limit: 20 }, { SEEN_LOCAL_INGEST_TOKEN: 't', GITHUB_TOKEN: 'no' });
  assert.deepEqual(Object.keys(env).sort(), ['CAREER_SITE_LIMIT', 'CAREER_SITE_TARGETS_JSON', 'SEEN_LOCAL_INGEST_TOKEN']);
});

const summary = (sites) => JSON.stringify({ ok: true, dry_run: false, targets: sites.length, pages_read: sites.reduce((a, s) => a + s.pages_read, 0), postings_found: sites.reduce((a, s) => a + s.postings_found, 0), saved: sites.reduce((a, s) => a + s.saved, 0), sites }, null, 2);
const site = (o) => ({ company: 'Vandelay', start_url: 'https://www.vandelay.example/careers', links_found: 3, pages_read: 4, postings_found: 3, saved: 2, skipped: { other_employer: 1 }, errors: [], ...o });

test('interpretation: completed, partial, failed and blocked are told apart', () => {
  const ok = interpret({ code: 0, stdout: '[collect] Vandelay: 3 job links\n' + summary([site()]), stderr: '' });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.metrics.saved, 2);
  assert.equal(ok.metrics.skipped, 1);
  assert.equal(ok.diagnostics.perSite[0].linksFound, 3);

  const part = interpret({ code: 0, stdout: summary([site(), site({ company: 'Wonka', errors: ['https://x: timed out'] })]), stderr: '[skip] Wonka page https://x: timed out' });
  assert.equal(part.status, 'partial');
  assert.equal(part.diagnostics.warnings.length, 1);

  const none = interpret({ code: 0, stdout: summary([site({ pages_read: 0, postings_found: 0, saved: 0, errors: ['Browser Bridge extension is not connected'] })]), stderr: '' });
  assert.equal(none.status, 'blocked');
  assert.match(none.reason, /no career site could be opened/);

  const empty = interpret({ code: 0, stdout: summary([site({ postings_found: 0, saved: 0, skipped: {} })]), stderr: '' });
  assert.equal(empty.status, 'completed');
  assert.match(empty.reason, /no job data/);

  const dead = interpret({ code: 1, stdout: '', stderr: 'Error: Set SEEN_LOCAL_INGEST_TOKEN first.' });
  assert.equal(dead.status, 'blocked');
  assert.equal(dead.metrics.saved, undefined, 'nothing is invented when the collector printed no summary');
  assert.equal(interpret({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', cancelled: true }).status, 'cancelled');
});

test('readiness probes the career-site ingest endpoint with an empty, non-writing body', async () => {
  let probed = null;
  const r = await readiness({ repoDir: fakeRepo(), env: { SEEN_LOCAL_INGEST_TOKEN: 't' }, deps: { ...okProbes, probeIngestAuth: async (a) => { probed = a; return { status: 'ok', detail: 'ok' }; } } });
  assert.equal(probed.url, 'https://seen.example/api/ingest-local-career-jobs');
  assert.deepEqual(probed.emptyBody, { company: '', items: [] });
  assert.equal(r.checks.find((c) => c.id === 'repo').status, 'ok');
  const old = await readiness({ repoDir: fakeRepo({ career: null }), env: {}, deps: okProbes });
  assert.match(old.checks.find((c) => c.id === 'repo').fix, /git pull/);
});
