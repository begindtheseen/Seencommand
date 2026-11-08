// Test helpers for the aggregation suite (imported only by *.test.mjs). Nothing here touches the
// network, a real OpenCLI, Chrome, Seen, Supabase or the real Chronos vault.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';

// The option lines that capability discovery reads, copied from Seen's real CLIs (2026-10-19).
export const INDEED_SOURCE = `
export function configFromEnv(env = process.env) {
  if (!env.SEEN_LOCAL_INGEST_TOKEN) throw new Error('Set SEEN_LOCAL_INGEST_TOKEN to the Vercel LOCAL_INDEED_INGEST_SECRET.');
  const limit = parsePositiveInt(env.INDEED_RESULTS_PER_SEARCH, 'INDEED_RESULTS_PER_SEARCH', { fallback: 20, max: 25 });
  const maxPages = parsePositiveInt(env.INDEED_MAX_PAGES, 'INDEED_MAX_PAGES', { fallback: 1, max: 100 });
  const maxSearches = env.INDEED_MAX_SEARCHES === undefined ? Infinity : parsePositiveInt(env.INDEED_MAX_SEARCHES, 'INDEED_MAX_SEARCHES', { fallback: Infinity });
  const concurrency = parsePositiveInt(env.INDEED_DETAIL_CONCURRENCY, 'INDEED_DETAIL_CONCURRENCY', { fallback: 1, max: 1 });
  return { endpoint: env.SEEN_LOCAL_INGEST_URL || 'https://seen.example/api/ingest-local-indeed' };
}
async function retry(task, { attempts = 2, delayMs = 750, random = Math.random } = {}) {}
// opencli(['indeed', 'search', query, '--location', location, '--limit', String(cfg.limit), '--start', String(page * 10), '-f', 'json'])
const metrics = { detail_requests_failed: 0 };
`;

export const INTEL_SOURCE = `
const base = (process.env.SEEN_COMPANY_INTEL_INGEST_URL || 'https://seen.example/api/ingest-local-company-intel');
const targetCount = Math.min(100, Math.max(1, Number(process.env.COMPANY_INTEL_COMPANY_LIMIT) || 10));
const postLimit = Math.min(10, Math.max(1, Number(process.env.COMPANY_INTEL_POSTS_PER_COMPANY) || 3));
const dryRun = process.argv.includes('--dry-run');
import { censorExcerpt } from '../lib/server/companyIntelImport.js';
import { rankAndFilter } from '../api/_utils/companyReddit.js';
posts = await opencli(['reddit', 'search', jobQuery(target.company), '--sort', 'relevance']);
body: JSON.stringify({ items, require_existing: true });
rawItems.push({ company: target.company, source_url: url, excerpt });
`;

// The option lines of Seen's career-site collector (scripts/collect-career-site.mjs, Seen c07a5c3).
export const CAREER_SOURCE = `
const limit = Math.min(60, Math.max(1, Number(process.env.CAREER_SITE_LIMIT) || 20));
const maxJobs = Math.min(5000, Math.max(1, Number(process.env.CAREER_SITE_MAX_JOBS) || 3000));
const dryRun = process.argv.includes('--dry-run');
if (process.env.CAREER_SITE_TARGETS_JSON) {}
const out = list.map((t) => ({ company: clean(t?.company), url: safeStartUrl(t?.url) })).filter((t) => t.company && t.url).slice(0, 10);
`;

// The option lines of Seen's archive applicant-report collector (scripts/collect-archive-reports.mjs, Seen 6ee8071).
export const ARCHIVE_SOURCE = `
import { runCollection } from '../lib/reports/collectorRun.js';
import { redditArchiveSource } from '../lib/reports/archiveSource.js';
const base = (process.env.SEEN_COMPANY_INTEL_INGEST_URL || 'https://seen.example/api/ingest-local-company-intel').replace(/x/, '');
const goal = int(process.env.ARCHIVE_REPORTS_GOAL, 0, 100000, 10);
const years = int(process.env.ARCHIVE_REPORTS_YEARS, 1, 10, 5);
const minutes = int(process.env.ARCHIVE_REPORTS_MINUTES_PER_COMPANY, 1, 240, 20);
const totalMinutes = int(process.env.ARCHIVE_REPORTS_TOTAL_MINUTES, 1, 1440, null);
const companyLimit = int(process.env.ARCHIVE_REPORTS_COMPANY_LIMIT, 1, 100, 10);
const below = int(process.env.ARCHIVE_REPORTS_BELOW, 1, 10000, null);
const dryRun = process.argv.includes('--dry-run');
const SOURCE_IDS = ['reddit'];
if (!names.length || names.length > 500) throw new Error('ARCHIVE_REPORTS_COMPANIES_JSON must name 1–500 companies.');
body: JSON.stringify({ items, require_existing: true });
Object.assign(row, { new_reports: dryRun ? null : row.imported });
`;

