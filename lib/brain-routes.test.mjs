// lib/brain-routes.mjs — the Chronos app's main process, now inside Seen Command's server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createBrainHub, localRequest, looksLikeVault, legacyChronosVault, upsertEnvLine, handleBrainRoute } from './brain-routes.mjs';
import { addFact, appendTimeline, logDecision } from '../brain/lib/memory-write.mjs';

const ORIG_VAULT = process.env.CHRONOS_VAULT;
const HUBS = []; // every hub is stopped at the end: a hub that chose a vault folder is watching it
after(() => { for (const h of HUBS) h.stop(); if (ORIG_VAULT === undefined) delete process.env.CHRONOS_VAULT; else process.env.CHRONOS_VAULT = ORIG_VAULT; });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'brain-routes-'));
  const vault = join(root, 'memory');
  mkdirSync(vault, { recursive: true });
  addFact(vault, { note: 'knowledge/seen.md', subject: 'Seen', predicate: 'active_jobs', object: '12345', valid_from: '2026-10-08', by: 'claude-seenjobs', source: 'live probe' });
  addFact(vault, { note: 'knowledge/seen.md', subject: 'Seen', predicate: 'mrr', object: '$0', valid_from: '2026-10-01', by: 'seen-command' });
  appendTimeline(vault, { heading: '4am — seenjobs.io: digest', text: 'listings fresh, nothing broke' });
  logDecision(vault, { title: 'Chronos folds into Seen Command', body: 'one app' });
  mkdirSync(join(vault, '.access'), { recursive: true });
  appendFileSync(join(vault, '.access', 'requests.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), tool: 'brain_search_facts', mode: 'read', by: 'codex', args: 'q', ok: true, ms: 4 })}\n`);
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify({ generatedAt: '2026-10-21T15:00:00.000Z', memoryGraph: { nodes: [{ id: 'Seen', label: 'Seen', group: 'entity' }, { id: 'mrr', label: 'mrr: $0', group: 'value' }], links: [{ source: 'Seen', target: 'mrr', kind: 'fact' }] } }));
  const envFile = join(root, '.env');
  return { root, vault, statePath, envFile };
}

function hubFor(fx, extra = {}) {
  process.env.CHRONOS_VAULT = fx.vault;
  const copied = [];
  const hub = createBrainHub({
    statePath: () => fx.statePath, envFile: () => fx.envFile, inline: true, pollMs: 0, home: fx.root, log: () => {},
    deps: {
      buildLive: null, cloudConfigured: () => false, syncDown: async () => ({ changed: 0 }), fetchBrainAccess: async () => [],
      syncAccessClient: async () => ({ synced: true }), clipboard: async (s) => { copied.push(s); return true; }, legacy: () => null,
      ...(extra.deps || {}),
    },
    ...(extra.opts || {}),
  });
  HUBS.push(hub);
  return { hub, copied };
}

// A request the way node:http hands it over: a readable body, a socket, headers.
function call(hub, method, path, { body, headers = {}, remote = '127.0.0.1', opts } = {}) {
  const req = new PassThrough();
  req.method = method; req.url = path; req.socket = { remoteAddress: remote };
  req.headers = { host: 'localhost:4173', ...(method === 'POST' ? { origin: 'http://localhost:4173', 'content-type': 'application/json' } : {}), ...headers };
  const out = { status: 0, headers: {}, chunks: [] };
  const res = {
    writeHead(code, h) { out.status = code; out.headers = h || {}; return res; },
    end(b) { if (b) out.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b))); out.done = true; },
  };
  const p = hub.handle(req, res, path.split('?')[0], opts);
  req.end(body ? JSON.stringify(body) : undefined);
  return p.then((handled) => {
    out.handled = handled;
    out.raw = Buffer.concat(out.chunks);
    const text = out.headers['content-encoding'] === 'gzip' ? gunzipSync(out.raw).toString('utf8') : out.raw.toString('utf8');
    try { out.json = text ? JSON.parse(text) : null; } catch { out.json = null; }
    return out;
  });
}

test('localRequest: only this Mac — loopback socket, localhost Host, and a localhost Origin on writes', () => {
  const r = (remote, headers) => ({ socket: { remoteAddress: remote }, headers });
  assert.equal(localRequest(r('127.0.0.1', { host: 'localhost:4173' })), true);
  assert.equal(localRequest(r('::ffff:127.0.0.1', { host: '127.0.0.1:4173' })), true);
  assert.equal(localRequest(r('10.0.0.5', { host: 'localhost:4173' })), false, 'another machine');
  assert.equal(localRequest(r('127.0.0.1', { host: 'evil.example:4173' })), false, 'DNS rebinding');
  assert.equal(localRequest(r('127.0.0.1', { host: 'localhost:4173', origin: 'https://evil.example' })), false, 'cross-site read');
  assert.equal(localRequest(r('127.0.0.1', { host: 'localhost:4173' }), { write: true }), false, 'a write needs an Origin');
  assert.equal(localRequest(r('127.0.0.1', { host: 'localhost:4173', origin: 'http://localhost:4173' }), { write: true }), true);
});

