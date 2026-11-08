// In-app updates — the top-bar badge ("Update ready · 5 changes") and the panel: what's new, Update &
// restart, live progress of the tested install (lib/updater.mjs → engine/self-update.mjs --no-merge).
// Opened from the badge, Settings, or the app menu's "Check for Updates…" (window.openUpdater(true)).
(function () {
  var PT = 'America/Los_Angeles';
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  var short = function (s) { return s ? String(s).slice(0, 7) : '—'; };
  function req(method, u) { return fetch(u, { method: method }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); }
  var poll = null, status = null;

  function badge() {
    var host = document.getElementById('clock'); if (!host) return;
    var b = document.getElementById('upd-badge');
    if (!b) { b = document.createElement('button'); b.id = 'upd-badge'; b.className = 'upd-badge'; b.onclick = function () { window.openUpdater(false); }; host.parentNode.insertBefore(b, host); }
    var v = status && status.verdict; var p = status && status.progress;
    var installing = p && (p.status === 'building' || p.status === 'queued');
    if (installing) { b.hidden = false; b.className = 'upd-badge run'; b.textContent = 'Updating…'; return; }
    if (v && v.state === 'available') { b.hidden = false; b.className = 'upd-badge'; b.textContent = 'Update ready · ' + (v.commits && v.commits.length ? v.commits.length + ' change' + (v.commits.length === 1 ? '' : 's') : 'new'); return; }
    b.hidden = true;
  }
  function stepsHtml(p) {
    if (!p) return '';
    var tone = p.status === 'updated' ? 'ok' : p.status === 'failed' ? 'bad' : 'run';
    var label = p.status === 'updated' ? 'Installed — restarting' : p.status === 'failed' ? 'Update stopped' : 'Installing';
    return '<div class="u-sub">Progress</div><div class="u-actions"><span class="u-chip ' + tone + '">' + label + '</span><span class="u-muted sm">started ' + E(fmt(p.startedAt)) + '</span></div>'
      + (p.error ? '<div class="u-note bad">' + E(p.error) + '</div>' : '')
      + '<pre class="upd-log">' + E((p.log || []).map(function (l) { return String(l).replace(/^\[self-update\]\s*/, ''); }).join('\n') || 'Starting…') + '</pre>';
  }
  function render() {
    var a = document.querySelector('#upd-panel .u-drawer'); if (!a) return;
    var v = (status && status.verdict) || null; var p = status && status.progress; var run = status && status.running;
    var installing = p && (p.status === 'building' || p.status === 'queued');
    var head = !v ? '<p class="u-muted">Not checked yet.</p>'
      : v.state === 'up-to-date' ? '<p class="u-lead">You’re on the latest version.</p>'
      : v.state === 'available' ? '<p class="u-lead">A new version is ready — ' + (v.commits.length || 'new') + ' change' + (v.commits.length === 1 ? '' : 's') + '.</p>'
      : v.state === 'blocked' ? '<div class="u-note warn">' + E(v.reason) + '</div>'
      : '<div class="u-note">' + E(v.reason || 'Could not check.') + '</div>';
    var list = v && v.commits && v.commits.length ? '<div class="u-sub">What’s new</div><ul class="u-list tight">' + v.commits.slice(0, 25).map(function (c) { return '<li class="u-row"><div class="u-row-main"><b>' + E(c.subject) + '</b><p>' + E(fmt(c.at)) + ' · ' + E(short(c.sha)) + '</p></div></li>'; }).join('') + '</ul>' : '';
    var wn = status && status.whatsNew && status.whatsNew.commits && status.whatsNew.commits.length ? '<div class="u-sub">In the update you installed (' + E(short(status.whatsNew.from)) + ' → ' + E(short(status.whatsNew.to)) + ')</div><ul class="u-list tight">' + status.whatsNew.commits.slice(0, 15).map(function (c) { return '<li class="u-row"><div class="u-row-main"><b>' + E(c.subject) + '</b></div></li>'; }).join('') + '</ul>' : '';
    a.innerHTML = '<header class="u-drawer-h"><div><h2>Updates</h2><p class="u-muted">Running ' + E(short(run && run.sha)) + (run && run.builtAt ? ' · built ' + E(fmt(run.builtAt)) : '') + (v && v.checkedAt ? ' · checked ' + E(fmt(v.checkedAt)) : '') + '</p></div><button class="u-btn ghost sm" id="upd-x">✕</button></header>'
      + head
      + '<div class="u-actions">' + (v && v.state === 'available' && !installing ? '<button class="u-btn primary" id="upd-go">Update &amp; restart</button>' : '') + '<button class="u-btn" id="upd-check"' + (installing ? ' disabled' : '') + '>Check now</button></div>'
      + '<p class="u-muted sm">Updating runs every test on the new version first — if any fails, nothing is installed and you keep this one. Then Seen Command rebuilds itself and reopens (a few minutes). It checks for updates on its own every hour.</p>'
      + stepsHtml(p) + list + wn;
    document.getElementById('upd-x').onclick = close;
    var c = document.getElementById('upd-check'); c.onclick = function () { c.disabled = true; c.textContent = 'Checking…'; req('POST', '/api/update/check').then(function () { return load(); }).catch(function (e) { c.textContent = e.message; }); };
    var g = document.getElementById('upd-go'); if (g) g.onclick = function () { g.disabled = true; g.textContent = 'Starting…'; req('POST', '/api/update/apply').then(function () { follow(); }).catch(function (e) { g.textContent = e.message; }); };
  }
  function load() { return req('GET', '/api/update/status').then(function (s) { status = s; badge(); render(); return s; }).catch(function () {}); }
  function follow() { clearInterval(poll); poll = setInterval(function () { load().then(function (s) { var p = s && s.progress; if (p && p.status !== 'building' && p.status !== 'queued') clearInterval(poll); }); }, 2000); load(); }
  function close() { var d = document.getElementById('upd-panel'); if (d) d.remove(); }
  window.openUpdater = function (checkNow) {
    close();
    var d = document.createElement('div'); d.id = 'upd-panel'; d.className = 'u-drawer-wrap';
    d.innerHTML = '<div class="u-drawer-bg"></div><aside class="u-drawer"><div class="u-skeleton"><div></div><div></div></div></aside>';
    document.body.appendChild(d); d.querySelector('.u-drawer-bg').onclick = close;
    (checkNow ? req('POST', '/api/update/check').catch(function () {}) : Promise.resolve()).then(load).then(function (s) { var p = s && s.progress; if (p && (p.status === 'building' || p.status === 'queued')) follow(); });
  };
  if (location.protocol.indexOf('http') === 0) { setTimeout(load, 3000); setInterval(load, 10 * 60_000); }
})();
