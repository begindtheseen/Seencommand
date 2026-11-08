#!/usr/bin/env node
// The board-meeting run — on-demand and LIVE. v0.4: the agenda is GENERATED, not canned. Each
// department's model writes its read AND its concrete proposals grounded in: the current focus
// (preset or Brandon's custom one), Brandon's recent Board Room directives, the live connector
// data, the brain's facts, the last week of timeline (multi-day memory), the open task list, and
// what was already decided — so two meetings are never the same and the approvals queue reflects
// what Brandon actually asked for. The old deterministic drafts remain ONLY as the offline
// fallback, and the run is labeled agendaMode:'fallback' when used (honest, never silent).
//
// Output → data/state.json, which the command center renders. Exposed as runBoardMeeting() so the
// live server (engine/server.mjs) can trigger a fresh meeting; runs standalone via `node engine/run.mjs`.

import { fileURLToPath } from 'node:url';
import { kpiObservations } from '../brain/lib/metrics.mjs';
import { CEO, DEPARTMENTS } from '../org/org.mjs';
import { SEED, loadState, saveState, byArea, byPriority, memoryGraph } from '../lib/memory.mjs';
import { gatedActionFor, riskOf, buildTargetFor } from './policy.mjs';
import { DEFAULT_FOCUS, resolveFocus } from '../org/focus.mjs';
import { readBrainFacts, mergeFacts, recordBoardMeeting, recordFacts, recordDevLog, brainVault, readTimelineDigest } from '../lib/brain.mjs';
import { appendGitEpisode } from '../brain/lib/git-episodes.mjs';
import { logActivity } from '../lib/activity.mjs';
import { pushBrainSafe, syncDownSafe, cloudConfigured } from '../brain/lib/cloud.mjs';
import { rankFacts } from '../brain/lib/keeper.mjs';
import { config } from '../lib/config.mjs';
import { gatherLive, pickDeptContext, signalsFrom } from '../lib/connectors/index.mjs';
import { issuesFor, closedIssuesFor } from '../lib/connectors/github.mjs';
import { screenAndDemote } from './proposal-gate.mjs';
import { targetPremiseProblem, pathExistsAtGitRef } from './task-premise.mjs';
import { collectHandoffs, inboxByDept, routingLines, deriveHandoffs } from './bus.mjs';
import { reason, llmInfo, extractJson } from '../lib/llm.mjs';
import { isDeliverable } from './deliver.mjs';
import { findDuplicate, CONCRETE_ANCHOR } from '../lib/text.mjs';
import { roomBrief } from '../lib/room.mjs';
import { seenJobsFirst } from '../lib/priority.mjs';
import { openFailures } from '../lib/failure-loop.mjs';
import { libraryInsights, creatorEvidenceBlock, checkCreatorCitations, insightLine } from '../lib/instagram/insights.mjs';
import { moneyDeptBlock } from '../lib/money/live.mjs';
import { growthMeetingBlock } from '../lib/growth/meeting.mjs';

const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// The condensed admin summary if admin-stats answered cleanly, else null (degrade gracefully).
function liveAdmin(live) {
  const a = live.admin_stats;
  return a && !a.error && !a.notConfigured ? a : null;
}

// Seen sells one-time products (e.g. Interview Prep, Job Search Pass — nothing renews), so the
// money line is one-time revenue in the last 30 days from Seen's revenue funnel, never MRR. Unknown stays
// "—" (an older Seen deploy without the funnel), never $0.
const usd0 = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
export function revenueLine(r) {
  if (!r) return 'revenue unknown';
  if (r.month == null) return `revenue (30d) unknown${r.funnelError ? ` (${r.funnelError})` : ''}`;
  const bits = [`${r.payingCustomers ?? '?'} paying`, `${r.prepPurchases ?? '?'} Interview Prep`, `${r.passPurchases ?? '?'} Job Search Pass`];
  const funnel = r.interviews != null ? `; ${r.interviews} cards at an interview now${r.rates?.offer_click != null ? `, offer→click ${r.rates.offer_click}%` : ''}${r.rates?.checkout != null ? `, click→buy ${r.rates.checkout}%` : ''}` : '';
  const legacy = r.legacy?.subscribers ? `; ${r.legacy.subscribers} legacy subscriptions still running (not counted)` : '';
  return `revenue ${usd0(r.month)} in ${r.days || 30}d one-time (${bits.join(', ')})${funnel}${legacy}`;
}

// Real business KPIs for the debrief tiles — users / revenue / jobs / errors, straight from admin-stats.
function buildKpis(admin) {
  if (!admin) return [
    { label: 'Total users', value: '—', delta: 'connect admin-stats' },
    { label: 'Revenue (30 days)', value: '—', delta: null },
    { label: 'Active jobs', value: '—', delta: null },
    { label: 'Errors today', value: '—', delta: null },
  ];
  return [
    { label: 'Total users', value: fmt(admin.users?.total), delta: admin.users?.newToday ? `+${admin.users.newToday} today` : null },
    { label: 'Revenue (30 days)', value: usd0(admin.revenue?.month), delta: admin.revenue?.month == null ? 'funnel not readable' : `${admin.revenue.payingCustomers ?? 0} paying · one-time` },
    { label: 'Active jobs', value: fmt(admin.jobs?.active), delta: admin.jobs?.crisis ? '⚠ crisis' : `${fmt(admin.jobs?.stale)} stale` },
    { label: 'Errors today', value: fmt(admin.errors?.today), delta: admin.errors?.thisWeek != null ? `${fmt(admin.errors.thisWeek)}/wk` : null },
  ];
}

// One-line KPI string for prompts.
function kpiLine(kpis) { return kpis.map((k) => `${k.label} ${k.value}${k.delta ? ` (${k.delta})` : ''}`).join(' · '); }

