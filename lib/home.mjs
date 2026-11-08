// Home — the one screen the owner opens to see how the business is doing RIGHT NOW (owner, 2026-10-21:
// "the command center tab has too much info and none of it is up to date accurate or useful … stuff I
// actually care about like jobs added today, recent changes, things we should work on based on automatic
// board room meetings"). Every section is read live when the tab asks, carries its own `at`, and fails on
// its own: a section that could not be read says so (`error`) instead of showing a stale or zero number.
//
// Sections: seen (today on seenjobs.io), needsYou (decisions waiting on the owner — incl. brain tickets that
// only he can move: blocked on him, or a PR ready to merge), runs (collectors on this
// Mac + in the cloud + schedules), changes (commits on both repos, the production deploy, what the app did),
// board (the latest board meeting and its open action items).
import { formatPT, ptDate } from './time-pt.mjs';

const settle = async (fn) => { try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; } };
const within = (ms, p) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t)); };
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function seenSection(raw, at) {
  const jb = raw.jobs || {}, jh = raw.job_health || {}, m = raw.monetization || {}, st = raw.storage || null;
  return {
    at,
    degraded: !!raw.data_quality?.degraded,
    jobs: { addedToday: n(jb.added_today ?? jb.new_today), active: n(jh.active ?? jb.active), total: n(jb.total), stale: n(jb.stale_clearable ?? jb.stale_or_expired) },
    reports: { today: n(raw.reports?.today), week: n(raw.reports?.this_week), total: n(raw.reports?.total), held: n(raw.held_reports?.pending) },
    companies: { graded: n(raw.companies?.with_scores) },
    users: { total: n(raw.users?.total), newToday: n(raw.users?.new_today) },
    // One-time sales in the last 30 days (Interview Prep + the Job Search Pass) from Seen's revenue funnel; null
    // when Seen could not report it — never $0. Legacy subscriptions (pre-2026-10-25) are their own number.
    revenue: raw.revenue_funnel?.revenue ? { month: n(raw.revenue_funnel.revenue.total), paying: n(raw.revenue_funnel.revenue.paying_customers),
      pass: n(raw.revenue_funnel.revenue.pass_count), prep: n((raw.revenue_funnel.steps || []).find((x) => x.key === 'prep_purchases')?.n),
      legacySubs: n(m.active_paid) } : null,
    errors: { today: n(raw.errors?.today) },
    storage: st ? { mb: Math.round(st.db_bytes / 1048576), maxMb: st.max_mb, guard: !!st.enabled, blocking: !!st.blocking } : null,
  };
}

export function needsYouItems({ state, seen, runs, cloud, tickets = null, dataHealth = [], now = new Date() }) {
  const items = [];
  const pending = (state?.approvals || []).filter((x) => x.status === 'pending');
  const board = boardSection(state, now);
  // Proposals from a meeting that is days old are not current decisions: listing each one as if it were
  // today's is what made Home read as out of date. One line instead, pointing at a fresh meeting.
  if (pending.length && board.stale) {
    const days = Math.round(board.ageHours / 24);
    items.push({ kind: 'stale-approvals', level: 'info', count: pending.length, ageDays: days,
      title: `${pending.length} proposal${pending.length === 1 ? '' : 's'} from the ${board.day || 'last'} meeting (${days} day${days === 1 ? '' : 's'} ago)`,
      body: 'They may no longer fit. Run a fresh board meeting for current proposals, or review the old ones in Board report.' });
  } else {
    for (const a of pending) items.push({ kind: 'approval', level: a.risk === 'high' ? 'error' : 'warning', id: a.id, title: a.title, body: a.summary, dept: a.dept, risk: a.risk });
  }
  if (seen?.storage?.blocking) items.push({ kind: 'storage', level: 'error', title: `Database at ${seen.storage.mb} MB — new job listings are paused`, body: 'Upgrade the Supabase plan, then raise or turn off the storage guard.' });
  else if (seen?.storage && seen.storage.guard && seen.storage.mb >= seen.storage.maxMb - 30) items.push({ kind: 'storage', level: 'warning', title: `Database at ${seen.storage.mb} MB of ${seen.storage.maxMb} MB`, body: 'New job listings pause at the guard so Seen never turns read-only. Upgrading the Supabase plan removes the limit.' });
  if (seen?.reports?.held > 0) items.push({ kind: 'held-reports', level: 'info', title: `${seen.reports.held} held report${seen.reports.held === 1 ? '' : 's'} waiting for review`, body: 'Seen admin → Community → Reports awaiting review.' });
  for (const r of runs?.recent || []) {
    if (['failed', 'blocked'].includes(r.status) && Date.now() - new Date(r.endedAt).getTime() < 24 * 3600e3) items.push({ kind: 'run', level: 'error', id: r.id, title: `${r.label} ${r.status}`, body: r.reason || '' });
  }
  const cf = (cloud?.runs || []).find((r) => r.status === 'failed' && Date.now() - new Date(r.finished_at).getTime() < 24 * 3600e3);
  if (cf) items.push({ kind: 'cloud-run', level: 'error', title: 'A cloud collector run failed', body: cf.error || '' });
  // Tickets: ONLY the owner's move. Everything an AI can pick up stays in the Tickets tab.
  for (const t of (tickets?.needsOwner || []).slice(0, 5)) {
    items.push(t.why === 'merge_ready'
      ? { kind: 'ticket', level: 'info', id: t.id, title: `Ready to merge: ${t.title}`, body: `${t.prUrl || ''} — every check is green. Merge it in Tickets (${t.id}).`.trim() }
      : { kind: 'ticket', level: 'warning', id: t.id, title: `Blocked on you: ${t.title}`, body: `${t.body || ''}${t.body ? ' · ' : ''}Tickets → ${t.id}` });
  }
  // Data health (lib/data-health.mjs): only what needs a human — look-alike companies, a cleanup that failed.
  for (const d of dataHealth || []) items.push(d);
  return items;
}

