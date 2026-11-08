// Growth Studio — the marketing team for seenjobs.io, in one tab: this week vs the plan to 1,000 users
// (REAL admin-stats numbers), today's 1% item, the content calendar with trust-checked copy, the zero-cost
// ad designer (lib/ui/growth-design.js), the brand kit, positioning, creator assets and the paid plan.
// Backed by /api/growth/* (lib/growth/routes.mjs). Plain browser JS, inlined into the dashboard after
// growth-design.js. California time everywhere; calendar days are Pacific days.
(function () {
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  var money = function (n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
  var dayL = function (d, wd) { var x = new Date(d + 'T12:00:00Z'); return isNaN(x) ? d : x.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: wd ? 'short' : undefined, month: 'short', day: 'numeric' }); };
  var timeL = function (t) { var p = String(t || '').split(':'); var h = +p[0], m = p[1] || '00'; return (h % 12 || 12) + ':' + m + (h < 12 ? ' AM' : ' PM') + ' PT'; };
  var addDay = function (d, n) { var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function req(method, u, body) {
    return fetch(u, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  var STATUS_CHIP = { 'ahead': 'ok', 'on-track': 'ok', 'behind': 'warn', 'off-track': 'bad', 'unknown': 'dim', 'unmeasured': 'dim', 'not-yet': 'dim', hit: 'ok', missed: 'bad', upcoming: 'run', 'needs-measurement': 'warn', idea: 'dim', drafted: 'run', approved: 'ok', scheduled: 'run', posted: 'ok', measured: 'ok', done: 'ok', open: 'run', skipped: 'dim' };
  var chip = function (st, label) { return '<span class="u-chip ' + (STATUS_CHIP[st] || 'dim') + '">' + E(label || st) + '</span>'; };
  var ruleChip = function (r) { if (!r) return ''; var id = r.id || r; var t = r.name ? r.name + (r.rationale ? ' — ' + r.rationale : '') + (r.source ? ' (Source: ' + r.source + ')' : '') : id; return '<span class="g-rule" title="' + E(t) + '">' + E(r.name || id) + '</span>'; };
  var CH = { reddit: 'Reddit', linkedin: 'LinkedIn', 'short-video': 'Short video', x: 'X', creators: 'Creators', email: 'Email', landing: 'Landing', ad: 'Ad (plan)', dm: 'DMs' };
  var NEXT = { idea: 'drafted', drafted: 'approved', approved: 'scheduled', scheduled: 'posted' };

  var S = { view: 'week', weekFrom: null, data: null, drawer: null, design: { template: 'data-callout', size: 'square', src: 'agency:0', fields: {} } };
  var root = function () { return document.getElementById('growth-view'); };
  var TABS = [['week', 'This week'], ['plan', 'Plan to 1,000'], ['calendar', 'Calendar'], ['designer', 'Ad designer'], ['brand', 'Brand'], ['positioning', 'Positioning'], ['creators', 'Creators'], ['paid', 'Paid plan']];
  function shell(inner) {
    return '<div class="u-head"><div><h1>Growth</h1><p class="u-muted sm">The marketing team for seenjobs.io — the plan to 1,000 users, checked every week against real numbers. Trust first: no invented numbers, ever.</p></div></div>'
      + '<div class="g-tabs">' + TABS.map(function (t) { return '<button class="g-tab' + (S.view === t[0] ? ' on' : '') + '" data-gv="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>'
      + '<div id="g-body">' + inner + '</div>';
  }
  function paint(inner) { var el = root(); if (!el) return; el.innerHTML = shell(inner); el.querySelectorAll('[data-gv]').forEach(function (b) { b.onclick = function () { S.view = b.getAttribute('data-gv'); window.loadGrowth(); }; }); }
  var loading = function () { return '<div class="u-skeleton"><div></div><div></div><div></div></div>'; };
  var fail = function (e) { return '<div class="u-note warn">' + E(e.message || e) + '</div>'; };

  // ---- This week -------------------------------------------------------------------------------------
  function statTile(label, actual, target, st, sub) {
    return '<div class="u-stat ' + (st === 'behind' || st === 'off-track' ? 'warn' : '') + '"><div class="u-stat-v">' + actual + '</div><div class="u-stat-l">' + E(label) + ' ' + chip(st) + '</div><div class="u-stat-s">' + (target != null ? 'goal ' + target : '') + (sub ? ' · ' + E(sub) : '') + '</div></div>';
  }
  function weekView(j) {
    var c = j.check, a = c.actuals || {}, t = c.target; var d = j.daily.item, st = j.daily.streak;
    var head = '<div class="u-card g-hero"><header><h3>Week ' + c.week + ' of ' + j.plan.weeks + ' · ' + E(c.phase.name) + '</h3>' + chip(c.overall, c.overall.toUpperCase()) + '</header>'
      + '<p class="u-lead">' + E(c.phase.goal) + '</p>'
      + (j.statsError ? '<div class="u-note warn">' + E(j.statsError) + ' — targets are shown, actuals are unknown (never guessed).</div>' : '')
      + (a.degraded ? '<div class="u-note warn">Seen reported failed queries in admin-stats — nothing is judged on numbers that may be zeros from errors.</div>' : '')
      + '<div class="g-stats">' + statTile('Users', num(a.users), num(t.users), c.status.users, a.newThisWeek != null ? '+' + a.newThisWeek + ' this week' : '') + statTile('Paying (30 days)', num(a.paid), num(t.paidUsers), c.status.paid)
      + statTile('Revenue (30 days)', money(a.revenue), money(t.revenue), c.status.revenue, a.prepPurchases != null ? a.prepPurchases + ' Prep · ' + (a.passPurchases || 0) + ' Pass' : '') + statTile('Activation', a.activation == null ? '—' : Math.round(a.activation * 100) + '%', Math.round(t.activationGoal * 100) + '%', c.status.activation, a.activation == null ? 'not measured yet' : '') + '</div></div>';
    var changes = '<div class="u-card"><header><h3>What to change this week</h3></header><ul class="u-list">' + c.changes.map(function (x) { return '<li class="u-row"><div class="u-row-main"><b>' + E(x.what) + '</b><p>' + E(x.why) + '</p></div>' + ruleChip({ id: x.rule, name: x.ruleName || x.rule, rationale: x.why, source: '' }) + '</li>'; }).join('') + '</ul></div>';
    var gates = '<div class="u-card"><header><h3>Dated gates</h3><span class="u-muted sm">kill / scale decisions</span></header><ul class="u-list tight">' + c.gates.slice(0, 9).map(function (g) { return '<li class="u-row"><div class="u-row-main"><b>' + E(g.id.startsWith('users') ? g.name : g.id + ' · ' + g.name) + '</b><p>' + E(g.number) + ' · by ' + dayL(g.date) + (g.state === 'upcoming' ? ' (' + g.daysLeft + ' days)' : '') + (g.note ? ' — ' + E(g.note) : '') + '</p></div>' + chip(g.state) + '</li>'; }).join('') + '</ul></div>';
    var daily = '<div class="u-card g-daily"><header><h3>Today\'s 1% · ' + E(d.laneName) + '</h3>' + chip(d.status) + '</header><b class="g-daily-t">' + E(d.title) + '</b><p class="u-muted">' + E(d.detail) + '</p>'
      + '<p class="u-muted sm">~' + E(d.minutes) + ' min · ' + (d.who === 'app' ? 'the app drafts it, you approve' : d.who === 'agent' ? 'a small task for the coding agent' : 'you') + ' · moves: ' + E(d.moves) + ' · ' + ruleChip(d.laneRule) + '</p>'
      + '<div class="u-actions"><button class="u-btn primary sm" data-daily="done"' + (d.status === 'done' ? ' disabled' : '') + '>Done</button><button class="u-btn ghost sm" data-daily="skipped">Skip today</button></div>'
      + '<div class="g-streak"><span><b>' + st.current + '</b> day streak</span><span>best ' + st.best + '</span><span>' + st.doneThisWeek + '/7 this week</span><span title="1.01 to the power of the streak">+' + st.compounding + '% compounded</span></div></div>';
    return '<div class="u-grid"><div>' + head + changes + '</div><div>' + daily + gates + '</div></div><h2 class="u-h2">This week</h2>' + weekStrip(j.calendar);
  }
  function weekStrip(cal) {
    if (!cal.days.some(function (d) { return d.items.length; })) return '<div class="u-empty">No calendar yet. <button class="u-btn sm" data-gen="1">Generate 6 weeks</button></div>';
    return (cal.violations.length ? '<div class="u-note warn">' + cal.violations.map(function (v) { return E(v.problem); }).join(' · ') + '</div>' : '') + '<div class="g-week">' + cal.days.map(function (d) {
      return '<div class="g-day"><div class="g-day-h"><b>' + dayL(d.date, true) + '</b></div>'
        + '<div class="g-1pct ' + (d.daily.status === 'done' ? 'done' : '') + '" title="1% lane">1% · ' + E(d.daily.title || d.daily.lane) + '</div>'
        + d.items.map(function (i) { return '<button class="g-item ch-' + E(i.channel) + '" data-item="' + E(i.id) + '"><span>' + timeL(i.time).replace(' PT', '') + ' · ' + E(CH[i.channel] || i.channel) + '</span><b>' + E(i.hook) + '</b>' + chip(i.status) + (i.owner === 'brandon' ? '<em>you</em>' : '<em>app drafts</em>') + '</button>'; }).join('') + '</div>';
    }).join('') + '</div>';
  }
  function bindCommon() {
    var el = root(); if (!el) return;
    el.querySelectorAll('[data-item]').forEach(function (b) { b.onclick = function () { openItem(b.getAttribute('data-item')); }; });
    el.querySelectorAll('[data-gen]').forEach(function (b) { b.onclick = function () { b.disabled = true; b.textContent = 'Generating…'; req('POST', '/api/growth/calendar/generate', { weeks: 6, from: S.weekFrom || undefined }).then(function () { window.loadGrowth(); }).catch(function (e) { b.textContent = e.message; }); }; });
    el.querySelectorAll('[data-daily]').forEach(function (b) { b.onclick = function () { b.disabled = true; req('POST', '/api/growth/daily', { status: b.getAttribute('data-daily') }).then(function () { window.loadGrowth(); }).catch(function (e) { b.textContent = e.message; }); }; });
  }

  // ---- calendar item drawer: details, status, drafts, approvals, results --------------------------------
  function closeDrawer() { var w = document.getElementById('g-drawer'); if (w) w.remove(); S.drawer = null; }
  function drawer(html) { closeDrawer(); var w = document.createElement('div'); w.className = 'u-drawer-wrap'; w.id = 'g-drawer'; w.innerHTML = '<div class="u-drawer-bg"></div><aside class="u-drawer">' + html + '</aside>'; document.body.appendChild(w); w.querySelector('.u-drawer-bg').onclick = closeDrawer; var x = w.querySelector('[data-close]'); if (x) x.onclick = closeDrawer; return w; }
  function variantHtml(v, i, approved) {
    var body = '';
    if (v.title) body += '<div class="g-v-title">' + E(v.title) + '</div>';
    if (v.body) body += '<div class="g-v-body">' + E(v.body) + '</div>';
    if (v.parts) {
      var p = v.parts;
      if (p.posts) body += p.posts.map(function (x, k) { return '<div class="g-v-body"><span class="u-muted sm">' + (k + 1) + '/' + p.posts.length + ' · ' + x.length + ' chars</span>\n' + E(x) + '</div>'; }).join('');
      else if (p.beats) body += '<div class="g-v-body"><b>Hook (0–2 s):</b> ' + E(p.hook) + '\n' + p.beats.map(function (b, k) { return (k + 1) + '. ' + E(b); }).join('\n') + '\n<b>CTA:</b> ' + E(p.cta) + '\n<b>On screen:</b> ' + E(p.onScreen) + '\n<b>Caption:</b> ' + E(p.caption) + '</div>';
      else body += '<div class="g-v-body">' + Object.keys(p).map(function (k) { return '<b>' + E(k) + ':</b> ' + E(p[k]); }).join('\n') + '</div>';
    }
    var tr = v.trust || {}; var flags = (tr.flags || []);
    return '<div class="g-variant' + (approved ? ' approved' : '') + '"><header><b>' + (i + 1) + ' · ' + E(v.style) + '</b>' + (tr.ok ? chip('ok', 'trust checklist passed') : chip('missed', 'fails trust')) + (approved ? chip('approved', 'approved') : '') + '</header>' + body
      + '<p class="u-muted sm"><b>Why this works:</b> ' + E(v.why) + ' ' + ruleChip({ id: v.rule, name: v.ruleName || v.rule, rationale: v.ruleWhy, source: '' }) + '</p>'
      + (flags.length ? '<ul class="g-flags">' + flags.map(function (f) { return '<li class="' + E(f.severity) + '"><b>' + E(f.id) + '</b> ' + E(f.text) + ' — ' + E(f.fix) + '</li>'; }).join('') + '</ul>' : '')
      + (v.formatProblems && v.formatProblems.length ? '<div class="u-note warn">' + E(v.formatProblems.join(' · ')) + '</div>' : '')
      + '<details class="g-check"><summary>Trust checklist</summary><ul>' + (tr.checklist || []).map(function (c) { return '<li class="' + (c.pass ? 'pass' : 'fail') + '">' + (c.pass ? '✓' : '✕') + ' ' + E(c.label) + (c.fixed ? ' <span class="u-muted sm">(fixed)</span>' : '') + '</li>'; }).join('') + '</ul></details>'
      + '<div class="u-actions"><button class="u-btn sm" data-copy="' + i + '">Copy text</button>' + (approved ? '' : '<button class="u-btn primary sm" data-approve="' + i + '"' + (tr.ok ? '' : ' disabled') + '>Approve this one</button>') + '</div></div>';
  }
  function variantText(v) { var p = v.parts || {}; return [v.title, v.body, p.subject, p.preheader, p.headline, p.sub, p.primary, p.description, p.hook, (p.beats || []).join('\n'), p.cta, p.caption, (p.posts || []).join('\n\n')].filter(Boolean).join('\n\n'); }
  function openItem(id) {
    drawer('<div class="u-drawer-h"><h2>Loading…</h2><button class="u-btn ghost" data-close>✕</button></div>');
    req('GET', '/api/growth/copy/' + encodeURIComponent(id)).then(function (j) { renderItem(j.item, j.draft); }).catch(function (e) { drawer('<div class="u-drawer-h"><h2>Calendar item</h2><button class="u-btn ghost" data-close>✕</button></div>' + fail(e)); });
  }
  function renderItem(it, draft) {
    var next = NEXT[it.status];
    var res = it.results ? '<dl class="u-facts">' + Object.keys(it.results).filter(function (k) { return k !== 'recordedAt'; }).map(function (k) { return '<dt>' + E(k) + '</dt><dd>' + E(it.results[k]) + '</dd>'; }).join('') + '</dl>' : '';
    var w = drawer('<div class="u-drawer-h"><h2>' + E(it.hook) + '</h2><button class="u-btn ghost" data-close>✕</button></div>'
      + '<p>' + chip(it.status) + ' ' + E(CH[it.channel] || it.channel) + (it.subreddit ? ' · ' + E(it.subreddit) : '') + ' · ' + E(it.format) + ' · ' + dayL(it.date, true) + ', ' + timeL(it.time) + ' · ' + ruleChip(it.ruleInfo) + '</p>'
      + '<dl class="u-facts"><dt>Goal</dt><dd>' + E(it.goal) + '</dd><dt>Who</dt><dd>' + (it.owner === 'brandon' ? 'You: ' + E(it.ownerAction) : 'The app drafts it; you: ' + E(it.ownerAction)) + '</dd><dt>Pillar</dt><dd>' + E(it.pillar) + '</dd>'
      + (it.evidence ? '<dt>Evidence</dt><dd>' + E(it.evidence.line) + ' — <a href="' + E(it.evidence.url) + '" target="_blank" rel="noopener">source</a> (' + E(it.evidence.source) + ')</dd>' : '<dt>Evidence</dt><dd class="u-muted">none — this item carries no numbers</dd>') + '</dl>'
      + '<div class="u-sub">Platform rules</div><ul class="g-rules">' + (it.platformRules || []).map(function (r) { return '<li>' + E(r) + '</li>'; }).join('') + (it.subredditNote ? '<li><b>' + E(it.subreddit) + ':</b> ' + E(it.subredditNote) + '</li>' : '') + '</ul>'
      + '<div class="u-actions">' + '<button class="u-btn primary" id="g-draft">' + (draft ? 'Redraft 3 variants' : 'Draft 3 variants') + '</button>' + (next ? '<button class="u-btn" id="g-next">Mark ' + next + '</button>' : '') + '<button class="u-btn ghost" id="g-design">Design it →</button><button class="u-btn ghost" id="g-reset">Reset to idea</button></div>'
      + (['posted', 'measured'].indexOf(it.status) >= 0 ? '<div class="u-sub">Results (what the platform shows)</div>' + res + '<div class="u-form" id="g-res">' + ['impressions', 'views', 'sessions', 'upvotes', 'comments', 'signups', 'reports'].map(function (k) { return '<label>' + k + '<input type="number" min="0" name="' + k + '" value="' + E(it.results && it.results[k] != null ? it.results[k] : '') + '"></label>'; }).join('') + '<label class="wide">notes<textarea name="notes" rows="2">' + E(it.results && it.results.notes || '') + '</textarea></label></div><div class="u-actions"><button class="u-btn" id="g-save-res">Save results</button></div>' : '')
      + '<div id="g-drafts">' + (draft ? '<div class="u-sub">Drafts · ' + E(draft.engine === 'templates' ? 'written from the brand kit (no model lane)' : 'polished by ' + draft.engine) + '</div>' + draft.variants.map(function (v, i) { return variantHtml(v, i, draft.approved === i); }).join('') : '<p class="u-muted sm">No drafts yet.</p>') + '</div>');
    var msg = function (t) { var d = w.querySelector('#g-drafts'); d.insertAdjacentHTML('afterbegin', '<div class="u-note warn">' + E(t) + '</div>'); };
    w.querySelector('#g-draft').onclick = function () { var b = this; b.disabled = true; b.textContent = 'Drafting…'; req('POST', '/api/growth/copy/' + encodeURIComponent(it.id) + '/draft', {}).then(function () { openItem(it.id); }).catch(function (e) { b.disabled = false; b.textContent = 'Draft 3 variants'; msg(e.message); }); };
    if (w.querySelector('#g-next')) w.querySelector('#g-next').onclick = function () { req('POST', '/api/growth/calendar/' + encodeURIComponent(it.id) + '/status', { status: next }).then(function () { openItem(it.id); window.loadGrowth(true); }).catch(function (e) { msg(e.message); }); };
    w.querySelector('#g-reset').onclick = function () { req('POST', '/api/growth/calendar/' + encodeURIComponent(it.id) + '/status', { status: 'idea' }).then(function () { openItem(it.id); window.loadGrowth(true); }).catch(function (e) { msg(e.message); }); };
    w.querySelector('#g-design').onclick = function () { closeDrawer(); S.view = 'designer'; S.design.item = it; S.design.src = it.evidence ? 'item' : 'brand'; S.design.template = it.evidence ? 'data-callout' : 'cta-banner'; S.design.fields = {}; window.loadGrowth(); };
    var sv = w.querySelector('#g-save-res'); if (sv) sv.onclick = function () { var b = {}; w.querySelectorAll('#g-res input, #g-res textarea').forEach(function (x) { if (x.value !== '') b[x.name] = x.value; }); req('POST', '/api/growth/calendar/' + encodeURIComponent(it.id) + '/results', b).then(function () { openItem(it.id); window.loadGrowth(true); }).catch(function (e) { msg(e.message); }); };
    w.querySelectorAll('[data-approve]').forEach(function (b) { b.onclick = function () { b.disabled = true; req('POST', '/api/growth/copy/' + encodeURIComponent(it.id) + '/approve', { variant: Number(b.getAttribute('data-approve')) }).then(function () { openItem(it.id); window.loadGrowth(true); }).catch(function (e) { b.disabled = false; msg(e.message); }); }; });
    w.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { var v = draft.variants[Number(b.getAttribute('data-copy'))]; try { navigator.clipboard.writeText(variantText(v)); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Copy failed'; } }; });
  }

  // ---- plan ------------------------------------------------------------------------------------------------
  function planView(j) {
    var hist = j.history || {};
    var phases = '<div class="g-phases">' + j.phases.map(function (p) {
      return '<div class="u-card"><header><h3>' + E(p.name) + '</h3><span class="u-muted sm">weeks ' + p.fromWeek + '–' + p.toWeek + ' · ' + dayL(p.from) + ' → ' + dayL(p.to) + '</span></header><p class="u-lead">' + E(p.goal) + '</p>'
        + '<div class="u-sub">Moves</div><ul class="g-rules">' + p.moves.map(function (m) { return '<li>' + E(m) + '</li>'; }).join('') + '</ul>'
        + '<div class="u-sub">Channels (organic first)</div><p>' + p.channels.map(function (c) { return '<span class="u-chip" title="' + E(c.why) + '">' + E(c.name) + '</span>'; }).join(' ') + '</p>'
        + '<div class="u-sub">Rules behind this phase</div><p>' + p.rules.map(ruleChip).join(' ') + '</p>'
        + '<div class="u-sub">Your weekly time · ' + p.time.totalHours + ' h (ceiling ' + p.time.ceilingHours + ' h)</div><ul class="u-list tight">' + p.time.rows.map(function (r) { return '<li class="u-row"><div class="u-row-main"><b>' + E(r.task) + '</b></div><span class="u-muted sm nowrap">' + r.minutes + ' min</span></li>'; }).join('') + '</ul></div>';
    }).join('') + '</div>';
    var rows = j.targets.map(function (t) { var a = hist[t.week]; var cur = t.week === j.check.week; return '<tr' + (cur ? ' class="cur"' : '') + '><td>' + t.week + '</td><td>' + dayL(t.weekStart) + '</td><td>' + E(t.phase) + '</td><td>' + num(t.users) + '</td><td>' + (a && a.users != null ? num(a.users) : '<span class="u-muted">—</span>') + '</td><td>' + num(t.paidUsers) + '</td><td>' + (a && a.paid != null ? num(a.paid) : '<span class="u-muted">—</span>') + '</td><td>' + money(t.revenue) + '</td></tr>'; }).join('');
    var base = j.plan.baseline || {};
    return '<div class="u-card"><header><h3>The plan · ' + num(j.plan.goal) + ' users in ' + j.plan.weeks + ' weeks from ' + dayL(j.plan.start) + '</h3></header><p class="u-muted sm">Baseline: ' + (base.users != null ? num(base.users) + ' users (' + E(base.source) + ')' : 'unknown until admin-stats is read') + '. The user milestones (100 → 350 → 1,000) are this plan\'s goals; the paid goals follow the approved playbook. Seen sells one-time products — Interview Prep $9.99 and the 30-day Job Search Pass $19.99 — so paying and revenue are counted over the last 30 days. Actuals are only ever what admin-stats reports.</p>'
      + '<div class="u-form"><label>Start (Monday, PT)<input type="date" id="g-pstart" value="' + E(j.plan.start) + '"></label><label>Weeks<input type="number" id="g-pweeks" min="8" max="78" value="' + j.plan.weeks + '"></label></div><div class="u-actions"><button class="u-btn" id="g-replan">Rebuild the plan</button><span class="u-muted sm">keeps the calendar; the baseline becomes today\'s real user count</span></div></div>'
      + phases + '<h2 class="u-h2">Weekly targets vs actuals</h2><div class="g-table-wrap"><table class="g-table"><thead><tr><th>Wk</th><th>Starts</th><th>Phase</th><th>Users goal</th><th>Users actual</th><th>Paid goal</th><th>Paid actual</th><th>Revenue goal (30 days)</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // ---- calendar page ---------------------------------------------------------------------------------------
  function calendarView(cal) {
    return '<div class="u-actions g-calbar"><button class="u-btn sm" id="g-prev">← Prev week</button><b>Week ' + (cal.week || '—') + ' · ' + dayL(cal.weekStart) + ' – ' + dayL(addDay(cal.weekStart, 6)) + '</b><button class="u-btn sm" id="g-nextw">Next week →</button><span style="flex:1"></span><button class="u-btn" data-gen="1">Regenerate 6 weeks</button></div>'
      + '<p class="u-muted sm">Regenerating keeps everything approved, scheduled, posted or measured. Items marked "you" are human-only; "app drafts" items get three trust-checked variants. All times are Pacific.</p>' + weekStrip(cal);
  }

  // ---- ad designer --------------------------------------------------------------------------------------
  function designerData() {
    var D = S.data || {}; var src = S.design.src; var f = S.design.fields; var t = S.design.template; var base;
    if (t === 'agency-leaderboard') base = (D.agencies || []).length ? { title: 'Staffing Agency Ghost Index', rows: D.agencies.slice(0, 7).map(function (a) { return { name: a.name, ghostPct: a.ghostPct, reports: a.reports, confidence: a.confidence }; }), sourceLine: 'seenjobs.io/agencies · applicant reports, trust-weighted · agencies with 5+ reports · as of ' + D.asOf + ' PT', cta: 'See the full index' } : null;
    else if (t === 'data-callout') {
      var c = null; if (src === 'item' && S.design.item && S.design.item.evidence) { var ev = S.design.item.evidence; c = (D.agencies || []).concat(D.companies || []).filter(function (x) { return x.line === ev.line; })[0] || null; }
      if (!c && /^(agency|company):/.test(src)) { var p = src.split(':'); c = (p[0] === 'agency' ? D.agencies : D.companies || [])[Number(p[1])] || null; }
      if (!c && (D.agencies || []).length) c = D.agencies[0];
      base = c ? { name: c.name, ghostPct: c.ghostPct, responsePct: c.responsePct, reports: c.reports, confidence: c.confidence, sourceLine: c.sourceLine, cta: 'Check before you apply', metric: f.metric || 'ghost' } : null;
    } else if (t === 'quote') base = { text: S.design.item ? S.design.item.hook : 'Silence is information. Check whether they answer applicants before you spend the hour.', attribution: '', context: 'From the founder of Seen', cta: 'Check a company' };
    else if (t === 'cta-banner') base = { headline: 'Check if they ghost before you apply.', sub: 'Response and ghost rates for employers and staffing agencies, from applicant reports — with the sample size on every number.', cta: 'Look one up — free' };
    else base = { title: 'Ten seconds before every application', steps: ['Look up the employer or agency on Seen', 'Apply where people actually hear back', 'Ghosted? Put it on the record — it warns the next applicant'], cta: 'Try it — seenjobs.io' };
    if (!base) return null;
    var out = {}; Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    // Text fields are editable; NUMBERS are not (they come from the live callout only).
    // (a data card's company name is NOT editable: its number belongs to that company)
    ['headline', 'sub', 'cta', 'text', 'attribution', 'context', 'title', 'subtitle'].forEach(function (k) { if (f[k] != null && f[k] !== '') out[k] = f[k]; });
    if (f.steps) out.steps = f.steps.split('\n').filter(Boolean).slice(0, 3);
    return out;
  }
  function designerView() {
    var G = window.GrowthDesign; if (!G) return fail('the designer module did not load');
    var meta = G.meta(); var D = S.data || {}; var d = designerData();
    var srcOpts = '';
    if (S.design.template === 'data-callout') srcOpts = '<label>Live callout<select id="g-dsrc">' + (S.design.item && S.design.item.evidence ? '<option value="item"' + (S.design.src === 'item' ? ' selected' : '') + '>From the calendar item</option>' : '') + (D.agencies || []).map(function (a, i) { return '<option value="agency:' + i + '"' + (S.design.src === 'agency:' + i ? ' selected' : '') + '>Agency · ' + E(a.line) + '</option>'; }).join('') + (D.companies || []).slice(0, 25).map(function (a, i) { return '<option value="company:' + i + '"' + (S.design.src === 'company:' + i ? ' selected' : '') + '>Company · ' + E(a.line) + '</option>'; }).join('') + '</select></label><label>Show<select id="g-dmetric"><option value="ghost">Ghost rate</option><option value="response"' + (S.design.fields.metric === 'response' ? ' selected' : '') + '>Response rate</option></select></label>';
    var editable = { 'data-callout': ['cta'], 'agency-leaderboard': ['title', 'subtitle', 'cta'], quote: ['text', 'attribution', 'context', 'cta'], 'cta-banner': ['headline', 'sub', 'cta'], steps: ['title', 'steps', 'cta'] }[S.design.template];
    var fields = editable.map(function (k) { var v = S.design.fields[k] != null ? S.design.fields[k] : (d && d[k] != null ? (Array.isArray(d[k]) ? d[k].join('\n') : d[k]) : ''); var long = k === 'text' || k === 'sub' || k === 'steps'; return '<label class="' + (long ? 'wide' : '') + '">' + E(k) + (long ? '<textarea data-df="' + k + '" rows="3">' + E(v) + '</textarea>' : '<input data-df="' + k + '" value="' + E(v) + '">') + '</label>'; }).join('');
    return '<div class="g-designer"><div class="u-card g-dctl"><header><h3>Ad designer</h3><span class="u-muted sm">free · Canvas · PNG</span></header>'
      + '<div class="u-form"><label>Template<select id="g-dt">' + meta.templates.map(function (t) { return '<option value="' + t.id + '"' + (t.id === S.design.template ? ' selected' : '') + '>' + E(t.name) + '</option>'; }).join('') + '</select></label>'
      + '<label>Size<select id="g-ds">' + Object.keys(meta.sizes).map(function (k) { return '<option value="' + k + '"' + (k === S.design.size ? ' selected' : '') + '>' + E(meta.sizes[k].label) + '</option>'; }).join('') + '</select></label>' + srcOpts + fields + '</div>'
      + '<p class="u-muted sm">' + E((meta.templates.filter(function (t) { return t.id === S.design.template; })[0] || {}).what) + ' ' + E(meta.sizes[S.design.size].use) + '. Numbers come only from live callouts; text fields are yours.</p>'
      + (S.design.template === 'quote' ? '<div class="u-note warn">A quote with a name must be real, attributed and used with permission. Leave attribution empty for a brand statement.</div>' : '')
      + (!d && (S.design.template === 'data-callout' || S.design.template === 'agency-leaderboard') ? '<div class="u-note warn">No live data reachable' + (D.error ? ' (' + E(D.error) + ')' : '') + ' — the preview is a SAMPLE LAYOUT and is stamped so it cannot be posted.</div>' : '')
      + '<div class="u-actions"><button class="u-btn primary" id="g-png">Download PNG</button><button class="u-btn" id="g-lib">Save to library</button><span class="u-muted sm" id="g-dmsg"></span></div></div>'
      + '<div class="g-canvas-wrap"><canvas id="g-canvas"></canvas><div class="u-muted sm" id="g-dinfo"></div></div></div>'
      + '<h2 class="u-h2">Library</h2><div id="g-library" class="g-library">' + loading() + '</div>';
  }
  function drawDesign() {
    var G = window.GrowthDesign, c = document.getElementById('g-canvas'); if (!G || !c) return;
    G.loadFonts('/api/growth/fonts/').then(function () {
      var d = designerData(); var r = G.render(c, S.design.template, S.design.size, d);
      var info = document.getElementById('g-dinfo'); if (info) info.textContent = r.w + ' × ' + r.h + (r.sample ? ' · SAMPLE LAYOUT (not real data)' : ' · real data');
      c.dataset.sample = r.sample ? '1' : '';
    });
  }
  function loadLibrary() {
    req('GET', '/api/growth/library').then(function (j) { var el = document.getElementById('g-library'); if (!el) return; el.innerHTML = j.items.length ? j.items.map(function (x) { return '<a class="g-lib-item" href="' + E(x.url) + '" target="_blank" rel="noopener"><img src="' + E(x.url) + '" alt=""><span>' + E(x.name) + ' · ' + E(x.size) + '</span></a>'; }).join('') : '<div class="u-empty">Nothing saved yet.</div>'; }).catch(function (e) { var el = document.getElementById('g-library'); if (el) el.innerHTML = fail(e); });
  }
  function bindDesigner() {
    var q = function (id) { return document.getElementById(id); };
    var re = function () { window.loadGrowth(); };
    q('g-dt').onchange = function () { S.design.template = this.value; S.design.fields = {}; re(); };
    q('g-ds').onchange = function () { S.design.size = this.value; drawDesign(); };
    if (q('g-dsrc')) q('g-dsrc').onchange = function () { S.design.src = this.value; re(); };
    if (q('g-dmetric')) q('g-dmetric').onchange = function () { S.design.fields.metric = this.value; drawDesign(); };
    document.querySelectorAll('[data-df]').forEach(function (x) { x.oninput = function () { S.design.fields[x.getAttribute('data-df')] = x.value; drawDesign(); }; });
    q('g-png').onclick = function () { var c = q('g-canvas'); if (c.dataset.sample) { q('g-dmsg').textContent = 'This is a sample layout — fill it from a live callout first.'; } var a = document.createElement('a'); a.download = 'seen-' + S.design.template + '-' + S.design.size + '.png'; a.href = c.toDataURL('image/png'); a.click(); };
    q('g-lib').onclick = function () { var c = q('g-canvas'); var b = this; if (c.dataset.sample) { q('g-dmsg').textContent = 'Sample layouts are not saved — pick a live callout.'; return; } b.disabled = true;
      var d = designerData() || {}; req('POST', '/api/growth/library', { png: c.toDataURL('image/png'), name: (d.name || d.headline || d.title || S.design.template), template: S.design.template, size: S.design.size, itemId: S.design.item ? S.design.item.id : null, source: d.sourceLine || '' }).then(function () { b.disabled = false; q('g-dmsg').textContent = 'Saved.'; loadLibrary(); }).catch(function (e) { b.disabled = false; q('g-dmsg').textContent = e.message; }); };
    drawDesign(); loadLibrary();
  }

  // ---- brand / positioning / creators / paid --------------------------------------------------------------
  function brandView(b) {
    var k = b.kit; var sw = Object.keys(k.visual.colors).filter(function (c) { return typeof k.visual.colors[c] === 'string'; }).map(function (c) { return '<div class="g-swatch"><i style="background:' + E(k.visual.colors[c]) + '"></i><b>' + E(c) + '</b><span>' + E(k.visual.colors[c]) + '</span></div>'; }).join('');
    return '<div class="u-grid"><div><div class="u-card"><header><h3>Brand kit · v' + b.version + '</h3><span class="u-muted sm">' + (b.savedAt ? 'saved ' + new Date(b.savedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : 'drafted default — edit and save to make it yours') + '</span></header>'
      + '<div class="u-form">' + ['tagline', 'category', 'promise', 'positioning'].map(function (f) { return '<label class="wide">' + f + (f === 'tagline' || f === 'category' ? '<input data-bf="' + f + '" value="' + E(k[f]) + '">' : '<textarea data-bf="' + f + '" rows="3">' + E(k[f]) + '</textarea>') + '</label>'; }).join('') + '<label class="wide">note for this version<input id="g-bnote" placeholder="what changed and why"></label></div>'
      + '<div class="u-actions"><button class="u-btn primary" id="g-bsave">Save as v' + (b.version + 1) + '</button><span class="u-muted sm" id="g-bmsg"></span></div></div>'
      + '<div class="u-card"><header><h3>Segments and pains</h3></header>' + k.segments.map(function (s) { return '<div class="g-seg"><b>' + E(s.name) + '</b><p class="u-muted sm">' + E(s.where) + '</p><ul class="g-rules">' + s.pains.map(function (p) { return '<li>' + E(p) + '</li>'; }).join('') + '</ul><p class="sm"><b>Wants:</b> ' + E(s.wants) + '</p></div>'; }).join('') + '</div></div>'
      + '<div><div class="u-card"><header><h3>Proof points Seen can back up</h3></header><ul class="u-list tight">' + k.proofPoints.map(function (p) { return '<li class="u-row"><div class="u-row-main"><b>' + E(p.text) + '</b><p>' + E(p.backedBy) + '</p></div></li>'; }).join('') + (b.liveProof || []).map(function (p) { return '<li class="u-row"><div class="u-row-main"><b>' + E(p.text) + '</b><p>live · ' + E(p.source) + '</p></div>' + chip('ok', 'live') + '</li>'; }).join('') + '</ul></div>'
      + '<div class="u-card"><header><h3>Voice</h3></header><p class="u-lead">' + E(k.voice.summary) + '</p><ul class="u-list tight">' + k.voice.traits.map(function (t) { return '<li class="u-row"><div class="u-row-main"><b>' + E(t.trait) + '</b><p>Do: ' + E(t.do) + ' · Don\'t: ' + E(t.dont) + '</p></div></li>'; }).join('') + '</ul>'
      + '<div class="u-sub">Words to use</div><p>' + k.wordsToUse.map(function (w) { return '<span class="u-chip ok">' + E(w) + '</span>'; }).join(' ') + '</p><div class="u-sub">Words to avoid</div><ul class="g-rules">' + k.wordsToAvoid.map(function (w) { return '<li><b>' + E(w.word) + '</b> — ' + E(w.why) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="u-card"><header><h3>Trust principles</h3></header><ul class="g-rules">' + k.trustPrinciples.map(function (t) { return '<li>' + E(t) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="u-card"><header><h3>Visual tokens</h3><span class="u-muted sm">from seenjobs.io</span></header><div class="g-swatches">' + sw + '</div><p class="sm">Type: <b>' + E(k.visual.fonts.display) + '</b> (display) · <b>' + E(k.visual.fonts.body) + '</b> (body) · <b>' + E(k.visual.fonts.mono) + '</b> (data)</p><ul class="g-rules">' + k.visual.rules.map(function (r) { return '<li>' + E(r) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="u-card"><header><h3>Versions</h3></header>' + (b.history.length ? '<ul class="u-list tight">' + b.history.slice().reverse().map(function (v) { return '<li class="u-row"><div class="u-row-main"><b>v' + v.v + ' · ' + E(v.note || 'no note') + '</b><p>' + new Date(v.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT · ' + E(v.by) + '</p></div></li>'; }).join('') + '</ul>' : '<div class="u-empty">Only the drafted default so far.</div>') + '</div></div></div>';
  }
  function bindBrand() {
    var s = document.getElementById('g-bsave'); if (!s) return;
    s.onclick = function () { var patch = {}; document.querySelectorAll('[data-bf]').forEach(function (x) { patch[x.getAttribute('data-bf')] = x.value; }); s.disabled = true;
      req('POST', '/api/growth/brand', { patch: patch, note: document.getElementById('g-bnote').value }).then(function (r) { document.getElementById('g-bmsg').textContent = r.unchanged ? 'Nothing changed.' : 'Saved v' + r.version + (r.brain && !r.brain.ok ? ' (brain pointer not written: ' + r.brain.error + ')' : ' · pointer in the brain'); setTimeout(window.loadGrowth, 900); }).catch(function (e) { s.disabled = false; document.getElementById('g-bmsg').textContent = e.message; }); };
  }
  function positioningView(p) {
    return '<div class="u-card g-hero"><header><h3>The category Seen owns: ' + E(p.category.name) + '</h3></header><p class="u-lead">' + E(p.category.oneLiner) + '</p><p class="u-muted">' + E(p.category.whyNow) + '</p><p class="sm"><b>Value:</b> ' + E(p.value) + '</p><p class="sm"><b>Best fit:</b> ' + E(p.bestFit) + '</p><p>' + ruleChip(p.rule) + '</p></div>'
      + '<div class="u-grid"><div><div class="u-card"><header><h3>What only Seen has</h3></header><ul class="u-list tight">' + p.uniqueAttributes.map(function (a) { return '<li class="u-row"><div class="u-row-main"><b>' + E(a.attr) + '</b><p>' + E(a.detail) + '</p></div></li>'; }).join('') + '</ul></div>'
      + '<div class="u-card"><header><h3>How to stand apart</h3></header><ul class="g-rules">' + p.standApart.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul></div></div><div><div class="u-note warn">' + E(p.unverifiedNote) + '</div></div></div>'
      + '<h2 class="u-h2">The alternatives people use today</h2><div class="g-comp">' + p.alternatives.map(function (c) { return '<div class="u-card"><header><h3>' + E(c.name) + '</h3>' + (c.verified ? chip('ok', 'home turf') : chip('dim', 'unverified')) + '</header><p class="u-muted sm">' + E(c.kind) + '</p><div class="u-sub">Does well</div><ul class="g-rules">' + c.doesWell.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul><div class="u-sub">The gap</div><p class="sm">' + E(c.gap) + '</p><div class="u-sub">Seen\'s line</div><p class="sm"><b>' + E(c.seenAngle) + '</b></p>' + (c.note ? '<p class="u-muted sm">' + E(c.note) + '</p>' : '') + '</div>'; }).join('') + '</div>';
  }
  function creatorsView(j) {
    return '<p class="u-muted">Assets that make a creator look good to their own audience — citable numbers with links and sample sizes. The Creator Library matches creators to these (exported as <code>shareableAssets()</code> and <code>storyAngles(week)</code>).</p>'
      + (j.dataError ? '<div class="u-note warn">Live data unavailable (' + E(j.dataError) + ') — angles are shown without numbers.</div>' : '')
      + '<h2 class="u-h2">Story angles · week ' + j.week + '</h2><div class="g-comp">' + j.angles.map(function (a) { return '<div class="u-card"><header><h3>' + E(a.title) + '</h3>' + (a.evidence ? chip('ok', a.evidence.confidence) : chip('dim', 'no numbers')) + '</header><p class="u-lead">' + E(a.hook) + '</p>' + (a.evidence ? '<p class="u-muted sm">' + E(a.evidence.source) + ' · <a href="' + E(a.evidence.url) + '" target="_blank" rel="noopener">source</a></p>' : '<p class="u-muted sm">' + E(a.needsData || 'story-first — needs no data') + '</p>') + '<p>' + a.fits.map(function (f) { return '<span class="u-chip">' + E(f) + '</span>'; }).join(' ') + '</p></div>'; }).join('') + '</div>'
      + '<h2 class="u-h2">Shareable assets</h2><ul class="u-list">' + j.assets.map(function (a) { return '<li class="u-row"><div class="u-row-main"><b>' + a.priority + '. ' + E(a.name) + ' — <a href="' + E(a.url.replace('<name>', 'amazon')) + '" target="_blank" rel="noopener">' + E(a.url) + '</a></b><p>Creator gets: ' + E(a.creatorGets) + ' · Audience gets: ' + E(a.audienceGets) + '</p></div><span class="u-chip">' + E(a.kind) + '</span></li>'; }).join('') + '</ul>';
  }
  function paidView(p) {
    var r = p.readiness;
    return '<div class="u-note warn">' + E(p.note) + '</div>'
      + '<div class="u-card g-hero"><header><h3>Is paid allowed yet?</h3>' + chip(r.ready ? 'hit' : 'upcoming', r.ready ? 'gate open' : 'not yet') + '</header>' + (r.reasons.length ? '<ul class="g-rules">' + r.reasons.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul>' : '<p>Organic proof and activation are in place — simulate the first tranche.</p>') + '<p class="sm"><b>Target cost per signup:</b> ' + (p.targetCpa.value != null ? money(p.targetCpa.value) : 'unknown') + ' — ' + E(p.targetCpa.why) + '</p></div>'
      + '<h2 class="u-h2">Budget tranches</h2><div class="g-comp">' + p.tranches.map(function (t) { var sim = p.simulate[t.id]; return '<div class="u-card"><header><h3>' + E(t.name) + ' · ' + money(t.budget) + '</h3><span class="u-muted sm">' + E(t.length) + '</span></header><p class="sm">' + E(t.does) + '</p><p class="u-muted sm"><b>Gate:</b> ' + E(t.gate) + '</p>' + (sim ? '<p class="u-muted sm">' + sim.assumptions.map(E).join(' · ') + '</p><div class="u-actions"><button class="u-btn sm" data-sim="' + t.id + '">Simulate this first</button><span class="u-muted sm" id="g-sim-' + t.id + '"></span></div>' : '') + '</div>'; }).join('') + '</div>'
      + '<h2 class="u-h2">Channels (in order)</h2><ul class="u-list">' + p.channels.map(function (c) { return '<li class="u-row"><div class="u-row-main"><b>' + E(c.name) + '</b><p>When: ' + E(c.when) + ' · Audience: ' + E(c.audience) + ' · ' + E(c.why) + '</p></div>' + ruleChip(c.rule) + '</li>'; }).join('') + '</ul>'
      + '<h2 class="u-h2">Kill / scale rules</h2><ul class="u-list">' + p.killScale.map(function (k) { return '<li class="u-row"><div class="u-row-main"><b>' + E(k.rule) + '</b><p>' + E(k.why) + '</p></div></li>'; }).join('') + '</ul>'
      + '<h2 class="u-h2">Creative matrix · ' + p.matrix.length + ' combinations</h2><p class="u-muted sm">angle × template × hook style, each with its UTM — e.g. <code>' + E(p.utmExample) + '</code>. ' + E(p.unverified) + '</p>';
  }
  function bindPaid(p) {
    document.querySelectorAll('[data-sim]').forEach(function (b) { b.onclick = function () { var id = b.getAttribute('data-sim'); var sim = p.simulate[id]; b.disabled = true;
      req('POST', '/api/simulate', { question: sim.question, numbers: sim.numbers }).then(function (r) { document.getElementById('g-sim-' + id).textContent = r.existing ? 'Already simulated (' + r.status + ') — the brief is in the Board Room.' : 'Queued — the brief will land in the Board Room.'; }).catch(function (e) { b.disabled = false; document.getElementById('g-sim-' + id).textContent = e.message; }); }; });
  }

  // ---- loader ----------------------------------------------------------------------------------------------
  window.loadGrowth = function (quiet) {
    var v = S.view; if (!quiet) paint(loading());
    var after = function (html, bind) { if (S.view !== v) return; paint(html); bindCommon(); if (bind) bind(); };
    var data = function () { return S.data ? Promise.resolve(S.data) : req('GET', '/api/growth/data').then(function (d) { S.data = d; return d; }).catch(function (e) { S.data = { agencies: [], companies: [], error: e.message }; return S.data; }); };
    var p;
    if (v === 'week') p = req('GET', '/api/growth/overview').then(function (j) { after(weekView(j)); });
    else if (v === 'plan') p = req('GET', '/api/growth/plan').then(function (j) { after(planView(j), function () { document.getElementById('g-replan').onclick = function () { var b = this; b.disabled = true; req('POST', '/api/growth/plan', { start: document.getElementById('g-pstart').value, weeks: Number(document.getElementById('g-pweeks').value) }).then(function () { window.loadGrowth(); }).catch(function (e) { b.disabled = false; b.textContent = e.message; }); }; }); });
    else if (v === 'calendar') p = req('GET', '/api/growth/calendar' + (S.weekFrom ? '?week=' + S.weekFrom : '')).then(function (c) { S.weekFrom = c.weekStart; after(calendarView(c), function () { document.getElementById('g-prev').onclick = function () { S.weekFrom = addDay(S.weekFrom, -7); window.loadGrowth(); }; document.getElementById('g-nextw').onclick = function () { S.weekFrom = addDay(S.weekFrom, 7); window.loadGrowth(); }; }); });
    else if (v === 'designer') p = data().then(function () { after(designerView(), bindDesigner); });
    else if (v === 'brand') p = req('GET', '/api/growth/brand').then(function (b) { after(brandView(b), bindBrand); });
    else if (v === 'positioning') p = req('GET', '/api/growth/positioning').then(function (j) { after(positioningView(j)); });
    else if (v === 'creators') p = req('GET', '/api/growth/assets').then(function (j) { after(creatorsView(j)); });
    else p = req('GET', '/api/growth/ads').then(function (j) { after(paidView(j), function () { bindPaid(j); }); });
    return p.catch(function (e) { paint(fail(e)); });
  };
  window.GrowthStudio = { state: S, openItem: openItem };
})();