// Morning briefing — what MOVED since the last board meeting. Pure + testable.
function toNum(v) { const n = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isNaN(n) ? null : n; }
function buildBriefing(prev, kpis, tasks) {
  const lines = [];
  const pk = Object.fromEntries((prev?.debrief?.kpis || []).map((k) => [k.label, k.value]));
  for (const k of kpis) {
    const now = toNum(k.value), was = pk[k.label] != null ? toNum(pk[k.label]) : null;
    if (was != null && now != null && now !== was) {
      const d = now - was;
      lines.push(`${k.label}: ${pk[k.label]} → ${k.value}  (${d > 0 ? '▲' : '▼'}${Math.abs(d).toLocaleString('en-US')})`);
    }
  }
  const pt = prev?.tasks?.length;
  if (pt != null && tasks.length !== pt) lines.push(`Open tasks: ${pt} → ${tasks.length}`);
  const err = kpis.find((k) => /errors/i.test(k.label));
  if (err && (toNum(err.value) || 0) > 0) lines.push(`⚠ ${err.value} errors today — worth a look`);
  return { since: prev?.generatedAt || null, lines };
}

// A compact, prompt-safe digest of a department's live slice — never dumps raw payloads.
function liveDigest(ctx) {
  const parts = [];
  const a = ctx.admin_stats;
  if (a && !a.error && !a.notConfigured) parts.push(`admin: users ${fmt(a.users?.total)} (+${a.users?.newToday ?? 0} today, ${a.users?.dau ?? 0} DAU), ${revenueLine(a.revenue)}, jobs ${fmt(a.jobs?.active)} active/${fmt(a.jobs?.stale)} stale, errors ${a.errors?.today ?? 0} today, ghost_rate ${a.funnel?.ghostRatePct ?? '?'}%`);
  else if (a?.error) parts.push(`admin: error (${a.error})`);
  const g = ctx.github;
  if (g && !g.error && !g.notConfigured) parts.push(`github: ${g.openPRs?.length ?? 0} open PRs, CI ${g.ci?.state ?? '?'}, ${g.openIssues?.length ?? 0} issues`);
  else if (g?.error) parts.push(`github: error (${g.error})`);
  const v = ctx.vercel;
  if (v?.deployment && !v.deployment.error) parts.push(`vercel: deploy ${v.deployment.none ? 'none' : (v.deployment.state ?? '?')}`);
  const s = ctx.supabase;
  if (s?.health) parts.push(`supabase: ${s.health.up ? 'up' : 'down'}${s.advisors?.available ? `, ${s.advisors.count} advisors` : ''}`);
  const st = ctx.stripe;
  if (st?.oneTime) parts.push(`stripe: ${st.oneTime.count} one-time payments, ${usd0(st.oneTime.total)} in 30d${st.subscriptions?.activeCount ? `; ${st.subscriptions.activeCount} legacy subscriptions` : ''}`);
  else if (st?.subscriptions) parts.push(`stripe: ${st.subscriptions.activeCount} legacy subscriptions`);
  return parts.length ? parts.join(' | ') : 'no live connectors wired to this department';
}

// --- deterministic worker drafts — the OFFLINE FALLBACK ONLY (labeled agendaMode:'fallback') -----
// Exported so a test can pin that every BUILDABLE kind keeps its dedicated copy — PR #74 silently
// deleted the 'platform PR' line to make room for a kind no worker has.
export function draftProposal(worker, thread, admin) {
  const base = { agent: worker.id, agentTitle: worker.title, dept: worker.dept, thread: thread ? thread.id : null, standing: !thread };
  const ctx = thread ? thread.title : worker.charter;
  const u = admin?.users, r = admin?.revenue, j = admin?.jobs, e = admin?.errors, f = admin?.funnel;
  const liveMap = admin ? {
    'kpi pack': `Live admin-stats: ${fmt(u?.total)} users (+${u?.newToday ?? 0} today, ${u?.dau ?? 0} DAU) · ${revenueLine(r)} · ${fmt(j?.active)} active jobs · ${e?.today ?? 0} errors today. Compiled for the debrief.`,
    'health report': `Errors today ${e?.today ?? 0} (${e?.thisWeek ?? 0}/wk); jobs ${fmt(j?.active)} active${j?.crisis ? ' — ⚠ CRISIS' : ''}; ${revenueLine(r)}. No new error-rate regression flagged.`,
    'anomaly read': `admin-stats scan: ${e?.today ?? 0} errors today, ghost_rate ${f?.ghostRatePct ?? '?'}%, ${u?.newToday ?? 0} new signups. ${(e?.today ?? 0) > 5 ? 'Error count elevated — flag.' : 'Nothing anomalous.'}`,
    'diagnosis': `From live data: ${r?.payingCustomers ?? 0} paying customers in 30 days on ${fmt(u?.total)} users (${revenueLine(r)}). Interview Prep sells at the interview moment, so the binding constraint is how many tracked applications reach an interview (${r?.interviews ?? '?'} now) and top-of-funnel volume (${u?.newToday ?? 0} signups today).`,
    'retention read': `${u?.dau ?? 0} DAU on ${fmt(u?.total)} users; reactivation opportunity in the dormant cohort. ${r?.interviews ?? '?'} tracked applications at an interview now.`,
  } : {};
  const propose = {
    'reddit plan': `Proposes this week's r/recruitinghell cadence (a value-first post + replies in the thread). Nothing sent — approve to file it as a task.`,
    'social plan': `(dormant channel — off)`,
    'intel brief': `Proposes this week's Ghost Report from company_scores (top ghosting companies). Approve to draft + file it.`,
    'research memo': `Watching competitor moves + market signals for angles Seen can own.`,
    'seo draft': `Proposes a company-page + comparison page tuned for search / AI-citation (GEO). Approve to file it as a task.`,
    'bugfix PR': `Proposes to triage + fix: ${ctx}. Approve to build it (test-gated PR).`,
    'feature PR': `Proposes to scope ${ctx} into a small change with tests. Approve to build it (test-gated PR).`,
    'review verdict': `Reviews the open PRs against the merge rules before they land.`,
    'migration draft': `Proposes a Supabase migration for ${ctx} (schema + RLS), advisor-checked. Approve to file — never auto-applied to prod.`,
    'cost alert': `Watching vendor spend + lock-in as a dependency risk (${ctx}).`,
    'perf proposal': `Proposes caching + indexing to cut cold-start stalls before they bite.`,
    'funnel experiment': `Proposes one experiment on the revenue funnel (interview → Prep offer → checkout) (${ctx}). Approve to file it as a task.`,
    'pricing proposal': `Proposes an offer-placement test for Interview Prep / the Pass within the locked prices. Approve to file it as a task.`,
    'sales draft': `Proposes employer outreach to staffing agencies on the Ghost Index. Approve to file it as a task.`,
    'dunning action': `Proposes follow-up on failed checkouts and refunds. Approve to file it as a task — no charges auto-run.`,
    'game plan': `Turns the diagnosis into a fix plan with owners across departments.`,
    'opportunity memo': `Names the biggest upside to double down on, grounded in the live numbers.`,
    'steering brief': `Synthesizes where the company should steer this week.`,
    'bug report': `Monitors Seen Command itself each run for broken runs / stale data / errors.`,
    'wiring audit': `Audits org ↔ memory ↔ dashboard for missing connections.`,
    'ux proposal': `Proposes a command-center usability improvement.`,
    'platform PR': `Proposes a Seen Command self-improvement. Approve to build it (test-gated PR).`,
  };
  const body = liveMap[worker.outputs] || propose[worker.outputs] || (thread ? `Proposes to tackle: ${thread.title}` : `Owns: ${worker.charter}`);
  const gatedAction = thread ? gatedActionFor(worker.outputs) : null;
  return {
    ...base, kind: worker.outputs, executed: true,
    title: thread ? `${worker.title} → ${thread.title}` : worker.title,
    body, gatedAction, effect: gatedAction ? 'gated' : 'internal',
  };
}

