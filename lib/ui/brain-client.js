// Brain — Chronos, folded into Seen Command (2026-10-21). The Brain tab (#tab-vault) gets six views:
// Overview (the existing Knowledge Vault: ask, this week, decisions, facts) · Graph · Activity ·
// Overnight · Health · Access. Everything Chronos.app showed lives here now, read from the local
// server's /api/brain/* routes (lib/brain-routes.mjs). Inlined into public/command-center.html after
// jobs-client.js. Plain browser JS.
//
// FAST: nothing loads until the Brain tab opens, each view loads when it is first shown, and while the
// tab is open the page asks only GET /api/brain/status (a few counters) every 5 s; a view re-reads its
// data only when a counter it depends on moved. The graph is fetched with If-None-Match, so an
// unchanged graph is a 304. Leaving the tab (or hiding the window) stops every timer.
//
// The graph canvas is lib/ui/brain-graph.js, inlined just before this file: BrainGraph.mount(el, data,
// { onSelect }) returns the instance whose .update(data) redraws. Picking a node offers "Ask the Board
// Room about this", which prefills the Board Room composer (it never sends on its own).
//
// Every date and time shown is California time (America/Los_Angeles).
(function () {
  var PT = 'America/Los_Angeles';
  var LIVE_PAGE = location.protocol.indexOf('http') === 0;
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  // Brain stamps are UTC: full ISO strings, or minute-precision slices ("2026-07-09T04:00") that carry no
  // zone — read those as UTC too, never as this machine's local time.
  var norm = function (s) { s = String(s || ''); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s + 'Z' : s; };
  var hasClock = function (s) { return String(s || '').length > 10 && !isNaN(new Date(norm(s))); };
  var ptDay = function (s) { s = String(s || ''); if (!s) return 'unknown'; if (!hasClock(s)) return s.slice(0, 10); return new Date(norm(s)).toLocaleDateString('en-CA', { timeZone: PT }); };
  var todayPT = function () { return new Date().toLocaleDateString('en-CA', { timeZone: PT }); };
  var clock = function (s) { return hasClock(s) ? new Date(norm(s)).toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' }) + ' PT' : ''; };
  var when = function (s) {
    if (!s) return '';
    if (!hasClock(s)) { var d = new Date(String(s).slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }); }
    return new Date(norm(s)).toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
  };
  var dayLabel = function (d) {
    if (d === 'unknown') return 'undated';
    var x = new Date(d + 'T12:00:00Z'); var pretty = isNaN(x) ? d : x.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
    return d === todayPT() ? 'Today · ' + pretty : pretty;
  };
  function ago(iso) {
    if (!iso) return ''; var s = (Date.now() - new Date(iso)) / 1000; if (isNaN(s)) return '';
    if (s < 45) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return when(iso);
  }
  function shortPath(p) { var parts = String(p || '').split('/').filter(Boolean); if (!parts.length) return '—'; return (parts.length > 2 ? '…/' : '/') + parts.slice(-2).join('/'); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function req(method, url, body, headers) {
    var h = headers || {}; if (body) h['content-type'] = 'application/json';
    return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 304) return { notModified: true, status: 304 };
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok && r.status !== 410) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; } if (r.status === 410) j.gone = true; return j; });
      });
  }

  var VIEWS = [['overview', 'Overview'], ['graph', 'Graph'], ['activity', 'Activity'], ['overnight', 'Overnight'], ['health', 'Health'], ['access', 'Access']];
  var HINT = { graph: '⌘1', activity: '⌘2', overnight: '⌘3', health: '⌘4', access: '⌘5' };
  var KEYS = { '1': 'graph', '2': 'activity', '3': 'overnight', '4': 'health', '5': 'access' };
  var S = {
    on: false, view: 'overview', built: false, poll: null, actPoll: null, seen: null, status: null,
    graph: null, viewG: null, bg: null, etag: null, mounted: false, gLoading: false, selected: null, origins: {}, play: null,
    act: { data: null, section: 'recent', loading: false, all: false }, ov: { data: null, open: {}, loading: false },
    hl: { data: null, loading: false }, ac: { clients: [], loading: false }, stale: {},
  };

  // ---- the shell: header + view tabs + panes; the existing vault content becomes Overview -----------
  function build() {
    if (S.built) return true;
    var tab = document.getElementById('tab-vault'); if (!tab) return false;
    var overview = document.createElement('div'); overview.id = 'brain-v-overview'; overview.className = 'brain-pane';
    while (tab.firstChild) overview.appendChild(tab.firstChild);
    tab.innerHTML = '<div class="u-head brain-head"><div><h1>Brain</h1><p class="u-muted sm" id="brain-sub">The company’s shared memory — ask it, see the whole graph, every change and who made it, what ran overnight, how healthy it is, and who may use it.</p></div>'
      + '<div class="u-head-actions"><span class="u-chip dim" id="brain-live" title="">…</span><button class="u-btn sm" id="brain-refresh" title="Pull the cloud brain now and re-read every view">Refresh</button></div></div>'
      + '<div class="brain-tabs" role="tablist">' + VIEWS.map(function (v) { return '<button class="brain-tab" role="tab" data-bview="' + v[0] + '"' + (HINT[v[0]] ? ' title="' + v[1] + ' (' + HINT[v[0]] + ')"' : '') + '>' + v[1] + '</button>'; }).join('') + '</div>'
      + '<div class="u-note warn brain-banner" id="brain-banner" hidden></div>'
      + '<div id="brain-panes"></div>';
    var panes = document.getElementById('brain-panes');
    panes.appendChild(overview);
    var add = function (id, html) { var d = document.createElement('div'); d.id = 'brain-v-' + id; d.className = 'brain-pane'; d.hidden = true; d.innerHTML = html; panes.appendChild(d); };
    add('graph', '<div class="brain-gtools">'
      + '<div class="brain-origins" id="brain-origins" role="group" aria-label="Which brains to show">' + ORIGINS.map(function (o) { return '<button type="button" class="on" data-origin="' + o[0] + '"><i class="brain-org ' + o[0] + '"></i>' + o[1] + '</button>'; }).join('') + '</div>'
      + '<div class="brain-time" title="Travel through time: the brain as it stood at the end of a past day (California time)"><button type="button" class="u-btn ghost sm" id="brain-asof-play" aria-label="Play the brain forward through time">▶</button>'
      + '<input type="range" id="brain-asof" min="0" max="1" value="1" aria-label="As of date"><span class="brain-asof-l" id="brain-asof-l">Now</span><button type="button" class="u-btn ghost sm" id="brain-asof-now" hidden>Back to now</button></div>'
      + '<div class="brain-selbar" id="brain-selbar" hidden></div></div>'
      + '<div class="u-note warn brain-banner" id="brain-gbanner" hidden></div>'
      + '<div class="brain-stage" id="brain-stage"></div><div class="brain-strip" id="brain-strip"></div>');
    add('activity', '<div class="brain-segs" id="brain-act-tabs"><button data-sec="recent">Latest changes<span class="n" id="brain-n-recent"></span></button><button data-sec="all">All changes<span class="n" id="brain-n-all"></span></button><button data-sec="requests">AI traffic<span class="n" id="brain-n-req"></span></button></div>'
      + '<p class="u-muted sm" id="brain-act-sub">reading the vault…</p><div id="brain-act-sessions"></div><div id="brain-act-body"></div>');
    add('overnight', '<p class="u-muted sm" id="brain-ov-sub">reading the vault…</p><div id="brain-ov-body"></div>');
    add('health', '<p class="u-muted sm">The Keeper reads the whole brain at once and reports what does not hold up — facts that contradict each other, and open facts nothing has refreshed.</p><div id="brain-hl-body"></div><div id="brain-sources"></div>');
    add('access', '<p class="u-muted sm">Credentials — not claimed names — control identity. A secret is shown once or installed on this Mac; the vault keeps only a salted verifier. One credential per source; give only that source its secret.</p>'
      + '<div class="u-card brain-issue"><div class="brain-issue-row">'
      + '<input id="brain-ac-name" placeholder="client name, e.g. codex" autocomplete="off">'
      + ['read', 'write', 'artifact:read', 'artifact:write', 'github:write', 'admin'].map(function (s) { var label = { 'artifact:read': 'receive files', 'artifact:write': 'send files', 'github:write': 'GitHub PRs' }[s] || s; return '<label class="u-toggle"><input type="checkbox" data-scope="' + s + '"' + (s === 'read' ? ' checked' : '') + '>' + label + '</label>'; }).join('')
      + '<select id="brain-ac-ttl" aria-label="Credential lifetime"><option value="24">expires in 24 hours</option><option value="168">expires in 7 days</option><option value="720" selected>expires in 30 days</option><option value="">no expiry</option></select>'
      + '<label class="u-toggle"><input type="checkbox" id="brain-ac-install" checked>install on this Mac</label>'
      + '<button class="u-btn primary sm" id="brain-ac-issue">Issue credential</button></div><div id="brain-ac-secret" hidden></div></div>'
      + '<div id="brain-ac-body"></div>');
    Array.prototype.forEach.call(tab.querySelectorAll('.brain-tab'), function (b) { b.onclick = function () { setView(b.getAttribute('data-bview')); }; });
    Array.prototype.forEach.call(tab.querySelectorAll('#brain-act-tabs button'), function (b) { b.onclick = function () { actSection(b.getAttribute('data-sec')); }; });
    document.getElementById('brain-refresh').onclick = refreshAll;
    document.getElementById('brain-ac-issue').onclick = issue;
    S.built = true;
    return true;
  }

  function setView(name) {
    if (!VIEWS.some(function (v) { return v[0] === name; })) name = 'overview';
    if (S.view === 'access' && name !== 'access') clearSecret(); // a secret is shown once — not left behind
    S.view = name; store('sc-brain-view', name);
    Array.prototype.forEach.call(document.querySelectorAll('.brain-tab'), function (b) { var on = b.getAttribute('data-bview') === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    VIEWS.forEach(function (v) { var el = document.getElementById('brain-v-' + v[0]); if (el) el.hidden = v[0] !== name; });
    if (!LIVE_PAGE) { if (name !== 'overview') paneMsg(name, 'Open Seen Command (the app) for the live brain.'); return; }
    if (name === 'graph') { if (!S.graph || S.stale.graph) loadGraph(); else renderGraph(); }
    if (name === 'activity' && (!S.act.data || S.stale.activity)) loadActivity();
    if (name === 'overnight' && (!S.ov.data || S.stale.overnight)) loadOvernight();
    if (name === 'health' && (!S.hl.data || S.stale.health)) loadHealth();
    if (name === 'access') loadAccess();
    if (name === 'activity') startActPoll(); else stopActPoll();
  }
  function paneMsg(name, text) { var el = document.getElementById('brain-v-' + name); if (el) el.innerHTML = '<div class="u-empty">' + E(text) + '</div>'; }

  // ---- live status: one tiny poll while the tab is open ---------------------------------------------
  function startPoll() { if (S.poll || !LIVE_PAGE) return; pollOnce(); S.poll = setInterval(function () { if (!document.hidden) pollOnce(); }, 5000); }
  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } stopActPoll(); }
  function pollOnce() {
    req('GET', '/api/brain/status').then(function (s) {
      var prev = S.seen; S.status = s; S.seen = s.versions; renderLive(s);
      if (!prev) return;
      var v = s.versions;
      var graphMoved = v.vault !== prev.vault || v.state !== prev.state || v.live !== prev.live;
      var vaultMoved = v.vault !== prev.vault;
      if (graphMoved) { S.stale.graph = true; if (S.view === 'graph') loadGraph(); }
      if (vaultMoved) { S.stale.overnight = S.stale.health = true; if (S.view === 'overnight') loadOvernight(); if (S.view === 'health') loadHealth(); }
      if (vaultMoved || v.access !== prev.access) { S.stale.activity = true; if (S.view === 'activity') loadActivity(); if (S.view === 'access' && v.access !== prev.access) loadAccess(); }
    }).catch(function () { var el = document.getElementById('brain-live'); if (el) { el.className = 'u-chip bad'; el.textContent = 'server unreachable'; } });
  }
  function renderLive(s) {
    var el = document.getElementById('brain-live'); if (!el) return;
    var src = s.sources || {}, c = s.cloud || {}, ls = c.lastSync || {};
    var cloud = c.configured === false ? 'cloud copy not set up' : ls.at ? (ls.error ? 'cloud sync failed ' + ago(ls.at) : 'cloud synced ' + ago(ls.at)) : 'cloud sync starting';
    el.className = 'u-chip ' + (!src.vaultFound ? 'bad' : ls.error ? 'warn' : 'ok');
    el.textContent = (src.vaultFound ? 'live' : 'no vault') + ' · ' + cloud;
    el.title = 'vault: ' + (src.vaultPath || 'not found') + (s.watching && s.watching.vault ? ' (watched)' : '') + '\n' + (src.version || '');
    var b = document.getElementById('brain-banner');
    if (b) {
      if (!src.vaultFound) { b.hidden = false; b.innerHTML = 'No brain vault found on this Mac, so the Graph shows Seen Command’s board-meeting graph only. <a class="u-link" id="brain-pick">Pick the vault folder</a> (the seen repo’s <code>memory/</code>).'; var a = document.getElementById('brain-pick'); if (a) a.onclick = function () { setView('health'); setTimeout(function () { var i = document.getElementById('brain-src-path'); if (i) i.focus(); }, 0); }; }
      else if (s.legacy) { b.hidden = false; b.textContent = 'Using the vault folder you picked in Chronos: ' + s.legacy.vaultPath + ' (saved to Seen Command’s settings).'; }
      else b.hidden = true;
    }
  }
  function refreshAll() {
    var btn = document.getElementById('brain-refresh'); if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    req('POST', '/api/brain/refresh', {}).then(function (s) { S.status = s; S.seen = s.versions; renderLive(s); })
      .catch(function () { /* the reloads below still run */ })
      .then(function () {
        S.stale = { graph: true, activity: true, overnight: true, health: true };
        if (S.view === 'graph') loadGraph(true); if (S.view === 'activity') loadActivity(); if (S.view === 'overnight') loadOvernight(); if (S.view === 'health') loadHealth(); if (S.view === 'access') loadAccess();
        // Overview re-reads too (its loader caches once per page).
        try { if (typeof vaultLoaded !== 'undefined' && typeof loadVault === 'function') { vaultLoaded = false; loadVault(); } } catch (e) { /* static page */ }
        if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
      });
  }

  // ---- Graph -----------------------------------------------------------------------------------------
  // The canvas is lib/ui/brain-graph.js. Around it, the two Chronos controls the map itself does not
  // carry: WHICH brains to show (vault / board meeting / live data / bridges) and WHEN — a time slider
  // that shows the brain as it stood at the end of a past California day (facts not yet known drop
  // out, facts superseded later count as still true then). Both are a filter of the same /api/brain/graph
  // payload, so the map stays a pure function of the data it is handed.
  var DAY_MS = 86400000;
  var ORIGINS = [['chronos', 'Chronos vault'], ['command', 'Board meeting'], ['live', 'Live data'], ['bridge', 'Bridges']];
  // California midnight of y-m-d, DST-correct (the same reading of a bare day the map uses).
  function ptMidnight(y, m, d) {
    var guess = Date.UTC(y, m - 1, d, 8, 0), off = 8;
    try { var h = Number(new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(guess)).filter(function (p) { return p.type === 'hour'; })[0].value); if (h === 1) off = 7; } catch (e) { /* assume PST */ }
    return Date.UTC(y, m - 1, d, off, 0);
  }
  // A graph date → ms: 'YYYY-MM-DD' is a California day; 'YYYY-MM-DDTHH:MM' (no zone) is a UTC minute.
  function tms(v) {
    if (v == null || v === '') return null;
    var s = String(v).trim(), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return ptMidnight(+m[1], +m[2], +m[3]);
    var ms = Date.parse(norm(s)); return isNaN(ms) ? null : ms;
  }
  function ptYmd(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: PT }); }
  // The brain as it stood at `asOf` (ms; null = now), limited to the chosen origins. Pure.
  function graphAt(g, asOf, origins) {
    origins = origins || {};
    var on = function (o) { return origins[o] !== false; };
    var allOn = ORIGINS.every(function (o) { return on(o[0]); });
    var nodes = (g.nodes || []).filter(function (n) { return on(n.origin || 'chronos'); });
    var ids = {}; nodes.forEach(function (n) { ids[n.id] = 1; });
    var links = [], counts = { active: 0, superseded: 0, future: 0 }, now = asOf == null ? Date.now() : asOf;
    (g.links || []).forEach(function (l) {
      var s = l.source && l.source.id ? l.source.id : l.source, t = l.target && l.target.id ? l.target.id : l.target;
      if (l.kind === 'bridge' && !on('bridge')) return;
      if (!ids[s] || !ids[t]) return;
      if (l.kind === 'fact') {
        var from = tms(l.valid_from);
        if (asOf != null && from != null && from > asOf) { counts.future++; return; }
        var to = tms(l.valid_to), inv = tms(l.invalidated);
        if (asOf != null && ((to != null && to > asOf) || (inv != null && inv > asOf))) {
          // Superseded LATER: on that day it was still the answer.
          var c = {}; for (var k in l) c[k] = l[k];
          if (to != null && to > asOf) { c.valid_to = null; c.superseded_by = null; to = null; }
          if (inv != null && inv > asOf) c.invalidated = null;
          l = c;
        }
        if (to != null && to <= now) counts.superseded++; else counts.active++;
      } else if (l.kind === 'work' && asOf != null) {
        var w = tms(l.valid_from); if (w != null && w > asOf) return;
      }
      links.push(l);
    });
    if (asOf != null || !allOn) {
      // A fact value, entity, thread or department exists only through its links — when none is left
      // at that date, it was not there yet. Notes stay: they are the vault's skeleton.
      var inc = {}; links.forEach(function (l) { inc[l.source && l.source.id ? l.source.id : l.source] = 1; inc[l.target && l.target.id ? l.target.id : l.target] = 1; });
      var PRUNE = { value: 1, entity: 1, thread: 1, dept: 1 };
      nodes = nodes.filter(function (n) { return !PRUNE[n.type] || inc[n.id]; });
    }
    var out = {}; for (var key in g) out[key] = g[key];
    out.nodes = nodes; out.links = links; out.asOf = asOf; out.factCounts = counts;
    return out;
  }
  window.__brainGraphAt = graphAt; // for tests

  function graphStart(g) { var a = tms(g && g.dateRange && g.dateRange.from); var floor = Date.now() - 3 * 365 * DAY_MS; return a == null || a < floor ? floor : a; }
  function asOfSteps() { return Math.max(1, Math.ceil((Date.now() - graphStart(S.graph)) / DAY_MS)); }
  // Slider position i → end of that California day (ms), or null at the right end (= now).
  function asOfFromSlider(i, n) {
    if (i >= n) return null;
    var d = ptYmd(graphStart(S.graph) + i * DAY_MS).split('-');
    return ptMidnight(+d[0], +d[1], +d[2] + 1) - 1;
  }
  function graphToolsWire() {
    var r = document.getElementById('brain-asof'); if (!r || r.dataset.wired) return; r.dataset.wired = '1';
    var t = null;
    r.oninput = function () { stopPlay(); asOfLabel(); clearTimeout(t); t = setTimeout(applyView, 180); };
    document.getElementById('brain-asof-now').onclick = function () { stopPlay(); r.value = r.max; asOfLabel(); applyView(); };
    document.getElementById('brain-asof-play').onclick = function () { if (S.play) stopPlay(); else startPlay(); };
    Array.prototype.forEach.call(document.querySelectorAll('#brain-origins [data-origin]'), function (b) {
      b.onclick = function () { var o = b.getAttribute('data-origin'); S.origins[o] = S.origins[o] === false; b.classList.toggle('on', S.origins[o] !== false); applyView(); };
    });
  }
  function asOfLabel() {
    var r = document.getElementById('brain-asof'), l = document.getElementById('brain-asof-l'); if (!r || !l) return;
    var a = asOfFromSlider(+r.value, +r.max);
    l.textContent = a == null ? 'Now' : 'As of ' + new Date(a).toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric' });
    l.classList.toggle('past', a != null);
    var nb = document.getElementById('brain-asof-now'); if (nb) nb.hidden = a == null;
  }
  function stopPlay() { if (S.play) { clearInterval(S.play); S.play = null; } var b = document.getElementById('brain-asof-play'); if (b) b.textContent = '▶'; }
  function startPlay() {
    var r = document.getElementById('brain-asof'); if (!r) return;
    if (+r.value >= +r.max) r.value = 0;
    var step = Math.max(1, Math.round(+r.max / 40));
    document.getElementById('brain-asof-play').textContent = '❚❚';
    asOfLabel(); applyView();
    S.play = setInterval(function () {
      if (!S.on || S.view !== 'graph') return stopPlay();
      r.value = Math.min(+r.max, +r.value + step); asOfLabel(); applyView();
      if (+r.value >= +r.max) stopPlay();
    }, 900);
  }
  function loadGraph(force) {
    if (S.gLoading) return; S.gLoading = true; S.stale.graph = false;
    if (!S.graph) document.getElementById('brain-stage').innerHTML = '<div class="u-skeleton"><div></div><div></div><div></div></div>';
    // If-None-Match: an unchanged graph is a 304 — nothing re-downloaded, nothing re-drawn.
    fetch('/api/brain/graph' + (force ? '?refresh=1' : ''), { headers: (S.etag && !force) ? { 'if-none-match': S.etag } : {} })
      .then(function (r) {
        if (r.status === 304) return null;
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        S.etag = r.headers.get('etag');
        return r.json();
      })
      .then(function (d) { if (d) { S.graph = d; renderGraph(); } })
      .catch(function (e) { banner('Could not load the graph: ' + e.message); })
      .then(function () { S.gLoading = false; renderStrip(); });
  }
  function banner(text) { var b = document.getElementById('brain-gbanner'); if (b) { b.hidden = !text; b.textContent = text || ''; } }
  function renderGraph() {
    var g = S.graph; if (!g) return;
    banner(g.error ? 'Graph error: ' + g.error : !g.stateFound ? 'No board-meeting graph yet (data/state.json) — run a board meeting to add Seen Command’s layer.' : '');
    graphToolsWire();
    var r = document.getElementById('brain-asof');
    if (r) { var n = asOfSteps(), atNow = !r.dataset.n || +r.value >= +r.dataset.n; r.max = n; r.dataset.n = n; if (atNow) r.value = n; asOfLabel(); }
    if (S.drawn === g && S.mounted) { renderStrip(); return; } // coming back to the view: the same data is already drawn
    S.drawn = g;
    applyView();
  }
  // Filter (time + origins) and hand the result to the map.
  function applyView() {
    var g = S.graph; if (!g) return;
    var r = document.getElementById('brain-asof');
    var v = graphAt(g, r ? asOfFromSlider(+r.value, +r.max) : null, S.origins);
    S.viewG = v;
    var stage = document.getElementById('brain-stage');
    if (!window.BrainGraph || typeof window.BrainGraph.mount !== 'function') { stage.innerHTML = '<div class="u-empty">The brain map did not load in this build.</div>'; return; }
    if (!S.bg) { stage.innerHTML = ''; S.bg = window.BrainGraph.mount(stage, v, { onSelect: select }); S.mounted = true; }
    else S.bg.update(v);
    renderStrip();
    if (S.selected && !v.nodes.some(function (n) { return n.id === S.selected.id; })) select(null);
  }
  function renderStrip() {
    var el = document.getElementById('brain-strip'); var g = S.graph; if (!el) return;
    if (!g) { el.textContent = S.gLoading ? 'building the graph…' : ''; return; }
    var c = g.counts || {}, t = c.total || {}, src = g.sources || {}, live = g.live || {}, v = S.viewG, fc = (v && v.factCounts) || {};
    var filtered = v && (v.asOf != null || v.nodes.length !== (g.nodes || []).length);
    var bits = [
      '<b>' + num(filtered ? v.nodes.length : t.nodes) + '</b> nodes' + (filtered ? ' of ' + num(t.nodes) : ''), '<b>' + num(filtered ? v.links.length : t.links) + '</b> links', '<b>' + num(filtered ? v.links.filter(function (l) { return l.kind === 'bridge'; }).length : c.bridges) + '</b> bridges',
      '<b>' + num(fc.active) + '</b> facts true ' + (v && v.asOf != null ? 'then' : 'now') + ' · ' + num(fc.superseded) + ' superseded' + (v && v.asOf != null ? ' · ' + num(fc.future) + ' not yet known' : ''),
      '<span class="brain-dot ' + (g.vaultFound ? 'ok' : 'miss') + '"></span>vault ' + (g.vaultFound ? E(shortPath(src.vaultPath)) : 'not found'),
      '<span class="brain-dot ' + (g.stateFound ? 'ok' : 'miss') + '"></span>board graph ' + (g.stateFound ? 'found' : 'not found'),
      'live: Supabase ' + (live.supabase ? '✓' : '—') + ' · GitHub ' + (live.github ? '✓' : '—'),
      S.gLoading ? 'updating…' : ('built ' + E(clock((S.status && S.status.graph && S.status.graph.builtAt) || new Date().toISOString()))),
    ];
    el.innerHTML = bits.join('<span class="sep">·</span>');
    el.title = 'vault: ' + (src.vaultPath || '—') + '\nboard graph: ' + (src.statePath || '—');
  }
  // What a node is ABOUT, in words a question can use: a fact value names its subject and predicate.
  function aboutNode(n) {
    var v = S.viewG || S.graph || {}, f = null;
    if (n.type === 'value') (v.links || []).some(function (l) { if (l.kind === 'fact' && (l.target === n.id || (l.target && l.target.id === n.id))) { f = l; return true; } return false; });
    if (f) return { subject: String(f.subject || ''), phrase: f.subject + '’s ' + f.predicate + ' (' + f.object + ')' };
    var label = String(n.label || n.id || '');
    return { subject: n.type === 'value' ? label.split(':')[0] : label, phrase: label };
  }
  // A node was picked on the map (its facts are in the map's own panel): offer the next move.
  function select(n) {
    S.selected = n || null;
    var el = document.getElementById('brain-selbar'); if (!el) return;
    if (!n) { el.hidden = true; el.innerHTML = ''; return; }
    var a = aboutNode(n);
    var where = n.origin === 'command' ? 'board meeting' : n.origin === 'live' ? 'live data' : 'Chronos vault';
    el.hidden = false;
    el.innerHTML = '<div class="brain-selbar-what"><b title="' + E(n.label) + '">' + E(n.label) + '</b><span class="u-muted sm">' + E(n.type || '') + ' · ' + E(where) + '</span></div>'
      + '<div class="u-actions"><button class="u-btn primary sm" id="brain-sel-room" title="Opens the Board Room with a question about this already typed — nothing is sent until you press send">Ask the Board Room about this</button>'
      + '<button class="u-btn sm" id="brain-sel-facts">Show its facts</button><button class="u-btn ghost sm" id="brain-sel-x" aria-label="Clear the selection">✕</button></div>';
    document.getElementById('brain-sel-x').onclick = function () { select(null); };
    document.getElementById('brain-sel-facts').onclick = function () { setView('overview'); if (window.vaultFilter) window.vaultFilter(a.subject); };
    document.getElementById('brain-sel-room').onclick = function () { prefillBoardRoom('What does the brain know about ' + a.phrase + ', and what should SeenJobs do about it?'); };
  }
  // Prefill the Board Room composer (never sends on its own).
  function prefillBoardRoom(text) {
    if (window.showTab) window.showTab('boardroom');
    var d = document.getElementById('directive'); if (!d) return;
    d.value = text;
    try { if (typeof autogrow === 'function') autogrow(d); } catch (e) { /* older page */ }
    d.focus(); try { d.setSelectionRange(text.length, text.length); } catch (e) { /* ignore */ }
  }
  // NOT window.askBoardRoom — that name is the chat's SEND function (scripts/build-dashboard.mjs). Overwriting
  // it (2026-10-21, #233) made every chat message silently go back into the box instead of being sent.
  window.prefillBoardRoom = prefillBoardRoom;

  // ---- Activity: every write, every request of the brain, who is working right now -----------------
  function startActPoll() { if (S.actPoll) return; S.actPoll = setInterval(function () { if (S.on && S.view === 'activity' && !document.hidden && !S.act.loading) loadActivity(); }, 20000); }
  function stopActPoll() { if (S.actPoll) { clearInterval(S.actPoll); S.actPoll = null; } }
  function loadActivity() {
    S.act.loading = true; S.stale.activity = false; if (!S.act.data) actRender();
    req('GET', '/api/brain/activity').then(function (d) { S.act.data = d; }).catch(function (e) { S.act.data = { error: 'Could not read activity: ' + e.message }; })
      .then(function () { S.act.loading = false; actCounts(); actRender(); });
  }
  function actCounts() {
    var d = S.act.data || {}, c = d.counts || {};
    var set = function (id, n) { var el = document.getElementById(id); if (el) el.textContent = n ? ' ' + num(n) : ''; };
    set('brain-n-recent', (d.recent || []).length); set('brain-n-all', c.changes); set('brain-n-req', c.requests);
    var sub = [];
    if (c.changes) sub.push(num(c.changes) + ' writes');
    if (c.requests) sub.push(num(c.requests) + ' requests (' + num(c.requestReads || 0) + ' read / ' + num(c.requestWrites || 0) + ' write' + (c.cloudRequests ? ', ' + num(c.cloudRequests) + ' from cloud sessions' : '') + ')');
    if (d.newestChangeAt) sub.push('last write ' + when(d.newestChangeAt));
    var el = document.getElementById('brain-act-sub'); if (el) el.textContent = d.error ? '' : (sub.length ? sub.join(' · ') : 'nothing recorded yet');
    var ses = document.getElementById('brain-act-sessions');
    if (ses) {
      var list = d.sessions || [];
      ses.innerHTML = list.length ? '<div class="brain-sessions"><span class="u-sub">Working right now</span>' + list.map(function (x) { return '<span class="u-chip run" title="' + E(x.cwd || '') + '">' + E(x.by || 'session') + ' · ' + E(x.repo || '') + ' · since ' + E(clock(x.at)) + '</span>'; }).join('') + '</div>' : '';
    }
  }
  function actSection(sec) {
    S.act.section = sec; S.act.all = false;
    Array.prototype.forEach.call(document.querySelectorAll('#brain-act-tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-sec') === sec); });
    actRender();
  }
  function winChip(r) {
    if (r.valid_from && r.valid_to) return '<span class="brain-win closed">' + E(when(r.valid_from)) + ' → ' + E(when(r.valid_to)) + '</span>';
    if (r.valid_from) return '<span class="brain-win">' + E(when(r.valid_from)) + ' → open</span>';
    return '<span class="brain-win none">no valid-time</span>';
  }
  function changeRow(r) {
    var obj = String(r.object || ''); var shown = obj.length > 260 ? obj.slice(0, 260) + '…' : obj;
    var meta = [winChip(r), '<span class="u-chip dim">' + E(r.kind) + '</span>'];
    if (r.retired) meta.push('<span class="u-chip dim">history</span>');
    if (r.by) meta.push('<span class="brain-by">' + E(r.by) + '</span>');
    if (r.note) meta.push('<span class="u-muted">' + E(r.note) + '</span>');
    var t = clock(r.at); if (t) meta.push('<span class="u-muted">' + E(t) + '</span>');
    return '<li class="brain-evt ' + (r.kind === 'changed' ? 'changed' : 'added') + (r.retired ? ' retired' : '') + '"><div class="brain-evt-1"><b>' + E(r.subject) + '</b> <span class="u-muted">' + E(r.predicate) + '</span> → ' + E(shown) + '</div>'
      + '<div class="brain-evt-2">' + meta.join('') + '</div>' + (r.change ? '<div class="brain-why">' + E(r.change) + '</div>' : '') + '</li>';
  }
  function requestRow(r) {
    var meta = ['<span class="u-chip ' + (r.mode === 'write' ? 'run' : 'dim') + '">' + E(r.mode || 'read') + '</span>'];
    if (r.ok === false) meta.push('<span class="u-chip bad">failed</span>');
    if (r.origin === 'cloud') meta.push('<span class="u-chip dim">cloud</span>');
    if (r.by) meta.push('<span class="brain-by">' + E(r.by) + '</span>');
    if (typeof r.ms === 'number') meta.push('<span class="u-muted">' + r.ms + ' ms</span>');
    var t = clock(r.at); if (t) meta.push('<span class="u-muted">' + E(t) + '</span>');
    return '<li class="brain-evt ' + (r.ok === false ? 'failed' : r.mode === 'write' ? 'write' : 'read') + '"><div class="brain-evt-1"><b>' + E(r.tool) + '</b>' + (r.args ? ' <span class="u-muted">' + E(r.args) + '</span>' : '') + '</div>'
      + '<div class="brain-evt-2">' + meta.join('') + '</div>' + (r.error ? '<div class="brain-why">' + E(r.error) + '</div>' : '') + '</li>';
  }
  function actRender() {
    var body = document.getElementById('brain-act-body'); if (!body) return;
    var d = S.act.data;
    if (!d) { body.innerHTML = '<div class="u-skeleton"><div></div><div></div></div>'; return; }
    if (d.error) { body.innerHTML = '<div class="u-note warn">' + E(d.error) + '</div>'; return; }
    var isReq = S.act.section === 'requests';
    var rows = isReq ? (d.requests || []) : ((S.act.section === 'all' ? d.all : d.recent) || []);
    Array.prototype.forEach.call(document.querySelectorAll('#brain-act-tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-sec') === S.act.section); });
    if (!rows.length) { body.innerHTML = '<div class="u-empty">' + (isReq ? 'No requests logged yet. Every read or write an AI client makes through the brain is recorded here with its authenticated source.' : 'No changes recorded yet.') + '</div>'; return; }
    var cap = S.act.all ? rows.length : 300, shown = rows.slice(0, cap);
    var days = [], idx = {};
    shown.forEach(function (r) { var k = ptDay(r.at); if (idx[k] === undefined) { idx[k] = days.length; days.push({ day: k, items: [] }); } days[idx[k]].items.push(r); });
    body.innerHTML = days.map(function (g) {
      return '<div class="brain-day' + (g.day === todayPT() ? ' today' : '') + '"><span>' + E(dayLabel(g.day)) + '</span><i></i><span class="u-count">' + g.items.length + '</span></div><ul class="brain-feed">' + g.items.map(isReq ? requestRow : changeRow).join('') + '</ul>';
    }).join('') + (rows.length > shown.length ? '<div class="u-actions end"><button class="u-btn sm" id="brain-act-more">Show all ' + num(rows.length) + '</button></div>' : '');
    var more = document.getElementById('brain-act-more'); if (more) more.onclick = function () { S.act.all = true; actRender(); };
  }

  // ---- Overnight: what the scheduled 4 AM agents did -------------------------------------------------
  var LANE = { 'applications': 'run', 'seenjobs.io': 'ok', 'overnight': 'dim' };
  function loadOvernight() {
    S.ov.loading = true; S.stale.overnight = false; if (!S.ov.data) ovRender();
    req('GET', '/api/brain/overnight').then(function (d) { S.ov.data = d; }).catch(function (e) { S.ov.data = { error: 'Could not read the overnight digests: ' + e.message }; })
      .then(function () { S.ov.loading = false; ovRender(); });
  }
  function ovRender() {
    var body = document.getElementById('brain-ov-body'), sub = document.getElementById('brain-ov-sub'); if (!body) return;
    var d = S.ov.data;
    if (!d) { body.innerHTML = '<div class="u-skeleton"><div></div><div></div></div>'; return; }
    if (d.error) { sub.textContent = 'could not read the overnight digests'; body.innerHTML = '<div class="u-note warn">' + E(d.error) + '</div>'; return; }
    var runs = (d.counts && d.counts.runs) || 0, total = (d.counts && d.counts.entries) || 0;
    var entries = total + ' timeline entr' + (total === 1 ? 'y' : 'ies');
    sub.innerHTML = runs ? E(runs + ' overnight agent run' + (runs === 1 ? '' : 's') + ' and ' + entries + ' over the last week')
      : total ? '<span class="u-chip warn">no overnight digest this week</span> The 4 AM agents (applications 4:00 AM PT, seenjobs.io 4:30 AM PT) left nothing in 7 days — check that the routines still run. Below: the week’s ' + E(entries) + '.'
        : 'The 4 AM agents write one digest each per night (applications at 4:00 AM PT, seenjobs.io at 4:30 AM PT).';
    if (!total) { body.innerHTML = '<div class="u-empty">Nothing in the vault’s timeline this week. If a routine ran but nothing appears, it wrote to the cloud and this Mac has not pulled it yet — Seen Command pulls the cloud brain every minute while it runs (Refresh pulls now).</div>'; return; }
    var html = '', day = null, today = todayPT();
    (d.entries || []).forEach(function (e, i) {
      if (e.date !== day) { day = e.date; html += '<div class="brain-day' + (day === today ? ' today' : '') + '"><span>' + E(dayLabel(day)) + '</span><i></i></div>'; }
      var long = String(e.body || '').length > 420, open = !!S.ov.open[i];
      html += '<div class="u-card brain-ov' + (e.lane ? ' run' : '') + '"><header><h3>' + E(e.heading) + '</h3>' + (e.lane ? '<span class="u-chip ' + (LANE[e.lane] || 'dim') + '">' + E(e.lane) + '</span>' : '') + '</header>'
        + '<div class="brain-ov-body' + (long && !open ? ' clip' : '') + '">' + E(e.body) + '</div>'
        + (long ? '<button class="u-btn ghost sm brain-ov-more" data-i="' + i + '">' + (open ? 'Show less' : 'Show more') + '</button>' : '') + '</div>';
    });
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('.brain-ov-more'), function (b) { b.onclick = function () { var i = b.getAttribute('data-i'); S.ov.open[i] = !S.ov.open[i]; ovRender(); }; });
  }

  // ---- Health: the Keeper's audit + where the brain lives --------------------------------------------
  function loadHealth() {
    S.hl.loading = true; S.stale.health = false; if (!S.hl.data) hlRender();
    req('GET', '/api/brain/health').then(function (d) { S.hl.data = d; }).catch(function (e) { S.hl.data = { error: 'Could not audit the brain: ' + e.message }; })
      .then(function () { S.hl.loading = false; hlRender(); sourcesRender(); });
  }
  function ticks(n, red) { if (!n) return '<div class="brain-ticks"><span class="u-muted sm">none</span></div>'; var k = Math.min(n, 48), o = ''; for (var i = 0; i < k; i++) o += '<i></i>'; return '<div class="brain-ticks' + (red ? ' red' : '') + '">' + o + (n > k ? '<span class="u-muted sm">+' + (n - k) + '</span>' : '') + '</div>'; }
  function hlRender() {
    var body = document.getElementById('brain-hl-body'); if (!body) return;
    var d = S.hl.data;
    if (!d) { body.innerHTML = '<div class="u-skeleton"><div></div></div>'; return; }
    if (d.error) { body.innerHTML = '<div class="u-note warn">' + E(d.error) + '</div>'; return; }
    var total = +d.facts || 0, cur = +d.currentFacts || 0, hist = Math.max(0, total - cur), pct = total ? Math.round(cur / total * 100) : 0;
    var contra = d.contradictions || [], stale = d.stale || [], prov = d.provenance || null;
    var h = '<div class="brain-verdict ' + (d.clean ? 'clean' : 'look') + '"><b>' + (d.clean ? 'Brain is clean' : 'Worth a look') + '</b><span>' + E(d.verdict || (contra.length + ' contradictions · ' + stale.length + ' possibly stale')) + '</span></div>';
    h += '<div class="u-stats">'
      + '<div class="u-stat accent"><div class="u-stat-v">' + num(cur) + '<span class="u-muted sm"> / ' + num(total) + '</span></div><div class="u-stat-l">True now</div><div class="brain-split"><i style="width:' + pct + '%"></i></div><div class="u-stat-s">' + num(cur) + ' still true · ' + num(hist) + ' kept as history (' + pct + '% hold today)</div></div>'
      + '<div class="u-stat ' + (contra.length ? 'bad' : '') + '"><div class="u-stat-v">' + num(contra.length) + '</div><div class="u-stat-l">Contradictions</div>' + ticks(contra.length, true) + '<div class="u-stat-s">One subject and predicate with two answers that both claim to be current.</div></div>'
      + '<div class="u-stat ' + (stale.length ? 'warn' : '') + '"><div class="u-stat-v">' + num(stale.length) + '</div><div class="u-stat-l">Possibly stale</div>' + ticks(stale.length, false) + '<div class="u-stat-s">Open facts nothing has re-recorded in over 14 days' + (d.oldestStaleRecorded ? ' (oldest ' + E(when(d.oldestStaleRecorded)) + ')' : '') + '.</div></div>'
      + (prov && prov.total ? '<div class="u-stat"><div class="u-stat-v">' + Math.round((prov.evidenceBacked / prov.total) * 100) + '%</div><div class="u-stat-l">Evidence-backed</div><div class="u-stat-s">' + num(prov.evidenceBacked) + ' of ' + num(prov.total) + ' current facts cite a measurement, artifact or code; ' + num(prov.weak) + ' cite only a note or nothing.</div></div>' : '')
      + '</div>';
    h += '<div class="u-card"><header><h3>Contradictions</h3><span class="u-count">' + contra.length + '</span></header>' + (contra.length ? '<ul class="u-list tight">' + contra.map(function (c) { return '<li class="u-row"><span class="u-dot error"></span><div class="u-row-main"><p>' + E(c) + '</p></div></li>'; }).join('') + '</ul>' : '<div class="u-empty ok">None. No subject in the brain holds two current answers.</div>') + '</div>';
    var staleShown = S.hl.all ? stale : stale.slice(0, 40);
    h += '<div class="u-card brain-gap"><header><h3>Possibly stale</h3><span class="u-count">' + stale.length + '</span></header>' + (stale.length ? '<ul class="u-list tight">' + staleShown.map(function (s) { return '<li class="u-row"><span class="u-dot warning"></span><div class="u-row-main"><p>' + E(s) + '</p></div></li>'; }).join('') + '</ul>' + (stale.length > staleShown.length ? '<div class="u-actions end"><button class="u-btn sm" id="brain-hl-more">Show all ' + num(stale.length) + '</button></div>' : '') : '<div class="u-empty ok">None. Every open fact was recorded inside the last 14 days.</div>') + '</div>';
    body.innerHTML = h;
    var more = document.getElementById('brain-hl-more'); if (more) more.onclick = function () { S.hl.all = true; hlRender(); };
  }
  function sourcesRender() {
    var el = document.getElementById('brain-sources'); if (!el) return;
    var s = (S.status && S.status.sources) || (S.hl.data && S.hl.data.sources) || {}, c = (S.status && S.status.cloud) || {}, ls = c.lastSync || {}, w = (S.status && S.status.watching) || {};
    el.innerHTML = '<div class="u-card brain-gap"><header><h3>Where the brain lives</h3></header><dl class="u-facts">'
      + '<dt>Vault</dt><dd>' + (s.vaultFound ? E(s.vaultPath) + (w.vault ? ' <span class="u-chip ok">watched live</span>' : '') : '<span class="u-chip bad">not found</span>') + '</dd>'
      + '<dt>Board graph</dt><dd>' + E(s.statePath || '—') + (s.stateFound ? '' : ' <span class="u-chip warn">not yet written</span>') + '</dd>'
      + '<dt>Cloud copy</dt><dd>' + (c.configured === false ? 'not set up on this Mac (SUPABASE_URL + SUPABASE_SERVICE_KEY in Settings)' : (ls.at ? (ls.error ? 'last pull failed ' + E(ago(ls.at)) + ': ' + E(ls.error) : 'pulled ' + E(ago(ls.at)) + (ls.changed || ls.merged || ls.timeline ? ' — ' + num((ls.changed || 0) + (ls.merged || 0)) + ' notes, ' + num(ls.timeline || 0) + ' timeline entries' : ' — nothing new')) : 'first pull pending') + ' · every ' + Math.round((c.pollMs || 60000) / 1000) + ' s') + '</dd>'
      + '<dt>Audited</dt><dd>' + E(s.today ? dayLabel(s.today) : '') + ' · ' + E(s.version || '') + '</dd>'
      + '</dl><div class="brain-src-form"><input id="brain-src-path" placeholder="/Users/you/…/seen/memory" value="' + E(s.vaultPath || '') + '"><button class="u-btn sm" id="brain-src-save">Use this vault folder</button><span class="u-muted sm" id="brain-src-out"></span></div></div>';
    document.getElementById('brain-src-save').onclick = function () {
      var out = document.getElementById('brain-src-out'), v = document.getElementById('brain-src-path').value;
      out.textContent = 'checking…';
      req('POST', '/api/brain/sources', { vaultPath: v }).then(function () { out.textContent = 'Saved. Every view now reads this vault.'; S.stale = { graph: true, activity: true, overnight: true, health: true }; pollOnce(); loadHealth(); })
        .catch(function (e) { out.textContent = e.message; });
    };
  }

  // ---- Access: who may use the brain ----------------------------------------------------------------
  function loadAccess() {
    S.ac.loading = true;
    req('GET', '/api/brain/access').then(function (d) { S.ac.clients = d.clients || []; S.ac.meta = d; acRender(); })
      .catch(function (e) { var b = document.getElementById('brain-ac-body'); if (b) b.innerHTML = '<div class="u-note warn">' + E(e.message) + '</div>'; })
      .then(function () { S.ac.loading = false; });
  }
  function clearSecret() { var box = document.getElementById('brain-ac-secret'); if (box) { box.hidden = true; box.innerHTML = ''; } }
  function showSecret(out) {
    var box = document.getElementById('brain-ac-secret'); if (!box) return;
    box.hidden = false;
    var cloud = out.cloud && !out.cloud.synced ? '<div class="u-muted sm">cloud gateway: ' + E(out.cloud.reason || 'not synced') + '</div>' : '<div class="u-muted sm">mirrored to the cloud gateway</div>';
    if (!out.secret && out.secretInstalled) {
      box.innerHTML = '<div class="u-note brain-ok"><b>Installed on this Mac.</b> The secret never left the Seen Command server.' + (out.credentialFile ? '<div class="mono sm">' + E(out.credentialFile) + '</div>' : '') + cloud + '</div>';
      return;
    }
    box.innerHTML = '<div class="u-note warn"><b>Copy it now — it is shown once.</b><div class="brain-secret mono">' + E(out.secret) + '</div>'
      + (out.credentialFile ? '<div class="mono sm">installed: ' + E(out.credentialFile) + '</div>' : '') + cloud
      + '<div class="u-actions"><button class="u-btn sm" id="brain-ac-copy">Copy credential</button><button class="u-btn ghost sm" id="brain-ac-hide">Done — hide it</button></div></div>';
    var secret = out.secret, copyId = out.copyId;
    document.getElementById('brain-ac-hide').onclick = clearSecret;
    // Copy once: the request carries only the one-time copy id; the server puts the secret on this Mac's
    // clipboard and forgets it. Where the server has no clipboard (not a Mac), the page copies what it shows.
    document.getElementById('brain-ac-copy').onclick = function () {
      var b = this, id = copyId; copyId = null; b.disabled = true;
      var done = function (t) { b.textContent = t; };
      req('POST', '/api/brain/access/copy-once', { copyId: id }).then(function (r) {
        if (r.copied) return done('Copied');
        if (r.gone) return done('Already copied once');
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(secret).then(function () { done('Copied'); }, function () { done('Select the text to copy'); });
        done('Select the text to copy');
      }).catch(function () { done('Select the text to copy'); });
    };
  }
  function acStatus(c) { return c.revokedAt ? 'revoked' : (c.expiresAt && Date.parse(c.expiresAt) <= Date.now() ? 'expired' : 'active'); }
  function acCard(c) {
    var st = acStatus(c);
    return '<li class="u-row"><span class="u-dot ' + (st === 'active' ? 'success' : st === 'expired' ? 'warning' : 'error') + '"></span><div class="u-row-main"><b>' + E(c.name) + ' <span class="u-muted sm mono">' + E(c.id) + '</span></b>'
      + '<p><span class="u-chip ' + (st === 'active' ? 'ok' : st === 'expired' ? 'warn' : 'bad') + '">' + st + '</span> ' + E((c.scopes || []).join(', '))
      + (c.installedOnThisMac ? ' · installed on this Mac' : '') + ' · ' + (c.expiresAt ? (st === 'expired' ? 'expired ' : 'expires ') + E(when(c.expiresAt)) : 'no expiry')
      + (c.lastUsedAt ? ' · last used ' + E(when(c.lastUsedAt)) : ' · never used') + (c.revokedAt ? ' · revoked ' + E(when(c.revokedAt)) : '') + '</p></div>'
      + (st !== 'revoked' ? '<div class="u-actions"><button class="u-btn sm brain-ac-renew" data-id="' + E(c.id) + '" data-name="' + E(c.name) + '">Renew</button>' + (st === 'active' ? '<button class="u-btn sm brain-ac-rotate" data-id="' + E(c.id) + '" data-name="' + E(c.name) + '">Rotate</button>' : '') + '<button class="u-btn sm danger brain-ac-revoke" data-id="' + E(c.id) + '" data-name="' + E(c.name) + '">Revoke</button></div>' : '')
      + '</li>';
  }
  function ttlExpiry() { var v = Number(document.getElementById('brain-ac-ttl').value); return v ? new Date(Date.now() + v * 3600000).toISOString() : null; }
  function acRender() {
    var body = document.getElementById('brain-ac-body'); if (!body) return;
    var m = S.ac.meta || {};
    if (m.vaultFound === false) { body.innerHTML = '<div class="u-note warn">No vault on this Mac, so there is no credential registry to manage. Pick the vault folder under Health → Where the brain lives.</div>'; return; }
    var cur = S.ac.clients.filter(function (c) { return !c.revokedAt; }), rev = S.ac.clients.filter(function (c) { return !!c.revokedAt; });
    body.innerHTML = '<div class="u-card"><header><h3>Current credentials</h3><span class="u-count">' + cur.length + '</span></header>'
      + (cur.length ? '<ul class="u-list">' + cur.map(acCard).join('') + '</ul>' : '<div class="u-empty">No authenticated clients — brain MCP access is locked until one is issued.</div>') + '</div>'
      + (rev.length ? '<div class="u-card brain-gap"><header><h3>Explicitly revoked</h3><span class="u-count">' + rev.length + '</span></header><ul class="u-list">' + rev.map(acCard).join('') + '</ul></div>' : '')
      + (m.cloudConfigured === false ? '<p class="u-muted sm brain-gap">The cloud copy is not set up here, so changes stay on this Mac until it is (cloud sessions verify against the mirrored registry).</p>' : '');
    var box = function (html) { var b = document.getElementById('brain-ac-secret'); b.hidden = false; b.innerHTML = html; };
    Array.prototype.forEach.call(body.querySelectorAll('.brain-ac-revoke'), function (b) { b.onclick = function () {
      if (!confirm('Revoke ' + b.dataset.name + ' now? Anything using it stops working immediately.')) return;
      req('POST', '/api/brain/access/revoke', { id: b.dataset.id }).then(loadAccess).catch(function (e) { box('<div class="u-note warn">' + E(e.message) + '</div>'); });
    }; });
    Array.prototype.forEach.call(body.querySelectorAll('.brain-ac-renew'), function (b) { b.onclick = function () {
      var sel = document.getElementById('brain-ac-ttl');
      if (!confirm('Renew ' + b.dataset.name + ' — ' + sel.options[sel.selectedIndex].text + '? The credential itself does not change, so running sessions keep working.')) return;
      req('POST', '/api/brain/access/renew', { id: b.dataset.id, expiresAt: ttlExpiry() }).then(function (out) {
        box('<div class="u-note brain-ok"><b>Renewed ' + E(out.client.name) + '.</b> Same credential, ' + (out.client.expiresAt ? 'now expires ' + E(when(out.client.expiresAt)) : 'no expiry') + '. Nothing to reinstall.' + (out.cloud && !out.cloud.synced ? '<div class="u-muted sm">cloud gateway: ' + E(out.cloud.reason || 'not synced') + '</div>' : '') + '</div>');
        loadAccess();
      }).catch(function (e) { box('<div class="u-note warn">' + E(e.message) + '</div>'); });
    }; });
    Array.prototype.forEach.call(body.querySelectorAll('.brain-ac-rotate'), function (b) { b.onclick = function () {
      if (!confirm('Rotate ' + b.dataset.name + ' now? The old credential stops working immediately.')) return;
      req('POST', '/api/brain/access/rotate', { id: b.dataset.id }).then(function (out) { showSecret(out); loadAccess(); }).catch(function (e) { box('<div class="u-note warn">' + E(e.message) + '</div>'); });
    }; });
  }
  function issue() {
    var scopes = [];
    Array.prototype.forEach.call(document.querySelectorAll('#brain-v-access [data-scope]'), function (x) { if (x.checked) scopes.push(x.getAttribute('data-scope')); });
    var name = document.getElementById('brain-ac-name');
    var btn = document.getElementById('brain-ac-issue'); btn.disabled = true;
    req('POST', '/api/brain/access/issue', { name: name.value, scopes: scopes, expiresAt: ttlExpiry(), installLocal: document.getElementById('brain-ac-install').checked })
      .then(function (out) { showSecret(out); name.value = ''; loadAccess(); })
      .catch(function (e) { var b = document.getElementById('brain-ac-secret'); b.hidden = false; b.innerHTML = '<div class="u-note warn">' + E(e.message) + '</div>'; })
      .then(function () { btn.disabled = false; });
  }

  // ---- wiring ------------------------------------------------------------------------------------------
  function enter() {
    if (!build()) return;
    S.on = true;
    setView(S.view && S.built && S.entered ? S.view : (store('sc-brain-view') || 'overview'));
    S.entered = true;
    startPoll();
  }
  function leave() { if (!S.on) return; S.on = false; stopPoll(); stopPlay(); clearSecret(); }
  // showTab calls this on every tab change.
  window.brainTab = function (name) { if (name === 'vault') enter(); else leave(); };
  // The app menu (and anything else) opens a view directly: openBrain('activity', 'requests').
  window.openBrain = function (view, section) {
    if (window.showTab) window.showTab('vault'); else enter();
    if (view) setView(view);
    if (view === 'activity' && section) { actSection(section); if (!S.act.loading) loadActivity(); }
  };
  window.refreshBrain = refreshAll;
  document.addEventListener('keydown', function (e) {
    if (!S.on || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    var v = KEYS[e.key]; if (!v) return;
    e.preventDefault(); setView(v);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.on) pollOnce(); });
})();
