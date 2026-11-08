import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSearchCommand, planSearch, createSearch } from './search.mjs';

const CATALOG = [{ company: 'Acme', active_listings: 900 }, { company: 'Home Depot', active_listings: 400 }, { company: 'Acme Energy', active_listings: 3 }, { company: 'The Home Depot', active_listings: 2 }];

test('what a search is: company, company + keywords, field / niche', () => {
  assert.deepEqual(planSearch({ text: 'acme' }, CATALOG).company, 'Acme');
  const tk = planSearch({ text: 'Acme technician' }, CATALOG);
  assert.equal(tk.kind, 'company'); assert.equal(tk.keywords, 'technician');
  assert.deepEqual(tk.methods, ['career_site', 'seen_pull', 'indeed', 'applicant_reports', 'company_intel']);
  assert.equal(planSearch({ text: 'acme energy storage' }, CATALOG).company, 'Acme Energy', 'the longest name wins');
  assert.equal(planSearch({ text: 'home depot', keywords: 'cashier' }, CATALOG).keywords, 'cashier');
  const w = planSearch({ text: 'welder' }, CATALOG);
  assert.equal(w.kind, 'field'); assert.equal(w.field, 'welder'); assert.deepEqual(w.methods, ['indeed', 'seen_sources']);
  const u = planSearch({ text: '', url: 'https://www.acme.com/careers' }, []);
  assert.equal(u.kind, 'company'); assert.equal(u.company, 'acme'); assert.equal(u.url, 'https://www.acme.com/careers');
  assert.deepEqual(planSearch({ text: 'acme' }, CATALOG, { only: ['applicant_reports'] }).methods, ['applicant_reports']);
});

test('Board Room commands', () => {
  assert.deepEqual(parseSearchCommand('search acme technician jobs'), { text: 'acme technician', keywords: '', url: null, only: null });
  assert.equal(parseSearchCommand('find welder jobs').text, 'welder');
  assert.deepEqual(parseSearchCommand('pull jobs for Acme keywords technician, service'), { text: 'Acme', keywords: 'technician, service', url: null, only: null });
  assert.deepEqual(parseSearchCommand('collect reports for Walmart').only, ['applicant_reports', 'company_intel']);
  assert.equal(parseSearchCommand('search https://careers.acme.example/search/?site=US for acme').url, 'https://careers.acme.example/search/?site=US');
  assert.equal(parseSearchCommand('what did we ship today?'), null);
  assert.equal(parseSearchCommand('search'), null);
});

test('one search starts every method, groups the runs, and notifies once when all are done', async () => {
  const runs = new Map(); let n = 0; const started = []; const notes = [];
  const manager = {
    companyCatalog: async () => ({ ok: true, companies: CATALOG }),
    collectors: () => [{ id: 'indeed', capabilities: { resultsPerSearchMax: 25, maxPagesMax: 20 } }, { id: 'career_site', capabilities: { maxJobsMax: 20000 } }],
    startRun: async ({ pipeline, overrides, searchId }) => { const id = `r${++n}`; runs.set(id, { id, pipeline, status: 'queued', searchId }); started.push({ pipeline, overrides }); return { ok: true, run: { id, status: 'queued' } }; },
    getRun: (id) => runs.get(id),
    pullCompanyJobsDirect: async () => ({ ok: true, saved: 12, needsBrowser: [] }),
  };
  const d = mkdtempSync(join(tmpdir(), 'search-'));
  const s = createSearch({ manager, dir: () => d, notify: (x) => notes.push(x) });
  const r = await s.start({ text: 'acme technician' });
  assert.equal(r.ok, true);
  assert.deepEqual(started.map((x) => x.pipeline).sort(), ['applicant_reports', 'career_site', 'company_intel', 'indeed']);
  assert.deepEqual(started.find((x) => x.pipeline === 'career_site').overrides.targets, [{ company: 'Acme', keywords: 'technician' }]);
  assert.deepEqual(started.find((x) => x.pipeline === 'indeed').overrides.searches, [{ query: 'technician Acme', location: 'United States' }]);
  assert.equal(started.find((x) => x.pipeline === 'indeed').overrides.maxPages, 10, 'deep pages, not just the first');
  assert.equal(s.list()[0].steps.find((x) => x.method === 'seen_pull').result.saved, 12);
  assert.equal(notes.length, 0, 'not done yet');
  for (const run of runs.values()) { run.status = 'completed'; run.metrics = { saved: 5 }; s.onRunEnd(run); }
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Search “Acme · technician” finished/);
  assert.match(notes[0].body, /Career site \(Chrome\): completed, 5 jobs/);
  s.onRunEnd([...runs.values()][0]);
  assert.equal(notes.length, 1, 'one notification per search');
  assert.equal(s.list()[0].status, 'completed');
});

