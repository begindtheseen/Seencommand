// Seen Command — desktop app shell (Electron). Runs FULLY LIVE from /Applications: a packaged .app
// bundle is read-only, so on launch we (1) seed a writable runtime home under app.getPath('userData')
// and point every child script at it via SEEN_HOME, then (2) spawn the live API server
// (engine/server.mjs) and load http://localhost:PORT — so Approve + Board Room chat hit real
// connectors and the model. Opening the app does NOT run a paid/model-backed board meeting; those
// remain explicit through the UI/menu/schedule (or SEEN_MEETING_ON_LAUNCH=1 for an intentional opt-in).
//
// Dev: `npm run app:dev` (needs `npm install` first — Electron is a devDependency).
// Install: `npm run app:install` builds the .app and copies it (via ditto) into /Applications.
// No Electron installed? The pure-Node path still works: double-click "Seen Command.command".

const { app, BrowserWindow, Menu, shell, powerSaveBlocker, Notification, powerMonitor, dialog } = require('electron');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { mergeEnvText } = require('./env-merge.js');
const { seedRuntimeAssets } = require('./runtime-assets.js');
const { selectChildRuntime, buildChildEnv } = require('./child-runtime.js');
const { meetingOnLaunch } = require('./launch-policy.js');
const { openSplash } = require('./splash.js');

const ROOT = path.join(__dirname, '..');              // repo root, or …/Contents/Resources/app when packaged (READ-ONLY)
const USERDATA = app.getPath('userData');             // writable runtime home (…/Library/Application Support/seen-command)
const PORT = Number(process.env.PORT || 4173);
// Prefer a real Node binary for background workers when this Mac has one. On current macOS builds,
// immediately spawning the freshly ad-hoc-signed Electron executable back into NODE mode can stall
// in module loading after an in-place app update. The packaged Electron runtime remains the fallback.
const CHILD_RUNTIME = selectChildRuntime(process.execPath);

// Read-only seed sources bundled with the app. .env ships via extraResources (Contents/Resources/.env).
const BUNDLED_ENV = app.isPackaged ? path.join(process.resourcesPath, '.env') : path.join(ROOT, '.env');
const BUNDLED_DASH = path.join(ROOT, 'public', 'command-center.html');
const BUNDLED_STATE = path.join(ROOT, 'data', 'state.json');

// Seed the writable home on first launch: the keys (.env), a last-built dashboard, and a state file,
// so the window always has something live to show even before the first fresh meeting completes.
// The .env is ALSO merged on every later launch — keys new to the bundled .env are appended to the
// runtime copy, but values the user edited there are never overwritten (see app/env-merge.js).
function seedHome() {
  try {
    seedRuntimeAssets({ userData: USERDATA, bundledDashboard: BUNDLED_DASH, bundledState: BUNDLED_STATE });
    seedEnv(BUNDLED_ENV, path.join(USERDATA, '.env'));
  } catch (e) { console.error('seed failed:', e.message); }
}

// First launch: copy the bundled .env whole. After that: append any keys the bundle has that the
// runtime file doesn't. The runtime file stays the user's source of truth for values — no line the
// user wrote is ever modified, and a write only happens when there is actually something to add.
function seedEnv(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) { fs.copyFileSync(src, dest); fs.chmodSync(dest, 0o600); return; }
  const { text, added } = mergeEnvText(fs.readFileSync(src, 'utf8'), fs.readFileSync(dest, 'utf8'));
  if (added.length === 0) { fs.chmodSync(dest, 0o600); return; }
  fs.writeFileSync(dest, text, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  console.log('seeded new .env keys from bundle:', added.join(', '));
}

// Env for every child: the writable home, Node mode (use Electron's bundled Node), the port, and
// SEEN_NO_OPEN so the spawned server does NOT also open the default browser (the app IS the window).
// Electron 35 embeds Node 22.x, where node:sqlite (the Creator Library reader) is gated behind
// --experimental-sqlite — enable it for the child so Library reads work in the packaged app.
function childEnv() {
  const nodeOptions = [process.env.NODE_OPTIONS, '--experimental-sqlite'].filter(Boolean).join(' ').trim();
  const compilerToolDir = app.isPackaged
    ? path.join(process.resourcesPath, 'video-software-compiler')
    : path.join(ROOT, 'tools', 'video-software-compiler');
  return buildChildEnv({ baseEnv: process.env, runtime: CHILD_RUNTIME, userData: USERDATA, port: PORT, nodeOptions, compilerToolDir });
}