test('route shapes: status, sources, graph (= graph:request), activity, overnight, health', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  const st = await call(hub, 'GET', '/api/brain/status');
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.json.versions).sort(), ['access', 'live', 'state', 'vault']);
  assert.equal(st.json.sources.vaultFound, true);
  assert.equal(st.json.sources.vaultPath, fx.vault);
  assert.match(st.json.sources.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(st.json.sources.version, /^Seen Command v/);

  const src = await call(hub, 'GET', '/api/brain/sources');
  for (const k of ['statePath', 'vaultPath', 'stateFound', 'vaultFound', 'seenCommandRoot', 'today', 'version', 'cloud']) assert.ok(k in src.json, k);

  const g = await call(hub, 'GET', '/api/brain/graph');
  assert.equal(g.status, 200);
  assert.ok(g.headers.etag, 'etag');
  assert.deepEqual(Object.keys(g.json).sort(), ['counts', 'dateRange', 'generated', 'links', 'live', 'nodes', 'sources', 'stateFound', 'vaultFound']);
  assert.equal(g.json.vaultFound, true); assert.equal(g.json.stateFound, true);
  assert.ok(g.json.nodes.some((n) => n.origin === 'chronos') && g.json.nodes.some((n) => n.origin === 'command'));
  assert.equal(g.json.counts.total.nodes, g.json.nodes.length);

  const again = await call(hub, 'GET', '/api/brain/graph', { headers: { 'if-none-match': g.headers.etag } });
  assert.equal(again.status, 304, 'an unchanged graph costs a 304');
  const zipped = await call(hub, 'GET', '/api/brain/graph', { headers: { 'accept-encoding': 'gzip, deflate' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.json.nodes.length, g.json.nodes.length);

  const a = await call(hub, 'GET', '/api/brain/activity');
  for (const k of ['recent', 'all', 'requests', 'sessions', 'counts', 'vaultPath']) assert.ok(k in a.json, k);
  assert.ok(a.json.all.some((r) => r.subject === 'Seen' && r.predicate === 'active_jobs'));
  assert.equal(a.json.requests[0].tool, 'brain_search_facts');

  const o = await call(hub, 'GET', '/api/brain/overnight');
  assert.ok(o.json.entries.some((e) => e.lane === 'seenjobs.io'), 'the 4am digest is badged');
  assert.equal(o.json.sources.vaultFound, true);

  const h = await call(hub, 'GET', '/api/brain/health');
  for (const k of ['facts', 'currentFacts', 'contradictions', 'stale', 'clean', 'verdict', 'sources']) assert.ok(k in h.json, k);
  assert.equal(h.json.facts, 2);
});

test('a path that is not a Brain route is left to the server (POST /api/brain/record keeps working)', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  const r = await call(hub, 'POST', '/api/brain/record', { body: { kind: 'note', text: 'x' } });
  assert.equal(r.handled, false); assert.equal(r.status, 0);
  assert.equal(await handleBrainRoute({}, {}, '/api/home'), false);
});

test('access routes answer only to this Mac', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  const remote = await call(hub, 'GET', '/api/brain/access', { remote: '192.168.1.20' });
  assert.equal(remote.status, 403);
  const noOrigin = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'x' }, headers: { origin: '' } });
  assert.equal(noOrigin.status, 403);
  const foreign = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const list = await call(hub, 'GET', '/api/brain/access');
  assert.deepEqual(list.json.clients, [], 'nothing was issued by the refused calls');
});

test("writes also pass the server's own gate (credentialRequestAllowed, handed in as localOnly); reads do not need an Origin", async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  const seen = [];
  const deny = (req) => { seen.push(req.url); return false; };
  const refused = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'gate-test', scopes: ['read'] }, opts: { localOnly: deny } });
  assert.equal(refused.status, 403);
  assert.deepEqual(seen, ['/api/brain/access/issue'], 'the server gate was consulted');
  const refresh = await call(hub, 'POST', '/api/brain/refresh', { body: {}, opts: { localOnly: deny } });
  assert.equal(refresh.status, 403, 'every write, not only credentials');
  const read = await call(hub, 'GET', '/api/brain/access', { opts: { localOnly: deny } });
  assert.equal(read.status, 200, 'a same-origin GET carries no Origin, so reads use the loopback + Host check');
  assert.deepEqual(read.json.clients, []);
  const ok = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'gate-test', scopes: ['read'] }, opts: { localOnly: () => true } });
  assert.equal(ok.status, 200);
});