// --- dynamic agenda ------------------------------------------------------------------------------
// Every output kind ANY worker in the org can own — computed once. Lets normalizeAgendaItem tell a
// KIND TRESPASS (a real kind that belongs to a DIFFERENT dept → drop) apart from a typo/garbage kind
// (coerce to the dept's lead). Includes dormant workers' kinds ('social plan' is a real org kind even
// while the channel is off), so claiming an off channel's kind is still a trespass, never a coerce.
const ORG_KINDS = new Set(DEPARTMENTS.flatMap((d) => d.workers.map((w) => w.outputs)));

// The kinds the coding agent BUILDS (a PR / migration draft) rather than a human shipping content.
// engine/proposal-gate.mjs keeps the same set — both must move together if the org gains a kind.
const ENGINEERING_KINDS = new Set(['bugfix PR', 'feature PR', 'platform PR', 'migration draft']);

// CONCRETE_ANCHOR now lives in lib/text.mjs (so engine/builder.mjs can read it for lane routing
// without importing this meeting engine); re-exported here for existing callers + agenda.test.mjs.
export { CONCRETE_ANCHOR };

// Coerce one model-proposed agenda item into a real proposal, bound to a worker whose output kind it
// matches (invalid kind → the dept's lead worker). Gating is decided by POLICY (kind), never by the
// model, so nothing irreversible slips through as "internal". Three integrity guards stop the queue
// from decoupling what Brandon READS from what approve EXECUTES (today's queue held a "feature PR:
// Integrate Supabase Broadcast…" whose real kind was 'reddit plan' — approving it would post to Reddit):
//   (a) KIND TRESPASS — a real kind this dept can't own → drop.
//   (b) TITLE/KIND DECOUPLING — an engineering "<x> PR:" title prefix that names a different kind than
//       the one that will gate → drop; a matching prefix → strip (cosmetic).
//   (c) DONE-MEANS CONTRACT — no observable acceptance line in the detail → drop (kills vague theater).
//   (d) CONCRETENESS ANCHOR — an engineering proposal that names no path/file/route the coder can open
//       → drop (a whole-feature ask provably exhausts the patch-coder; #93-#96 all died at the gate).
// Exported for tests.
export function normalizeAgendaItem(dept, item, workers) {
  if (!item || typeof item !== 'object') return null;
  const active = workers.filter((w) => !w.dormant);
  if (!active.length) return null;
  const allowed = active.map((w) => w.outputs);
  // (a) KIND TRESPASS: a REAL org kind that isn't in THIS dept's active workers' outputs means the dept
  // is proposing work it can't own — approving it would fire a gate nobody here is accountable for. Drop
  // it (the caller filters nulls). An unknown/absent/garbage kind is a typo, not a trespass — keep the
  // coerce-to-lead below so a misspelling never kills an otherwise-good proposal.
  if (item.kind && ORG_KINDS.has(item.kind) && !allowed.includes(item.kind)) return null;
  const kind = allowed.includes(item.kind) ? item.kind : allowed[0];
  const worker = active.find((w) => w.outputs === kind) || active[0];
  let title = String(item.title || '').trim().slice(0, 140);
  const body = String(item.detail || item.body || '').trim().slice(0, 500);
  if (!title) return null;
  // (b) TITLE/KIND DECOUPLING: an engineering "<feature|bugfix|platform> PR:" title prefix is a CLAIM
  // about what approving this runs. If it names a different kind than the resolved one that actually
  // gates, the label and the action are decoupled → drop. If it names the SAME kind, the prefix is
  // redundant noise → strip it so the queue shows the real action, not a restated kind.
  const pfx = title.match(/^(feature|bugfix|platform)\s*PR\s*[:—–-]\s*/i);
  if (pfx) {
    if (`${pfx[1].toLowerCase()} PR` !== kind) return null;
    title = title.slice(pfx[0].length).trim();
    if (!title) return null;
  }
  // (c) DONE-MEANS CONTRACT: a proposal with no observable acceptance line is theater ("investigate and
  // optimize X … identifying areas for improvement"). Require a 'Done means:' sentence in the detail —
  // never fabricate one; a missing one means the model didn't commit to a checkable outcome. The text
  // rides in the body so it flows verbatim into the filed GitHub issue.
  if (!/\bdone means\s*:/i.test(body)) return null;
  // (d) CONCRETENESS ANCHOR — engineering kinds only. A whole-feature ask with no concrete target
  // provably exhausts the patch-coder: four employer feature tasks in a row (#93 "…Notification
  // System", #94 "Optimize…Workflow", #95 "Develop Employer Dashboard", #96 "…Analytics") each died
  // "could not reach a green gate in 8 rounds". The coder works in small SEARCH/REPLACE diffs against a
  // retrieved window (engine/coder.mjs) — it can build "add a page listing X from table Y", never
  // "develop a dashboard". So for a resolved ENGINEERING kind, require the title+detail to NAME a
  // path/file/route the coder can open (CONCRETE_ANCHOR); no anchor → it's a feature, not a step → drop.
  // Non-engineering kinds (reddit plan, intel brief, …) are untouched. Ordered last so the other guards
  // stay composable.
  if (ENGINEERING_KINDS.has(kind) && !CONCRETE_ANCHOR.test(`${title} ${body}`)) return null;
  const gatedAction = gatedActionFor(kind);
  return {
    agent: worker.id, agentTitle: worker.title, dept: dept.id, kind, executed: false,
    title, body: body || title, gatedAction, effect: gatedAction ? 'gated' : 'internal', generated: true,
  };
}

