#!/usr/bin/env node
// The BOARD ROOM AGENT — the front-page chat given real reach, a real context window, and a visible
// thought process, so it stops being the clueless single-shot box that answered "look at PR 132" with
// "I have no access to PR details." Brandon's ask (2026-08-03): "a chat bot that literally has access to
// everything and gets a context window and the same capabilities that you have… reach and use resources
// the way claude does… access my vercel/github/supabase… local files on the macbook too."
//
// The most direct route to "the same capabilities you have" is to run the thing that HAS them: the local
// `claude` binary (a Claude subscription — $0, not API credits), the same engine engine/agentic-coder.mjs
// already drives for building. This module runs it in an INVESTIGATE posture and STREAMS its native
// events (assistant text + tool calls + tool results) so the UI can render the reasoning and the tool
// chips live, exactly like Claude Code. Context continuity is real: a stable per-chat session id is
// resumed each turn, so the agent keeps its own context window across the conversation.
//
// Reach & safety (matches the app's approval culture and Brandon's file-access choice — "whole home,
// read-only"):
//   • READS: Read/Grep/Glob/LS over the whole home dir (via --add-dir), plus WebFetch/WebSearch and the
//     brain MCP (Chronos memory), plus read-only GitHub/git inspection through `gh`/`git`.
//   • It does NOT get Write/Edit or destructive Bash by default — anything that would CHANGE Brandon's
//     systems (open a PR, deploy, delete, send) it is told to PROPOSE for his approval, not do silently.
//   • The allow-list is the enforcement: in headless `-p` mode any tool NOT allowed is auto-denied (no
//     interactive prompt is possible), so the surface is bounded by ALLOW_RULES below, overridable by env.
//
// Degradation is honest: if the `claude` binary is absent or logged out, runChatAgent falls back to the
// caller-supplied single-shot `fallback()` (the old memory-augmented reason() answer) and flags
// `degraded:true` with the reason, so the UI can say "log in to the claude CLI for full capabilities"
// instead of pretending. Dependency-free: node:child_process spawn (injectable for tests), pure ESM.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../lib/config.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { CAPABILITIES } from '../org/capabilities.mjs';
import { catalogLines } from '../lib/act-catalog.mjs';
import { clineExecutable, clineSelection, recordClineConnectionSuccess, claudeCliHealth, clineCliHealth } from '../lib/credentials.mjs';
import { recordAIUsage } from '../lib/ai-usage.mjs';
import { toolEnv, claudeToolEnv } from '../lib/tool-env.mjs';

// A bare 'claude' is ENOENT under the packaged app's launchd PATH — probe the usual homes (same list
// engine/agentic-coder.mjs uses).
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
function claudeBin() {
  const configured = config.claudeCliPath();
  if (configured && configured !== 'claude' && existsSync(configured)) return configured;
  return BIN_PATHS.map((p) => join(p, 'claude')).find((f) => existsSync(f)) || configured || 'claude';
}

// Identity for anything this lane spawns. The brain MCP stamps every write with BRAIN_CLIENT, so a fact
// written from the Board Room is attributable in Seen Command → Brain → Activity WITHOUT depending on
// the model passing `by` — structural attribution, not a instruction it can forget.
// toolEnv: a Finder-launched app has a bare PATH; a Node-script CLI needs to find its node (lib/tool-env.mjs).
const chatChildEnv = (bin) => toolEnv(bin, { ...process.env, BRAIN_CLIENT: process.env.BRAIN_CLIENT || 'board-room' });
// The claude CLI lane: same, minus the app's ANTHROPIC_API_KEY, so it answers on the owner's own login.
const claudeChildEnv = (bin) => claudeToolEnv(bin, { ...process.env, BRAIN_CLIENT: process.env.BRAIN_CLIENT || 'board-room' });

