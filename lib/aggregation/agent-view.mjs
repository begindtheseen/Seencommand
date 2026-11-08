// The Board Room's READ-ONLY view of the collection pipelines. Pure functions over the manager's
// snapshot (status + run summaries): every number in an answer comes from a recorded run's metrics,
// a metric the collector does not report is said to be unreported (never estimated), and nothing here
// can start, cancel, schedule or reconfigure a run — those stay with the owner in the dashboard.

const DAY = 24 * 60 * 60 * 1000;
const fmt = (n) => (n == null ? 'not reported' : Number(n).toLocaleString('en-US'));
const sum = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const when = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') + ' UTC' : 'never');

export const AGGREGATION_QUESTION = /\b(indeed|aggregation|collection (?:pipelines?|performance|runs?)|(?:data|seen|both) collectors?|company intel(?:ligence)?|applicant reports?|reddit (?:collector|intel(?:ligence)?|collection)|(?:jobs?|indeed|listing) ingest(?:ion)?|company identit(?:y|ies)|unresolved (?:company|identit)|ats slugs?|valid listings)\b/i;

function windowRuns(runs, pipeline, fromMs, toMs) {
  return runs.filter((r) => r.pipeline === pipeline && r.endedAt && ['completed', 'partial', 'failed', 'blocked', 'interrupted'].includes(r.status)
    && new Date(r.endedAt).getTime() >= fromMs && new Date(r.endedAt).getTime() < toMs);
}
function indeedTotals(rs) {
  return { runs: rs.length, written: sum(rs.map((r) => r.metrics?.written ?? null)), unique: sum(rs.map((r) => r.metrics?.uniqueListings ?? null)),
    rejected: sum(rs.map((r) => r.metrics?.rejected ?? null)), detailsFailed: sum(rs.map((r) => r.metrics?.detailsFailed ?? null)) };
}
function intelTotals(rs) {
  const real = rs.filter((r) => r.metrics && r.metrics.dryRun === false);
  return { runs: rs.length, dryRuns: rs.length - real.length, reports: sum(real.map((r) => r.metrics.importedReports)), commentary: sum(real.map((r) => r.metrics.commentary)),
    duplicates: sum(real.map((r) => r.metrics.duplicates)), rejected: sum(real.map((r) => r.metrics.rejected)), collected: sum(rs.map((r) => r.metrics?.excerptsCollected ?? null)) };
}

function archiveTotals(rs) {
  const real = rs.filter((r) => r.metrics && r.metrics.dryRun === false);
  return { runs: rs.length, dryRuns: rs.length - real.length, reports: sum(real.map((r) => r.metrics.newReports ?? null)), published: sum(real.map((r) => r.metrics.published ?? null)),
    duplicates: sum(real.map((r) => r.metrics.duplicates ?? null)), companies: sum(rs.map((r) => r.metrics?.companiesDone ?? null)) };
}

function pipelineLine(p) {
  if (!p) return '';
  const last = p.lastRun ? `last run ${p.lastRun.status} ${when(p.lastRun.endedAt)}${p.lastRun.reason ? ` — ${p.lastRun.reason}` : ''}` : 'no runs yet';
  return `- **${p.label}** — **${p.state}** · ${last}${p.lastSuccess ? ` · last success ${when(p.lastSuccess.endedAt)}` : ''}`;
}

