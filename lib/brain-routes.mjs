// brain-routes — everything the Chronos app did, now inside Seen Command's local server.
//
// Chronos was a second Electron app whose main process (brain/main.js) owned three background jobs and
// a set of IPC handlers. They live here now, so the one Seen Command app is the brain's window:
//
//   background (start())                         HTTP (handle())
//   • watch the vault (recursive) + state.json   GET  /api/brain/status      versions + sync + sources
//   • pull the cloud brain every 60 s            GET  /api/brain/sources     = sources:info
//     (incremental; the first pass is full)      POST /api/brain/sources     pick the vault folder
//   • env: lib/config.mjs (SEEN_HOME/.env,       POST /api/brain/refresh     = Graph → Refresh now
//     repo .env, primary checkout .env)          GET  /api/brain/graph       = graph:request (same JSON)
//                                                GET  /api/brain/activity    = activity:request
//                                                GET  /api/brain/overnight   = overnight:request
//                                                GET  /api/brain/health      = health:request
//                                                GET  /api/brain/access      = access:list
//                                                POST /api/brain/access/{issue,revoke,renew,rotate,copy-once}
//
// FAST: nothing here runs until someone asks, except the watchers (which only bump counters) and the
// cloud tick (network + a few small writes). The heavy reads — the unified graph, the activity feed,
// the Keeper audit — run in a worker thread (lib/brain-worker.mjs), are cached per vault version, and
// the graph is served pre-serialized and gzipped with an ETag, so a poll that finds nothing new costs
// a 304. The page polls GET /api/brain/status (counters only) while the Brain tab is open.
//
// SECRETS: every /api/brain/* route here answers only to this Mac (loopback socket + localhost Host;
// writes also need a localhost Origin). A credential's secret is in exactly one response — the one
// that issued or rotated it — and is never logged. To copy it, the page sends back a one-time copy id
// (never the secret); the server puts the secret on the clipboard through pbcopy's stdin and forgets
// it. A second copy of the same id answers 410.
import './config.mjs';
import { watch, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { statePath as scStatePath, envPath, REPO_ROOT } from './paths.mjs';
import { ptDate } from './time-pt.mjs';
import { resolveSources } from '../brain/lib/sources.mjs';
import { runTask, explainBrainError } from './brain-worker.mjs';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export const CLOUD_POLL_MS = num(process.env.CHRONOS_CLOUD_POLL_MS, 60_000); // 0 = no cloud tick
const GRAPH_MAX_AGE_MS = 120_000;   // past this a viewed graph is rebuilt (fresh Supabase/GitHub layer)
const LIVE_BUDGET_MS = 2_500;       // the graph never waits longer than this for the live layer
const CLOUD_ACCESS_TTL_MS = 15_000; // cloud sessions' audit rows, re-read at most this often
const COPY_TTL_MS = 5 * 60_000;     // a one-time copy id dies after this
const TASK_TIMEOUT_MS = 60_000;
const MAX_BODY = 64 * 1024;

// ---- who may call: this Mac only ----------------------------------------------------------------
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
const ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
// Reads: a loopback socket and a localhost Host (a DNS-rebinding page sends its own host name).
// Writes: also a localhost Origin, which every browser sends on a POST — so no other site can drive it.
export function localRequest(req, { write = false } = {}) {
  if (!LOOPBACK.has(String(req?.socket?.remoteAddress || ''))) return false;
  if (!HOST_RE.test(String(req?.headers?.host || ''))) return false;
  const origin = String(req?.headers?.origin || '');
  return write ? ORIGIN_RE.test(origin) : (!origin || ORIGIN_RE.test(origin));
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// A folder is a vault when it holds markdown notes (at the top or one level down) — enough to refuse a
// mistyped path without second-guessing an unusual layout.
export function looksLikeVault(dir) {
  if (!dir || !isAbsolute(dir) || !isDir(dir)) return false;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      if (name.endsWith('.md')) return true;
      const sub = join(dir, name);
      if (isDir(sub) && readdirSync(sub).some((n) => n.endsWith('.md'))) return true;
    }
  } catch { /* unreadable → not usable */ }
  return false;
}