// The investigate-posture tool surface. Reads + web + brain + read-only GitHub/git. NO Write/Edit, NO
// open-ended Bash. `gh`/`git` are allowed only for their read subcommands so "what went wrong with PR N"
// works (gh pr view/checks/diff) without granting mutation. Override with CHAT_ALLOWED_TOOLS (comma list).
const ALLOW_RULES = [
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite',
  'mcp__brain__brain_overview', 'mcp__brain__brain_search_facts', 'mcp__brain__brain_whats_changed',
  'mcp__brain__brain_get_entity', 'mcp__brain__brain_timeline', 'mcp__brain__brain_contradictions',
  // THE BRAIN IS WRITABLE — and it is the ONLY thing this lane may change. That is a deliberate
  // exception to the no-mutation posture, and it holds because of what a brain write actually is:
  // append-only and bi-temporal (a supersede CLOSES the old fact and adds a new one, it never
  // overwrites), no delete is exposed over MCP at all, and every call is now recorded in the access log
  // and surfaced in Seen Command → Brain. So a bad write is visible and reversible, which is not true of a
  // deploy, a merge, or an edited file. Those stay forbidden.
  'mcp__brain__brain_add_fact', 'mcp__brain__brain_supersede_fact',
  'mcp__brain__brain_log_decision', 'mcp__brain__brain_append_timeline',
  'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr list:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)',
  'Bash(gh api:*)', 'Bash(gh search:*)',
  'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git branch:*)',
  'Bash(vercel ls:*)', 'Bash(vercel inspect:*)', 'Bash(vercel logs:*)',
  // The MASTER-KIT (lib/ops.mjs): one deterministic, read-only command surface over every connector,
  // the brain, both repos, and the runtime — so the agent pulls live state in ONE call instead of
  // burning turns on ad-hoc exploration. The CLI is read-only by design (see scripts/ops.mjs).
  'Bash(node scripts/ops.mjs:*)',
  // The assistant's hands (scripts/act.mjs): every Seen Command button as a named verb, through the app's own
  // routes (docs/ACT_PARITY.md). No arbitrary shell — each new ability is a verb there, not a new rule here.
  'Bash(node scripts/act.mjs:*)',
];

function allowedTools() {
  const override = String(process.env.CHAT_ALLOWED_TOOLS || '').trim();
  return override ? override.split(',').map((s) => s.trim()).filter(Boolean) : ALLOW_RULES;
}

// The concrete map of Brandon's repos + vault, so the agent doesn't waste turns discovering that a plain
// PR number lives in the PRODUCT repo (the exact tax we watched it pay on "why is PR 243 conflicting?").
function repoContext() {
  let product = 'begindtheseen/seen'; let command = 'begindtheseen/seen-command';
  let productDir = ''; let commandDir = ''; let vault = '';
  try { product = config.githubRepo(); } catch { /* default */ }
  try { command = config.commandRepo(); } catch { /* default */ }
  try { productDir = config.productRepoDir(); } catch { /* unknown */ }
  try { commandDir = config.commandRepoDir(); } catch { /* unknown */ }
  try { vault = process.env.CHRONOS_VAULT || (productDir ? join(productDir, 'memory') : ''); } catch { /* unknown */ }
  return `YOUR REPOS (real, on this machine):
• PRODUCT — ${product} — the Seen product / seenjobs.io (Next.js). Local: ${productDir || '(unknown)'}. A plain PR/issue number almost always means THIS repo.
• TOOL — ${command} — Seen Command, this app (pure Node). Local: ${commandDir || REPO_ROOT}.
• BRAIN VAULT — the shared Chronos memory. Local: ${vault || '(unknown)'}.`;
}

