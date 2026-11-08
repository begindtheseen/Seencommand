#!/usr/bin/env node
// Local app server — turns the static dashboard into a live app. Dependency-free node:http. Serves
// public/ AND a small API the UI calls, so Approve/Deny, the Board Room chat, and "run board
// meeting" are REAL (they hit connectors + the model + persist to state), not cosmetic.
//
//   GET  /api/state           → current data/state.json
//   GET  /api/signals         → live GitHub/CI/deploy/KPI strip
//   POST /api/board-meeting   → run a fresh board meeting, returns summary
//   POST /api/chat            → { message, deptId? } → reason() over live state
//   POST /api/approve         → { id, decision } → execute gated action + persist decision
//   /api/aggregation/*        → the Aggregation Dashboard (lib/aggregation/routes.mjs)
//   /api/data-health*         → duplicates + stale listings on seenjobs.io (lib/data-health.mjs)
//
// `npm run serve` or the Electron app spawns this; the window loads http://localhost:PORT.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, saveState } from '../lib/memory.mjs';
import { runBoardMeeting } from './run.mjs';
import { reason, llmInfo } from '../lib/llm.mjs';
import { signals, executeGated } from '../lib/connectors/index.mjs';
import { rankFacts } from '../brain/lib/keeper.mjs';
import { readBrainFacts } from '../lib/brain.mjs';
import { departmentById, DEPARTMENTS } from '../org/org.mjs';
import { publicDir, REPO_ROOT, dataDir } from '../lib/paths.mjs';
import { writeBuild, queueBuild, readBuild, listBuilds, reconcileStaleBuilds } from '../lib/builds.mjs';
import { buildTargetForTask, taskShape } from './policy.mjs';
import { issuesFor, issueInfo, issueStateFor, executeCommentIssueIn, executeCloseIssueIn, executeFileIssue } from '../lib/connectors/github.mjs';
import { config } from '../lib/config.mjs';
import { isDeliverable, draftDeliverable, draftForTask } from './deliver.mjs';
import { CAPABILITIES } from '../org/capabilities.mjs';
import { FOCUSES, buildCustomFocus, resolveFocus } from '../org/focus.mjs';
import { readTimelineDigest, readTimelineEntries, readDecisions, currentFacts, recordFacts, recordDevLog } from '../lib/brain.mjs';
import { logActivity } from '../lib/activity.mjs';
import { handleInstagram, handleInstagramChat } from '../lib/instagram/routes.mjs';
import { handleAggregation } from '../lib/aggregation/routes.mjs';
import { handleBrainRoute, startBrainBackground } from '../lib/brain-routes.mjs';
import { aggregationManager, searchService } from './aggregation-manager.mjs';
import { parseSearchCommand, METHODS as SEARCH_METHODS } from './search.mjs';
import { planChatSearch } from './search-planner.mjs';
import { recoverInterrupted as igRecover } from '../lib/instagram/jobs.mjs';
import { runChatAgent } from './agent-chat.mjs';
import { answerOwned } from './owned-brain.mjs';
import { configureCline, credentialStatus, saveCredentials, startClineSignIn, testClineConnection } from '../lib/credentials.mjs';
import { usageReport } from '../lib/ai-usage.mjs';
import { platformStatus, platformContext } from '../lib/platform-status.mjs';
import { gatherLocalContext, brainContext } from '../lib/context-gather.mjs';
import { parseApprovalEdit, editApproval, resolveApproval } from './approval-control.mjs';
import { WorkflowStore } from '../intelligence/workflow-store.mjs';
import { intelligenceRuntimeStatus } from '../intelligence/runtime-status.mjs';
import { loadRuntimeConfig } from '../intelligence/runtime-config.mjs';
import { discoverModels } from '../intelligence/model-registry.mjs';
import { baseHealthJob } from '../lib/base-health-job.mjs';
import { notifications, notify } from '../lib/notifications.mjs';
import { createAssistantRoutes } from '../lib/assistant/routes.mjs';
import { createSkillWatcher, skillsContext, SKILL_DIRS } from '../lib/assistant/skills.mjs';
import { openClaudeTerminal } from '../lib/terminal.mjs';
import { createUpdater } from '../lib/updater.mjs';
import { parseRoomAddress, createMeetingRelay } from '../lib/room.mjs';
import { createSimulations } from '../lib/simulations.mjs';
import { handleMoney, numbersFor as moneyNumbersFor } from '../lib/money/routes.mjs';
import { homeSnapshot } from '../lib/home.mjs';
import { fetchCloudRuns, pollCloudRuns } from '../lib/cloud-runs.mjs';
import { readActivity } from '../lib/activity.mjs';
import * as adminStatsConn from '../lib/connectors/adminStats.mjs';
import { recentCommitsFor } from '../lib/connectors/github.mjs';
import { latestDeployment } from '../lib/connectors/vercel.mjs';
import { createDataHealth, createDataHealthRoutes } from '../lib/data-health.mjs';
import { recordFailure, resolveFailure } from '../lib/failure-loop.mjs';

const PUBLIC = publicDir();
const PORT = Number(process.env.PORT || 4173);
const READ_SWEEP_MS = 30_000;   // GET /api/builds is polled every 2.5s — don't sweep on every poll
let lastBuildSweep = 0;
try { igRecover(); } catch { /* no instagram jobs yet — recover on next start */ }
const intelligenceWorkflows = new WorkflowStore();
try { intelligenceWorkflows.recoverInterrupted(); } catch { /* no intelligence workflows yet */ }

// The app's own version — so the CEO knows what it's running (no more guessing "1.0").
let SC_VERSION = 'unknown';
try {
  const v = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  let sha = ''; try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }).toString().trim(); } catch { /* packaged */ }
  SC_VERSION = `v${v}${sha ? ` (build ${sha})` : ''}`;
} catch { /* ignore */ }

// Rebuild the static dashboard from the current state (run after a fresh board meeting so a reload
// shows the new numbers). Resolves when the build finishes.
function rebuildDashboard() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'build-dashboard.mjs')], { cwd: REPO_ROOT, env: process.env, stdio: 'ignore' });
    p.on('exit', resolve); p.on('error', resolve);
  });
}
// Kick the test-gated builder in the BACKGROUND (detached so it outlives this request and even the
// app window). It writes its lifecycle to data/builds/<id>.json, which the dashboard polls. We seed a
// 'queued' record synchronously so the UI shows the build the instant approve returns.
function startBuild({ id, key, repo, task, title, issueRepo, issueNumber }) {
  // queueBuild (not writeBuild) so a re-run under this stable id wears NONE of the last run's verdict —
  // above all not its pid, which made the stale sweep reap a just-kicked build as a dead one.
  queueBuild(id, { id, key: key || null, repo, task, title: title || task,
    issue: issueRepo && issueNumber ? { repo: issueRepo, number: issueNumber } : null });
  const args = ['engine/build-runner.mjs', '--id', id, '--repo', repo, '--task', task];
  if (key) args.push('--key', key);
  if (title) args.push('--title', title);
  if (issueRepo && issueNumber) args.push('--issue-repo', issueRepo, '--issue-number', String(issueNumber));
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, detached: true, stdio: 'ignore' });
  child.on('error', (e) => { try { writeBuild(id, { status: 'failed', error: `spawn failed: ${e.message}`, endedAt: new Date().toISOString() }); } catch { /* ignore */ } });
  child.unref();
}

// "Build X" — file a tracked task (GitHub issue, label auto-build) and start the test-gated builder on it.
// The builder codes in an isolated worktree, runs the full gate and opens a draft PR only when green;
// merging stays the owner's (merge-pr + his confirm phrase). Shared by the Board Room's deterministic
// "build … in Seen Command" command and POST /api/tasks/new (`act.mjs build`). repo: 'tool' | 'product'.
async function fileAndBuild({ repo, task }) {
  const target = repo === 'tool' ? 'Seen Command' : 'Seen product';
  const title = String(task).replace(/^\s*(?:build|fix|implement|refactor|patch)\s+/i, '').slice(0, 90);
  const filed = await executeFileIssue({
    repo: config.commandRepo(),
    title: `[${repo === 'tool' ? 'platform' : 'product'}] ${title}`,
    body: `Requested and approved by Brandon in Board Room.\n\n**Target:** ${target}\n\n**Request:** ${task}\n\n**Gate:** Implement with the coding agent, pass the full test gate, and open a draft PR only if green.\n\n---\n_Filed by Seen Command from an explicit Board Room build command._`,
    labels: ['auto-build'],
  });
  const id = `task-${filed.number}`;
  const existing = readBuild(id);
  if (existing && (existing.status === 'queued' || existing.status === 'building')) return { filed, id, target, title, already: true };
  startBuild({ id, repo, task, title, issueRepo: filed.repo, issueNumber: filed.number });
  logActivity({ kind: 'build', id, status: 'kicked', summary: `build kicked for task #${filed.number} (${target}) — ${title}` });
  return { filed, id, target, title, already: false };
}

// Execute one approval for real — draft the deliverable / file the task / kick the builder — and record
// the decision. Shared by /api/approve AND the Board Room chat (so "approve the Ghost Report" in chat
// does exactly what clicking Approve does). Mutates `state`; returns the outcome (or { error }).
async function runApproval(state, appr, decision) {
  if (!['approve', 'deny'].includes(decision)) return { error: 'decision must be approve or deny' };
  appr.status = decision === 'approve' ? 'approved' : 'denied';
  appr.decidedAt = new Date().toISOString();
  let execResult = null; let building = null; let delivered = false;
  if (decision === 'approve' && appr.exec && appr.exec.args && appr.exec.args[0] && isDeliverable(appr.action)) {
    try {
      const d = await draftDeliverable({ kind: appr.action, task: `${appr.title} — ${appr.summary || ''}`, dept: appr.dept });
      if (d && d.body) { appr.exec.args[0].title = d.title || appr.exec.args[0].title; appr.exec.args[0].body = `${d.body}\n\n---\n${appr.exec.args[0].body}`; delivered = true; }
    } catch (e) { process.stderr.write(`[server] deliverable draft failed (filing stub): ${e.message}\n`); }
  }
  if (decision === 'approve' && appr.exec) {
    try { execResult = await executeGated(appr.exec); appr.executed = true; }
    catch (e) { appr.status = 'pending';
      logActivity({ kind: 'approval', id: appr.id, status: 'failed', summary: `approve "${appr.title}" failed to execute`, detail: e.message });
      return { error: e.message }; }
  }
  if (decision === 'approve' && appr.build && appr.buildTask) {
    try { startBuild({ id: appr.id, key: appr.key, repo: appr.build, task: appr.buildTask, title: appr.title, issueRepo: execResult && execResult.repo, issueNumber: execResult && execResult.number }); building = { id: appr.id, repo: appr.build }; }
    catch (e) { process.stderr.write(`[server] build kick failed: ${e.message}\n`); }
  }
  state.decisions = state.decisions || [];
  state.decisions.unshift({ id: appr.id, key: appr.key, title: appr.title, decision: appr.status, at: new Date().toISOString(), executed: !!appr.exec && decision === 'approve' });
  state.decisions = state.decisions.slice(0, 200);
  const triggered = decision !== 'approve' ? 'dropped — won\'t be re-proposed'
    : building ? `kicked the ${building.repo} builder`
    : delivered ? 'drafted the deliverable + filed it'
    : execResult && execResult.url ? `filed a tracked task (${execResult.url})`
    : 'executed';
  logActivity({ kind: 'approval', id: appr.id, status: appr.status,
    summary: `${decision === 'approve' ? 'approved' : 'denied'} "${appr.title}" — ${triggered}` });
  return { status: appr.status, execResult, building, delivered };
}