test('a secret is in exactly one response, never stored or logged, and copies once', async () => {
  const fx = fixture(); const { hub, copied } = hubFor(fx);
  const logged = [];
  const orig = { out: process.stdout.write, err: process.stderr.write, log: console.log, error: console.error, warn: console.warn };
  const grab = (...a) => { logged.push(a.map(String).join(' ')); return true; };
  process.stdout.write = grab; process.stderr.write = grab; console.log = grab; console.error = grab; console.warn = grab;
  let issued, copy1, copy2, list, rotated;
  try {
    issued = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'codex-test', scopes: ['read'], expiresAt: null, installLocal: false } });
    copy1 = await call(hub, 'POST', '/api/brain/access/copy-once', { body: { copyId: issued.json.copyId } });
    copy2 = await call(hub, 'POST', '/api/brain/access/copy-once', { body: { copyId: issued.json.copyId } });
    list = await call(hub, 'GET', '/api/brain/access');
    rotated = await call(hub, 'POST', '/api/brain/access/rotate', { body: { id: issued.json.client.id } });
  } finally { Object.assign(process.stdout, { write: orig.out }); Object.assign(process.stderr, { write: orig.err }); console.log = orig.log; console.error = orig.error; console.warn = orig.warn; }

  const secret = issued.json.secret;
  assert.equal(issued.status, 200);
  assert.match(secret, /^chr_[A-Za-z0-9_-]{40,}$/);
  assert.equal(issued.headers['cache-control'], 'no-store');
  assert.ok(!('verifier' in issued.json.client) && !('salt' in issued.json.client) && !('lookup' in issued.json.client));
  assert.ok(!readFileSync(join(fx.vault, '.access', 'clients.json'), 'utf8').includes(secret), 'the registry keeps only a verifier');
  assert.ok(!JSON.stringify(list.json).includes(secret), 'listing never carries a secret');
  assert.equal(list.json.clients.length, 1);
  assert.equal(copy1.status, 200); assert.equal(copy1.json.copied, true);
  assert.deepEqual(copied, [secret], 'the clipboard got it — the copy request carried only the copy id');
  assert.equal(copy2.status, 410, 'a second copy is refused');
  assert.ok(!JSON.stringify(copy2.json).includes(secret));
  assert.ok(!logged.join('\n').includes(secret), 'never logged');
  assert.equal(rotated.status, 200);
  assert.match(rotated.json.secret, /^chr_/); assert.notEqual(rotated.json.secret, secret);
  assert.ok(rotated.json.copyId && rotated.json.copyId !== issued.json.copyId);
});

test('install on this Mac: the secret goes to an owner-only file and is NOT sent back', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  const home = process.env.HOME; process.env.HOME = fx.root;
  try {
    const r = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'local-mac', scopes: ['read', 'write'], installLocal: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.secret, undefined); assert.equal(r.json.copyId, undefined);
    assert.equal(r.json.secretInstalled, true);
    assert.ok(r.json.credentialFile.startsWith(fx.root));
    assert.equal(statSync(r.json.credentialFile).mode & 0o777, 0o600);
    const list = await call(hub, 'GET', '/api/brain/access');
    assert.equal(list.json.clients[0].installedOnThisMac, true);
    const rev = await call(hub, 'POST', '/api/brain/access/revoke', { body: { id: r.json.client.id } });
    assert.equal(rev.json.revoked, true);
    assert.equal(existsSync(r.json.credentialFile), false, 'revoking removes the installed file');
  } finally { process.env.HOME = home; }
});

test('renew keeps the secret; bad input is a 400 with the reason', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  const issued = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'renew-me', scopes: ['read'], installLocal: false } });
  const exp = new Date(Date.now() + 7 * 86400000).toISOString();
  const r = await call(hub, 'POST', '/api/brain/access/renew', { body: { id: issued.json.client.id, expiresAt: exp } });
  assert.equal(r.status, 200); assert.equal(r.json.client.expiresAt, exp); assert.equal(r.json.secret, undefined);
  const bad = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: '', scopes: ['read'] } });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /name required/);
  const legacy = await call(hub, 'POST', '/api/brain/access/issue', { body: { name: 'claude-session-1', scopes: ['read'] } });
  assert.equal(legacy.status, 400);
});