// The folder the owner once picked in Chronos's first-run dialog (userData/config.json). Read only to
// carry that choice over when nothing else finds a vault.
export function legacyChronosVault({ home = homedir() } = {}) {
  for (const name of ['Chronos', 'chronos-app']) {
    const p = join(home, 'Library', 'Application Support', name, 'config.json');
    try {
      if (!existsSync(p)) continue;
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      if (cfg && cfg.vaultPath && looksLikeVault(resolve(cfg.vaultPath))) return { vaultPath: resolve(cfg.vaultPath), from: p };
    } catch { /* unreadable config → ignore */ }
  }
  return null;
}

// Set KEY in a .env file without touching any other line (atomic replace, owner-only mode). Values are
// JSON-quoted, which lib/config.mjs parses back.
export function upsertEnvLine(file, key, value) {
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `${key}=${JSON.stringify(String(value))}`;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let done = false;
  const lines = original.split(/\r?\n/).map((l) => { if (!done && re.test(l)) { done = true; return line; } return l; });
  if (!done) lines.push(line);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, file);
}

// The secret goes to pbcopy on STDIN — never as an argument, where `ps` would show it.
export function systemClipboard(secret, { platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== 'darwin') return Promise.resolve(false);
  return new Promise((done) => {
    let settled = false; const finish = (v) => { if (!settled) { settled = true; done(v); } };
    try {
      const p = spawnFn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(false); }, 3000);
      p.on('error', () => { clearTimeout(t); finish(false); });
      p.on('exit', (code) => { clearTimeout(t); finish(code === 0); });
      p.stdin.end(String(secret));
    } catch { finish(false); }
  });
}

function appVersion() {
  let v = '?', sha = '';
  try { v = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  try { sha = JSON.parse(readFileSync(join(REPO_ROOT, 'build-info.json'), 'utf8')).sha || ''; } catch { /* dev run */ }
  return `Seen Command v${v}${sha ? ` · ${String(sha).slice(0, 7)}` : ''}`;
}

const TIMEOUT = Symbol('timeout');
const later = (ms) => new Promise((r) => { const t = setTimeout(() => r(TIMEOUT), ms); t.unref?.(); });

// JSON, never cached. A big feed (All changes is ~450 KB) goes gzipped when the client accepts it.
function send(res, code, body, req = null) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (req && buf.length > 16 * 1024 && /\bgzip\b/.test(String(req.headers?.['accept-encoding'] || ''))) {
    const z = gzipSync(buf, { level: 4 });
    res.writeHead(code, { ...headers, 'content-encoding': 'gzip', 'content-length': z.length, vary: 'accept-encoding' });
    return res.end(z);
  }
  res.writeHead(code, { ...headers, 'content-length': buf.length });
  return res.end(buf);
}
function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { fail(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return ok({}); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', fail);
  });
}

const EMPTY_ACTIVITY = (error) => ({ recent: [], all: [], requests: [], sessions: [], counts: { changes: 0, requests: 0 }, error });