// The persona/brief appended to the CLI's own system prompt. Keeps it grounded, concise, honest, and
// safe-by-default. The CAPABILITIES manifest (org/capabilities.mjs) is injected so it knows what the
// Seen Command OS around it can really do (run a board meeting, build via the test-gated coder, etc.).
function appendSystemPrompt(extra = '') {
  return `You are the Board Room — the live chat brain of Seen Command, Brandon's agentic exec OS for Seen (seenjobs.io). You are Brandon's co-CEO: sharp, concise, and honest. You have a real context window across this conversation and real tools; use them.

HOW TO ANSWER:
• GROUND before you assert. When Brandon asks about a PR, a deploy, a file, an error, or the state of the business, actually go look — read the files, run the read-only gh/git commands, search the brain — then answer from what you found. Never guess when you can check.
• Show your work briefly, then land the answer. Lead with the conclusion; keep the reasoning tight. This is a chat, not a report — summarize.
• Cite specifics: PR numbers, file:line, check names, commit shas, the exact error. Vague is useless to Brandon.
• Be honest about limits. If a tool isn't available or you couldn't verify something, say so plainly.

PRIORITY: seenjobs.io. Everything you do serves SeenJobs' users, growth and revenue. Never promote or pitch Seen Command itself — no "you could also add X to Seen Command" suggestions. The one exception: when YOU fail at something Brandon asked (a missing ability, a broken route, an error), say plainly what failed and FILE ONE ticket with \`ticket-new\` saying what would have helped (a concrete ability or fix) — then get back to his SeenJobs goal. Never file one for an idea that did not come from a failure.

YOU ACT — through Seen Command itself, ONE command per action: \`node scripts/act.mjs <verb> …\` (JSON out; the same routes and bodies as the app's buttons — anything Brandon can click, you can run). Brandon asking IS the approval for any verb: run it, then report what the JSON says. Only these need his explicit words in this conversation: \`approve\`/\`deny\` (he names or clearly means that approval), \`merge-pr\` (Merge ONLY when Brandon replies with that phrase: \`merge-pr <owner/repo> <n> confirm="<phrase>"\`; it refuses anything not green and mergeable — never merge another way), and the typed deletions \`purge-archived\` / \`creator-delete\`. Never answer "I can't" when a verb exists — run it. When no verb does what he asked, say so in one line and file \`ticket-new\` with what would have helped.
VERBS (\`act.mjs help\` prints them with arguments):
${catalogLines()}
USING THEM WELL:
• \`brief\` whenever the talk touches plans, problems or "what's going on"; \`recall\` before answering a concern and before a note.
• \`note\` what Brandon says that is durable (vision, preference, decision, concern) — unprompted, the NEW part only, in his words, one topic per idea; tell him in one line what you saved. Skip chit-chat and what is already noted.
• \`search\` — THIS IS HOW JOBS GET ONTO SEENJOBS.IO: a search collects the listings AND imports them through Seen's own ingest (US/remote only, de-duplicated, audited). So "aggregate NASA jobs and import them", "pull Tesla's jobs", "get welder jobs in Texas" = run \`search\` RIGHT AWAY with the best wording (an agency like NASA is an employer — its jobs are on USAJOBS and its careers site; the planner knows) and report what started. It is NOT a propose-only action and needs no approval.
• A code change he asks for ("fix X", "add Y to seenjobs") → \`build seen <what>\` (\`build command <what>\` for this app): it files a task, the builder codes in an isolated worktree, runs the tests and opens a draft PR only when green; follow with \`build-status\` / \`prs\`, then \`merge-pr\` with his phrase. Coding he wants to drive himself → \`terminal\`.
• Before Brandon decides anything MAJOR (irreversible, money, pricing, publishing publicly, outreach, data/schema), check for a simulation (\`brief\`/\`simulation\`) and \`simulate\` if there is none — say it takes a few minutes, then give him its call. Never rush a major decision.
• A request that fits a SKILL (\`skills\`) → follow its steps exactly. A concern that already has a fix waiting (approval, build, task, ticket) → say so by title and id and offer to approve it.
• Never invent results: report the JSON's answer; if a command errors, say what failed.

CREDENTIALS: never open or reveal a credential VALUE (.env files, keychains, SSH/cloud stores, tokens, private keys) — \`credentials\` / \`diagnostics\` give secret-free status. A key Brandon hands you goes in with \`secret-set\` / \`cline-setup\`, which never echo it; do not repeat it back. Outside act.mjs and ops.mjs you change nothing yourself (no file edits, deploys or messages) — running a search/import, a meeting, or a job edit Brandon asked for through act.mjs is NOT on this list; do those.

THE BRAIN IS YOURS TO KEEP CURRENT. Remembering is your job, not his.
• Prefer \`act.mjs note\` for what Brandon tells you; brain_add_fact / brain_supersede_fact for facts you VERIFIED this conversation (say in \`change\` how); brain_log_decision when he locks a call; brain_append_timeline for what happened today.
• Never record a guess or an inference as fact. A repeat is a no-op; a changed value supersedes — never two live answers to one question.
• Numbers Brandon states about his own business ARE verified — he is the owner. Numbers from a degraded tool are NOT.

${repoContext()}

TOOL TIPS: to inspect a specific repo on GitHub use \`gh -R <owner/repo> pr view <n>\` / \`gh -R <owner/repo> pr diff <n>\` — a bare PR number usually means the PRODUCT repo. Read/Grep/Glob work directly on the local paths above (both repos + the vault are under your home dir). Keep bash to ONE command (no \`;\` / \`&&\` chains — compound commands are blocked); run separate tool calls instead.

OPS MASTER-KIT — prefer these over ad-hoc exploration; each is ONE deterministic, read-only command (\`node scripts/ops.mjs <cmd>\`, JSON out):
• \`state\` — every live connector in one call (GitHub, Seen admin, Supabase, Vercel, Stripe + AI lanes).
• \`snapshot\` — the full platform dump: focus, pending approvals, open tasks, builds, brain, health, repos, activity.
• \`search <query>\` — code (git grep, BOTH repos) + ranked brain facts in one step, with file:line references.
• \`query --target facts|db|activity|builds|state\` — parameterized read-only queries (facts: --subject/--predicate/--contains; db: --table/--select/--filter like status=eq.active; state: --path a.b.c).
• \`credentials\` — which connectors are missing VALID tokens (configured-but-rejected vs not set; never values).
• \`drift\` — is what's merged what's deployed (live probe + the last recorded merge_vs_deploy verdict).
• \`logs\` — export a debugging bundle (CI runs + failed-run log tail, Vercel deploys, build logs, activity, health) and report its path.
• \`diagnose --fix\` — the health map plus safe self-repair (git fetch + ahead/behind with the exact reconcile command; it never touches a working tree).

THE OS AROUND YOU:
${CAPABILITIES}
${extra ? `\n${extra}` : ''}`;
}

