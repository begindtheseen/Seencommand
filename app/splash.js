// The launch splash (owner, 2026-10-21: "add a cool splash screen like how [ORBIT and LAUNCHPAD] have —
// long enough for me to see it"). Its own frameless window, like ORBIT's: shown at once, at least
// MIN_MS on screen, and it narrates the REAL start-up steps (engine → Seen → workspace) as they pass —
// never a fake progress bar. The main window stays hidden behind it until the app has actually loaded.
const { BrowserWindow } = require('electron');

const MIN_MS = 2800;
const STEPS = ['Starting the engine', 'Connecting to Seen', 'Loading your workspace', 'Bringing in your numbers', 'Ready'];

function html({ version = '', sha = '' } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{--bg:#07090e;--ink:#e7e9ee;--muted:#7d8697;--accent:#4f8cff;--violet:#8b7cf6;--green:#3ecf8e}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:500 13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;overflow:hidden;-webkit-user-select:none;-webkit-app-region:drag}
  .bg{position:absolute;inset:-20%;background:radial-gradient(40% 50% at 30% 40%,rgba(79,140,255,.20),transparent 70%),radial-gradient(35% 45% at 72% 62%,rgba(139,124,246,.16),transparent 70%);animation:drift 9s ease-in-out infinite alternate}
  @keyframes drift{to{transform:translate(3%,-2%) scale(1.06)}}
  .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:38px 38px;mask-image:radial-gradient(60% 60% at 50% 50%,#000,transparent)}
  .wrap{position:relative;height:100%;display:grid;grid-template-columns:230px 1fr;align-items:center;padding:0 54px;gap:34px}
  .mark{position:relative;width:190px;height:190px}
  .ring{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(79,140,255,.28)}
  .ring.r2{inset:26px;border-color:rgba(139,124,246,.30)}.ring.r3{inset:54px;border-color:rgba(255,255,255,.12)}
  .core{position:absolute;inset:74px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#9cc0ff,var(--accent) 55%,#2a4fb0);box-shadow:0 0 40px rgba(79,140,255,.55),0 0 90px rgba(79,140,255,.25);animation:pulse 2.4s ease-in-out infinite}
  @keyframes pulse{50%{box-shadow:0 0 56px rgba(79,140,255,.75),0 0 120px rgba(79,140,255,.3)}}
  .orbit{position:absolute;inset:0;animation:spin 6s linear infinite}.orbit.o2{inset:26px;animation-duration:4.2s;animation-direction:reverse}.orbit.o3{inset:54px;animation-duration:2.9s}
  .orbit i{position:absolute;top:-4px;left:50%;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--ink);box-shadow:0 0 12px var(--accent)}
  .orbit.o2 i{background:var(--violet);box-shadow:0 0 12px var(--violet)}.orbit.o3 i{width:6px;height:6px;background:var(--green);box-shadow:0 0 10px var(--green)}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{margin:0;font:700 34px/1.1 -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;letter-spacing:-.3px;opacity:0;transform:translateY(8px);animation:in .7s .15s forwards}
  .tag{margin:8px 0 26px;color:var(--muted);font-size:14px;opacity:0;animation:in .7s .35s forwards}
  @keyframes in{to{opacity:1;transform:none}}
  ol{list-style:none;margin:0;padding:0;display:grid;gap:9px}
  li{display:flex;align-items:center;gap:10px;color:#4a5263;transition:color .3s}
  li b{width:14px;height:14px;border-radius:50%;border:1.5px solid #2a3142;display:grid;place-items:center;font-size:9px;transition:all .3s}
  li.on{color:var(--ink)}li.on b{border-color:var(--accent);box-shadow:0 0 0 3px rgba(79,140,255,.15);animation:blink 1s ease-in-out infinite}
  li.done{color:var(--muted)}li.done b{border-color:var(--green);background:var(--green);color:#07090e;animation:none}
  @keyframes blink{50%{box-shadow:0 0 0 6px rgba(79,140,255,.05)}}
  .foot{position:absolute;left:54px;right:54px;bottom:22px;display:flex;justify-content:space-between;color:#4a5263;font:11px ui-monospace,Menlo,monospace}
  body.out{animation:fade .45s forwards}@keyframes fade{to{opacity:0}}
  </style></head><body><div class="bg"></div><div class="grid"></div>
  <div class="wrap"><div class="mark"><div class="ring"></div><div class="ring r2"></div><div class="ring r3"></div><div class="orbit"><i></i></div><div class="orbit o2"><i></i></div><div class="orbit o3"><i></i></div><div class="core"></div></div>
  <div><h1>Seen Command</h1><div class="tag">Your company, running — jobs, reports, the board and the brain in one place.</div>
  <ol id="s">${STEPS.map((t, i) => `<li${i === 0 ? ' class="on"' : ''}><b></b>${esc(t)}</li>`).join('')}</ol></div></div>
  <div class="foot"><span>seenjobs.io</span><span>${esc(version)}${sha ? ` · ${esc(String(sha).slice(0, 7))}` : ''}</span></div>
  <script>window.setStep=function(n){var l=document.querySelectorAll('#s li');l.forEach(function(x,i){x.className=i<n?'done':i===n?'on':'';var b=x.querySelector('b');b.textContent=i<n?'✓':'';});};window.leave=function(){document.body.className='out';};</script>
  </body></html>`;
}

// Open the splash; returns { step(n), close(): Promise } — close waits out MIN_MS, fades, then closes.
function openSplash({ version, sha } = {}) {
  const shownAt = Date.now();
  const w = new BrowserWindow({ width: 760, height: 440, frame: false, resizable: false, movable: true, center: true, show: false, backgroundColor: '#07090e', alwaysOnTop: true, skipTaskbar: true, hasShadow: true, roundedCorners: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html({ version, sha })));
  w.once('ready-to-show', () => { if (!w.isDestroyed()) w.show(); });
  let current = 0;
  const step = (n) => { if (n <= current || w.isDestroyed()) return; current = n; w.webContents.executeJavaScript(`window.setStep && setStep(${Number(n)})`).catch(() => {}); };
  const close = () => new Promise((resolve) => {
    const wait = Math.max(0, MIN_MS - (Date.now() - shownAt));
    setTimeout(() => {
      if (w.isDestroyed()) { resolve(); return; }
      step(STEPS.length - 1);
      w.webContents.executeJavaScript('window.leave && leave()').catch(() => {});
      setTimeout(() => { if (!w.isDestroyed()) w.close(); resolve(); }, 520);
    }, wait);
  });
  return { step, close, window: w };
}

module.exports = { openSplash, MIN_MS, STEPS, html };
