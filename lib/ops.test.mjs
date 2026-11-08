// Offline tests for the ops master-kit. Every external dependency is injected — nothing here touches
// the network, the vault, git, or gh. The recurring assertion theme: a FAILED source must surface as
// {error} or an errors[] entry, never as a clean empty result.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAllState, opsSnapshot, searchAll, credentialAudit, driftCheck, runQuery, exportLogs, diagnose } from './ops.mjs';
import { parseArgs, USAGE } from '../scripts/ops.mjs';

const CONFIG = {
  commandRepoDir: () => '/repo/command',
  productRepoDir: () => '/repo/product',
  commandRepo: () => 'o/command',
  githubRepo: () => 'o/product',
  githubBranch: () => 'next-migration',
  commandBranch: () => 'main',
  supabase: () => ({ url: 'https://sb.example', key: 'k' }),
  vercel: () => ({ token: 't', projectId: 'p', teamId: 'tm' }),
};

const PLATFORM = {
  at: '2026-08-13T00:00:00Z',
  credentials: { groups: [
    { id: 'github', label: 'GitHub', fields: [{ key: 'GITHUB_TOKEN', configured: true }] },
    { id: 'supabase', label: 'Supabase', fields: [{ key: 'SUPABASE_ACCESS_TOKEN', configured: true }] },
  ] },
  state: { runId: 'run-9', focusId: 'users', approvals: [{ id: 'a1', title: 'Ship it' }] },
  tasks: { openCount: 2, recent: [{ number: 7, title: 'Fix' }] },
  builds: { recent: [{ id: 'task-7', status: 'pr_ready' }] },
  activity: { recent: [{ kind: 'build' }] },
  brain: { available: true, factCount: 3 },
  repos: { commandRepo: { branch: 'main' } },
  health: {
    overall: 'broken',
    counts: { broken: 1, degraded: 0, missing: 0, healthy: 9 },
    checks: [
      { id: 'github', label: 'GitHub', status: 'healthy', detail: 'ok', fix: null },
      { id: 'supabase-advisors', label: 'Supabase advisors', status: 'broken', detail: 'HTTP 401', fix: 'mint a new token' },
      { id: 'supabase-db', label: 'Supabase database', status: 'healthy', detail: 'ok', fix: null },
    ],
  },
};

test('fetchAllState returns every connector and keeps degradation honest', async () => {
  const out = await fetchAllState({
    signals: async () => ({ status: { github: true }, github: { repo: 'o/p' }, admin: { notConfigured: true }, supabase: { error: 'down' }, vercel: null, stripe: null }),
    llmStatus: () => ({ groq: true }),
  });
  assert.equal(out.connectors.github.repo, 'o/p');
  assert.equal(out.connectors.admin.notConfigured, true);
  assert.equal(out.connectors.supabase.error, 'down');
  assert.equal(out.llm.groq, true);
});

test('opsSnapshot projects the platform snapshot deterministically', async () => {
  const out = await opsSnapshot({ platformStatus: async () => PLATFORM });
  assert.equal(out.runId, 'run-9');
  assert.equal(out.focus, 'users');
  assert.equal(out.pendingApprovals[0].id, 'a1');
  assert.equal(out.openTasks.count, 2);
  assert.equal(out.connectorHealth.overall, 'broken');
  assert.equal(out.brain.factCount, 3);
});

test('searchAll parses git grep hits and ranks facts, one step', () => {
  const out = searchAll({ query: 'writeFact' }, {
    config: CONFIG,
    exists: () => true,
    execFile: (bin, args, opts) => (opts.cwd === '/repo/command' ? 'lib/brain.mjs:12:writeFact call\n' : 'lib/server/writeFact.js:1:export\n'),
    currentFacts: () => [{ subject: 'brain', predicate: 'writer', object: 'writeFact.js', note: 'n.md', valid_from: '2026-08-01' }],
    rankFacts: (facts) => facts,
  });
  assert.equal(out.code.length, 2);
  assert.deepEqual(out.code[0], { repo: 'command', file: 'lib/brain.mjs', line: 12, text: 'writeFact call' });
  assert.equal(out.facts[0].subject, 'brain');
  assert.equal(out.errors, undefined);
});

test('searchAll: git grep exit 1 is "no matches", other failures are errors', () => {
  const noHit = new Error('no match'); noHit.status = 1; noHit.stderr = '';
  const boom = new Error('git exploded'); boom.status = 128;
  const out = searchAll({ query: 'zzz' }, {
    config: CONFIG,
    exists: () => true,
    execFile: (bin, args, opts) => { throw opts.cwd === '/repo/command' ? noHit : boom; },
    currentFacts: () => [],
    rankFacts: () => [],
  });
  assert.equal(out.code.length, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /exploded/);
});

test('searchAll requires a query', () => {
  assert.equal(searchAll({ query: '' }).error, 'query required');
});

test('credentialAudit joins configured booleans to live verdicts without values', async () => {
  const out = await credentialAudit({ platformStatus: async () => PLATFORM });
  const sb = out.connectors.find((c) => c.id === 'supabase');
  assert.equal(sb.live, 'broken');
  assert.equal(sb.credentials[0].configured, true);
  assert.match(sb.fix, /mint a new token/);
  const gh = out.connectors.find((c) => c.id === 'github');
  assert.equal(gh.live, 'healthy');
  assert.equal(JSON.stringify(out).includes('sbp_'), false);
});

