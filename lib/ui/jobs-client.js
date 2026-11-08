// Jobs — every Seen job listing, managed from Seen Command (2026-10-21). Browse with search + filters
// (keyset pages over the whole table, so "every listing" really is every listing), click one for the full
// record, edit it, take it down or put it back. Backed by Seen's admin job manager through /api/jobs*.
// Inlined into public/command-center.html after app-client.js. Plain browser JS. California time.
(function () {
  var PT = 'America/Los_Angeles';
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  var fmt = function (iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  function ago(iso) {
    if (!iso) return ''; var s = (Date.now() - new Date(iso)) / 1000; if (isNaN(s)) return '';
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' });
  }
  function req(method, u, body) {
    return fetch(u, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  // Seen answers "Unknown action" until the job manager (Seen PR #346) is deployed.
  var why = function (e) { return /unknown action/i.test(e.message) ? 'Seen has not been updated with the job manager yet (Seen PR #346) — it works as soon as that is deployed.' : e.message; };
  var pay = function (j) { if (j.salary) return j.salary; if (j.salary_min || j.salary_max) return '$' + [j.salary_min, j.salary_max].filter(function (x) { return x != null; }).map(num).join('–'); return ''; };
  var onSite = function (j) { return j.expires_at && new Date(j.expires_at) > new Date(); };
  var statusChip = function (j) { return onSite(j) ? '<span class="u-chip ok">On the site</span>' : '<span class="u-chip dim">Off the site</span>'; };
  // Descriptions arrive as HTML from job boards: parsed inertly (no scripts run) and shown as text.
  function plain(html) { try { return new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim(); } catch (e) { return String(html || ''); } }

  var F = { q: '', company: '', location: '', source: '', status: 'all', visible: '', since: '', sort: 'newest' };
  var rows = [], next = null, total = null, loading = false, openId = null;

  function filtersBar() {
    var sel = function (id, opts) { return '<select id="' + id + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (F[id.slice(3)] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'; };
    return '<div class="u-jf">'
      + '<input id="jf-q" placeholder="Search titles and companies — “registered nurse”, “acme”" value="' + E(F.q) + '">'
      + '<input id="jf-company" placeholder="Company" value="' + E(F.company) + '">'
      + '<input id="jf-location" placeholder="Location" value="' + E(F.location) + '">'
      + '<input id="jf-source" placeholder="Source (Greenhouse…)" value="' + E(F.source) + '">'
      + sel('jf-since', [['', 'Added any time'], ['today', 'Added today'], ['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']])
      + sel('jf-visible', [['', 'On or off the site'], ['on', 'On the site'], ['off', 'Off the site']])
      + sel('jf-status', [['all', 'Any status'], ['active', 'Active'], ['stale', 'Stale'], ['expired', 'Expired'], ['unknown', 'Unknown']])
      + sel('jf-sort', [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['seen', 'Last seen on its board']])
      + '</div>';
  }
  function rowHtml(j) {
    var meta = [j.company, j.location, j.source].filter(Boolean).map(E).join(' · ');
    return '<li class="u-row u-job" data-id="' + E(j.id) + '"><div class="u-row-main"><b>' + E(j.title) + '</b><p>' + meta + (pay(j) ? ' · ' + E(pay(j)) : '') + (j.is_employer_posted ? ' · <span class="u-chip run">Employer post</span>' : '') + '</p></div>'
      + '<span class="u-muted sm nowrap">added ' + E(ago(j.created_at)) + '</span>' + statusChip(j) + '</li>';
  }
  function renderList() {
    var el = document.getElementById('jobs-list'); if (!el) return;
    var head = document.getElementById('jobs-total');
    if (head) head.textContent = total == null ? '' : num(total) + (total === 1 ? ' listing' : ' listings') + ' match';
    if (!rows.length) { el.innerHTML = loading ? '<div class="u-skeleton"><div></div><div></div><div></div></div>' : '<div class="u-empty">No listings match these filters.</div>'; return; }
    // Rows already on screen stay; only new rows are added (re-rendering every row on each "Load more" made
    // long lists stutter). One click handler serves the whole list.
    var ul = el.querySelector('ul.u-jobs');
    var drawn = ul ? ul.children.length : 0;
    if (!ul || drawn > rows.length) { el.innerHTML = '<ul class="u-list u-jobs"></ul><div id="jobs-foot"></div>'; ul = el.querySelector('ul.u-jobs'); drawn = 0;
      ul.addEventListener('click', function (e) { var li = e.target.closest('.u-job'); if (li) openJob(li.getAttribute('data-id')); }); }
    if (rows.length > drawn) ul.insertAdjacentHTML('beforeend', rows.slice(drawn).map(rowHtml).join(''));
    var foot = document.getElementById('jobs-foot');
    if (foot) foot.innerHTML = next ? '<div class="u-actions end"><button class="u-btn" id="jobs-more">' + (loading ? 'Loading…' : 'Load 50 more') + '</button><span class="u-muted sm">showing ' + num(rows.length) + ' of ' + num(total) + '</span></div>' : '<div class="u-muted sm u-end">All ' + num(rows.length) + ' shown.</div>';
    var more = document.getElementById('jobs-more'); if (more) more.onclick = function () { load(false); };
  }
  function qsOf(cursor) {
    var p = new URLSearchParams();
    Object.keys(F).forEach(function (k) { if (F[k] && !(k === 'status' && F[k] === 'all')) p.set(k, F[k]); });
    p.set('limit', '50'); if (cursor) p.set('cursor', JSON.stringify(cursor));
    return p.toString();
  }
  var seq = 0;
  function load(reset) {
    if (loading && !reset) return;
    var mine = ++seq; loading = true;
    if (reset) { rows = []; next = null; total = null; renderList(); }
    req('GET', '/api/jobs?' + qsOf(reset ? null : next)).then(function (d) {
      if (mine !== seq) return; // a newer filter change won
      rows = rows.concat(d.jobs || []); next = d.next || null; total = d.total; loading = false; renderList();
      // Ask for the next page now, quietly: the server keeps it for 30 s, so "Load more" is usually instant.
      if (next) fetch('/api/jobs?' + qsOf(next)).catch(function () {});
    }).catch(function (e) { if (mine !== seq) return; loading = false; var el = document.getElementById('jobs-list'); if (el) el.innerHTML = '<div class="u-empty">Listings could not load: ' + E(why(e)) + '</div>'; });
  }

  // ---- one listing, in full ----
  var EDIT = [['title', 'Title'], ['company', 'Company'], ['location', 'Location'], ['salary', 'Pay as shown'], ['salary_min', 'Pay from (yearly $)'], ['salary_max', 'Pay to (yearly $)'], ['apply_url', 'Apply link'], ['job_type', 'Job type'], ['level', 'Level']];
  function closeJob() { openId = null; var d = document.getElementById('job-drawer'); if (d) d.remove(); }
  function openJob(id) {
    closeJob(); openId = id;
    var d = document.createElement('div'); d.id = 'job-drawer'; d.className = 'u-drawer-wrap';
    d.innerHTML = '<div class="u-drawer-bg"></div><aside class="u-drawer"><div class="u-skeleton"><div></div><div></div></div></aside>';
    document.body.appendChild(d);
    d.querySelector('.u-drawer-bg').onclick = closeJob;
    req('GET', '/api/jobs/' + encodeURIComponent(id)).then(function (x) { if (openId === id) renderJob(x); })
      .catch(function (e) { var a = d.querySelector('.u-drawer'); if (a) a.innerHTML = '<div class="u-empty">This listing could not load: ' + E(why(e)) + '</div><div class="u-actions end"><button class="u-btn" id="jd-close">Close</button></div>'; var c = document.getElementById('jd-close'); if (c) c.onclick = closeJob; });
  }
  function renderJob(x) {
    var j = x.job || {}; var a = document.querySelector('#job-drawer .u-drawer'); if (!a) return;
    var held = (x.holders || []).filter(function (h) { return h.count; });
    var facts = [['Company', j.company], ['Location', j.location], ['Pay', pay(j)], ['Source', j.source + (j.ats_provider ? ' (' + j.ats_provider + ')' : '')], ['Status', j.availability_status + (j.status && j.status !== 'active' ? ' · ' + j.status : '')],
      ['Remote', j.remote == null ? '' : j.remote ? 'Yes' : 'No'], ['Added to Seen', fmt(j.created_at)], ['Last seen on its board', fmt(j.last_seen_at)], ['Leaves the site', fmt(j.expires_at)], ['Last edited', j.edited_at ? fmt(j.edited_at) : ''], ['Score', j.score == null ? '' : j.score]];
    a.innerHTML = '<header class="u-drawer-h"><div><h2>' + E(j.title) + '</h2><p class="u-muted">' + E([j.company, j.location].filter(Boolean).join(' · ')) + '</p></div><button class="u-btn ghost sm" id="jd-x" aria-label="Close">✕</button></header>'
      + '<div class="u-actions">' + statusChip(j) + (x.suppressed ? '<span class="u-chip warn">Apply link blocked from coming back</span>' : '') + (j.is_employer_posted ? '<span class="u-chip run">Employer post</span>' : '') + '</div>'
      + '<div class="u-actions">' + (j.apply_url ? '<a class="u-btn sm" href="' + E(j.apply_url) + '" target="_blank" rel="noopener">Open the employer’s posting ↗</a>' : '') + '<a class="u-btn sm" href="https://seenjobs.io/jobs/' + encodeURIComponent(j.id) + '" target="_blank" rel="noopener">Open on seenjobs.io ↗</a>'
      + '<button class="u-btn sm" id="jd-edit">Edit</button>' + (onSite(j) ? '<button class="u-btn sm danger" id="jd-remove">Take off the site</button>' : '<button class="u-btn sm primary" id="jd-restore">Put back on the site</button>') + '</div>'
      + '<div id="jd-msg"></div>'
      + '<dl class="u-facts">' + facts.filter(function (f) { return f[1] !== '' && f[1] != null; }).map(function (f) { return '<dt>' + E(f[0]) + '</dt><dd>' + E(f[1]) + '</dd>'; }).join('') + '</dl>'
      + '<div class="u-sub">People holding it</div><p class="u-muted">' + (held.length ? held.map(function (h) { return num(h.count) + ' ' + E(h.label); }).join(' · ') : 'Nobody has saved, tracked or applied to it.') + '</p>'
      + '<div id="jd-form"></div>'
      + '<div class="u-sub">Description</div><div class="u-desc">' + (j.description ? E(plain(j.description)) : '<span class="u-muted">No description stored.</span>') + '</div>'
      + ((x.history || []).length ? '<div class="u-sub">Admin history</div><ul class="u-list tight">' + x.history.map(function (h) { return '<li class="u-row"><div class="u-row-main"><b>' + E(h.action.replace(/_/g, ' ')) + '</b><p>' + E(fmt(h.created_at)) + (h.metadata && h.metadata.patch ? ' · ' + E(Object.keys(h.metadata.patch).join(', ')) : '') + '</p></div></li>'; }).join('') + '</ul>' : '')
      + '<p class="u-muted sm">Listing id ' + E(j.id) + '</p>';
    document.getElementById('jd-x').onclick = closeJob;
    var msg = function (t, tone) { var m = document.getElementById('jd-msg'); if (m) m.innerHTML = t ? '<div class="u-note ' + (tone || '') + '">' + E(t) + '</div>' : ''; };
    var after = function (text) { return function (r) { msg(text, 'ok'); var i = rows.findIndex(function (y) { return y.id === j.id; }); if (r && r.job && i >= 0) { rows[i] = Object.assign(rows[i], r.job); var l = document.querySelector('#jobs-list ul.u-jobs'); if (l) l.innerHTML = ''; renderList(); } req('GET', '/api/jobs/' + encodeURIComponent(j.id)).then(function (y) { if (openId === j.id) { renderJob(y); msg(text, 'ok'); } }); }; };
    var rm = document.getElementById('jd-remove');
    if (rm) rm.onclick = function () {
      if (!window.confirm('Take “' + j.title + '” off seenjobs.io? Its apply link is blocked from being re-added. You can put it back any time.')) return;
      rm.disabled = true; req('POST', '/api/jobs/' + encodeURIComponent(j.id) + '/remove').then(after('Taken off the site.')).catch(function (e) { rm.disabled = false; msg(why(e), 'bad'); });
    };
    var rs = document.getElementById('jd-restore');
    if (rs) rs.onclick = function () { rs.disabled = true; req('POST', '/api/jobs/' + encodeURIComponent(j.id) + '/restore').then(after('Back on the site for 14 days.')).catch(function (e) { rs.disabled = false; msg(why(e), 'bad'); }); };
    document.getElementById('jd-edit').onclick = function () { editForm(j, msg, after); };
  }
  function editForm(j, msg, after) {
    var el = document.getElementById('jd-form'); if (!el) return;
    var sel = function (k, opts) { return '<label><span>' + k[1] + '</span><select data-k="' + k[0] + '">' + opts.map(function (o) { return '<option' + (j[k[0]] === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>'; };
    el.innerHTML = '<div class="u-sub">Edit</div><div class="u-form">'
      + EDIT.map(function (k) { return '<label><span>' + E(k[1]) + '</span><input data-k="' + k[0] + '" value="' + E(j[k[0]] == null ? '' : j[k[0]]) + '"></label>'; }).join('')
      + sel(['availability_status', 'Availability'], ['active', 'stale', 'expired', 'unknown']) + sel(['status', 'Hiring status'], ['active', 'closed', 'filled'])
      + '<label class="u-check"><input type="checkbox" data-k="remote"' + (j.remote ? ' checked' : '') + '><span>Remote</span></label>'
      + '<label class="wide"><span>Description</span><textarea data-k="description" rows="10">' + E(j.description || '') + '</textarea></label>'
      + '</div><div class="u-actions end"><button class="u-btn ghost" id="jd-cancel">Cancel</button><button class="u-btn primary" id="jd-save">Save changes</button></div>';
    document.getElementById('jd-cancel').onclick = function () { el.innerHTML = ''; };
    document.getElementById('jd-save').onclick = function () {
      var patch = {};
      el.querySelectorAll('[data-k]').forEach(function (f) {
        var k = f.getAttribute('data-k'); var v = f.type === 'checkbox' ? f.checked : f.value;
        var was = j[k] == null ? (f.type === 'checkbox' ? false : '') : (f.type === 'checkbox' ? !!j[k] : String(j[k]));
        if (v === was) return;
        patch[k] = (v === '' && k !== 'title' && k !== 'company') ? null : v;
      });
      if (!Object.keys(patch).length) { msg('Nothing changed.'); return; }
      var b = document.getElementById('jd-save'); b.disabled = true;
      req('POST', '/api/jobs/' + encodeURIComponent(j.id), { patch: patch }).then(after('Saved: ' + Object.keys(patch).join(', ') + '.')).catch(function (e) { b.disabled = false; msg(why(e), 'bad'); });
    };
  }

  window.loadJobs = function () {
    var root = document.getElementById('jobs-view'); if (!root) return;
    if (!document.getElementById('jobs-list')) {
      root.innerHTML = '<div class="u-head"><div><h1>Jobs</h1><p class="u-muted">Every listing on seenjobs.io. Click one for the full record — edit it, take it off the site, or put it back. <span id="jobs-total"></span></p></div>'
        + '<div class="u-head-actions"><button class="u-btn ghost" id="jf-clear">Clear filters</button><button class="u-btn" id="jobs-refresh">Refresh</button></div></div>'
        + '<div id="dh-panel"></div>' + filtersBar() + '<div id="jobs-list"></div>';
      var t = null;
      ['q', 'company', 'location', 'source'].forEach(function (k) { document.getElementById('jf-' + k).addEventListener('input', function (e) { F[k] = e.target.value.trim(); clearTimeout(t); t = setTimeout(function () { load(true); }, 350); }); });
      ['since', 'visible', 'status', 'sort'].forEach(function (k) { document.getElementById('jf-' + k).onchange = function (e) { F[k] = e.target.value; load(true); }; });
      document.getElementById('jf-clear').onclick = function () { F = { q: '', company: '', location: '', source: '', status: 'all', visible: '', since: '', sort: 'newest' }; root.innerHTML = ''; window.loadJobs(); };
      document.getElementById('jobs-refresh').onclick = function () { load(true); };
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeJob(); });
    }
    load(true);
    if (window.loadDataHealth) window.loadDataHealth('dh-panel'); // duplicates + stale (lib/ui/data-health-client.js)
  };
  // Open the Jobs tab with filters set (Home's "added today", the chat, a search's results).
  window.openJobs = function (filters) {
    F = Object.assign({ q: '', company: '', location: '', source: '', status: 'all', visible: '', since: '', sort: 'newest' }, filters || {});
    var root = document.getElementById('jobs-view'); if (root) root.innerHTML = '';
    if (window.showTab) window.showTab('jobs'); else window.loadJobs();
  };
  window.openJob = openJob;
  // Home's "Recently added" card: the newest listings, each clickable.
  window.fillRecentJobs = function (elId) {
    var el = document.getElementById(elId); if (!el) return;
    req('GET', '/api/jobs?since=today&limit=8').then(function (d) {
      var list = d.jobs || [];
      el.innerHTML = list.length ? '<ul class="u-list tight">' + list.map(rowHtml).join('') + '</ul>' : '<div class="u-empty">No new listings yet today.</div>';
      el.querySelectorAll('.u-job').forEach(function (li) { li.onclick = function () { openJob(li.getAttribute('data-id')); }; });
    }).catch(function (e) { el.innerHTML = '<div class="u-empty">' + E(why(e)) + '</div>'; });
  };
})();