// Run a fresh board meeting + rebuild the dashboard in the background (never blocks the window), then
// call `done`. Uses spawn (not execFileSync) so the UI stays responsive during the live calls.
const boardChildren = new Set();
let quitting = false;
function trackBoardChild(child) {
  boardChildren.add(child);
  child.once('exit', () => boardChildren.delete(child));
  child.once('error', () => boardChildren.delete(child));
  return child;
}
function stopBoardChildren() {
  for (const child of boardChildren) { try { child.kill(); } catch { /* already gone */ } }
  boardChildren.clear();
}
// Keep the brain current WITHOUT a board meeting. A meeting spends real LLM calls across every
// department, so once meetings stopped running on launch (#153) nothing fed the brain: on 2026-08-12
// its newest business fact was a week old, and a brain that lags the snapshot it is meant to arbitrate
// silently stops correcting anything (lib/kpi-reconcile.mjs prefers whichever side is fresher).
// scripts/brain-sync.mjs is the cheap half on its own — fetch the live signals, record them, push.
// No models, so it is safe on a short interval. Re-recording an unchanged value is a no-op, so this
// does not churn the vault. Runs once shortly after launch, then hourly.
// The hourly brain sync and the live server must not be silently suspended by App Nap — a "power
// machine whose biggest weakness is the laptop being closed" is the failure mode this guards against.
// `prevent-app-suspension` keeps timers firing while the app is backgrounded or the display sleeps.
// Honest limit: it cannot stop a lid-closed-on-battery sleep — Amphetamine (+ Enhancer for
// closed-display) owns that layer; and the cloud brain (Supabase) is the true always-on copy, so a
// sleeping Mac loses NOTHING durable — the next brain-sync on wake reconciles.
let powerBlockerId = null;
function startPowerAssertion() {
  try {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log(`Seen Command: app-suspension blocker active (id ${powerBlockerId})`);
  } catch (e) { console.error('power assertion failed (non-fatal):', e.message); }
}
function stopPowerAssertion() {
  try { if (powerBlockerId != null && powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId); }
  catch { /* already stopped */ }
  powerBlockerId = null;
}

const BRAIN_SYNC_MS = 60 * 60 * 1000;
const BRAIN_SYNC_FIRST_MS = 30 * 1000; // let the server settle first
let brainSyncTimer = null;
function brainSync() {
  const s = trackBoardChild(spawn(CHILD_RUNTIME.executable, [path.join(ROOT, 'scripts', 'brain-sync.mjs'), '--quiet'],
    { cwd: ROOT, env: childEnv(), stdio: 'inherit' }));
  s.on('error', (e) => console.error('brain-sync error:', e.message));
}
function startBrainSync() {
  setTimeout(() => { if (!quitting) brainSync(); }, BRAIN_SYNC_FIRST_MS);
  brainSyncTimer = setInterval(() => { if (!quitting) brainSync(); }, BRAIN_SYNC_MS);
}
function stopBrainSync() { if (brainSyncTimer) { clearInterval(brainSyncTimer); brainSyncTimer = null; } }

function boardMeeting(done) {
  const run = trackBoardChild(spawn(CHILD_RUNTIME.executable, [path.join(ROOT, 'engine', 'run.mjs')], { cwd: ROOT, env: childEnv(), stdio: 'inherit' }));
  run.on('error', (e) => { console.error('run.mjs error:', e.message); if (done) done(); });
  run.on('exit', () => {
    if (quitting) { if (done) done(); return; }
    const build = trackBoardChild(spawn(CHILD_RUNTIME.executable, [path.join(ROOT, 'scripts', 'build-dashboard.mjs')], { cwd: ROOT, env: childEnv(), stdio: 'inherit' }));
    build.on('error', (e) => { console.error('build-dashboard error:', e.message); if (done) done(); });
    build.on('exit', () => { if (done) done(); });
  });
}