export function answerAggregationQuestion(message, snap, nowMs = Date.now()) {
  const t = String(message || '').toLowerCase();
  if (!AGGREGATION_QUESTION.test(t)) return null;
  const runs = Array.isArray(snap?.runs) ? snap.runs : [];
  const P = snap?.pipelines || {};
  const week = windowRuns.bind(null, runs);
  const sources = ['aggregation:run-history'];

  if (/\b(which|what) searches\b|most valid|best search|producing the most/.test(t)) {
    const rs = runs.filter((r) => r.pipeline === 'indeed' && r.metrics && r.metrics.written != null).slice(0, 5);
    const lines = rs.map((r) => `- ${when(r.endedAt)}: ${fmt(r.metrics.uniqueListings)} unique listings → ${fmt(r.metrics.written)} rows written (${fmt(r.metrics.rejected)} rejected)`);
    return { reply: `**Per-search yield is not reported.** The Indeed CLI returns totals for a whole run, not per search query, so I can't rank individual searches without inventing numbers.\n\n${lines.length ? `Per-run totals (newest first):\n${lines.join('\n')}` : 'No completed Indeed runs with metrics yet.'}\n\n_To compare searches, run them as separate runs (one search each) and compare the run totals in Aggregation → History._`, sources };
  }

  if (/\bindeed\b/.test(t) && /\b(how many|count|number|imported|import|jobs|listings)\b/.test(t)) {
    const x = indeedTotals(week('indeed', nowMs - 7 * DAY, nowMs + 1));
    if (!x.runs) return { reply: '**No Indeed runs finished in the last 7 days**, so there is nothing to count. Start one from Aggregation → Indeed Jobs.', sources };
    return { reply: `### Indeed — last 7 days\n- **${fmt(x.written)}** listing rows written or refreshed by Seen (${x.runs} run${x.runs === 1 ? '' : 's'})\n- ${fmt(x.unique)} unique Indeed listings found · ${fmt(x.rejected)} rejected by Seen’s checks · ${fmt(x.detailsFailed)} detail extractions failed\n\n_Seen does not split new vs. updated rows for this merge path, so "written" is not a count of brand-new jobs._`, sources };
  }

  if (/\b(applicant reports?|reports did we|company intel|reddit)\b/.test(t) && /\b(how many|count|number|collect|collected|imported)\b/.test(t)) {
    const x = intelTotals(week('company_intel', nowMs - 7 * DAY, nowMs + 1));
    const a = archiveTotals([...week('applicant_reports', nowMs - 7 * DAY, nowMs + 1), ...week('web_reports', nowMs - 7 * DAY, nowMs + 1)]);
    if (!x.runs && !a.runs) return { reply: '**No applicant-report runs finished in the last 7 days.** Start one from Aggregation → Applicant Reports (free Reddit archive) or Company Intelligence (Chrome).', sources };
    const parts = [];
    if (a.runs) parts.push(`### Applicant Reports (Reddit archive, Google) — last 7 days\n- **${fmt(a.reports)}** new applicant reports (${fmt(a.published)} published at the Reddit trust tier)\n- ${fmt(a.duplicates)} already held by Seen · ${fmt(a.companies)} companies worked · ${a.runs} run${a.runs === 1 ? '' : 's'}, of which ${a.dryRuns} dry run${a.dryRuns === 1 ? '' : 's'}`);
    if (x.runs) parts.push(`### Company Intelligence — last 7 days\n- **${fmt(x.reports)}** applicant reports imported (low-trust, source-labeled) + **${fmt(x.commentary)}** commentary excerpts\n- ${fmt(x.duplicates)} already held by Seen · ${fmt(x.rejected)} rejected (including unknown companies — never created)\n- ${x.runs} run${x.runs === 1 ? '' : 's'}, of which ${x.dryRuns} dry run${x.dryRuns === 1 ? '' : 's'} (${fmt(x.collected)} raw excerpts found overall)`);
    return { reply: parts.join('\n\n'), sources };
  }

  if (/\b(unresolved|identit|unknown compan|ats slug|slug)\b/.test(t)) {
    const recent = runs.filter((r) => r.pipeline === 'company_intel').slice(0, 10);
    return { reply: `**Unmatched company identities are not reported by the collector** — Seen rejects an unknown company per item, but the collector keeps only the total. Unknown companies are rejected, never created.\n\n${recent.length ? `Rejected items in the last ${recent.length} run(s): **${fmt(sum(recent.map((r) => r.metrics?.rejected ?? null)))}**.` : 'No Company Intelligence runs yet.'}\n\n_ATS-style slugs (lowercase, no spaces) among the targets are flagged for review in Aggregation → Company Intelligence → Identity review._`, sources };
  }

  if (/\b(what changed|change in|performance|trend|compared?|versus|vs\.?)\b/.test(t)) {
    const cur = indeedTotals(week('indeed', nowMs - 7 * DAY, nowMs + 1)); const prev = indeedTotals(week('indeed', nowMs - 14 * DAY, nowMs - 7 * DAY));
    const ci = intelTotals(week('company_intel', nowMs - 7 * DAY, nowMs + 1)); const cp = intelTotals(week('company_intel', nowMs - 14 * DAY, nowMs - 7 * DAY));
    return { reply: `### Collection performance — this week vs. last\n- **Indeed rows written:** ${fmt(cur.written)} vs ${fmt(prev.written)} (${cur.runs} vs ${prev.runs} runs)\n- **Indeed detail failures:** ${fmt(cur.detailsFailed)} vs ${fmt(prev.detailsFailed)}\n- **Applicant reports imported:** ${fmt(ci.reports)} vs ${fmt(cp.reports)} (${ci.runs} vs ${cp.runs} runs)\n- **Commentary excerpts:** ${fmt(ci.commentary)} vs ${fmt(cp.commentary)}`, sources };
  }

  // Failing / why-stopped / overview.
  const lines = [pipelineLine(P.company_intel), pipelineLine(P.indeed), pipelineLine(P.career_site), pipelineLine(P.applicant_reports), pipelineLine(P.web_reports)].filter(Boolean);
  const problems = Object.values(P).flatMap((p) => (p.problems || []).filter((x) => x.blocking).map((x) => `- ${p.label}: **${x.label}** — ${x.detail}`));
  const actions = Object.values(P).flatMap((p) => (p.actions || []).map((a) => `- ${p.label}: ${a}`));
  if (/\b(why|stop|stopped|fail|failing|broken|blocked)\b/.test(t)) {
    const failing = Object.values(P).filter((p) => ['failed', 'blocked', 'partial'].includes(p.state));
    if (!failing.length && !problems.length) return { reply: `**Neither pipeline is failing right now.**\n\n${lines.join('\n')}`, sources };
    const detail = failing.map((p) => {
      const cats = (p.lastRun?.failureCategories || []).map((c) => `${c.label} ×${c.count}`).join(', ');
      return `- **${p.label}** is **${p.state}**: ${p.lastRun?.reason || 'see readiness'}${cats ? ` (${cats})` : ''}`;
    });
    return { reply: `### Collection pipelines — what is wrong\n${[...detail, ...problems].join('\n')}${actions.length ? `\n\n**What you need to do:**\n${[...new Set(actions)].slice(0, 6).join('\n')}` : ''}`, sources };
  }
  return { reply: `### Collection pipelines\n${lines.join('\n') || '- No pipelines registered.'}${problems.length ? `\n\n**Blocking problems:**\n${problems.join('\n')}` : ''}\n\n_Open Aggregation in the sidebar for configuration, runs and history. I can explain and recommend; starting or scheduling a run is yours to do there._`, sources };
}

