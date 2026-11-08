// Run: node --test lib/base-health-job.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBaseHealthJob, STALE_MS } from './base-health-job.mjs';

function fakeSpawn() {
  const calls = []; let child = null;
  const spawnFn = (bin, args, opts) => { child = new EventEmitter(); calls.push({ bin, args, opts }); return child; };
  return { spawnFn, calls, exit: (code) => child.emit('exit', code) };
}

test('"Check now" runs the CLI in a background process once; a second press while running starts nothing', () => {
  const sp = fakeSpawn();
  const job = createBaseHealthJob({ spawnFn: sp.spawnFn, execPath: '/node', script: '/repo/lib/base-health.mjs', read: () => ({ checkedAt: null }) });
  const a = job.start('manual');
  assert.equal(a.started, true);
  assert.deepEqual(sp.calls[0].args, ['/repo/lib/base-health.mjs', 'both']);
  assert.equal(sp.calls[0].opts.stdio, 'ignore');
  assert.equal(job.status().running, true);
  assert.equal(job.start('manual').alreadyRunning, true);
  assert.equal(sp.calls.length, 1);
  sp.exit(1); // a red/unknown base exits 1 — that is a finished check, not a failure to run
  assert.equal(job.status().running, false);
  assert.equal(job.status().exitCode, 1);
  assert.equal(job.status().error, null);
});

test('daily: due when a repo was never checked or its verdict is over 24h old; otherwise skipped', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const fresh = new Date(now.getTime() - 60_000).toISOString();
  const old = new Date(now.getTime() - STALE_MS - 1).toISOString();
  const mk = (verdicts) => createBaseHealthJob({ spawnFn: fakeSpawn().spawnFn, now: () => now, read: (r) => ({ checkedAt: verdicts[r] }) });
  assert.equal(mk({ tool: fresh, product: fresh }).due(), false);
  assert.equal(mk({ tool: fresh, product: null }).due(), true);
  assert.equal(mk({ tool: old, product: fresh }).due(), true);
  const j = mk({ tool: fresh, product: fresh });
  assert.equal(j.tick().skipped, true);
  assert.equal(mk({ tool: null, product: null }).tick().started, true);
});

test('a spawn that throws is reported, not swallowed', () => {
  const job = createBaseHealthJob({ spawnFn: () => { throw new Error('EACCES'); }, read: () => ({}) });
  const r = job.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /EACCES/);
  assert.equal(job.status().running, false);
});

test('a red verdict names the failing tests (both reporters, deduped), not an arbitrary log tail', async () => {
  const { failingTests } = await import('./base-health.mjs');
  const out = 'ok 1 - fine\nnot ok 2 - appendAccess never throws # SKIP\n✖ failing tests:\n✖ the same heading (92.3ms)\n✖ the same heading (92.3ms)\nnot ok 9 - lib/a.test.mjs';
  assert.deepEqual(failingTests(out), { total: 2, names: ['appendAccess never throws', 'the same heading'] });
  assert.equal(failingTests('ok 1 - fine').total, 0);
});

test('the base-branch gate runs the product suite WITHOUT the app’s credentials (same env as the builder gate)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'bh-env-'));
  const saved = { SEEN_HOME: process.env.SEEN_HOME, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  Object.assign(process.env, { SEEN_HOME: home, SUPABASE_URL: 'https://real-project.supabase.co', SUPABASE_SERVICE_KEY: 'real-service-key', GITHUB_TOKEN: 'ghp_real' });
  try {
    const { checkBaseHealth } = await import('./base-health.mjs');
    let gateEnv = null;
    const execFn = (bin, args, opts) => { if (bin !== 'git') gateEnv = opts.env; return ''; };
    const v = await checkBaseHealth({
      repo: 'product', configObj: { productRepoDir: () => '/repo', githubBranch: () => 'next-migration' },
      execFn, exists: (p) => p === '/repo' || p.endsWith('package.json'), read: () => JSON.stringify({ scripts: { test: 'node --test' } }),
      mkdtemp: () => '/tmp/wt', rm: () => {}, symlink: () => {},
    });
    assert.equal(v.green, true, v.reason);
    assert.ok(gateEnv, 'the gate ran');
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GITHUB_TOKEN']) assert.equal(gateEnv[k], undefined, `${k} must not reach the product's tests`);
    assert.ok(gateEnv.PATH && gateEnv.HOME !== undefined, 'paths still resolve');
    assert.equal(gateEnv.SEEN_HOME, home);
  } finally {
    for (const [k, val] of Object.entries(saved)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  }
});