// Seen 2026-10-21 moved the archive source (where each item keeps its link) into this shared module.
export const ARCHIVE_SOURCE_MODULE = `
import { censorExcerpt } from '../server/companyIntelImport.js';
export function redditArchiveSource() {
  return { toItem: (company, a) => ({ company, source: \`Reddit r/\${a.subreddit}\`, source_url: a.url, excerpt: censorExcerpt(a.excerpt) }) };
}
`;
export const ARCHIVE_IMPORTS = [{ path: 'lib/reports/archiveSource.js', source: ARCHIVE_SOURCE_MODULE }];

// The option lines of Seen's Google applicant-report collector (scripts/collect-web-reports.mjs, Seen 0fd4462).
export const WEB_SOURCE = `
import { runCollection } from '../lib/reports/collectorRun.js';
import { censorExcerpt } from '../lib/server/companyIntelImport.js';
const base = (process.env.SEEN_COMPANY_INTEL_INGEST_URL || 'https://seen.example/api/ingest-local-company-intel').replace(/x/, '');
const goal = int(process.env.WEB_REPORTS_GOAL, 0, 100000, 10);
const minutes = int(process.env.WEB_REPORTS_MINUTES_PER_COMPANY, 1, 240, 15);
const totalMinutes = int(process.env.WEB_REPORTS_TOTAL_MINUTES, 1, 1440, null);
const companyLimit = int(process.env.WEB_REPORTS_COMPANY_LIMIT, 1, 100, 10);
const below = int(process.env.WEB_REPORTS_BELOW, 1, 10000, null);
const searchGapSeconds = int(process.env.WEB_REPORTS_SEARCH_GAP_SECONDS, 10, 600, 25);
const pagesPerCompany = int(process.env.WEB_REPORTS_PAGES_PER_COMPANY, 1, 200, 30);
const dryRun = process.argv.includes('--dry-run');
if (!names.length || names.length > 500) throw new Error('WEB_REPORTS_COMPANIES_JSON must name 1–500 companies.');
body: JSON.stringify({ items, require_existing: true });
toItem: (company, a) => ({ company, source_url: a.url, excerpt: censorExcerpt(a.excerpt) });
`;

export function fakeRepo({ indeed = INDEED_SOURCE, intel = INTEL_SOURCE, career = CAREER_SOURCE, archive = ARCHIVE_SOURCE, web = WEB_SOURCE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agg-seen-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'seen', type: 'module' }));
  if (indeed != null) writeFileSync(join(dir, 'scripts', 'ingest-indeed-opencli.mjs'), indeed);
  if (intel != null) writeFileSync(join(dir, 'scripts', 'collect-reddit-company-intel.mjs'), intel);
  if (career != null) writeFileSync(join(dir, 'scripts', 'collect-career-site.mjs'), career);
  if (archive != null) {
    writeFileSync(join(dir, 'scripts', 'collect-archive-reports.mjs'), archive);
    mkdirSync(join(dir, 'lib', 'reports'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'reports', 'archiveSource.js'), ARCHIVE_SOURCE_MODULE);
  }
  if (web != null) writeFileSync(join(dir, 'scripts', 'collect-web-reports.mjs'), web);
  return dir;
}

// A controllable child process: the test writes stdout/stderr and decides when/how it exits.
export function fakeSpawn() {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = undefined; // never a real pid → cancel falls back to child.kill (no real signal sent)
    child.killed = [];
    child.kill = (sig) => { child.killed.push(sig); if (child.onKill) child.onKill(sig); return true; };
    child.finish = (code = 0, { stdout = '', stderr = '', signal = null } = {}) => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', code, signal); });
    };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawnImpl, calls };
}

export const okProbes = {
  probeIngestAuth: async () => ({ status: 'ok', detail: 'accepted' }),
  probeIntelMigration: async () => ({ status: 'ok', migration: '20261019160000_company_intel_imports.sql', detail: 'present' }),
  probeOpenCli: async () => ({ installed: true, version: '1.0.0', bridge: 'connected', status: 'ok', detail: 'connected' }),
  probeArchive: async () => ({ status: 'ok', detail: 'the archive answered' }),
};