// Compact context block for the streaming Board Room agent — run-derived only (no network probes).
export function aggregationContextFromRuns(runs = [], nowMs = Date.now()) {
  if (!runs.length) return '';
  const last = (p) => runs.find((r) => r.pipeline === p && r.endedAt);
  const i = indeedTotals(windowRuns(runs, 'indeed', nowMs - 7 * DAY, nowMs + 1));
  const c = intelTotals(windowRuns(runs, 'company_intel', nowMs - 7 * DAY, nowMs + 1));
  const a = archiveTotals([...windowRuns(runs, 'applicant_reports', nowMs - 7 * DAY, nowMs + 1), ...windowRuns(runs, 'web_reports', nowMs - 7 * DAY, nowMs + 1)]);
  const li = last('indeed'); const lc = last('company_intel'); const la = last('applicant_reports');
  return `COLLECTION PIPELINES (Seen Command run history — real recorded metrics; "not reported" means the collector does not report it):\n`
    + `• Indeed: last run ${li ? `${li.status} ${when(li.endedAt)}${li.reason ? ` (${li.reason})` : ''}` : 'never'}; 7 days: ${i.runs} runs, ${fmt(i.written)} rows written or refreshed.\n`
    + `• Company Intelligence: last run ${lc ? `${lc.status} ${when(lc.endedAt)}${lc.reason ? ` (${lc.reason})` : ''}` : 'never'}; 7 days: ${c.runs} runs, ${fmt(c.reports)} applicant reports + ${fmt(c.commentary)} commentary imported.\n`
    + `• Applicant Reports (Reddit archive, Google): last run ${la ? `${la.status} ${when(la.endedAt)}${la.reason ? ` (${la.reason})` : ''}` : 'never'}; 7 days: ${a.runs} runs, ${fmt(a.reports)} new applicant reports.\n`
    + `You can start searches and presets (see SEARCH + COLLECTION): if a request did not start one, end with one line "RUN: <the search>". You do not change schedules or credentials.`;
}