// Map free text to a focus id (mirrors the client). null = no clear focus mentioned.
function focusFromText(t) {
  t = (t || '').toLowerCase();
  if (/pa(y|id)|revenue|mrr|money|monetiz|convert|sales/.test(t)) return 'revenue';
  if (/reten|activat|churn|keep|onboard|engage/.test(t)) return 'retention';
  if (/reliab|uptime|cost|scal|infra|stable|stability/.test(t)) return 'reliability';
  if (/user|signup|sign up|grow|traffic|acquisition|audience/.test(t)) return 'users';
  return null;
}

// Detect an ACTIONABLE command in a Board Room message. Returns the action to execute, or null (chat).
// Deterministic (no model) so the CEO never hallucinates having acted — it only claims what really ran.
// Pull the target of a focus command out of the message, or null if it isn't one.
function parseFocusCommand(m) {
  let x = /\b(?:set|change|switch|make|shift|update|move|point)\b[^]*?\b(?:focus|priority|prioriti[sz]e)\b[^]*?\b(?:to|on|toward|towards|:)\s+(.+)/i.exec(m)
    || /^\s*focus\s+(?:on|to)\s+(.+)/i.exec(m)
    || /\b(?:change|switch|set|make)\s+(?:this|it|our focus|the focus)\s+to\s+(.+)/i.exec(m);
  return x ? x[1].trim().replace(/[."'\s]+$/, '') : null;
}

// A direct engineering command ("fix the X", "build Y in seen command") → which repo + the task, or
// null. Ambiguous repo → { repo: null } so the CEO asks instead of guessing at a codebase.
function parseBuildCommand(m) {
  const t = String(m).trim();
  const verb = /^(?:build|fix|implement|refactor|patch)\b/i.test(t)
    || /\b(?:have|get|tell)\s+the\s+(?:builder|coder|coding agent)\b/i.test(t)
    || /\bwrite\s+(?:the\s+)?code\b/i.test(t);
  if (!verb || t.length < 12) return null;
  const tool = /\bseen command\b|\bcommand center\b|\bcommand os\b|\bcockpit\b|\bthe app\b|\bthe os\b|\bboard room\b|\bchronos\b/i.test(t);
  const product = /\bseenjobs\b|\bseen\s*\.\s*io\b|\bthe (?:site|website|product)\b|\badmin (?:page|site|dashboard)\b|\bjob (?:board|page|listing)/i.test(t);
  if (tool && !product) return { repo: 'tool', task: t };
  if (product && !tool) return { repo: 'product', task: t };
  return { repo: null, task: t };
}

function detectChatAction(message, state) {
  const m = String(message).trim();
  if (/\b(?:run|start|do)\b[^.?!]*\bmaintenance\b/i.test(m)) return { type: 'search', preset: 'maintenance' };
  if (/\bfill\b[^.?!]*\bthinnest\b/i.test(m)) return { type: 'search', preset: 'reports:thinnest' };
  if (/\b(?:pull|refresh|sync)\b[^.?!]*\b(?:job )?boards\b/i.test(m)) return { type: 'search', preset: 'boards:stalest' };
  // "open claude in seen", "open a claude terminal for seen command", "launch claude code on the website repo"
  if (/\b(?:open|start|launch)\b[^.?!]*\bclaude\b/i.test(m) && /\b(?:terminal|session|code|in|on|for)\b/i.test(m)) {
    const repo = /\bseen[\s-]*command\b|\bcommand\b|\bthis app\b/i.test(m) ? 'command' : /\bseen\b|\bseenjobs\b|\bwebsite\b|\bsite\b|\bproduct\b/i.test(m) ? 'seen' : 'command';
    return { type: 'terminal', repo };
  }
  const room = parseRoomAddress(m);
  if (room) return room.board ? { type: 'board', question: room.question } : { type: 'dept', dept: room.dept, question: room.question };
  const search = parseSearchCommand(m);
  if (search) return { type: 'search', ...search };
  const edit = parseApprovalEdit(m, state);
  if (edit) return edit;
  if (/\b(run|start|hold|kick off|do)\b[^.?!]*\bboard meeting\b/i.test(m) || /^\s*(run|start) the meeting\b/i.test(m)) return { type: 'meeting' };
  if (/\b(?:update|upgrade|rebuild)\s+(?:yourself|the app|seen command)\b/i.test(m)
    || /\bself[- ]?update\b/i.test(m) || /\b(?:apply|install)\s+(?:the\s+)?(?:updates?|improvements?)\b/i.test(m)) return { type: 'self-update' };
  const target = parseFocusCommand(m);
  if (target) { const f = focusFromText(target); return f ? { type: 'focus', focusId: f } : { type: 'focus', custom: target }; }
  const build = parseBuildCommand(m);
  if (build) return { type: 'build', ...build };
  // Chronos writes from chat — the deliberate exception to "conversation never mutates" (Brandon,
  // 2026-08-13: "seen command must communicate read and write to chronos"). Deterministic shapes only:
  // "record fact <subject> | <predicate> | <object>" for a typed fact, "remember: <text>" for a
  // timeline note. Both go through the ONE shared writer and are verified read-after-write.
  const factM = /^\s*record\s+fact\s+(.+?)\s*[|·]\s*(.+?)\s*[|·:]\s*(.+)$/i.exec(m);
  if (factM) return { type: 'remember', fact: { subject: factM[1].trim(), predicate: factM[2].trim(), object: factM[3].trim() } };
  const remM = /^\s*remember[:,]?\s+(.+)/is.exec(m);
  if (remM) return { type: 'remember', text: remM[1].trim() };
  const approve = /\b(approve|green-?light|go ahead with|ship the|publish the|do the|kick off the|build the)\b/i.exec(m);
  const deny = /\b(deny|reject|skip|decline|drop the|don'?t do the)\b/i.exec(m);
  if (approve || deny) {
    const pend = (state.approvals || []).filter((a) => a.status === 'pending');
    if (!pend.length) return { type: 'no-pending' };
    const numeric = /\b(?:approval|proposal)?\s*#?\s*(\d{1,4})\b/i.exec(m);
    if (numeric) {
      const resolved = resolveApproval(state, numeric[1]);
      if (resolved.approval) return { type: 'decide', decision: deny ? 'deny' : 'approve', appr: resolved.approval };
    }
    // score each pending approval by word overlap with the message
    const words = new Set(m.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
    const scored = pend.map((a) => {
      const hay = `${a.title} ${a.summary} ${a.action} ${a.dept}`.toLowerCase();
      let s = 0; words.forEach((w) => { if (hay.includes(w)) s++; });
      return { a, s };
    }).sort((x, y) => y.s - x.s);
    if (scored[0].s === 0) return { type: 'which', decision: deny ? 'deny' : 'approve', options: pend };
    return { type: 'decide', decision: deny ? 'deny' : 'approve', appr: scored[0].a };
  }
  return null;
}

// The single-shot, memory-augmented answer — the OLD chat behavior. It stays as the honest fallback for
// the streaming agent (engine/agent-chat.mjs) when the claude CLI isn't logged in, and still powers the
// per-department chats. Returns { reply, engine }; the caller persists the turns.
async function singleShotChat(message, deptId, state, suppliedLiveContext = '') {
  const dept = deptId ? departmentById(deptId) : null;
  const kpis = (state?.debrief?.kpis || []).map((k) => `${k.label} ${k.value}`).join(' · ');
  const focus = (state ? resolveFocus(state).title : null) || state?.debrief?.focus?.title || 'users';
  let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
  const cloudStored = cloud ? await cloud.getConversationSafe(30) : [];
  const stored = cloudStored.length ? cloudStored : (state?.chatContext || []);
  const convo = stored.map((m) => `${m.role === 'you' ? 'Brandon' : 'You (CEO)'}: ${m.text}`).join('\n');
  let mem = '';
  try { mem = rankFacts(readBrainFacts(), message, 8).map((f) => `- ${f.subject} · ${f.predicate}: ${f.object}`).join('\n'); } catch { /* ignore */ }
  let week = '';
  try { week = readTimelineDigest(7, 1100); } catch { /* no vault */ }
  let liveContext = suppliedLiveContext;
  if (!deptId && !liveContext) {
    try {
      const snapshot = await platformStatus();
      liveContext = [platformContext(snapshot), gatherLocalContext(message)].filter(Boolean).join('\n\n');
    } catch { /* model fallback remains usable if a diagnostic collector fails */ }
  }
  const persona = dept
    ? `You are ${dept.title} on Seen Command — Brandon's agentic exec OS for Seen (seenjobs.io), running ${SC_VERSION}. Charter: ${dept.charter}`
    : `You are the CEO / Orchestrator of Seen Command — Brandon's agentic exec OS for Seen (seenjobs.io). You are the app itself, running ${SC_VERSION}.`;
  const system = `${persona}\n\n${CAPABILITIES}\n\n`
    + `Hold a REAL conversation with Brandon: read the history and answer the point he's actually making — including short replies like "this is wrong", "why?", "what version are we on?". `
    + `CRITICAL: this reply is CONVERSATION only — composing it does NOT run a meeting, change the focus, or approve anything (those happen through a separate action path that answers instantly, not through your prose). So NEVER say "I've updated the focus / ran the meeting / started X" — you didn't. If Brandon asked you to change something and you're replying in words, it wasn't recognized as a command — tell him to say it plainly (e.g. "set focus to <goal>"). `
    + `Answer questions about your own capabilities STRICTLY from the ground-truth list above. Obey the HARD RULES: no theater, never claim you did something you didn't. `
    + `Do NOT recite user counts, job counts, or KPIs unless he specifically asks about them. If you don't know something, say so plainly. `
    + `STYLE: Markdown is rendered — use **bold**, short bullet lists, and \`code\` when they make the answer clearer. Lead with the answer, keep it tight (no filler, no restating the question), but be COMPLETE: a real answer beats a clipped one. For strategy/judgment questions, give a clear recommendation and the one-line why.`;
  const prompt = `THE CURRENT FOCUS IS "${focus}" — this is the LIVE truth from app state right now. If Brandon asks what the focus is, answer with exactly that. Older messages in the history may mention different focuses that are now OUTDATED — ignore them; "${focus}" is correct.\n\n`
    + `${liveContext ? `${liveContext}\n\nUse this freshly gathered evidence before Brain/history. If it does not contain the requested fact, say what is missing; never imply you inspected a source that is not shown.\n\n` : ''}`
    + `${week ? `WHAT ACTUALLY HAPPENED RECENTLY (the shared brain's timeline, last 7 days — use this to answer "what did we do / what happened / progress" questions with SPECIFICS):\n${week}\n\n` : ''}`
    + `${convo ? `Conversation so far (for tone/thread only — NOT the source of truth for focus/state):\n${convo}\n\n` : ''}Brandon just said: "${message}"\n\n`
    + `${mem ? `Relevant facts from the brain (use only if they bear on his message):\n${mem}\n\n` : ''}`
    + `App version: ${SC_VERSION}. (Live KPIs available if asked: ${kpis || 'n/a'}.)\n\nReply as yourself.`;
  // 900 tokens + a patient window: the free hosted lanes answer in seconds; when they're down the
  // local 32B needs minutes, not the 20s conversational default (the machine-loop timeout lesson).
  const r = await reason({ deptId: deptId || 'command', system, prompt, maxTokens: 900, timeoutMs: 120000,
    fallback: `I can't reach a reasoning lane right now (rate-limited or offline), so I won't fake an answer — try again in a moment.` });
  return { reply: r.text, engine: r.engine };
}

function conversationContext(state, max = 16) {
  const turns = (state?.chatContext || []).slice(-max);
  if (!turns.length) return '';
  return `RECENT BOARD ROOM TURNS (conversation continuity only; live snapshot still wins):\n${turns.map((m) => `${m.role === 'you' ? 'Brandon' : 'Board Room'}: ${String(m.text || '').slice(0, 1200)}`).join('\n')}`;
}

async function persistChatTurns(message, reply, deptId, cloud, { fresh = false } = {}) {
  if (cloud) {
    try { await cloud.appendMessageSafe('you', message, deptId); await cloud.appendMessageSafe('ceo', reply, deptId); } catch { /* local continuity still works */ }
  }
  // Keep the served history current without a network round trip (the Board Room reads it on every open).
  if (!deptId && chatHistoryCache) chatHistoryCache = { at: chatHistoryCache.at, messages: [...chatHistoryCache.messages, { role: 'you', text: String(message) }, { role: 'ceo', text: String(reply || '') }].slice(-300) };
  if (deptId) return;
  try {
    const s = loadState() || {};
    const prior = fresh ? [] : (s.chatContext || []);
    const at = new Date().toISOString();
    s.chatContext = [...prior, { role: 'you', text: String(message).slice(0, 6000), at }, { role: 'ceo', text: String(reply || '').slice(0, 12000), at }].slice(-30);
    saveState(s);
  } catch { /* conversation persistence must never break a reply */ }
}

// Execute a wired Board Room command (the deterministic action path) and return { reply, action }. Shared
// by POST /api/chat and the streaming POST /api/chat/stream so a command does the SAME real thing on both.
// The caller persists the turns and shapes the response.
// `say` narrates REAL milestones as they pass — a board meeting takes minutes, and streaming nothing
// until it finishes made the app look hung. Every message below marks a boundary we actually crossed;
// none of them are invented granularity, because a fake progress bar is just theater with a spinner.
// "RUN: <search>" at the end of a model reply → run it like the owner typed it, if (and only if) it is a
// search or a preset. Returns { reply, action } or null.
async function runModelHandoff(reply, state, say = () => {}) {
  const m = /^\s*RUN:\s*(.{3,300})$/m.exec(String(reply || ''));
  if (!m) return null;
  const cmd = m[1].replace(/^["“']|["”']$/g, '').trim();
  const act = detectChatAction(/^(?:search|find|collect|pull|aggregate|run|fill)\b/i.test(cmd) ? cmd : `search ${cmd}`, state || {});
  if (!act || act.type !== 'search') return null;
  return runWiredAction(act, cmd, say);
}

async function runWiredAction(act, message, say = () => {}) {
  let reply = ''; let action = null;
  try {
    if (act.type === 'search') {
      say('planning the search…');
      // Presets run as named. A typed request is planned first (company vs field, related titles, places,
      // the careers page, which methods) — the planner never blocks: slow or unusable → the parser's plan.
      let input = { preset: act.preset, text: act.text, keywords: act.keywords, url: act.url, methods: act.only };
      let planned = null;
      if (!act.preset) {
        planned = await planChatSearch(message, act, { catalog: await searchService().catalog(), reasonFn: reason });
        input = planned.input;
        say(planned.planned ? 'planned — starting every method that fits…' : 'starting every method that fits…');
      }
      const r = await searchService().start(input, { origin: 'Board Room' });
      if (!r.ok) reply = `I couldn't start that search: ${r.error}.`;
      else {
        const s = r.search;
        const what = s.kind === 'preset' ? `the **${s.label}** preset` : s.kind === 'company' ? `**${s.company}**${s.keywords ? ` — roles: ${s.keywords}` : ' — every open role'} (company search)` : `**${s.field}**${(s.titles || []).length > 1 ? ` + ${s.titles.slice(1).join(', ')}` : ''} (field search across every company)`;
        const where = s.kind !== 'preset' && (s.locations || []).length ? `\nWhere: ${s.locations.join(', ')}.` : '';
        const why = planned?.planned ? (planned.why ? `\nWhy: ${planned.why}` : '') : planned ? '\n(Read by the quick parser — the AI planner was not available, so related titles and places were not added.)' : '';
        reply = `Started ${what}.${where}${why}\n\n${s.steps.map((x) => `- ${x.label}: ${x.status === 'not started' ? `not started — ${x.error}` : x.status}`).join('\n')}\n\nThe Chrome collectors take turns on the Browser Bridge; the rest run at the same time. Results go straight to seenjobs.io — it's in **Search → History**, and you'll get a notification when the whole search is done.`;
        action = { type: 'search', id: s.id };
      }
    } else if (act.type === 'dept') {
      // A department speaks in the room: its own brief + the live meeting state, answering Brandon here.
      const dep = departmentById(act.dept);
      say(`asking ${dep?.title || act.dept}…`);
      const r = await singleShotChat(act.question, act.dept, loadState());
      reply = `**${dep?.title || act.dept}:** ${String(r.reply || '').trim() || '(no answer — its model lane was unavailable)'}`;
    } else if (act.type === 'board') {
      // Every department answers in parallel (each capped), then Command lands where they agree and what to do.
      say('asking every department…');
      const st = loadState();
      const answers = await Promise.all(DEPARTMENTS.map((d) => Promise.race([
        singleShotChat(act.question, d.id, st).then((r) => ({ d, text: String(r.reply || '').trim() })).catch(() => ({ d, text: '' })),
        new Promise((res) => setTimeout(() => res({ d, text: '' }), 90_000)),
      ])));
      const got = answers.filter((a) => a.text);
      say('putting it together…');
      const syn = got.length ? await reason({ deptId: 'strategy', system: 'You chair Seen\'s board. Given each department\'s answer to the owner\'s question, write: where they agree, where they disagree, and the ONE move you recommend (with which department owns it). 6 short lines max. No preamble.', prompt: `Owner's question: ${act.question}\n\n${got.map((a) => `${a.d.title}: ${a.text.slice(0, 900)}`).join('\n\n')}`, maxTokens: 380, fallback: '' }) : { text: '' };
      reply = [`**The board on:** ${act.question}`, '', ...got.map((a) => `**${a.d.title}:** ${a.text.replace(/\n+/g, ' ').slice(0, 600)}`), ...(answers.length > got.length ? ['', `_${answers.length - got.length} department(s) did not answer in time._`] : []), ...(syn.text ? ['', `**Command's call:** ${syn.text.trim()}`] : [])].join('\n');
    } else if (act.type === 'terminal') {
      const r = await openClaudeTerminal({ repo: act.repo });
      reply = r.ok ? `Opened Claude Code in Terminal, in the ${act.repo === 'seen' ? 'Seen (seenjobs.io)' : 'Seen Command'} checkout (${r.dir}).` : `I couldn't open Terminal: ${r.error}`;
    } else if (act.type === 'meeting') {
      say('starting a board meeting — gathering live connector data (GitHub, Supabase, Vercel, Stripe, admin KPIs)…');
      const rb = await runBoardMeeting();
      say(`meeting done — ${rb.proposals} proposals, ${rb.approvals} approvals queued via ${rb.reasonEngine}. Rebuilding the cockpit…`);
      await rebuildDashboard();
      reply = `Done — ran a board meeting (${rb.runId}): ${rb.proposals} proposals, ${rb.approvals} approvals queued, reasoned via ${rb.reasonEngine}. Home, the Board report and Tasks are updated.`;
      action = { type: 'reload' };
    } else if (act.type === 'focus') {
      const s2 = loadState();
      let title;
      if (act.custom) { s2.customFocus = buildCustomFocus(act.custom); s2.focusId = 'custom'; title = s2.customFocus.title; }
      else { s2.focusId = act.focusId; s2.customFocus = null; title = FOCUSES[act.focusId]?.title; }
      const f = resolveFocus(s2);
      if (s2.debrief) {
        s2.debrief.focus = { id: f.id, title: f.title, emoji: f.emoji, northStar: f.northStar };
        if (s2.debrief.headline) s2.debrief.headline = s2.debrief.headline.replace(/^Focus:[^.]*\./, `Focus: ${f.title}.`);
      }
      saveState(s2); await rebuildDashboard();
      reply = `Focus set to ${title}. Realigned the team — Home and the Board report reflect it now, and the next board meeting will steer to it.`;
      action = { type: 'focus', focusId: s2.focusId, custom: !!act.custom, title };
    } else if (act.type === 'decide') {
      const s2 = loadState(); const appr = (s2.approvals || []).find((a) => a.id === act.appr.id);
      if (appr) say(`${act.decision === 'approve' ? 'approving' : 'denying'} "${appr.title}" — running the same path as the button…`);
      const rr = appr ? await runApproval(s2, appr, act.decision) : { error: 'that item is no longer pending' };
      if (rr.error) { reply = `Couldn't ${act.decision} "${act.appr.title}": ${rr.error}`; }
      else {
        saveState(s2); await rebuildDashboard();
        reply = act.decision === 'approve'
          ? `Approved "${appr.title}". ${rr.building ? `The test-gated builder is writing the code now (${rr.building.repo} repo).` : rr.delivered ? `I drafted the deliverable and filed it as a task.` : rr.execResult && rr.execResult.url ? `Filed as a tracked task: ${rr.execResult.url}` : 'Done.'}`
          : `Denied "${appr.title}" — dropped, won't be re-proposed.`;
        action = { type: 'reload' };
      }
    } else if (act.type === 'edit-approval') {
      if (!act.approval) {
        reply = `I didn't edit anything because that target is ambiguous. Pending approvals: ${act.options.map((o, i) => `${i + 1}. "${o.title}"`).join(' · ') || 'none'}. Try “edit approval 2 summary to …” or use its title.`;
      } else {
        const s2 = loadState();
        const live = (s2?.approvals || []).find((a) => a.id === act.approval.id);
        if (!live || live.status !== 'pending') reply = `I didn't edit anything because that approval is no longer pending.`;
        else {
          const before = act.field === 'repo' ? live.build : live[act.field];
          editApproval(s2, live, { field: act.field, value: act.value });
          const landed = act.field === 'repo' ? live.build : live[act.field];
          saveState(s2); await rebuildDashboard();
          const verified = (loadState()?.approvals || []).find((a) => a.id === live.id);
          const confirmed = act.field === 'repo' ? verified?.build : verified?.[act.field];
          if (confirmed !== landed) throw new Error(`approval edit did not survive read-after-write verification (${act.field})`);
          logActivity({ kind: 'approval-edit', id: live.id, status: 'edited', summary: `edited ${act.field} for "${live.title}"` });
          const label = ({ targetPath: 'target path', acceptanceCriteria: 'acceptance criteria', repo: 'target repo' })[act.field] || act.field;
          reply = `Updated and verified the pending approval's **${label}**:\n\n> ${before || '(not set)'} → ${confirmed}\n\nThe approval card and the exact task/build payload that will run on approval are in sync.`;
          action = { type: 'reload' };
        }
      }
    } else if (act.type === 'self-update') {
      const child = spawn(process.execPath, ['engine/self-update.mjs'], { cwd: REPO_ROOT, env: process.env, detached: true, stdio: 'ignore' });
      child.unref();
      reply = `Self-update started: merging green self-improvement PRs, pulling main, running the FULL test gate, rebuilding the app, then RESTARTING it (~2-4 min). This window will close and reopen on the new build. If any step fails, nothing is installed and the update record shows exactly where (no silent failures).`;
      action = { type: 'self-update' };
    } else if (act.type === 'build') {
      if (!act.repo) {
        reply = `I haven't filed or started anything yet because the target is ambiguous. Which codebase — Seen Command (this app) or the Seen product (the site)? Say it with the repo, e.g. "build ${act.task.slice(0, 40)}… in Seen Command".`;
      } else {
        say(`filing a tracked task against ${act.repo === 'tool' ? 'Seen Command' : 'Seen product'}…`);
        const { filed, id, target } = await fileAndBuild({ repo: act.repo, task: act.task });
        reply = `Filed tracked task #${filed.number}${filed.existing ? ' (existing)' : ''}: ${filed.url}\n\nThe test-gated builder is now working on ${target}. Track it in Tasks; a draft PR opens only if the full gate passes.`;
        action = { type: 'build', id, repo: act.repo, task: { number: filed.number, url: filed.url } };
      }
    } else if (act.type === 'remember') {
      const r = await recordBrainNote(act);
      reply = r.ok
        ? r.kind === 'fact'
          ? (r.unchanged
            ? `Already in the brain, unchanged: **${act.fact.subject} · ${act.fact.predicate} = ${act.fact.object}** (re-recording an identical value is a no-op).`
            : `Recorded and verified in the brain: **${act.fact.subject} · ${act.fact.predicate} = ${act.fact.object}** — visible in Seen Command → Brain → Activity.`)
          : (r.unchanged
            ? 'That note is already on today\'s timeline — unchanged.'
            : `Noted on today's brain timeline (${r.note}): “${String(act.text).slice(0, 120)}”.`)
        : `I could NOT record that: ${r.error}`;
      if (r.ok) action = { type: 'brain-write', kind: r.kind };
    } else if (act.type === 'which') {
      reply = `Which one? Pending right now: ${act.options.map((o) => `"${o.title}"`).join(' · ')}. Name it and I'll ${act.decision} it.`;
    } else if (act.type === 'no-pending') {
      reply = `Nothing is pending approval right now — say "run a board meeting" and I'll generate the queue.`;
    }
  } catch (e) { reply = `I tried to do that but hit an error: ${e.message}`; }
  return { reply, action };
}

// Deterministic Chronos WRITE — shared by the "remember"/"record fact" chat actions and
// POST /api/brain/record. Typed facts supersede-never-overwrite through the one shared writer;
// freeform text becomes a timeline note. Every write is verified by a read-after-write and
// activity-logged; a no-op or a missing vault is reported as exactly that, never as success.
export async function recordBrainNote({ fact = null, text = '', heading = 'Board Room — noted by Brandon' } = {}) {
  if (fact) {
    if (!fact.subject || !fact.predicate || fact.object == null || fact.object === '') {
      return { ok: false, error: 'a fact needs subject, predicate, and object' };
    }
    const r = recordFacts([{ ...fact, confidence: 'high', source: 'board-room (Brandon)' }]);
    const live = (currentFacts() || []).some((f) => f.subject === fact.subject
      && f.predicate === fact.predicate && String(f.object) === String(fact.object));
    if (!live) return { ok: false, error: 'the write did not land (no vault, or the writer failed) — nothing was recorded' };
    logActivity({ kind: 'brain-write', status: r.written ? 'written' : 'unchanged', summary: `fact ${fact.subject} · ${fact.predicate} = ${String(fact.object).slice(0, 80)}` });
    return { ok: true, kind: 'fact', written: !!r.written, unchanged: !r.written };
  }
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'nothing to record' };
  const r = recordDevLog({ heading, text: t, key: t.slice(0, 40) });
  if (!r) return { ok: false, error: 'the timeline write failed (no vault?) — nothing was recorded' };
  logActivity({ kind: 'brain-write', status: r.skipped ? 'unchanged' : 'written', summary: `note: ${t.slice(0, 80)}` });
  return { ok: true, kind: 'timeline', note: r.note, unchanged: !!r.skipped };
}

// Delete a tracked task WITHOUT losing the fact that it existed. Brandon's requirement: a delete
// "doesnt just delete it but make it known to brain that its deleted" — a task that silently vanishes
// is indistinguishable from one that was never filed, and the board would happily re-propose it.
//
// So "delete" means: close the real GitHub issue (issues are never hard-deleted — closing keeps the
// audit trail and is reversible), leave a comment saying who closed it and why, record the episode in
// Chronos so the brain knows the work was dropped ON PURPOSE, cancel any stale local build record so
// the card cannot keep showing as in-flight, and VERIFY the close actually landed before reporting
// success. If GitHub accepted nothing, this returns an error rather than a cheerful lie.
export async function deleteTask({ number, reason = '', repo = null } = {}, deps = {}) {
  const close = deps.closeIssue || executeCloseIssueIn;
  const verify = deps.issueState || issueStateFor;
  const info = deps.issueInfo || issueInfo;
  const record = deps.recordBrainNote || recordBrainNote;
  const activity = deps.logActivity || logActivity;
  const builds = deps.readBuild || readBuild;
  const write = deps.writeBuild || writeBuild;
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'a task number is required' };
  const target = repo || config.commandRepo();
  const why = String(reason || '').trim() || 'no reason given';

  let title = '';
  try { const i = await info(target, n); title = String(i?.title || ''); } catch { /* the close is what matters */ }

  try {
    await close({ repo: target, number: n, comment: `Deleted from Seen Command by Brandon.\n\n**Reason:** ${why}\n\n_Closed rather than erased so the history survives; recorded in the Chronos brain so the board will not re-propose it as new work._` });
  } catch (e) { return { ok: false, error: `GitHub refused the close: ${e.message}` }; }

  // Read-after-write: a 200 from the API is not proof the issue is actually closed.
  let state = null;
  try { state = await verify(target, n); } catch { state = null; }
  if (state && state !== 'closed') return { ok: false, error: `the issue is still ${state} on GitHub — nothing was recorded` };

  const brain = await record({
    heading: `Task deleted — ${target}#${n}${title ? ` ${title}` : ''}`,
    text: `Brandon deleted task #${n}${title ? ` ("${title}")` : ''} from the Seen Command Tasks tab.\nReason: ${why}\nThe GitHub issue is CLOSED, not erased: https://github.com/${target}/issues/${n}\nThis was dropped deliberately — do not re-propose it as new work without new evidence.`,
  });

  // A dead build record would keep the card rendering as "building" forever.
  let cancelledBuild = false;
  try {
    const b = builds(`task-${n}`);
    if (b && ['queued', 'building'].includes(b.status)) {
      write(`task-${n}`, { status: 'failed', error: `task #${n} was deleted by Brandon (${why}) — build abandoned`, endedAt: new Date().toISOString() });
      cancelledBuild = true;
    }
  } catch { /* no build record — nothing to cancel */ }

  activity({ kind: 'task-delete', id: `task-${n}`, status: 'closed', summary: `deleted task #${n}${title ? ` "${title}"` : ''} — ${why}` });
  return {
    ok: true, number: n, repo: target, title, reason: why, cancelledBuild,
    recordedToBrain: !!brain.ok,
    brainError: brain.ok ? null : brain.error,
    url: `https://github.com/${target}/issues/${n}`,
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// A chat message has to be BOUNDED. Without this, a 100KB paste (or a runaway client) went straight
// to a model lane: the request hung for minutes, the UI looked frozen, and the spend was real. The
// cap is generous — ~5,000 words, far past any genuine question or pasted stack trace — and it
// REJECTS rather than silently truncating, because quietly answering half a question is worse than
// saying the message is too long. Measured: a 100KB message did not crash the server, it just hung.
const MAX_CHAT_CHARS = 20000;
function tooLong(message) {
  const n = String(message || '').length;
  return n > MAX_CHAT_CHARS
    ? `that message is ${n.toLocaleString()} characters — I cap chat at ${MAX_CHAT_CHARS.toLocaleString()} so a huge paste can't hang the app or burn model spend. Trim it, or point me at a file/PR and I'll read it myself.`
    : null;
}

// Credential mutation is a localhost-only, same-origin capability. JSON requests already trigger the
// browser's CORS preflight cross-origin; this explicit check also blocks form tricks and a server that
// was accidentally exposed beyond loopback. No credential value is ever included in a response.
function credentialRequestAllowed(req) {
  const remote = String(req.socket?.remoteAddress || '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return false;
  const origin = String(req.headers.origin || '');
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

// Home: one live snapshot of what matters (lib/home.mjs). Cached 30 s so tab switches are instant; ?refresh=1 forces.
let homeCache = null;
// Home is served from memory and refreshed in the background (stale-while-revalidate), prepared right after
// the server starts, and kept on disk so a fresh launch shows the last snapshot instantly — the splash used
// to give way to ~3 s of empty cards while Home's six live reads finished.
const HOME_DISK = () => join(dataDir(), 'home-cache.json');
let homeValue = (() => { try { return JSON.parse(readFileSync(HOME_DISK(), 'utf8')); } catch { return null; } })();
let homeInflight = null;
// Job-list pages: the same query within 30 s is answered from memory (each Seen round trip is 0.3–1.5 s),
// and the two pages the app opens with are prepared at startup. An edit/remove/restore clears the cache.
const jobsCache = new Map();
function jobsPage(filters) {
  const key = JSON.stringify(filters);
  const hit = jobsCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const p = adminStatsConn.adminAction({ action: 'jobs_browse', filters });
  jobsCache.set(key, { at: Date.now(), p });
  p.catch(() => jobsCache.delete(key));
  if (jobsCache.size > 200) jobsCache.delete(jobsCache.keys().next().value);
  return p;
}
// Data health (lib/data-health.mjs): duplicates + stale listings, found and cleaned through Seen's admin API.
// A finished cleanup drops the cached job pages and Home, so the next look shows the new counts.
const dataHealth = createDataHealth({
  action: (b) => adminStatsConn.adminAction(b), stats: () => adminStatsConn.stats(), configured: () => !!config.adminCreds(),
  file: () => join(dataDir(), 'data-health.json'), logActivity, notify, recordFailure, failureRepo: () => config.githubRepo(),
  // The queue line is resolved by id; the brain ticket by its kind + thing (the failure-loop hook only knows builds).
  resolveFailure: (f) => {
    resolveFailure(f);
    import('../lib/ticket-wire.mjs').then((m) => m.ticketSources.resolveFrom({ kind: 'data_cleanup_failed', repo: config.githubRepo(), thing: 'data-health-auto', ref: f.id, how: f.how })).catch(() => {});
  },
  onFinished: () => { jobsCache.clear(); refreshHome().catch(() => {}); },
});
function refreshHome() {
  if (homeInflight) return homeInflight;
  homeInflight = homeSnapshot(homeDeps()).then((v) => {
    homeValue = v; homeCache = { t: Date.now() };
    try { writeFileSync(HOME_DISK(), JSON.stringify(v)); } catch { /* the disk copy is a convenience */ }
    return v;
  }).finally(() => { homeInflight = null; });
  return homeInflight;
}
let chatHistoryCache = null, chatHistoryInflight = null;
export const _invalidateChatHistory = () => { chatHistoryCache = null; };
function homeDeps() {
  return {
    // Home's numbers + Seen's revenue funnel (one-time sales, 30 days); a Seen without the funnel → revenue unknown.
    adminStats: async () => { const [s, f] = await Promise.all([adminStatsConn.stats(), adminStatsConn.revenueFunnel(30).catch(() => null)]); return { ...s, revenue_funnel: f }; },
    aggregation: aggregationManager(),
    commits: async (since) => {
      const lists = await Promise.all([[config.githubRepo(), config.githubBranch()], [config.commandRepo(), config.commandBranch()]]
        .map(([repo, branch]) => recentCommitsFor({ repo, branch, since, n: 15 }).catch(() => [])));
      return lists.flat();
    },
    deployment: () => latestDeployment(),
    cloudRuns: () => fetchCloudRuns(),
    state: () => loadState(),
    activity: () => readActivity({ days: 3 }),
    dataHealth: () => dataHealth.needsYou(),
  };
}

// The Board Room assistant: skills (watched for adds/edits/removals) and the routes `scripts/act.mjs` uses.
const skillWatcher = createSkillWatcher({
  onChange: (d) => notify({ kind: 'skills', level: 'info', title: 'Board Room skills changed', body: [d.added.length ? `added ${d.added.join(', ')}` : '', d.updated.length ? `updated ${d.updated.join(', ')}` : '', d.removed.length ? `removed ${d.removed.join(', ')}` : ''].filter(Boolean).join(' · '), tab: 'boardroom', key: `skills:${Object.values(d.now).join('')}` }),
});
const timelineLines = (days = 30) => readTimelineEntries(days).flatMap((d) => d.entries.map((e) => ({ date: d.date, heading: e.heading, text: e.text })));
const assistantRoutes = createAssistantRoutes({
  json, readBody, localOnly: (req) => credentialRequestAllowed(req), loadState, currentFacts, timelineLines,
  recordFact: (fact) => recordBrainNote({ fact }), skills: skillWatcher, skillDirs: SKILL_DIRS(),
  searches: () => searchService().list({ limit: 20 }), openTerminal: (o) => openClaudeTerminal(o), logActivity,
  simulationFor: (id) => simulations.forApproval(id),
});
const dataHealthRoutes = createDataHealthRoutes({ dh: dataHealth, json, readBody, localOnly: (req) => credentialRequestAllowed(req) });
// ONE ROOM (lib/room.mjs): a finished meeting posts its digest into the Board Room conversation, whatever
// started it (chat, button, the app menu, a schedule) — the relay notices the new run id.
async function postToRoom(role, text) {
  let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
  if (cloud) { try { await cloud.appendMessageSafe(role, text, null); } catch { /* local copy below still lands */ } }
  if (chatHistoryCache) chatHistoryCache = { at: chatHistoryCache.at, messages: [...chatHistoryCache.messages, { role, text: String(text) }].slice(-300) };
  try { const s = loadState() || {}; s.chatContext = [...(s.chatContext || []), { role, text: String(text).slice(0, 12000), at: new Date().toISOString() }].slice(-30); saveState(s); } catch { /* never breaks */ }
}
// Simulations before major decisions (lib/simulate.mjs): deep, one at a time, briefs posted into the room.
const simulations = createSimulations({
  reasonFn: (o) => reason({ ...o, timeoutMs: o.timeoutMs || 120_000 }), loadState, numbersFor: (job) => moneyNumbersFor(job),
  contextFor: async () => { try { const s = loadState() || {}; const d = s.debrief || {}; return [d.headline, d.topConstraint ? `Biggest constraint: ${d.topConstraint}` : '', (d.kpis || []).map((k) => `${k.label} ${k.value}`).join(' · ')].filter(Boolean).join('\n'); } catch { return ''; } },
  post: async (rec) => { await postToRoom('board', rec.brief); notify({ kind: 'simulation', level: 'info', title: `Simulated: ${String(rec.question).slice(0, 80)}`, body: rec.brief.split('\n')[0].replace(/\*/g, ''), tab: 'boardroom' }); },
});
const meetingRelay = createMeetingRelay({ loadState, post: async (text) => { await postToRoom('board', text); notify({ kind: 'meeting', level: 'info', title: 'Board meeting results are in the Board Room', body: text.split('\n')[1] || '', tab: 'boardroom' }); const n = simulations.afterMeeting(); if (n) await postToRoom('board', `Simulating ${n} major decision${n === 1 ? '' : 's'} from this meeting before you decide — the results will appear here.`); } });
// In-app updates (lib/updater.mjs): checked at launch + hourly, one-click install through the tested self-update.
const updater = createUpdater({ notify });
// What every chat turn knows about skills: the roster, the matching skill's steps, and unannounced changes.
function chatSkillsContext(message) {
  try { const cur = skillWatcher.check(); return skillsContext(message, { skills: cur.skills, changes: skillWatcher.takeChanges() }); } catch { return ''; }
}

async function handleApi(req, res, path) {
  const qs = new URL(req.url || '/', 'http://x').searchParams;
  if (await assistantRoutes(req, res, path, qs)) return;
  if (await dataHealthRoutes(req, res, path, qs)) return;
  if (await handleBrainRoute(req, res, path, { localOnly: credentialRequestAllowed })) return; // the Brain (was Chronos.app): lib/brain-routes.mjs
  if (await handleMoney(req, res, path, qs, { json, readBody, localOnly: credentialRequestAllowed, logActivity })) return;
  if (path.startsWith('/api/growth/') && await (await import('../lib/growth/routes.mjs')).handleGrowth(req, res, path, qs)) return;
  // --- simulations before major decisions ---
  if (path === '/api/simulate' || path.startsWith('/api/simulate/')) {
    if (req.method === 'GET' && path === '/api/simulate') return json(res, 200, { running: simulations.running(), queued: simulations.queued(), simulations: simulations.list().slice(0, 30) });
    if (req.method === 'GET') { const r = simulations.get(decodeURIComponent(path.slice('/api/simulate/'.length))); return r ? json(res, 200, r) : json(res, 404, { error: 'no such simulation' }); }
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'simulations are started from this Mac only' });
    const b = await readBody(req);
    const r = simulations.enqueue({ approvalId: b.approvalId || null, question: b.question || '', numbers: b.numbers || null, force: !!b.force });
    return json(res, r.ok ? 200 : 400, r);
  }
  // --- in-app updates ---
  if (path.startsWith('/api/update/')) {
    if (req.method === 'GET' && path === '/api/update/status') return json(res, 200, updater.status());
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'updates are started from this Mac only' });
    if (req.method === 'POST' && path === '/api/update/check') { try { return json(res, 200, await updater.check({ quiet: true })); } catch (e) { return json(res, 500, { error: e.message }); } }
    if (req.method === 'POST' && path === '/api/update/apply') return json(res, 200, updater.apply());
    return json(res, 404, { error: 'no such update route' });
  }
  // --- home + notifications ---
  if (req.method === 'GET' && path === '/api/home') {
    const forced = qs.get('refresh') === '1';
    const stale = !homeCache || Date.now() - homeCache.t > 30_000;
    if (homeValue && !forced) {
      if (stale) refreshHome().catch(() => {});
      return json(res, 200, { ...homeValue, ...(homeCache ? {} : { fromLastLaunch: true }) });
    }
    try { return json(res, 200, await refreshHome()); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  // --- every Seen job listing: browse, read, edit, take down, restore (Seen's admin job manager) ---
  if (path === '/api/jobs' || path.startsWith('/api/jobs/')) {
    const jobErr = (e) => json(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
    try {
      if (req.method === 'GET' && path === '/api/jobs') {
        const f = {};
        for (const k of ['q', 'company', 'location', 'source', 'status', 'visible', 'employer', 'since', 'sort', 'limit']) if (qs.get(k)) f[k] = qs.get(k);
        if (qs.get('cursor')) { try { f.cursor = JSON.parse(qs.get('cursor')); } catch { /* ignored: first page */ } }
        return json(res, 200, await jobsPage(f));
      }
      const m = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(remove|restore))?$/i.exec(path);
      if (!m) return json(res, 404, { error: 'no such job route' });
      const [, id, verb] = m;
      if (req.method === 'GET' && !verb) return json(res, 200, await adminStatsConn.adminAction({ action: 'job_detail', job_id: id }));
      if (req.method === 'POST' && !verb) { const b = await readBody(req); jobsCache.clear(); return json(res, 200, await adminStatsConn.adminAction({ action: 'job_update', job_id: id, patch: b.patch || {} })); }
      if (req.method === 'POST' && verb === 'remove') jobsCache.clear(); return json(res, 200, await adminStatsConn.adminAction({ action: 'delete_listing', job_id: id }));
      if (req.method === 'POST' && verb === 'restore') jobsCache.clear(); return json(res, 200, await adminStatsConn.adminAction({ action: 'job_restore', job_id: id }));
      return json(res, 405, { error: 'method not allowed' });
    } catch (e) { return jobErr(e); }
  }
  if (/^\/api\/(tickets|prs)(\/|$)/.test(path)) return (await import('../lib/ticket-routes.mjs')).serveTicketRoutes(req, res, path, { startBuild, local: credentialRequestAllowed });
  // --- the one search box ---
  if (req.method === 'POST' && path === '/api/search') {
    const b = await readBody(req);
    // { plan: true, message } = the assistant's "search …" (planned like the chat, then started).
    if (b.plan && b.message && !b.preset) {
      const act = parseSearchCommand(/^(?:search|find|collect|pull|aggregate|get|import)\b/i.test(String(b.message)) ? String(b.message) : `search ${b.message}`);
      if (!act) return json(res, 400, { error: 'say what to search — a company, a field, or a company and its roles' });
      const planned = await planChatSearch(String(b.message), act, { catalog: await searchService().catalog(), reasonFn: reason });
      const r = await searchService().start(planned.input, { origin: 'Board Room' });
      return json(res, r.ok ? 200 : (r.code || 400), { ...r, planned: planned.planned, why: planned.why || null });
    }
    const r = await searchService().start({ preset: b.preset, text: b.text, keywords: b.keywords, url: b.url, website: b.website, methods: Array.isArray(b.methods) ? b.methods.filter((m) => SEARCH_METHODS[m]) : null }, { origin: 'search box' });
    return json(res, r.ok ? 200 : (r.code || 400), r);
  }
  if (req.method === 'GET' && path === '/api/search/presets') return json(res, 200, await searchService().presets());
  if (req.method === 'GET' && path === '/api/search/plan') return json(res, 200, await searchService().preview({ text: qs.get('text') || '', keywords: qs.get('keywords') || '', url: qs.get('url') || '' }));
  if (req.method === 'GET' && path === '/api/search') return json(res, 200, { searches: searchService().list({ limit: Number(qs.get('limit') || 50) }), methods: SEARCH_METHODS });
  if (req.method === 'GET' && path.startsWith('/api/search/')) { const r = searchService().get(path.slice('/api/search/'.length)); return r ? json(res, 200, r) : json(res, 404, { error: 'no such search' }); }
  if (req.method === 'GET' && path === '/api/notifications') {
    return json(res, 200, notifications().list({ after: Number(qs.get('after') || 0), limit: Number(qs.get('limit') || 100), unread: qs.get('unread') === '1' }));
  }
  if (req.method === 'POST' && path === '/api/notifications/read') {
    const b = await readBody(req); return json(res, 200, notifications().markRead(b.ids || 'all'));
  }
  if (req.method === 'POST' && path === '/api/notifications/clear') {
    return json(res, 200, notifications().clear());
  }
  // --- reads ---
  if (req.method === 'GET' && path === '/api/state') {
    const s = loadState(); return s ? json(res, 200, s) : json(res, 404, { error: 'no state — run a board meeting' });
  }
  if (req.method === 'GET' && path === '/api/signals') {
    try { return json(res, 200, { ...(await signals()), llm: llmInfo() }); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'GET' && path === '/api/credentials') {
    return json(res, 200, credentialStatus());
  }
  if (req.method === 'GET' && path === '/api/diagnostics') {
    try { return json(res, 200, { ...(await platformStatus()), jobs: { baseHealth: baseHealthJob().status() } }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  // Settings → System diagnostics → "Check now" on a base-branch card: runs both repositories' base
  // checks in a background process (lib/base-health-job.mjs); the cards update when it finishes.
  if (req.method === 'POST' && path === '/api/diagnostics/base-health') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'checks can be started only from the local Seen Command app' });
    const r = baseHealthJob().start('manual');
    return json(res, r.ok ? 202 : 500, r);
  }
  if (req.method === 'GET' && path === '/api/ai-usage') {
    const report = usageReport(); const creds = credentialStatus();
    const ai = creds.groups.find((g) => g.id === 'ai');
    return json(res, 200, { ...report, cline: creds.cline, providers: (ai?.fields || []).map((f) => ({ name: f.label.replace(/ API key$/i, ''), configured: f.configured, balance: null, balanceStatus: 'Balance not exposed by this connection' })) });
  }
  if (req.method === 'GET' && path === '/api/intelligence') {
    try { return json(res, 200, intelligenceRuntimeStatus({ workflows: intelligenceWorkflows.list(), config: loadRuntimeConfig(), registry: discoverModels() })); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'GET' && path === '/api/intelligence/workflows') {
    try { return json(res, 200, { workflows: intelligenceWorkflows.list() }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'POST' && /^\/api\/intelligence\/workflows\/[^/]+\/cancel$/.test(path)) {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'workflow cancellation is allowed only from the local Seen Command app' });
    try { const id = path.split('/')[4]; return json(res, 200, { ok: true, workflow: intelligenceWorkflows.requestCancellation(id, 'local operator') }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && /^\/api\/intelligence\/workflows\/[^/]+\/approve$/.test(path)) {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'workflow approval is allowed only from the local Seen Command app' });
    try {
      const id = path.split('/')[4]; const body = await readBody(req);
      if (!['plan', 'remote-call', 'preview', 'production'].includes(body.kind)) return json(res, 400, { error: 'approval kind is invalid' });
      return json(res, 200, { ok: true, approval: intelligenceWorkflows.approve(id, { kind: body.kind, by: 'local owner', scope: body.scope || null, expiresAt: body.expiresAt || null }) });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/credentials') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'credential changes are allowed only from the local Seen Command app' });
    try { return json(res, 200, { ok: true, ...saveCredentials(await readBody(req)) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/credentials/cline') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'Cline setup is allowed only from the local Seen Command app' });
    try { return json(res, 200, configureCline(await readBody(req))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/credentials/cline-signin') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'Cline sign-in is allowed only from the local Seen Command app' });
    try { return json(res, 202, startClineSignIn(await readBody(req))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/credentials/cline-test') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'Cline testing is allowed only from the local Seen Command app' });
    try { return json(res, 200, testClineConnection(await readBody(req))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  // Instagram Knowledge Compiler — doctor, Creator Intelligence Library, jobs, guidance (see routes.mjs).
  if (path.startsWith('/api/instagram/')) {
    try { return await handleInstagram(req, res, path); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  // Aggregation Dashboard — both Seen collection pipelines (Company Intelligence + Indeed Jobs).
  // The handler applies its own loopback/Origin gates; no route accepts a command or a path to run.
  if (path === '/api/aggregation' || path.startsWith('/api/aggregation/')) {
    return handleAggregation(req, res);
  }
  // --- actions ---
  if (req.method === 'POST' && path === '/api/board-meeting') {
    try { const r = await runBoardMeeting(); await rebuildDashboard(); return json(res, 200, { ok: true, runId: r.runId, proposals: r.proposals, approvals: r.approvals }); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && path === '/api/chat-history') {
    // The history lives in the cloud brain; opening the Board Room must not wait on the network. Served from
    // memory (refreshed in the background every 15 s, at most a 4 s wait the first time).
    const fresh = chatHistoryCache && Date.now() - chatHistoryCache.at < 15_000;
    if (!fresh && !chatHistoryInflight) {
      chatHistoryInflight = import('../brain/lib/cloud.mjs').then((cloud) => cloud.getConversationSafe(300))
        .then((messages) => { chatHistoryCache = { at: Date.now(), messages }; }).catch(() => {}).finally(() => { chatHistoryInflight = null; });
    }
    if (!chatHistoryCache && chatHistoryInflight) await Promise.race([chatHistoryInflight, new Promise((r) => setTimeout(r, 4000))]);
    return json(res, 200, { messages: chatHistoryCache ? chatHistoryCache.messages : [], cached: !!chatHistoryCache });
  }
  // The app-level Chronos write API (localhost-only, same gate as credentials): the UI and local
  // integrations record facts/notes through the same verified path the chat actions use.
  if (req.method === 'POST' && path === '/api/brain/record') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'brain writes are allowed only from the local Seen Command app' });
    const body = await readBody(req);
    try {
      const out = body.kind === 'fact'
        ? await recordBrainNote({ fact: { subject: body.subject, predicate: body.predicate, object: body.object } })
        : await recordBrainNote({ text: body.text, ...(body.heading ? { heading: body.heading } : {}) });
      return json(res, out.ok ? 200 : 422, out);
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/chat') {
    const { message, deptId } = await readBody(req);
    if (!message) return json(res, 400, { error: 'message required' });
    const long = tooLong(message);
    if (long) return json(res, 413, { error: long });
    // Instagram Knowledge Compiler commands — deterministic, before the general chat lane (CEO only).
    if (!deptId) {
      let ig = null; try { ig = await handleInstagramChat(message); } catch (e) { ig = { reply: `Instagram command error: ${e.message}` }; }
      if (ig) {
        let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
        await persistChatTurns(message, ig.reply, deptId, cloud);
        return json(res, 200, { reply: ig.reply, engine: 'instagram', dept: 'command', action: ig.action || null });
      }
    }
    const state = loadState();
    const dept = deptId ? departmentById(deptId) : null;

    // --- Board Room ACTIONS: when Brandon gives a command, actually DO it and report the real result
    // (then the client refreshes the other sections). Only from the CEO chat, and only on a real match.
    const act = state && !deptId ? detectChatAction(message, state) : null;
    if (act) {
      let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
      const { reply, action } = await runWiredAction(act, message);
      await persistChatTurns(message, reply, deptId, cloud);
      return json(res, 200, { reply, engine: 'action', dept: 'command', action });
    }

    // Keep the one-shot fallback at parity with streaming Board Room chat. The dashboard normally uses
    // SSE, but network/proxy failures retry here; bypassing the owned engine made the exact same “task
    // 147” question fall back to stale Brain/model context instead of live GitHub + build records.
    if (!deptId) {
      try {
        const owned = await answerOwned({ message, state });
        if (owned?.handled) {
          let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
          await persistChatTurns(message, owned.reply, deptId, cloud);
          return json(res, 200, { reply: owned.reply, engine: owned.engine || `owned:${owned.skill || 'skill'}`, dept: 'command' });
        }
      } catch { /* owned engine miss → fall through to the model */ }
    }

    let { reply, engine } = await singleShotChat(message, deptId, state);
    if (!deptId) { const ran = await runModelHandoff(reply, state); if (ran) reply = `${reply.replace(/^\s*RUN:.*$/m, '').trim()}\n\n${ran.reply}`; }
    // Persist BOTH turns to the online brain, so the conversation is permanent.
    let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
    await persistChatTurns(message, reply, deptId, cloud);
    return json(res, 200, { reply, engine, dept: deptId || 'command' });
  }
  // Streaming Board Room agent — the real, tool-using, context-carrying chat brain (engine/agent-chat.mjs).
  // Server-Sent Events: each event is one line the UI renders live (status / thinking text / tool chip /
  // tool result / done). Deterministic app COMMANDS still run through the instant action path first; only
  // open-ended questions go to the streaming agent. Falls back to singleShotChat when the CLI is logged out.
  if (req.method === 'POST' && path === '/api/chat/stream') {
    const { message, fresh } = await readBody(req);
    if (!message) return json(res, 400, { error: 'message required' });
    const longMsg = tooLong(message);
    if (longMsg) return json(res, 413, { error: longMsg });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } };
    let cloud = null; try { cloud = await import('../brain/lib/cloud.mjs'); } catch { /* local-only */ }
    const persist = async (reply) => persistChatTurns(message, reply, null, cloud, { fresh: !!fresh });

    const state = loadState();
    // Instagram compiler commands + wired app actions run instantly (no agent needed) — stream one result.
    try {
      let ig = null; try { ig = await handleInstagramChat(message); } catch (e) { ig = { reply: `Instagram command error: ${e.message}` }; }
      const act = ig ? null : (state ? detectChatAction(message, state) : null);
      // Every recognized action stays on the deterministic path. Letting build/approval-shaped
      // messages fall through to an LLM caused it to *say* work was approved without filing a task.
      if (ig || act) {
        send({ type: 'status', text: 'running command…' });
        // Narrate the real milestones as they pass. A board meeting takes minutes; streaming nothing
        // until it finished made the app look hung, which is most of why the chat felt dead.
        const out = ig ? { reply: ig.reply, action: ig.action || null }
          : await runWiredAction(act, message, (text) => send({ type: 'status', text }));
        send({ type: 'text', text: out.reply });
        if (out.action) send({ type: 'action', action: out.action });
        send({ type: 'done', engine: ig ? 'instagram' : 'action' });
        await persist(out.reply);
        res.end(); return;
      }
    } catch (e) { send({ type: 'status', text: `command check failed: ${e.message}` }); }

    // OWNED engine FIRST — deterministic skills answer common questions from real GitHub/Vercel/Supabase/
    // brain data with NO external AI ($0, instant, offline). As skills grow, more queries never touch Claude.
    try {
      const owned = await answerOwned({ message, state });
      if (owned && owned.handled) {
        send({ type: 'owned', skill: owned.skill });
        send({ type: 'text', text: owned.reply });
        send({ type: 'done', engine: owned.engine || `owned:${owned.skill || 'skill'}` });
        await persist(owned.reply);
        res.end(); return;
      }
    } catch { /* owned engine miss → fall through to the model */ }

    // Open-ended question → the streaming claude agent, with the single-shot answer as the honest fallback.
    // "New chat" (fresh) starts a new context window instead of resuming the stored session.
    const chatEngineKey = String(process.env.CHAT_ENGINE || 'cline').toLowerCase() === 'claude' ? 'claude' : 'cline';
    const sessionId = fresh ? null : (state?.chatSessionIds?.[chatEngineKey]
      || (chatEngineKey === 'claude' ? state?.chatSessionId : null));
    let liveContext = '';
    try {
      const snapshot = await platformStatus();
      // The brain goes in LAST so it has the final word: the live Cline lane gets no brain MCP tools,
      // so without this injection the chat answers from the snapshot alone and repeats stale figures
      // (the stale-user-count bug, where the brain itself held the correct, newer figure).
      let brain = '';
      try { brain = brainContext(message, currentFacts()); } catch { /* no vault → snapshot only */ }
      // What is CURRENTLY broken, and whose move it is. Without this the chat could describe the
      // platform as healthy while builds sat failing in the queue — the same class as the stale-user-count
      // bug, where the answer was assembled from a source that did not know.
      let failures = '';
      try {
        const { openFailures } = await import('../lib/failure-loop.mjs');
        const q = openFailures({ days: 14 });
        if (q.open.length) {
          failures = `OPEN FAILURES (${q.open.length} unresolved — ${q.actionable} actionable, ${q.blocked} blocked on Brandon).\n`
            + `A BLOCKED failure cannot be fixed by retrying; say plainly what Brandon must clear.\n`
            + q.open.slice(0, 8).map((f) => `• ${f.id}${f.repo ? ` (${f.repo})` : ''}${f.blocked ? ' [BLOCKED ON OWNER]' : ''}: ${String(f.reason).slice(0, 200)}`).join('\n');
        }
      } catch { /* the queue is additive context, never required */ }
      // Collection pipelines: real run metrics only (one compact block; empty when nothing has run).
      let aggregation = '';
      try { const { aggregationContext } = await import('./owned-brain.mjs'); aggregation = await aggregationContext(); } catch { /* optional context */ }
      try { const { creatorContext } = await import('../lib/instagram/insights.mjs'); aggregation = [aggregation, await creatorContext(message)].filter(Boolean).join('\n\n'); } catch { /* optional context */ }
      liveContext = [platformContext(snapshot), fresh ? '' : conversationContext(state), gatherLocalContext(message), failures, aggregation, chatSkillsContext(message), brain].filter(Boolean).join('\n\n');
    } catch { /* the agent still has its own safe read tools / honest fallback */ }
    let full = '';
    const result = await runChatAgent({
      message,
      sessionId,
      extraContext: liveContext,
      emit: (ev) => { if (ev.type === 'text' && ev.text) full += (full ? '\n' : '') + ev.text; send(ev); },
      fallback: async () => await singleShotChat(message, null, state, liveContext),
    });
    // Claude exposes a resumable engine session id. Cline does not, so its continuity comes from the
    // verified local/cloud conversation turns injected into the next live snapshot instead.
    if (result.sessionId && result.sessionId !== sessionId) {
      try {
        const s2 = loadState() || state || {};
        s2.chatSessionIds = { ...(s2.chatSessionIds || {}), [chatEngineKey]: result.sessionId };
        if (chatEngineKey === 'claude') s2.chatSessionId = result.sessionId; // backwards compatibility
        saveState(s2);
      } catch { /* ignore */ }
    }
    // The model may hand a search back to the app ("RUN: find welder jobs in Texas") when the owner's wording
    // slipped past the instant parser. Only a search or a preset is ever run this way.
    let finalReply = result.reply || full;
    const ran = await runModelHandoff(finalReply, state, (text) => send({ type: 'status', text }));
    if (ran) {
      send({ type: 'text', text: ran.reply });
      if (ran.action) send({ type: 'action', action: ran.action });
      finalReply = `${finalReply.replace(/^\s*RUN:.*$/m, '').trim()}\n\n${ran.reply}`;
    }
    await persist(finalReply);
    res.end(); return;
  }
  if (req.method === 'POST' && path === '/api/ask') {
    const { question } = await readBody(req);
    if (!question) return json(res, 400, { error: 'question required' });
    try { const { ask } = await import('../brain/lib/keeper.mjs'); return json(res, 200, await ask(question)); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'GET' && path === '/api/brain-review') {
    try { const { review } = await import('../brain/lib/keeper.mjs'); return json(res, 200, review()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  // The Knowledge Vault workspace payload: the brain's current facts, the decisions ledger, the last
  // week's timeline, and health — one call feeds the whole tab. Ask goes through POST /api/ask.
  if (req.method === 'GET' && path === '/api/vault') {
    try {
      const facts = currentFacts();
      let health = null;
      try { const { review } = await import('../brain/lib/keeper.mjs'); health = review(); } catch { /* no vault */ }
      return json(res, 200, {
        facts: facts.map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object, confidence: f.confidence || null, note: f.note || null, valid_from: f.valid_from || null })),
        decisions: readDecisions(40),
        timeline: readTimelineEntries(7),
        health,
        vaultFound: facts.length > 0 || !!health,
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  // Live task list — the Tasks tab refreshes from here, so it shows what is open on GitHub RIGHT NOW
  // instead of whatever was baked into the last dashboard build.
  if (req.method === 'GET' && path === '/api/tasks') {
    try { const repo = config.commandRepo(); return json(res, 200, { repo, tasks: await issuesFor(repo) }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  // Manually start the test-gated builder on a filed task (GitHub issue) — the ▶ Build button on the
  // Tasks tab. The build id is the STABLE `task-<number>`, so clicking again while one is running
  // returns the in-flight record (progress) instead of double-building; after it ends, a re-click
  // starts a fresh build under the same id (rebuild).
  if (req.method === 'POST' && path === '/api/tasks/build') {
    const { number, repo: repoOverride } = await readBody(req);
    const n = Number(number);
    if (!n) return json(res, 400, { error: 'number required' });
    const taskRepo = config.commandRepo();
    let issue = null;
    // DIRECT per-issue GET (read-your-writes consistent) — the LIST endpoint lags a just-created issue
    // by seconds, so issuesFor().find() 404'd tasks the instant they were filed (live #104: create →
    // build 12s early → false 404, a retry succeeded). Rule (brain 2026-07-18): state checks use direct
    // per-entity GETs, never list-presence. Same fix PR #91 made inside runBuild, at this second site.
    try { issue = await issueInfo(taskRepo, n); }
    catch (e) { return json(res, 500, { error: `could not read task: ${e.message}` }); }
    if (!issue) return json(res, 404, { error: `could not find task #${n} — if it was just created, GitHub may still be indexing; retry` });
    if (issue.state === 'closed') return json(res, 404, { error: `task #${n} is closed` });
    const id = `task-${n}`;
    const existing = readBuild(id);
    if (existing && (existing.status === 'queued' || existing.status === 'building')) {
      return json(res, 200, { ok: true, already: true, build: existing });
    }
    // A plan/audit/report-shaped task wants a DOCUMENT, not code — the builder can only pass a test
    // gate, and pointing it at a document task produced the 2026-07-10 theater PRs (comment spam,
    // console.log "optimizations"). Draft the real document, deliver it ON the task, close the task.
    if (!repoOverride && taskShape(issue.title) === 'deliverable') {
      try {
        const dept = (issue.title.match(/^\[([\w-]+)\]/) || [])[1] || null;
        const d = await draftForTask({ title: issue.title, dept });
        await executeCommentIssueIn({ repo: taskRepo, number: n,
          body: `${d.body}\n\n---\n_This task is document-shaped, so the deliverable lives here (no code PR). Drafted by ${d.engine || 'the deliverer'}._` });
        await executeCloseIssueIn({ repo: taskRepo, number: n });
        writeBuild(id, { id, title: issue.title, task: issue.title, repo: 'deliverable', status: 'delivered',
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
          issue: { repo: taskRepo, number: n }, summary: 'document delivered on the task; task closed', log: [] });
        logActivity({ kind: 'deliver', id, status: 'delivered', summary: `task #${n} delivered on the issue + closed`, detail: issue.title });
        return json(res, 200, { ok: true, delivered: true, build: readBuild(id) });
      } catch (e) { return json(res, 500, { error: `deliver failed: ${e.message}` }); }
    }
    const repo = repoOverride === 'product' || repoOverride === 'tool'
      ? repoOverride : buildTargetForTask(`${issue.title}\n${issue.body}`);
    const title = issue.title.replace(/^\[[^\]]+\]\s*/, ''); // drop the [dept] prefix — dept ≠ repo
    // Preserve the filed issue's real acceptance context. The old 600-char cut could remove the exact
    // grounding/done-condition from detailed tasks, leaving the coder to guess from a title fragment.
    startBuild({ id, repo, task: `${title}. ${issue.body}`.slice(0, 6000), title, issueRepo: taskRepo, issueNumber: n });
    logActivity({ kind: 'build', id, status: 'kicked', summary: `build kicked for task #${n} (${repo === 'tool' ? 'Seen Command' : 'Seen product'}) — ${title}` });
    return json(res, 200, { ok: true, build: readBuild(id) });
  }
  // Live build status — the dashboard polls this after approving an engineering action to show
  // "building… → PR ready". Reads the per-build status files the background runner writes.
  // Delete a task — closes the issue AND records the deletion in the brain (see deleteTask above).
  // Localhost-gated like every other mutation the UI can trigger.
  if (req.method === 'POST' && path === '/api/tasks/delete') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'task deletion is allowed only from the local Seen Command app' });
    const { number, reason, repo } = await readBody(req);
    try {
      const out = await deleteTask({ number, reason, repo });
      return json(res, out.ok ? 200 : 400, out);
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  // File a new task and start the builder on it in one step (`act.mjs build <seen|command> <what>`): the
  // same path as the Board Room's "build … in Seen Command" command. Local-only like every UI mutation.
  if (req.method === 'POST' && path === '/api/tasks/new') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'tasks are filed only from the local Seen Command app' });
    const b = await readBody(req);
    const repo = ({ product: 'product', seen: 'product', seenjobs: 'product', tool: 'tool', command: 'tool' })[String(b.repo || '').toLowerCase()];
    const task = String(b.task || '').trim();
    if (!repo) return json(res, 400, { error: 'repo must be seen (the Seen product / seenjobs.io) or command (Seen Command)' });
    if (task.length < 8) return json(res, 400, { error: 'say what to change, in plain words' });
    if (task.length > 6000) return json(res, 413, { error: 'that request is too long — 6,000 characters at most' });
    try {
      const r = await fileAndBuild({ repo, task });
      return json(res, 200, { ok: true, already: r.already, target: r.target, task: { number: r.filed.number, url: r.filed.url, existing: !!r.filed.existing }, build: readBuild(r.id) });
    } catch (e) { return json(res, 500, { error: `could not file the task: ${e.message}` }); }
  }
  // `npm run agent:setup` without Terminal: reinstall + re-sign Cline (lib/agent-setup.mjs), output tail back.
  if (req.method === 'POST' && path === '/api/agents/setup') {
    if (!credentialRequestAllowed(req)) return json(res, 403, { error: 'agent setup runs only from the local Seen Command app' });
    const r = await (await import('../lib/agent-setup.mjs')).runAgentSetup();
    logActivity({ kind: 'agent-setup', status: r.ok ? 'done' : 'failed', summary: r.ok ? 'Cline reinstalled and re-signed (agent:setup)' : `agent:setup failed: ${r.error}` });
    return json(res, 200, r); // a finished run is a report either way: ok + the output tail say how it went
  }
  // Zombie reap on the READ path — a build whose runner died is otherwise only reaped when the owner
  // kicks off ANOTHER build, so the dashboard paints "building…" for a process gone for days. This
  // endpoint is polled every 2.5s while a build is live (startBuildPolling in build-dashboard.mjs),
  // so sweep at most once per window: a corpse that has lain there for hours can wait 30s more.
  // Never fatal — a sweep problem must not blank the dashboard's build list.
  if (req.method === 'GET' && path === '/api/builds') {
    try {
      if (Date.now() - lastBuildSweep >= READ_SWEEP_MS) {
        lastBuildSweep = Date.now();   // stamp BEFORE the sweep so a thrower can't retry every 2.5s
        try { reconcileStaleBuilds(); } catch (e) { console.error(`[server] stale-build sweep failed: ${e.message}`); }
      }
      return json(res, 200, { builds: listBuilds() });   // sweep first, so the reap shows this paint
    }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/approve') {
    const { id, key, decision } = await readBody(req);
    const state = loadState();
    if (!state) return json(res, 404, { error: 'no state' });
    // Match by run-specific id, or fall back to the STABLE key — so a decision lands even if the
    // dashboard snapshot drifted from the latest board meeting.
    const appr = (state.approvals || []).find((a) => a.id === id) || (key && (state.approvals || []).find((a) => a.key === key));
    if (!appr) return json(res, 404, { error: 'approval not found' });
    const r = await runApproval(state, appr, decision);
    if (r.error) return json(res, 500, { error: `action failed: ${r.error}` });
    saveState(state);
    return json(res, 200, { ok: true, status: r.status, executed: !!r.execResult, result: r.execResult, building: r.building, delivered: r.delivered });
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

const srv = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path.startsWith('/api/')) { try { await handleApi(req, res, path); } catch (e) { json(res, 500, { error: e.message }); } return; }
  // static files
  try {
    let p = path === '/' ? '/command-center.html' : path;
    const file = normalize(join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
    await stat(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('not found'); }
});
// Only bind the port when this file is the ENTRY POINT (`node engine/server.mjs`, or spawned as one
// by the app / Seen Command.command). Guarding the listen keeps the module import-safe, so the load
// smoke test (engine/imports.test.mjs) can import it and catch load-time crashes — like the #78
// phantom `import { optimizedReadBrainFacts }` — that node --check and untested paths otherwise miss.
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // Fail cleanly if the port is already held (e.g. a prior instance is still serving) instead of
  // throwing an unhandled 'error' that dumps a stack — the app just loads the existing server.
  srv.on('error', (e) => { console.error(`server listen error on :${PORT} — ${e.code || e.message}`); process.exit(1); });
  srv.listen(PORT, '127.0.0.1', () => {
    // The assistant's `scripts/act.mjs` (run by the chat engines as a child process) finds this server here.
    process.env.SEEN_COMMAND_URL = `http://127.0.0.1:${PORT}`;
    refreshHome().catch(() => {}); // Home is ready before the window asks for it
    setTimeout(() => { if (config.adminCreds()) { jobsPage({ since: 'today', limit: '8' }).catch(() => {}); jobsPage({ sort: 'newest', limit: '50' }).catch(() => {}); } }, 1500).unref?.();
    try { skillWatcher.start(); } catch (e) { console.error(`[skills] watcher not started: ${e.message}`); }
    try { updater.start(); } catch (e) { console.error(`[update] checks not started: ${e.message}`); }
    setInterval(() => { meetingRelay.tick().catch(() => {}); }, 20_000).unref?.(); meetingRelay.tick().catch(() => {});
    // Restart recovery + the per-pipeline schedules (disabled until the owner enables one).
    try { aggregationManager().start(); } catch (e) { console.error(`[aggregation] scheduler not started: ${e.message}`); }
    // Base-branch health: checked once a day in the background (the diagnostics cards were "never checked").
    try { baseHealthJob().startSchedule(); } catch (e) { console.error(`[base-health] daily check not scheduled: ${e.message}`); }
    // Data health: the daily automatic cleanup (duplicates + stale; never company merges), caught up a few
    // minutes after launch when the last one is more than a day old. Off with the panel's switch.
    try { dataHealth.startSchedule({ firstDelayMs: Number(process.env.SEEN_DATA_HEALTH_FIRST_DELAY_MS) || undefined }); } catch (e) { console.error(`[data-health] daily cleanup not scheduled: ${e.message}`); }
    // The Brain's background work (was Chronos.app): vault + state watchers and the 60 s cloud pull.
    try { startBrainBackground(); } catch (e) { console.error(`[brain] background not started: ${e.message}`); }
    // Activity → notifications, and the cloud collector runs Seen does without this Mac (every 10 minutes).
    import('../lib/notify-wire.mjs').catch(() => {});
    const cloudPoll = () => pollCloudRuns().catch(() => {});
    setTimeout(cloudPoll, 20_000).unref?.(); setInterval(cloudPoll, 10 * 60_000).unref?.();
    const url = `http://localhost:${PORT}`;
    console.log(`Seen Command → ${url}  (Ctrl+C to stop)`);
    // Native, zero-Electron: open the cockpit in the default browser.
    if (process.env.SEEN_NO_OPEN !== '1') { try { spawn('open', [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ } }
  });
}

// Exposed for tests — the chat input bound and its message.
export const _chatLimits = { MAX_CHAT_CHARS, tooLong };