// The live API server — long-lived child. Approve / Board Room chat / signals hit this.
let server = null;
function startServer() {
  server = spawn(CHILD_RUNTIME.executable, [path.join(ROOT, 'engine', 'server.mjs')], { cwd: ROOT, env: childEnv(), stdio: 'inherit' });
  server.on('error', (e) => console.error('server error:', e.message));
  server.on('exit', (code) => { server = null; if (code) console.error('server exited', code); });
}
function stopServer() { if (server) { try { server.kill(); } catch { /* ignore */ } server = null; } }

let win;
// A plain loading screen shown INSTANTLY — the window never sits blank or "frozen" while the server boots.
const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b0d12;color:#9aa3b2;font:500 13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;display:grid;place-items:center}
  .w{display:grid;gap:14px;justify-items:center}.b{font:600 18px -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;color:#e7e9ee;letter-spacing:.2px}
  .bar{width:160px;height:3px;border-radius:3px;background:#1b2030;overflow:hidden}.bar i{display:block;width:40%;height:100%;background:#4f8cff;border-radius:3px;animation:m 1.1s ease-in-out infinite}
  @keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}</style></head><body><div class="w"><div class="b">Seen Command</div><div class="bar"><i></i></div><div>Starting…</div></div></body></html>`);
function serverUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/notifications?limit=1', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
let splash = null; // the launch splash (app/splash.js) — only on a normal, visible launch
async function loadAppWhenReady() {
  for (let i = 0; i < 240 && win && !win.isDestroyed(); i++) { if (await serverUp()) break; await new Promise((r) => setTimeout(r, 250)); }
  if (splash) splash.step(2);
  if (win && !win.isDestroyed()) win.loadURL(`http://localhost:${PORT}/`);
}
function buildInfo() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'build-info.json'), 'utf8')); } catch { return {}; } }
// The splash leaves (after its minimum time) only once the real app has loaded; then the window shows.
// A page that never loads still shows the window after 60 s, with its own retry + loading screen.
function revealWhenLoaded() {
  if (!splash) return;
  const s = splash; let done = false;
  const reveal = () => { if (done) return; done = true; s.close().then(() => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } splash = null; }); };
  // Reveal when Home has drawn its data (window.__homeReady), not when an empty page has loaded — at most
  // 10 s after the page loads; the splash's own minimum time still applies.
  win.webContents.on('did-finish-load', () => {
    if (!String(win.webContents.getURL()).startsWith('http://localhost')) return;
    if (s) s.step(3);
    const started = Date.now();
    const poll = () => {
      if (done || !win || win.isDestroyed()) return;
      win.webContents.executeJavaScript('window.__homeReady === true').then((ok) => { if (ok || Date.now() - started > 10_000) reveal(); else setTimeout(poll, 150); }).catch(() => reveal());
    };
    poll();
  });
  setTimeout(reveal, 60_000);
}
function createWindow({ withSplash = false } = {}) {
  if (withSplash) { try { const b = buildInfo(); splash = openSplash({ version: b.version ? `v${b.version}` : app.getVersion(), sha: b.sha || '' }); setTimeout(() => splash && splash.step(1), 700); } catch (e) { console.error('splash failed:', e.message); splash = null; } }
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1000, minHeight: 700,
    backgroundColor: '#0b0d12',
    title: 'Seen Command',
    show: !splash,
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadURL(SPLASH);
  revealWhenLoaded();
  loadAppWhenReady();
  win.webContents.on('did-fail-load', (_e, _code, _desc, url) => {
    if (String(url || '').startsWith('http://localhost')) setTimeout(() => { if (win && !win.isDestroyed()) loadAppWhenReady(); }, 500);
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  // Closing the window keeps Seen Command running in the background (searches, schedules, notifications);
  // Quit (⌘Q, the Dock menu) is the only thing that stops it.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); if (process.platform === 'darwin' && !closedOnce) { closedOnce = true; notifyNative({ title: 'Seen Command is still running', body: 'Searches and schedules keep going in the background. Quit from the Dock to stop it.' }); } } });
}
let closedOnce = false;
function showWindow(tab) {
  if (!win || win.isDestroyed()) createWindow();
  win.show(); win.focus();
  if (tab) win.webContents.executeJavaScript(`window.showTab && window.showTab(${JSON.stringify(String(tab))})`).catch(() => {});
}
// Open the Brain tab on a view ('graph' | 'activity' | 'overnight' | 'health' | 'access'; null = as it was).
function openBrain(view, section = null) {
  showWindow();
  const js = `window.openBrain ? window.openBrain(${JSON.stringify(view)}, ${JSON.stringify(section)}) : (window.showTab && window.showTab('vault'))`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

// ---- native notifications + Dock badge (from the server's notification store) -------------------
let lastNoticeId = null;
function getJson(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 4000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function notifyNative({ title, body, tab }) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(title).slice(0, 120), body: String(body || '').slice(0, 300), silent: false });
    n.on('click', () => showWindow(tab || 'notifications'));
    n.show();
  } catch (e) { console.error('notification failed:', e.message); }
}
async function pollNotices() {
  const d = await getJson(`/api/notifications?after=${lastNoticeId || 0}&limit=20`);
  if (!d) return;
  if (lastNoticeId == null) { lastNoticeId = d.latest || 0; } // start from now — never replay old ones on launch
  else for (const n of [...(d.items || [])].reverse()) {
    lastNoticeId = Math.max(lastNoticeId, n.id);
    if (n.level !== 'info' || ['search', 'meeting'].includes(n.kind)) notifyNative({ title: n.title, body: n.body, tab: n.tab || 'notifications' });
  }
  try { if (process.platform === 'darwin') app.dock.setBadge(d.unread ? String(d.unread) : ''); else app.setBadgeCount(d.unread || 0); } catch { /* badge is cosmetic */ }
}
let noticeTimer = null;
function startNotices() { noticeTimer = setInterval(() => { pollNotices().catch(() => {}); }, 15_000); setTimeout(() => { pollNotices().catch(() => {}); }, 4000); }