// One department's live agenda: { read, proposals[], engine } or null on any failure (→ fallback).
// Exported (with reasonFn injectable) so a smoke test can EXECUTE the whole body — PR #46 shipped a
// call to an undefined function in here with a green gate because nothing ever ran this path in tests.
export async function deptAgenda({ dept, focus, kpisStr, digest, memBlock, creatorBlock = '', timeline, directiveBlock, openTaskTitles, closedTaskTitles = [], decidedLines, reasonFn = reason }) {
  const active = dept.workers.filter((w) => !w.dormant);
  const allowed = active.map((w) => `"${w.outputs}"`).join(', ');
  const role = focus.dept[dept.id]?.role || 'support';
  const move = focus.dept[dept.id]?.move || `Advance "${focus.title}".`;
  const system = `You are ${dept.title} on Seen's AI executive board (Seen = a hiring-intelligence SaaS, seenjobs.io). Respond ONLY with JSON, no prose.`;
  const prompt = `COMPANY FOCUS: "${focus.title}" — ${focus.northStar}\nYour role for this focus: ${role.toUpperCase()} — ${move}\n\n`
    + `${directiveBlock}`
    + `LIVE KPIs: ${kpisStr}\nYOUR DEPARTMENT'S LIVE DATA: ${digest}\n\n`
    + `${memBlock}`
    + `${creatorBlock}`
    + `${timeline ? `WHAT HAPPENED RECENTLY (timeline, oldest→newest):\n${timeline}\n\n` : ''}`
    + `${openTaskTitles.length ? `TASKS ALREADY FILED (do NOT re-propose): ${openTaskTitles.join(' · ')}\n` : ''}`
    + `${closedTaskTitles.length ? `ALREADY DONE OR REJECTED (closed tasks — do NOT re-propose in ANY wording): ${closedTaskTitles.join(' · ')}\n` : ''}`
    + `${decidedLines.length ? `RECENTLY DECIDED (do NOT re-ask): ${decidedLines.join(' · ')}\n` : ''}`
    + `\nReturn JSON exactly like: {"read":"2-3 sentences — your department's read, grounded in the data and Brandon's directives","proposals":[{"title":"specific concrete action","detail":"1-2 concrete sentences","kind":<one of ${allowed}>}]}\n`
    + `Rules: 1-3 proposals, each a NEW concrete step that serves the FOCUS and Brandon's directives (the newest directive wins). `
    + `Every proposal's "detail" MUST end with 'Done means: <one observable behavior a human can check>'. `
    + `${creatorBlock ? 'When a CREATOR EVIDENCE line supports a proposal, name it in the detail with its exact support (e.g. "3 creators / 7 videos") — never invent a count or cite evidence that is not listed. ' : ''}`
    + `Only use kinds from your OWN allowed list — never label a proposal as another department's kind. `
    + `Engineering kinds ("bugfix PR","feature PR","platform PR","migration draft") are BUILT by the coding agent when approved. `
    + `Each must be ONE small change that ships as a single PR, and its "detail" MUST name the concrete target — an exact file path, route, script, or module (e.g. "add app/employers/dashboard/page.tsx — a read-only list of the employer's jobs from the jobs table"). `
    + `Propose a big feature as its FIRST small step, never the whole thing ("Develop Employer Dashboard" is too big — the coder builds one page, not a system). No fluff, no repeats of filed/decided work.`;
  try {
    // 60s window: a local last-resort lane needs ~40-90s for 700 tokens of JSON — a 20s attempt never
    // finishes yet still occupies Ollama's queue (starving any concurrent build). Give it a real shot.
    const r = await reasonFn({ deptId: dept.id, system, prompt, maxTokens: 700, timeoutMs: 60000, fallback: '' });
    if (r.engine === 'fallback' || !r.text) return null;
    const j = extractJson(r.text);
    const proposals = (Array.isArray(j.proposals) ? j.proposals : []).slice(0, 3)
      .map((it) => normalizeAgendaItem(dept, it, dept.workers)).filter(Boolean);
    if (!proposals.length) return null;
    const read = String(j.read || '').trim().slice(0, 600);
    return { read: read || `${dept.title}: agenda set.`, proposals, engine: r.engine };
  } catch { return null; }
}