test('driftCheck is honest when uncheckable and always carries lastRecorded', async () => {
  const out = await driftCheck({
    config: { ...CONFIG, vercel: () => null },
    execFile: () => { throw new Error('gh not authed'); },
    fetchFn: async () => { throw new Error('unreachable'); },
    currentFacts: () => [{ subject: 'Seen production deploy', predicate: 'merge_vs_deploy', object: 'in sync — abc123', valid_from: '2026-08-13' }],
  });
  assert.equal(out.checkable, false);
  assert.equal(out.drifted, null); // NOT false — uncheckable is not "in sync"
  assert.match(out.lastRecorded.verdict, /in sync/);
});

test('driftCheck detects drift live', async () => {
  const out = await driftCheck({
    config: CONFIG,
    execFile: () => 'aaaa\n',
    fetchFn: async () => ({ ok: true, json: async () => ({ deployments: [{ state: 'READY', meta: { githubCommitSha: 'bbbb' }, created: Date.now() - 120000 }] }) }),
    currentFacts: () => [],
  });
  assert.equal(out.checkable, true);
  assert.equal(out.drifted, true);
  assert.equal(out.branchSha, 'aaaa');
  assert.equal(out.prodSha, 'bbbb');
});

test('runQuery facts filters by subject/predicate/contains', async () => {
  const deps = { currentFacts: () => [
    { subject: 'Seen', predicate: 'users_total', object: '1200' },
    { subject: 'Seen', predicate: 'active_jobs', object: '12345' },
  ] };
  const out = await runQuery({ target: 'facts', predicate: 'users' }, deps);
  assert.equal(out.count, 1);
  assert.equal(out.rows[0].object, '1200');
});

test('runQuery db is GET-only, validates the table, and surfaces non-2xx', async () => {
  let captured;
  const deps = {
    config: CONFIG,
    fetchFn: async (url, opts) => { captured = { url, opts }; return { ok: true, text: async () => '[{"id":1}]' }; },
  };
  const ok = await runQuery({ target: 'db', table: 'jobs', filter: 'status=eq.active' }, deps);
  assert.equal(ok.count, 1);
  assert.match(captured.url, /\/rest\/v1\/jobs\?/);
  assert.match(captured.url, /status=eq\.active/);
  assert.equal(captured.opts.method, undefined); // GET

  assert.match((await runQuery({ target: 'db', table: 'jobs; drop' }, deps)).error, /table must match/);

  const bad = await runQuery({ target: 'db', table: 'jobs' }, { config: CONFIG, fetchFn: async () => ({ ok: false, status: 400, text: async () => 'column missing' }) });
  assert.equal(bad.error, 'HTTP 400');
  assert.match(bad.body, /column missing/);
});

test('runQuery rejects unknown targets with the valid list', async () => {
  const out = await runQuery({ target: 'nope' });
  assert.match(out.error, /facts, db, activity, builds, state/);
});

test('runQuery state walks a dot path', async () => {
  const out = await runQuery({ target: 'state', path: 'debrief.focus' }, { loadState: () => ({ debrief: { focus: { id: 'users' } } }) });
  assert.equal(out.value.id, 'users');
});

test('exportLogs writes a bundle where failed sections say so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-'));
  const out = await exportLogs({
    dataDir: () => dir,
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => writeFileSync(p, c),
    config: CONFIG,
    execFile: (bin, args) => {
      if (args[0] === 'api') return JSON.stringify([{ id: 1, name: 'tests', head_branch: 'main', head_sha: 'abc', status: 'completed', conclusion: 'failure', html_url: 'u', created_at: '2026-08-13' }]);
      throw new Error('gh run view unavailable');
    },
    fetchFn: async () => ({ ok: false, status: 403 }),
    listBuilds: () => { throw new Error('no records'); },
    readActivity: () => [{ kind: 'build' }],
    platformStatus: async () => PLATFORM,
  });
  assert.ok(out.files.includes('ci.json'));
  assert.ok(out.files.includes('ci-failed.txt'));
  const failedLog = readFileSync(join(out.dir, 'ci-failed.txt'), 'utf8');
  assert.match(failedLog, /could not fetch failed-run log/);
  const vercel = readFileSync(join(out.dir, 'vercel.json'), 'utf8');
  assert.match(vercel, /HTTP 403/);
  const builds = readFileSync(join(out.dir, 'builds.json'), 'utf8');
  assert.match(builds, /no records/);
  assert.ok(readdirSync(out.dir).length >= 5);
});

test('diagnose runs no git without --fix and reports safe actions with it', async () => {
  const calls = [];
  const deps = {
    platformStatus: async () => PLATFORM,
    config: CONFIG,
    exists: () => true,
    execFile: (bin, args, opts) => { calls.push(args.join(' ')); return args[0] === 'rev-list' ? '0\t3\n' : ''; },
  };
  const dry = await diagnose({ fix: false }, deps);
  assert.equal(calls.length, 0);
  assert.equal(dry.actions.length, 0);
  assert.match(dry.remediation[0].fix, /mint a new token/);

  const fixed = await diagnose({ fix: true }, deps);
  assert.ok(calls.some((c) => c.startsWith('fetch origin')));
  assert.equal(fixed.actions.length, 2);
  assert.match(fixed.actions[0].result, /behind origin\/main.*merge --ff-only/);
  assert.ok(fixed.after);
});

test('CLI parseArgs handles words and flags', () => {
  assert.deepEqual(parseArgs(['search', 'ghost', 'rate', '--limit', '5']),
    { cmd: 'search', words: ['ghost', 'rate'], flags: { limit: '5' } });
  assert.deepEqual(parseArgs(['diagnose', '--fix']).flags, { fix: true });
  assert.equal(parseArgs([]).cmd, 'help');
  assert.ok(USAGE.commands.state);
});
