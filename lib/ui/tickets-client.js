// Tickets — every failure Seen Command turned into trackable work in the brain (2026-10-21). A failed
// build, collector run, deploy drift or red test opens a ticket by itself; any AI on the brain (Claude,
// Codex) can claim it, plan it and open a PR; the owner merges it here. Backed by /api/tickets* and
// /api/prs* (lib/ticket-routes.mjs). Inlined into public/command-center.html after jobs-client.js.
// Plain browser JS. California time everywhere.
(function () {
  var PT = 'America/Los_Angeles';
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT'; };
  function ago(iso) {
    if (!iso) return ''; var s = (Date.now() - new Date(iso)) / 1000; if (isNaN(s)) return '';
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' });
  }
  function req(method, u, body) {
    return fetch(u, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.data = j; throw e; } return j; }); });
  }
  var STATUS = { open: ['Open', 'warn'], claimed: ['Claimed', 'run'], planned: ['Planned', 'run'], in_progress: ['In progress', 'run'], pr_open: ['PR open', 'run'], merged: ['Merged', 'ok'], resolved: ['Resolved', 'ok'], wont_fix: ['Won’t fix', 'dim'], duplicate: ['Duplicate', 'dim'] };
  var KINDS = { build_failed: 'Build failed', collector_failed: 'Collector failed', deploy_drift: 'Deploy drift', test_red: 'Tests red', data_quality: 'Data quality', pr_blocked: 'PR blocked', meeting_failed: 'Board meeting failed', self_update_failed: 'Self-update failed', approval_failed: 'Approval failed', assistant_failed: 'Assistant could not do it', proof_failed: 'Not proven after merge', other: 'Other' };
  var chip = function (s) { var x = STATUS[s] || [s, 'dim']; return '<span class="u-chip ' + x[1] + '">' + E(x[0]) + '</span>'; };
  // A run reference is "<run or build id>@<when it started>"; the time is shown in California time.
  function refText(ref) {
    var m = /^(.*)@(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)$/.exec(String(ref || ''));
    if (m) return (m[1] ? 'run ' + m[1] + ' · ' : '') + 'started ' + fmt(m[2]);
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(String(ref))) return 'checked ' + fmt(ref);
    return 'ref ' + ref;
  }
  var repoShort = function (r) { return r ? String(r).split('/').pop() : 'no repo'; };
  var F = { status: 'active', kind: '', repo: '' };
  var rows = [], summary = null, openId = null, loading = false;

  function setBadge(s) {
    var b = document.getElementById('nav-tickets-badge'); if (!b) return;
    var n = s && s.needsOwner ? s.needsOwner.length : 0;
    b.hidden = !n; b.textContent = n ? String(n) : '';
  }
  window.loadTicketsBadge = function () { req('GET', '/api/tickets/summary').then(setBadge).catch(function () {}); };

  function statsHtml(s) {
    if (!s) return '';
    var cell = function (v, l, sub, cls) { return '<div class="u-stat ' + (cls || '') + '"><div class="u-stat-v">' + E(v) + '</div><div class="u-stat-l">' + E(l) + '</div><div class="u-stat-s">' + E(sub) + '</div></div>'; };
    return '<div class="u-stats">'
      + cell(s.active || 0, 'Active tickets', 'opened by failures, not by you')
      + cell((s.needsOwner || []).length, 'Need you', 'blocked on you, or a PR ready to merge', (s.needsOwner || []).length ? 'warn' : '')
      + cell(s.unclaimed || 0, 'Waiting for an AI', (s.readyForAI || 0) + ' you asked an AI to fix')
      + cell(s.claimed || 0, 'Being worked on', 'claimed by an AI or the builder', 'accent')
      + '</div>';
  }
  function filtersHtml() {
    var sel = function (id, cur, opts) { return '<select id="' + id + '">' + opts.map(function (o) { return '<option value="' + E(o[0]) + '"' + (cur === o[0] ? ' selected' : '') + '>' + E(o[1]) + '</option>'; }).join('') + '</select>'; };
    var repos = [['', 'Every repo']]; rows.concat([]).forEach(function (t) { if (t.repo && !repos.some(function (r) { return r[0] === t.repo; })) repos.push([t.repo, t.repo]); });
    if (F.repo && !repos.some(function (r) { return r[0] === F.repo; })) repos.push([F.repo, F.repo]);
    return '<div class="u-tk-f">'
      + sel('tkf-status', F.status, [['active', 'Active'], ['open', 'Open'], ['claimed,planned,in_progress', 'Being worked on'], ['pr_open', 'PR open'], ['merged,resolved', 'Done'], ['wont_fix,duplicate', 'Closed without a fix'], ['all', 'Every ticket']])
      + sel('tkf-kind', F.kind, [['', 'Every kind']].concat(Object.keys(KINDS).map(function (k) { return [k, KINDS[k]]; })))
      + sel('tkf-repo', F.repo, repos)
      + '</div>';
  }
  function rowHtml(t) {
    var meta = [KINDS[t.kind] || t.kind, repoShort(t.repo), '×' + (t.count || 1), 'last ' + ago(t.lastSeen || t.updatedAt)].map(E).join(' · ');
    var chips = chip(t.status)
      + (t.blocked && ['open', 'claimed', 'planned', 'in_progress', 'pr_open'].indexOf(t.status) >= 0 ? '<span class="u-chip bad">Needs you</span>' : '')
      + (t.prState === 'ready' && t.status === 'pr_open' ? '<span class="u-chip ok">Ready to merge</span>' : '')
      + (t.requested === 'ai' && !t.claimant ? '<span class="u-chip warn">Ready for AI</span>' : '')
      + (t.tool ? '<span class="u-chip dim" title="About Seen Command itself — seenjobs.io tickets come first">Seen Command</span>' : '')
      + (t.claimant ? '<span class="u-chip dim" title="claimed ' + E(fmt(t.claimedAt)) + '">' + E(t.claimant) + (t.claimExpired ? ' · expired' : '') + '</span>' : '');
    return '<li class="u-row u-tk-row" data-id="' + E(t.id) + '"><div class="u-row-main"><b>' + E(t.title) + '</b><p>' + meta + '</p>'
      + (t.lastError ? '<p class="u-tk-err">' + E(t.lastError) + '</p>' : '')
      + (t.helped ? '<p class="u-tk-help"><span>Would have helped:</span> ' + E(t.helped) + '</p>' : '') + '</div><div class="u-tk-chips">' + chips + '</div></li>';
  }
  function renderList() {
    var el = document.getElementById('tickets-list'); if (!el) return;
    var st = document.getElementById('tickets-stats'); if (st) st.innerHTML = statsHtml(summary);
    if (loading && !rows.length) { el.innerHTML = '<div class="u-skeleton"><div></div><div></div></div>'; return; }
    if (!rows.length) { el.innerHTML = '<div class="u-empty ok">' + (F.status === 'active' ? 'No active tickets — nothing is failing that Seen Command knows about.' : 'No tickets match these filters.') + '</div>'; return; }
    el.innerHTML = '<ul class="u-list">' + rows.map(rowHtml).join('') + '</ul>';
    el.querySelectorAll('.u-tk-row').forEach(function (li) { li.onclick = function () { openTicket(li.getAttribute('data-id')); }; });
  }
  function qs() { var p = new URLSearchParams(); Object.keys(F).forEach(function (k) { if (F[k]) p.set(k, F[k]); }); return p.toString(); }
  var seq = 0;
  function load() {
    var mine = ++seq; loading = true; renderList();
    req('GET', '/api/tickets?' + qs()).then(function (d) {
      if (mine !== seq) return;
      loading = false; rows = d.tickets || []; summary = d.summary || null; setBadge(summary);
      var note = document.getElementById('tickets-note');
      if (note) note.innerHTML = d.vault === false ? '<div class="u-note warn">No brain vault is connected, so no tickets can be stored. Point CHRONOS_VAULT at the seen repo’s memory folder.</div>' : '';
      var fl = document.getElementById('tickets-filters'); if (fl) { fl.innerHTML = filtersHtml(); bindFilters(); }
      renderList();
    }).catch(function (e) { if (mine !== seq) return; loading = false; var el = document.getElementById('tickets-list'); if (el) el.innerHTML = '<div class="u-empty">Tickets could not load: ' + E(e.message) + '</div>'; });
  }
  function bindFilters() {
    ['status', 'kind', 'repo'].forEach(function (k) { var s = document.getElementById('tkf-' + k); if (s) s.onchange = function (e) { F[k] = e.target.value; load(); }; });
  }

  // ---- open pull requests on both repos ----
  function loadPRs() {
    var el = document.getElementById('tickets-prs'); if (!el) return;
    el.innerHTML = '<div class="u-skeleton"><div></div></div>';
    req('GET', '/api/prs').then(function (d) {
      var prs = (d.prs || []).filter(function (p) { return !p.error; }); var errs = (d.prs || []).filter(function (p) { return p.error; });
      var sameErr = errs.length > 1 && errs.every(function (p) { return p.error === errs[0].error; });
      el.innerHTML = (sameErr ? '<div class="u-note warn">' + E(errs[0].error) + '</div>' : errs.map(function (p) { return '<div class="u-note warn">' + E(p.repo) + ': ' + E(p.error) + '</div>'; }).join(''))
        + (prs.length ? '<ul class="u-list tight">' + prs.map(function (p) {
          return '<li class="u-row u-tk-row" data-repo="' + E(p.repo) + '" data-n="' + E(p.number) + '"><div class="u-row-main"><b>' + E(repoShort(p.repo)) + ' #' + E(p.number) + ' — ' + E(p.title) + '</b><p>' + E([p.head + ' → ' + p.base, p.author, 'updated ' + ago(p.updatedAt)].join(' · ')) + '</p></div>' + (p.draft ? '<span class="u-chip dim">Draft</span>' : '<span class="u-chip run">Open</span>') + '</li>';
        }).join('') + '</ul>' : (errs.length ? '' : '<div class="u-empty">No open pull requests on either repo.</div>'));
      el.querySelectorAll('.u-tk-row').forEach(function (li) { li.onclick = function () { openPR(li.getAttribute('data-repo'), li.getAttribute('data-n')); }; });
    }).catch(function (e) { el.innerHTML = '<div class="u-empty">' + E(e.message) + '</div>'; });
  }

  // ---- drawer ----
  function closeDrawer() { openId = null; var d = document.getElementById('tk-drawer'); if (d) d.remove(); }
  function drawer() {
    closeDrawer();
    var d = document.createElement('div'); d.id = 'tk-drawer'; d.className = 'u-drawer-wrap';
    d.innerHTML = '<div class="u-drawer-bg"></div><aside class="u-drawer u-tk"><div class="u-skeleton"><div></div><div></div></div></aside>';
    document.body.appendChild(d); d.querySelector('.u-drawer-bg').onclick = closeDrawer;
    return d.querySelector('.u-drawer');
  }
  function openTicket(id) {
    var a = drawer(); openId = id;
    req('GET', '/api/tickets/' + encodeURIComponent(id)).then(function (x) { if (openId === id) renderTicket(x); })
      .catch(function (e) { a.innerHTML = '<div class="u-empty">This ticket could not load: ' + E(e.message) + '</div>'; });
  }
  function msg(t, tone) { var m = document.getElementById('tk-msg'); if (m) m.innerHTML = t ? '<div class="u-note ' + (tone || '') + '">' + E(t) + '</div>' : ''; }
  function fixLabel(f) { return f.mode === 'rebuild' ? 'Ask Claude to fix (re-run the build)' : f.mode === 'builder' ? 'Ask Claude to fix' : f.mode === 'ready_for_ai' ? 'Ask an AI to fix' : 'Ask Claude to fix'; }
  function renderTicket(x) {
    var t = x.ticket, a = document.querySelector('#tk-drawer .u-drawer'); if (!a) return;
    var ev = t.evidence || {};
    var facts = [['Status', (STATUS[t.status] || [t.status])[0]], ['Kind', KINDS[t.kind] || t.kind], ['Repo', t.repo || '—'], ['About', t.tool ? 'Seen Command itself (seenjobs.io work comes first)' : 'seenjobs.io'], ['Failed', (t.count || 1) + ' time' + ((t.count || 1) === 1 ? '' : 's')],
      ['First seen', fmt(t.firstSeen)], ['Last seen', fmt(t.lastSeen)], ['Blocked on you', t.blocked ? 'Yes — retrying cannot fix it' : 'No'],
      ['Claimed by', t.claimant ? t.claimant + ' · ' + fmt(t.claimedAt) : 'Nobody yet'], ['Claim expires', t.claimExpiresAt ? fmt(t.claimExpiresAt) + (t.claimExpired ? ' (expired — anyone can take it)' : '') : ''],
      ['Asked for', t.requested === 'ai' ? 'Any AI on the brain' : t.requested === 'builder' ? 'The builder' : ''], ['Build', t.buildId || ''],
      ['Duplicate of', t.duplicateOf || ''], ['Failed again after', t.regressionOf || ''], ['Resolution', t.resolution || '']];
    var f = x.fix || { mode: 'none' };
    var active = !t.terminal;
    a.innerHTML = '<header class="u-drawer-h"><div><h2>' + E(t.title) + '</h2><p class="u-muted">' + E(t.id) + ' · ' + E(t.thing || '') + '</p></div><button class="u-btn ghost sm" id="tk-x" aria-label="Close">✕</button></header>'
      + '<div class="u-actions u-tk-wrap">' + chip(t.status) + (t.blocked && active ? '<span class="u-chip bad">Needs you</span>' : '') + (t.prState === 'ready' && t.status === 'pr_open' ? '<span class="u-chip ok">Ready to merge</span>' : '') + (t.requested === 'ai' && !t.claimant ? '<span class="u-chip warn">Ready for AI</span>' : '') + '</div>'
      + '<div class="u-actions u-tk-wrap">'
      + (active ? '<button class="u-btn sm primary" id="tk-fix"' + (f.mode === 'none' ? ' disabled title="' + E(f.why || '') + '"' : '') + '>' + E(fixLabel(f)) + '</button>' : '')
      + (active ? '<button class="u-btn sm" id="tk-wont">Won’t fix</button><button class="u-btn sm" id="tk-dup">Duplicate of…</button>' : '')
      + (t.terminal && t.status !== 'merged' ? '<button class="u-btn sm" id="tk-reopen">Reopen</button>' : '')
      + (active && t.claimant ? '<button class="u-btn sm ghost" id="tk-release">Release the claim</button>' : '')
      + '<button class="u-btn sm ghost" id="tk-note">Add a note</button></div>'
      + (active && f.mode === 'none' && f.why ? '<p class="u-muted sm">' + E(f.why) + '</p>' : '')
      + '<div id="tk-msg"></div><div id="tk-form"></div>'
      + (t.prUrl ? '<div class="u-sub">Pull request</div><div id="tk-pr" class="u-card u-tk-pr"><div class="u-skeleton"><div></div></div></div>' : '')
      + '<dl class="u-facts">' + facts.filter(function (r) { return r[1] !== '' && r[1] != null; }).map(function (r) { return '<dt>' + E(r[0]) + '</dt><dd>' + E(r[1]) + '</dd>'; }).join('') + '</dl>'
      + (t.helped ? '<div class="u-sub">What would have helped</div><p class="u-tk-helped">' + E(t.helped) + '</p>' : '')
      + (t.plan ? '<div class="u-sub">Plan</div><pre class="u-tk-pre">' + E(t.plan) + '</pre>' : '')
      + (t.note ? '<div class="u-sub">Latest note</div><p>' + E(t.note) + '</p>' : '')
      + '<div class="u-sub">Evidence — occurrence ' + E(ev.n || 1) + ', ' + E(fmt(ev.at)) + '</div>'
      + (ev.error ? '<pre class="u-tk-pre bad">' + E(ev.error) + '</pre>' : '<p class="u-muted">No error text was recorded.</p>')
      + (ev.log ? '<div class="u-sub">Log excerpt</div><pre class="u-tk-pre">' + E(ev.log) + '</pre>' : '')
      + '<p class="u-muted sm">' + [ev.ref ? E(refText(ev.ref)) : '', ev.source ? 'from ' + E(ev.source) : ''].filter(Boolean).join(' · ') + '</p>'
      + ((ev.links || []).length ? '<p class="sm">' + ev.links.map(function (l) { return '<a href="' + E(l) + '" target="_blank" rel="noopener">' + E(l.replace(/^https:\/\/github\.com\//, '')) + ' ↗</a>'; }).join(' · ') + '</p>' : '')
      + ((t.occurrences || []).length > 1 ? '<div class="u-sub">Earlier occurrences</div><ul class="u-list tight">' + t.occurrences.slice(0, -1).reverse().slice(0, 8).map(function (o) { return '<li class="u-row"><div class="u-row-main"><b>#' + E(o.n) + ' · ' + E(fmt(o.at)) + '</b><p>' + E(o.error) + '</p></div></li>'; }).join('') + '</ul>' : '')
      + '<div class="u-sub">History</div><ul class="u-list tight u-tk-hist">' + (t.history || []).slice().reverse().map(function (h) {
        return '<li class="u-row"><div class="u-row-main"><b>' + E(h.change || Object.keys(h.fields || {}).join(', ')) + '</b><p>' + E(fmt(h.at)) + (h.by ? ' · ' + E(h.by) : '') + '</p></div>' + (h.fields && h.fields.status ? chip(h.fields.status) : '') + '</li>';
      }).join('') + '</ul>'
      + '<p class="u-muted sm">Stored in the brain as ' + E('tickets/' + t.id + '.md') + ' — every change supersedes, never overwrites. Any AI on the brain can read it with brain_get_ticket.</p>';
    document.getElementById('tk-x').onclick = closeDrawer;
    var after = function (text) { return function (r) { msg(text, 'ok'); load(); req('GET', '/api/tickets/' + encodeURIComponent(t.id)).then(function (y) { if (openId === t.id) { renderTicket(y); msg(text, 'ok'); } }); return r; }; };
    var fail = function (b) { return function (e) { if (b) b.disabled = false; msg(e.message, 'bad'); }; };
    var post = function (verb, body, text, b) { if (b) b.disabled = true; return req('POST', '/api/tickets/' + encodeURIComponent(t.id) + '/' + verb, body || {}).then(after(text)).catch(fail(b)); };
    var form = function (html, onSave) {
      var el = document.getElementById('tk-form'); el.innerHTML = '<div class="u-form u-tk-form">' + html + '</div><div class="u-actions end"><button class="u-btn ghost sm" id="tkf-cancel">Cancel</button><button class="u-btn primary sm" id="tkf-save">Save</button></div>';
      document.getElementById('tkf-cancel').onclick = function () { el.innerHTML = ''; };
      document.getElementById('tkf-save').onclick = function () { onSave(document.getElementById('tkf-save')); };
    };
    var fix = document.getElementById('tk-fix');
    if (fix) fix.onclick = function () {
      var what = f.mode === 'ready_for_ai' ? 'Mark this ticket ready for any AI on the brain (Claude, Codex) to claim and fix?' : 'Send this ticket to the builder? It codes a fix on ' + (f.repo === 'product' ? 'the Seen repo' : 'the Seen Command repo') + ', runs the tests, and opens a PR for you to merge.';
      if (!window.confirm(what)) return;
      post('fix', {}, f.mode === 'ready_for_ai' ? 'Marked ready for an AI. It shows first in brain_list_tickets.' : 'Sent to the builder. The ticket moves to PR open when its PR is ready.', fix);
    };
    var wont = document.getElementById('tk-wont');
    if (wont) wont.onclick = function () { form('<label class="wide"><span>Why won’t this be fixed? (kept on the ticket)</span><textarea id="tkf-reason" rows="3"></textarea></label>', function (b) { post('wont-fix', { reason: document.getElementById('tkf-reason').value.trim() }, 'Closed as won’t fix.', b); }); };
    var dup = document.getElementById('tk-dup');
    if (dup) dup.onclick = function () {
      var others = rows.filter(function (r) { return r.id !== t.id; });
      form('<label class="wide"><span>Duplicate of</span>' + (others.length ? '<select id="tkf-of">' + others.map(function (r) { return '<option value="' + E(r.id) + '">' + E(r.id + ' — ' + r.title) + '</option>'; }).join('') + '</select>' : '<input id="tkf-of" placeholder="tkt-…">') + '</label>',
        function (b) { post('duplicate', { of: document.getElementById('tkf-of').value.trim() }, 'Marked as a duplicate.', b); });
    };
    var reopen = document.getElementById('tk-reopen'); if (reopen) reopen.onclick = function () { post('open', {}, 'Reopened.', reopen); };
    var rel = document.getElementById('tk-release'); if (rel) rel.onclick = function () { if (window.confirm('Release ' + t.claimant + '’s claim? The ticket goes back to open for anyone.')) post('open', { reason: 'Claim released by the owner' }, 'Claim released.', rel); };
    document.getElementById('tk-note').onclick = function () { form('<label class="wide"><span>Note (any AI picking this up will read it)</span><textarea id="tkf-text" rows="3"></textarea></label>', function (b) { post('note', { text: document.getElementById('tkf-text').value }, 'Note added.', b); }); };
    if (t.prUrl && x.pr) loadPrPanel(x.pr.repo, x.pr.number, document.getElementById('tk-pr'), t.id);
  }

  // ---- one PR: checks, mergeability, Merge ----
  function openPR(repo, n) {
    var a = drawer(); openId = 'pr:' + repo + '#' + n;
    a.innerHTML = '<header class="u-drawer-h"><div><h2>' + E(repoShort(repo)) + ' #' + E(n) + '</h2><p class="u-muted">' + E(repo) + '</p></div><button class="u-btn ghost sm" id="tk-x" aria-label="Close">✕</button></header><div id="tk-msg"></div><div id="tk-pr" class="u-card u-tk-pr"></div>';
    document.getElementById('tk-x').onclick = closeDrawer;
    loadPrPanel(repo, n, document.getElementById('tk-pr'), null);
  }
  function checkChip(r) { var c = r.status !== 'completed' ? ['running', 'run'] : (['success', 'neutral', 'skipped'].indexOf(r.conclusion) >= 0 ? [r.conclusion, 'ok'] : [r.conclusion || 'failed', 'bad']); return '<span class="u-chip ' + c[1] + '">' + E(c[0]) + '</span>'; }
  function loadPrPanel(repo, n, el, ticketId) {
    if (!el) return;
    el.innerHTML = '<div class="u-skeleton"><div></div></div>';
    var parts = String(repo).split('/');
    var base = '/api/prs/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) + '/' + encodeURIComponent(n);
    req('GET', base).then(function (s) {
      var pr = s.pr || {};
      var stateChip = pr.merged ? '<span class="u-chip ok">Merged</span>' : pr.state !== 'open' ? '<span class="u-chip dim">Closed</span>' : s.canMerge ? '<span class="u-chip ok">Ready to merge</span>' : '<span class="u-chip warn">Not mergeable yet</span>';
      var checks = (s.runs || []).map(function (r) { return '<li class="u-row"><div class="u-row-main"><b>' + (r.url ? '<a href="' + E(r.url) + '" target="_blank" rel="noopener">' + E(r.name) + '</a>' : E(r.name)) + '</b></div>' + checkChip(r) + '</li>'; })
        .concat(((s.combined && s.combined.statuses) || []).map(function (x) { return '<li class="u-row"><div class="u-row-main"><b>' + E(x.name) + '</b></div><span class="u-chip ' + (x.state === 'success' ? 'ok' : x.state === 'pending' ? 'run' : 'bad') + '">' + E(x.state) + '</span></li>'; }));
      var dep = s.deploy ? '<div class="u-sub">Production deploy</div><p class="sm">' + (s.deploy.deployment && s.deploy.deployment.state ? E('Vercel: ' + s.deploy.deployment.state + (s.deploy.deployment.sha ? ' · ' + s.deploy.deployment.sha : '') + (s.deploy.deployment.createdAt ? ' · ' + fmt(s.deploy.deployment.createdAt) : '')) : s.deploy.deployment && s.deploy.deployment.configured === false ? 'Vercel is not connected here, so the deploy cannot be checked from Seen Command.' : E('No production deployment found yet for ' + (s.deploy.sha || 'the merge commit') + ' — if this stays empty, the merge did not deploy.')) + '</p>' + (s.deploy.drift ? '<p class="u-muted sm">Deploy monitor: ' + E(s.deploy.drift) + '</p>' : '') : '';
      el.innerHTML = '<div class="u-tk-prh"><div class="u-row-main"><b><a href="' + E(pr.url) + '" target="_blank" rel="noopener">' + E(pr.title || ('#' + n)) + ' ↗</a></b><p>' + E(repo + ' #' + n + ' · ' + (pr.head || '') + ' → ' + (pr.base || '') + (pr.author ? ' · ' + pr.author : '') + (pr.headSha ? ' · ' + String(pr.headSha).slice(0, 7) : '')) + '</p></div>' + stateChip + '</div>'
        + (checks.length ? '<ul class="u-list tight">' + checks.join('') + '</ul>' : '<p class="u-muted sm">No checks have reported on this commit.</p>')
        + (!pr.merged && pr.state === 'open' && (s.reasons || []).length ? '<div class="u-note warn">Merge is off: ' + E(s.reasons.join('; ')) + '</div>' : '')
        + (pr.mergedAt ? '<p class="sm">Merged ' + E(fmt(pr.mergedAt)) + (pr.mergeSha ? ' as ' + E(String(pr.mergeSha).slice(0, 8)) : '') + '</p>' : '')
        + dep
        + (!pr.merged && pr.state === 'open' ? '<div class="u-actions end"><button class="u-btn ghost sm" id="pr-refresh">Check again</button><button class="u-btn primary sm" id="pr-merge"' + (s.canMerge ? '' : ' disabled') + '>Squash and merge</button></div>' : '');
      var rf = document.getElementById('pr-refresh'); if (rf) rf.onclick = function () { loadPrPanel(repo, n, el, ticketId); };
      var mb = document.getElementById('pr-merge');
      if (mb && s.canMerge) mb.onclick = function () {
        var to = pr.base + (repo.toLowerCase() === 'begindtheseen/seen' && pr.base === 'next-migration' ? ' — this deploys seenjobs.io' : '');
        if (!window.confirm('Squash-merge ' + repo + ' #' + n + ' “' + pr.title + '” into ' + to + '?\n\nOnly commit ' + String(pr.headSha).slice(0, 7) + ' (what you see here) will be merged.')) return;
        mb.disabled = true;
        req('POST', base + '/merge', { confirm: true, expectedHeadSha: pr.headSha, ticketId: ticketId }).then(function (r) {
          msg('Merged as ' + String(r.sha || '').slice(0, 8) + '.' + (r.deploy && r.deploy.note ? ' ' + r.deploy.note : '') + (r.tickets && r.tickets.length ? ' Ticket ' + r.tickets.join(', ') + ' is now merged.' : ''), 'ok');
          load(); loadPRs(); loadPrPanel(repo, n, el, ticketId);
        }).catch(function (e) { mb.disabled = false; msg(e.message, 'bad'); });
      };
    }).catch(function (e) { el.innerHTML = '<div class="u-empty">' + E(e.message) + '</div>'; });
  }

  window.loadTickets = function () {
    var root = document.getElementById('tickets-view'); if (!root) return;
    if (!document.getElementById('tickets-list')) {
      root.innerHTML = '<div class="u-head"><div><h1>Tickets</h1><p class="u-muted">Failures Seen Command turned into work — by itself. Any AI on the brain (Claude, Codex) can claim one, plan the fix and open a PR; you merge it here.</p></div>'
        + '<div class="u-head-actions"><button class="u-btn" id="tickets-refresh">Refresh</button></div></div>'
        + '<div id="tickets-note"></div><div id="tickets-stats"></div><div id="tickets-filters">' + filtersHtml() + '</div><div id="tickets-list"></div>'
        + '<h2 class="u-h2">Open pull requests</h2><p class="u-muted sm">Both repos. Open one to see its checks; Merge is on only when every check is green and GitHub calls it mergeable.</p><div id="tickets-prs"></div>';
      bindFilters();
      document.getElementById('tickets-refresh').onclick = function () { load(); loadPRs(); };
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.getElementById('tk-drawer')) closeDrawer(); });
    }
    load(); loadPRs();
  };
  window.openTicket = openTicket;
  window.openTickets = function (filters) { F = Object.assign({ status: 'active', kind: '', repo: '' }, filters || {}); var root = document.getElementById('tickets-view'); if (root) root.innerHTML = ''; if (window.showTab) window.showTab('tickets'); else window.loadTickets(); };
  setTimeout(window.loadTicketsBadge, 1500);
})();