export async function runBoardMeeting() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const stamp = now.toISOString();
  const prev = loadState();
  const runId = 'run-' + stamp.replace(/[-:T]/g, '').slice(0, 12);
  const focusId = (prev && prev.focusId) || DEFAULT_FOCUS;
  const customFocus = (prev && prev.customFocus) || null; // a freeform focus Brandon set, if any
  const focus = resolveFocus(prev);
  logActivity({ kind: 'meeting', id: runId, status: 'started', summary: `board meeting started — focus "${focus.title}"` });

  const threads = SEED.threads;
  const decisions = (prev && prev.decisions) || SEED.decisions;

  // Reason on the freshest ONLINE brain: pull anything newer from Supabase into the vault first.
  // FULL pass (path+updated_at listing, not the incremental window): a meeting is rare and ends in a
  // push, so it should start from a complete, clock-independent reconcile.
  if (cloudConfigured()) await syncDownSafe(brainVault(), { full: true });

  // Board Room correlation: Brandon's recent directives steer THIS meeting.
  let directives = [];
  try {
    if (cloudConfigured()) {
      const { getConversationSafe } = await import('../brain/lib/cloud.mjs');
      directives = (await getConversationSafe(40)).filter((m) => m.role === 'you').slice(-5).map((m) => m.text);
    }
  } catch { /* offline — no directives */ }
  const directiveBlock = directives.length ? `BRANDON'S RECENT DIRECTIVES (oldest→newest; the NEWEST overrides — obey these):\n${directives.map((d) => `- "${d}"`).join('\n')}\n\n` : '';

  // Multi-day memory: facts + the last week of the vault timeline.
  const brainFacts = readBrainFacts();
  const facts = mergeFacts(SEED.facts, brainFacts);
  const timeline = readTimelineDigest(7, 1200);
  // ONE ROOM: what Brandon said in the Board Room + his noted vision reach every department (lib/room.mjs).
  const room = roomBrief({ conversation: (prev && prev.chatContext) || [], facts: brainFacts });

  // --- 1) Gather every connector's live data ONCE + the real open-task list ---------------------
  const live = await gatherLive();
  // Creator Library → ranked, cited, cross-creator insights (deterministic, read-only, no model). Each
  // department below gets ONLY the lines that pass the strength bar for its job; none → no block.
  let creatorLib = null;
  try { creatorLib = await libraryInsights(); }
  catch (e) { process.stderr.write(`[run] creator evidence skipped: ${e.message}\n`); }
  const admin = liveAdmin(live);
  const kpis = buildKpis(admin);
  const kpisStr = kpiLine(kpis);
  const taskRepo = config.commandRepo();
  let tasks = [];
  try { tasks = await issuesFor(taskRepo); }
  catch (e) { process.stderr.write(`[run] task fetch failed: ${e.message}\n`); }
  const openTaskTitles = tasks.slice(0, 10).map((t) => t.title);
  // Closed tasks too: finished or REJECTED work must not come back as a fresh proposal in new
  // wording (the "Upgrade Chronos SDK" resurrection). Used in the prompt AND as a hard filter below.
  let closedTasks = [];
  try { closedTasks = await closedIssuesFor(taskRepo); }
  catch (e) { process.stderr.write(`[run] closed-task fetch failed: ${e.message}\n`); }
  const closedTaskTitles = closedTasks.slice(0, 20).map((t) => t.title);
  const TTL_MS = Number(process.env.APPROVAL_TTL_HOURS || 20) * 3600 * 1000;
  const priorDecisions = (prev && prev.decisions) || [];
  const decidedFor = (key) => priorDecisions
    .filter((d) => d.key === key && d.at && (now - new Date(d.at)) < TTL_MS)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  const decidedLines = priorDecisions.slice(0, 6).map((d) => `"${d.title}" → ${d.decision}`);

  // --- 2) Every department writes its LIVE agenda (parallel; per-dept fallback) ------------------
  const agendas = await Promise.all(DEPARTMENTS.map(async (dept) => {
    const ctx = pickDeptContext(live, dept.id);
    const digest = liveDigest(ctx);
    const mem = rankFacts(facts, `${dept.title} ${dept.charter} ${dept.kpi} ${focus.title}`, 6);
    const memBlock = (room ? `${room}\n\n` : '') + (mem.length ? `INSTITUTIONAL MEMORY (brain facts):\n${mem.map((f) => `- ${f.subject} · ${f.predicate}: ${f.object}`).join('\n')}\n\n` : '') + moneyDeptBlock(dept.id, live) + growthMeetingBlock(dept.id, { admin });
    const creator = creatorEvidenceBlock(creatorLib, dept.id);
    const agenda = await deptAgenda({ dept, focus, kpisStr, digest, memBlock, creatorBlock: creator.text, timeline, directiveBlock, openTaskTitles, closedTaskTitles, decidedLines });
    return { dept, ctx, agenda, creatorUsed: creator.used };
  }));

  const agents = {};
  const proposals = [];
  const reasoningBy = {};
  let dynamicDepts = 0;
  const creatorByDept = {};
  const creatorCited = [];
  for (const { dept, ctx, agenda, creatorUsed } of agendas) {
    const handoffs = deriveHandoffs(dept.id, ctx); // rule-based, from real numbers
    let deptProposals;
    if (agenda) {
      dynamicDepts++;
      deptProposals = agenda.proposals;
      reasoningBy[dept.id] = { deptId: dept.id, title: dept.title, text: agenda.read, engine: agenda.engine };
    } else {
      // Model unreachable for THIS dept: keep its INTERNAL live-data reads (real numbers), but never
      // queue canned approvals — a fallback dept asks for nothing rather than re-pitching stock items.
      const queue = byPriority(byArea(threads, dept.id));
      const activeW = dept.workers.filter((w) => !w.dormant);
      deptProposals = activeW
        .map((w, i) => draftProposal({ ...w, dept: dept.id, charter: w.charter }, queue[i] || null, admin))
        .filter((p) => !p.gatedAction);
      const read = deptProposals[0]?.body || dept.charter;
      reasoningBy[dept.id] = { deptId: dept.id, title: dept.title, text: `${read} (model unreachable this round — no new asks)`, engine: 'fallback' };
    }
    // PROPOSAL SANITY GATE (engine/proposal-gate.mjs) — the approval-queue analog of the coder's
    // phantom-reference lint. The prompt only ASKS the model not to re-propose or invent; this is the
    // HARD filter. Proposals with a phantom premise (a "Chronos SDK" that doesn't exist), a reworded
    // closed task (de-noised so the description tail can't hide it), or content off-charter for the
    // raising dept (a growth "reddit plan" carrying an engineering task — #81) are DEMOTED to inert:
    // visible in the meeting with a ⛔ note (auditable), but never gated/queued/filed/built.
    // PROPOSAL_GATE=0 disables.
    deptProposals = screenAndDemote(deptProposals, {
      closedTitles: closedTaskTitles,
      // Live open-PR titles from the bundle already gathered this run. NULL (not []) when GitHub is
      // unreadable, so a connector outage cannot silently look like "no duplicates exist".
      openPRTitles: (live?.github && !live.github.error && !live.github.notConfigured)
        ? (live.github.openPRs || []).map((pr) => pr && pr.title).filter(Boolean) : null,
      targetCheck: (p) => {
        const target = buildTargetFor(p.kind);
        if (!target) return null;
        const root = target === 'product' ? config.productRepoDir() : config.commandRepoDir();
        const base = target === 'product' ? config.githubBranch() : config.commandBranch();
        return targetPremiseProblem({ task: `${p.title} ${p.body}`, repoLabel: `${target} repo`,
          targetExists: (path) => pathExistsAtGitRef(root, `origin/${base}`, path) });
      },
    }, (m) => process.stderr.write(m));
    if (deptProposals.length && handoffs.length) deptProposals[0].handoffs = handoffs;
    // Creator-evidence citations are checked in CODE: a "N creators / M videos" the dept was never
    // shown is labelled unverified on the proposal itself, so Brandon never approves on an invented count.
    if (creatorUsed.length) creatorByDept[dept.id] = creatorUsed.map((i) => ({ id: i.id, type: i.type, basis: i.basis, claim: i.claim, strength: i.strength, support: { creators: i.support.creators, videos: i.support.videos } }));
    for (const p of deptProposals) {
      const chk = checkCreatorCitations(`${p.title} ${p.body}`, creatorUsed);
      if (chk.cited.length) { p.creatorEvidence = chk.cited; creatorCited.push({ dept: dept.id, title: p.title, insightIds: chk.cited }); }
      if (chk.phantom.length) { p.creatorEvidenceUnverified = chk.phantom; p.body = `${p.body} (⚠ cites creator evidence not in the Creator Library: ${chk.phantom.join(', ')} — unverified)`; }
    }
    proposals.push(...deptProposals);
    // agent statuses: a worker with a proposal is working (or waiting at the gate); the rest hold their charter
    for (const w of dept.workers) {
      const p = deptProposals.find((x) => x.agent === w.id);
      agents[w.id] = w.dormant
        ? { status: 'idle', task: 'off — switch on when ready', dept: dept.id }
        : p
          ? { status: p.gatedAction ? 'waiting' : 'working', task: p.title, dept: dept.id }
          : { status: 'working', task: w.charter, dept: dept.id };
    }
  }
  agents[CEO.id] = { status: 'working', task: `steering to "${focus.title}" across ${DEPARTMENTS.length} departments`, dept: 'command' };
  const agendaMode = dynamicDepts === DEPARTMENTS.length ? 'dynamic' : dynamicDepts > 0 ? 'partial' : 'fallback';

  // DETERMINISTIC dedupe — the model rewords the same work, so this is code, not prompt-hope. A gated
  // proposal that matches an OPEN task, a RECENT decision, or an earlier proposal in THIS meeting is
  // demoted to internal (visible, but never re-asked / re-filed). Fixes the triplicate-task spam.
  const openTitles = tasks.map((t) => t.title);
  const decidedTitles = priorDecisions.slice(0, 30).map((d) => d.title).filter(Boolean);
  const seenThisRun = [];
  for (const p of proposals) {
    if (!p.gatedAction) continue;
    const dup = findDuplicate(p.title, [...seenThisRun, ...openTitles, ...decidedTitles]);
    if (dup) {
      p.gatedAction = null; p.effect = 'internal'; p.duplicateOf = dup;
      p.body = `${p.body} — already tracked ("${dup}"), not re-asking.`;
    } else {
      seenThisRun.push(p.title);
    }
  }

  // SEENJOBS FIRST (lib/priority.mjs): a proposal about Seen Command itself reaches Brandon only when a
  // recorded failure is behind it (then it fixes something that broke); otherwise it is held back, kept on
  // the record with the reason. The approvals queue is about seenjobs.io.
  let openFails = [];
  try { openFails = openFailures({ days: 14 }).open || []; } catch { /* no failure log yet */ }
  for (const p of proposals) {
    if (!p.gatedAction) continue;
    const v = seenJobsFirst(p, { build: buildTargetFor(p.kind), failures: openFails });
    if (!v.keep) { p.gatedAction = null; p.effect = 'internal'; p.heldBack = v.why; p.body = `${p.body} — held back: ${v.why}.`; }
    else if (v.failure) p.fixesFailure = v.failure;
  }

  // --- 3) Cross-team routing (message bus) -------------------------------------------------------
  const routed = collectHandoffs(proposals);
  const inbox = inboxByDept(routed);
  const routing = routingLines(routed);

  // A proposal that cited creator evidence carries those exact lines (with video + timestamp links)
  // into the filed task, so whoever acts on it can check the evidence without opening the app.
  const creatorLineById = new Map((creatorLib?.insights || []).map((i) => [i.id, insightLine(i, { citations: 2, urls: true, excerpt: 100 })]));
  const creatorEvidenceMd = (p) => (p.creatorEvidence?.length
    ? `\n\n**Creator evidence cited** (Creator Library — research, not proof):\n${p.creatorEvidence.map((id) => creatorLineById.get(id)).filter(Boolean).join('\n')}` : '');

  // --- 4) Approvals queue: gated proposals park, with REAL titles; TTL keeps decided ones quiet ---
  const approvals = proposals.filter((p) => p.gatedAction).map((p, i) => {
    const key = `${p.dept}:${p.kind}:${slug(p.title)}`;
    const prior = decidedFor(key);
    const build = buildTargetFor(p.kind); // 'tool' | 'product' | null
    return {
      id: `${runId}-a${i + 1}`, key,
      dept: p.dept, agent: p.agentTitle,
      title: p.title, summary: p.body, action: p.kind, risk: riskOf(p.kind),
      gate: p.gatedAction,
      build,
      buildTask: build ? `${p.title}. ${p.body}`.slice(0, 600) : null,
      onApprove: build
        ? `kicks the test-gated builder → a ${build === 'tool' ? 'Seen Command' : 'Seen product'} PR (plus a tracked task)`
        : isDeliverable(p.kind)
          ? 'drafts the actual deliverable (grounded via Chronos) + files it for your review'
          : `files a tracked task (GitHub issue) in ${taskRepo}`,
      status: prior ? prior.decision : 'pending',
      decidedAt: prior ? prior.at : null,
      exec: { connector: 'github', method: 'executeFileIssue', args: [{
        repo: taskRepo,
        title: `[${p.dept}] ${p.title}`,
        body: `**Proposed by:** ${p.agentTitle} (${p.dept} dept)\n**Gate:** ${p.gatedAction}\n\n${p.body}${creatorEvidenceMd(p)}\n\n---\n_Filed by Seen Command when Brandon approved it._`,
        labels: [],
      }] },
    };
  });
  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;

  // --- 5) Morning debrief ------------------------------------------------------------------------
  const internalCount = proposals.filter((p) => !p.gatedAction).length;
  const engines = [...new Set(Object.values(reasoningBy).map((r) => r.engine))];
  const live_lane = engines.find((e) => e !== 'fallback') || 'fallback';
  const debrief = {
    date: today,
    focus: { id: focus.id, title: focus.title, emoji: focus.emoji, northStar: focus.northStar },
    directives,
    agendaMode,
    headline: agendaMode === 'fallback'
      ? `Focus: ${focus.title}. No AI model was reachable, so the departments filed their standing drafts; ${pendingApprovals} decision${pendingApprovals === 1 ? '' : 's'} wait for you.`
      : `Focus: ${focus.title}. The departments put forward ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}; ${pendingApprovals} decision${pendingApprovals === 1 ? '' : 's'} wait for you.`,
    sections: DEPARTMENTS.map((d) => {
      const rz = reasoningBy[d.id];
      const bullets = [];
      if (rz) bullets.push(`Department read (${rz.engine}): ${rz.text}`);
      for (const p of proposals.filter((p) => p.dept === d.id)) {
        bullets.push(`${p.agentTitle}: ${p.title}${p.body && p.body !== p.title ? ` — ${p.body}` : ''}${p.gatedAction ? ' (awaiting your yes/no)' : ''}`);
      }
      return { title: d.title, bullets };
    }),
    kpis,
    routing,
    topConstraint: reasoningBy['strategy']?.text || null,
    steer: reasoningBy['strategy']?.text || null,
  };
  debrief.briefing = buildBriefing(prev, kpis, tasks);

  // --- 6) Signals strip + state ------------------------------------------------------------------
  const signals = { ...signalsFrom(live), llm: llmInfo() };
  const state = {
    generatedAt: stamp,
    runId,
    today,
    focusId,
    customFocus,
    agendaMode,
    ceo: CEO,
    departments: DEPARTMENTS,
    agents,
    proposals,
    approvals,
    decisions,
    threads: byPriority(threads.filter((t) => t.status !== 'done')),
    debrief,
    signals,
    tasks,
    tasksRepo: taskRepo,
    handoffs: routed,
    inbox,
    reasonEngine: live_lane,
    memoryGraph: memoryGraph(facts, threads),
    // What the Creator Library contributed to THIS meeting (null when it had nothing strong enough).
    creatorEvidence: Object.keys(creatorByDept).length ? {
      runId, at: stamp, generatedAt: creatorLib.generatedAt,
      creators: creatorLib.totals.creators, posts: creatorLib.totals.posts,
      byDept: creatorByDept, cited: creatorCited,
    } : null,
  };
  // The Board Room conversation lives in this file too. Re-read it NOW (a meeting takes minutes and
  // Brandon may have chatted meanwhile) — without this every meeting wiped the room's local memory.
  try { const latest = loadState() || {}; for (const k of ['chatContext', 'chatSessionIds', 'chatSessionId']) if (latest[k] !== undefined) state[k] = latest[k]; } catch { /* first run */ }
  const path = saveState(state);

  // --- 7) Record the live facts back into the shared brain (bi-temporal; grows the graph) --------
  let recorded = { written: 0 };
  if (admin) {
    const obs = kpiObservations(admin); // the ONE list of KPI readings (brain/lib/metrics.mjs) — brain-sync records the same
    const g = live.github;
    if (g && !g.error && !g.notConfigured) obs.push({ subject: 'Seen repo', predicate: 'open_prs', object: String(g.openPRs?.length ?? 0), confidence: 'high' });
    const v = live.vercel?.deployment;
    if (v && !v.error && v.state) obs.push({ subject: 'Seen deploy', predicate: 'state', object: String(v.state), confidence: 'high' });
    const sb = live.supabase?.health;
    if (sb && sb.up != null) obs.push({ subject: 'Supabase', predicate: 'health', object: sb.up ? 'up' : 'down', confidence: 'high' });
    recorded = recordFacts(obs);
  }
  // `focus.title` lands in the brain as the bi-temporal fact `Seen Command · current_focus`.
  // INVARIANT: re-recording the SAME title must be a no-op, not a supersede. That check lives in
  // lib/brain.mjs writeOne() (and in seen's recordFact on the shared-writer path) and compares the
  // value read back OUT of the vault against the one about to be written — so it holds only while
  // the vault's writer and parser are exact inverses. They drifted, and every meeting re-superseded
  // the identical focus. Before touching brain/lib/chronos/memoryGraph.mjs or
  // brain/lib/memory-write.mjs, read the parity guard in brain/lib/memory-write.test.mjs.
  const brained = recordBoardMeeting(null, {
    runId, date: today, autoExecuted: internalCount, parked: pendingApprovals,
    openItems: state.threads.length, focus: focus.title,
  });

  // Narrate the WORK, not just the numbers: one dev-log episode listing the PRs merged since the
  // previous meeting. Without this the brain records KPIs moving with no explanation — twelve PRs
  // merged on 2026-07-31 left zero trace in the vault. Runs BEFORE the cloud push so the episode
  // ships in the same mirror. Guarded twice (here and inside the module): narration must NEVER fail
  // a board meeting, and a failed append leaves the cursor so the next run retries.
  let devlog = null;
  try { devlog = appendGitEpisode({ append: recordDevLog, date: today }); }
  catch (e) { process.stderr.write(`[run] dev-log episode skipped: ${e.message}\n`); }

  // Chronos delegates storage: mirror the whole brain to Supabase (online truth). Guarded.
  const cloud = cloudConfigured() ? await pushBrainSafe(brainVault()) : null;

  const gateDemoted = proposals.filter((p) => p.gateBlocked).length; // proposal-gate knocked these out of the queue
  logActivity({ kind: 'meeting', id: runId, status: 'completed',
    summary: `board meeting done — ${approvals.length} queued, ${gateDemoted} gate-demoted, ${pendingApprovals} pending (${agendaMode})`,
    detail: `${proposals.length} proposals total · reasoning ${live_lane} · KPIs: ${kpisStr}` });

  console.log(`Board meeting ${runId} — agenda ${agendaMode}: ${proposals.length} proposals, ${pendingApprovals} pending / ${approvals.length - pendingApprovals} carried, reasoning via ${live_lane}.`);
  console.log(`Live KPIs: ${kpisStr}`);
  console.log(`Cross-team routes: ${routing.length}${routing.length ? ' → ' + routing.join(' ; ') : ''}`);
  console.log(`Brain: ${brainFacts.length} vault facts read → ${facts.length} in graph; ${recorded.written} live facts recorded${brained ? '; run logged to vault' : ''}.`);
  const ce = state.creatorEvidence;
  console.log(ce
    ? `Creator evidence: ${ce.creators} creators / ${ce.posts} videos → ${Object.entries(ce.byDept).map(([d, l]) => `${d} ${l.length}`).join(' · ')} line(s); ${ce.cited.length} proposal(s) cited it.`
    : `Creator evidence: none sent (${creatorLib?.totals?.creators ? 'nothing at moderate+ strength yet' : 'no researched creators'}).`);
  if (devlog?.wrote) console.log(`Dev log: ${devlog.prs} PR(s) + ${devlog.direct} direct commit(s) narrated from ${devlog.repos.join(', ')}.`);
  else if (devlog?.retry) console.log(`Dev log: append failed (${devlog.error}) — cursor held, retrying next run.`);
  if (cloud) console.log(`Cloud: brain mirrored to Supabase — ${cloud.notes} notes · ${cloud.facts} facts · ${cloud.episodes} episodes.`);
  console.log(`Wrote ${path}`);

  return { runId, proposals: proposals.length, approvals: approvals.length, reasonEngine: live_lane, agendaMode, kpis, recorded: recorded.written };
}

// Run when invoked directly (node engine/run.mjs or via the Electron app's ELECTRON_RUN_AS_NODE).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('../lib/notify-wire.mjs');
  runBoardMeeting().catch((err) => { console.error('board meeting failed:', err); process.exit(1); });
}