// WHICH LANE ACTUALLY ANSWERS THIS TURN.
//
// Brandon: the Board Room "can barely tell if its running half the time". It could not, because it
// picked its lane from an env default and only discovered the lane was dead by getting nothing back
// — and "nothing back" produced the reason string "unknown". On this machine that is not a rare
// edge: the configured default lane (Cline) is SIGKILLed by macOS on every launch with zero bytes on
// stdout AND stderr, so every single turn degraded silently with a meaningless explanation.
//
// So ask first, with a cached probe, and make the answer visible:
//   • Cline runs (or its state is UNKNOWN — a slow probe is not a verdict) → use Cline, unchanged.
//   • Cline is definitively broken and the claude CLI is logged in → answer on the claude CLI and SAY
//     SO. This is a visible failover, never a silent default change: the notice names the failed lane
//     and the exact reason, and the same reason is already in diagnostics as the `cline-test` check.
//   • Neither lane can answer → don't spawn anything. Degrade with BOTH reasons.
export function chooseLiveLane({ cline, claude } = {}) {
  const clineDead = !!cline && (cline.installed === false || cline.runnable === false);
  if (!clineDead) return { engine: 'cline', notice: null, reason: null };
  const why = (cline && cline.reason) || 'the Cline lane is unavailable';
  const fix = (cline && cline.fix) ? ` Fix: ${cline.fix}` : '';
  if (claude && claude.runnable === true && claude.authenticated === true) {
    return {
      engine: 'claude',
      reason: why,
      notice: `Cline lane is down (${why}) — answering on the local claude CLI instead.${fix}`,
    };
  }
  const claudeWhy = (claude && claude.reason) || 'the claude CLI could not be verified';
  return { engine: 'none', reason: `${why}; the claude CLI fallback is not usable either (${claudeWhy})`, notice: null };
}

