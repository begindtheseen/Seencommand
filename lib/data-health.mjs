// Data health — duplicates and stale listings on seenjobs.io, found and cleaned from Seen Command (owner,
// 2026-10-21: "seen command should be able to handle duplicates and stale listings all in app and it is the
// best at managing the data").
//
// Seen already owns the RULES and the safety guarantees; this module only drives them, through Seen's
// admin API (lib/connectors/adminStats.mjs adminAction):
//   • scan_job_dupes / dedupe_jobs — same title+company+place, same source id, or same apply link + title.
//     Employer posts and listings someone saved or applied to are never deleted (Seen lib/server/jobDedupe.js).
//   • purge_stale_jobs — listings unseen on their board 7+ days; ones people hold stay as hidden 'expired'.
//   • scan_report_dupes / dedupe_reports — a second copy of an applicant report is HIDDEN, never deleted.
//   • find_duplicates / auto_merge — only names that differ by Inc/LLC/Corp/… are merged (reversible);
//     look-alikes ("Acme Group" vs "Acme") are listed for a human and never merged here.
// Each cleaning action does a bounded amount of work per request and says `complete:false` while more
// remains, so ONE loop (drain) repeats it — the same rules as Seen's own admin (components/admin/drain.ts):
// a round lost in transit (502/503/504, no JSON, dropped connection) is retried at most twice in a row; a
// round that did nothing while claiming more work stops the loop; 40 rounds / 4 minutes per kind at most.
//
// Counts are never invented: a part that could not be read says so with Seen's own error text.
// State (the automatic-cleanup setting, the last runs, look-alikes the owner already reviewed) lives in
// one small file under the runtime data dir. Tests: lib/data-health.test.mjs.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { formatPT } from './time-pt.mjs';