test('presets: every Indeed set + saved sets + quick starts survive, and one tap runs a tracked search', async () => {
  const started = []; const runs = new Map(); let n = 0;
  const PRE = { ok: true, maintenance: { week: 43, searches: [{ query: 'forklift operator', location: 'Remote' }, { query: 'welder', location: 'Houston, TX' }] },
    demand: { searches: [{ query: 'barista', location: 'Austin, TX' }] }, thin: { belowResults: 10, searches: [] }, niches: [{ id: 'trades', label: 'Skilled trades', searches: [{ query: 'electrician', location: 'Remote' }] }] };
  const manager = {
    indeedPresets: async () => PRE,
    getConfig: () => ({ pipelines: { indeed: { config: { presets: [{ name: 'My SoCal set', searches: [{ query: 'cashier', location: 'San Diego, CA' }] }] } } } }),
    collectors: () => [{ id: 'indeed', capabilities: { resultsPerSearchMax: 25, maxPagesMax: 10 } }],
    startRun: async ({ pipeline, overrides, searchId }) => { const id = `r${++n}`; runs.set(id, { id, status: 'queued', searchId }); started.push({ pipeline, overrides }); return { ok: true, run: { id, status: 'queued' } }; },
    getRun: (id) => runs.get(id), pullBoards: async () => ({ ok: true, saved: 40, boards: 200 }), companyCatalog: async () => ({ ok: true, companies: [] }),
  };
  const d = mkdtempSync(join(tmpdir(), 'search-'));
  const s = createSearch({ manager, dir: () => d, fetchImpl: async () => new Response(JSON.stringify({ jobs: [1, 2] }), { status: 200 }), notify: () => {} });
  const keys = (await s.presets()).presets.map((p) => p.key);
  assert.deepEqual(keys, ['maintenance', 'demand', 'niche:trades', 'saved:My SoCal set', 'reports:thinnest', 'boards:stalest'], 'an empty set is not offered; everything else is');
  const r = await s.start({ preset: 'maintenance' });
  assert.equal(r.ok, true);
  assert.deepEqual(started[0].overrides.searches, PRE.maintenance.searches);
  assert.equal(started[0].overrides.maxPages, 3);
  assert.equal(s.list()[0].kind, 'preset');
  assert.deepEqual(s.list()[0].steps.find((x) => x.method === 'seen_sources').result, { matched: 4, queries: 2 });
  await s.start({ preset: 'reports:thinnest' });
  assert.deepEqual(started[1].overrides, { mode: 'import', companies: [], fillBelow: 10, companyLimit: 25, goal: 10 });
  const b = await s.start({ preset: 'boards:stalest' });
  assert.equal(b.search.status, 'completed');
  assert.equal((await s.start({ preset: 'nope' })).code, 404);
});

test('chat commands: any search wording; "and import to seenjobs" is dropped; unrelated asks stay chat', () => {
  assert.deepEqual(parseSearchCommand('aggregate nasa jobs and import to seenjobs'), { text: 'nasa', keywords: '', url: null, only: null });
  assert.equal(parseSearchCommand('Can you find welder jobs and add them to seen').text, 'welder');
  assert.equal(parseSearchCommand('import nasa jobs').text, 'nasa');
  assert.equal(parseSearchCommand('get me amazon warehouse jobs').text, 'amazon warehouse');
  assert.equal(parseSearchCommand('please search for acme keywords technician').keywords, 'technician');
  assert.equal(parseSearchCommand('aggregate jobs from https://careers.nasa.gov and import into seenjobs.io').url, 'https://careers.nasa.gov/');
  assert.deepEqual(parseSearchCommand('collect applicant reports for Home Depot').only, ['applicant_reports', 'company_intel']);
  for (const t of ['add a task to fix the logo', 'get the build status', 'run the board meeting', 'import the brain backup']) assert.equal(parseSearchCommand(t), null, t);
});

test('a field search runs each related title in each chosen place', () => {
  const p = planSearch({ text: 'welder', keywords: 'fabricator, pipe welder, Welder', locations: ['Texas', 'Remote', 'Texas'] }, []);
  assert.equal(p.kind, 'field');
  assert.deepEqual(p.titles, ['welder', 'fabricator', 'pipe welder']);
  assert.deepEqual(p.locations, ['Texas', 'Remote']);
  assert.deepEqual(planSearch({ text: 'welder' }, []).locations, ['United States', 'Remote']);
  assert.deepEqual(planSearch({ text: 'Acme' }, [{ company: 'Acme', active_listings: 10 }]).locations, ['United States']);
});