// Why a spawned lane produced no answer. "It ended without an answer (unknown)" is exactly the
// message Brandon could not act on, so every branch here names something he can check or fix.
function exitFailureReason(label, { exitCode = null, signal = null, stderr = '', timedOut = false, timeoutMs = 0 } = {}) {
  if (timedOut) return `${label} did not answer within ${Math.round(timeoutMs / 1000)}s and was stopped`;
  const err = String(stderr || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (signal === 'SIGKILL' || exitCode === 137) {
    return `${label} was killed by macOS the instant it launched (SIGKILL, no output) — its code signature is invalid; run \`npm run agent:setup\` to re-sign it`;
  }
  if (signal) return `${label} was terminated by ${signal} before it could answer`;
  if (typeof exitCode === 'number' && exitCode !== 0) return `${label} exited ${exitCode}${err ? `: ${err}` : ' with no output'}`;
  if (err) return `${label} produced no answer: ${err}`;
  return null;
}

// Classify a CLI failure as "not usable" (fall back) vs a real error. Logged-out / missing-binary /
// auth failures mean fall back to the single-shot answer; anything else we surface honestly.
function unusableReason(text = '') {
  const t = String(text);
  if (/credit balance (?:is )?too low|usage limit|quota.*(?:exceeded|reached)/i.test(t)) return 'the Claude lane has no credits remaining';
  if (/not logged in|please run .*login|\/login|authentication.*required|invalid api key/i.test(t)) return 'the claude CLI is not logged in — run `claude` then /login in Terminal';
  if (/ENOEXEC|native binary not installed|not installed|command not found|ENOENT/i.test(t)) return 'the claude CLI is not fully installed on this machine — reinstall it (npm i -g @anthropic-ai/claude-code) to unlock the full agent';
  return null;
}

// Turn a raw spawn/exec error into an honest, actionable degrade reason.
function spawnErrorReason(e) {
  const msg = String((e && e.message) || e || '');
  return unusableReason(msg) || `could not start the claude CLI: ${msg}`;
}

// Parse one stream-json NDJSON event into UI events via emit(). Returns the final result text when the
// terminal `result` event arrives, else null. The claude CLI `--output-format stream-json` emits:
//   {type:'system',subtype:'init',session_id,tools,model}
//   {type:'assistant',message:{content:[{type:'text',text}|{type:'tool_use',name,input}]}}
//   {type:'user',message:{content:[{type:'tool_result',content}]}}
//   {type:'result',subtype:'success'|'error...',result,session_id,is_error}
function handleEvent(obj, emit, ctx) {
  const type = obj && obj.type;
  if (type === 'system' && obj.subtype === 'init') {
    if (obj.session_id) ctx.sessionId = obj.session_id;
    emit({ type: 'status', text: `engine ready · ${obj.model || 'claude'}`, model: obj.model });
    return null;
  }
  if (type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const block of obj.message.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text && block.text.trim()) {
        const unusable = unusableReason(block.text);
        if (unusable) ctx.error = block.text; // suppress provider billing/auth text; finish() falls back
        else emit({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        emit({ type: 'tool', name: block.name, summary: summarizeToolInput(block.name, block.input) });
      }
    }
    return null;
  }
  if (type === 'user' && obj.message && Array.isArray(obj.message.content)) {
    for (const block of obj.message.content) {
      if (block && block.type === 'tool_result') {
        emit({ type: 'tool_result', ok: !block.is_error, preview: previewToolResult(block.content) });
      }
    }
    return null;
  }
  if (type === 'result') {
    if (obj.session_id) ctx.sessionId = obj.session_id;
    if (obj.is_error) { ctx.error = obj.result || obj.subtype || 'the agent ended with an error'; return null; }
    return typeof obj.result === 'string' ? obj.result : '';
  }
  return null;
}

function summarizeToolInput(name, input = {}) {
  try {
    if (name === 'Read' || name === 'LS') return String(input.file_path || input.path || '');
    if (name === 'Grep') return String(input.pattern || '');
    if (name === 'Glob') return String(input.pattern || '');
    if (name === 'Bash') return String(input.command || '').slice(0, 120);
    if (name === 'WebFetch' || name === 'WebSearch') return String(input.url || input.query || '');
    if (name && name.startsWith('mcp__brain__')) return String(input.query || input.subject || input.since || '');
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch { return ''; }
}

function previewToolResult(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) s = content.map((c) => (c && (c.text || c.result)) || '').join(' ');
  else if (content && content.text) s = content.text;
  else if (content && typeof content === 'object') { try { s = JSON.stringify(content); } catch { s = ''; } }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// Run the streaming claude-CLI agent. Resolves { reply, engine, sessionId, toolCount, degraded, reason }.
// emit(event) streams UI events as they happen. spawnFn is injectable for tests.
//
// A live turn the full agent could not complete (lane down, logged out, an error, no answer) is a
// failure Seen Command tracks by itself: one 'assistant' line on the activity ledger, which
// lib/ticket-sources.mjs turns into an assistant_failed brain ticket (with what would have helped). The
// next turn the agent answers resolves it. Injected test runs (a fake spawnFn) never report.
export function runChatAgent(opts = {}) {
  const p = runChatAgentTurn(opts);
  if (opts.spawnFn && opts.spawnFn !== nodeSpawn) return p;
  return p.then((r) => { reportTurn(opts.message, r); return r; });
}
export function turnFailure(r) {
  if (!r || r.reason === 'empty message') return null;
  if (r.degraded && r.reason) return String(r.reason);
  if (r.reason && /^I hit an error/.test(String(r.reply || ''))) return String(r.reason);
  return null;
}
function reportTurn(message, r) {
  const why = turnFailure(r);
  if (why) {
    import('../lib/activity.mjs').then((m) => m.logActivity({ kind: 'assistant', id: 'full agent', status: 'failed',
      summary: `Board Room could not complete a request: ${String(message || '').replace(/\s+/g, ' ').slice(0, 140)}`, detail: why.slice(0, 600) })).catch(() => {});
    return;
  }
  if (r && r.reply && !r.degraded) {
    import('../lib/ticket-wire.mjs').then((m) => m.ticketSources.resolveFrom({ kind: 'assistant_failed', repo: config.commandRepo(), thing: 'board room full agent', how: `the full agent answered a turn (${r.engine})` })).catch(() => {});
  }
}

function runChatAgentTurn({ message, sessionId = null, emit = () => {}, spawnFn = nodeSpawn,
  cwd = REPO_ROOT, addDir = homedir(), extraContext = '', fallback = null, timeoutMs = 10 * 60 * 1000, lane: forcedLane = null,
  claudeHealth = claudeCliHealth } = {}) {
  // Live app default: use the authenticated Cline Pass for conversation. Injected tests retain the
  // Claude stream parser below. Cline does not receive a write-capable shell: the server first injects
  // a fresh, secret-free platform snapshot plus message-targeted read-only local evidence. Deterministic
  // owned skills/actions still handle direct reads and all writes before this conversational lane.
  if (forcedLane !== 'claude' && spawnFn === nodeSpawn && String(process.env.CHAT_ENGINE || 'cline').toLowerCase() !== 'claude') {
    let lane = { engine: 'cline', notice: null, reason: null };
    try { lane = chooseLiveLane({ cline: clineCliHealth(), claude: claudeCliHealth() }); }
    catch { lane = { engine: 'cline', notice: null, reason: null }; } // a broken probe must not block the chat
    if (lane.engine === 'cline') {
      // A Cline turn that FAILS at run time (killed by macOS, timed out, no answer) used to drop straight to
      // the memory-only lane even with a logged-in claude CLI sitting right there (owner, 2026-10-21: answers
      // came back "memory-only · gemini"). Now one honest retry on the claude CLI comes first.
      const viaClaude = clineFailover({ claudeHealth, emit, run: () => runChatAgentTurn({ message, sessionId, emit, spawnFn, cwd, addDir, extraContext, fallback, timeoutMs, lane: 'claude' }) });
      return runClineChat({ message, emit, cwd, extraContext, fallback, timeoutMs, onFail: viaClaude });
    }
    if (lane.engine === 'none') {
      return new Promise((resolve) => { degradeTo(fallback, lane.reason, emit, resolve); });
    }
    // Visible failover to the claude CLI. Announce the switch and the reason, then fall through to
    // the streaming claude path below (spawnFn is the real spawn here).
    emit({ type: 'status', text: lane.notice, laneSwitch: true, from: 'cline', to: 'claude-cli', reason: lane.reason });
  }
  return new Promise((resolve) => {
    if (!message || !String(message).trim()) { resolve({ reply: '', engine: 'none', degraded: true, reason: 'empty message' }); return; }

    const bin = claudeBin();
    const injected = spawnFn !== nodeSpawn;
    if (!injected && !existsSync(bin)) { degradeTo(fallback, 'the claude CLI is not installed on PATH', emit, resolve); return; }

    const args = [
      '-p', String(message),
      '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', appendSystemPrompt(extraContext),
      '--allowedTools', allowedTools().join(' '),
      '--add-dir', addDir,
    ];
    // Context continuity: resume the same chat session so the agent keeps its own context window across
    // turns. A stale/absent id just starts fresh (the CLI mints one, returned in the init/result event).
    if (sessionId) args.push('--resume', String(sessionId));
    if (process.env.CHAT_MODEL) args.push('--model', process.env.CHAT_MODEL);

    let child;
    try { child = spawnFn(bin, args, { cwd, env: claudeChildEnv(bin) }); }
    catch (e) { degradeTo(fallback, spawnErrorReason(e), emit, resolve); return; }

    const ctx = { sessionId, error: null };
    let buf = '';
    let stderr = '';
    let finalReply = null;
    let toolCount = 0;
    let settled = false;
    let timedOut = false;

    const emitCounting = (ev) => { if (ev.type === 'tool') toolCount += 1; emit(ev); };

    const timer = setTimeout(() => { if (!settled) { timedOut = true; try { child.kill('SIGTERM'); } catch { /* ignore */ } } }, timeoutMs);

    const onLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj; try { obj = JSON.parse(trimmed); } catch { return; } // non-JSON noise — ignore
      const result = handleEvent(obj, emitCounting, ctx);
      if (result !== null) finalReply = result;
    };

    child.stdout && child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString(); });

    const finish = (exitCode = null, signal = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (buf.trim()) onLine(buf); // flush the last partial line
      const combined = `${stderr}\n${finalReply || ''}`;
      const unusable = unusableReason(combined);
      // Some Claude CLI versions return billing/auth failures as a successful-looking `result` string.
      // Never paint that raw provider failure as the assistant's answer—fall through regardless.
      if (unusable) { degradeTo(fallback, unusable, emit, resolve); return; }
      if (ctx.error && finalReply == null) {
        const reason = unusableReason(ctx.error);
        if (reason) { degradeTo(fallback, reason, emit, resolve); return; }
        emit({ type: 'error', text: ctx.error });
        resolve({ reply: `I hit an error: ${ctx.error}`, engine: 'claude-cli', sessionId: ctx.sessionId, toolCount, degraded: false, reason: ctx.error });
        return;
      }
      if (finalReply == null) {
        // No answer means SOMETHING went wrong; name it. A silent exit code or a kill signal is a
        // diagnosis Brandon can act on, unlike "produced no answer".
        const why = exitFailureReason('the claude CLI', { exitCode, signal, stderr, timedOut, timeoutMs })
          || 'the claude CLI produced no answer';
        degradeTo(fallback, why, emit, resolve); return;
      }
      emit({ type: 'done', engine: 'claude-cli' });
      resolve({ reply: finalReply, engine: 'claude-cli', sessionId: ctx.sessionId, toolCount, degraded: false });
    };

    child.on('error', (e) => { if (!settled) degradeTo(fallback, spawnErrorReason(e), emit, resolve, settleGuard(() => { settled = true; clearTimeout(timer); })); });
    child.on('close', (code, signal) => finish(code, signal));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

// Returns an onFail(why) handler for a failed Cline turn: retry once on the claude CLI when it is installed
// and logged in, otherwise null (the caller degrades to memory-only with the Cline reason). Pure enough to test.
export function clineFailover({ claudeHealth = claudeCliHealth, emit = () => {}, run }) {
  return (why) => {
    let h = null; try { h = claudeHealth(); } catch { h = null; }
    if (!h || h.runnable !== true || h.authenticated !== true) return null;
    emit({ type: 'status', text: `Cline failed (${why}) — answering on the local claude CLI instead`, laneSwitch: true, from: 'cline', to: 'claude-cli', reason: why });
    return run();
  };
}

function runClineChat({ message, emit, cwd, extraContext, fallback, timeoutMs, onFail = null }) {
  return new Promise((resolve) => {
    const bin = clineExecutable();
    if (!existsSync(bin)) { degradeTo(fallback, `the Cline lane is not installed (no binary at ${bin}) — run \`npm run agent:setup\``, emit, resolve); return; }
    const selected = clineSelection();
    const system = `${appendSystemPrompt(extraContext)}

INVESTIGATION MODE: Answer Brandon directly and naturally. Start from the LIVE PLATFORM SNAPSHOT and READ-ONLY LOCAL EVIDENCE above; they were gathered immediately before this turn and override stale conversation/Brain facts. You are running in Cline PLAN mode: use its read_file/list_files/search_files and strictly read-only run_commands tools whenever the supplied evidence is insufficient. The approved read-only command surface is \`node scripts/ops.mjs <state|snapshot|search <q>|query --target …|credentials|drift|logs|diagnose>\` (the OPS MASTER-KIT above) — prefer it over ad-hoc commands; it is deterministic and cannot mutate anything. Inspect both repo paths and the Brain path shown above as needed. Never create, edit, delete, install, migrate, deploy or send through any other command. The ONE exception is \`node scripts/act.mjs <verb>\` (see YOU ACT above): every Seen Command action — searches, builds, meetings, settings, cleanups, approvals Brandon asks for, brain notes — goes through it; use it whenever Brandon asks you to do something. If a source is unavailable, name it instead of guessing. Never claim an action was performed unless act.mjs returned it.`;
    const args = clineChatArgs({ selected, cwd, timeoutMs, system, message });
    let child;
    try { child = nodeSpawn(bin, args, { cwd, env: chatChildEnv(bin) }); }
    catch (e) { const why = `Cline could not start: ${e.message}`; const retry = onFail ? onFail(why) : null; if (retry) { Promise.resolve(retry).then(resolve); return; } degradeTo(fallback, why, emit, resolve); return; }
    emit({ type: 'status', text: `Cline Pass ready · ${selected.model || 'provider default'}`, model: selected.model });
    let buf = ''; let stderr = ''; let final = null; let failure = null; let settled = false; let run = null; let toolCount = 0; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs);
    const onLine = (line) => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'run_result') { run = e; final = String(e.text || ''); if (e.finishReason && e.finishReason !== 'completed') failure = e.finishReason; }
      const ce = handleClineEvent(e, emit);
      if (ce.tool) toolCount += 1;
      if (ce.failure) failure = ce.failure;
    };
    child.stdout?.on('data', (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const finish = (exitCode = null, signal = null) => {
      if (settled) return; settled = true; clearTimeout(timer); if (buf.trim()) onLine(buf);
      const bad = unusableReason(`${stderr}\n${final || ''}`);
      if (bad || failure || !final) {
        // The old message here was "Cline ended without an answer (unknown)" — which is precisely
        // what a SIGKILLed binary produces, and precisely what Brandon could not act on. Prefer, in
        // order: a classified provider failure, the process-level diagnosis (exit code / signal /
        // timeout), then Cline's own reported finish reason.
        const why = bad
          || exitFailureReason('the Cline lane', { exitCode, signal, stderr, timedOut, timeoutMs })
          || (failure ? `the Cline lane stopped early (${failure})` : 'the Cline lane returned no answer and no error');
        const retry = onFail ? onFail(why) : null;
        if (retry) { Promise.resolve(retry).then(resolve, () => degradeTo(fallback, why, emit, resolve)); return; }
        degradeTo(fallback, why, emit, resolve); return;
      }
      try { recordAIUsage({ provider: run?.model?.provider || selected.provider, model: run?.model?.id || selected.model, surface: 'board-room', costUsd: run?.usage?.totalCost, inputTokens: run?.usage?.inputTokens, outputTokens: run?.usage?.outputTokens }); } catch { /* usage must never break chat */ }
      try { recordClineConnectionSuccess({ provider: run?.model?.provider || selected.provider, model: run?.model?.id || selected.model, latencyMs: run?.durationMs, costUsd: run?.usage?.totalCost, source: 'board-room' }); } catch { /* health recording must never break chat */ }
      emit({ type: 'text', text: final }); emit({ type: 'done', engine: 'cline-pass' });
      resolve({ reply: final, engine: 'cline-pass', sessionId: null, toolCount, degraded: false });
    };
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); const why = `Cline could not start: ${e.message}`; const retry = onFail ? onFail(why) : null; if (retry) { Promise.resolve(retry).then(resolve); return; } degradeTo(fallback, why, emit, resolve); } });
    child.on('close', (code, signal) => finish(code, signal));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