export function createBrainHub({
  statePath = scStatePath,          // () => Seen Command's state.json (SEEN_HOME/data in the packaged app)
  envFile = envPath,                // () => the runtime .env the vault choice is saved to
  inline = false,                   // true → run heavy reads on this thread (tests; no worker)
  pollMs = CLOUD_POLL_MS,
  home = homedir(),
  deps = {},                        // injectable: buildLive, syncDown, cloudConfigured, fetchBrainAccess,
                                    // syncAccessClient, accessControl, readOvernight, clipboard, legacy
  log = (m) => process.stderr.write(`[brain] ${m}\n`),
} = {}) {
  const VERSION = appVersion();
  const ver = { vault: 1, state: 1, access: 1, live: 1 };
  const cache = { graph: null, activity: null, health: null, overnight: null, cloudAccess: null };
  const inflight = {};
  let sources = null, legacyUsed = null, watching = { vault: false, state: false };
  let D = null, worker = null, workerOff = inline, seq = 0;
  const pending = new Map();
  const watchers = [];
  let bumpTimer = null; const toBump = new Set();
  let heartbeat = null, ticking = null, lastSync = null, firstTick = true;
  let lastLive = null, liveHash = '', liveAt = 0, liveInflight = null;
  const stash = new Map();
  const legacyFn = deps.legacy || (() => legacyChronosVault({ home }));

  async function loadDeps() {
    if (D) return D;
    const o = { ...deps };
    if (!('buildLive' in o)) { try { o.buildLive = (await import('../brain/lib/live.mjs')).buildLiveLayer; } catch (e) { log(`live layer unavailable: ${e.message}`); o.buildLive = null; } }
    if (!o.syncDown || !o.cloudConfigured || !o.fetchBrainAccess || !o.syncAccessClient) {
      let C = null; try { C = await import('../brain/lib/cloud.mjs'); } catch (e) { log(`cloud module unavailable (local-only): ${e.message}`); }
      o.syncDown ||= C ? C.syncDownSafe : async () => ({ changed: 0, skipped: 'cloud module unavailable' });
      o.cloudConfigured ||= C ? C.cloudConfigured : () => false;
      o.fetchBrainAccess ||= C ? C.fetchBrainAccess : async () => [];
      o.syncAccessClient ||= C ? C.syncAccessClient : async () => ({ synced: false, reason: 'cloud module unavailable' });
    }
    o.accessControl ||= await import('../brain/lib/access-control.mjs');
    o.readOvernight ||= (await import('../brain/lib/overnight.mjs')).readOvernight;
    o.clipboard ||= systemClipboard;
    D = o; return D;
  }

  // ---- worker -----------------------------------------------------------------------------------
  function failAll(e) { for (const [, p] of pending) p.reject(e); pending.clear(); }
  function getWorker() {
    if (workerOff) return null;
    if (worker) return worker;
    try {
      worker = new Worker(new URL('./brain-worker.mjs', import.meta.url));
      worker.unref();
      worker.on('message', ({ id, ok, result, error }) => {
        const p = pending.get(id); if (!p) return;
        pending.delete(id); clearTimeout(p.t);
        if (ok) p.resolve(result); else p.reject(new Error(error));
      });
      worker.on('error', (e) => { log(`brain worker error: ${e.message}`); failAll(e); worker = null; });
      worker.on('exit', (code) => { worker = null; if (pending.size) failAll(new Error(`brain worker stopped (${code})`)); });
    } catch (e) { log(`brain worker unavailable, reading inline: ${e.message}`); workerOff = true; worker = null; }
    return worker;
  }
  function task(kind, args) {
    const w = getWorker();
    if (!w) return runTask(kind, args);
    return new Promise((resolveTask, rejectTask) => {
      const id = ++seq;
      const t = setTimeout(() => { pending.delete(id); rejectTask(new Error(`brain ${kind} took longer than ${TASK_TIMEOUT_MS / 1000}s`)); try { w.terminate(); } catch { /* gone */ } }, TASK_TIMEOUT_MS);
      t.unref?.();
      pending.set(id, { resolve: resolveTask, reject: rejectTask, t });
      w.postMessage({ id, kind, args });
    }).catch((e) => {
      // A crashed worker must not take the Brain down with it: answer this one inline.
      if (/brain worker stopped|brain worker error/.test(e.message)) return runTask(kind, args);
      throw e;
    });
  }

  // ---- sources ----------------------------------------------------------------------------------
  function refreshSources() {
    let s = resolveSources({ statePath: statePath() });
    if (!s.vaultFound && !process.env.CHRONOS_VAULT) {
      const lg = legacyFn();
      if (lg) {
        // Carry the Chronos folder choice over — and save it, so the board meeting and every other
        // process read the same vault this window shows.
        process.env.CHRONOS_VAULT = lg.vaultPath; legacyUsed = lg;
        try { upsertEnvLine(envFile(), 'CHRONOS_VAULT', lg.vaultPath); } catch (e) { log(`could not save the vault folder: ${e.message}`); }
        s = resolveSources({ statePath: statePath() });
      }
    }
    sources = s; return s;
  }
  const src = () => sources || refreshSources();
  const info = () => ({ ...src(), today: ptDate(), version: VERSION });

  // ---- versions + watchers ------------------------------------------------------------------------
  function bump(kind) {
    toBump.add(kind);
    clearTimeout(bumpTimer);
    // Editors and atomic renames fire several events per save — one bump per burst.
    bumpTimer = setTimeout(() => { for (const k of toBump) ver[k]++; toBump.clear(); }, 200);
    bumpTimer.unref?.();
  }
  function onVaultEvent(f) {
    const p = String(f || '').replace(/\\/g, '/');
    if (!p) { bump('vault'); bump('access'); return; }
    if (p.startsWith('.access/')) { bump('access'); return; }
    if (/\.tmp$/.test(p) || p.split('/').some((seg) => seg.startsWith('.'))) return; // locks, temp files, .obsidian, .graph
    bump('vault');
  }
  function stopWatching() { for (const w of watchers.splice(0)) { try { w.close(); } catch { /* closed */ } } watching = { vault: false, state: false }; }
  function startWatching() {
    stopWatching();
    const s = src();
    const add = (dir, opts, fn) => {
      try { const w = watch(dir, opts, fn); w.on('error', (e) => log(`watch stopped for ${dir}: ${e.message}`)); watchers.push(w); return true; }
      catch (e) { log(`watch failed for ${dir}: ${e.message}`); return false; }
    };
    if (s.statePath && isDir(dirname(s.statePath))) {
      const base = basename(s.statePath);
      watching.state = add(dirname(s.statePath), {}, (_e, f) => { if (!f || String(f).startsWith(base)) bump('state'); });
    }
    if (s.vaultPath && isDir(s.vaultPath)) watching.vault = add(s.vaultPath, { recursive: true }, (_e, f) => onVaultEvent(f));
  }

  // ---- cloud sync (Chronos's 60 s tick) ------------------------------------------------------------
  async function tick(opts = {}) {
    if (ticking) return ticking;
    ticking = (async () => {
      const d = await loadDeps();
      const at = new Date().toISOString();
      if (!d.cloudConfigured()) { lastSync = { at, skipped: 'not configured' }; return lastSync; }
      const s = src();
      if (!s.vaultPath) { lastSync = { at, skipped: 'no vault' }; return lastSync; }
      try {
        const r = (await d.syncDown(s.vaultPath, opts)) || {};
        lastSync = { at, ok: !r.error, mode: r.mode || null, changed: r.changed || 0, merged: r.merged || 0, timeline: Number(r.timeline) || 0, preserved: r.preserved || 0, error: r.error || null, skipped: r.skipped || null };
        if (r.changed || r.merged || r.timeline) bump('vault');
      } catch (e) { lastSync = { at, ok: false, error: e.message }; }
      return lastSync;
    })().finally(() => { ticking = null; });
    return ticking;
  }
  // One heartbeat: find a vault that appeared since start (a fresh clone), then pull the cloud brain.
  async function beat() {
    const before = src();
    if (!before.vaultFound) { const s = refreshSources(); if (s.vaultFound) startWatching(); }
    const full = firstTick; firstTick = false;
    // The first pass is FULL: it catches remote deletions and anything written while the Mac slept.
    return tick(full ? { full: true } : {});
  }

  // ---- the live layer (Supabase + GitHub), never allowed to hold the graph up -----------------------
  async function liveLayer({ force = false } = {}) {
    const d = await loadDeps();
    if (!d.buildLive) return null;
    if (!liveInflight || force) {
      liveInflight = Promise.resolve().then(() => d.buildLive({ force }))
        .then((l) => {
          const h = JSON.stringify(l || null);
          if (h !== liveHash) { liveHash = h; ver.live++; }
          lastLive = l || null; liveAt = Date.now(); return lastLive;
        })
        .catch(() => lastLive)
        .finally(() => { liveInflight = null; });
    }
    const r = await Promise.race([liveInflight, later(LIVE_BUDGET_MS)]);
    return r === TIMEOUT ? lastLive : r;
  }

  // ---- reads ---------------------------------------------------------------------------------------
  async function graph({ force = false } = {}) {
    const s = src();
    const live = await liveLayer({ force });
    const key = `${ver.vault}.${ver.state}.${ver.live}|${s.vaultPath}|${s.statePath}`;
    const c = cache.graph;
    if (!force && c && c.key === key && Date.now() - c.at < GRAPH_MAX_AGE_MS) return c;
    if (inflight.graph && inflight.graph.key === key && !force) return inflight.graph.p;
    const p = task('graph', { statePath: s.statePath, vaultPath: s.vaultPath, today: ptDate(), live })
      .then((r) => {
        const gz = Buffer.from(r.gz.buffer, r.gz.byteOffset, r.gz.byteLength);
        const json = Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength);
        const g = { key, at: Date.now(), json, gz, etag: `"g${r.hash}"`, summary: r.summary };
        cache.graph = g; return g;
      })
      .finally(() => { if (inflight.graph && inflight.graph.p === p) inflight.graph = null; });
    inflight.graph = { key, p };
    return p;
  }

  async function activity() {
    const s = src();
    if (!s.vaultPath) return EMPTY_ACTIVITY('no vault');
    const d = await loadDeps();
    let local;
    try {
      const key = `${ver.vault}.${ver.access}|${s.vaultPath}`;
      if (cache.activity && cache.activity.key === key) local = cache.activity.data;
      else { local = await task('activity', { vaultPath: s.vaultPath }); cache.activity = { key, data: local }; }
    } catch (e) { return EMPTY_ACTIVITY(explainBrainError(e, s.vaultPath)); }
    const payload = { ...local, counts: { ...local.counts }, requests: [...(local.requests || [])] };
    // CLOUD sessions' requests (the product gateway's brain_access audit) join the local ones, so an AI
    // client on another machine is as visible here as a local one. Additive only: [] on any failure.
    try {
      const fresh = cache.cloudAccess && Date.now() - cache.cloudAccess.at < CLOUD_ACCESS_TTL_MS;
      if (!fresh) {
        const rows = await Promise.race([d.fetchBrainAccess({ limit: 200 }), later(5000)]);
        cache.cloudAccess = { at: Date.now(), rows: rows === TIMEOUT ? (cache.cloudAccess?.rows || []) : (rows || []) };
      }
      const cloud = cache.cloudAccess.rows;
      if (cloud.length) {
        payload.requests = [...payload.requests, ...cloud]
          .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 300);
        payload.counts.requests = payload.requests.length;
        payload.counts.requestWrites = payload.requests.filter((r) => r.mode === 'write').length;
        payload.counts.requestReads = payload.counts.requests - payload.counts.requestWrites;
        payload.counts.cloudRequests = cloud.length;
        payload.newestRequestAt = payload.requests.length ? payload.requests[0].at : payload.newestRequestAt;
      }
    } catch { /* the cloud feed is additive only */ }
    return payload;
  }

  async function health() {
    const s = src();
    const key = `${ver.vault}|${s.vaultPath}`;
    if (cache.health && cache.health.key === key) return { ...cache.health.data, sources: info() };
    try {
      if (!s.vaultPath) throw new Error('no vault found — pick the vault folder under Brain → Sources (or set CHRONOS_VAULT)');
      const data = await task('health', { vaultPath: s.vaultPath });
      cache.health = { key, data };
      return { ...data, sources: info() };
    } catch (e) { return { error: explainBrainError(e, s.vaultPath), sources: info() }; }
  }

  async function overnight() {
    const s = src();
    const empty = (error) => ({ entries: [], days: [], counts: { entries: 0, runs: 0 }, sources: info(), error });
    if (!s.vaultPath) return empty('no vault');
    try {
      const d = await loadDeps();
      const key = `${ver.vault}|${s.vaultPath}`;
      if (!cache.overnight || cache.overnight.key !== key) {
        // Day-notes are keyed by calendar date. Start the 8-day walk from the LATER of the UTC and the
        // California date (the UTC one, after 4–5 PM PT), so a note a writer stamped with either
        // convention is found. Every date SHOWN is the note's own date; `today` below is California's.
        const lookupFrom = new Date().toISOString().slice(0, 10);
        cache.overnight = { key, data: d.readOvernight({ vaultPath: s.vaultPath, days: 8, today: lookupFrom }) };
      }
      return { ...cache.overnight.data, sources: info() };
    } catch (e) { return empty(explainBrainError(e, s.vaultPath)); }
  }

  function status() {
    if (!src().vaultFound) { const s = refreshSources(); if (s.vaultFound) startWatching(); }
    // Someone is looking: keep the live layer (Supabase/GitHub) about a minute fresh. A change bumps
    // ver.live, which tells the page to re-read the graph.
    if (D && D.buildLive && !liveInflight && Date.now() - liveAt > 60_000) liveLayer({}).catch(() => {});
    const g = cache.graph;
    return {
      versions: { ...ver },
      sources: info(),
      watching: { ...watching },
      cloud: { configured: D ? !!D.cloudConfigured() : null, pollMs, lastSync, syncing: !!ticking },
      graph: g ? { builtAt: new Date(g.at).toISOString(), ...g.summary } : null,
      legacy: legacyUsed ? { vaultPath: legacyUsed.vaultPath, from: legacyUsed.from } : null,
    };
  }

  async function setVaultFolder(raw) {
    const p = resolve(String(raw || '').trim().replace(/^~(?=\/|$)/, home));
    if (!raw || !looksLikeVault(p)) {
      const e = new Error(`${raw ? `"${raw}" is not a vault folder` : 'a folder path is required'} — choose the seen repo's memory/ folder (it holds the .md notes).`);
      e.status = 400; throw e;
    }
    upsertEnvLine(envFile(), 'CHRONOS_VAULT', p);
    process.env.CHRONOS_VAULT = p;
    legacyUsed = null;
    refreshSources(); startWatching();
    for (const k of Object.keys(ver)) ver[k]++;
    return info();
  }

  // ---- access (credential authority; secrets are shown once) ----------------------------------------
  function requireVault() { const s = src(); if (!s.vaultPath) { const e = new Error('no vault found — Brain access lives in the vault (.access/clients.json)'); e.status = 409; throw e; } return s.vaultPath; }
  function sweep() { const now = Date.now(); for (const [k, v] of stash) if (v.exp <= now) stash.delete(k); }
  function stashSecret(secret) { sweep(); const id = randomBytes(16).toString('hex'); stash.set(id, { secret, exp: Date.now() + COPY_TTL_MS }); return id; }
  async function syncClientRecord(id) {
    const d = await loadDeps();
    if (!d.cloudConfigured()) return { synced: false, reason: 'cloud not configured' };
    try { return await d.syncAccessClient(d.accessControl.getClientRecord(requireVault(), id)); }
    catch (e) { return { synced: false, reason: e.message }; }
  }
  const withCopy = (delivered) => { if (delivered && delivered.secret) delivered.copyId = stashSecret(delivered.secret); return delivered; };
  const access = {
    async list() {
      const d = await loadDeps(); const s = src();
      return { clients: s.vaultPath ? d.accessControl.listClients(s.vaultPath) : [], vaultFound: !!s.vaultPath, cloudConfigured: !!d.cloudConfigured() };
    },
    async issue(input = {}) {
      const d = await loadDeps(); const v = requireVault(); const ac = d.accessControl;
      const out = ac.issueClient(v, { name: input.name, scopes: input.scopes, expiresAt: input.expiresAt || null });
      const credentialFile = input.installLocal ? ac.installClientCredential({ name: out.client.name, secret: out.secret }) : null;
      const delivered = ac.credentialDeliveryResult(out, { credentialFile });
      delivered.cloud = await syncClientRecord(out.client.id);
      bump('access');
      return withCopy(delivered);
    },
    async revoke({ id } = {}) {
      const d = await loadDeps(); const v = requireVault(); const ac = d.accessControl;
      const client = ac.listClients(v).find((c) => c.id === String(id || ''));
      ac.revokeClient(v, String(id || ''));
      if (client && client.installedOnThisMac) ac.removeInstalledCredential(client.name);
      bump('access');
      return { revoked: true, cloud: await syncClientRecord(String(id || '')) };
    },
    // Renew keeps the secret, so nothing is installed or shown; only the record's new expiry is synced.
    async renew({ id, expiresAt } = {}) {
      const d = await loadDeps(); const v = requireVault();
      const out = d.accessControl.renewClient(v, String(id || ''), { expiresAt: expiresAt || null });
      bump('access');
      return { ...out, cloud: await syncClientRecord(out.client.id) };
    },
    async rotate({ id } = {}) {
      const d = await loadDeps(); const v = requireVault(); const ac = d.accessControl;
      const old = ac.listClients(v).find((c) => c.id === String(id || ''));
      const out = ac.rotateClient(v, String(id || ''));
      const credentialFile = old && old.installedOnThisMac ? ac.installClientCredential({ name: out.client.name, secret: out.secret }) : null;
      const delivered = ac.credentialDeliveryResult(out, { credentialFile });
      const oldCloud = await syncClientRecord(String(id || ''));
      delivered.cloud = await syncClientRecord(out.client.id);
      delivered.cloudPrevious = oldCloud;
      bump('access');
      return withCopy(delivered);
    },
    async copyOnce({ copyId } = {}) {
      sweep();
      const key = String(copyId || '');
      const entry = stash.get(key);
      if (!entry) return { status: 410, body: { copied: false, error: 'already copied, or the copy window closed — a credential is shown once. Rotate it to get a new one.' } };
      stash.delete(key);
      const d = await loadDeps();
      const ok = await d.clipboard(entry.secret);
      return { status: 200, body: ok ? { copied: true } : { copied: false, reason: 'no system clipboard from here — copy it from the screen' } };
    },
  };

  // ---- HTTP ----------------------------------------------------------------------------------------
  const GET = {
    '/api/brain/status': async () => status(),
    '/api/brain/sources': async () => { const st = status(); return { ...st.sources, cloud: st.cloud, legacy: st.legacy, watching: st.watching }; },
    '/api/brain/activity': () => activity(),
    '/api/brain/overnight': () => overnight(),
    '/api/brain/health': () => health(),
    '/api/brain/access': () => access.list(),
  };
  const POST = {
    '/api/brain/sources': (b) => setVaultFolder(b.vaultPath),
    '/api/brain/refresh': async () => {
      // Graph → Refresh now: pull the cloud brain, then make every view re-read.
      await Promise.race([tick({}), later(8000)]);
      for (const k of Object.keys(ver)) ver[k]++;
      liveLayer({ force: true }).catch(() => {});
      return status();
    },
    '/api/brain/access/issue': (b) => access.issue(b),
    '/api/brain/access/revoke': (b) => access.revoke(b),
    '/api/brain/access/renew': (b) => access.renew(b),
    '/api/brain/access/rotate': (b) => access.rotate(b),
  };

  async function sendGraph(req, res, qs) {
    let g;
    try { g = await graph({ force: qs.get('refresh') === '1' }); }
    catch (e) { return send(res, 500, { error: explainBrainError(e, src().vaultPath) }); }
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-cache', etag: g.etag, 'x-brain-version': `${ver.vault}.${ver.state}.${ver.live}` };
    if (String(req.headers['if-none-match'] || '') === g.etag) { res.writeHead(304, headers); return res.end(); }
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': g.gz.length, vary: 'accept-encoding' });
      return res.end(g.gz);
    }
    res.writeHead(200, { ...headers, 'content-length': g.json.length });
    return res.end(g.json);
  }

  // `localOnly` is the server's own write gate (engine/server.mjs credentialRequestAllowed — the one the
  // assistant routes use). Reads cannot use it: a browser sends no Origin on a same-origin GET.
  async function handle(req, res, path, { localOnly = null } = {}) {
    if (!String(path || '').startsWith('/api/brain/')) return false;
    const method = req.method || 'GET';
    const isGraph = method === 'GET' && path === '/api/brain/graph';
    const isCopy = method === 'POST' && path === '/api/brain/access/copy-once';
    const fn = method === 'GET' ? GET[path] : method === 'POST' ? POST[path] : null;
    if (!isGraph && !isCopy && !fn) return false; // not ours (e.g. POST /api/brain/record) — the server goes on
    const write = method !== 'GET';
    const allowed = write
      ? localRequest(req, { write: true }) && (typeof localOnly !== 'function' || !!localOnly(req))
      : localRequest(req);
    if (!allowed) {
      send(res, 403, { error: 'the Brain answers only to the Seen Command app on this Mac' });
      return true;
    }
    const qs = new URL(req.url || '/', 'http://x').searchParams;
    try {
      if (isGraph) { await sendGraph(req, res, qs); return true; }
      const body = method === 'POST' ? await readJson(req) : {};
      if (isCopy) { const r = await access.copyOnce(body); send(res, r.status, r.body); return true; }
      send(res, 200, await fn(body), req);
    } catch (e) {
      // access-control's messages name the problem ("client name required", "active client not found")
      // and never contain a secret.
      const code = e.status || (/required|invalid|expiry|scope|already exists|not found|forbidden|role-qualified/i.test(e.message) ? 400 : 500);
      send(res, code, { error: e.message });
    }
    return true;
  }

  function start() {
    refreshSources();
    startWatching();
    loadDeps().catch((e) => log(`brain deps failed: ${e.message}`));
    if (pollMs > 0 && !heartbeat) {
      const first = setTimeout(() => { beat().catch(() => {}); }, 3000); first.unref?.();
      heartbeat = setInterval(() => { beat().catch(() => {}); }, pollMs); heartbeat.unref?.();
    }
    return status();
  }
  function stop() {
    stopWatching();
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    clearTimeout(bumpTimer);
    if (worker) { try { worker.terminate(); } catch { /* gone */ } worker = null; }
  }

  return { handle, start, stop, status, graph, activity, health, overnight, access, setVaultFolder, refreshSources, tick, beat, info, _ver: ver, _onVaultEvent: onVaultEvent, _stash: stash };
}

let HUB = null;
export function brainHub() { return HUB || (HUB = createBrainHub()); }
// The server's one dispatch line. Resolves true when the request was answered here.
export function handleBrainRoute(req, res, path, opts = {}) {
  if (!String(path || '').startsWith('/api/brain/')) return Promise.resolve(false);
  return brainHub().handle(req, res, path, opts);
}
// Called once when the server starts listening: watchers + the cloud tick.
export function startBrainBackground() { return brainHub().start(); }
