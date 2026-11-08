// Data health — the panel at the top of the Jobs tab (2026-10-21). Duplicate listings, stale listings,
// duplicate applicant reports and company duplicates on seenjobs.io: how many, a few examples, and one
// button each that keeps going until the job is done ("removed 2,400 · 0 left"). Backed by
// /api/data-health* (lib/data-health.mjs), which drives Seen's own audited cleanup actions.
// Inlined into public/command-center.html after jobs-client.js. Plain browser JS. California time.
// Cheap on purpose: no timers except a 2-second progress check WHILE a cleanup runs.
(function () {
  var PT = 'America/Los_Angeles';
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  var fmt = function (iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  function req(method, u, body) {
    return fetch(u, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.body = j; throw e; } return j; }); });
  }
  var ROWS = [
    { id: 'job_dupes', kind: 'job_dupes', title: 'Duplicate listings', button: 'Remove duplicates', ask: function (s) { return 'Remove ' + num(s.count) + ' duplicate listings from seenjobs.io? One copy of each stays. Listings someone saved or applied to, and employer posts, are never removed.'; } },
    { id: 'stale', kind: 'stale', title: 'Stale listings', button: 'Clear stale', ask: function (s) { return 'Clear ' + num(s.count) + ' stale listings from seenjobs.io? These have not been seen on their job board for 7+ days. Ones people saved or applied to stay as hidden records.'; } },
    { id: 'report_dupes', kind: 'report_dupes', title: 'Duplicate reports', button: 'Hide copies', ask: null },
    { id: 'company_dupes', kind: 'company_suffix_dupes', title: 'Company duplicates', button: 'Merge Inc / LLC names', ask: function (s) { return 'Merge ' + num(s.count) + ' company names that differ only by Inc / LLC / Corp into their main page? Each merge can be undone in Seen admin. Look-alikes are not touched.'; } },
  ];
  var LABEL = { stale: 'Stale listings', job_dupes: 'Duplicate listings', report_dupes: 'Duplicate reports', company_suffix_dupes: 'Company duplicates' };
  var VERB = { stale: 'cleared', job_dupes: 'removed', report_dupes: 'hidden', company_suffix_dupes: 'merged' };
  var data = null, run = null, poll = null, loading = false, elId = 'dh-panel';

  function el() { return document.getElementById(elId); }
  function stepLine(s) {
    var left = s.left == null ? '' : ' · ' + num(s.left) + ' left';
    var state = s.status === 'running' ? '<span class="u-spin"></span>' : s.status === 'done' ? '<span class="u-chip ok">Done</span>' : s.status === 'failed' ? '<span class="u-chip bad">Failed</span>' : s.status === 'partial' ? '<span class="u-chip warn">Not finished</span>' : '<span class="u-chip dim">Waiting</span>';
    var what = s.status === 'waiting' ? 'next' : s.status === 'running' && !s.rounds ? 'working on the first batch…' : num(s.done) + ' ' + VERB[s.kind] + left;
    return '<li class="u-row"><div class="u-row-main"><b>' + E(LABEL[s.kind] || s.kind) + '</b><p>' + E(what) + (s.error ? ' — ' + E(s.error) : '') + (s.note ? ' · ' + E(s.note) : '') + '</p></div>' + state + '</li>';
  }
  function runBox() {
    if (!run) return '';
    var oneFailed = (run.steps || []).some(function (s) { return s.status === 'failed'; });
    var head = run.running ? 'Cleaning…' : run.status === 'completed' ? 'Last cleanup finished' : run.status === 'failed' ? 'Last cleanup failed' : oneFailed ? 'Last cleanup finished — part of it failed' : 'Last cleanup stopped before the end';
    var tone = run.running ? '' : run.status === 'completed' ? ' ok' : run.status === 'failed' ? ' bad' : ' warn';
    return '<div class="dh-run' + tone + '"><div class="dh-run-h"><b>' + E(head) + '</b><span class="u-muted sm">' + (run.trigger === 'auto' ? 'automatic · ' : '') + E(run.running ? 'started ' + fmt(run.startedAt) : fmt(run.endedAt || run.startedAt)) + '</span></div>'
      + '<ul class="u-list tight">' + (run.steps || []).map(stepLine).join('') + '</ul></div>';
  }
  function sample(r, s) {
    if (!s.ok) return '';
    var body = '';
    if (r.id === 'job_dupes' && (s.sample || []).length) {
      body = s.sample.map(function (g) {
        var k = g.keep || {}; var copies = (g.remove || []).length;
        return '<li><b>' + E(k.title) + '</b><p>' + E([k.company, k.location].filter(Boolean).join(' · ')) + ' — ' + num(copies + 1 + (g.protectedCopies || []).length) + ' copies. Keeps the one from ' + E(k.source || 'its board') + '; removes '
          + (g.remove || []).slice(0, 3).map(function (x) { return E([x.location || '(no place)', x.source].filter(Boolean).join(', ')); }).join(' · ') + (copies > 3 ? ' · +' + num(copies - 3) + ' more' : '')
          + ((g.protectedCopies || []).length ? '. ' + num(g.protectedCopies.length) + ' kept because someone holds it' : '') + '.</p></li>';
      }).join('');
    } else if (r.id === 'stale' && s.count) {
      body = '<li><p>' + [s.overdue != null ? num(s.overdue) + ' overdue (unseen 15+ days)' : '', s.kept != null ? num(s.kept) + ' kept hidden for people who saved or applied' : '', s.active != null ? num(s.active) + ' live listings stay as they are' : ''].filter(Boolean).map(E).join(' · ') + '</p></li>';
    } else if (r.id === 'report_dupes' && (s.byCompany || []).length) {
      body = s.byCompany.map(function (c) { return '<li><b>' + E(c.company) + '</b><p>' + num(c.copies) + ' extra ' + (c.copies === 1 ? 'copy' : 'copies') + '</p></li>'; }).join('');
    } else if (r.id === 'company_dupes' && (s.autoSample || []).length) {
      body = s.autoSample.map(function (g) { return '<li><b>' + E(g.keep) + '</b><p>would absorb ' + g.merge.map(E).join(' · ') + '</p></li>'; }).join('');
    }
    return body ? '<details class="dh-more"><summary>Examples</summary><ul class="dh-ex">' + body + '</ul></details>' : '';
  }
  function lookalikes(s) {
    if (!s.ok || !(s.lookalikeList || []).length) return '';
    return '<details class="dh-more"' + (s.lookalikeList.length <= 3 ? ' open' : '') + '><summary>' + num(s.lookalikesWaiting) + ' look-alike group' + (s.lookalikesWaiting === 1 ? '' : 's') + ' for you</summary>'
      + '<p class="u-muted sm">These names are close but might be different companies, so nothing merges them on its own. If one is really the same company, merge it in <a href="https://seenjobs.io/admin" target="_blank" rel="noopener">Seen admin ↗</a>.</p>'
      + '<ul class="dh-ex">' + s.lookalikeList.map(function (g) {
        return '<li class="dh-look"><div><b>' + g.companies.map(function (c) { return E(c.name); }).join(' · ') + '</b><p>' + g.companies.map(function (c) { return num(c.reports) + ' report' + (c.reports === 1 ? '' : 's'); }).join(' · ') + '</p></div>'
          + '<button class="u-btn sm" data-dh-review="' + E(g.key) + '">Different companies</button></li>';
      }).join('') + '</ul></details>';
  }
  function render() {
    var root = el(); if (!root) return;
    var busy = run && run.running;
    if (!data) { root.innerHTML = '<section class="u-card dh"><header><h3>Data health</h3></header>' + (loading ? '<p class="u-muted">Checking seenjobs.io for duplicates and stale listings…</p><div class="u-skeleton"><div></div></div>' : '') + runBox() + '</section>'; return; }
    if (data.configured === false) { root.innerHTML = '<section class="u-card dh"><header><h3>Data health</h3></header><div class="u-empty">' + E(data.headline) + ' <a onclick="__go(\'settings\')">Open Settings →</a></div></section>'; return; }
    var S = data.sections || {};
    var rows = ROWS.map(function (r) {
      var s = S[r.id] || { ok: false, line: 'Not checked.' };
      var n = s.ok ? s.count : null;
      var btn = !s.ok ? '' : '<button class="u-btn sm' + (n ? ' primary' : '') + '" data-dh-kind="' + r.kind + '"' + (busy || !n ? ' disabled' : '') + '>' + (n ? E(r.button) : 'Nothing to do') + '</button>';
      return '<li class="u-row dh-row"><div class="dh-n' + (!s.ok ? ' bad' : n ? ' warn' : ' ok') + '">' + (s.ok ? num(n) : '!') + '</div>'
        + '<div class="u-row-main"><b>' + E(r.title) + '</b><p>' + E(s.line) + '</p>' + sample(r, s) + (r.id === 'company_dupes' ? lookalikes(s) : '') + '</div><div class="dh-act">' + btn + '</div></li>';
    }).join('');
    var a = data.auto || {};
    var anything = (data.toClean || 0) > 0;
    root.innerHTML = '<section class="u-card dh"><header><div><h3>Data health</h3><p class="u-muted sm">' + E(data.headline) + ' · checked ' + E(fmt(data.at)) + '</p></div>'
      + '<div class="u-actions"><button class="u-btn sm ghost" id="dh-check"' + (busy ? ' disabled' : '') + '>Check again</button><button class="u-btn sm' + (anything ? ' primary' : '') + '" id="dh-all"' + (busy || !anything ? ' disabled' : '') + '>Clean everything</button></div></header>'
      + '<div id="dh-msg"></div>' + runBox()
      + '<ul class="u-list dh-rows">' + rows + '</ul>'
      + '<div class="dh-foot"><label class="u-toggle"><input type="checkbox" id="dh-auto"' + (a.enabled ? ' checked' : '') + '>Clean automatically every day</label>'
      + '<span class="u-muted sm" id="dh-auto-txt">' + autoText(a) + '</span>'
      + '<details class="dh-more dh-hist" id="dh-hist"><summary>Past cleanups</summary><div id="dh-hist-body" class="u-muted sm">Loading…</div></details></div>'
      + '</section>';
    root.querySelectorAll('[data-dh-kind]').forEach(function (b) { b.onclick = function () { start(b.getAttribute('data-dh-kind')); }; });
    var all = document.getElementById('dh-all'); if (all) all.onclick = function () { start('all'); };
    var chk = document.getElementById('dh-check'); if (chk) chk.onclick = function () { load(true); };
    // Only the words next to the switch change — the panel (and any open list) stays as it is.
    var au = document.getElementById('dh-auto'); if (au) au.onchange = function () { au.disabled = true; req('POST', '/api/data-health/settings', { auto: au.checked }).then(function (r) { data.auto = r.auto; au.disabled = false; var t = document.getElementById('dh-auto-txt'); if (t) t.innerHTML = autoText(r.auto); }).catch(function (e) { au.checked = !au.checked; au.disabled = false; msg(e.message, 'bad'); }); };
    root.querySelectorAll('[data-dh-review]').forEach(function (b) { b.onclick = function () {
      var key = b.getAttribute('data-dh-review'); b.disabled = true;
      req('POST', '/api/data-health/review', { key: key }).then(function () {
        var cd = data.sections && data.sections.company_dupes; // forget it locally too, so a re-draw does not bring it back
        if (cd && cd.lookalikeList) { cd.lookalikeList = cd.lookalikeList.filter(function (g) { return g.key !== key; }); cd.lookalikesWaiting = Math.max(0, (cd.lookalikesWaiting || 1) - 1); }
        var li = b.closest('li'); if (li) { li.classList.add('done'); b.outerHTML = '<span class="u-chip dim">Left as is</span>'; }
      }).catch(function (e) { b.disabled = false; msg(e.message, 'bad'); });
    }; });
    var h = document.getElementById('dh-hist'); if (h) h.addEventListener('toggle', function () { if (h.open) history(); });
  }
  function autoText(a) {
    a = a || {};
    return a.enabled ? (a.lastWhen ? 'last automatic cleanup ' + E(a.lastWhen) + (a.lastOk ? '' : ' (part of it failed)') : 'first automatic cleanup a few minutes after the app starts') + (a.nextWhen ? ' · next ' + E(a.nextWhen) : '') + ' · duplicates and stale listings only — company merges stay your click' : 'off — nothing is cleaned unless you press a button';
  }
  function msg(t, tone) { var m = document.getElementById('dh-msg'); if (m) m.innerHTML = t ? '<div class="u-note ' + (tone || '') + '">' + E(t) + '</div>' : ''; }
  function history() {
    req('GET', '/api/data-health/history?limit=15').then(function (r) {
      var b = document.getElementById('dh-hist-body'); if (!b) return;
      var list = r.history || [];
      b.innerHTML = list.length ? '<ul class="u-list tight">' + list.map(function (x) { return '<li class="u-row"><div class="u-row-main"><b>' + E(x.when) + (x.trigger === 'auto' ? ' · automatic' : '') + '</b><p>' + E(x.summary) + '</p></div><span class="u-chip ' + (x.status === 'completed' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn') + '">' + E(x.status === 'completed' ? 'Done' : x.status === 'failed' ? 'Failed' : 'Partly done') + '</span></li>'; }).join('') + '</ul>' : 'No cleanups yet.';
    }).catch(function (e) { var b = document.getElementById('dh-hist-body'); if (b) b.textContent = e.message; });
  }
  function start(kind) {
    var row = null; ROWS.forEach(function (r) { if (r.kind === kind) row = r; });
    var s = row && data && data.sections ? data.sections[row.id] : null;
    var ask = kind === 'all' ? 'Clean everything on seenjobs.io now? Stale listings are cleared, duplicate listings removed (one copy of each stays), duplicate reports hidden, and Inc / LLC company names merged. Anything people saved or applied to is never removed.' : row && row.ask && s ? row.ask(s) : null;
    if (ask && !window.confirm(ask)) return;
    msg('');
    req('POST', '/api/data-health/clean', { kind: kind }).then(function (r) { run = r.run; render(); watch(); })
      .catch(function (e) { if (e.body && e.body.run) { run = e.body.run; render(); watch(); } msg(e.message, 'bad'); });
  }
  function watch() {
    if (poll) return;
    poll = setInterval(function () {
      if (!el()) { clearInterval(poll); poll = null; return; } // the Jobs tab was rebuilt — the next open picks it up
      req('GET', '/api/data-health/run').then(function (r) {
        run = r.run;
        var box = el() && el().querySelector('.dh-run');
        if (run && run.running) { if (box) box.outerHTML = runBox(); else render(); return; }
        clearInterval(poll); poll = null; render(); load(true); // finished: the result stays, the counts re-check
      }).catch(function () { /* the next tick tries again */ });
    }, 2000);
  }
  function load(refresh) {
    loading = true; if (!data) render();
    else { var c = document.getElementById('dh-check'); if (c) { c.disabled = true; c.textContent = 'Checking…'; } }
    return req('GET', '/api/data-health' + (refresh ? '?refresh=1' : '')).then(function (d) {
      loading = false; data = d; if (d.run) run = d.run; render(); if (run && run.running) watch();
    }).catch(function (e) { loading = false; var root = el(); if (root) root.innerHTML = '<section class="u-card dh"><header><h3>Data health</h3></header><div class="u-empty">The check could not run: ' + E(e.message) + '</div></section>'; });
  }
  window.loadDataHealth = function (id) { elId = id || 'dh-panel'; if (data) render(); load(false); };
})();
