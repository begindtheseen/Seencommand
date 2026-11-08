// Operational memory for the collection pipelines — what Chronos should REMEMBER, not what it should
// store. The run history (lib/aggregation/store.mjs) is the record of every run; Chronos only gets a
// fact when something meaningful changes, written through the ONE canonical writer (lib/brain.mjs
// recordFacts → supersede-never-overwrite, no-op when unchanged):
//   • health    — the pipeline's health class changed (healthy ↔ degraded ↔ failing)
//   • persistent_blocker — the same blocking cause stopped ≥2 consecutive runs; superseded by
//                          "cleared …" when a later run succeeds
//   • schedule  — the owner enabled/disabled/changed a recurring schedule (an approved config decision)
// No collected job, applicant report, excerpt, URL list or per-run row is ever written to Chronos.

import { FAILURE_CATEGORIES } from './failures.mjs';

const LABEL = { indeed: 'Indeed Job Collection', company_intel: 'Company Intelligence Collection', career_site: 'Career Site (Chrome) Collection', applicant_reports: 'Applicant Report Collection (Reddit archive)', web_reports: 'Applicant Report Collection (Google in Chrome)' };
export const subjectFor = (pipeline) => `seen:aggregation:${pipeline}`;

export function healthClass(status) {
  if (status === 'completed') return 'healthy';
  if (status === 'partial') return 'degraded';
  if (status === 'failed' || status === 'blocked') return 'failing';
  return null; // cancelled / interrupted say nothing about the pipeline's health
}

export function headline(run) {
  const m = run.metrics || {};
  if (run.pipeline === 'indeed') {
    if (m.written != null) return `${m.written} listing rows written or refreshed from ${m.uniqueListings ?? '?'} unique Indeed listings`;
    return run.reason || run.status;
  }
  if (run.pipeline === 'career_site') {
    if (m.saved != null) return `${m.saved} jobs saved from ${m.postingsFound ?? '?'} postings on ${m.pagesRead ?? '?'} career-site pages (${m.sites ?? '?'} sites)`;
    return run.reason || run.status;
  }
  if (run.pipeline === 'applicant_reports' || run.pipeline === 'web_reports') {
    if (m.dryRun) return `dry run: ${m.accountsFound ?? '?'} first-hand applicant accounts found for ${m.companiesDone ?? '?'} companies`;
    if (m.newReports != null) return `${m.newReports} new applicant reports (${m.published ?? '?'} published) for ${m.companiesDone ?? '?'} companies (${run.pipeline === 'web_reports' ? 'Google' : 'Reddit archive'})${m.googleBlocked ? ' — Google asked for a CAPTCHA and was stopped' : ''}`;
    return run.reason || run.status;
  }
  if (m.dryRun) return `dry run: ${m.excerptsCollected ?? '?'} raw excerpts found for ${m.companiesTargeted ?? '?'} companies`;
  if (m.importedReports != null) return `${m.importedReports} applicant reports + ${m.commentary ?? 0} commentary excerpts imported for ${m.companiesTargeted ?? '?'} companies`;
  return run.reason || run.status;
}

// Given a just-finished run and the pipeline's memory state, return the facts to write + new state.
export function factsForRun(run, prior = {}) {
  const facts = [];
  const state = { ...prior };
  const cls = healthClass(run.status);
  const day = String(run.endedAt || run.updatedAt || new Date().toISOString()).slice(0, 10);
  const source = `Seen Command aggregation run ${run.id}`;
  if (!cls) return { facts, state };

  if (cls !== prior.lastClass) {
    const why = cls === 'healthy' ? headline(run) : (run.reason || run.status);
    facts.push({ subject: subjectFor(run.pipeline), predicate: 'health', confidence: 'high', source,
      object: `${cls} since ${day} (${LABEL[run.pipeline]}): ${String(why).slice(0, 260)}` });
    state.lastClass = cls; state.lastClassSince = day;
  }

  const top = (run.diagnostics?.failureCategories || []).find((f) => f.blocking);
  if (run.status === 'blocked' && top) {
    const same = prior.blockerCategory === top.category;
    state.blockerCategory = top.category;
    state.blockerCount = same ? (prior.blockerCount || 1) + 1 : 1;
    state.blockerSince = same ? (prior.blockerSince || day) : day;
    if (state.blockerCount >= 2 && prior.blockerRecorded !== top.category) {
      facts.push({ subject: subjectFor(run.pipeline), predicate: 'persistent_blocker', confidence: 'high', source,
        object: `${FAILURE_CATEGORIES[top.category].label} — blocked ${state.blockerCount} consecutive runs since ${state.blockerSince}. Fix: ${FAILURE_CATEGORIES[top.category].fix}` });
      state.blockerRecorded = top.category;
    }
  } else if (cls === 'healthy' || cls === 'degraded') {
    if (prior.blockerRecorded) {
      facts.push({ subject: subjectFor(run.pipeline), predicate: 'persistent_blocker', confidence: 'high', source,
        object: `cleared ${day}: run ${run.id} ${run.status} after "${FAILURE_CATEGORIES[prior.blockerRecorded]?.label || prior.blockerRecorded}"` });
    }
    state.blockerCategory = null; state.blockerCount = 0; state.blockerSince = null; state.blockerRecorded = null;
  }
  return { facts, state };
}

export function scheduleFact(pipeline, sched, day = new Date().toISOString().slice(0, 10)) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const when = sched.frequency === 'weekly' ? `weekly on ${days[sched.weekday]} at ${sched.time}` : `daily at ${sched.time}`;
  return { subject: subjectFor(pipeline), predicate: 'schedule', confidence: 'high', source: 'Seen Command Aggregation → Scheduling (owner)',
    object: sched.enabled ? `enabled by the owner on ${day}: ${when} (Mac local time; runs only while Seen Command is open)` : `disabled by the owner on ${day} (manual runs only)` };
}