// ---- always on ----------------------------------------------------------------------------------
// Opens at login (hidden), so schedules and searches resume after a restart without anyone opening it.
function setOpenAtLogin(on) { try { app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true }); } catch { /* not supported here */ } }
function prefsPath() { return path.join(USERDATA, 'shell-prefs.json'); }
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsPath(), JSON.stringify(p, null, 2)); } catch { /* best effort */ } }
// A Mac with its lid closed sleeps, and a sleeping Mac runs nothing. pmset's disablesleep keeps it awake
// with the lid closed; it needs the owner's admin password (macOS asks), and it is the owner's explicit choice.
function lidAwake(on) {
  const cmd = `pmset -a disablesleep ${on ? 1 : 0}`;
  execFile('osascript', ['-e', `do shell script "${cmd}" with administrator privileges`], (err) => {
    if (err) { dialog.showMessageBox({ type: 'warning', message: 'The setting was not changed', detail: String(err.message || err).slice(0, 300) }); return; }
    const p = readPrefs(); p.lidAwake = !!on; writePrefs(p); buildMenu();
    notifyNative({ title: on ? 'Stays awake with the lid closed' : 'Normal sleep restored', body: on ? 'Scheduled searches keep running with the lid closed. Turn it off from the Seen Command menu.' : 'The Mac sleeps normally again.' });
  });
}
// On wake, the run manager's minute tick catches up any missed schedule ONCE; nudge it immediately.
function onWake() {
  try { const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/aggregation/schedules/tick', method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${PORT}` }, timeout: 10000 }, (res) => res.resume()); req.on('error', () => {}); req.end('{}'); } catch { /* the minute tick catches it anyway */ }
  pollNotices().catch(() => {});
}

// Reload WITHOUT throwing Brandon out of what he is doing.
//
// A bare win.reload() is a hard navigation: it drops him on the landing tab (Board Room) and eats a
// half-typed message — "I literally get kicked off of whatever I'm doing and forced back to the chat."
// The page owns softReload(), which stashes the active tab + composer draft and restores them after
// the load, so the shell drives THAT. A hard reload is only the fallback for a page too old to have it.
function reloadWindow() {
  if (!win || win.isDestroyed()) return;
  win.webContents
    .executeJavaScript('typeof window.__softReload === "function" ? (window.__softReload(), true) : false')
    .then((soft) => { if (!soft && win && !win.isDestroyed()) win.reload(); })
    .catch(() => { if (win && !win.isDestroyed()) win.reload(); });
}

function buildMenu() {
  const prefs = readPrefs();
  const login = (() => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } })();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', click() { showWindow('settings'); setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.openUpdater && window.openUpdater(true)').catch(() => {}); }, 400); } }, { type: 'separator' },
      { label: 'Open at login (runs in the background)', type: 'checkbox', checked: login, click(i) { setOpenAtLogin(i.checked); const p = readPrefs(); p.openAtLogin = i.checked; writePrefs(p); } },
      { label: 'Stay awake with the lid closed…', type: 'checkbox', checked: !!prefs.lidAwake, click(i) { lidAwake(i.checked); } },
      { type: 'separator' }, { role: 'hide' }, { label: 'Quit Seen Command', accelerator: 'CmdOrCtrl+Q', click() { quitting = true; app.quit(); } }] },
    { role: 'editMenu' },
    { label: 'Board Meeting', submenu: [
      // NOT CmdOrCtrl+R: a reflexive reload must never spend model calls.
      { label: 'Run new board meeting', accelerator: 'CmdOrCtrl+Shift+M', click() { boardMeeting(reloadWindow); } },
    ] },
    // The Brain (was the separate Chronos app, retired 2026-10-21): the same menu, opening Seen Command's Brain tab.
    { label: 'Brain', submenu: [
      { label: 'Latest changes', accelerator: 'CmdOrCtrl+L', click() { openBrain('activity', 'recent'); } },
      { label: 'All changes', accelerator: 'CmdOrCtrl+Shift+L', click() { openBrain('activity', 'all'); } },
      { label: 'AI traffic', accelerator: 'CmdOrCtrl+Alt+L', click() { openBrain('activity', 'requests'); } },
      { type: 'separator' },
      { label: 'Graph', click() { openBrain('graph'); } },
      { label: 'Overnight', click() { openBrain('overnight'); } },
      { label: 'Health', click() { openBrain('health'); } },
      { label: 'Access', click() { openBrain('access'); } },
      { type: 'separator' },
      { label: 'Pull the cloud brain now', click() { openBrain(null); if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.refreshBrain && window.refreshBrain()').catch(() => {}); } },
    ] },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click() { reloadWindow(); } },
      { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
  if (process.platform === 'darwin') {
    try { app.dock.setMenu(Menu.buildFromTemplate([
      { label: 'Open Seen Command', click() { showWindow(); } },
      { label: 'Search', click() { showWindow('search'); } },
      { label: 'Notifications', click() { showWindow('notifications'); } },
      { label: 'Check for Updates…', click() { showWindow('settings'); setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.openUpdater && window.openUpdater(true)').catch(() => {}); }, 400); } },
      { type: 'separator' },
      { label: 'Quit (stops searches and schedules)', click() { quitting = true; app.quit(); } },
    ])); } catch { /* no dock */ }
  }
}

app.whenReady().then(() => {
  seedHome();
  process.env.SEEN_HOME = USERDATA;
  startServer();                 // 1) live API up
  buildMenu();
  // Opened at login → stay in the background (the Dock icon shows it is running).
  const hidden = (() => { try { return app.getLoginItemSettings().wasOpenedAsHidden; } catch { return false; } })();
  createWindow({ withSplash: !hidden }); // 2) the splash at once (not when opened hidden at login), then the app when it has loaded
  if (hidden && win) win.hide();
  const prefs = readPrefs();
  if (prefs.openAtLogin === undefined) { setOpenAtLogin(true); prefs.openAtLogin = true; writePrefs(prefs); buildMenu(); } // always-on by default (owner, 2026-10-21)
  if (meetingOnLaunch()) boardMeeting(reloadWindow); // explicit opt-in only; normal launch is read-only
  startBrainSync();              // 3) keep the brain current without spending a meeting
  startPowerAssertion();         // 4) and keep those timers alive through App Nap
  startNotices();                // 5) native notifications + Dock badge
  try { powerMonitor.on('resume', onWake); powerMonitor.on('unlock-screen', onWake); } catch { /* not on this platform */ }
});
app.on('activate', () => { showWindow(); });
app.on('before-quit', () => { quitting = true; if (noticeTimer) clearInterval(noticeTimer); stopBrainSync(); stopPowerAssertion(); stopServer(); stopBoardChildren(); });
// Closing the window no longer quits: Seen Command keeps running searches and schedules in the background.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') { stopServer(); app.quit(); } });