export const tick = () => new Promise((r) => setImmediate(r));
export async function until(fn, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('condition never became true');
}

// A stand-in `opencli` (Indeed + Reddit adapters) for the contract test and the browser smoke run.
export const FAKE_OPENCLI = `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = (v) => { process.stdout.write(JSON.stringify(v)); };
if (a[0] === '--version') { console.log('opencli 9.9.9-fake'); process.exit(0); }
if (a[0] === 'doctor') { console.log('✓ Browser Bridge connected'); process.exit(0); }
if (a[0] === 'indeed' && a[1] === 'search') {
  const start = Number(a[a.indexOf('--start') + 1]);
  if (start > 0) { out([]); process.exit(0); }
  if (a[2] === 'data analyst') { out([{ id: '1111111111111111' }, { id: '333333333333333f' }]); process.exit(0); } // 1 overlaps the first search
  out([{ id: '1111111111111111' }, { id: '2222222222222222' }, { id: 'not-a-job-key' }]); process.exit(0);
}
if (a[0] === 'indeed' && a[1] === 'job') {
  const id = a[2];
  if (id.endsWith('f')) { console.error('Browser Bridge: tab crashed while reading the job'); process.exit(1); }
  out({ title: 'Data Engineer', company: 'Acme Corp', location: 'Remote', description: 'Fully remote. Work from home anywhere in the US.', url: 'https://www.indeed.com/viewjob?jk=' + id + '&from=serp', job_type: 'Full-time' });
  process.exit(0);
}
if (a[0] === 'reddit' && a[1] === 'search') {
  if (a[2].includes('Beta Inc')) { console.error('Browser Bridge extension is not connected'); process.exit(1); }
  out([{ id: 'p1abc', title: 'Acme Corp interview — ghosted after the final round', url: 'https://www.reddit.com/r/recruitinghell/comments/p1abc/acme/', subreddit: 'recruitinghell', selftext: 'Acme Corp recruiter went silent', created: new Date().toISOString() }]);
  process.exit(0);
}
if (a[0] === 'reddit' && a[1] === 'read') {
  out([{ body: 'I interviewed at Acme Corp for a data role and they ghosted me after the final round, no response at all.', url: 'https://www.reddit.com/r/recruitinghell/comments/p1abc/acme/c1' },
       { body: 'Their benefits page says they value candidates, which is an interesting claim for any company to make.', url: 'https://www.reddit.com/r/recruitinghell/comments/p1abc/acme/c2' }]);
  process.exit(0);
}
console.error('fake opencli: unsupported ' + a.join(' ')); process.exit(2);
`;

// A stand-in Seen deployment exposing the three local-ingest endpoints with their real auth/400 rules.
export function fakeSeen(tokens) {
  const seen = { indeed: [], intel: [], targets: 0 };
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      const auth = req.headers.authorization;
      const body = b ? JSON.parse(b) : {};
      if (req.url === '/api/ingest-local-indeed' && req.method === 'POST') {
        if (auth !== `Bearer ${tokens.indeed}`) return json(401, { error: 'Unauthorized' });
        if (!body.jobs?.length) return json(400, { error: 'Provide 1–100 Indeed jobs.' });
        seen.indeed.push(...body.jobs);
        return json(200, { ok: true, received: body.jobs.length, accepted: body.jobs.length, rejected: 0, deduplicated: 0, upserted: body.jobs.length, dropped: 0, inserted: null, updated: null });
      }
      if (req.url.startsWith('/api/local-company-intel-targets') && req.method === 'GET') {
        if (auth !== `Bearer ${tokens.intel}`) return json(401, { error: 'Unauthorized' });
        seen.targets++;
        return json(200, { ok: true, companies: [{ company: 'Acme Corp', active_listings: 4, existing_reports: 1 }, { company: 'Beta Inc', active_listings: 1, existing_reports: 0 }], scanned_active_companies: 2 });
      }
      if (req.url === '/api/ingest-local-company-intel' && req.method === 'POST') {
        if (auth !== `Bearer ${tokens.intel}`) return json(401, { error: 'Unauthorized' });
        if (!body.items?.length) return json(400, { error: 'Provide 1–100 source-attributed items.' });
        seen.intel.push(body);
        const reports = body.items.filter((i) => i.kind === 'applicant_outcome').length;
        return json(200, { ok: true, received: body.items.length, accepted: body.items.length, imported_reports: reports, commentary: body.items.length - reports, duplicates: 0, rejected: 0, errors: [] });
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, port: srv.address().port })));
}