function handleClineEvent(row, emit = () => {}) {
  const e = row?.type === 'agent_event' ? row.event : null;
  if (!e) return {};
  if (e.type === 'content_start' && e.contentType === 'reasoning') {
    emit({ type: 'status', text: 'investigating live sources…' });
  }
  if (e.type === 'content_start' && e.contentType === 'tool') {
    emit({ type: 'tool', name: e.toolName || 'read', summary: summarizeToolInput(e.toolName, e.input) });
    return { tool: true };
  }
  if (e.type === 'content_end' && e.contentType === 'tool') {
    emit({ type: 'tool_result', ok: !e.error, preview: previewToolResult(e.output || e.error || '') });
  }
  if (e.type === 'done' && e.reason !== 'completed') return { failure: e.reason || 'incomplete' };
  return {};
}

function clineChatArgs({ selected, cwd, timeoutMs, system, message }) {
  const args = ['--json', '--plan', '--provider', selected.provider];
  if (selected.model) args.push('--model', selected.model);
  // Plan mode is Cline's enforced investigation surface: edit/write tools are absent and
  // run_commands is restricted to read-only inspection. Auto-approval prevents headless reads from
  // being denied merely because no TTY exists; it does not switch the session into Act mode.
  args.push('--cwd', cwd, '--timeout', String(Math.max(30, Math.floor(timeoutMs / 1000))), '--thinking', 'medium', '--auto-approve', 'true', '--system', system, String(message));
  return args;
}

