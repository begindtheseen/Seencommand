// Home · Search · Notifications — the three screens the owner lives in (2026-10-21 redesign). Inlined into
// public/command-center.html by scripts/build-dashboard.mjs. Plain browser JS, no framework: every screen
// renders from ONE live endpoint (/api/home, /api/search, /api/notifications) and says plainly when a part
// could not be read. All times are California time.
(function () {
  var PT = 'America/Los_Angeles';
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    var now = new Date(); var s = (now - d) / 1000;
    if (s < -60) { // the future (a schedule's next run)
      var dayN = d.toLocaleDateString('en-CA', { timeZone: PT }), todayN = now.toLocaleDateString('en-CA', { timeZone: PT });
      var tm = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: PT });
      var tt = d.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });
      if (-s < 3600) return 'in ' + Math.round(-s / 60) + ' min';
      return dayN === todayN ? 'today ' + tt : dayN === tm ? 'tomorrow ' + tt : d.toLocaleDateString('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + tt;
    }
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    var sameDay = d.toLocaleDateString('en-CA', { timeZone: PT }) === now.toLocaleDateString('en-CA', { timeZone: PT });
    var t = d.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });
    if (sameDay) return 'today ' + t;
    return d.toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' }) + ', ' + t;
  }
  var getJSON = function (u) { return fetch(u).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); };
  var postJSON = function (u, b) { return fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); };
  var STATUS = { completed: ['ok', 'Done'], complete: ['ok', 'Done'], partial: ['warn', 'Partly done'], failed: ['bad', 'Failed'], blocked: ['bad', 'Blocked'], cancelled: ['dim', 'Cancelled'], interrupted: ['bad', 'Interrupted'],
    running: ['run', 'Running'], queued: ['run', 'Waiting its turn'], starting: ['run', 'Starting'], 'not started': ['bad', 'Not started'] };
  var chip = function (s) { var x = STATUS[s] || ['dim', s || '—']; return '<span class="u-chip ' + x[0] + '">' + E(x[1]) + '</span>'; };
  var go = function (tab) { if (window.showTab) window.showTab(tab); };
  window.__go = go;

  // ---------------------------------------------------------------------------------------- Home
  var homeTimer = null;
  function section(title, right, body, cls) { return '<section class="u-card ' + (cls || '') + '"><header><h3>' + title + '</h3>' + (right || '') + '</header>' + body + '</section>'; }
  function stat(label, value, sub, tone) { return '<div class="u-stat ' + (tone || '') + '"><div class="u-stat-v">' + value + '</div><div class="u-stat-l">' + E(label) + '</div>' + (sub ? '<div class="u-stat-s">' + sub + '</div>' : '') + '</div>'; }
  function renderHome(h) {
    var root = document.getElementById('home-view'); if (!root) return;
    var hour = Number(new Date().toLocaleString('en-US', { timeZone: PT, hour: 'numeric', hour12: false }));
    var hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    var s = h.seen || {};
    var stats = s.error
      ? '<div class="u-empty">Seen’s numbers could not be read — ' + E(s.error) + '. <a onclick="__go(\'settings\')">Check the connection →</a></div>'
      : '<div class="u-stats">'
        + '<a class="u-stat-link" onclick="window.openJobs&&openJobs({since:\'today\'})">' + stat('Jobs added today', num(s.jobs && s.jobs.addedToday), 'since midnight PT · open the list →', 'accent') + '</a>'
        + stat('Live job listings', num(s.jobs && s.jobs.active), s.jobs && s.jobs.stale ? num(s.jobs.stale) + ' stale waiting to clear' : '')
        + stat('Applicant reports', num(s.reports && s.reports.today), 'today · ' + num(s.reports && s.reports.week) + ' this week')
        + stat('Graded companies', num(s.companies && s.companies.graded), '')
        + (s.revenue && s.revenue.month != null ? stat('Revenue · 30 days', '$' + Number(s.revenue.month).toLocaleString('en-US', { maximumFractionDigits: 2 }), num(s.revenue.paying) + ' paying · ' + num(s.revenue.prep) + ' Prep · ' + num(s.revenue.pass) + ' Pass') : '')
        + (s.storage ? stat('Database', num(s.storage.mb) + ' MB', s.storage.blocking ? 'new listings paused' : 'pauses at ' + s.storage.maxMb + ' MB', s.storage.blocking ? 'bad' : s.storage.mb >= s.storage.maxMb - 30 ? 'warn' : '') : '')
        + '</div>' + (s.degraded ? '<div class="u-note warn">Some of Seen’s counts failed to load this time — a number may be low.</div>' : '');
    var needs = (h.needsYou || []);
    var needsBody = needs.length ? '<ul class="u-list">' + needs.map(function (n) {
      var act = n.kind === 'approval' ? '<div class="u-actions"><button class="u-btn ghost sm" data-sim="' + E(n.id) + '" title="Deep-simulate this decision first (a few minutes); the result lands in the Board Room">Simulate</button><button class="u-btn primary sm" data-appr="' + E(n.id) + '" data-d="approve">Approve</button><button class="u-btn sm" data-appr="' + E(n.id) + '" data-d="deny">Deny</button></div>'
        : n.kind === 'run' || n.kind === 'cloud-run' ? '<div class="u-actions"><button class="u-btn sm" onclick="__go(\'search\')">Open</button></div>'
        : n.kind === 'data-health' ? '<div class="u-actions"><button class="u-btn sm" onclick="__go(\'jobs\')">Open</button></div>'
        : n.kind === 'stale-approvals' ? '<div class="u-actions"><button class="u-btn primary sm" data-meeting="1">Run a fresh meeting</button><button class="u-btn sm" onclick="__go(\'cc\')">Review</button></div>' : '';
      return '<li class="u-row"><span class="u-dot ' + E(n.level) + '"></span><div class="u-row-main"><b>' + E(n.title) + '</b>' + (n.body ? '<p>' + E(n.body) + '</p>' : '') + '</div>' + act + '</li>';
    }).join('') + '</ul>' : '<div class="u-empty ok">Nothing needs you right now.</div>';
    var r = h.runs || {};
    var runsBody = r.error ? '<div class="u-empty">' + E(r.error) + '</div>'
      : ((r.active || []).length ? '<ul class="u-list">' + r.active.map(function (x) { return '<li class="u-row"><span class="u-spin"></span><div class="u-row-main"><b>' + E(x.label) + '</b><p>' + (x.status === 'queued' ? 'Waiting for the browser' : 'Running since ' + when(x.startedAt)) + (x.trigger && x.trigger !== 'manual' ? ' · ' + E(x.trigger) : '') + '</p></div></li>'; }).join('') + '</ul>' : '<div class="u-empty">Nothing running.</div>')
        + ((r.recent || []).length ? '<div class="u-sub">Last finished</div><ul class="u-list tight">' + r.recent.slice(0, 5).map(function (x) { return '<li class="u-row"><div class="u-row-main"><b>' + E(x.label) + '</b><p>' + when(x.endedAt) + (x.reason ? ' · ' + E(x.reason).slice(0, 140) : '') + '</p></div>' + chip(x.status) + '</li>'; }).join('') + '</ul>' : '')
        + ((r.schedules || []).length ? '<div class="u-sub">Scheduled</div><ul class="u-list tight">' + r.schedules.map(function (x) { return '<li class="u-row"><div class="u-row-main"><b>' + E(x.label) + '</b><p>' + E(x.frequency) + ' at ' + E(x.time) + ' · next ' + when(x.next) + '</p></div></li>'; }).join('') + '</ul>' : '');
    var c = h.cloud || {};
    var cloudBody = c.error ? '<div class="u-empty">' + E(c.error) + '</div>' : !c.ready ? '<div class="u-empty">' + E(c.error || 'The always-on cloud collector starts after Seen deploys it.') + '</div>'
      : (c.runs || []).length ? '<ul class="u-list tight">' + c.runs.slice(0, 6).map(function (x) { return '<li class="u-row"><div class="u-row-main"><b>' + E((x.companies || []).join(', ') || 'Applicant reports') + '</b><p>' + when(x.finished_at || x.started_at) + ' · ' + num(x.new_reports) + ' new reports</p></div>' + chip(x.status) + '</li>'; }).join('') + '</ul>' : '<div class="u-empty">No cloud runs yet.</div>';
    var ch = h.changes || {};
    var KIND = { commit: 'Code', deploy: 'Deploy', aggregation: 'Run', build: 'Build', approval: 'Decision', 'board-meeting': 'Meeting', meeting: 'Meeting', 'self-update': 'Update', 'pr-verdict': 'PR', 'task-delete': 'Task', 'data-health': 'Cleanup' };
    var changesBody = (ch.items || []).length ? '<ul class="u-feed">' + ch.items.map(function (x) {
      return '<li><span class="u-tag">' + E(KIND[x.kind] || x.kind) + '</span><div><b>' + (x.url ? '<a href="' + E(x.url) + '" target="_blank" rel="noopener">' + E(x.title) + '</a>' : E(x.title)) + '</b><p>' + when(x.at) + (x.repo ? ' · ' + E(String(x.repo).split('/').pop()) : '') + '</p></div></li>';
    }).join('') + '</ul>' : '<div class="u-empty">' + (ch.error ? E(ch.error) : 'No changes in the last 3 days.') + '</div>';
    var b = h.board || {};
    // The meeting's proposals live in "Needs you" (or one line there when the meeting is old) — never twice.
    var boardBody = !b.ran ? '<div class="u-empty">No board meeting has run on this Mac yet. Run one to get the team\u2019s read on Seen and its proposals.</div>'
      : (b.stale ? '<div class="u-note warn">This is from the ' + E(b.day || '') + ' meeting, ' + E(String(Math.round(b.ageHours / 24))) + ' days ago. The numbers and proposals below are from then — run a fresh meeting for today\u2019s.</div>' : '')
        + '<p class="u-lead' + (b.stale ? ' u-dim' : '') + '">' + E(b.headline || '') + '</p>' + (b.topConstraint ? '<p class="u-muted">Biggest constraint: ' + E(b.topConstraint) + '</p>' : '')
        + (b.pending ? '<p class="u-muted sm">' + b.pending + ' proposal' + (b.pending === 1 ? '' : 's') + ' still open' + (b.stale ? '' : ' — decide them under Needs you') + '.</p>' : '<div class="u-empty ok">Every proposal has been decided.</div>');
    root.innerHTML = '<div class="u-head"><div><h1>' + hello + ', Brandon</h1><p class="u-muted">' + E(new Date().toLocaleDateString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric' })) + ' · updated ' + when(h.at) + '</p></div>'
      + '<div class="u-head-actions"><button class="u-btn ghost" data-claude="seen" title="Open Claude Code in Terminal, in the Seen (seenjobs.io) folder">Claude · Seen</button><button class="u-btn ghost" data-claude="command" title="Open Claude Code in Terminal, in the Seen Command folder">Claude · Seen Command</button><button class="u-btn" id="home-refresh">Refresh</button><button class="u-btn primary" onclick="__go(\'search\')">New search</button></div></div>'
      + stats
      + '<div class="u-grid">'
      + '<div class="u-col">' + section('Needs you', needs.length ? '<span class="u-count">' + needs.length + '</span>' : '', needsBody)
      + section('Added to Seen today', '<a class="u-link" onclick="window.openJobs&&openJobs({since:\'today\'})">All of today’s →</a>', '<div id="home-recent-jobs"><div class="u-skeleton"><div></div></div></div>')
      + section('Recent changes', '', changesBody) + '</div>'
      + '<div class="u-col">' + section('Searches &amp; collectors', '<a class="u-link" onclick="__go(\'search\')">Open →</a>', runsBody) + section('Always-on (cloud)', '', cloudBody)
      + section('Board meeting', b.ran ? '<span class="u-muted sm">' + (b.stale ? '<span class="u-chip warn">' + E(String(Math.round(b.ageHours / 24))) + ' days old</span>' : when(b.at)) + '</span>' : '', boardBody + '<div class="u-actions end"><button class="u-btn' + (b.stale || !b.ran ? ' primary' : '') + '" data-meeting="1">' + (b.stale ? 'Run a fresh meeting' : 'Run a board meeting') + '</button><button class="u-btn ghost" onclick="__go(\'cc\')">Full report</button></div>') + '</div>'
      + '</div>';
    window.__homeReady = true; // the launch splash waits for this (app/main.js) — real content, not empty cards
    if (window.fillRecentJobs) window.fillRecentJobs('home-recent-jobs');
    root.querySelectorAll('[data-claude]').forEach(function (b) { b.onclick = function () { var t = b.textContent; b.disabled = true; postJSON('/api/terminal/claude', { repo: b.getAttribute('data-claude') }).then(function () { b.textContent = 'Opened in Terminal'; }).catch(function (e) { b.textContent = e.message.slice(0, 60); }).finally(function () { setTimeout(function () { b.textContent = t; b.disabled = false; }, 3000); }); }; });
    var rf = document.getElementById('home-refresh'); if (rf) rf.onclick = function () { rf.disabled = true; window.loadHome(true); };
    root.querySelectorAll('[data-meeting]').forEach(function (mt) { mt.onclick = function () {
      root.querySelectorAll('[data-meeting]').forEach(function (x) { x.disabled = true; x.textContent = 'Meeting in progress… (a few minutes)'; });
      postJSON('/api/board-meeting').then(function () { if (window.__softReload) window.__softReload(); else window.loadHome(true); }).catch(function (e) { mt.disabled = false; mt.textContent = 'Meeting failed: ' + e.message; });
    }; });
    root.querySelectorAll('[data-sim]').forEach(function (b) { b.onclick = function () { b.disabled = true; b.textContent = 'Simulating…'; postJSON('/api/simulate', { approvalId: b.getAttribute('data-sim') }).then(function (r) { b.textContent = r.existing && r.status === 'done' ? 'Simulated — see Board Room' : 'Running — result in Board Room'; }).catch(function (e) { b.textContent = e.message.slice(0, 40); b.disabled = false; }); }; });
    root.querySelectorAll('[data-appr]').forEach(function (btn) { btn.onclick = function () {
      var row = btn.closest('.u-row'); row.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
      postJSON('/api/approve', { id: btn.getAttribute('data-appr'), decision: btn.getAttribute('data-d') }).then(function () { row.classList.add('done'); row.querySelector('.u-actions').innerHTML = '<span class="u-chip ' + (btn.getAttribute('data-d') === 'approve' ? 'ok">Approved' : 'dim">Denied') + '</span>'; })
        .catch(function (e) { row.querySelector('.u-actions').innerHTML = '<span class="u-chip bad">' + E(e.message) + '</span>'; });
    }; });
  }
  window.loadHome = function (refresh) {
    var root = document.getElementById('home-view'); if (!root) return;
    if (!root.children.length) root.innerHTML = '<div class="u-skeleton"><div></div><div></div><div></div></div>';
    getJSON('/api/home' + (refresh ? '?refresh=1' : '')).then(renderHome).catch(function (e) { window.__homeReady = true; root.innerHTML = '<div class="u-empty">Home could not load: ' + E(e.message) + '</div>'; });
    clearInterval(homeTimer); homeTimer = setInterval(function () { var t = document.getElementById('tab-home'); if (t && !t.classList.contains('hidden') && !document.hidden) getJSON('/api/home').then(renderHome).catch(function () {}); }, 60000);
  };

  // -------------------------------------------------------------------------------------- Search
  var METHOD_ORDER = ['career_site', 'seen_pull', 'indeed', 'applicant_reports', 'company_intel', 'seen_sources'];
  var searchTimer = null, planTimer = null, chosen = null;
  function searchForm() {
    return '<div class="u-search">'
      + '<div class="u-search-main"><input id="s-text" autocomplete="off" placeholder="Search a company, a field or a job — e.g. “Acme”, “acme technician”, “welder”"><button class="u-btn primary lg" id="s-go">Search</button></div>'
      + '<div class="u-search-more"><input id="s-kw" autocomplete="off" placeholder="Keywords or roles (optional) — technician, service advisor"><input id="s-url" autocomplete="off" placeholder="Careers page (optional) — https://…"></div>'
      + '<div id="s-plan" class="u-plan"></div><div id="s-out" class="u-out"></div></div>';
  }
  function renderPlan(p) {
    var el = document.getElementById('s-plan'); if (!el) return;
    if (!p) { el.innerHTML = ''; return; }
    var what = p.kind === 'company' ? 'Company search · <b>' + E(p.company) + '</b>' + (p.keywords ? ' · keywords <b>' + E(p.keywords) + '</b>' : '') : 'Field search · <b>' + E(p.field) + '</b> across every company';
    if (!chosen) chosen = p.methods.slice();
    el.innerHTML = '<div class="u-plan-what">' + what + '</div><div class="u-plan-methods">' + p.methods.map(function (m, i) {
      return '<label class="u-toggle"><input type="checkbox" data-m="' + E(m) + '"' + (chosen.indexOf(m) >= 0 ? ' checked' : '') + '><span>' + E(p.labels[i]) + '</span></label>';
    }).join('') + '</div><div class="u-muted sm">Chrome collectors take turns on the browser; the rest run at the same time.</div>';
    el.querySelectorAll('input[data-m]').forEach(function (x) { x.onchange = function () { var m = x.getAttribute('data-m'); chosen = chosen.filter(function (y) { return y !== m; }); if (x.checked) chosen.push(m); }; });
  }
  function previewPlan() {
    var t = (document.getElementById('s-text') || {}).value || '', k = (document.getElementById('s-kw') || {}).value || '', u = (document.getElementById('s-url') || {}).value || '';
    chosen = null;
    if (!t.trim() && !u.trim()) { renderPlan(null); return; }
    getJSON('/api/search/plan?text=' + encodeURIComponent(t) + '&keywords=' + encodeURIComponent(k) + '&url=' + encodeURIComponent(u)).then(renderPlan).catch(function () {});
  }
  function stepNumbers(st) {
    var r = st.result || {};
    var bits = [];
    if (r.saved != null) bits.push(num(r.saved) + ' saved'); else if (r.written != null) bits.push(num(r.written) + ' written');
    if (r.listed != null) bits.push(num(r.listed) + ' listed' + (r.siteTotal ? ' of ' + num(r.siteTotal) : ''));
    if (r.newReports != null) bits.push(num(r.newReports) + ' new reports'); if (r.importedReports != null) bits.push(num(r.importedReports) + ' reports');
    if (r.matched != null) bits.push(num(r.matched) + ' matches');
    if (st.attempt > 1) bits.push('run ' + st.attempt + ' of 2');
    return bits.join(' · ');
  }
  function renderSearches(list) {
    var el = document.getElementById('s-history'); if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="u-empty">No searches yet. Type one above — a company, a field, or a company and its roles.</div>'; return; }
    el.innerHTML = list.map(function (s) {
      return '<article class="u-card u-search-card"><header><div><h3>' + E(s.label || s.input && s.input.text) + '</h3><p class="u-muted sm">' + (s.kind === 'company' ? 'Company search' : s.kind === 'preset' ? 'Preset' : 'Field search') + ' · from ' + E(s.origin || 'search box') + ' · ' + when(s.at) + '</p></div>' + chip(s.status) + '</header>'
        + '<ul class="u-steps">' + (s.steps || []).sort(function (a, b) { return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method); }).map(function (st) {
          var why = st.error || (st.status !== 'completed' && st.reason) || '';
          return '<li><span class="u-step-l">' + E(st.label) + '</span>' + chip(st.status) + '<span class="u-step-n">' + E(stepNumbers(st)) + '</span>' + (why ? '<div class="u-step-why">' + E(String(why).slice(0, 220)) + '</div>' : '') + '</li>';
        }).join('') + '</ul></article>';
    }).join('');
  }
  function loadSearches() {
    return getJSON('/api/search?limit=30').then(function (j) {
      var list = j.searches || [];
      renderSearches(list);
      clearTimeout(searchTimer);
      if (list.some(function (s) { return s.status === 'running'; })) searchTimer = setTimeout(loadSearches, 5000);
    }).catch(function (e) { var el = document.getElementById('s-history'); if (el) el.innerHTML = '<div class="u-empty">History could not load: ' + E(e.message) + '</div>'; });
  }
  window.loadSearch = function () {
    var root = document.getElementById('search-view'); if (!root) return;
    if (!document.getElementById('s-text')) {
      root.innerHTML = '<div class="u-head"><div><h1>Search</h1><p class="u-muted">One box for every way Seen collects: career sites, job boards, Indeed, applicant reports and company intelligence.</p></div></div>'
        + searchForm() + '<h2 class="u-h2">Presets</h2><div id="s-presets" class="u-presets"><div class="u-empty">Loading presets…</div></div>'
        + '<h2 class="u-h2">History</h2><div id="s-history"></div>';
      loadPresets();
      ['s-text', 's-kw', 's-url'].forEach(function (id) { var x = document.getElementById(id); x.addEventListener('input', function () { clearTimeout(planTimer); planTimer = setTimeout(previewPlan, 300); }); x.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); }); });
      document.getElementById('s-go').onclick = start;
    }
    loadSearches();
  };
  // Presets: every set the Indeed tab offered + the everyday quick starts, one tap each (they become a
  // tracked search like a typed one).
  function loadPresets() {
    var el = document.getElementById('s-presets'); if (!el) return;
    getJSON('/api/search/presets').then(function (d) {
      var groups = {}, order = [];
      (d.presets || []).forEach(function (p) { if (!groups[p.group]) { groups[p.group] = []; order.push(p.group); } groups[p.group].push(p); });
      el.innerHTML = (d.presetsError ? '<div class="u-note warn">Seen’s Indeed presets could not load: ' + E(d.presetsError) + '</div>' : '')
        + order.map(function (g) { return '<div class="u-pgroup"><div class="u-sub">' + E(g) + '</div><div class="u-pchips">' + groups[g].map(function (p) {
          return '<button class="u-pchip" data-preset="' + E(p.key) + '" data-title="' + E(p.title) + '" data-sub="' + E(p.sub) + '"><b>' + E(p.title) + '</b><span>' + E(p.sub) + '</span></button>'; }).join('') + '</div></div>'; }).join('');
      el.querySelectorAll('[data-preset]').forEach(function (b) { b.onclick = function () {
        if (!window.confirm('Run “' + b.getAttribute('data-title') + '” — ' + b.getAttribute('data-sub') + '? Results go straight to seenjobs.io.')) return;
        b.disabled = true; postJSON('/api/search', { preset: b.getAttribute('data-preset') }).then(function () { b.disabled = false; loadSearches(); })
          .catch(function (e) { b.disabled = false; var out = document.getElementById('s-out'); if (out) out.innerHTML = '<span class="u-chip bad">' + E(e.message) + '</span>'; });
      }; });
    }).catch(function (e) { el.innerHTML = '<div class="u-empty">Presets could not load: ' + E(e.message) + '</div>'; });
  }
  function start() {
    var t = document.getElementById('s-text').value.trim(), k = document.getElementById('s-kw').value.trim(), u = document.getElementById('s-url').value.trim();
    var out = document.getElementById('s-out'), btn = document.getElementById('s-go');
    if (!t && !u) { out.innerHTML = '<span class="u-chip bad">Type a company, a field or a job first</span>'; return; }
    btn.disabled = true; out.innerHTML = '<span class="u-chip run">Starting…</span>';
    postJSON('/api/search', { text: t, keywords: k, url: u, methods: chosen }).then(function (j) {
      out.innerHTML = '<span class="u-chip ok">Started — you’ll get a notification when it’s done</span>';
      document.getElementById('s-text').value = ''; document.getElementById('s-kw').value = ''; document.getElementById('s-url').value = ''; renderPlan(null); chosen = null;
      loadSearches();
    }).catch(function (e) { out.innerHTML = '<span class="u-chip bad">' + E(e.message) + '</span>'; }).finally(function () { btn.disabled = false; });
  }

  // ------------------------------------------------------------------------------- Notifications
  function setBadge(n) { var b = document.getElementById('nav-notes-badge'); if (!b) return; b.textContent = n > 99 ? '99+' : String(n || ''); b.hidden = !n; }
  window.loadNotifications = function () {
    var root = document.getElementById('notes-view'); if (!root) return;
    getJSON('/api/notifications?limit=200').then(function (d) {
      setBadge(d.unread);
      var items = d.items || [];
      root.innerHTML = '<div class="u-head"><div><h1>Notifications</h1><p class="u-muted">Searches, runs, meetings and builds — newest first. They also appear as macOS notifications.</p></div><div class="u-head-actions"><button class="u-btn" id="n-read">Mark all read</button><button class="u-btn ghost" id="n-clear">Clear</button></div></div>'
        + (items.length ? '<ul class="u-list u-notes">' + items.map(function (n) {
          return '<li class="u-row' + (n.read ? '' : ' unread') + '" data-tab="' + E(n.tab || '') + '" data-id="' + n.id + '"><span class="u-dot ' + E(n.level) + '"></span><div class="u-row-main"><b>' + E(n.title) + '</b>' + (n.body ? '<p>' + E(n.body) + '</p>' : '') + '</div><span class="u-muted sm nowrap">' + when(n.at) + '</span></li>';
        }).join('') + '</ul>' : '<div class="u-empty">You’re all caught up.</div>');
      document.getElementById('n-read').onclick = function () { postJSON('/api/notifications/read', { ids: 'all' }).then(window.loadNotifications); };
      document.getElementById('n-clear').onclick = function () { postJSON('/api/notifications/clear').then(window.loadNotifications); };
      root.querySelectorAll('.u-notes .u-row').forEach(function (row) { row.onclick = function () { postJSON('/api/notifications/read', { ids: [Number(row.getAttribute('data-id'))] }); var t = row.getAttribute('data-tab'); if (t && t !== 'notifications') go(t); else { row.classList.remove('unread'); } }; });
      if (d.unread) setTimeout(function () { postJSON('/api/notifications/read', { ids: 'all' }).then(function (x) { setBadge(x.unread); }); }, 4000);
    }).catch(function (e) { root.innerHTML = '<div class="u-empty">Notifications could not load: ' + E(e.message) + '</div>'; });
  };
  function pollBadge() { if (location.protocol.indexOf('http') !== 0) return; getJSON('/api/notifications?limit=1').then(function (d) { setBadge(d.unread); }).catch(function () {}); }
  setInterval(pollBadge, 20000); setTimeout(pollBadge, 1500);
})();
