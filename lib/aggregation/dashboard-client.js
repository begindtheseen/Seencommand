// Aggregation Dashboard — browser module. scripts/build-dashboard.mjs inlines this file into the
// Command Center page; it is plain browser JS (no imports) and defines exactly two globals:
//   window.AggUI          pure render functions (data → HTML string), unit-tested in node via vm
//   window.loadAggregation  the tab loader that showTab('aggregation') calls
// Honesty rules the renderers enforce: a metric the collector does not report renders as "—" with a
// "not reported" tooltip (never 0); partial runs are never shown as plain success; each pipeline keeps
// its own colour, panel and history.
(function () {
  'use strict';
  var PIPE = {
    company_intel: { label: 'Company Intelligence', cls: 'agg-ci', icon: '◆' },
    indeed: { label: 'Indeed Jobs', cls: 'agg-in', icon: '▣' },
    career_site: { label: 'Career Sites (Chrome)', cls: 'agg-cs', icon: '◎' },
    applicant_reports: { label: 'Applicant Reports', cls: 'agg-ar', icon: '✦' },
    web_reports: { label: 'Google Reports (Chrome)', cls: 'agg-ar', icon: 'G' },
  };
  var ALL_PIPES = ['company_intel', 'indeed', 'career_site', 'applicant_reports', 'web_reports'];
  // Collectors that drive this Mac's Chrome take turns; Applicant Reports reads public APIs directly.
  var CHROME_PIPES = ['company_intel', 'indeed', 'career_site', 'web_reports'];
  var REPORT_PIPES = ['applicant_reports', 'web_reports'];
  var SOURCE_LABEL = { reddit: 'Reddit', google: 'Google' };
  var STATE_LABEL = { ready: 'Ready', running: 'Running', queued: 'Queued', completed: 'Completed', partial: 'Partially completed', blocked: 'Blocked', failed: 'Failed', degraded: 'Needs attention', cancelled: 'Cancelled', interrupted: 'Interrupted' };
  var STATE_TONE = { ready: 'ok', completed: 'ok', running: 'run', queued: 'run', partial: 'warn', degraded: 'warn', blocked: 'bad', failed: 'bad', cancelled: 'mute', interrupted: 'mute' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v, unreportedWhy) {
    if (v === null || v === undefined) return '<span class="agg-na" title="' + esc(unreportedWhy || 'not reported by the collector') + '">—</span>';
    return esc(Number(v).toLocaleString('en-US'));
  }
  function when(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function dur(ms) { if (ms == null) return '—'; var s = Math.round(ms / 1000); return s < 90 ? s + 's' : Math.round(s / 60) + 'm'; }
  function pill(state) { return '<span class="agg-pill ' + (STATE_TONE[state] || 'mute') + '">' + esc(STATE_LABEL[state] || state || 'unknown') + '</span>'; }
  function stat(label, value, hint) { return '<div class="agg-stat"><b>' + value + '</b><span>' + esc(label) + (hint ? ' <i title="' + esc(hint) + '">ⓘ</i>' : '') + '</span></div>'; }
  function checkRow(c) {
    var tone = c.status === 'ok' ? 'ok' : (c.blocking && c.status !== 'unknown' ? 'bad' : (c.informational ? 'mute' : 'warn'));
    return '<div class="agg-check ' + tone + '"><span class="agg-check-s">' + esc(c.status) + (c.blocking && c.status !== 'ok' ? ' · blocking' : '') + (c.modes ? ' · ' + esc(c.modes.join('/')) + ' only' : '') + '</span><b>' + esc(c.label) + '</b><p>' + esc(c.detail) + '</p>' + (c.fix ? '<p class="agg-fix"><b>Fix:</b> ' + esc(c.fix) + '</p>' : '') + '</div>';
  }

  // ---- Overview ------------------------------------------------------------------------------
  function pipelineCard(p) {
    var meta = PIPE[p.id] || { label: p.label, cls: '' };
    var rec = p.recent || {};
    var recLine = p.id === 'indeed'
      ? num(rec.value, 'no finished run reported a written count') + ' <small>listing rows written or refreshed · 7 days</small>'
      : p.id === 'career_site' ? num(rec.value, 'no finished run reported a saved count') + ' <small>jobs saved from career sites · 7 days</small>'
      : REPORT_PIPES.indexOf(p.id) >= 0 ? num(rec.value, 'no import run in the last 7 days (previews import nothing)') + ' <small>new applicant reports · 7 days</small>'
      : num(rec.value, 'no import run in the last 7 days (dry runs import nothing)') + ' <small>applicant reports</small> + ' + num(rec.commentary, 'no import run in the last 7 days') + ' <small>commentary · 7 days</small>';
    var active = p.activeRun ? '<div class="agg-active">' + pill(p.activeRun.status) + ' started ' + esc(when(p.activeRun.startedAt || p.activeRun.createdAt)) + (p.activeRun.waitingFor ? ' · waiting for the Browser Bridge' : '') + '</div>' : '';
    var probs = (p.problems || []).filter(function (x) { return x.status !== 'ok'; });
    return '<div class="agg-card ' + meta.cls + '">'
      + '<div class="agg-card-h"><span class="agg-icon">' + esc(meta.icon) + '</span><b>' + esc(meta.label) + '</b>' + pill(p.state) + '</div>'
      + '<p class="agg-sub">' + esc(p.executes || '') + '</p>' + active
      + '<div class="agg-kv"><span>Last run</span><span>' + (p.lastRun ? pill(p.lastRun.status) + ' ' + esc(when(p.lastRun.endedAt)) : 'never') + '</span>'
      + '<span>Last success</span><span>' + (p.lastSuccess ? esc(when(p.lastSuccess.endedAt)) : 'never') + '</span>'
      + '<span>Recent imports</span><span>' + recLine + '</span>'
      + '<span>Next scheduled</span><span>' + (p.schedule && p.schedule.enabled ? esc(when(p.schedule.nextRunAt)) : 'not scheduled') + '</span></div>'
      + (p.lastRun && p.lastRun.reason ? '<p class="agg-reason">' + esc(p.lastRun.reason) + '</p>' : '')
      + (probs.length ? '<div class="agg-probs"><div class="agg-lbl">Outstanding problems</div>' + probs.map(function (x) { return '<div class="agg-prob ' + (x.blocking ? 'bad' : 'warn') + '"><b>' + esc(x.label) + '</b> — ' + esc(x.detail) + '</div>'; }).join('') + '</div>' : '')
      + ((p.actions || []).length ? '<div class="agg-probs"><div class="agg-lbl">What you need to do</div>' + p.actions.map(function (a) { return '<div class="agg-act">→ ' + esc(a) + '</div>'; }).join('') + '</div>' : '')
      + '<div class="agg-card-f"><button class="agg-btn" data-agg-tab="' + esc(p.id === 'career_site' ? 'company_jobs' : p.id === 'web_reports' ? 'applicant_reports' : p.id) + '">Open ' + esc(p.id === 'career_site' ? 'Company jobs' : p.id === 'web_reports' ? 'Applicant Reports' : meta.label) + ' →</button></div></div>';
  }
  function renderOverview(status) {
    if (!status || !status.pipelines) return '<p class="muted">No status yet.</p>';
    var ps = status.pipelines;
    return '<div class="agg-note">' + esc(status.sharedResource || '') + ' Readiness checked ' + esc(when(status.checkedAt)) + '.</div>'
      + '<div class="agg-grid2">' + ALL_PIPES.filter(function (k) { return ps[k]; }).map(function (k) { return pipelineCard(ps[k]); }).join('') + '</div>';
  }

  // ---- shared run widgets --------------------------------------------------------------------
  function failureTable(cats) {
    if (!cats || !cats.length) return '<p class="muted">No failures recorded.</p>';
    return '<div class="agg-table"><div class="agg-tr head"><span>Category</span><span>Count</span><span>Example</span><span>Recovery</span></div>'
      + cats.map(function (c) { return '<div class="agg-tr"><span>' + esc(c.label) + (c.blocking ? ' <em class="agg-b">blocking</em>' : '') + '</span><span>' + esc(c.count) + '</span><span class="agg-mono">' + esc(c.example) + '</span><span>' + esc(c.fix) + '</span></div>'; }).join('') + '</div>';
  }
  function runHeader(run) {
    if (!run) return '';
    return '<div class="agg-runh">' + pill(run.status) + ' <b>' + esc(when(run.startedAt || run.createdAt)) + '</b> · ' + esc(run.trigger) + (run.mode && run.mode !== 'run' ? ' · ' + esc(run.mode === 'dry_run' ? 'dry run' : 'import') : '') + ' · ' + esc(dur(run.durationMs)) + ' · <span class="agg-mono">' + esc(run.id) + '</span>'
      + (run.reason ? '<p class="agg-reason">' + esc(run.reason) + '</p>' : '') + '</div>';
  }
  function indeedResults(run) {
    if (!run) return '<p class="muted">No Indeed run yet.</p>';
    var m = run.metrics || {}; var d = run.diagnostics || {}; var dup = d.duplicates || {}; var rx = d.retryExhausted || {};
    var dead = 'not reported — the CLI stopped before printing metrics';
    return runHeader(run)
      + '<div class="agg-stats">' + stat('Searches attempted', num(m.searchesAttempted, dead)) + stat('Searches failed', num(m.searchesFailed, dead)) + stat('Raw search hits', num(m.rawSearchHits, dead))
      + stat('Unique listings', num(m.uniqueListings, dead)) + stat('Details OK', num(m.detailsSucceeded, dead)) + stat('Details failed', num(m.detailsFailed, dead), rx.note)
      + stat('Accepted by Seen', num(m.accepted, dead)) + stat('Rejected by Seen', num(m.rejected, dead), 'failed Seen’s quality checks (bad URL, location-like employer…)')
      + stat('Rows written', num(m.written, dead), 'written or refreshed — Seen does not split new vs. updated') + stat('Inserted / updated', num(m.inserted, 'Seen does not report the insert/update split for this merge path') + ' / ' + num(m.updated, 'not reported by Seen')) + '</div>'
      + '<div class="agg-lbl">Duplicates</div><div class="agg-kv"><span>Source duplicates</span><span>' + num(dup.source, dead) + ' <small>same job key across searches/pages</small></span><span>Merged by Seen</span><span>' + num(dup.server, dead) + ' <small>inside a batch</small></span><span>Already in database</span><span>' + num(dup.alreadyInDatabase, 'Seen does not report this distinction') + '</span></div><p class="agg-sub">' + esc(dup.note || '') + '</p>'
      + '<div class="agg-lbl">Failures by category</div>' + failureTable(d.failureCategories)
      + (d.warnings && d.warnings.length ? '<details><summary>Collector warnings (' + d.warnings.length + ')</summary><pre class="agg-pre">' + esc(d.warnings.join('\n')) + '</pre></details>' : '');
  }
  function intelResults(run) {
    if (!run) return '<p class="muted">No Company Intelligence run yet.</p>';
    var m = run.metrics || {}; var d = run.diagnostics || {};
    var dry = m.dryRun ? 'dry run — nothing was sent to Seen' : 'not reported by the collector';
    return runHeader(run)
      + '<div class="agg-stats">' + stat('Companies targeted', num(m.companiesTargeted)) + stat('Sources queried', esc((m.sourcesQueried || []).join(', ') || '—'))
      + stat('Excerpts collected', num(m.excerptsCollected)) + stat('Accepted', num(m.accepted, dry)) + stat('Applicant reports', num(m.importedReports, dry), 'first-person hiring outcomes → low-trust, source-labeled imported reports')
      + stat('Commentary', num(m.commentary, dry), 'stays under “What people are saying online”; never affects grades') + stat('Duplicates', num(m.duplicates, dry), 'already in Seen’s registry (source URL + excerpt hash)')
      + stat('Rejected', num(m.rejected, dry), 'invalid items and unknown companies — rejected, never created') + stat('Unmatched identities', num(m.unmatchedIdentities, (d.unmatched && d.unmatched.note) || 'not reported'))
      + stat('Source failures', num((m.searchFailures || 0) + (m.threadFailures || 0))) + stat('Duration', esc(dur(run.durationMs))) + '</div>'
      + ((d.rejectionReasons || []).length ? '<div class="agg-lbl">Why Seen rejected items</div>' + d.rejectionReasons.map(function (r) { return '<div class="agg-prob warn">' + esc(r) + '</div>'; }).join('') : '')
      + '<div class="agg-lbl">Provenance</div><p class="agg-sub">' + esc(d.provenance || '') + '</p>'
      + ((d.identityReview || []).length ? '<div class="agg-lbl">Identity review</div>' + d.identityReview.map(function (x) { return '<div class="agg-prob warn"><b>' + esc(x.company) + '</b> — ' + esc(x.reason) + '</div>'; }).join('') : '')
      + ((d.perCompany || []).length ? '<details><summary>Per company (' + d.perCompany.length + ')</summary><div class="agg-table">' + d.perCompany.map(function (c) { return '<div class="agg-tr two"><span>' + esc(c.company) + (c.slugLike ? ' <em class="agg-b warn">slug?</em>' : '') + '</span><span>' + esc(c.excerpts) + ' raw excerpts</span></div>'; }).join('') + '</div></details>' : '')
      + ((d.sourceFailures || []).length ? '<details><summary>Source failures (' + d.sourceFailures.length + ')</summary><pre class="agg-pre">' + esc(d.sourceFailures.map(function (f) { return f.stage + ' · ' + f.company + (f.post ? ' · ' + f.post : '') + ': ' + f.error; }).join('\n')) + '</pre></details>' : '')
      + '<div class="agg-lbl">Failures by category</div>' + failureTable(d.failureCategories);
  }
  var METHOD = { tesla_feed: 'the site’s own job feed', page_scroll: 'scrolled the job list', pages: 'opened job pages one by one' };
  function careerResults(run) {
    if (!run) return '<p class="muted">No career-site run yet.</p>';
    var m = run.metrics || {}; var d = run.diagnostics || {};
    var dead = 'not reported — the collector stopped before printing its summary';
    var skipped = Object.keys(d.skipped || {}).map(function (k) { return k.replace(/_/g, ' ') + ' ' + d.skipped[k]; }).join(' · ');
    return runHeader(run)
      + '<div class="agg-stats">' + stat('Sites', num(m.sites, dead)) + stat('Jobs listed', num(m.listed, dead), 'jobs the site’s own list or its scrolled page showed') + stat('Pages opened', num(m.pagesRead, dead))
      + stat('Postings found', num(m.postingsFound, dead), 'schema.org JobPosting data on the pages') + stat('Saved by Seen', num(m.saved, m.dryRun ? 'dry run — nothing was sent to Seen' : dead))
      + stat('Skipped by Seen', num(m.skipped, dead), 'another employer, outside the US, expired, or failed the quality gate') + stat('No job data', num(m.noData, dead), 'listed jobs whose page carried no job data Seen can read — never invented') + stat('Sites that failed', num(m.sitesFailed, dead)) + '</div>'
      + (skipped ? '<p class="agg-sub">Seen skipped: ' + esc(skipped) + '</p>' : '')
      + ((d.perSite || []).length ? '<div class="agg-lbl">Per site</div><div class="agg-table">' + d.perSite.map(function (x) { return '<div class="agg-tr"><span>' + esc(x.company) + '</span><span>' + esc(x.saved) + ' saved</span><span class="agg-mono">' + esc(x.startUrl) + '</span><span>' + esc((x.method ? (METHOD[x.method] || x.method) + ' · ' : '') + (x.listed ? x.listed + ' listed · ' : '') + x.postingsFound + ' with job data' + (x.noData ? ' · ' + x.noData + ' without' : '') + (x.errors.length ? ' · ' + x.errors[0] : '') + ((x.notes || []).length ? ' · note: ' + x.notes[0] : '')) + '</span></div>'; }).join('') + '</div>' : '')
      + '<p class="agg-sub">' + esc(d.note || '') + '</p>'
      + '<div class="agg-lbl">Failures by category</div>' + failureTable(d.failureCategories);
  }
  var STOP_LABEL = { goal: 'reached the goal', exhausted: 'no more to find', time: 'out of time', unsearchable_name: 'name too short to search', error: 'error', google_blocked: 'Google CAPTCHA — stopped' };
  function reportsResults(run) {
    if (!run) return '<p class="muted">No Applicant Reports run yet.</p>';
    var m = run.metrics || {}; var d = run.diagnostics || {};
    var dead = 'not reported — the collector stopped before printing its summary';
    var dry = m.dryRun ? 'preview — nothing was sent to Seen' : dead;
    return runHeader(run)
      + '<div class="agg-stats">' + stat('Companies', num(m.companiesDone, dead)) + stat('Accounts found', num(m.accountsFound, dead), 'first-hand applicant accounts that passed Seen’s rules')
      + stat('New reports', num(m.newReports, dry), 'new report rows Seen accepted — the goal counts these') + stat('Published', num(m.published, dry), 'public discussion, Reddit trust tier (0.3), tag reddit_rule_match')
      + stat('Already in Seen', num(m.duplicates, dry)) + stat('Kept as commentary', num(m.downgraded, dry), 'Seen’s re-check did not read it as a first-hand applicant account')
      + stat(run.pipeline === 'web_reports' ? 'Pages read' : 'Threads read', num(m.threadsRead, dead)) + stat('Failed searches', num(m.failedSearches, dead), 'archive searches that failed even after the title-only retry') + '</div>'
      + (m.bySource && Object.keys(m.bySource).length ? '<p class="agg-sub">By source: ' + esc(Object.keys(m.bySource).map(function (k) { var b = m.bySource[k]; return (SOURCE_LABEL[k] || k) + ' — ' + (m.dryRun ? b.found + ' found' : (b.newReports == null ? '—' : b.newReports) + ' new of ' + b.found + ' found'); }).join(' · ')) + '</p>' : '')
      + (m.googleBlocked ? '<p class="agg-prob warn">Google asked this Mac for a CAPTCHA (“unusual traffic”), so Google stopped for this run. It is never solved. Wait an hour or two, or raise the pause between searches, then run again.</p>' : '')
      + ((d.perCompany || []).length ? '<div class="agg-lbl">Per company</div><div class="agg-table"><div class="agg-tr ar head"><span>Company</span><span>New</span><span>Found</span><span>Already had</span><span>Stopped</span></div>'
        + d.perCompany.map(function (c) { return '<div class="agg-tr ar"><span>' + esc(c.company) + ((c.companySubs || []).length ? '<br><small>r/' + esc(c.companySubs.join(', r/')) + '</small>' : '') + '</span><span><b>' + num(c.newReports, dry) + '</b></span><span>' + num(c.found) + '</span><span>' + num(c.duplicates, dry) + '</span><span>' + esc(STOP_LABEL[c.stoppedBy] || c.stoppedBy || '—') + ((c.error || (c.searchErrors || [])[0]) ? '<br><small>' + esc(c.error || c.searchErrors[0]) + '</small>' : '') + '</span></div>'; }).join('') + '</div>' : '')
      + ((d.notReached || []).length ? '<p class="agg-prob warn">Not reached before the run budget ran out (start another run to continue): ' + esc(d.notReached.slice(0, 20).join(', ')) + (d.notReached.length > 20 ? '…' : '') + '</p>' : '')
      + ((d.rejectionReasons || []).length ? '<div class="agg-lbl">Why Seen rejected items</div>' + d.rejectionReasons.map(function (r) { return '<div class="agg-prob warn">' + esc(r) + '</div>'; }).join('') : '')
      + '<div class="agg-lbl">Provenance</div><p class="agg-sub">' + esc(d.provenance || '') + '</p>'
      + '<div class="agg-lbl">Failures by category</div>' + failureTable(d.failureCategories);
  }
  function resultsFor(run) { return run.pipeline === 'indeed' ? indeedResults(run) : run.pipeline === 'career_site' ? careerResults(run) : REPORT_PIPES.indexOf(run.pipeline) >= 0 ? reportsResults(run) : intelResults(run); }
  function liveRun(run) {
    if (!run) return '';
    return '<div class="agg-live">' + runHeader(run) + '<div class="agg-lbl">Events</div><pre class="agg-pre">' + esc((run.events || []).map(function (e) { return when(e.at) + '  ' + e.text; }).join('\n')) + '</pre>'
      + ((run.stdoutTail || []).length ? '<div class="agg-lbl">Collector output (tail)</div><pre class="agg-pre">' + esc(run.stdoutTail.slice(-15).join('\n')) + '</pre>' : '')
      + ((run.stderrTail || []).length ? '<div class="agg-lbl">Collector warnings (tail)</div><pre class="agg-pre">' + esc(run.stderrTail.slice(-15).join('\n')) + '</pre>' : '') + '</div>';
  }
  // ---- shared tool pieces --------------------------------------------------------------------
  // Plain-language readiness banner: nothing when ready; otherwise the blockers and where to fix them.
  function readyBanner(health, pipe) {
    var h = health && health.pipelines && health.pipelines[pipe]; if (!h || h.status === 'ready') return '';
    var bad = (h.checks || []).filter(function (c) { return c.status !== 'ok' && !c.informational; });
    if (!bad.length) return '';
    return '<div class="agg-banner ' + (h.status === 'blocked' ? 'bad' : 'warn') + '"><b>' + (h.status === 'blocked' ? 'Not ready to run' : 'Runs, with warnings') + '</b>'
      + bad.slice(0, 3).map(function (c) { return '<div>' + esc(c.label) + ' — ' + esc(c.detail) + (c.fix ? ' <span class="agg-fixl">' + esc(c.fix) + '</span>' : '') + '</div>'; }).join('')
      + '<button class="agg-link" data-agg-tab="health">Open System Health →</button></div>';
  }
  function step(n, title, sub) { return '<div class="agg-step"><span class="agg-step-n">' + n + '</span><div><b>' + esc(title) + '</b>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div></div>'; }
  function seg(name, options, current) {
    return '<div class="agg-seg" role="radiogroup">' + options.map(function (o) { return '<button class="agg-seg-b' + (o.id === current ? ' on' : '') + '" role="radio" aria-checked="' + (o.id === current) + '" data-agg-' + name + '="' + esc(o.id) + '"><b>' + esc(o.label) + '</b><small>' + esc(o.sub) + '</small></button>'; }).join('') + '</div>';
  }
  function runFooter(pipe, status, label, note) {
    var p = status && status.pipelines && status.pipelines[pipe]; if (!p) return '';
    var busy = CHROME_PIPES.indexOf(pipe) >= 0 && CHROME_PIPES.some(function (k) { var o = status.pipelines[k]; return k !== pipe && o && o.activeRun && o.activeRun.status === 'running'; });
    var act = p.activeRun;
    return '<div class="agg-go">' + (act
      ? '<button class="agg-btn danger big" data-agg-cancel="' + esc(act.id) + '">Cancel ' + (act.status === 'queued' ? 'queued run' : 'run') + '</button>'
      : '<button class="agg-btn primary big" data-agg-start="' + esc(pipe) + '"' + (p.state === 'blocked' ? ' disabled title="Not ready — see above"' : '') + '>' + esc(busy ? label + ' (queues behind the other collector)' : label) + '</button>')
      + '<button class="agg-btn" data-agg-save="' + esc(pipe) + '" title="Scheduled runs use the saved setup">Save as the schedule’s setup</button>'
      + '<span class="agg-out" id="agg-out-' + esc(pipe) + '"></span>' + (note ? '<p class="agg-sub">' + note + '</p>' : '') + '</div>';
  }
  // One sentence that says what the last run did, before the detailed numbers.
  function lastRunSentence(run) {
    if (!run) return '';
    var m = run.metrics || {}; var n = function (v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); };
    if (run.pipeline === 'career_site') return n(m.saved) + ' jobs saved from ' + (m.listed ? n(m.listed) + ' jobs listed' : n(m.pagesRead) + ' pages') + ' on ' + n(m.sites) + ' career site' + (m.sites === 1 ? '' : 's') + ((m.methods || []).length ? ' (' + m.methods.map(function (x) { return METHOD[x] || x; }).join(', ') + ')' : '') + (m.sitesFailed ? ' · ' + n(m.sitesFailed) + ' could not be opened' : '');
    if (REPORT_PIPES.indexOf(run.pipeline) >= 0) {
      var bs = m.bySource || {}; var parts = Object.keys(bs).map(function (k) { return (SOURCE_LABEL[k] || k) + ' ' + n(m.dryRun ? bs[k].found : bs[k].newReports); });
      var by = parts.length > 1 ? ' (' + parts.join(' · ') + ')' : '';
      var gb = m.googleBlocked ? ' · Google asked for a CAPTCHA and was stopped' : '';
      if (m.dryRun) return 'Preview: ' + n(m.accountsFound) + ' first-hand applicant accounts found' + by + ' for ' + n(m.companiesDone) + ' compan' + (m.companiesDone === 1 ? 'y' : 'ies') + ' — nothing was sent to Seen' + gb;
      return n(m.newReports) + ' new applicant reports' + by + ' for ' + n(m.companiesDone) + ' compan' + (m.companiesDone === 1 ? 'y' : 'ies') + (m.reachedGoal ? ' · ' + n(m.reachedGoal) + ' reached the goal' : '') + (m.exhausted ? ' · ' + n(m.exhausted) + ' had no more to find' : '') + (m.duplicates ? ' · ' + n(m.duplicates) + ' already in Seen' : '') + (m.notReached ? ' · ' + n(m.notReached) + ' not reached (out of time)' : '') + gb;
    }
    if (run.pipeline === 'indeed') return n(m.written) + ' listings written or refreshed from ' + n(m.searchesSuccessful) + ' searches' + ((m.searchesFailed || m.detailsFailed) ? ' · ' + n(m.searchesFailed || 0) + ' searches and ' + n(m.detailsFailed || 0) + ' listings failed' : '');
    if (m.dryRun) return 'Preview: ' + n(m.excerptsCollected) + ' excerpts collected from ' + n(m.companiesTargeted) + ' companies — nothing was sent to Seen';
    return n(m.importedReports) + ' applicant reports and ' + n(m.commentary) + ' comments imported for ' + n(m.companiesTargeted) + ' companies' + (m.rejected ? ' · ' + n(m.rejected) + ' rejected' : '') + (m.duplicates ? ' · ' + n(m.duplicates) + ' already in Seen' : '');
  }
  function lastRun(pipe, status, detail) {
    var p = status.pipelines[pipe]; var live = p.activeRun ? (detail && detail.id === p.activeRun.id ? detail : p.activeRun) : null;
    if (live) return '<div class="agg-lbl">Running now</div>' + liveRun(live);
    var run = detail && detail.pipeline === pipe ? detail : null;
    if (!run) return '<div class="agg-lbl">Last run</div><p class="muted">No run yet.</p>';
    return '<div class="agg-lbl">Last run</div><p class="agg-sum">' + esc(lastRunSentence(run)) + '</p><details><summary>All numbers, failures and duplicates</summary>' + resultsFor(run) + '</details>';
  }

  // ---- Indeed: preset sets → search list → depth → start --------------------------------------
  var DEPTHS = [
    { id: 'quick', label: 'Quick', sub: '10 listings per search', rps: 10, pages: 1 },
    { id: 'standard', label: 'Standard', sub: '20 listings per search', rps: 20, pages: 1 },
    { id: 'deep', label: 'Deep', sub: '25 per search + a 2nd page', rps: 25, pages: 2 },
  ];
  var skey = function (s) { return String(s.query || '').trim().toLowerCase() + '|' + String(s.location || '').trim().toLowerCase(); };
  // Every set the operator can tap: Seen's presets (when Seen answered) + the operator's saved sets.
  function indeedSets(presets, saved) {
    var out = [];
    if (presets && presets.ok) {
      var mt = presets.maintenance || {};
      if ((mt.searches || []).length) out.push({ key: 'maintenance', kind: 'star', title: 'This week’s maintenance', sub: mt.searches.length + ' searches · ' + (mt.perNiche || 2) + ' from every niche · rotates weekly' + (mt.week ? ' (week ' + mt.week + ')' : ''), searches: mt.searches });
      var d = presets.demand || {};
      out.push({ key: 'demand', kind: 'people', title: 'What people searched on Seen', sub: d.error ? 'unavailable: ' + d.error : (d.searches || []).length + ' searches people ran 2+ times' + (d.days ? ' in ' + d.days + ' days' : ''), searches: d.searches || [], disabled: !!d.error || !(d.searches || []).length });
      var t = presets.thin || {};
      out.push({ key: 'thin', kind: 'warn', title: 'Thin coverage', sub: t.error ? 'unavailable' : (t.searches || []).length + ' searches that found under ' + (t.belowResults || 10) + ' results', searches: t.searches || [], disabled: !!t.error || !(t.searches || []).length });
      (presets.niches || []).forEach(function (n) { out.push({ key: 'niche:' + n.id, kind: 'niche', title: n.label, sub: n.searches.length + ' searches', searches: n.searches }); });
    }
    (saved || []).forEach(function (p) { out.push({ key: 'saved:' + p.name, kind: 'saved', title: p.name, sub: p.searches.length + ' searches · your set', searches: p.searches }); });
    return out;
  }
  // The run's searches: every picked set, then the operator's own additions, minus removed rows.
  function buildIndeedSearches(ui, sets) {
    var bySet = {}; (sets || []).forEach(function (s) { bySet[s.key] = s; });
    var out = []; var seen = {}; var removed = {}; (ui.removed || []).forEach(function (k) { removed[k] = true; });
    var add = function (s, from) { var k = skey(s); if (!s.query || seen[k] || removed[k]) return; seen[k] = true; out.push({ query: s.query, location: s.location || 'Remote', from: from }); };
    (ui.picked || []).forEach(function (k) { var set = bySet[k]; if (set) set.searches.forEach(function (s) { add(s, set.title); }); });
    (ui.extra || []).forEach(function (s) { add(s, 'added by you'); });
    return out;
  }
  function renderIndeed(cfgAll, status, health, detail, presets, ui) {
    var pc = cfgAll && cfgAll.pipelines && cfgAll.pipelines.indeed; if (!pc) return '<p class="muted">Configuration unavailable.</p>';
    var caps = pc.capabilities || {}; var p = status.pipelines.indeed; ui = ui || {};
    var sets = indeedSets(presets, pc.config.presets);
    var searches = buildIndeedSearches(ui, sets);
    var picked = {}; (ui.picked || []).forEach(function (k) { picked[k] = true; });
    var depth = DEPTHS.filter(function (d) { return d.rps === ui.rps && d.pages === ui.pages; })[0];
    var step10 = caps.pageStep || 10;
    var perSearch = (ui.rps || 20) + step10 * Math.max(0, (ui.pages || 1) - 1);
    var n = ui.maxSearches ? Math.min(ui.maxSearches, searches.length) : searches.length;
    var card = function (s) {
      return '<button class="agg-set ' + s.kind + (picked[s.key] ? ' on' : '') + '"' + (s.disabled && !picked[s.key] ? ' disabled' : '') + ' data-agg-set="' + esc(s.key) + '" aria-pressed="' + !!picked[s.key] + '">'
        + '<span class="agg-set-t">' + (picked[s.key] ? '✓ ' : '') + esc(s.title) + '</span><span class="agg-set-s">' + esc(s.sub) + '</span></button>';
    };
    var top = sets.filter(function (s) { return s.kind !== 'niche' && s.kind !== 'saved'; });
    var niches = sets.filter(function (s) { return s.kind === 'niche'; });
    var saved = sets.filter(function (s) { return s.kind === 'saved'; });
    var list = searches.length
      ? '<div class="agg-rows">' + searches.map(function (s, i) { return '<div class="agg-row"><span class="agg-row-q">' + esc(s.query) + '</span><span class="agg-row-l">' + esc(s.location) + '</span><span class="agg-row-f">' + esc(s.from) + '</span><button class="agg-x" title="Remove from this run" data-agg-rm="' + i + '">✕</button></div>'; }).join('') + '</div>'
      : '<p class="muted">No searches yet — tap a set above, or add one below.</p>';
    return '<div class="agg-panel agg-in agg-tool">'
      + '<div class="agg-card-h"><span class="agg-icon">▣</span><b>Indeed Jobs</b>' + pill(p.state) + '<span class="agg-env">pulls real Indeed listings into seenjobs.io</span></div>'
      + readyBanner(health, 'indeed')
      + (caps.found ? '' : '<p class="agg-prob bad">The Indeed collector was not found in the Seen checkout — fix the path in System Health.</p>')
      + step(1, 'Pick what to refresh', 'Tap a set to add its searches, tap again to take them out. Sets combine.')
      + (presets && !presets.ok ? '<p class="agg-prob warn">Seen’s presets are unavailable (' + esc(presets.error) + '). Your own sets and searches still work.</p>' : (!presets ? '<p class="muted">Loading Seen’s presets…</p>' : ''))
      + (top.length ? '<div class="agg-sets">' + top.map(card).join('') + '</div>' : '')
      + (niches.length ? '<div class="agg-lbl">Seen’s niches <small>— the same searches Seen’s refresh schedule keeps fresh</small></div><div class="agg-sets small">' + niches.map(card).join('') + '</div>' : '')
      + (saved.length ? '<div class="agg-lbl">Your saved sets</div><div class="agg-sets small">' + saved.map(card).join('') + '</div>' : '')
      + step(2, 'Searches in this run (' + searches.length + ')', 'Remove any you don’t want, or add your own.')
      + list
      + '<div class="agg-add"><input id="agg-add-q" maxlength="160" placeholder="Job title, e.g. forklift operator"/><input id="agg-add-l" maxlength="120" placeholder="Location, e.g. Dallas, TX or Remote"/><button class="agg-btn" id="agg-add-search">+ Add</button>'
      + (searches.length ? '<input id="agg-preset-name" maxlength="60" placeholder="Name this list to save it"/><button class="agg-btn" id="agg-preset-save">Save as a set</button>' : '') + '</div>'
      + step(3, 'How deep', 'Deeper runs find more listings per search and take longer.')
      + seg('depth', DEPTHS, depth ? depth.id : '')
      + '<details class="agg-adv"' + (depth ? '' : ' open') + '><summary>Advanced' + (depth ? '' : ' — custom depth') + '</summary><div class="agg-form">'
      + '<label>Listings per search<input type="number" id="agg-rps" min="1" max="' + esc(caps.resultsPerSearchMax || 25) + '" value="' + esc(ui.rps) + '"/><small>1–' + esc(caps.resultsPerSearchMax || 25) + '</small></label>'
      + '<label>Pages per search<input type="number" id="agg-pages" min="1" max="' + esc(caps.pagination === false ? 1 : (caps.maxPagesMax || 100)) + '" value="' + esc(ui.pages) + '"' + (caps.pagination === false ? ' disabled' : '') + '/><small>each extra page adds ~' + esc(step10) + ' listings</small></label>'
      + '<label>Only run the first<input type="number" id="agg-maxs" min="1" value="' + esc(ui.maxSearches || '') + '" placeholder="all"/><small>searches (empty = all)</small></label></div></details>'
      + runFooter('indeed', status, searches.length ? 'Start — ' + n + ' search' + (n === 1 ? '' : 'es') : 'Pick some searches first',
        searches.length ? 'Opens up to <b>' + esc((n * perSearch).toLocaleString('en-US')) + '</b> Indeed listings in your Chrome, one at a time. Listings go straight to seenjobs.io; ones Seen already has are refreshed, not duplicated.' : '')
      + lastRun('indeed', status, detail)
      + '</div>';
  }

  // ---- Company Intelligence: pick companies → mode/depth → start ---------------------------------
  var INTEL_DEPTHS = [
    { id: '3', label: 'Quick', sub: '3 threads per company', posts: 3 },
    { id: '5', label: 'Standard', sub: '5 threads per company', posts: 5 },
    { id: '10', label: 'Deep', sub: '10 threads per company', posts: 10 },
  ];
  var QUICK_PICKS = [
    { id: 'major', label: 'Major companies', sub: 'top 25 by open jobs — reach the most job seekers' },
    { id: 'needs', label: 'Need a grade', sub: '25 with open jobs but not enough reports for a grade' },
    { id: 'least', label: 'Least covered', sub: '25 with 10+ open jobs and the fewest reports' },
  ];
  var cmpNum = function (a, b) { return (a == null ? -1 : a) - (b == null ? -1 : b); };
  // Pure: which companies a quick pick selects. Unverified ATS slugs are never auto-picked.
  function quickPick(companies, kind, n) {
    n = n || 25;
    var real = (companies || []).filter(function (c) { return !c.slugLike; });
    var by = function (f) { return real.slice().sort(f).slice(0, n).map(function (c) { return c.company; }); };
    if (kind === 'major') return by(function (a, b) { return cmpNum(b.activeListings, a.activeListings) || a.company.localeCompare(b.company); });
    if (kind === 'needs') return real.filter(function (c) { return !c.graded && (c.activeListings || 0) >= 5; }).sort(function (a, b) { return cmpNum(b.activeListings, a.activeListings); }).slice(0, n).map(function (c) { return c.company; });
    if (kind === 'least') return real.filter(function (c) { return (c.activeListings || 0) >= 10; }).sort(function (a, b) { return cmpNum(a.applicantReports, b.applicantReports) || cmpNum(b.activeListings, a.activeListings); }).slice(0, n).map(function (c) { return c.company; });
    return [];
  }
  var SORTS = [{ id: 'jobs', label: 'Most open jobs' }, { id: 'fewest', label: 'Fewest reports' }, { id: 'most', label: 'Most reports' }, { id: 'name', label: 'A–Z' }];
  // Pure: the catalog filtered by the search box and sorted.
  function filterCatalog(companies, ui) {
    var q = String(ui.q || '').trim().toLowerCase();
    var list = (companies || []).filter(function (c) { return (!ui.hideSlugs || !c.slugLike) && (!q || c.company.toLowerCase().indexOf(q) >= 0); });
    var s = ui.sort || 'jobs';
    list.sort(s === 'name' ? function (a, b) { return a.company.localeCompare(b.company); }
      : s === 'fewest' ? function (a, b) { return cmpNum(a.applicantReports, b.applicantReports) || cmpNum(b.activeListings, a.activeListings); }
      : s === 'most' ? function (a, b) { return cmpNum(b.applicantReports, a.applicantReports) || cmpNum(b.activeListings, a.activeListings); }
      : function (a, b) { return cmpNum(b.activeListings, a.activeListings) || a.company.localeCompare(b.company); });
    return list;
  }
  function gradeCell(c) {
    if (c.graded) return '<span class="agg-g ok">graded</span>';
    if (c.reportsNeeded != null) return '<span class="agg-g">needs ' + esc(c.reportsNeeded) + ' more</span>';
    return '<span class="agg-g">—</span>';
  }
  function renderIntel(cfgAll, status, health, detail, catalog, ui) {
    var pc = cfgAll && cfgAll.pipelines && cfgAll.pipelines.company_intel; if (!pc) return '<p class="muted">Configuration unavailable.</p>';
    var caps = pc.capabilities || {}; var p = status.pipelines.company_intel; var modes = p.modes || {}; ui = ui || {};
    var picked = ui.picked || []; var isPicked = {}; picked.forEach(function (n) { isPicked[n.toLowerCase()] = true; });
    var view = catalog && catalog.ok ? filterCatalog(catalog.companies, ui) : [];
    var shown = view.slice(0, ui.show || 50);
    var depth = INTEL_DEPTHS.filter(function (d) { return d.posts === ui.posts; })[0];
    var canPick = caps.explicitTargets !== false;
    var table = !catalog ? '<p class="muted">Loading every company Seen knows… (reads all open listings, ~10 seconds)</p>'
      : !catalog.ok ? '<p class="agg-prob warn">The company list is unavailable: ' + esc(catalog.error) + '</p>'
      : '<div class="agg-cat-tools"><input id="agg-cat-q" placeholder="Find a company…" value="' + esc(ui.q || '') + '"/><select id="agg-cat-sort">' + SORTS.map(function (s) { return '<option value="' + s.id + '"' + ((ui.sort || 'jobs') === s.id ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') + '</select>'
        + '<label class="agg-chk"><input type="checkbox" id="agg-cat-slugs"' + (ui.hideSlugs ? ' checked' : '') + '/> hide unverified ATS names</label><span class="agg-sub">' + esc(view.length.toLocaleString('en-US')) + ' of ' + esc(catalog.total.toLocaleString('en-US')) + ' companies</span></div>'
        + '<div class="agg-cat"><div class="agg-cat-r head"><span></span><span>Company</span><span>Open jobs</span><span>Applicant reports</span><span>Employee reviews</span><span>Grade</span></div>'
        + shown.map(function (c, i) { var on = isPicked[c.company.toLowerCase()]; return '<label class="agg-cat-r' + (on ? ' on' : '') + '"><input type="checkbox" data-agg-co="' + i + '"' + (on ? ' checked' : '') + (canPick ? '' : ' disabled') + '/><span class="agg-cat-n">' + esc(c.company) + (c.slugLike ? ' <em class="agg-b warn">unverified name</em>' : '') + '</span><span>' + num(c.activeListings) + '</span><span>' + num(c.applicantReports) + '</span><span>' + num(c.employeeReviews, catalog.employeeReviewCounts ? 'not reported' : 'Seen does not store employee-review counts yet') + '</span><span>' + gradeCell(c) + '</span></label>'; }).join('')
        + '</div>' + (view.length > shown.length ? '<button class="agg-btn" id="agg-cat-more">Show ' + Math.min(50, view.length - shown.length) + ' more</button>' : '');
    var chips = picked.length ? '<div class="agg-chips"><b>' + picked.length + ' selected</b>' + picked.map(function (n, i) { return '<span class="agg-chip">' + esc(n) + '<button data-agg-unpick="' + i + '" title="Remove">✕</button></span>'; }).join('') + '<button class="agg-link" id="agg-pick-clear">Clear</button></div>'
      : '<p class="agg-sub">Nothing selected — Seen will choose its ' + esc(ui.companyLimit || 5) + ' most active companies.</p>';
    var mode = ui.mode || 'dry_run';
    var label = (mode === 'import' ? 'Import' : 'Preview') + ' — ' + (picked.length ? picked.length + ' compan' + (picked.length === 1 ? 'y' : 'ies') : 'Seen picks ' + (ui.companyLimit || 5));
    var count = picked.length || ui.companyLimit || 5;
    return '<div class="agg-panel agg-ci agg-tool">'
      + '<div class="agg-card-h"><span class="agg-icon">◆</span><b>Company Intelligence</b>' + pill(p.state) + '<span class="agg-env">collects public Reddit accounts of how companies hire</span></div>'
      + readyBanner(health, 'company_intel')
      + step(1, 'Pick companies', canPick ? 'Use a quick pick, or tick companies in the list. Up to 100 per run.' : 'This Seen checkout can’t take a company list yet — git pull it (next-migration, 2026-10-20+). Until then Seen chooses.')
      + (canPick ? '<div class="agg-sets small">' + QUICK_PICKS.map(function (q) { return '<button class="agg-set" data-agg-pick="' + q.id + '"' + (catalog && catalog.ok ? '' : ' disabled') + '><span class="agg-set-t">' + esc(q.label) + '</span><span class="agg-set-s">' + esc(q.sub) + '</span></button>'; }).join('')
        + '<button class="agg-set' + (picked.length ? '' : ' on') + '" data-agg-pick="seen"><span class="agg-set-t">' + (picked.length ? '' : '✓ ') + 'Let Seen choose</span><span class="agg-set-s">its most active companies (no list)</span></button></div>' : '')
      + chips + table
      + step(2, 'What to do with what it finds', '')
      + seg('mode', [{ id: 'dry_run', label: 'Preview only', sub: 'collect and show — sends nothing (' + (modes.dry_run || '?') + ')' }, { id: 'import', label: 'Import into Seen', sub: 'add to the company pages (' + (modes.import || '?') + ')' }], mode)
      + step(3, 'How deep', 'Reddit threads read per company.')
      + seg('posts', INTEL_DEPTHS, depth ? depth.id : '')
      + (picked.length ? '' : '<details class="agg-adv"><summary>Advanced</summary><div class="agg-form"><label>Companies Seen picks<input type="number" id="agg-climit" min="1" max="' + esc(caps.companyLimitMax || 100) + '" value="' + esc(ui.companyLimit || 5) + '"/><small>when nothing is selected</small></label></div></details>')
      + runFooter('company_intel', status, label, 'Reads up to <b>' + esc((count * (ui.posts || 3)).toLocaleString('en-US')) + '</b> Reddit threads in your Chrome. Excerpts stay word-for-word (contact details removed). Seen only accepts companies it already knows — a name it doesn’t know is rejected, never created.')
      + lastRun('company_intel', status, detail)
      + '</div>'
      + renderBoards(ui.boards, picked);
  }

  // Employer job boards: Seen pulls openings straight from company career sites (Greenhouse, Lever,
  // Ashby…) on its own every hour; this card pulls now, for the chosen companies or the stalest boards.
  function boardsSentence(r) {
    if (!r) return '';
    var t = r.at ? new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    var what = r.request && r.request.companies ? r.request.companies.length + ' chosen compan' + (r.request.companies.length === 1 ? 'y' : 'ies') : (r.boards + ' stalest boards');
    return t + ' · ' + what + ': ' + num(r.synced) + ' of ' + num(r.boards) + ' boards answered · <b>' + num(r.saved) + '</b> US/remote listings saved · ' + num(r.droppedOutsideMarket) + ' outside the US skipped'
      + (r.outOfTime ? ' · stopped at the time limit (the hourly sync picks up the rest)' : '');
  }
  function renderBoards(boards, picked) {
    picked = picked || []; boards = boards || {};
    var last = boards.last; var busy = !!boards.running || !!boards.pulling;
    var nf = last && last.notFound && last.notFound.length ? '<p class="agg-sub">No job board registered for: ' + esc(last.notFound.slice(0, 12).join(', ')) + (last.notFound.length > 12 ? '…' : '') + '. Seen finds boards as it sees their listings.</p>' : '';
    return '<div class="agg-panel agg-tool agg-boards"><div class="agg-card-h"><span class="agg-icon">▤</span><b>Employer job boards</b><span class="agg-env">openings straight from company career sites · US and remote only</span></div>'
      + '<p class="agg-sub">Seen already pulls these by itself every hour (Greenhouse, Lever, Ashby and more). Use this when you want a company’s jobs in now.</p>'
      + '<div class="agg-sets small">'
      + '<button class="agg-set" data-agg-boards="picked"' + (picked.length && !busy ? '' : ' disabled') + '><span class="agg-set-t">▶ ' + (picked.length ? 'Pull boards for the ' + picked.length + ' selected' : 'Select companies above to pull their boards') + '</span><span class="agg-set-s">up to 50 companies · about a minute</span></button>'
      + '<button class="agg-set" data-agg-boards="stalest"' + (busy ? ' disabled' : '') + '><span class="agg-set-t">▶ Pull the 200 stalest boards</span><span class="agg-set-s">whatever has waited longest · up to 4 minutes</span></button>'
      + '</div>'
      + '<p class="agg-out' + (boards.error ? ' bad' : ' ok') + '" id="agg-out-boards">' + (busy ? 'Pulling… Seen is reading the boards now.' : boards.error ? esc(boards.error) : last ? boardsSentence(last) : '') + '</p>'
      + nf + '</div>';
  }

  // Overview quick starts: one tap for the everyday runs.
  function renderQuick(status, presets, catalog, boards) {
    if (!status || !status.pipelines) return '';
    var mt = presets && presets.ok && presets.maintenance && presets.maintenance.searches.length ? presets.maintenance : null;
    var ib = status.pipelines.indeed && status.pipelines.indeed.state === 'blocked';
    var cb = status.pipelines.company_intel && status.pipelines.company_intel.state === 'blocked';
    var major = catalog && catalog.ok ? quickPick(catalog.companies, 'major', 10) : [];
    return '<div class="agg-quick"><div class="agg-lbl">Quick start</div><div class="agg-sets">'
      + '<button class="agg-set star" data-agg-quick="indeed-maintenance"' + (mt && !ib ? '' : ' disabled') + '><span class="agg-set-t">▶ Run this week’s Indeed maintenance</span><span class="agg-set-s">' + (mt ? mt.searches.length + ' searches · 2 from every niche · Standard depth' : (presets && !presets.ok ? 'presets unavailable: ' + esc(presets.error) : 'loading…')) + (ib ? ' · not ready' : '') + '</span></button>'
      + '<button class="agg-set" data-agg-boards="stalest"' + (boards && (boards.running || boards.pulling) ? ' disabled' : '') + '><span class="agg-set-t">▶ Pull 200 employer job boards now</span><span class="agg-set-s">' + (boards && (boards.running || boards.pulling) ? 'pulling…' : boards && boards.last ? 'last: ' + num(boards.last.saved) + ' listings saved' : 'Greenhouse · Lever · Ashby · US and remote only') + '</span></button>'
      + '<button class="agg-set" data-agg-tab="company_jobs"><span class="agg-set-t">▶ Find every job at a company</span><span class="agg-set-s">type Acme Corp, Globex… · job boards, career site, Adzuna, Indeed</span></button>'
      + '<button class="agg-set star" data-agg-quick="reports-fill"' + (status.pipelines.applicant_reports && status.pipelines.applicant_reports.state === 'blocked' ? ' disabled' : '') + '><span class="agg-set-t">▶ Fill the 25 thinnest companies to 10 reports</span><span class="agg-set-s">free Reddit archive · no Chrome · imports into Seen' + (status.pipelines.applicant_reports && status.pipelines.applicant_reports.state === 'blocked' ? ' · not ready' : '') + '</span></button>'
      + '<button class="agg-set" data-agg-quick="intel-major"' + (cb ? ' disabled' : '') + '><span class="agg-set-t">▶ Preview the top 10 major companies</span><span class="agg-set-s">' + (major.length ? esc(major.slice(0, 3).join(', ')) + '… · Reddit · sends nothing' : (catalog && !catalog.ok ? 'company list unavailable: ' + esc(catalog.error) : 'by open jobs · Reddit · sends nothing')) + (cb ? ' · not ready' : '') + '</span></button>'
      + '</div></div>';
  }

  // ---- Company jobs: name companies → every source tries them ---------------------------------
  // Pure: one company per line, optionally "Name | website" when its site is not name.com.
  var MAX_CJ = 10;
  function parseCompanyLines(text) {
    var companies = []; var websites = {}; var errors = []; var seen = {};
    String(text || '').split(/\r?\n/).forEach(function (line, i) {
      var parts = line.split('|'); var name = parts[0].replace(/[\u0000-\u001f\u007f]/g, '').trim(); var site = (parts.slice(1).join('|') || '').trim();
      if (!name) return;
      if (name.length > 120) { errors.push('Line ' + (i + 1) + ': a company name is at most 120 characters.'); return; }
      var k = name.toLowerCase(); if (seen[k]) return; seen[k] = true;
      companies.push(name); if (site) websites[name] = site;
    });
    if (companies.length > MAX_CJ) errors.push('Up to ' + MAX_CJ + ' companies per pull — ' + companies.length + ' listed.');
    return { companies: companies, websites: websites, errors: errors };
  }
  function boardCell(b) {
    if (!b) return '<span class="agg-na">—</span>';
    if (b.status === 'ok') return esc((b.boards || []).map(function (x) { return x.provider + (x.nameUnverified ? ' (name unverified)' : ''); }).join(', ')) + (b.registered === 'new' ? ' <em class="agg-b">found now</em>' : '') + '<br><small>' + num(b.kept) + ' US/remote of ' + num(b.fetched) + ' · <b>' + num(b.saved) + '</b> saved</small>';
    return '<small>' + esc(b.status === 'none' ? 'no job board found' : (b.note || b.status)) + '</small>';
  }
  function siteCell(c) {
    if (!c) return '<span class="agg-na">—</span>';
    if (c.status === 'ok') return esc(c.host || '') + '<br><small>' + num(c.read) + ' pages read · <b>' + num(c.saved) + '</b> saved' + (c.note ? ' · ' + esc(c.note) : '') + '</small>';
    if (c.status === 'blocked' || c.status === 'needs_browser') return esc(c.host || '') + '<br><small>' + (c.status === 'blocked' ? 'needs a full browser' : 'builds its pages in JavaScript') + ' → Chrome</small>';
    return '<small>' + esc(c.status === 'none' ? 'no readable career site found' : (c.note || c.status)) + '</small>';
  }
  function adzunaCell(a) {
    if (!a) return '<span class="agg-na">—</span>';
    if (a.status === 'ok') return '<small>' + num(a.thisCompany) + ' of ' + num(a.found) + ' are this employer · <b>' + num(a.saved) + '</b> saved</small>';
    return '<small>' + esc(a.note || a.status) + '</small>';
  }
  // A run this pull started: its live state from the status poll, else what the start call said.
  function runLine(label, pipe, ref, status) {
    if (!ref) return '';
    var body;
    if (ref.skipped) body = esc(ref.note || 'not needed');
    else if (!ref.ok) body = '<span class="agg-bad">not started — ' + esc(ref.error || 'unknown error') + (ref.blockers && ref.blockers.length ? ' (' + esc(ref.blockers.join(', ')) + ')' : '') + '</span>';
    else {
      var p = status && status.pipelines && status.pipelines[pipe]; var r = null;
      if (p && p.activeRun && p.activeRun.id === ref.id) r = p.activeRun; else if (p && p.lastRun && p.lastRun.id === ref.id) r = p.lastRun;
      body = r ? pill(r.status) + (r.waitingFor ? ' waiting for the Browser Bridge' : '') + (r.metrics ? ' ' + esc(lastRunSentence(r)) : '') + (r.reason ? ' <small>' + esc(r.reason) + '</small>' : '')
        : pill(ref.status) + ' <small>see History for the result</small>';
    }
    return '<div class="agg-kv"><span>' + esc(label) + '</span><span>' + body + '</span></div>';
  }
  function renderCompanyJobsResult(st, status) {
    if (!st) return '';
    var req = st.request || {}; var seen = st.seen;
    var head = '<div class="agg-lbl">' + (st.running ? 'Pulling now' : 'Last pull') + ' · ' + esc(when(st.startedAt)) + ' · ' + esc((req.companies || []).join(', ')) + '</div>';
    var server = !seen ? (st.running ? '<p class="agg-sub">Seen is checking job boards, career sites and Adzuna… (up to about 4 minutes)</p>' : (st.error ? '<p class="agg-prob bad">' + esc(st.error) + '</p>' : ''))
      : !seen.ok ? '<p class="agg-prob bad">Seen’s pull failed: ' + esc(seen.error) + '</p>'
      : '<p class="agg-sum">Seen saved <b>' + num(seen.saved) + '</b> US/remote listings from job boards, career sites and Adzuna.</p>'
        + '<div class="agg-cj"><div class="agg-cj-r head"><span>Company</span><span>Job boards</span><span>Career site</span><span>Adzuna</span><span>Saved</span></div>'
        + seen.results.map(function (r) { return '<div class="agg-cj-r"><span><b>' + esc(r.company) + '</b>' + (r.skipped ? '<br><small>' + esc(r.skipped) + '</small>' : '') + '</span><span>' + boardCell(r.boards) + '</span><span>' + siteCell(r.careerSite) + '</span><span>' + adzunaCell(r.adzuna) + '</span><span><b>' + num(r.saved) + '</b></span></div>'; }).join('') + '</div>';
    return '<div class="agg-cj-out">' + head + server
      + (req.indeed ? runLine('Indeed (this Mac)', 'indeed', st.indeedRun, status) : '')
      + (req.browser ? runLine('Career sites in Chrome', 'career_site', st.careerRun || (st.running ? { skipped: true, note: 'waits for Seen to say which sites need a full browser' } : null), status) : '')
      + '</div>';
  }
  function renderCompanyJobs(status, health, cj, ui, intelPicked) {
    ui = ui || {}; cj = cj || {};
    var parsed = parseCompanyLines(ui.text);
    var running = !!cj.running || !!ui.starting;
    var n = parsed.companies.length;
    var ip = (intelPicked || []).slice(0, MAX_CJ);
    var st = function (pipe) { var p = status && status.pipelines && status.pipelines[pipe]; return p ? pill(p.state) : ''; };
    var ok = n > 0 && !parsed.errors.length && !running;
    return '<div class="agg-panel agg-cs agg-tool">'
      + '<div class="agg-card-h"><span class="agg-icon">⌕</span><b>Company jobs</b><span class="agg-env">every source tries the companies you name · US and remote only</span></div>'
      + '<p class="agg-sub">Type a company, for example Acme Corp. Seen checks its job boards (and registers them for the hourly sync), reads its own career site, and keeps Adzuna listings that are really that employer. Indeed searches it from this Mac, and a career site that refuses servers is read in your Chrome.</p>'
      + step(1, 'Companies (1–' + MAX_CJ + ')', 'One per line. Add “| website” when the site is not the name — or paste the careers page itself: Acme Corp | https://careers.acme.example/search')
      + '<textarea id="agg-cj-text" class="agg-cj-text" rows="4" maxlength="2400" placeholder="Acme Corp&#10;Globex | globex.example&#10;Initech">' + esc(ui.text || '') + '</textarea>'
      + (ip.length ? '<button class="agg-link" id="agg-cj-use">Use the ' + ip.length + ' compan' + (ip.length === 1 ? 'y' : 'ies') + ' selected in Company Intelligence</button>' : '')
      + (parsed.errors.length ? parsed.errors.map(function (e) { return '<p class="agg-prob warn">' + esc(e) + '</p>'; }).join('') : '')
      + step(2, 'Sources', 'Seen’s server sources always run. The two Chrome sources take turns with the other collectors.')
      + '<div class="agg-cj-src"><label class="agg-chk"><input type="checkbox" checked disabled/> Job boards · career site · Adzuna <small>(Seen’s server)</small></label>'
      + '<label class="agg-chk"><input type="checkbox" id="agg-cj-indeed"' + (ui.indeed !== false ? ' checked' : '') + '/> Indeed <small>(this Mac’s Chrome, 25 per company)</small> ' + st('indeed') + '</label>'
      + '<label class="agg-chk"><input type="checkbox" id="agg-cj-browser"' + (ui.browser !== false ? ' checked' : '') + '/> Career sites that need a full browser <small>(this Mac’s Chrome)</small> ' + st('career_site') + '</label></div>'
      + readyBanner(health, 'career_site')
      + '<details class="agg-adv"><summary>Advanced</summary><div class="agg-form"><label>Career-site pages Seen reads per company<input type="number" id="agg-cj-limit" min="1" max="150" value="' + esc(ui.siteLimit || 40) + '"/><small>1–150 (server)</small></label></div></details>'
      + '<div class="agg-go"><button class="agg-btn primary big" id="agg-cj-go"' + (ok ? '' : ' disabled') + '>' + esc(running ? 'Pulling…' : n ? 'Find jobs for ' + n + ' compan' + (n === 1 ? 'y' : 'ies') : 'Type a company first') + '</button><span class="agg-out" id="agg-out-company_jobs"></span></div>'
      + renderCompanyJobsResult(cj.last, status)
      + '</div>';
  }

  // ---- Applicant Reports: coverage → which companies → preview/import → how many → start ----------
  // Pure: how well applicant reports cover the companies people can apply to now (open listings).
  function coverage(companies, k) {
    k = k || 10;
    var live = (companies || []).filter(function (c) { return (c.activeListings || 0) > 0 && c.applicantReports != null; });
    var reports = 0; var atK = 0; var none = 0; var short = 0;
    live.forEach(function (c) { reports += c.applicantReports; if (c.applicantReports >= k) atK++; if (!c.applicantReports) none++; short += Math.max(0, k - c.applicantReports); });
    return { companies: live.length, reports: reports, perCompany: live.length ? reports / live.length : null, atK: atK, under: live.length - atK, none: none, shortfall: short, k: k };
  }
  // Pure: the N companies with the most open jobs that are under K reports (what "Fill" asks Seen for).
  function thinnest(companies, k, n) {
    return (companies || []).filter(function (c) { return !c.slugLike && (c.activeListings || 0) > 0 && c.applicantReports != null && c.applicantReports < (k || 10); })
      .sort(function (a, b) { return cmpNum(b.activeListings, a.activeListings) || cmpNum(a.applicantReports, b.applicantReports); }).slice(0, n || 25).map(function (c) { return c.company; });
  }
  // Pure: one company per line → a clean, de-duplicated list (≤500).
  function parseNameLines(text) {
    var out = []; var seen = {}; var errors = [];
    String(text || '').split(/\r?\n/).forEach(function (line, i) {
      var n = line.replace(/[\u0000-\u001f\u007f]/g, '').trim(); if (!n) return;
      if (n.length > 120) { errors.push('Line ' + (i + 1) + ': a company name is at most 120 characters.'); return; }
      var key = n.toLowerCase(); if (seen[key]) return; seen[key] = true; out.push(n);
    });
    if (out.length > 500) errors.push('Up to 500 companies per run — ' + out.length + ' listed.');
    return { companies: out, errors: errors };
  }
  var GOALS = [
    { id: '10', label: '10', sub: 'per company, then the next', goal: 10 },
    { id: '25', label: '25', sub: 'per company', goal: 25 },
    { id: '100', label: '100', sub: 'per company', goal: 100 },
    { id: '0', label: 'No cap', sub: 'every account it can find', goal: 0 },
  ];
  function coverageBlock(catalog, k) {
    if (!catalog) return '<p class="muted">Loading coverage… (reads every company Seen knows, ~10 seconds)</p>';
    if (!catalog.ok) return '<p class="agg-prob warn">Coverage is unavailable: ' + esc(catalog.error) + '</p>';
    var c = coverage(catalog.companies, k);
    var ratio = c.perCompany == null ? '—' : (Math.round(c.perCompany * 10) / 10).toLocaleString('en-US') + '×';
    var tone = c.perCompany == null ? 'warn' : c.perCompany >= 5 ? 'ok' : 'warn';
    return '<div class="agg-cov"><div class="agg-cov-big ' + tone + '"><b>' + esc(ratio) + '</b><span>applicant reports per company with open jobs<br><small>goal: 5–10×</small></span></div>'
      + '<div class="agg-stats">' + stat('Companies with open jobs', num(c.companies)) + stat('Their applicant reports', num(c.reports)) + stat('At ' + k + '+ reports', num(c.atK))
      + stat('Under ' + k, num(c.under)) + stat('With none', num(c.none)) + stat('Reports short of ' + k + ' everywhere', num(c.shortfall), 'the sum of what each company is missing to reach ' + k) + '</div></div>';
  }
  // Pure: which collectors a Collect press starts — the archive one for Reddit, the Chrome
  // one for Google — given the ticked sources and what each checked-out collector supports.
  function reportsPlan(ui, archiveCaps, webCaps) {
    var src = (ui && ui.src) || {}; var avail = (archiveCaps && archiveCaps.sources) || (archiveCaps && archiveCaps.found ? ['reddit'] : []);
    var archive = avail.filter(function (k) { return src[k] !== false; });
    return { archive: archive, google: !!(webCaps && webCaps.found) && src.google === true };
  }
  function reportsFooter(status, plan, label, note) {
    var a = status.pipelines.applicant_reports || {}; var w = status.pipelines.web_reports || {};
    var acts = [a.activeRun, w.activeRun].filter(Boolean);
    var none = !plan.archive.length && !plan.google;
    var blocked = (plan.archive.length && a.state === 'blocked') || (plan.google && w.state === 'blocked');
    return '<div class="agg-go">' + acts.map(function (r) { return '<button class="agg-btn danger big" data-agg-cancel="' + esc(r.id) + '">Cancel ' + esc((PIPE[r.pipeline] || {}).label || r.pipeline) + (r.status === 'queued' ? ' (queued)' : '') + '</button>'; }).join('')
      + (acts.length ? '' : '<button class="agg-btn primary big" id="agg-ar-go"' + (none || blocked ? ' disabled title="' + (none ? 'Tick at least one source' : 'Not ready — see above') + '"' : '') + '>' + esc(label) + '</button>')
      + '<button class="agg-btn" id="agg-ar-save" title="Scheduled runs use the saved setup">Save as the schedule’s setup</button>'
      + '<span class="agg-out" id="agg-out-applicant_reports"></span>' + (note ? '<p class="agg-sub">' + note + '</p>' : '') + '</div>';
  }
  function renderReports(cfgAll, status, health, detail, catalog, ui, detailWeb) {
    var pc = cfgAll && cfgAll.pipelines && cfgAll.pipelines.applicant_reports; if (!pc) return '<p class="muted">Configuration unavailable.</p>';
    var caps = pc.capabilities || {}; var p = status.pipelines.applicant_reports; var modes = p.modes || {}; ui = ui || {};
    var wc = (cfgAll.pipelines.web_reports || {}).capabilities || {}; var wp = status.pipelines.web_reports;
    var plan = reportsPlan(ui, caps, wc); var src = ui.src || {};
    var k = ui.fillBelow || 10;
    var how = ui.how === 'list' || !caps.fillBelow ? 'list' : 'fill';
    var parsed = parseNameLines(ui.text);
    var goal = GOALS.filter(function (g) { return g.goal === ui.goal; })[0];
    var mode = ui.mode || 'dry_run';
    var n = how === 'list' ? parsed.companies.length : (ui.companyLimit || 25);
    var ready = how === 'fill' || (n > 0 && !parsed.errors.length);
    var picks = catalog && catalog.ok ? thinnest(catalog.companies, k, 25) : [];
    var ip = ui.intelPicked || [];
    var srcNames = plan.archive.map(function (k) { return SOURCE_LABEL[k] || k; }).concat(plan.google ? ['Google'] : []);
    var label = !ready ? 'Name some companies first' : !srcNames.length ? 'Tick a source first' : (mode === 'import' ? 'Collect and import' : 'Preview') + ' — ' + (how === 'fill' ? 'the ' + n + ' thinnest' : n + ' compan' + (n === 1 ? 'y' : 'ies')) + ' · ' + srcNames.join(' + ');
    var chk = function (k, title, sub, on, disabled, st) { return '<label class="agg-chk"><input type="checkbox" data-agg-arsrc="' + k + '"' + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '/> ' + esc(title) + ' <small>' + esc(sub) + '</small> ' + (st ? pill(st.state) : '') + '</label>'; };
    var avail = caps.sources || ['reddit'];
    return '<div class="agg-panel agg-ar agg-tool">'
      + '<div class="agg-card-h"><span class="agg-icon">✦</span><b>Applicant Reports</b>' + pill(p.state) + '<span class="agg-env">first-hand applicant accounts from Reddit and Google · free</span></div>'
      + readyBanner(health, 'applicant_reports')
      + (caps.found ? '' : '<p class="agg-prob bad">The applicant-report collector was not found in the Seen checkout — git pull it, or fix the path in System Health.</p>')
      + coverageBlock(catalog, k)
      + step(1, 'Which companies', 'Fill the thinnest: Seen hands over the companies with open jobs and the fewest reports, most jobs first. Or name your own.')
      + seg('arhow', [{ id: 'fill', label: 'Fill the thinnest', sub: caps.fillBelow ? 'companies under ' + k + ' reports' : 'needs a newer Seen checkout' }, { id: 'list', label: 'Companies I name', sub: 'one per line, up to 500' }], how)
      + (how === 'fill'
        ? '<div class="agg-form"><label>Under this many reports<input type="number" id="agg-ar-below" min="1" max="' + esc((caps.fillBelow || {}).max || 10000) + '" value="' + esc(k) + '"/><small>companies Seen picks have fewer than this</small></label>'
          + '<label>Companies this run<input type="number" id="agg-ar-limit" min="1" max="' + esc((caps.companyLimit || {}).max || 100) + '" value="' + esc(ui.companyLimit || 25) + '"/><small>1–' + esc((caps.companyLimit || {}).max || 100) + '</small></label></div>'
          + (picks.length ? '<p class="agg-sub">Next up: ' + esc(picks.slice(0, 8).join(', ')) + (picks.length > 8 ? '…' : '') + '</p>' : '')
        : '<textarea id="agg-ar-text" class="agg-cj-text" rows="5" maxlength="60000" placeholder="Acme Corp&#10;Globex&#10;Initech">' + esc(ui.text || '') + '</textarea>'
          + '<div class="agg-ctl">' + (picks.length ? '<button class="agg-link" id="agg-ar-thin">Use the ' + picks.length + ' with the most open jobs under ' + esc(k) + ' reports</button>' : '')
          + (ip.length ? '<button class="agg-link" id="agg-ar-intel">Use the ' + ip.length + ' selected in Company Intelligence</button>' : '') + '<span class="agg-sub">' + esc(parsed.companies.length) + ' named</span></div>'
          + parsed.errors.map(function (e) { return '<p class="agg-prob warn">' + esc(e) + '</p>'; }).join(''))
      + step(2, 'Sources', 'Every ticked source runs for the same companies. The Reddit archive needs no browser; Google runs in this Mac’s Chrome and takes turns with the other Chrome collectors.')
      + '<div class="agg-cj-src">'
      + chk('reddit', 'Reddit archive', 'the company’s own subreddits + the job subreddits, 5 years', src.reddit !== false && avail.indexOf('reddit') >= 0, avail.indexOf('reddit') < 0, null)
      + chk('google', 'Google', wc.found ? 'every open page it finds, in this Mac’s Chrome, ' + (ui.gap || 25) + ' s between searches' : 'needs a newer Seen checkout', src.google === true && !!wc.found, !wc.found, wp)
      + '</div>'
      + (plan.google ? readyBanner(health, 'web_reports') : '')
      + '<p class="agg-sub">Not read: Hacker News (not an applicant-review source), Glassdoor, Indeed, LinkedIn, Facebook, X and TikTok (their posts belong to their users under those sites’ terms), video sites and job boards. If Google asks for a CAPTCHA, Google stops for the run — it is never solved.</p>'
      + step(3, 'What to do with what it finds', '')
      + seg('armode', [{ id: 'dry_run', label: 'Preview only', sub: 'find and show — sends nothing (' + (modes.dry_run || '?') + ')' }, { id: 'import', label: 'Import into Seen', sub: 'Seen re-checks each one, then publishes (' + (modes.import || '?') + ')' }], mode)
      + step(4, 'New reports per company', 'At least this many. It moves on to the next company once this many NEW reports are in Seen (accounts Seen already has don’t count). No cap = everything the archive holds.')
      + seg('argoal', GOALS, goal ? goal.id : '')
      + '<details class="agg-adv"' + (goal ? '' : ' open') + '><summary>Advanced' + (goal ? '' : ' — custom goal') + '</summary><div class="agg-form">'
      + '<label>New reports per company<input type="number" id="agg-ar-goal" min="0" max="' + esc((caps.goal || {}).max || 100000) + '" value="' + esc(ui.goal) + '"/><small>0 = no cap</small></label>'
      + '<label>Years of history<input type="number" id="agg-ar-years" min="1" max="' + esc((caps.years || {}).max || 10) + '" value="' + esc(ui.years || 5) + '"/><small>newest first</small></label>'
      + '<label>Minutes per company<input type="number" id="agg-ar-mins" min="1" max="' + esc((caps.minutesPerCompany || {}).max || 240) + '" value="' + esc(ui.minutes || 10) + '"/><small>then the next company</small></label>'
      + (wc.found ? '<label>Seconds between Google searches<input type="number" id="agg-ar-gap" min="' + esc((wc.searchGapSeconds || {}).min || 10) + '" max="' + esc((wc.searchGapSeconds || {}).max || 600) + '" value="' + esc(ui.gap || 25) + '"/><small>slower is gentler on Google</small></label>'
        + '<label>Google pages read per company<input type="number" id="agg-ar-pages" min="1" max="' + esc((wc.pagesPerCompany || {}).max || 200) + '" value="' + esc(ui.pages || 30) + '"/><small>result pages opened</small></label>' : '')
      + '</div></details>'
      + reportsFooter(status, plan, label, 'Only first-hand accounts pass (the company named, the speaker the applicant, not advice, hearsay, lists or another employer). Words stay as written, contact details removed, each with its link, and Seen re-checks every one. A run stops itself after ' + esc(Math.floor(230 / 60)) + 'h ' + esc(230 % 60) + 'm; reports already sent stay.')
      + '<div class="agg-lbl">Reddit archive</div>' + lastRun('applicant_reports', status, detail).replace(/^<div class="agg-lbl">[^<]*<\/div>/, '')
      + (wc.found ? '<div class="agg-lbl">Google (this Mac’s Chrome)</div>' + lastRun('web_reports', status, detailWeb).replace(/^<div class="agg-lbl">[^<]*<\/div>/, '') : '')
      + '</div>';
  }

  // ---- History -------------------------------------------------------------------------------
  function renderHistory(runs, f) {
    f = f || {};
    var opt = function (v, l, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>'; };
    var filters = '<div class="agg-filters"><select id="agg-f-pipe">' + opt('', 'All pipelines', f.pipeline || '') + opt('company_intel', 'Company Intelligence', f.pipeline) + opt('indeed', 'Indeed Jobs', f.pipeline) + opt('career_site', 'Career Sites (Chrome)', f.pipeline) + opt('applicant_reports', 'Applicant Reports', f.pipeline) + opt('web_reports', 'Google Reports (Chrome)', f.pipeline) + '</select>'
      + '<select id="agg-f-status">' + opt('', 'Any status', f.status || '') + ['completed', 'partial', 'failed', 'blocked', 'cancelled', 'interrupted', 'running', 'queued'].map(function (s) { return opt(s, STATE_LABEL[s], f.status); }).join('') + '</select>'
      + '<select id="agg-f-source">' + opt('', 'Any source', f.source || '') + opt('reddit', 'Reddit', f.source) + opt('indeed', 'Indeed', f.source) + opt('career_site', 'Career sites', f.source) + opt('reddit_archive', 'Reddit archive', f.source) + opt('google', 'Google', f.source) + '</select>'
      + '<input type="date" id="agg-f-since" value="' + esc(f.since || '') + '"/><input type="date" id="agg-f-until" value="' + esc(f.until || '') + '"/><button class="agg-btn" id="agg-f-go">Filter</button></div>';
    if (!runs || !runs.length) return filters + '<p class="muted">No runs match.</p>';
    return filters + '<div class="agg-table agg-hist"><div class="agg-tr head"><span>Pipeline</span><span>Started</span><span>Status</span><span>Trigger</span><span>Headline</span><span>Duration</span></div>'
      + runs.map(function (r) {
        var m = r.metrics || {};
        var head = r.pipeline === 'indeed' ? num(m.written) + ' written · ' + num(m.uniqueListings) + ' unique · ' + num(m.detailsFailed) + ' detail failures'
          : r.pipeline === 'career_site' ? num(m.saved) + ' saved · ' + num(m.postingsFound) + ' postings · ' + num(m.pagesRead) + ' pages'
          : REPORT_PIPES.indexOf(r.pipeline) >= 0 ? (m.dryRun ? 'preview · ' + num(m.accountsFound) + ' accounts' : num(m.newReports) + ' new reports · ' + num(m.companiesDone) + ' companies · ' + num(m.duplicates) + ' already had')
          : (m.dryRun ? 'dry run · ' + num(m.excerptsCollected) + ' excerpts' : num(m.importedReports) + ' reports · ' + num(m.commentary) + ' commentary · ' + num(m.rejected) + ' rejected');
        return '<div class="agg-tr ' + (PIPE[r.pipeline] || {}).cls + '" data-agg-run="' + esc(r.id) + '"><span>' + esc((PIPE[r.pipeline] || {}).label || r.pipeline) + '</span><span>' + esc(when(r.startedAt || r.createdAt)) + '</span><span>' + pill(r.status) + '</span><span>' + esc(r.trigger) + '</span><span>' + head + '</span><span>' + esc(dur(r.durationMs)) + '</span></div>';
      }).join('') + '</div><div id="agg-run-detail"></div>';
  }
  function renderRunDetail(run) {
    if (!run) return '';
    var body = resultsFor(run);
    return '<div class="agg-panel ' + (PIPE[run.pipeline] || {}).cls + '"><div class="agg-lbl">Run detail</div>' + body
      + '<details><summary>Configuration used</summary><pre class="agg-pre">' + esc(JSON.stringify(run.config, null, 2)) + '</pre></details>'
      + '<details><summary>Events and output tails</summary><pre class="agg-pre">' + esc((run.events || []).map(function (e) { return e.at + '  ' + e.text; }).join('\n') + '\n\n--- stdout ---\n' + (run.stdoutTail || []).join('\n') + '\n\n--- stderr ---\n' + (run.stderrTail || []).join('\n')) + '</pre></details></div>';
  }

  // ---- System health + scheduling ------------------------------------------------------------
  function renderHealth(health, cfgAll) {
    if (!health) return '<p class="muted">Checking…</p>';
    var repo = '<div class="agg-panel"><div class="agg-lbl">Seenjobs.io checkout on this Mac</div><div class="agg-presets"><input id="agg-repo" class="agg-wide" value="' + esc((cfgAll && cfgAll.seenRepoDir) || '') + '" placeholder="' + esc((cfgAll && cfgAll.defaultSeenRepoDir) || 'absolute path') + '"/><button class="agg-btn" id="agg-repo-save">Save path</button><button class="agg-btn" id="agg-health-refresh">Re-run checks</button><span class="agg-out" id="agg-out-health"></span></div><p class="agg-sub">In use: <span class="agg-mono">' + esc(health.seenRepoDir) + '</span>. Leave empty to use the default (SEEN_PRODUCT_REPO_DIR or ../seen). The checkout is never bundled into the app.</p></div>';
    return repo + '<div class="agg-grid2">' + ALL_PIPES.map(function (k) {
      var h = health.pipelines[k]; if (!h) return '';
      var modes = Object.keys(h.modes || {}).map(function (m) { return esc(m.replace('_', ' ')) + ': ' + pill(h.modes[m]); }).join(' ');
      return '<div class="agg-card ' + PIPE[k].cls + '"><div class="agg-card-h"><span class="agg-icon">' + PIPE[k].icon + '</span><b>' + PIPE[k].label + '</b>' + pill(h.status) + '</div><p class="agg-sub">' + modes + ' · endpoint <span class="agg-mono">' + esc(h.endpoint || '—') + '</span></p><div class="agg-checks">' + h.checks.map(checkRow).join('') + '</div></div>';
    }).join('') + '</div><p class="agg-sub">Checked ' + esc(when(health.checkedAt)) + '. Secrets are reported as configured / rejected / unknown — never shown. Seen Command cannot read Vercel settings, so "unknown" means not verifiable from here, not missing.</p>';
  }
  function renderSchedules(sch, status) {
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return '<div class="agg-note">Schedules are off by default and independent. They fire only while Seen Command is open and this Mac is awake (the Chrome collectors also need the local Browser Bridge; Applicant Reports does not). A slot missed while the app was closed is skipped, not replayed; overlapping Chrome runs queue instead of running together.</div><div class="agg-grid2">'
      + ['company_intel', 'indeed', 'applicant_reports', 'web_reports'].map(function (k) {
        var s = (sch || {})[k] || {}; var meta = PIPE[k];
        return '<div class="agg-card ' + meta.cls + '" data-agg-sched="' + k + '"><div class="agg-card-h"><span class="agg-icon">' + meta.icon + '</span><b>' + meta.label + '</b>' + pill(s.enabled ? 'running' : 'cancelled').replace(s.enabled ? 'Running' : 'Cancelled', s.enabled ? 'Scheduled' : 'Manual only') + '</div>'
          + '<div class="agg-form"><label>Enabled<input type="checkbox" class="agg-s-en"' + (s.enabled ? ' checked' : '') + '/></label>'
          + '<label>Frequency<select class="agg-s-freq"><option value="daily"' + (s.frequency === 'daily' ? ' selected' : '') + '>Daily</option><option value="weekly"' + (s.frequency === 'weekly' ? ' selected' : '') + '>Weekly</option></select></label>'
          + '<label>Time (this Mac)<input type="time" class="agg-s-time" value="' + esc(s.time || '06:00') + '"/></label>'
          + '<label>Weekday<select class="agg-s-wd">' + days.map(function (d, i) { return '<option value="' + i + '"' + (Number(s.weekday) === i ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></label></div>'
          + '<div class="agg-kv"><span>Next run</span><span>' + (s.enabled ? esc(when(s.nextRunAt)) : '—') + '</span><span>Last scheduled run</span><span>' + esc(when(s.lastRunAt)) + (s.lastOutcome ? ' · ' + esc(s.lastOutcome) : '') + '</span><span>Missed slots</span><span>' + esc((s.missed || []).length) + '</span></div>'
          + '<p class="agg-sub">Scheduled runs use the saved ' + meta.label + ' configuration' + (k !== 'indeed' ? ' (including its preview/import mode)' : '') + (k === 'applicant_reports' ? '. A daily “fill the thinnest” import keeps every company climbing toward 10.' : k === 'web_reports' ? '. Google runs in this Mac’s Chrome, so keep it to once a day.' : '') + '.</p>'
          + '<div class="agg-ctl"><button class="agg-btn" data-agg-sched-save="' + k + '">Save schedule</button><span class="agg-out" id="agg-out-sched-' + k + '"></span></div></div>';
      }).join('') + '</div>';
  }

  window.AggUI = { esc: esc, num: num, pill: pill, renderOverview: renderOverview, renderQuick: renderQuick, renderIndeed: renderIndeed, renderIntel: renderIntel, renderHistory: renderHistory, renderRunDetail: renderRunDetail, renderHealth: renderHealth, renderSchedules: renderSchedules, indeedResults: indeedResults, intelResults: intelResults, careerResults: careerResults,
    renderReports: renderReports, reportsResults: reportsResults, reportsPlan: reportsPlan, coverage: coverage, thinnest: thinnest, parseNameLines: parseNameLines,
    renderCompanyJobs: renderCompanyJobs, renderCompanyJobsResult: renderCompanyJobsResult, parseCompanyLines: parseCompanyLines,
    indeedSets: indeedSets, buildIndeedSearches: buildIndeedSearches, renderBoards: renderBoards, boardsSentence: boardsSentence, quickPick: quickPick, filterCatalog: filterCatalog, lastRunSentence: lastRunSentence, DEPTHS: DEPTHS };

  // ---- controller (browser only) -------------------------------------------------------------
  if (typeof document === 'undefined') return;
  // S.ui holds the two tools' on-screen choices (picked sets, searches, companies, depth…). It lives
  // outside the saved config, so the live poll re-rendering the page never drops what you picked.
  var S = { tab: 'overview', status: null, config: null, health: null, runs: null, schedules: null, detail: {}, filters: {}, timer: null, dirty: {}, openRun: null,
    presets: null, catalog: null, boards: null, companyJobs: null, loading: {}, ui: { indeed: null, company_intel: null, company_jobs: null, applicant_reports: null } };
  // The Company jobs box does not come from the saved config, so it is created here and nothing that
  // resets the config-derived choices (saving the Seen folder path) may drop it: when it was dropped,
  // typing went nowhere and the button stayed on "Type a company first".
  function cjUi() { return S.ui.company_jobs || (S.ui.company_jobs = { text: '', indeed: true, browser: true, siteLimit: 40 }); }
  function api(path, opts) {
    opts = opts || {};
    return fetch('/api/aggregation' + path, { method: opts.method || 'GET', headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
  }
  // The Google collector has no panel of its own: it reports on the Applicant Reports line.
  function out(id, text, ok) { var el = document.getElementById('agg-out-' + id) || (id === 'web_reports' ? document.getElementById('agg-out-applicant_reports') : null); if (el) { el.textContent = text || ''; el.className = 'agg-out ' + (ok ? 'ok' : 'bad'); } }
  function root() { return document.getElementById('agg-view'); }
  function setTab(t) {
    S.tab = t;
    document.querySelectorAll('.agg-tab').forEach(function (b) { b.classList.toggle('on', b.dataset.aggTab === t); });
    refresh();
  }
  function latestDetail(pipe) {
    var p = S.status && S.status.pipelines[pipe]; if (!p) return Promise.resolve(null);
    var id = (p.activeRun && p.activeRun.id) || (p.lastRun && p.lastRun.id); if (!id) return Promise.resolve(null);
    return api('/runs/' + encodeURIComponent(id)).then(function (r) { return r && r.id ? r : null; });
  }
  function savedCfg(pipe) { return S.config && S.config.pipelines && S.config.pipelines[pipe] ? S.config.pipelines[pipe].config : null; }
  function capsOf(pipe) { return (S.config && S.config.pipelines && S.config.pipelines[pipe] && S.config.pipelines[pipe].capabilities) || {}; }
  // First visit: start from the saved setup (what the schedule uses).
  function uiFor(pipe) {
    if (S.ui[pipe]) return S.ui[pipe];
    var c = savedCfg(pipe); if (!c) return null;
    S.ui[pipe] = pipe === 'indeed'
      ? { picked: [], extra: (c.searches || []).map(function (s) { return { query: s.query, location: s.location }; }), removed: [], rps: c.resultsPerSearch, pages: c.maxPages, maxSearches: c.maxSearches || null }
      : pipe === 'applicant_reports'
      ? (function () { var w = savedCfg('web_reports') || {}; var src = {}; (capsOf('applicant_reports').sources || ['reddit']).forEach(function (k) { src[k] = !c.sources || c.sources.indexOf(k) >= 0; }); src.google = false;
        return { how: (c.companies || []).length ? 'list' : 'fill', text: (c.companies || []).join('\n'), fillBelow: c.fillBelow || 10, companyLimit: c.companyLimit || 25, mode: c.mode, goal: c.goal, years: c.years, minutes: c.minutesPerCompany, src: src, gap: w.searchGapSeconds || 25, pages: w.pagesPerCompany || 30 }; })()
      : { picked: (c.companies || []).slice(), q: '', sort: 'jobs', hideSlugs: true, show: 50, mode: c.mode, posts: c.postsPerCompany, companyLimit: c.companyLimit };
    return S.ui[pipe];
  }
  function indeedSearchesNow() { return buildIndeedSearches(uiFor('indeed'), indeedSets(S.presets, (savedCfg('indeed') || {}).presets)); }
  function collectIndeed() {
    var ui = uiFor('indeed'); var c = savedCfg('indeed') || {};
    return { searches: indeedSearchesNow().map(function (s) { return { query: s.query, location: s.location }; }), resultsPerSearch: ui.rps, maxPages: ui.pages, maxSearches: ui.maxSearches || null, presets: c.presets || [] };
  }
  function collectReports() {
    var ui = uiFor('applicant_reports'); var list = ui.how === 'list';
    var plan = reportsPlan(ui, capsOf('applicant_reports'), capsOf('web_reports'));
    var out = { mode: ui.mode, companies: list ? parseNameLines(ui.text).companies : [], companyLimit: ui.companyLimit, fillBelow: list ? 0 : ui.fillBelow, goal: ui.goal, years: ui.years, minutesPerCompany: ui.minutes };
    if (capsOf('applicant_reports').sources && plan.archive.length) out.sources = plan.archive;
    return out;
  }
  function collectWeb() {
    var r = collectReports(); var ui = uiFor('applicant_reports');
    return { mode: r.mode, companies: r.companies, companyLimit: r.companyLimit, fillBelow: r.fillBelow, goal: r.goal, minutesPerCompany: r.minutesPerCompany, searchGapSeconds: ui.gap || 25, pagesPerCompany: ui.pages || 30 };
  }
  function collectFor(pipe) { return pipe === 'indeed' ? collectIndeed() : pipe === 'applicant_reports' ? collectReports() : pipe === 'web_reports' ? collectWeb() : collectIntel(); }
  function collectIntel() { var ui = uiFor('company_intel'); return { mode: ui.mode, companyLimit: ui.companyLimit, postsPerCompany: ui.posts, companies: ui.picked.slice() }; }
  function catalogView() { var ui = uiFor('company_intel'); return S.catalog && S.catalog.ok ? filterCatalog(S.catalog.companies, ui).slice(0, ui.show || 50) : []; }

  // Replacing the page removes a focused field, which fires its change handler, which renders again —
  // inside the first render ("the node to be removed is no longer a child"). Defer a nested render.
  var rendering = false;
  function render() {
    if (rendering) { setTimeout(render, 0); return; }
    rendering = true;
    try { renderNow(); } finally { rendering = false; }
  }
  function renderNow() {
    var el = root(); if (!el || !S.status) return;
    // Unsaved schedule / health edits survive the live poll: those forms are not re-rendered while dirty.
    if ((S.tab === 'schedules' || S.tab === 'health') && S.dirty[S.tab]) return;
    // Keep the cursor where it was (the company search box re-renders as you type).
    var a = document.activeElement; var focusId = a && a.id && el.contains(a) ? a.id : null; var sel = focusId && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    if (S.tab === 'overview') el.innerHTML = renderQuick(S.status, S.presets, S.catalog, S.boards) + renderOverview(S.status);
    else if (S.tab === 'indeed') el.innerHTML = renderIndeed(S.config, S.status, S.health, S.detail.indeed, S.presets, uiFor('indeed'));
    else if (S.tab === 'company_intel') { var cui = uiFor('company_intel'); if (cui) cui.boards = S.boards; el.innerHTML = renderIntel(S.config, S.status, S.health, S.detail.company_intel, S.catalog, cui); }
    else if (S.tab === 'applicant_reports') { var aui = uiFor('applicant_reports'); if (aui) aui.intelPicked = (uiFor('company_intel') || {}).picked || []; el.innerHTML = renderReports(S.config, S.status, S.health, S.detail.applicant_reports, S.catalog, aui, S.detail.web_reports); }
    else if (S.tab === 'company_jobs') el.innerHTML = renderCompanyJobs(S.status, S.health, S.companyJobs, cjUi(), (uiFor('company_intel') || {}).picked);
    else if (S.tab === 'history') { el.innerHTML = renderHistory(S.runs, S.filters); var dd = document.getElementById('agg-run-detail'); if (dd && S.openRun) dd.innerHTML = renderRunDetail(S.openRun); }
    else if (S.tab === 'health') el.innerHTML = renderHealth(S.health, S.config);
    else if (S.tab === 'schedules') el.innerHTML = renderSchedules(S.schedules, S.status);
    if (focusId) { var f = document.getElementById(focusId); if (f) { f.focus(); if (sel && f.setSelectionRange) try { f.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } } }
    wire();
  }
  function saveConfig(pipe, cfg) {
    var body = { pipelines: {} }; body.pipelines[pipe] = cfg;
    return api('/config', { method: 'PUT', body: body }).then(function (r) {
      if (r.ok) { S.config = r.config; out(pipe, 'Saved — scheduled runs use this setup.', true); }
      else out(pipe, (r.errors ? Object.values(r.errors).flat().join(' · ') : r.error), false);
      return r;
    });
  }
  // A run from a tool tab saves that setup first (so History shows what ran); a quick start passes
  // its choices as one-off overrides and leaves the saved setup alone.
  function startRun(pipe, confirmLarge, overrides) {
    var go = function () {
      return api('/runs', { method: 'POST', body: { pipeline: pipe, confirmLarge: !!confirmLarge, overrides: overrides || undefined } }).then(function (r) {
        if (r.needsConfirmation) {
          var e = r.estimate || {};
          var what = pipe === 'applicant_reports' ? e.companies + ' companies imported, up to ' + Math.round((e.maxMinutes || 0) / 60 * 10) / 10 + ' hours' : 'up to ' + (e.maxDetailCalls || e.maxThreadReads || '?') + ' pages opened in Chrome';
          if (window.confirm('This is a large run (' + what + '). Start it?')) return startRun(pipe, true, overrides);
          return out(pipe, 'Not started.', false);
        }
        if (r.ok) { out(pipe, r.run.status === 'queued' && r.run.waitingFor ? 'Queued — it starts when the other collector finishes.' : 'Started.', true); refresh(); }
        else { var msg = r.error + (r.blockers ? ': ' + r.blockers.map(function (b) { return b.label; }).join(', ') : '') + (r.errors ? ': ' + [].concat(r.errors).join(' · ') : ''); out(pipe, msg, false); if (S.tab === 'overview') window.alert(msg); }
      });
    };
    if (overrides) return go();
    return saveConfig(pipe, collectFor(pipe)).then(function (s) { if (s.ok) return go(); });
  }
  function loadList(key, path, force) {
    if (S.loading[key]) return;
    S.loading[key] = true;
    api(path + (force ? '?refresh=1' : '')).then(function (r) { S[key] = r; }).catch(function (e) { S[key] = { ok: false, error: e.message }; })
      .then(function () { S.loading[key] = false; render(); });
  }
  function wire() {
    var el = root(); if (!el) return;
    var on = function (sel, ev, fn) { el.querySelectorAll(sel).forEach(function (n) { n[ev] = function (e) { fn(n, e); }; }); };
    var byId = function (id) { return document.getElementById(id); };
    on('[data-agg-tab]', 'onclick', function (b) { setTab(b.dataset.aggTab); });
    on('[data-agg-start]', 'onclick', function (b) { b.disabled = true; startRun(b.dataset.aggStart, false).finally(function () { b.disabled = false; }); });
    on('[data-agg-save]', 'onclick', function (b) { var p = b.dataset.aggSave; saveConfig(p, collectFor(p)); });
    on('[data-agg-cancel]', 'onclick', function (b) { if (!window.confirm('Cancel this run? Anything already sent to Seen stays stored.')) return; api('/runs/' + encodeURIComponent(b.dataset.aggCancel) + '/cancel', { method: 'POST', body: {} }).then(function (r) { if (!r.ok) window.alert(r.error); refresh(); }); });
    el.oninput = el.onchange = function () { if (S.tab === 'schedules' || S.tab === 'health') S.dirty[S.tab] = true; };

    // Indeed
    var iu = S.ui.indeed;
    on('[data-agg-set]', 'onclick', function (b) { var k = b.dataset.aggSet; var i = iu.picked.indexOf(k); if (i >= 0) iu.picked.splice(i, 1); else iu.picked.push(k); render(); });
    on('[data-agg-rm]', 'onclick', function (b) {
      var s = indeedSearchesNow()[Number(b.dataset.aggRm)]; if (!s) return;
      var k = skey(s); var before = iu.extra.length; iu.extra = iu.extra.filter(function (x) { return skey(x) !== k; });
      if (iu.extra.length === before || iu.picked.length) iu.removed.push(k);
      render();
    });
    var add = byId('agg-add-search'); if (add) add.onclick = function () {
      var q = byId('agg-add-q').value.trim(); var l = byId('agg-add-l').value.trim() || 'Remote';
      if (!q) return out('indeed', 'Type a job title first.', false);
      var s = { query: q, location: l }; iu.removed = iu.removed.filter(function (k) { return k !== skey(s); }); iu.extra.push(s); render();
    };
    var ps = byId('agg-preset-save'); if (ps) ps.onclick = function () {
      var name = byId('agg-preset-name').value.trim(); if (!name) return out('indeed', 'Name the set first.', false);
      var c = collectIndeed(); c.presets = (c.presets || []).filter(function (p) { return p.name !== name; }).concat([{ name: name, searches: c.searches }]);
      saveConfig('indeed', c).then(function (r) { if (r.ok) render(); });
    };
    on('[data-agg-depth]', 'onclick', function (b) { var d = DEPTHS.filter(function (x) { return x.id === b.dataset.aggDepth; })[0]; var cp = capsOf('indeed'); iu.rps = Math.min(d.rps, cp.resultsPerSearchMax || 25); iu.pages = cp.pagination === false ? 1 : d.pages; render(); });
    var num1 = function (id, key, nullable) { var n = byId(id); if (n) n.onchange = function () { var v = n.value === '' ? null : Number(n.value); if (!nullable && v == null) return; iu[key] = v; render(); }; };
    if (iu) { num1('agg-rps', 'rps'); num1('agg-pages', 'pages'); num1('agg-maxs', 'maxSearches', true); }

    // Company Intelligence
    var cu = S.ui.company_intel;
    on('[data-agg-pick]', 'onclick', function (b) { var k = b.dataset.aggPick; cu.picked = k === 'seen' ? [] : quickPick(S.catalog && S.catalog.ok ? S.catalog.companies : [], k, 25); render(); });
    on('[data-agg-co]', 'onchange', function (b) {
      var c = catalogView()[Number(b.dataset.aggCo)]; if (!c) return;
      var i = cu.picked.map(function (n) { return n.toLowerCase(); }).indexOf(c.company.toLowerCase());
      if (i >= 0) cu.picked.splice(i, 1);
      else if (cu.picked.length >= 100) { out('company_intel', 'Up to 100 companies per run.', false); b.checked = false; return; }
      else cu.picked.push(c.company);
      render();
    });
    on('[data-agg-unpick]', 'onclick', function (b) { cu.picked.splice(Number(b.dataset.aggUnpick), 1); render(); });
    var pc = byId('agg-pick-clear'); if (pc) pc.onclick = function () { cu.picked = []; render(); };
    var cq = byId('agg-cat-q'); if (cq) cq.oninput = function () { cu.q = cq.value; cu.show = 50; render(); };
    var cs = byId('agg-cat-sort'); if (cs) cs.onchange = function () { cu.sort = cs.value; render(); };
    var csl = byId('agg-cat-slugs'); if (csl) csl.onchange = function () { cu.hideSlugs = csl.checked; render(); };
    var cm = byId('agg-cat-more'); if (cm) cm.onclick = function () { cu.show += 50; render(); };
    on('[data-agg-mode]', 'onclick', function (b) { cu.mode = b.dataset.aggMode; render(); });
    on('[data-agg-posts]', 'onclick', function (b) { cu.posts = Math.min(Number(b.dataset.aggPosts), capsOf('company_intel').postsPerCompanyMax || 10); render(); });
    var cl = byId('agg-climit'); if (cl) cl.onchange = function () { var v = Number(cl.value); if (v >= 1) { cu.companyLimit = v; render(); } };

    // Applicant Reports
    var au = S.ui.applicant_reports;
    if (au) {
      on('[data-agg-arhow]', 'onclick', function (b) { au.how = b.dataset.aggArhow; render(); });
      on('[data-agg-armode]', 'onclick', function (b) { au.mode = b.dataset.aggArmode; render(); });
      on('[data-agg-argoal]', 'onclick', function (b) { au.goal = Number(b.dataset.aggArgoal); render(); });
      var at = byId('agg-ar-text'); if (at) at.oninput = function () { au.text = at.value; render(); };
      var aint = function (id, key, lo) { var n = byId(id); if (n) n.onchange = function () { var v = Number(n.value); if (Number.isInteger(v) && v >= lo) { au[key] = v; render(); } }; };
      aint('agg-ar-below', 'fillBelow', 1); aint('agg-ar-limit', 'companyLimit', 1); aint('agg-ar-goal', 'goal', 0); aint('agg-ar-years', 'years', 1); aint('agg-ar-mins', 'minutes', 1);
      var ath = byId('agg-ar-thin'); if (ath) ath.onclick = function () { au.text = thinnest(S.catalog && S.catalog.ok ? S.catalog.companies : [], au.fillBelow || 10, 25).join('\n'); render(); };
      var ain = byId('agg-ar-intel'); if (ain) ain.onclick = function () { au.text = ((uiFor('company_intel') || {}).picked || []).join('\n'); render(); };
      on('[data-agg-arsrc]', 'onchange', function (b) { au.src = au.src || {}; au.src[b.dataset.aggArsrc] = b.checked; render(); });
      aint('agg-ar-gap', 'gap', 10); aint('agg-ar-pages', 'pages', 1);
      // One press starts every ticked collector for the same companies and goal (each saves its setup first).
      var plan = function () { return reportsPlan(au, capsOf('applicant_reports'), capsOf('web_reports')); };
      var ago = byId('agg-ar-go'); if (ago) ago.onclick = function () {
        var pl = plan(); ago.disabled = true;
        var chain = Promise.resolve();
        if (pl.archive.length) chain = chain.then(function () { return startRun('applicant_reports', false); });
        if (pl.google) chain = chain.then(function () { return startRun('web_reports', false); });
        chain.finally(function () { ago.disabled = false; });
      };
      var asv = byId('agg-ar-save'); if (asv) asv.onclick = function () {
        var pl = plan();
        saveConfig('applicant_reports', collectReports()).then(function () { if (pl.google || savedCfg('web_reports')) return saveConfig('web_reports', collectWeb()).then(function (r) { if (r.ok) out('applicant_reports', 'Saved — scheduled runs of both use this setup.', true); }); });
      };
    }

    // Employer job boards (company tab card + overview quick start)
    on('[data-agg-boards]', 'onclick', function (b) {
      var body;
      if (b.dataset.aggBoards === 'picked') {
        var names = (S.ui.company_intel && S.ui.company_intel.picked || []).slice(0, 50); if (!names.length) return;
        if (S.ui.company_intel.picked.length > 50 && !window.confirm('Boards are pulled 50 companies at a time — pull the first 50 of your ' + S.ui.company_intel.picked.length + '?')) return;
        body = { companies: names };
      } else body = { limit: 200 };
      S.boards = { last: S.boards && S.boards.last, pulling: true }; render();
      api('/boards/pull', { method: 'POST', body: body }).then(function (r) {
        S.boards = r.ok ? { last: r } : { last: S.boards && S.boards.last, error: r.error || 'The pull failed.' };
        render();
      });
    });

    // Company jobs
    var ju = cjUi();
    var jt = byId('agg-cj-text'); if (jt) jt.oninput = function () { ju.text = jt.value; render(); };
    var juse = byId('agg-cj-use'); if (juse) juse.onclick = function () { ju.text = ((uiFor('company_intel') || {}).picked || []).slice(0, MAX_CJ).join('\n'); render(); };
    var ji = byId('agg-cj-indeed'); if (ji) ji.onchange = function () { ju.indeed = ji.checked; render(); };
    var jb = byId('agg-cj-browser'); if (jb) jb.onchange = function () { ju.browser = jb.checked; render(); };
    var jl = byId('agg-cj-limit'); if (jl) jl.onchange = function () { var v = Number(jl.value); if (v >= 1 && v <= 150) { ju.siteLimit = v; render(); } };
    var jg = byId('agg-cj-go'); if (jg) jg.onclick = function () {
      var p = parseCompanyLines(ju.text); if (!p.companies.length || p.errors.length) return;
      ju.starting = true; render();
      api('/company-jobs', { method: 'POST', body: { companies: p.companies, websites: p.websites, siteLimit: ju.siteLimit || 40, indeed: ju.indeed !== false, browser: ju.browser !== false } }).then(function (r) {
        ju.starting = false;
        if (r.ok) S.companyJobs = { running: true, last: r.state };
        else { render(); out('company_jobs', r.error || 'The pull did not start.', false); return; }
        refresh();
      });
    };

    // Overview quick starts
    on('[data-agg-quick]', 'onclick', function (b) {
      if (b.dataset.aggQuick === 'indeed-maintenance') {
        var mt = S.presets && S.presets.ok ? S.presets.maintenance : null; if (!mt) return;
        if (!window.confirm('Run this week’s Indeed maintenance — ' + mt.searches.length + ' searches, 2 from every niche, at Standard depth? Listings go straight to seenjobs.io.')) return;
        startRun('indeed', false, { searches: mt.searches.map(function (s) { return { query: s.query, location: s.location }; }), resultsPerSearch: Math.min(20, capsOf('indeed').resultsPerSearchMax || 25), maxPages: 1, maxSearches: null });
      } else if (b.dataset.aggQuick === 'reports-fill') {
        if (!window.confirm('Find applicant reports for the 25 companies with the most open jobs and fewer than 10 reports, up to 10 new reports each, from the free Reddit archive? Seen re-checks every account before publishing it.')) return;
        startRun('applicant_reports', false, { mode: 'import', companies: [], fillBelow: 10, companyLimit: 25, goal: 10 });
      } else if (b.dataset.aggQuick === 'intel-major') {
        if (!(S.catalog && S.catalog.ok)) {
          b.disabled = true; b.querySelector('.agg-set-s').textContent = 'loading the company list…';
          api('/company-intel/catalog').then(function (r) { S.catalog = r; render(); if (r.ok) { var nb = root().querySelector('[data-agg-quick="intel-major"]'); if (nb) nb.click(); } });
          return;
        }
        var major = quickPick(S.catalog.companies, 'major', 10); if (!major.length) return;
        if (!window.confirm('Preview Reddit accounts for the top 10 companies by open jobs (' + major.join(', ') + ')? Preview sends nothing to Seen.')) return;
        startRun('company_intel', false, { companies: major, mode: 'dry_run' });
      }
    });

    // History / health / schedules (unchanged behaviour)
    var fg = byId('agg-f-go'); if (fg) fg.onclick = function () { S.filters = { pipeline: byId('agg-f-pipe').value, status: byId('agg-f-status').value, source: byId('agg-f-source').value, since: byId('agg-f-since').value, until: byId('agg-f-until').value }; loadRuns().then(render); };
    on('[data-agg-run]', 'onclick', function (row) { api('/runs/' + encodeURIComponent(row.dataset.aggRun)).then(function (r) { S.openRun = r && r.id ? r : null; var d = byId('agg-run-detail'); if (d) d.innerHTML = renderRunDetail(S.openRun); }); });
    var rs = byId('agg-repo-save'); if (rs) rs.onclick = function () { api('/config', { method: 'PUT', body: { seenRepoDir: byId('agg-repo').value.trim() || null } }).then(function (r) { out('health', r.ok ? 'Saved — re-checking…' : r.error, r.ok); if (r.ok) { S.config = r.config; S.ui = { indeed: null, company_intel: null, applicant_reports: null, company_jobs: S.ui.company_jobs }; S.dirty.health = false; loadHealth(true).then(render); } }); };
    var hr = byId('agg-health-refresh'); if (hr) hr.onclick = function () { out('health', 'Checking…', true); S.dirty.health = false; loadHealth(true).then(render); };
    on('[data-agg-sched-save]', 'onclick', function (b) {
      var k = b.dataset.aggSchedSave; var card = el.querySelector('[data-agg-sched="' + k + '"]');
      var body = { enabled: card.querySelector('.agg-s-en').checked, frequency: card.querySelector('.agg-s-freq').value, time: card.querySelector('.agg-s-time').value, weekday: Number(card.querySelector('.agg-s-wd').value) };
      api('/schedules/' + k, { method: 'PUT', body: body }).then(function (r) { if (r.ok) { S.schedules[k] = r.schedule; S.dirty.schedules = false; render(); out('sched-' + k, 'Saved.', true); } else out('sched-' + k, r.errors ? r.errors.join(' · ') : r.error, false); });
    });
  }
  function loadHealth(force) { return api('/health' + (force ? '?refresh=1' : '')).then(function (h) { S.health = h; }); }
  function loadRuns() {
    var q = []; var f = S.filters || {};
    ['pipeline', 'status', 'source'].forEach(function (k) { if (f[k]) q.push(k + '=' + encodeURIComponent(f[k])); });
    if (f.since) q.push('since=' + encodeURIComponent(f.since));
    if (f.until) q.push('until=' + encodeURIComponent(f.until + 'T23:59:59'));
    return api('/runs' + (q.length ? '?' + q.join('&') : '')).then(function (r) { S.runs = r.runs || []; });
  }
  function refresh() {
    var el = root(); if (!el) return Promise.resolve();
    if (typeof LIVE !== 'undefined' && !LIVE) { el.innerHTML = '<p class="muted">Open the Seen Command app (or npm run serve) for the live Aggregation Dashboard.</p>'; return Promise.resolve(); }
    var need = [api('/status').then(function (s) { S.status = s; })];
    if (!S.config || S.tab === 'indeed' || S.tab === 'company_intel' || S.tab === 'applicant_reports' || S.tab === 'company_jobs' || S.tab === 'health') need.push(api('/config').then(function (c) { if (!c.error) S.config = c; }));
    if (!S.health || S.tab === 'health' || S.tab === 'indeed' || S.tab === 'company_intel' || S.tab === 'applicant_reports' || S.tab === 'company_jobs') need.push(loadHealth(false));
    if (S.tab === 'company_jobs' || (S.companyJobs && S.companyJobs.running)) need.push(api('/company-jobs').then(function (r) { if (!r.error) S.companyJobs = r; }));
    if (S.tab === 'history') need.push(loadRuns());
    if (!S.boards && (S.tab === 'overview' || S.tab === 'company_intel')) need.push(api('/boards').then(function (b) { if (!b.error) S.boards = { last: b.last, running: b.running }; }));
    if (S.tab === 'schedules') need.push(api('/schedules').then(function (r) { S.schedules = r.schedules; }));
    // The preset and company lists load in the background (the catalog takes ~10s) and render on arrival.
    if (!S.presets && (S.tab === 'indeed' || S.tab === 'overview')) loadList('presets', '/indeed/presets');
    // The catalog costs Seen a full read of its open listings, so it loads only where it is used.
    if (!S.catalog && (S.tab === 'company_intel' || S.tab === 'applicant_reports')) loadList('catalog', '/company-intel/catalog');
    return Promise.all(need).then(function () {
      if (S.tab === 'applicant_reports') return Promise.all([latestDetail('applicant_reports'), latestDetail('web_reports')]).then(function (d) { S.detail.applicant_reports = d[0]; S.detail.web_reports = d[1]; });
      if (S.tab === 'indeed' || S.tab === 'company_intel') return latestDetail(S.tab).then(function (d) { S.detail[S.tab] = d; });
    }).then(function () { render(); schedulePoll(); }).catch(function (e) { el.innerHTML = '<p class="agg-prob bad">Aggregation API unavailable: ' + esc(e.message) + '</p>'; });
  }
  // Poll only while the tab is visible AND something is active — no background chatter otherwise.
  function schedulePoll() {
    clearTimeout(S.timer);
    var tab = document.getElementById('tab-aggregation'); if (!tab || tab.classList.contains('hidden')) return;
    var active = (S.status && Object.values(S.status.pipelines).some(function (p) { return p.activeRun; })) || !!(S.companyJobs && S.companyJobs.running);
    S.timer = setTimeout(refresh, active ? 3000 : 30000);
  }
  window.loadAggregation = function () {
    document.querySelectorAll('.agg-tab').forEach(function (b) { b.onclick = function () { setTab(b.dataset.aggTab); }; });
    refresh();
  };
})();
