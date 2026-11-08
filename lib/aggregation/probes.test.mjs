import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeIngestAuth, probeIntelMigration, probeOpenCli, classifyBridgeOutput, safeEndpoint, probeSeenRepo } from './probes.mjs';
import { fakeRepo } from './testkit.mjs';
import { redact, tailLines } from './store.mjs';

const respond = (status, body = '{}') => async () => new Response(body, { status });

test('ingest auth probe sends an EMPTY batch (non-writing) and maps each answer honestly', async () => {
  let sent = null;
  const capture = async (url, opts) => { sent = opts; return new Response('{"error":"Provide 1–100"}', { status: 400 }); };
  const ok = await probeIngestAuth({ url: 'https://seen.example/api/ingest-local-indeed', token: 'tok', emptyBody: { jobs: [] }, fetchImpl: capture });
  assert.equal(ok.status, 'ok');
  assert.equal(sent.method, 'POST');
  assert.deepEqual(JSON.parse(sent.body), { jobs: [] });
  assert.equal(sent.headers.Authorization, 'Bearer tok');
  const u = { url: 'https://x.test/a', token: 't', emptyBody: { items: [] } };
  assert.equal((await probeIngestAuth({ ...u, fetchImpl: respond(401) })).status, 'unauthorized');
  assert.match((await probeIngestAuth({ ...u, fetchImpl: respond(401) })).detail, /not set in Vercel/);
  assert.equal((await probeIngestAuth({ ...u, fetchImpl: respond(404) })).status, 'not_deployed');
  assert.equal((await probeIngestAuth({ ...u, fetchImpl: respond(500) })).status, 'unknown');
  assert.equal((await probeIngestAuth({ ...u, fetchImpl: async () => { throw new Error('ENOTFOUND'); } })).status, 'unknown');
  assert.equal((await probeIngestAuth({ ...u, token: '' })).status, 'missing');
  assert.equal((await probeIngestAuth({ ...u, url: null })).status, 'invalid');
});

test('migration probe: present / missing (PGRST205) / unverifiable without credentials', async () => {
  const base = { supabaseUrl: 'https://p.supabase.co', serviceKey: 'k' };
  assert.equal((await probeIntelMigration({ ...base, fetchImpl: respond(200, '[]') })).status, 'ok');
  const missing = await probeIntelMigration({ ...base, fetchImpl: respond(404, '{"code":"PGRST205","message":"Could not find the table public.company_intel_imports"}') });
  assert.equal(missing.status, 'missing');
  assert.match(missing.fix, /owner approval/);
  assert.equal((await probeIntelMigration({ supabaseUrl: '', serviceKey: '' })).status, 'unknown');
  assert.equal((await probeIntelMigration({ ...base, fetchImpl: respond(401) })).status, 'unknown');
});

const fakeExec = (map) => (bin, args, opts, cb) => {
  const key = args.join(' ');
  const r = map[key];
  if (!r) { const e = new Error('spawn opencli ENOENT'); e.code = 'ENOENT'; return cb(e, '', ''); }
  if (r.code) { const e = new Error('exit'); e.code = r.code; e.killed = !!r.killed; return cb(e, r.stdout || '', r.stderr || ''); }
  return cb(null, r.stdout || '', r.stderr || '');
};

test('OpenCLI probe never calls a bare executable "ready"', async () => {
  const missing = await probeOpenCli({ execFileImpl: fakeExec({}), env: {} });
  assert.equal(missing.status, 'missing');
  const connected = await probeOpenCli({ execFileImpl: fakeExec({ '--version': { stdout: 'opencli 1.4.2\n' }, doctor: { stdout: '✓ Browser Bridge connected\n' } }), env: {} });
  assert.equal(connected.bridge, 'connected'); assert.equal(connected.status, 'ok'); assert.equal(connected.version, '1.4.2');
  const down = await probeOpenCli({ execFileImpl: fakeExec({ '--version': { stdout: '1.4.2' }, doctor: { code: 1, stdout: 'Browser Bridge: not connected' } }), env: {} });
  assert.equal(down.bridge, 'disconnected'); assert.equal(down.status, 'broken'); assert.match(down.fix, /Chrome/);
  const noDoctor = await probeOpenCli({ execFileImpl: fakeExec({ '--version': { stdout: '1.0.0' }, doctor: { code: 1, stderr: 'error: unknown command doctor' } }), env: {} });
  assert.equal(noDoctor.bridge, 'unverified'); assert.equal(noDoctor.status, 'degraded');
  assert.equal(classifyBridgeOutput('0 failed, all checks passed, connected', 0), 'connected');
  assert.equal(classifyBridgeOutput('daemon is not running', 1), 'disconnected');
  assert.equal(classifyBridgeOutput('', 0), 'unverified');
});

test('endpoint overrides must be https (or local http); repo probe needs a real Seen checkout', () => {
  assert.equal(safeEndpoint('', 'https://seenjobs.io/a'), 'https://seenjobs.io/a');
  assert.equal(safeEndpoint('http://attacker.test/a', 'https://seenjobs.io/a'), null);
  assert.equal(safeEndpoint('http://127.0.0.1:3000/a', 'x'), 'http://127.0.0.1:3000/a');
  assert.equal(probeSeenRepo('relative/path').status, 'missing');
  assert.equal(probeSeenRepo(fakeRepo(), ['scripts/ingest-indeed-opencli.mjs']).status, 'ok');
  assert.equal(probeSeenRepo(fakeRepo({ indeed: null }), ['scripts/ingest-indeed-opencli.mjs']).status, 'missing');
});

test('redaction removes token values, Bearer headers, token shapes and the home path', () => {
  const env = { SEEN_LOCAL_INGEST_TOKEN: 'super-secret-token-value', HOME: '/Users/you' };
  const text = 'Authorization: Bearer abc.def ghp_ABCDEFGHIJKL super-secret-token-value at /Users/you/seen';
  const out = redact(text, env);
  assert.doesNotMatch(out, /super-secret|abc\.def|ghp_ABCDEF|\/Users\/you/);
  assert.match(out, /~\/seen/);
  assert.equal(tailLines('a\n\nb\nc', { lines: 2, env }).join(','), 'b,c');
});