test('watchers: a note write bumps the vault version, a request-log write bumps only access', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  hub.start();
  try {
    await new Promise((r) => setTimeout(r, 150));
    const v0 = { ...hub.status().versions };
    addFact(fx.vault, { note: 'knowledge/seen.md', subject: 'Seen', predicate: 'users', object: '7', by: 'test' });
    await new Promise((r) => setTimeout(r, 700));
    const v1 = { ...hub.status().versions };
    assert.ok(v1.vault > v0.vault, 'vault bumped');
    appendFileSync(join(fx.vault, '.access', 'requests.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), tool: 'brain_overview', mode: 'read', by: 'codex' })}\n`);
    await new Promise((r) => setTimeout(r, 700));
    const v2 = { ...hub.status().versions };
    assert.ok(v2.access > v1.access, 'access bumped');
    assert.equal(v2.vault, v1.vault, 'the request log does not rebuild the graph');
    writeFileSync(fx.statePath, readFileSync(fx.statePath, 'utf8'));
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(hub.status().versions.state > v2.state, 'state.json change bumped state');
  } finally { hub.stop(); }
  // The classifier itself, without timing.
  const seen = []; const probe = createBrainHub({ statePath: () => fx.statePath, inline: true, pollMs: 0, log: () => {}, deps: { legacy: () => null } });
  for (const f of ['knowledge/.seen.md.lock', 'knowledge/seen.md.123.tmp', '.obsidian/workspace.json']) { probe._onVaultEvent(f); seen.push(f); }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(probe._ver.vault, 1, `ignored: ${seen.join(', ')}`);
});

test('cloud tick: pulls through syncDown, never overlaps, bumps the vault when something arrived', async () => {
  const fx = fixture();
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const { hub } = hubFor(fx, { deps: { cloudConfigured: () => true, syncDown: async (v, opts) => { calls++; assert.equal(v, fx.vault); await gate; return { mode: opts && opts.full ? 'full' : 'fast', changed: 2, merged: 0, timeline: 1 }; } } });
  const a = hub.tick({ full: true }); const b = hub.tick();
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1, 'one pull at a time');
  assert.equal(ra, rb);
  assert.equal(ra.changed, 2); assert.equal(ra.mode, 'full'); assert.equal(ra.timeline, 1);
  const v = hub._ver.vault;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(hub._ver.vault > v);
  assert.equal(hub.status().cloud.lastSync.changed, 2);
  const off = hubFor(fx).hub;
  assert.equal((await off.tick()).skipped, 'not configured');
});

test('vault folder: refuses a non-vault, saves a real one to the env file (other lines kept)', async () => {
  const fx = fixture(); const { hub } = hubFor(fx);
  writeFileSync(fx.envFile, 'GROQ_API_KEY="k"\n# note\n');
  const empty = mkdtempSync(join(tmpdir(), 'not-a-vault-'));
  const bad = await call(hub, 'POST', '/api/brain/sources', { body: { vaultPath: empty } });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /not a vault folder/);
  const good = await call(hub, 'POST', '/api/brain/sources', { body: { vaultPath: fx.vault } });
  assert.equal(good.status, 200); assert.equal(good.json.vaultPath, fx.vault);
  const env = readFileSync(fx.envFile, 'utf8');
  assert.match(env, /^GROQ_API_KEY="k"$/m); assert.match(env, /^# note$/m);
  assert.ok(env.includes(`CHRONOS_VAULT=${JSON.stringify(fx.vault)}`));
  assert.equal(statSync(fx.envFile).mode & 0o777, 0o600);
});

test('helpers: looksLikeVault, upsertEnvLine replaces in place, legacy Chronos folder choice is found', () => {
  const fx = fixture();
  assert.equal(looksLikeVault(fx.vault), true);
  assert.equal(looksLikeVault(fx.root + '/nope'), false);
  assert.equal(looksLikeVault('relative/path'), false);
  const f = join(fx.root, 'x.env');
  writeFileSync(f, 'A=1\nCHRONOS_VAULT="/old"\nB=2\n');
  upsertEnvLine(f, 'CHRONOS_VAULT', '/new');
  assert.equal(readFileSync(f, 'utf8'), 'A=1\nCHRONOS_VAULT="/new"\nB=2\n');
  const dir = join(fx.root, 'Library', 'Application Support', 'Chronos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ statePath: '/x/state.json', vaultPath: fx.vault }));
  assert.deepEqual(legacyChronosVault({ home: fx.root }), { vaultPath: fx.vault, from: join(dir, 'config.json') });
  assert.equal(legacyChronosVault({ home: mkdtempSync(join(tmpdir(), 'nohome-')) }), null);
});

test('the worker thread builds the same graph the inline path does', async () => {
  const fx = fixture();
  const inline = hubFor(fx).hub;
  const threaded = hubFor(fx, { opts: { inline: false } }).hub;
  try {
    const a = await call(inline, 'GET', '/api/brain/graph');
    const b = await call(threaded, 'GET', '/api/brain/graph');
    assert.equal(b.status, 200);
    assert.equal(b.json.nodes.length, a.json.nodes.length);
    assert.equal(b.headers.etag, a.headers.etag, 'same content, same ETag');
    const h = await call(threaded, 'GET', '/api/brain/health');
    assert.equal(h.json.facts, 2);
  } finally { threaded.stop(); }
});