function settleGuard(fn) { fn(); return true; }

// Fall back to the caller's single-shot answer (the old memory-augmented reason() path), flagged honestly
// so the UI can prompt Brandon to log in the CLI for full capabilities.
async function degradeTo(fallback, reason, emit, resolve, alreadySettled) {
  emit({ type: 'status', text: `full agent unavailable (${reason}) — answering from memory only`, degraded: true, reason });
  if (typeof fallback === 'function') {
    try {
      const r = await fallback();
      if (r && r.reply) emit({ type: 'text', text: r.reply });
      emit({ type: 'done', engine: (r && r.engine) || 'fallback', degraded: true, reason });
      resolve({ reply: (r && r.reply) || '', engine: (r && r.engine) || 'fallback', degraded: true, reason });
      return;
    } catch (e) {
      emit({ type: 'error', text: `fallback failed: ${e.message}` });
    }
  }
  const msg = `I can't run the full agent right now (${reason}).`;
  emit({ type: 'text', text: msg });
  emit({ type: 'done', engine: 'none', degraded: true, reason });
  resolve({ reply: msg, engine: 'none', degraded: true, reason });
}

export const _internals = { handleEvent, handleClineEvent, summarizeToolInput, previewToolResult, unusableReason, allowedTools, appendSystemPrompt, claudeBin, clineChatArgs, chooseLiveLane, exitFailureReason };
