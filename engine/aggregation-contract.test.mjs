// CONTRACT test: the manager drives Seen's REAL collector scripts end to end — real child process,
// real argv/env contract, real metrics parsing — against a FAKE `opencli` on PATH and a FAKE local
// Seen server. Nothing reaches Indeed, Reddit, Chrome, seenjobs.io or Supabase.
//
// Needs a Seen checkout (SEEN_PRODUCT_REPO_DIR, ../seen or ../Seen); skipped when there is none, so
// CI for this repo stays self-contained. Run it locally after pulling either repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAggregationManager } from './aggregation-manager.mjs';
import { createStore } from '../lib/aggregation/store.mjs';
import { until, FAKE_OPENCLI, fakeSeen } from '../lib/aggregation/testkit.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SEEN = [process.env.SEEN_PRODUCT_REPO_DIR, join(ROOT, '..', 'seen'), join(ROOT, '..', 'Seen')].filter(Boolean)
  .find((d) => existsSync(join(d, 'scripts', 'ingest-indeed-opencli.mjs')) && existsSync(join(d, 'scripts', 'collect-reddit-company-intel.mjs')));
const skip = SEEN ? false : 'no Seen checkout with both collector scripts next to this repo';

test('real Seen collectors, end to end, through the manager', { skip, timeout: 60_000 }, async () => {
  const tokens = { indeed: 'contract-indeed-token', intel: 'contract-intel-token' };
  const { srv, seen, port } = await fakeSeen(tokens);
  const bin = mkdtempSync(join(tmpdir(), 'agg-bin-')); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'opencli'), FAKE_OPENCLI); chmodSync(join(bin, 'opencli'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    const store = createStore({ base: mkdtempSync(join(tmpdir(), 'agg-contract-')) });
    store.writeConfig({ seenRepoDir: SEEN, pipelines: {
      indeed: { searches: [{ query: 'software engineer', location: 'Remote' }, { query: 'data analyst', location: 'Remote' }], resultsPerSearch: 3, maxPages: 2 },
      company_intel: { mode: 'import', companyLimit: 2, postsPerCompany: 1 },
    } });
    const env = { HOME: process.env.HOME, SEEN_LOCAL_INGEST_TOKEN: tokens.indeed, SEEN_COMPANY_INTEL_INGEST_TOKEN: tokens.intel, COMPANY_INTEL_SEARCH_GAP_MS: '0',
      SEEN_LOCAL_INGEST_URL: `http://127.0.0.1:${port}/api/ingest-local-indeed`, SEEN_COMPANY_INTEL_INGEST_URL: `http://127.0.0.1:${port}/api/ingest-local-company-intel` };
    const facts = [];
    const mgr = createAggregationManager({ maxAttempts: 1, // partial runs here are the fixture, not something to re-run
    store, env: () => env, recordFacts: (f) => { facts.push(...f); return { written: f.length }; },
      readinessDeps: { probeIntelMigration: async () => ({ status: 'ok', migration: 'm', detail: 'stubbed' }) } });

    // Readiness uses the REAL probes for OpenCLI (fake binary) and the token check (fake Seen).
    const h = await mgr.health({ refresh: true });
    assert.equal(h.pipelines.indeed.status, 'ready', JSON.stringify(h.pipelines.indeed.checks));
    assert.equal(h.pipelines.indeed.checks.find((c) => c.id === 'opencli').bridge, 'connected');
    assert.equal(h.pipelines.indeed.checks.find((c) => c.id === 'ingest-auth').status, 'ok');
    assert.equal(seen.indeed.length, 0, 'the readiness token check wrote nothing');

    const a = await mgr.startRun({ pipeline: 'indeed' });
    const b = await mgr.startRun({ pipeline: 'company_intel' });
    assert.equal(a.ok && b.ok, true);
    const ra = await until(() => { const r = store.readRun(a.run.id); return r && !['queued', 'running'].includes(r.status) && r; }, { tries: 3000 });
    const rb = await until(() => { const r = store.readRun(b.run.id); return r && !['queued', 'running'].includes(r.status) && r; }, { tries: 3000 });
    assert.ok(new Date(rb.startedAt) >= new Date(ra.endedAt), 'company intel waited for the Browser Bridge');

    // Indeed: 3 unique valid job keys, 1 cross-search duplicate, 1 detail that failed after the CLI's retries.
    assert.equal(ra.status, 'partial', ra.reason);
    assert.equal(ra.metrics.uniqueListings, 3);
    assert.equal(ra.metrics.sourceDuplicates, 1);
    assert.equal(ra.metrics.detailsSucceeded, 2);
    assert.equal(ra.metrics.detailsFailed, 1);
    assert.equal(ra.metrics.written, 2);
    assert.equal(ra.metrics.inserted, null);
    assert.equal(seen.indeed.length, 2);
    assert.ok(seen.indeed.every((j) => /^[0-9a-f]{16}$/.test(j.id)), 'Indeed job keys travel as ids (→ external_id)');
    assert.equal(ra.diagnostics.failureCategories[0].category, 'browser_bridge');

    // Company intel: existing companies only, raw excerpts with source URLs, one source failure.
    assert.equal(rb.status, 'partial', rb.reason);
    assert.equal(seen.targets, 1);
    assert.ok(seen.intel.length >= 1 && seen.intel.every((x) => x.require_existing === true), 'imports never allow company creation');
    const items = seen.intel.flatMap((x) => x.items);
    assert.ok(items.length >= 2 && items.every((i) => i.company === 'Acme Corp' && /^https:\/\/www\.reddit\.com\//.test(i.source_url)));
    assert.ok(items.some((i) => i.excerpt.startsWith('I interviewed at Acme Corp')), 'the person’s own words are kept verbatim');
    assert.equal(rb.metrics.importedReports, items.filter((i) => i.kind === 'applicant_outcome').length);
    assert.equal(rb.metrics.searchFailures, 1);
    assert.deepEqual(rb.diagnostics.sourceFailures.map((f) => f.company), ['Beta Inc']);
    assert.equal(rb.diagnostics.failureCategories[0].category, 'browser_bridge', 'the cause on execFile’s continuation line is classified');
    assert.ok(facts.some((f) => f.subject === 'seen:aggregation:indeed' && f.predicate === 'health'));
    assert.doesNotMatch(JSON.stringify(store.allRuns()), /contract-(indeed|intel)-token/, 'tokens never land in run history');

    // The company picker: a chosen list goes to the real collector, which then does NOT ask Seen for
    // targets (only checkouts that ship COMPANY_INTEL_COMPANIES_JSON — older ones refuse the list).
    if (mgr.getConfig().pipelines.company_intel.capabilities.explicitTargets) {
      const targetsBefore = seen.targets;
      const c = await mgr.startRun({ pipeline: 'company_intel', overrides: { companies: ['Acme Corp'], mode: 'dry_run' } });
      assert.equal(c.ok, true, JSON.stringify(c));
      let rc; for (let i = 0; i < 200; i++) { rc = mgr.getRun(c.run.id); if (['completed', 'partial', 'failed', 'blocked'].includes(rc.status)) break; await new Promise((r) => setTimeout(r, 50)); }
      assert.equal(seen.targets, targetsBefore, 'a chosen list never asks Seen for targets');
      assert.deepEqual(rc.diagnostics.perCompany.map((x) => x.company), ['Acme Corp']);
      assert.equal(rc.config.companies[0], 'Acme Corp');
    }
  } finally {
    process.env.PATH = oldPath;
    srv.close();
  }
});