export function changesList({ commits = [], deployment = null, activity = [], limit = 25 }) {
  const out = [];
  for (const c of commits) out.push({ at: c.date, kind: 'commit', repo: c.repo, title: c.message, url: c.url, short: c.short });
  if (deployment && deployment.createdAt) out.push({ at: deployment.createdAt, kind: 'deploy', title: `seenjobs.io deploy ${deployment.state || ''}`.trim(), url: deployment.url ? `https://${String(deployment.url).replace(/^https?:\/\//, '')}` : null, short: deployment.sha ? String(deployment.sha).slice(0, 7) : null });
  const MEANINGFUL = new Set(['approval', 'aggregation', 'build', 'board-meeting', 'self-update', 'task-delete', 'pr-verdict', 'data-health']);
  for (const a of activity) if (MEANINGFUL.has(a.kind) && !['queued', 'running'].includes(a.status)) out.push({ at: a.at || a.ts, kind: a.kind, title: a.summary }); // the ledger stamps `ts`
  return out.filter((x) => x.at && !Number.isNaN(new Date(x.at).getTime())).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit)
    .map((x) => ({ ...x, when: formatPT(x.at) }));
}

export function boardSection(state, now = new Date()) {
  if (!state) return { ran: false };
  const at = state.generatedAt || null;
  const ageHours = at ? Math.round((now - new Date(at)) / 3600e3) : null;
  const pending = (state.approvals || []).filter((a) => a.status === 'pending');
  const day = at ? new Date(at).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }) : null;
  return { ran: !!at, at, when: at ? formatPT(at) : null, day, ageHours, stale: ageHours != null && ageHours > 36,
    headline: state.debrief?.headline || null, topConstraint: state.debrief?.topConstraint || null,
    pending: pending.length, decided: (state.approvals || []).length - pending.length,
    actionItems: pending.slice(0, 6).map((a) => ({ id: a.id, title: a.title, summary: a.summary, dept: a.dept, risk: a.risk })) };
}

export async function homeSnapshot(deps, { now = () => new Date() } = {}) {
  const at = now().toISOString();
  // deps.tickets is the seam (tests); the live app reads the brain directly — the Home snapshot owns this.
  const readTickets = deps.tickets || (async () => (await import('./ticket-routes.mjs')).liveTicketsSummary());
  const [admin, mgr, commitsR, deployR, cloudR, ticketsR] = await Promise.all([
    settle(() => within(20000, deps.adminStats())),
    settle(async () => ({ status: await deps.aggregation.status(), recent: deps.aggregation.listRuns({ limit: 40 }) })),
    settle(() => within(15000, deps.commits(new Date(now() - 3 * 86400e3).toISOString()))),
    settle(() => within(15000, deps.deployment())),
    settle(() => within(15000, deps.cloudRuns())),
    settle(() => within(10000, Promise.resolve(readTickets()))),
  ]);
  const seen = admin.ok ? seenSection(admin.value, at) : { at, error: admin.error };
  const pipes = mgr.ok ? (mgr.value.status.pipelines || mgr.value.status) : null;
  const terminal = mgr.ok ? mgr.value.recent.filter((r) => r.endedAt) : [];
  const runs = mgr.ok ? {
    at,
    active: mgr.value.recent.filter((r) => ['queued', 'running'].includes(r.status)).map((r) => ({ id: r.id, label: r.label, status: r.status, trigger: r.trigger, startedAt: r.startedAt, since: r.startedAt ? formatPT(r.startedAt) : null, waitingFor: r.waitingFor || null })),
    recent: terminal.slice(0, 8).map((r) => ({ id: r.id, label: r.label, pipeline: r.pipeline, status: r.status, trigger: r.trigger, endedAt: r.endedAt, when: formatPT(r.endedAt), reason: r.reason || null, attempt: r.attempt || 1 })),
    schedules: pipes ? Object.entries(pipes).filter(([, p]) => p && p.schedule && p.schedule.enabled).map(([id, p]) => ({ pipeline: id, label: p.label || id, next: p.schedule.nextRunAt, nextWhen: p.schedule.nextRunAt ? formatPT(p.schedule.nextRunAt) : null, frequency: p.schedule.frequency, time: p.schedule.time })) : [],
  } : { at, error: mgr.error };
  const cloud = cloudR.ok ? { at, ...cloudR.value, runs: (cloudR.value.runs || []).slice(0, 10).map((r) => ({ ...r, when: formatPT(r.finished_at || r.started_at) })) } : { at, error: cloudR.error, runs: [] };
  const state = deps.state();
  const activity = (() => { try { return deps.activity(); } catch { return []; } })();
  return {
    at, today: ptDate(now()), when: formatPT(at),
    seen,
    needsYou: needsYouItems({ state, seen: seen.error ? null : seen, runs: runs.error ? null : runs, cloud, tickets: ticketsR.ok ? ticketsR.value : null,
      dataHealth: (() => { try { return deps.dataHealth ? deps.dataHealth() : []; } catch { return []; } })(), now: now() }),
    runs, cloud,
    changes: { at, error: commitsR.ok ? null : commitsR.error, items: changesList({ commits: commitsR.ok ? commitsR.value : [], deployment: deployR.ok ? deployR.value : null, activity }) },
    board: boardSection(state, now()),
  };
}
