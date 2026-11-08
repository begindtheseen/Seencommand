// Money & Scale tab (2026-10-21; one-time sales model 2026-10-27 — Interview Prep and the Job Search Pass, nothing
// renews): seenjobs.io's live money picture, the revenue funnel, where this month's revenue should go,
// unit economics, the scale-readiness watch, and "simulate a money decision". Every number shows where it
// came from (hover a tile, or read the line under it); projections are labelled. Backed by /api/money*.
// Inlined into public/command-center.html after jobs-client.js. Plain browser JS. California time.
(function () {
  var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var usd = function (x) { if (x == null || isNaN(x)) return '—'; var a = Math.abs(Number(x)); var s = a.toLocaleString('en-US', { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 }); return (x < 0 ? '−$' : '$') + s; };
  var pct = function (x) { return x == null || isNaN(x) ? '—' : (Math.round(x * 1000) / 10) + '%'; };
  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  function req(method, u, body) {
    return fetch(u, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  var P = null, busy = false;
  var CHIP = { act: '<span class="u-chip bad">Act now</span>', soon: '<span class="u-chip warn">Soon</span>', ok: '<span class="u-chip ok">OK</span>', unknown: '<span class="u-chip dim">Unavailable</span>' };
  var RCHIP = { done: '<span class="u-chip ok">Done</span>', partial: '<span class="u-chip warn">Partly</span>', todo: '<span class="u-chip bad">To do</span>', unknown: '<span class="u-chip dim">Confirm</span>' };

  function stat(v, label, sub, cls, title) { return '<div class="u-stat' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + E(title) + '"' : '') + '><div class="u-stat-v">' + v + '</div><div class="u-stat-l">' + E(label) + '</div>' + (sub ? '<div class="u-stat-s">' + E(sub) + '</div>' : '') + '</div>'; }
  function card(id, title, right, body) { return '<section class="u-card" id="' + id + '"><header><h3>' + E(title) + '</h3>' + (right || '') + '</header>' + body + '</section>'; }

  function statsHtml(l) {
    var t = l.trace || {}; var p = l.purchases || {}; var f = l.funnel || null; var lg = l.legacy || {};
    var tr = f && f.takeRate; var run = l.runway || {};
    return '<div class="u-stats u-money-stats">'
      + stat(usd(l.revenue.month), 'Revenue (30 days)', 'one-time' + (l.revenue.employer30d ? ' · employer ' + usd(l.revenue.employer30d) : '') + (lg.mrr ? ' · legacy ' + usd(lg.mrr) : ''), 'accent', t.monthRevenue + ' — ' + (t.consumer || ''))
      + stat(num(l.paying), 'Paying customers', 'last 30 days · ' + pct(l.buyerShare) + ' of ' + num(l.users) + ' accounts', '', t.paying)
      + stat(num(p.interview), 'Interview Prep sales', '$9.99 · last 30 days', '', t.consumer)
      + stat(num(p.pass30), 'Job Search Pass sales', '$19.99 · last 30 days', '', t.consumer)
      + stat(usd(l.revenue.avgSale), 'Average sale', l.revenue.avgSale == null ? 'no sales yet' : 'per purchase', '', t.avgSale)
      + stat(tr && tr.rate != null ? pct(tr.rate) : '—', 'Take rate', tr ? (tr.rate != null ? 'Prep offer → purchase' : 'not enough data') : 'funnel not readable', '', tr ? tr.formula : t.consumer)
      + (lg.subscribers ? stat(num(lg.subscribers), 'Legacy subscriptions', usd(lg.mrr) + '/mo · ends as they cancel' + (lg.pastDue ? ' · ' + lg.pastDue + ' past due' : ''), lg.pastDue ? 'warn' : '', t.legacy) : '')
      + stat(l.grossMargin == null ? '—' : pct(l.grossMargin), 'Gross margin', l.grossMargin == null ? 'needs revenue' : 'after infra, product AI, fees', '', t.grossMargin)
      + stat(usd(l.net), 'Net / month', (l.revenue.month == null ? 'revenue unknown · costs ' + usd(l.costs.total) : 'revenue ' + usd(l.revenue.month) + ' − costs ' + usd(l.costs.total)), l.net < 0 ? 'bad' : '', t.net)
      + stat(run.months != null ? run.months + ' mo' : (run.state === 'ok' ? '∞' : '—'), 'Runway', run.label, run.state === 'act' ? 'bad' : run.state === 'soon' ? 'warn' : '', t.runway)
      + '</div>';
  }

  function funnelHtml(f) {
    if (!f) return '<div class="u-empty">Seen\'s revenue funnel is not readable from here yet (it needs the admin-stats connection and a Seen deploy with the funnel).</div>';
    var steps = (f.steps || []).map(function (s) { return '<li class="u-row"><div class="u-row-main"><b>' + E(s.label) + '</b></div><span class="u-money-amt">' + num(s.n) + '</span></li>'; }).join('');
    var imp = f.implied ? '<p class="u-lead">At today\'s rates: ' + usd(f.implied.dollars) + ' a month <span class="u-muted sm">(' + E(f.implied.formula) + ' — a projection)</span></p>' : '<p class="u-muted sm">Monthly projection: not enough data yet (needs interviews, offers shown and pressed).</p>';
    return imp + (f.recording ? '' : '<div class="u-note">Seen\'s funnel events are not recording yet — offer and checkout steps read "—".</div>') + '<ul class="u-list tight">' + steps + '</ul><p class="u-muted sm">Last ' + f.days + ' days, from Seen\'s own tables. Interview Prep is offered when a tracked application reaches an interview.</p>';
  }

  function traceHtml(l) {
    var t = l.trace || {}; var keys = [['consumer', 'Interview Prep + Job Search Pass'], ['employer', 'Employer sales'], ['legacy', 'Legacy subscriptions'], ['paying', 'Paying customers'], ['costs', 'Costs'], ['grossMargin', 'Gross margin'], ['runway', 'Runway']];
    return '<details class="u-money-trace"><summary>Where every number comes from</summary><ul class="u-list tight">' + keys.filter(function (k) { return t[k[0]]; }).map(function (k) { return '<li class="u-row"><div class="u-row-main"><b>' + E(k[1]) + '</b><p>' + E(t[k[0]]) + '</p></div></li>'; }).join('') + '</ul></details>';
  }

  function allocationHtml(a) {
    var rows = a.buckets.map(function (b) { return '<li class="u-row"><div class="u-row-main"><b>' + E(b.label) + ' · ' + b.pct + '%' + (b.pct !== b.default ? ' <span class="u-chip run">yours</span>' : '') + '</b><p>' + E(b.rule) + '</p></div><span class="u-money-amt">' + usd(b.amount) + '</span></li>'; }).join('');
    var check = a.check ? '<div class="u-note' + (a.check.state === 'ok' ? '' : ' warn') + ' u-money-check">' + E(a.check.text) + '</div>' : '';
    var form = '<div class="u-money-edit" id="mo-alloc-form" hidden><div class="u-form u-money-pcts">' + a.buckets.map(function (b) { return '<label>' + E(b.label) + ' %<input type="number" min="0" max="100" step="0.5" data-b="' + b.id + '" value="' + b.pct + '"></label>'; }).join('') + '</div><div class="u-actions end"><span class="u-muted sm" id="mo-alloc-msg"></span><button class="u-btn ghost sm" id="mo-alloc-reset">Use defaults</button><button class="u-btn primary sm" id="mo-alloc-save">Save for this stage</button></div></div>';
    return '<p class="u-lead"><span class="u-chip run">' + E(a.stage.label) + '</span> ' + E(a.stage.why) + '</p>'
      + '<p class="u-money-head">' + E(a.headline) + '</p>' + check
      + '<ul class="u-list">' + rows + '</ul>' + form
      + '<p class="u-muted sm u-money-cite">' + (a.next ? 'Next stage (' + E(a.next.label) + ') at ' + usd(a.next.needed + a.revenue) + '/mo of revenue. ' : '') + 'Method: ' + a.frameworks.map(function (f) { return E(f.name) + ' — ' + E(f.by); }).join(' · ') + '. Percentages are Seen Command\'s stage defaults; the tax reserve is a placeholder for your real rate.</p>';
  }

  function costsHtml(l, m) {
    var rows = l.costs.list.map(function (c, i) {
      return '<li class="u-row u-money-cost"><div class="u-row-main"><b>' + E(c.name) + ' <span class="u-chip dim">' + E(c.category) + '</span>' + (c.confirmed === false ? ' <span class="u-chip warn">unconfirmed</span>' : '') + '</b><p>' + E(c.note || '') + '</p></div>'
        + '<div class="u-form u-money-in"><input type="text" inputmode="decimal" placeholder="not entered" data-cost="' + i + '" value="' + (c.monthly == null ? '' : c.monthly) + '"><span class="u-muted sm">/mo</span><button class="u-btn sm" data-save="' + i + '">Save</button></div></li>';
    }).join('');
    var cash = l.cash;
    return '<ul class="u-list">' + rows + '</ul>'
      + '<div class="u-form u-money-add"><input id="mo-new-name" placeholder="New cost (e.g. Figma)"><input id="mo-new-amt" inputmode="decimal" placeholder="$ / month"><select id="mo-new-cat"><option value="tools">tools</option><option value="infra">infra</option><option value="ai">ai</option><option value="ads">ads</option><option value="payroll">payroll</option><option value="other">other</option></select><button class="u-btn sm" id="mo-new-add">Add</button></div>'
      + '<div class="u-sub">Also counted</div><p class="u-muted sm">Seen Command\'s own AI spend, last 30 days: ' + usd(l.costs.aiOps) + ' (observed) · payment fees: ' + usd(l.costs.fees) + ' (Stripe standard rate, assumed) · total ' + usd(l.costs.total) + '/mo.</p>'
      + '<div class="u-sub">Cash on hand (for runway)</div><div class="u-form u-money-add"><input id="mo-cash" inputmode="decimal" placeholder="not entered" value="' + (cash == null ? '' : cash) + '"><button class="u-btn sm" id="mo-cash-save">Save cash</button><span class="u-muted sm" id="mo-cost-msg"></span></div>';
  }

  function unitsHtml(u, sc) {
    var cac = u.cac.length ? '<ul class="u-list tight">' + u.cac.map(function (c) { return '<li class="u-row"><div class="u-row-main"><b>' + E(c.name) + (c.projected ? ' <span class="u-chip warn">projection</span>' : '') + '</b><p>' + E(c.basis) + (c.paybackSales != null ? ' · pays back after ' + c.paybackSales + ' sale' + (c.paybackSales === 1 ? '' : 's') : '') + '</p></div><span class="u-money-amt">' + usd(c.cac) + '</span></li>'; }).join('') + '</ul>' : '<div class="u-empty">No channel spend recorded yet.' + (u.growthNote ? ' ' + E(u.growthNote) + '.' : '') + '</div>';
    var chForm = '<div class="u-form u-money-add"><input id="mo-ch-name" placeholder="Channel (reddit, ads…)"><input id="mo-ch-spend" inputmode="decimal" placeholder="$ spent, 30 days"><input id="mo-ch-su" inputmode="decimal" placeholder="signups, 30 days"><input id="mo-ch-pd" inputmode="decimal" placeholder="paying, 30 days"><button class="u-btn sm" id="mo-ch-save">Save channel</button></div>';
    var scen = '<table class="u-money-table"><thead><tr><th>Scenario (projection)</th><th>Month revenue</th><th>Change</th></tr></thead><tbody>' + sc.scenarios.map(function (s) { return '<tr><td><b>' + E(s.title) + '</b><div class="u-muted sm">' + E(s.assumes.join(' · ')) + '</div></td><td>' + usd(s.month) + '</td><td>' + (s.id === 'today' ? '—' : (s.delta >= 0 ? '+' : '') + usd(s.delta)) + '</td></tr>'; }).join('') + '</tbody></table><p class="u-muted sm">' + E(sc.note) + '</p>';
    var be = u.breakEven;
    return '<div class="u-stats">' + stat(usd(u.avgSale), 'Average sale used', u.avgSaleObserved ? 'observed' : 'assumed: Interview Prep price', '', u.trace.avgSale) + stat(usd(u.contribution), 'Contribution / sale', Math.round(u.grossMargin * 100) + '% margin', '', u.trace.contribution) + stat(num(be.sales), 'Break-even sales / month', be.interviews != null ? '≈ ' + num(be.interviews) + ' tracked interviews' : 'interviews: take rate not measured yet', '', be.formula) + '</div>'
      + '<div class="u-sub">Cost to win a buyer, by channel · ' + E(u.channelsSource) + '</div>' + cac + chForm
      + '<div class="u-sub">Scenario levers</div>' + scen
      + '<div class="u-form u-money-add"><label class="u-muted sm">Interviews / month<input id="mo-sc-int" inputmode="decimal" placeholder="' + (sc.base.interviews || 0) + '"></label><label class="u-muted sm">Take rate %<input id="mo-sc-take" inputmode="decimal" placeholder="' + Math.round((sc.base.takeRate || 0) * 1000) / 10 + '"></label><label class="u-muted sm">Buyers picking the Pass %<input id="mo-sc-pass" inputmode="decimal" placeholder="' + Math.round((sc.base.passShare || 0) * 100) + '"></label><label class="u-muted sm">Featured/mo<input id="mo-sc-feat" inputmode="decimal" placeholder="0"></label><button class="u-btn sm" id="mo-sc-run">Project</button></div><div class="u-muted sm" id="mo-sc-out"></div>'
      + (u.assumptions.length ? '<p class="u-muted sm">Assumed: ' + E(u.assumptions.join('; ')) + '.</p>' : '') + '<p class="u-muted sm">' + E(u.note) + '</p>';
  }

  function scaleHtml(s) {
    var rows = s.items.map(function (i) {
      return '<li class="u-row u-money-scale"><div class="u-row-main"><b>' + E(i.title) + '</b><p>' + E(i.reading || '') + (i.limit ? ' · limit ' + E(i.limit) : '') + (i.rate ? ' · ' + E(i.rate) : '') + '</p>'
        + (i.etaText && i.status !== 'unknown' ? '<p><b class="u-money-eta' + (i.status === 'ok' ? ' ok' : '') + '">ETA ' + E(i.etaText) + '</b></p>' : '')
        + (i.action ? '<p>' + E(i.action) + (i.fixCost ? ' <span class="u-chip">fix ' + E(i.fixCost) + '</span>' : '') + '</p>' : '')
        + (i.rateSource ? '<p class="u-muted sm">rate: ' + E(i.rateSource) + '</p>' : '') + '</div>' + (CHIP[i.status] || '') + '</li>';
    }).join('');
    return '<p class="u-muted sm u-money-plan">Supabase plan: <b>' + E(s.plan) + '</b> ' + ['free', 'pro', 'team'].map(function (p) { return '<button class="u-btn sm' + (s.plan === p ? ' primary' : ' ghost') + '" data-plan="' + p + '"' + (s.plan === p ? ' disabled' : '') + '>' + p + '</button>'; }).join('') + ' · ' + ['act', 'soon', 'unknown', 'ok'].map(function (k) { return (s.counts[k] || 0) + ' ' + ({ act: 'act now', soon: 'soon', unknown: 'unavailable', ok: 'ok' })[k]; }).join(' · ') + '</p><ul class="u-list">' + rows + '</ul>';
  }

  function readinessHtml(list) {
    var by = {}; list.forEach(function (r) { (by[r.milestone] = by[r.milestone] || []).push(r); });
    return Object.keys(by).sort(function (a, b) { return a - b; }).map(function (m) {
      return '<div class="u-sub">First ' + num(Number(m)) + ' users</div><ul class="u-list tight">' + by[m].map(function (r) {
        return '<li class="u-row"><div class="u-row-main"><b>' + E(r.title) + (r.due ? ' <span class="u-chip ' + (r.due === 'overdue' ? 'bad' : 'warn') + '">' + E(r.due) + '</span>' : '') + '</b><p>' + E(r.evidence || r.how) + '</p></div>' + (RCHIP[r.state] || '') + '<button class="u-btn ghost sm" data-ready="' + E(r.id) + '" data-done="' + (r.state === 'done' ? '0' : '1') + '">' + (r.state === 'done' ? 'Mark not done' : 'Mark done') + '</button></li>';
      }).join('') + '</ul>';
    }).join('');
  }

  function simHtml(inp) {
    return '<p class="u-muted">A money decision gets simulated with live numbers: today\'s users, growth measured from signups, the share of accounts that buy, Seen\'s prices and your costs. Include the amount (and "/mo" when it repeats). The verdict lands in the Board Room in a few minutes.</p>'
      + '<div class="u-form u-money-add"><input id="mo-sim-q" placeholder="e.g. Upgrade Supabase to Pro at $25/mo"><button class="u-btn primary sm" id="mo-sim-go">Simulate</button></div><div class="u-muted sm" id="mo-sim-msg"></div>'
      + '<details class="u-money-trace"><summary>The live inputs a simulation would use (12 weeks)</summary><ul class="u-list tight">' + inp.assumptions.map(function (a) { return '<li class="u-row"><div class="u-row-main"><p>' + E(a) + '</p></div></li>'; }).join('') + '</ul></details>';
  }

  function render() {
    var root = document.getElementById('money-view'); if (!root || !P) return;
    var l = P.ledger;
    var warn = (l.unavailable || []).map(function (u) { return '<div class="u-note warn">' + E(u) + '</div>'; }).join('') + (l.notes || []).map(function (n) { return '<div class="u-note">' + E(n) + '</div>'; }).join('');
    root.innerHTML = '<div class="u-head"><div><h1>Money &amp; Scale</h1><p class="u-muted">seenjobs.io first. Live from admin-stats, Stripe and your cost list · ' + E(P.atPT) + ' PT. ' + E(P.rule) + '</p></div><div class="u-head-actions"><button class="u-btn" id="mo-refresh">Refresh</button></div></div>'
      + warn + statsHtml(l) + traceHtml(l)
      + '<div class="u-grid u-money-grid"><div class="u-col">'
      + card('mo-scale', 'Scale watch — what breaks first', '<span class="u-count">' + (P.scale.counts.act || 0) + ' act now</span>', scaleHtml(P.scale))
      + card('mo-alloc', 'Where this month\'s money goes', '<button class="u-btn ghost sm" id="mo-alloc-edit">Edit %</button>', allocationHtml(P.allocation))
      + card('mo-sim', 'Simulate a money decision', '', simHtml(P.inputs))
      + '</div><div class="u-col">'
      + card('mo-costs', 'Monthly costs', '<span class="u-count">' + usd(l.costs.total) + '/mo</span>', costsHtml(l))
      + card('mo-funnel', 'Revenue funnel', '', funnelHtml(l.funnel))
      + card('mo-units', 'Unit economics', '', unitsHtml(P.units, P.scenarios))
      + card('mo-ready', 'Readiness for the next users', '', readinessHtml(P.scale.readiness))
      + '</div></div>';
    wire();
  }

  function msg(id, text, bad) { var el = document.getElementById(id); if (el) { el.textContent = text; el.style.color = bad ? 'var(--bad)' : ''; } }
  function after(id) { return function () { msg(id, 'Saved.'); window.loadMoney(true); }; }
  function fail(id) { return function (e) { msg(id, e.message, true); }; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  function wire() {
    var q = function (s) { return document.getElementById(s); };
    q('mo-refresh').onclick = function () { window.loadMoney(true); };
    document.querySelectorAll('[data-save]').forEach(function (b) {
      b.onclick = function () { var i = Number(b.getAttribute('data-save')); var c = P.ledger.costs.list[i]; var inp = document.querySelector('[data-cost="' + i + '"]'); b.disabled = true;
        req('POST', '/api/money/costs', { name: c.name, monthly: inp.value.trim() === '' ? null : inp.value.trim() }).then(after('mo-cost-msg')).catch(function (e) { b.disabled = false; fail('mo-cost-msg')(e); }); };
    });
    q('mo-new-add').onclick = function () { if (!val('mo-new-name')) return msg('mo-cost-msg', 'Give the cost a name.', true); req('POST', '/api/money/costs', { name: val('mo-new-name'), monthly: val('mo-new-amt'), category: val('mo-new-cat') }).then(after('mo-cost-msg')).catch(fail('mo-cost-msg')); };
    q('mo-cash-save').onclick = function () { req('POST', '/api/money/cash', { amount: val('mo-cash') === '' ? null : val('mo-cash') }).then(after('mo-cost-msg')).catch(fail('mo-cost-msg')); };
    q('mo-alloc-edit').onclick = function () { var f = q('mo-alloc-form'); f.hidden = !f.hidden; };
    q('mo-alloc-save').onclick = function () { var p = {}; document.querySelectorAll('#mo-alloc-form [data-b]').forEach(function (i) { p[i.getAttribute('data-b')] = Number(i.value); }); req('POST', '/api/money/allocate', { stage: P.allocation.stage.id, pcts: p }).then(after('mo-alloc-msg')).catch(fail('mo-alloc-msg')); };
    q('mo-alloc-reset').onclick = function () { req('POST', '/api/money/allocate', { stage: P.allocation.stage.id, reset: true }).then(after('mo-alloc-msg')).catch(fail('mo-alloc-msg')); };
    q('mo-ch-save').onclick = function () { req('POST', '/api/money/channels', { name: val('mo-ch-name'), spend30d: val('mo-ch-spend'), signups30d: val('mo-ch-su'), paid30d: val('mo-ch-pd') }).then(function () { window.loadMoney(true); }).catch(function (e) { msg('mo-sc-out', e.message, true); }); };
    q('mo-sc-run').onclick = function () {
      var lv = {}; var iv = val('mo-sc-int'), tk = val('mo-sc-take'), ps = val('mo-sc-pass'), ft = val('mo-sc-feat');
      if (iv) lv.interviews = Number(iv); if (tk) lv.takeRate = Number(tk) / 100; if (ps) lv.passShare = Number(ps) / 100; if (ft) lv.employerFeatured = Number(ft);
      req('POST', '/api/money/scenario', { levers: lv }).then(function (r) { msg('mo-sc-out', 'Projection: ' + usd(r.month) + '/mo (' + r.sales + ' sales → ' + usd(r.consumer) + ', employer ' + usd(r.employer) + (r.legacy ? ', legacy ' + usd(r.legacy) : '') + '). ' + r.note); }).catch(function (e) { msg('mo-sc-out', e.message, true); });
    };
    document.querySelectorAll('[data-plan]').forEach(function (b) { b.onclick = function () { b.disabled = true; req('POST', '/api/money/plan', { service: 'supabase', plan: b.getAttribute('data-plan') }).then(function () { window.loadMoney(true); }).catch(function (er) { b.disabled = false; b.textContent = er.message; }); }; });
    document.querySelectorAll('[data-ready]').forEach(function (b) { b.onclick = function () { req('POST', '/api/money/readiness', { id: b.getAttribute('data-ready'), done: b.getAttribute('data-done') === '1' }).then(function () { window.loadMoney(true); }).catch(function (e) { b.textContent = e.message; }); }; });
    q('mo-sim-go').onclick = function () {
      var t = val('mo-sim-q'); if (!t) return msg('mo-sim-msg', 'Say the decision in words.', true);
      var b = q('mo-sim-go'); b.disabled = true;
      req('POST', '/api/simulate', { question: t }).then(function (r) { b.disabled = false; msg('mo-sim-msg', (r.existing ? 'Already simulated (' + r.status + ')' : 'Queued' + (r.position ? ' (#' + r.position + ')' : '')) + ' — the verdict and the numbers run land in the Board Room. Simulation id ' + r.id + '.'); }).catch(function (e) { b.disabled = false; msg('mo-sim-msg', e.message, true); });
    };
  }

  window.loadMoney = function (refresh) {
    var root = document.getElementById('money-view'); if (!root || busy) return;
    if (!P) root.innerHTML = '<div class="u-head"><div><h1>Money &amp; Scale</h1><p class="u-muted">Reading admin-stats, Stripe and your cost list…</p></div></div><div class="u-skeleton"><div></div><div></div><div></div></div>';
    busy = true;
    req('GET', '/api/money' + (refresh ? '?refresh=1' : '')).then(function (p) { busy = false; P = p; render(); })
      .catch(function (e) { busy = false; root.innerHTML = '<div class="u-head"><div><h1>Money &amp; Scale</h1></div></div><div class="u-empty">Could not read the money picture: ' + E(e.message) + '. It needs the live app (Seen Command.command).</div>'; });
  };
})();
