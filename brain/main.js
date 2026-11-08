// Chronos — desktop app shell (Electron). A dedicated window + Dock icon whose only job is to
// visualize the LIVE, unified memory graph: Seen Command's board-meeting graph (data/state.json)
// AND Seen's bi-temporal Chronos vault, in one temporal canvas.
//
// `npm start` opens it (dev, from the repo). `npm run app:package` builds Chronos.app and
// `npm run app:install` copies it into /Applications so you can open it from Spotlight/Finder.
//
// A Finder-launched .app has no useful cwd and no shell env, so on first run (when it can't find
// live data) it asks you to point it at your seen-command repo folder and remembers that choice in
// userData/config.json. After that it reads live data and watches for changes like the dev run.
//
// The main process owns all file I/O: it builds the unified graph (via the vendored pure engine),
// watches both stores, and pushes fresh data to the renderer over IPC. The renderer is pure
// DOM/canvas with contextIsolation on — it never touches the filesystem.

const { app, BrowserWindow, Menu, ipcMain, shell, dialog, powerSaveBlocker, clipboard } = require('electron');
const { watch, existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

let win = null;
let sources = { statePath: null, vaultPath: null, stateFound: false, vaultFound: false }; // resolved at startup
let resolveSources = null;      // from lib/sources.mjs
let buildUnifiedGraph = null;   // from lib/unify.mjs
let buildLiveLayer = null;      // from lib/live.mjs (Supabase + GitHub)
let cloudSyncDown = null;       // from lib/cloud.mjs — pulls the online brain (Supabase) into the vault
let buildActivity = null;       // from lib/activity.mjs — the changes + requests feeds
let readVaultIndex = null;      // from lib/vault.mjs — facts, for the changes feed
let fetchBrainAccess = null;    // from lib/cloud.mjs — cloud sessions' gateway audit rows
let accessControl = null;       // credential issuance/revocation; secrets are returned once only
let syncAccessClient = null;     // mirrors verifier-only client records to the cloud gateway
let cloudConfigured = null;
let cloudTimer = null;
let configPath = null;          // userData/config.json
const watchers = [];
let debounceTimer = null;
// 60s (was 30s). Each tick is now an incremental pull (brain/lib/cloud.mjs syncDown — "[]" when the
// vault is idle) rather than a full-vault download, so the interval is no longer what drives egress;
// it is the latency for a cloud write to appear here. The cloud brain itself is the coordination
// point (the gateway and the board meeting both read Supabase directly), so a minute is still live.
// Override with CHRONOS_CLOUD_POLL_MS.
const CLOUD_POLL_MS = Number(process.env.CHRONOS_CLOUD_POLL_MS || 60000);

// Load Supabase creds from the real command-os/.env (derived from the user-configured state path),
// so the PACKAGED Chronos.app — which doesn't bundle .env — can still reach the online brain.
function loadSupabaseEnv() {
  try {
    if (process.env.SUPABASE_URL && process.env.GITHUB_TOKEN) return;
    const root = sources.statePath ? path.dirname(path.dirname(sources.statePath)) : null;
    const envPath = root && path.join(root, '.env');
    if (envPath && existsSync(envPath)) {
      // Supabase for the online brain + product data; GitHub for the live repo layer (branches/PRs).
      const KEYS = /^\s*(SUPABASE_URL|SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN|GH_TOKEN|SEEN_GITHUB_REPO|SEEN_COMMAND_GITHUB_REPO)\s*=\s*(.+?)\s*$/;
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(KEYS);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { console.error('env load failed:', e.message); }
}

// LIVE from the cloud: every CLOUD_POLL_MS, pull the online brain into the vault; changed notes fire
// the file-watcher → re-render. So a board meeting on another machine shows up here on its own.
function startCloudSync() {
  if (cloudTimer || !cloudSyncDown || !cloudConfigured || !cloudConfigured()) return;
  const tick = async (opts) => {
    try { const r = await cloudSyncDown(sources.vaultPath, opts); if (r && (r.changed || r.merged || r.timeline)) pushGraph(); }
    catch (e) { console.error('cloud sync tick failed:', e.message); }
  };
  cloudTimer = setInterval(() => tick(), CLOUD_POLL_MS);
  // Startup is a FULL pass (path+updated_at listing, ~6 KB): it catches remote deletions and anything
  // written while the Mac was asleep with a skewed clock. Later ticks are incremental; syncDown runs
  // its own slow pass every ~15 min and a deep content check once a day.
  tick({ full: true });
  console.log(`Chronos: live cloud sync every ${CLOUD_POLL_MS / 1000}s (Supabase online brain)`);
}
function stopCloudSync() { if (cloudTimer) { clearInterval(cloudTimer); cloudTimer = null; } }

// Chronos is the always-on coordination layer, so its cloud sync must not be silently suspended by
// App Nap when the window is hidden or the machine idles. `prevent-app-suspension` keeps our timers
// firing (it does NOT keep the display on, and — honestly — it cannot stop a lid-closed-on-battery
// sleep; Amphetamine/Amphetamine Enhancer own that layer). Cheap, reversible, released on quit.
let powerBlockerId = null;
function startPowerAssertion() {
  try {
    if (powerBlockerId == null || !powerSaveBlocker.isStarted(powerBlockerId)) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log(`Chronos: app-suspension blocker active (id ${powerBlockerId})`);
    }
  } catch (e) { console.error('power assertion failed (non-fatal):', e.message); }
}
function stopPowerAssertion() {
  try { if (powerBlockerId != null && powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId); }
  catch { /* already stopped */ }
  powerBlockerId = null;
}

const today = () => new Date().toISOString().slice(0, 10);

// Version/build stamp — shown in the window title so you can confirm an update actually landed.
// build-info.json is written at package time (brain:app) with the command-os git SHA; falls back to
// package.json version in dev.
let APP_VERSION = 'v?';
try { const bi = JSON.parse(readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); APP_VERSION = `v${bi.version}${bi.sha ? ' · ' + bi.sha : ''}`; }
catch { try { APP_VERSION = 'v' + JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { /* ignore */ } }
const TITLE = `Chronos ${APP_VERSION}`;

// ---- persisted config (remembers where the user's repos are) ----
function loadConfig() { try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return {}; } }
function saveConfig(cfg) {
  try { mkdirSync(path.dirname(configPath), { recursive: true }); writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error('config save failed:', e.message); }
}
function refreshSources() {
  const cfg = loadConfig();
  sources = resolveSources({ statePath: cfg.statePath, vaultPath: cfg.vaultPath });
  return sources;
}

// Load the ESM lib from this CJS entry point via dynamic import.
async function loadLib() {
  const S = await import('./lib/sources.mjs');
  const U = await import('./lib/unify.mjs');
  resolveSources = S.resolveSources;
  buildUnifiedGraph = U.buildUnifiedGraph;
  try { const C = await import('./lib/cloud.mjs'); cloudSyncDown = C.syncDownSafe; cloudConfigured = C.cloudConfigured; fetchBrainAccess = C.fetchBrainAccess; syncAccessClient = C.syncAccessClient; }
  catch (e) { console.error('cloud module unavailable (local-only):', e.message); }
  try { const L = await import('./lib/live.mjs'); buildLiveLayer = L.buildLiveLayer; }
  catch (e) { console.error('live layer unavailable:', e.message); }
  try { const A = await import('./lib/activity.mjs'); buildActivity = A.buildActivity; }
  catch (e) { console.error('activity module unavailable:', e.message); }
  try { const V = await import('./lib/vault.mjs'); readVaultIndex = V.readIndex; }
  catch (e) { console.error('vault reader unavailable:', e.message); }
  try { accessControl = await import('./lib/access-control.mjs'); }
  catch (e) { console.error('access control unavailable:', e.message); }
}

async function buildGraph() {
  try {
    let live = null;
    if (buildLiveLayer) { try { live = await buildLiveLayer(); } catch { /* fail-soft */ } }
    return buildUnifiedGraph({ statePath: sources.statePath, vaultPath: sources.vaultPath, today: today(), live });
  } catch (e) {
    console.error('graph build failed:', e);
    console.error('graph build failed (actionable):', explainGraphError(e));
    return { nodes: [], links: [], dateRange: { from: today(), to: today() }, generated: today(),
      vaultFound: false, stateFound: false, error: explainGraphError(e),
      counts: { command: { nodes: 0, facts: 0, threads: 0 }, chronos: { notes: 0, facts: 0, links: 0 }, bridges: 0, total: { nodes: 0, links: 0 } },
      sources: { statePath: sources.statePath, vaultPath: sources.vaultPath } };
  }
}

// Turn a failure into something the owner can ACT on. The case that actually happened: macOS asks once
// for access to Desktop/Documents/Downloads, the prompt was denied, and the denial is remembered — so
// the app never asks again and every vault read fails with `EPERM ... scandir`. Nothing is broken and
// no data is lost, but the raw errno says none of that. A re-signed build (every rebuild re-signs with
// a fresh CDHash) can also reset a previously granted permission, which makes it look like a regression.
function explainGraphError(e) {
  const msg = String((e && e.message) || e || '');
  const isPerm = /EPERM|EACCES|operation not permitted/i.test(msg);
  const p = String(sources.vaultPath || '');
  const protectedDir = ['Downloads', 'Documents', 'Desktop'].find((d) => p.includes(`/${d}/`));
  if (isPerm && protectedDir) {
    return `macOS is blocking access to your ${protectedDir} folder, so the vault at ${p} cannot be read. `
      + `Nothing is broken and no memory is lost — the permission was denied (or reset by a rebuild). `
      + `Fix: System Settings → Privacy & Security → Files and Folders → Chronos → enable "${protectedDir} Folder", `
      + `then Graph → Refresh now. Full Disk Access also works. (Original error: ${msg})`;
  }
  if (isPerm) {
    return `Permission denied reading the vault at ${p}. Grant Chronos access in System Settings → `
      + `Privacy & Security → Files and Folders, then Graph → Refresh now. (Original error: ${msg})`;
  }
  return msg;
}

async function pushGraph() {
  if (!win || win.isDestroyed()) return;
  const g = await buildGraph();
  if (win && !win.isDestroyed()) win.webContents.send('graph:update', g);
}

// Coalesce bursty filesystem events (editors + atomic renames fire several) into one rebuild.
function scheduleRebuild() { clearTimeout(debounceTimer); debounceTimer = setTimeout(pushGraph, 200); }

// LIVE: watch data/state.json (via its dir, so atomic rename-writes are still caught) and the whole
// Chronos vault tree (recursive). Any change → rebuild → push. No manual refresh.
function startWatching() {
  const watchDir = (dir, opts) => {
    if (!dir || !existsSync(dir)) return;
    try { watchers.push(watch(dir, opts, scheduleRebuild)); }
    catch (e) { console.error('watch failed for', dir, e.message); }
  };
  if (sources.statePath) watchDir(path.dirname(sources.statePath), {});
  if (sources.vaultPath) watchDir(sources.vaultPath, { recursive: true });
}
function stopWatching() { for (const w of watchers.splice(0)) { try { w.close(); } catch { /* ignore */ } } }

// ---- first-run / manual setup: point the app at the repos ----
async function setupDataFolders({ force = false } = {}) {
  if (!force && (sources.stateFound || sources.vaultFound)) return sources;
  try { return await runFolderPickers(); }
  catch (e) { console.error('data-folder setup failed:', e && e.message || e); return sources; }
}
async function runFolderPickers() {
  const pick = await dialog.showOpenDialog({
    title: 'Locate Seen Command',
    message: 'Select your seen-command repo folder. Chronos reads data/state.json there and the Chronos vault at ../seen/memory.',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory'],
  });
  if (!pick.canceled && pick.filePaths[0]) {
    const root = pick.filePaths[0];
    const cfg = loadConfig();
    cfg.statePath = path.join(root, 'data', 'state.json');
    const vaultGuess = path.join(root, '..', 'seen', 'memory');
    if (existsSync(vaultGuess)) cfg.vaultPath = vaultGuess;
    saveConfig(cfg);
    refreshSources();
  }
  // If the vault still isn't found, offer to locate it directly (optional).
  if (!sources.vaultFound) {
    const pv = await dialog.showOpenDialog({
      title: 'Locate the Chronos vault (optional)',
      message: "Select the seen repo's memory/ folder — the bi-temporal vault. Cancel to run on the Seen Command graph only.",
      buttonLabel: 'Use this vault',
      properties: ['openDirectory'],
    });
    if (!pv.canceled && pv.filePaths[0]) { const cfg = loadConfig(); cfg.vaultPath = pv.filePaths[0]; saveConfig(cfg); refreshSources(); }
  }
  return sources;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1040, minHeight: 720,
    backgroundColor: '#070b14',
    title: TITLE,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
  // Keep the version in the title bar even if the page tries to set its own <title>.
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(TITLE); });
  win.once('ready-to-show', () => { win.setTitle(TITLE); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

ipcMain.handle('graph:request', () => buildGraph());
ipcMain.handle('sources:info', () => ({ ...sources, today: today(), version: APP_VERSION }));
ipcMain.handle('access:list', () => accessControl && sources.vaultPath ? accessControl.listClients(sources.vaultPath) : []);
async function syncClientRecord(id) {
  if (!syncAccessClient || !cloudConfigured || !cloudConfigured()) return { synced: false, reason: 'cloud not configured' };
  const record = accessControl.getClientRecord(sources.vaultPath, id);
  try { return await syncAccessClient(record); } catch (e) { return { synced: false, reason: e.message }; }
}
ipcMain.handle('access:issue', async (_e, input) => {
  if (!accessControl || !sources.vaultPath) throw new Error('Chronos vault unavailable');
  const out = accessControl.issueClient(sources.vaultPath, input || {});
  const credentialFile = input && input.installLocal
    ? accessControl.installClientCredential({ name: out.client.name, secret: out.secret })
    : null;
  const delivered = accessControl.credentialDeliveryResult(out, { credentialFile });
  delivered.cloud = await syncClientRecord(out.client.id);
  return delivered;
});
ipcMain.handle('access:revoke', async (_e, id) => {
  const client = accessControl.listClients(sources.vaultPath).find((c) => c.id === String(id || ''));
  accessControl.revokeClient(sources.vaultPath, String(id || ''));
  if (client && client.installedOnThisMac) accessControl.removeInstalledCredential(client.name);
  return { revoked: true, cloud: await syncClientRecord(String(id || '')) };
});
// Renew keeps the secret, so nothing is installed or shown; only the record's new expiry is synced.
ipcMain.handle('access:renew', async (_e, id, expiresAt) => {
  if (!accessControl || !sources.vaultPath) throw new Error('Chronos vault unavailable');
  const out = accessControl.renewClient(sources.vaultPath, String(id || ''), { expiresAt: expiresAt || null });
  return { ...out, cloud: await syncClientRecord(out.client.id) };
});
ipcMain.handle('access:rotate', async (_e, id) => {
  const old = accessControl.listClients(sources.vaultPath).find((c) => c.id === String(id || ''));
  const out = accessControl.rotateClient(sources.vaultPath, String(id || ''));
  const credentialFile = old && old.installedOnThisMac
    ? accessControl.installClientCredential({ name: out.client.name, secret: out.secret })
    : null;
  const delivered = accessControl.credentialDeliveryResult(out, { credentialFile });
  const oldCloud = await syncClientRecord(String(id || ''));
  delivered.cloud = await syncClientRecord(out.client.id);
  delivered.cloudPrevious = oldCloud;
  return delivered;
});
ipcMain.handle('access:copy-once', (_e, secret) => {
  if (!/^chr_[A-Za-z0-9_-]{40,}$/.test(String(secret || ''))) throw new Error('invalid credential');
  clipboard.writeText(String(secret)); return true;
});

// The Brain activity panel: every write newest-first (from the vault's own provenance, so each AI
// client's writes appear with its identity) plus every request made of the brain (from the MCP
// server's access log). Read fresh on each open — the vault may have changed a second ago.
ipcMain.handle('activity:request', async () => {
  try {
    if (!buildActivity || !readVaultIndex || !sources.vaultPath) {
      return { recent: [], all: [], requests: [], counts: { changes: 0, requests: 0 }, error: 'no vault' };
    }
    const facts = readVaultIndex(sources.vaultPath).facts || [];
    const payload = { ...buildActivity({ facts, vaultPath: sources.vaultPath }), vaultPath: sources.vaultPath };
    // Merge CLOUD session activity (the product gateway's brain_access audit) into the requests feed,
    // so an AI client running on a remote machine is as visible here as a local one. Local rows
    // and cloud rows share one shape; newest first across both. [] on any failure keeps local intact.
    try {
      if (fetchBrainAccess) {
        const cloud = await fetchBrainAccess({ limit: 200 });
        if (cloud.length) {
          payload.requests = [...payload.requests, ...cloud]
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 300);
          payload.counts.requests = payload.requests.length;
          payload.counts.requestWrites = payload.requests.filter((r) => r.mode === 'write').length;
          payload.counts.requestReads = payload.counts.requests - payload.counts.requestWrites;
          payload.counts.cloudRequests = cloud.length;
          payload.newestRequestAt = payload.requests.length ? payload.requests[0].at : payload.newestRequestAt;
        }
      }
    } catch { /* cloud feed is additive only */ }
    return payload;
  } catch (e) {
    console.error('activity build failed:', e);
    return { recent: [], all: [], requests: [], counts: { changes: 0, requests: 0 }, error: explainGraphError(e) };
  }
});

// The Health view: the Keeper's own audit of the brain — current-vs-total facts, contradictions, and
// facts that look stale. keeper.review() resolves the vault itself, so pin CHRONOS_VAULT to the vault
// THIS window is showing; otherwise a user-configured vault (from the first-run folder picker) would be
// audited from the wrong place. Loaded lazily so a keeper failure can never block app startup, and it
// always returns an object — the renderer renders `error` as text rather than an empty pane.
let keeperReview = null; // from lib/keeper.mjs
ipcMain.handle('health:request', async () => {
  const info = { ...sources, today: today(), version: APP_VERSION };
  try {
    if (sources.vaultPath) process.env.CHRONOS_VAULT = sources.vaultPath;
    if (!keeperReview) { const K = await import('./lib/keeper.mjs'); keeperReview = K.review; }
    return { ...keeperReview(), sources: info };
  } catch (e) {
    console.error('health review failed:', e);
    return { error: explainGraphError(e), sources: info };
  }
});

// The Overnight view: the 4am agents' digests, newest first. Read fresh from the vault's day-notes —
// the cloud pull may have landed one seconds ago. Loaded lazily, and always returns an object so the
// renderer shows `error` as text instead of an empty pane.
let readOvernight = null; // from lib/overnight.mjs
ipcMain.handle('overnight:request', async () => {
  const info = { ...sources, today: today(), version: APP_VERSION };
  try {
    if (!sources.vaultPath) return { entries: [], days: [], counts: { entries: 0, runs: 0 }, sources: info, error: 'no vault' };
    if (!readOvernight) { const O = await import('./lib/overnight.mjs'); readOvernight = O.readOvernight; }
    return { ...readOvernight({ vaultPath: sources.vaultPath, days: 7, today: today() }), sources: info };
  } catch (e) {
    console.error('overnight read failed:', e);
    return { entries: [], days: [], counts: { entries: 0, runs: 0 }, sources: info, error: explainGraphError(e) };
  }
});

// Ask the renderer to open the Brain activity view on a given section. The menu is the entry point, so
// it opens on whichever section was chosen rather than always landing on the same tab.
function openActivity(section) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  win.webContents.send('activity:open', section);
  if (win.isMinimized()) win.restore();
  win.focus();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { label: 'Graph', submenu: [
      { label: 'Refresh now', accelerator: 'CmdOrCtrl+R', click() { pushGraph(); } },
      { type: 'separator' },
      { label: 'Set data folders…', async click() { await setupDataFolders({ force: true }); stopWatching(); startWatching(); pushGraph(); } },
    ] },
    { label: 'Brain', submenu: [
      { label: 'Latest changes', accelerator: 'CmdOrCtrl+L', click() { openActivity('recent'); } },
      { label: 'All changes', accelerator: 'CmdOrCtrl+Shift+L', click() { openActivity('all'); } },
      { label: 'AI traffic', accelerator: 'CmdOrCtrl+Alt+L', click() { openActivity('requests'); } },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(async () => {
  // The .app bundle is read-only: runtime state (the cloud-sync watermark) must live under a writable
  // per-user dir, or cloud.mjs's fallback writes it INSIDE the bundle and breaks the signature seal on
  // every sync. Seen Command's app/main.js already does this; Chronos must too.
  process.env.SEEN_HOME = app.getPath('userData');
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    await loadLib();
    refreshSources();
    if (!sources.stateFound && !sources.vaultFound) { await setupDataFolders(); }
  } catch (e) {
    console.error('startup setup failed (opening anyway):', e && e.message || e);
  }
  console.log('Chronos sources:', { stateFound: sources.stateFound, vaultFound: sources.vaultFound, vaultPath: sources.vaultPath });
  buildMenu();
  createWindow();
  startWatching();
  loadSupabaseEnv();
  startCloudSync();
  startPowerAssertion();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { stopWatching(); stopCloudSync(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { stopWatching(); stopCloudSync(); stopPowerAssertion(); });