export const DRAIN_LIMITS = Object.freeze({ maxRounds: 40, budgetMs: 240_000, maxLostInARow: 2, roundTimeoutMs: 120_000 });
export const AUTO_EVERY_MS = 24 * 3600e3;      // the automatic cleanup runs once a day…
export const AUTO_RETRY_MS = 6 * 3600e3;       // …and a failed one is tried again after 6 hours
export const SCAN_TTL_MS = 2 * 60_000;
const HISTORY_KEEP = 60;
const LOOKALIKES_SHOWN = 40;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const n0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmtN = (v) => Number(v || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${fmtN(n)} ${n === 1 ? one : many}`;
const clip = (s, n = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// What each cleaning kind runs, and how much one answer did. `left` is what Seen says remains (null = unknown).
export const KINDS = Object.freeze({
  stale: { action: 'purge_stale_jobs', label: 'Stale listings', did: (d) => num(d.removed) || num(d.deleted) + num(d.retained), left: (d) => n0(d.remaining), verb: 'cleared' },
  job_dupes: { action: 'dedupe_jobs', label: 'Duplicate listings', did: (d) => num(d.deleted), left: (d) => n0(d.remaining), verb: 'removed' },
  report_dupes: { action: 'dedupe_reports', label: 'Duplicate reports', did: (d) => num(d.marked), left: (d) => n0(d.remaining), verb: 'hidden' },
  company_suffix_dupes: { action: 'auto_merge', label: 'Company duplicates', did: (d) => num(d.merged), left: (d) => n0(d.remaining), verb: 'merged' },
});
// "Clean everything": stale first (fewer rows for the duplicate scan to read), then the rest.
export const ALL_KINDS = Object.freeze(['stale', 'job_dupes', 'report_dupes', 'company_suffix_dupes']);
// The daily automatic cleanup. Company merges stay a click — never automatic.
export const AUTO_KINDS = Object.freeze(['stale', 'job_dupes', 'report_dupes']);

// Seen's reason for a failure: its `detail` is the specific cause, its `error` the summary.
export function seenError(e) {
  const b = e && e.body && typeof e.body === 'object' ? e.body : null;
  const head = clip((b && b.error) || (e && e.message) || String(e), 200);
  const detail = b && b.detail ? clip(b.detail, 200) : '';
  return detail && !head.includes(detail) ? `${head}: ${detail}` : head;
}
// A round lost in transit (worth repeating — every batch Seen committed is saved and the actions are
// idempotent) vs an explicit refusal with a reason (a failure).
export function isTransient(e) {
  if (!e || e.permanent) return false;
  if (e.status == null) return true;                                   // dropped connection, timeout
  if ([502, 503, 504].includes(e.status)) return true;                 // gateway
  return !e.body || (typeof e.body === 'object' && !Object.keys(e.body).length); // an HTML error page
}

const withTimeout = (ms, p) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`no answer from Seen in ${Math.round(ms / 1000)} s`), { status: null })), ms); })])
    .finally(() => clearTimeout(t));
};

// THE loop. `call()` runs one round and resolves to Seen's JSON (or throws an Error with .status/.body).
// `did(d)` = how much a round achieved. Returns what happened; never throws.
export async function drain({ call, did, left = () => null, onRound = () => {}, now = Date.now, limits = {} } = {}) {
  const L = { ...DRAIN_LIMITS, ...limits };
  const deadline = now() + L.budgetMs;
  const out = { ok: true, complete: false, rounds: 0, lostRounds: 0, done: 0, left: null, stopped: null, error: null };
  let lostInARow = 0;
  while (out.rounds < L.maxRounds && now() < deadline) {
    let d;
    out.rounds++;
    try { d = await withTimeout(L.roundTimeoutMs, Promise.resolve().then(call)); }
    catch (e) {
      if (isTransient(e) && lostInARow < L.maxLostInARow) { lostInARow++; out.lostRounds++; onRound({ ...out, lost: true, error: seenError(e) }); continue; }
      // Keep what earlier rounds (and this one, before it failed) achieved — a late failure never erases a result.
      if (e && e.body && typeof e.body === 'object') { out.done += did(e.body); const l = left(e.body); if (l != null) out.left = l; }
      return { ...out, ok: false, stopped: 'error', error: seenError(e) };
    }
    if (!d || typeof d !== 'object' || d.ok === false) {
      return { ...out, ok: false, stopped: 'error', error: clip((d && (d.detail || d.error)) || 'Seen answered without a result') };
    }
    lostInARow = 0;
    const work = did(d);
    out.done += work;
    const l = left(d); if (l != null) out.left = l;
    onRound({ ...out });
    if (d.complete !== false) { out.complete = true; if (out.left == null) out.left = 0; out.stopped = 'complete'; return out; }
    if (!work) return { ...out, stopped: 'no_progress' }; // more work claimed, none done — don't spin
  }
  return { ...out, stopped: out.rounds >= L.maxRounds ? 'max_rounds' : 'time_budget' };
}

const settle = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: seenError(e) }; } };

// Look-alike companies need a human; a group the owner marked "different companies" stays quiet until its
// membership changes (the key includes every member's name).
export const lookalikeKey = (g) => `${g.key}|${(g.companies || []).map((c) => String(c.name || '').toLowerCase()).sort().join('|')}`;

// One readable summary of the four checks from the raw answers. `parts` = { jobs, reports, companies, stats }
// each { ok, value } | { ok:false, error }.
export function summarize(parts, { reviewed = [], at = new Date().toISOString() } = {}) {
  const seen = new Set(reviewed);
  const sections = {};

  const j = parts.jobs;
  if (!j || !j.ok) sections.job_dupes = { ok: false, error: j?.error || 'not checked', line: `Duplicate listings could not be checked — ${j?.error || 'not checked'}.` };
  else {
    const v = j.value || {}; const count = num(v.suspected); const prot = num(v.protected);
    const sample = (v.sample || []).slice(0, 8).map((g) => ({
      keep: brief(g.keep), remove: (g.remove || []).map(brief), protectedCopies: (g.kept || []).map(brief),
    }));
    sections.job_dupes = { ok: true, count, groups: num(v.groups), protected: prot, total: n0(v.total), sample,
      line: count
        ? `${plural(count, 'duplicate listing')} in ${plural(num(v.groups), 'group')} — the extra copies would be removed and one of each kept.${prot ? ` ${plural(prot, 'more copy', 'more copies')} stay because someone saved or applied to them, or an employer posted them.` : ''}`
        : `No duplicate listings${n0(v.total) != null ? ` among ${fmtN(v.total)}` : ''}.${prot ? ` (${plural(prot, 'copy', 'copies')} kept on purpose: saved, applied to, or employer-posted.)` : ''}` };
  }

  const s = parts.stats;
  if (!s || !s.ok) sections.stale = { ok: false, error: s?.error || 'not checked', line: `Stale listings could not be counted — ${s?.error || 'not checked'}.` };
  else {
    const jb = (s.value && s.value.jobs) || {}; const jh = (s.value && s.value.job_health) || {};
    const clearable = n0(jb.stale_clearable);
    if (clearable == null) sections.stale = { ok: false, error: 'Seen did not return a stale count', line: 'Stale listings could not be counted — Seen did not return the number this time.' };
    else {
      const kept = n0(jb.expired_kept); const overdue = n0(jb.stale_overdue);
      sections.stale = { ok: true, count: clearable, kept, overdue, active: n0(jh.active ?? jb.active), degraded: !!s.value.data_quality?.degraded,
        line: clearable
          ? `${plural(clearable, 'stale listing')} (not seen on their job board for 7+ days) can be cleared.${overdue ? ` ${fmtN(overdue)} of them are overdue — unseen 15+ days.` : ''}${kept ? ` ${fmtN(kept)} more stay hidden because people saved or applied to them.` : ''}`
          : `No stale listings to clear.${kept ? ` ${fmtN(kept)} expired listings stay hidden because people saved or applied to them.` : ''}` };
    }
  }

  const r = parts.reports;
  if (!r || !r.ok) sections.report_dupes = { ok: false, error: r?.error || 'not checked', line: `Duplicate reports could not be checked — ${r?.error || 'not checked'}.` };
  else {
    const v = r.value || {}; const count = num(v.suspected);
    const byCompany = Object.entries(v.by_company || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([company, copies]) => ({ company, copies }));
    sections.report_dupes = { ok: true, count, groups: num(v.groups), total: n0(v.total), byCompany,
      line: count
        ? `${plural(count, 'extra copy', 'extra copies')} of applicant reports Seen already has — they would be hidden (never deleted, and it can be undone), so each account counts once.`
        : `No duplicate applicant reports${n0(v.total) != null ? ` among ${fmtN(v.total)}` : ''}.` };
  }

  const c = parts.companies;
  if (!c || !c.ok) sections.company_dupes = { ok: false, error: c?.error || 'not checked', line: `Company duplicates could not be checked — ${c?.error || 'not checked'}.` };
  else {
    const groups = (c.value && c.value.duplicates) || [];
    const auto = groups.filter((g) => g.auto);
    const extra = auto.reduce((a, g) => a + Math.max(0, (g.companies || []).length - 1), 0);
    const look = groups.filter((g) => !g.auto);
    const waiting = look.filter((g) => !seen.has(lookalikeKey(g)));
    const names = (g) => (g.companies || []).map((x) => ({ name: x.name, reports: num(x.report_count) }));
    sections.company_dupes = { ok: true, count: extra, autoGroups: auto.length, lookalikes: look.length, lookalikesWaiting: waiting.length, total: n0(c.value.total),
      autoSample: auto.slice(0, 8).map((g) => ({ keep: g.companies?.[0]?.name || '', merge: (g.companies || []).slice(1).map((x) => x.name) })),
      lookalikeList: waiting.slice(0, LOOKALIKES_SHOWN).map((g) => ({ key: lookalikeKey(g), companies: names(g) })),
      line: [
        extra ? `${plural(extra, 'company name')} differ from another only by Inc / LLC / Corp — safe to merge (it can be undone).` : 'No companies that differ only by Inc / LLC / Corp.',
        waiting.length ? `${plural(waiting.length, 'look-alike group')} need you to decide — they might be different companies, so they are never merged automatically.` : look.length ? 'Every look-alike group has been reviewed.' : '',
      ].filter(Boolean).join(' ') };
  }

  const okParts = Object.values(sections).filter((x) => x.ok);
  const toClean = ['job_dupes', 'stale', 'report_dupes', 'company_dupes'].reduce((a, k) => a + (sections[k].ok ? num(sections[k].count) : 0), 0);
  const failed = Object.values(sections).filter((x) => !x.ok).length;
  const headline = !okParts.length ? 'Seen could not be checked right now.'
    : toClean ? `${fmtN(toClean)} thing${toClean === 1 ? '' : 's'} to clean.${failed ? ` ${failed} check${failed === 1 ? '' : 's'} could not run.` : ''}`
      : failed ? `Nothing to clean in what could be checked — ${failed} check${failed === 1 ? '' : 's'} could not run.` : 'The data is clean.';
  return { at, when: formatPT(at), headline, toClean, failed, sections };
}
function brief(r) { return r ? { id: r.id, title: r.title || '', company: r.company || '', location: r.location || '', source: r.source || '', status: r.status || null } : null; }

// When the automatic cleanup is due: never ran → now; the last one failed → 6 h later; else 24 h later.
export function autoDue({ enabled = true, lastAttemptAt = null, lastOk = true, now = Date.now() } = {}) {
  if (!enabled) return false;
  const t = Date.parse(lastAttemptAt || '');
  if (!Number.isFinite(t)) return true;
  return now - t >= (lastOk ? AUTO_EVERY_MS : AUTO_RETRY_MS);
}

// The plain-language result of one run.
export function describeRun(run) {
  const parts = (run.steps || []).map((s) => {
    const k = KINDS[s.kind];
    if (s.error && !s.done) return `${k.label.toLowerCase()}: failed — ${s.error}`;
    const left = s.left == null ? '' : ` · ${fmtN(s.left)} left`;
    return `${fmtN(s.done)} ${k.label.toLowerCase()} ${k.verb}${left}${s.error ? ` (then failed — ${s.error})` : ''}`;
  });
  return parts.join(' · ') || 'nothing ran';
}

// ---------------------------------------------------------------------------------------------------------
export function createDataHealth({
  action,                                      // (body) → Seen JSON; throws with .status/.body
  stats,                                       // () → Seen's admin overview
  configured = () => true,
  file = null,                                 // () → path of the state file
  logActivity = () => null,
  notify = () => null,
  recordFailure = () => null,
  resolveFailure = () => null,
  failureRepo = () => null,                    // the repo a cleanup failure's ticket is filed against
  onFinished = () => {},                       // (run | null after a review) → refresh the app's caches
  now = () => new Date(),
  limits = {},
} = {}) {
  const path = () => file();
  const read = () => {
    try { const v = JSON.parse(readFileSync(path(), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  };
  const write = (v) => {
    try {
      const f = path(); mkdirSync(join(f, '..'), { recursive: true });
      const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, f);
    } catch (e) { process.stderr.write(`[data-health] state not saved: ${e.message}\n`); }
  };
  const update = (fn) => { const v = read(); fn(v); write(v); return v; };
  const settings = () => { const v = read(); return { auto: v.auto !== false }; };

  let scanCache = null, scanInflight = null, running = null, lastRun = null;

  async function scan({ refresh = false } = {}) {
    if (!configured()) return { configured: false, at: now().toISOString(), headline: 'Seen admin is not connected — add the admin username and password in Settings.', sections: null };
    if (!refresh && scanCache && now().getTime() - scanCache.t < SCAN_TTL_MS) return scanCache.v;
    if (scanInflight) return scanInflight;
    scanInflight = (async () => {
      const [jobs, reports, companies, st] = await Promise.all([
        settle(() => action({ action: 'scan_job_dupes' })),
        settle(() => action({ action: 'scan_report_dupes' })),
        settle(() => action({ action: 'find_duplicates' })),
        settle(() => stats()),
      ]);
      const v = { configured: true, ...summarize({ jobs, reports, companies, stats: st }, { reviewed: read().reviewed || [], at: now().toISOString() }) };
      scanCache = { t: now().getTime(), v };
      const cd = v.sections.company_dupes;
      update((s) => { s.lastScan = { at: v.at, toClean: v.toClean, failed: v.failed, lookalikesWaiting: cd.ok ? cd.lookalikesWaiting : null }; });
      return v;
    })().finally(() => { scanInflight = null; });
    return scanInflight;
  }

  // Start a cleaning run in the background. One at a time (the automatic one shares the lock).
  function clean(kind, { trigger = 'manual' } = {}) {
    const kinds = kind === 'all' ? ALL_KINDS : kind === 'auto' ? AUTO_KINDS : KINDS[kind] ? [kind] : null;
    if (!kinds) return { ok: false, code: 400, error: `nothing called "${kind}" — use job_dupes, stale, report_dupes, company_suffix_dupes or all` };
    if (!configured()) return { ok: false, code: 400, error: 'Seen admin is not connected — add the admin username and password in Settings.' };
    if (running) return { ok: false, code: 409, error: 'a cleanup is already running', run: progress() };
    const id = `dh-${now().getTime().toString(36)}`;
    running = { id, kind, trigger, startedAt: now().toISOString(), status: 'running', current: kinds[0], steps: kinds.map((k) => ({ kind: k, label: KINDS[k].label, status: 'waiting', done: 0, left: null, rounds: 0, error: null })) };
    const done = (async () => {
      for (const step of running.steps) {
        running.current = step.kind; step.status = 'running';
        const k = KINDS[step.kind];
        const r = await drain({ call: () => action({ action: k.action }), did: k.did, left: k.left, now: () => now().getTime(), limits,
          onRound: (o) => { step.done = o.done; step.left = o.left; step.rounds = o.rounds; step.note = o.lost ? `a round got no answer (${o.error}) — trying again` : null; } });
        Object.assign(step, { done: r.done, left: r.left, rounds: r.rounds, lostRounds: r.lostRounds, error: r.error, stopped: r.stopped, note: null,
          status: r.complete ? 'done' : !r.ok ? 'failed' : 'partial' });
        if (step.status === 'partial') step.note = r.stopped === 'no_progress' ? 'Seen stopped making progress — try again later' : 'stopped at the time limit — press again to continue';
      }
      const failed = running.steps.filter((s) => s.status === 'failed');
      running.status = failed.length === running.steps.length ? 'failed' : failed.length || running.steps.some((s) => s.status === 'partial') ? 'partial' : 'completed';
      running.endedAt = now().toISOString();
      running.removed = running.steps.reduce((a, s) => a + num(s.done), 0);
      running.summary = describeRun(running);
      const rec = { ...running, current: null };
      lastRun = rec; running = null;
      scanCache = null; // the counts moved — the next look re-checks
      update((s) => {
        s.history = [rec, ...(s.history || [])].slice(0, HISTORY_KEEP);
        if (trigger === 'auto') { s.lastAutoAt = rec.startedAt; s.lastAutoOk = !failed.length; } // any failed part → retried in 6 h
      });
      logActivity({ kind: 'data-health', id: rec.id, status: rec.status, summary: `${trigger === 'auto' ? 'Automatic cleanup' : 'Cleanup'}: ${rec.summary}`.slice(0, 200), detail: failed.map((s) => `${s.label}: ${s.error}`).join(' · ') || null });
      afterRun(rec);
      try { onFinished(rec); } catch { /* a cache refresh never breaks a cleanup */ }
      return rec;
    })().catch((e) => { // never leaves the lock held
      const rec = { ...(running || {}), status: 'failed', endedAt: now().toISOString(), summary: `failed — ${clip(e.message)}` };
      lastRun = rec; running = null; return rec;
    });
    return { ok: true, run: progress(), done };
  }

  function afterRun(rec) {
    const failedSteps = rec.steps.filter((s) => s.status === 'failed');
    if (rec.trigger === 'auto') {
      if (rec.removed > 0 || failedSteps.length) {
        notify({ kind: 'data-health', level: failedSteps.length ? 'error' : 'success', tab: 'jobs', ref: rec.id,
          title: failedSteps.length ? 'Automatic data cleanup had a problem' : `Automatic cleanup: ${fmtN(rec.removed)} cleaned`, body: rec.summary });
      }
      const st = read();
      if (failedSteps.length) {
        const reason = failedSteps.map((s) => `${s.label}: ${s.error}`).join(' · ');
        // The failure queue + a brain ticket (lib/failure-loop.mjs → lib/ticket-sources.mjs) any AI can pick up.
        recordFailure({ kind: 'data_cleanup_failed', id: 'data-health-auto', key: 'data-health-auto', repo: failureRepo(), title: 'Automatic data cleanup failed', reason,
          blocked: /not connected|not configured|401|403|session expired|insufficient role/i.test(reason), source: 'lib/data-health.mjs' });
        update((s) => { s.openFailure = true; });
      } else if (st.openFailure) {
        resolveFailure({ id: 'data-health-auto', how: `the next automatic cleanup ran clean (${rec.summary})`, by: 'seen-command' });
        update((s) => { s.openFailure = false; });
      }
    }
  }

  function progress() {
    const r = running || lastRun;
    if (!r) return null;
    return { ...r, running: !!running, when: formatPT(r.endedAt || r.startedAt), summary: r.summary || describeRun(r) };
  }

  function history({ limit = 30 } = {}) {
    return (read().history || []).slice(0, Math.max(1, Math.min(HISTORY_KEEP, Number(limit) || 30))).map((h) => ({ ...h, when: formatPT(h.endedAt || h.startedAt) }));
  }

  function autoStatus() {
    const s = read();
    const enabled = s.auto !== false;
    const t = Date.parse(s.lastAutoAt || '');
    const nextAt = !enabled ? null : Number.isFinite(t) ? new Date(t + (s.lastAutoOk === false ? AUTO_RETRY_MS : AUTO_EVERY_MS)).toISOString() : null;
    return { enabled, lastAt: s.lastAutoAt || null, lastWhen: s.lastAutoAt ? formatPT(s.lastAutoAt) : null, lastOk: s.lastAutoOk !== false,
      nextAt, nextWhen: nextAt ? formatPT(nextAt) : null };
  }
  function setAuto(on) { update((s) => { s.auto = !!on; }); return autoStatus(); }

  function review(key) {
    if (!key || typeof key !== 'string' || key.length > 2000) return { ok: false, error: 'which look-alike group?' };
    update((s) => {
      const fresh = !(s.reviewed || []).includes(key);
      s.reviewed = [...new Set([key, ...(s.reviewed || [])])].slice(0, 2000);
      if (fresh && s.lastScan && s.lastScan.lookalikesWaiting > 0) s.lastScan.lookalikesWaiting--; // Home stops asking at once
    });
    scanCache = null;
    try { onFinished(null); } catch { /* Home picks it up on its next refresh */ }
    return { ok: true };
  }

  // The daily automatic cleanup. tick() is called a few minutes after launch, then hourly.
  function tick() {
    if (running || !configured()) return { skipped: true };
    const s = read();
    if (!autoDue({ enabled: s.auto !== false, lastAttemptAt: s.lastAutoAt, lastOk: s.lastAutoOk !== false, now: now().getTime() })) return { skipped: true };
    return clean('auto', { trigger: 'auto' });
  }
  let timers = [];
  function startSchedule({ firstDelayMs = 4 * 60_000, everyMs = 60 * 60_000 } = {}) {
    if (timers.length) return;
    const t1 = setTimeout(() => { try { tick(); } catch { /* next hour */ } }, firstDelayMs);
    const t2 = setInterval(() => { try { tick(); } catch { /* next hour */ } }, everyMs);
    t1.unref?.(); t2.unref?.(); timers = [t1, t2];
  }
  function stopSchedule() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  // What Home's "Needs you" shows: only what needs a human (look-alikes waiting, a cleanup that failed).
  function needsYou() {
    const s = read(); const items = [];
    const last = (s.history || [])[0];
    if (last && (last.steps || []).some((x) => x.status === 'failed') && now().getTime() - Date.parse(last.endedAt || last.startedAt) < 3 * 86400e3) {
      items.push({ kind: 'data-health', level: 'error', title: `${last.trigger === 'auto' ? 'The automatic data cleanup' : 'A data cleanup'} ${last.status === 'failed' ? 'failed' : 'partly failed'}`, body: last.summary || '' });
    }
    const w = s.lastScan && s.lastScan.lookalikesWaiting;
    if (w > 0) items.push({ kind: 'data-health', level: 'info', title: `${plural(w, 'look-alike company group')} to review`, body: 'They might be different companies, so Seen Command never merges them on its own. Jobs → Data health.' });
    return items;
  }

  return { scan, clean, progress, history, autoStatus, setAuto, review, tick, startSchedule, stopSchedule, needsYou, settings };
}

// ---------------------------------------------------------------------------------------------------------
// Routes (engine/server.mjs). Reads are open to the app window; anything that changes Seen answers this Mac
// only (`localOnly` = the server's same-origin loopback check).
//   GET  /api/data-health            the four checks (cached 2 min; ?refresh=1 re-checks) + the running/last
//                                    cleanup + the automatic-cleanup setting
//   GET  /api/data-health/run        the running (or last) cleanup — polled by the panel while one runs
//   GET  /api/data-health/history    past cleanups, newest first
//   POST /api/data-health/clean      { kind: job_dupes | stale | report_dupes | company_suffix_dupes | all } → 202
//   POST /api/data-health/settings   { auto: true|false } — the daily automatic cleanup
//   POST /api/data-health/review     { key } — a look-alike company group the owner says is fine
export function createDataHealthRoutes({ dh, json, readBody, localOnly }) {
  return async function handle(req, res, path, qs) {
    if (path !== '/api/data-health' && !path.startsWith('/api/data-health/')) return false;
    try {
      if (req.method === 'GET') {
        if (path === '/api/data-health') {
          const scan = await dh.scan({ refresh: qs?.get?.('refresh') === '1' });
          json(res, 200, { ...scan, run: dh.progress(), auto: dh.autoStatus() });
        } else if (path === '/api/data-health/run') json(res, 200, { run: dh.progress() });
        else if (path === '/api/data-health/history') json(res, 200, { history: dh.history({ limit: Number(qs?.get?.('limit') || 30) }) });
        else json(res, 404, { error: 'no such data-health route' });
        return true;
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }
      if (!localOnly(req)) { json(res, 403, { error: 'data cleanup is started from this Mac only' }); return true; }
      const b = (await readBody(req)) || {};
      if (path === '/api/data-health/clean') {
        const r = dh.clean(String(b.kind || ''), { trigger: 'manual' });
        if (!r.ok) { json(res, r.code || 400, { error: r.error, run: r.run || null }); return true; }
        json(res, 202, { ok: true, run: r.run });
      } else if (path === '/api/data-health/settings') {
        if (typeof b.auto !== 'boolean') json(res, 400, { error: 'say auto: true or auto: false' });
        else json(res, 200, { ok: true, auto: dh.setAuto(b.auto) });
      } else if (path === '/api/data-health/review') {
        const r = dh.review(b.key); json(res, r.ok ? 200 : 400, r);
      } else json(res, 404, { error: 'no such data-health route' });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  };
}
