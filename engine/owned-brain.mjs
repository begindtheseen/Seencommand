// owned-brain — the seed of an OWNED, deterministic answer engine for the Board Room. It answers the
// most common Board Room questions DIRECTLY from real connector + brain data, with NO LLM call, so the
// app can progressively stop leaning on external models. Every reply is grounded in live fields (PR
// mergeability, CI runs, the vault timeline, KPI tiles, deploy state) — it never fabricates; when a
// data source is unconfigured or a lookup throws, it returns { handled: false } and lets the LLM agent
// take over. When the source is reachable but genuinely empty, it says so honestly.
//
// This module is READ-ONLY over the connectors: it imports their functions and never mutates anything.
// Every external dependency is injected via `deps` (with real imports as defaults) so tests run offline.

import { existsSync } from 'node:fs';
import { openPRsFor, recentCommits, ciStatus, prInfo, prFiles, issuesFor, issueInfo, configured as githubConfigured } from '../lib/connectors/github.mjs';
import { signals } from '../lib/connectors/index.mjs';
import { readTimelineDigest, readTimelineEntries, readBrainFacts, readDecisions } from '../lib/brain.mjs';
import { rankFacts } from '../brain/lib/keeper.mjs';
import { summary as adminSummary } from '../lib/connectors/adminStats.mjs';
import { latestDeployment } from '../lib/connectors/vercel.mjs';
import { listBuilds } from '../lib/builds.mjs';
import { readActivity } from '../lib/activity.mjs';
import { servedTags } from '../lib/router.mjs';
import { clineExecutable, clineSelection } from '../lib/credentials.mjs';
import { config } from '../lib/config.mjs';
import { CAPABILITIES } from '../org/capabilities.mjs';
import { platformStatus } from '../lib/platform-status.mjs';
import { answerAggregationQuestion, aggregationContextFromRuns, AGGREGATION_QUESTION } from '../lib/aggregation/agent-view.mjs';

// Real dependency defaults — tests override these with fixtures so nothing hits the network.
export const DEFAULT_DEPS = {
  openPRsFor,
  recentCommits,
  ciStatus,
  prInfo,
  prFiles,
  issuesFor,
  issueInfo,
  githubConfigured,
  signals,
  readTimelineDigest,
  readTimelineEntries,
  readBrainFacts,
  rankFacts,
  readDecisions,
  listBuilds,
  readActivity,
  servedTags,
  clineBin: clineExecutable,
  clineSel: clineSelection,
  adminSnapshot: adminSummary,      // adminStats.summary — the KPI tiles
  vercelState: latestDeployment,    // vercel.latestDeployment — deploy state + url
  githubRepo: config.githubRepo,    // product repo slug (deploys prod)
  commandRepo: config.commandRepo,  // Seen Command's own (tool) repo slug
  capabilities: () => CAPABILITIES,
  platformStatus,
  // Aggregation Dashboard — the READ-ONLY snapshot (status + run history). Dynamic so this module never
  // hard-depends on the manager; nothing reachable from here can start, schedule or change a run.
  aggregation: async () => (await import('./aggregation-manager.mjs')).aggregationManager().snapshot(),
  // Creator Library — dynamic so this module never hard-depends on the sqlite-backed library.
  igProjects: async () => (await import('../lib/instagram/library.mjs')).listProjects(),
  // The Creator Library's ranked, cited insights (deterministic, read-only, no model) — all creators,
  // or one project. The same engine the board meeting reads.
  creatorInsights: async (project = null) => (await import('../lib/instagram/insights.mjs')).libraryInsights({ project }),
  answerCreatorQuestion: async (lib, q) => (await import('../lib/instagram/insights.mjs')).answerCreatorQuestion(lib, q),
  // The ops master-kit (lib/ops.mjs) — loaded lazily so skills that never need it pay no import
  // cost, and tests inject fakes without touching the real module.
  credentialAudit: async () => (await import('../lib/ops.mjs')).credentialAudit(),
  driftCheck: async () => (await import('../lib/ops.mjs')).driftCheck(),
  exportLogs: async () => (await import('../lib/ops.mjs')).exportLogs(),
  searchAll: async (q) => (await import('../lib/ops.mjs')).searchAll(q),
  opsUsage: async () => (await import('../scripts/ops.mjs')).USAGE,
  opsFailures: async () => (await import('../lib/ops.mjs')).opsFailures(),
  buildGaps: async () => (await import('../lib/build-gaps.mjs')).buildGaps(),
};

// A thrown-through sentinel: a connector result that means "not reachable" (unconfigured / errored),
// as opposed to reachable-but-empty. Used so a matched skill can fall through to the LLM cleanly.
class Unavailable extends Error {}
const isNotConfigured = (v) => !!(v && (v.notConfigured === true || v.configured === false));
const isErrored = (v) => !!(v && typeof v.error === 'string');
function requireReachable(v, what) {
  if (v == null || isNotConfigured(v) || isErrored(v)) throw new Unavailable(`${what} unavailable`);
  return v;
}

// ---- the capability catalog -------------------------------------------------
// What each owned skill actually does, keyed by skill id, plus the phrasing that triggers it.
//
// This exists because the Board Room could not confirm its own abilities: "what can you do" answered
// from a HAND-WRITTEN prose blurb that had already drifted — it never mentioned the four ops skills
// shipped hours earlier, so the chat denied having capabilities it demonstrably had. The roster is
// now DERIVED from SKILLS at runtime, and owned-brain.test.mjs fails if any skill lacks an entry
// here, which makes the "my list is stale" failure mode structurally impossible rather than a
// discipline problem.
export const SKILL_CATALOG = {
  'aggregation': { what: 'the two Seen collection pipelines (Company Intelligence + Indeed Jobs) from their real run history — imports this week, what is failing and why, identity review; read-only', ask: 'how many jobs did Indeed import this week?' },
  'pr-safety': { what: 'a deterministic merge verdict for any PR — CI, conflicts, draft state, diff size', ask: 'is PR 249 safe to merge?' },
  'pr-list': { what: 'every open PR across both repos, at a glance', ask: 'what PRs are open?' },
  'task-detail': { what: 'one task joined to its live GitHub issue and its current build record', ask: "what's going on with task 147?" },
  'task-list': { what: 'the real open tasks in both repos', ask: 'what tasks are open?' },
  'build-status': { what: 'what the test-gated builder is doing or last did', ask: 'is anything building?' },
  'activity-digest': { what: 'the activity ledger digested — every meeting, build, approval and verdict', ask: 'review seen command updates' },
  'approval-queue': { what: 'the pending approval queue with the exact edit/approve syntax', ask: 'what needs my approval?' },
  'decisions': { what: 'the locked-decisions ledger from the vault', ask: 'what have we decided?' },
  'ship-log': { what: 'what actually shipped recently, from the vault timeline plus merged PRs', ask: 'what did we ship this week?' },
  'credential-audit': { what: 'which connectors are missing VALID tokens — configured-but-rejected vs never set, never the values', ask: 'run a credential audit' },
  'deploy-drift': { what: 'whether what is merged is what is actually deployed', ask: 'is production in sync?' },
  'build-gaps': { what: 'my own shortcomings, read off every build I have ever run — what capability was missing, ranked by how many failures it would have converted', ask: 'what are you missing?' },
  'failure-queue': { what: 'every failure that has not been resolved, split into what is mine to fix vs blocked on you', ask: "what's stuck?" },
  'export-logs': { what: 'one debugging bundle: CI runs, the failed-run log, Vercel deploys, build logs, activity, health', ask: 'export all logs' },
  'search-everything': { what: 'code across both repos plus brain facts in one step, with file:line references', ask: 'search everything for ghost rate' },
  'self-diagnosis': { what: 'the full health map of every connector, lane, repo and runtime source, with repair steps', ask: 'diagnose yourself' },
  'platform-overview': { what: 'one live cross-source map of the whole platform', ask: 'show me the whole platform' },
  'whats-failing': { what: 'what is red right now across CI, deploys and error counts', ask: "what's broken?" },
  'forge-status': { what: 'whether the owned coding engine and local models are ready', ask: 'forge status' },
  'brain-know': { what: 'what the shared brain knows about a topic, cited', ask: 'what do we know about ghost rate?' },
  'creators': { what: 'the researched Instagram creators and their distilled SeenJobs key points', ask: 'creator library' },
  'kpi-quick': { what: 'a one-number answer straight from the KPI tiles', ask: 'how many users do we have?' },
  'business-summary': { what: 'the compact business readout — users, revenue, jobs, errors', ask: "how's the business?" },
  'deploy-status': { what: 'whether production is live and on which commit', ask: 'is prod up?' },
  'capabilities': { what: 'this list — everything I can really do, derived from what is wired', ask: 'what can you do?' },
  'can-i': { what: 'a straight yes/no on whether I can do a specific thing, with the exact phrasing to trigger it', ask: 'can you search the code?' },
};

// The things the Board Room really DOES on command (engine/server.mjs detectChatAction → runWiredAction).
// Kept here so the capability answer covers actions as well as read-only skills.
const WIRED_ACTIONS = [
  ['run a board meeting', 'runs a real board meeting and rebuilds the cockpit'],
  ['set focus to <goal>', 'changes the focus everywhere — any custom goal, not just presets'],
  ['approve <x> / deny <x>', 'runs the same path as the button: files the task, drafts the deliverable, or kicks the builder'],
  ['edit approval 2 summary to <text>', 'edits a pending proposal before it executes, verified read-after-write'],
  ['fix <bug> in seen command / build <thing> on the site', 'files a tracked task and starts the test-gated builder'],
  ['remember: <note>', 'writes a real note to the Chronos timeline'],
  ['record fact <subject> | <predicate> | <object>', 'writes a real typed fact to the brain, verified'],
  ['update yourself', 'merges green self-improvement PRs, runs the gate, rebuilds and restarts the app'],
];

// ---- helpers ----------------------------------------------------------------
const lc = (s) => String(s || '').toLowerCase();

function explicitRepoHint(message) {
  const t = lc(message);
  const tool = /\bseen command\b|\bcommand os\b|\bboard room\b|\btool repo(?:sitory)?\b|\bplatform repo(?:sitory)?\b/.test(t);
  const product = /\bseen ?jobs\b|\bseenjobs\.io\b|\bseen product\b|\bproduct repo(?:sitory)?\b|\bwebsite repo(?:sitory)?\b/.test(t);
  if (tool === product) return null;
  return tool ? 'tool' : 'product';
}

// The failing check-runs on a commit (conclusion present and not a benign outcome).
function failingRuns(ci) {
  return (ci?.runs || []).filter((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion));
}
function pendingRuns(ci) {
  return (ci?.runs || []).filter((r) => r.status && r.status !== 'completed');
}

// ---- SKILLS -----------------------------------------------------------------
// Each: { id, match(message) -> falsy | true | matchData, async run({ message, state, deps, m }) }.
// run returns { reply, sources } on success, returns null to decline, or throws to fall through.

const SKILLS = [
  // 0) AGGREGATION — collection-pipeline questions, answered only from recorded run metrics. First, so
  // "which collection pipeline is failing?" is not swallowed by the generic whats-failing skill.
  {
    id: 'aggregation',
    match(message) { return AGGREGATION_QUESTION.test(String(message || '')) ? true : null; },
    async run({ message, deps }) {
      let snap;
      try { snap = await deps.aggregation(); } catch { throw new Unavailable('aggregation unavailable'); }
      return answerAggregationQuestion(message, snap);
    },
  },
  // 1) PR SAFETY — the flagship "optimizer without AI": a deterministic merge verdict from real fields.
  {
    id: 'pr-safety',
    match(message) {
      const t = lc(message);
      const wantsVerdict = /\b(pr|pull request|merge|safe|review|wrong with|look at)\b/.test(t);
      if (!wantsVerdict) return null;
      let m = t.match(/(?:pr|pull request)\s*#?\s*(\d{1,6})/) || t.match(/#(\d{1,6})\b/);
      if (!m && /\b(merge|safe|review|wrong with|look at)\b/.test(t)) m = t.match(/\b(\d{1,6})\b/);
      const repoHint = explicitRepoHint(t);
      if (m) return { number: Number(m[1]), repoHint };
      return /\b(latest|newest|most recent|current)\b.*\bpr\b|\bpr\b.*\b(latest|newest|most recent|current)\b/.test(t) ? { latest: true, repoHint } : null;
    },
    async run({ deps, m }) {
      const productRepo = deps.githubRepo();
      const toolRepo = deps.commandRepo ? deps.commandRepo() : null;
      const hintedRepo = m.repoHint === 'tool' ? toolRepo : m.repoHint === 'product' ? productRepo : null;
      let number = m.number;
      if (m.latest) {
        let prs = [];
        let repo = hintedRepo || productRepo;
        try { prs = await deps.openPRsFor(repo); } catch (e) { if (/not configured/i.test(e.message)) throw new Unavailable('github unavailable'); }
        if (!prs.length && !hintedRepo && toolRepo && toolRepo !== productRepo) { try { prs = await deps.openPRsFor(toolRepo); repo = toolRepo; } catch { /* handled below */ } }
        if (!prs.length) return { reply: `✅ **There are no open PRs in \`${repo}\` right now.**`, sources: [`gh:${repo}:pulls`] };
        number = prs[0].number;
        // Keep the later lookup on the repo where "latest" was actually found.
        if (repo !== productRepo || hintedRepo) {
          const info = await deps.prInfo({ repo, number }).catch(() => null);
          if (info) m.preferredRepo = repo;
        }
      }

      // Look up the PR on the product repo first; if it 404s there, try the tool repo. A "not
      // configured" error is a genuine fallthrough (let the LLM handle it), not a not-found.
      let repo = m.preferredRepo || hintedRepo || productRepo;
      let info;
      try {
        info = await deps.prInfo({ repo, number });
      } catch (e) {
        if (/not configured/i.test(e.message)) throw new Unavailable('github unavailable');
        if (!hintedRepo && toolRepo && toolRepo !== productRepo) {
          try { info = await deps.prInfo({ repo: toolRepo, number }); repo = toolRepo; }
          catch (e2) {
            if (/not configured/i.test(e2.message)) throw new Unavailable('github unavailable');
            info = null;
          }
        } else { info = null; }
      }
      if (!info) {
        const searched = hintedRepo ? `\`${repo}\``
          : `\`${productRepo}\`${toolRepo && toolRepo !== productRepo ? ` or \`${toolRepo}\`` : ''}`;
        return {
          reply: `I couldn't find **PR #${number}** in ${searched}. Double-check the number, or name the other repo.`,
          sources: [`gh:${repo}#${number}`],
        };
      }

      const repoLabel = repo === toolRepo ? 'Seen Command' : 'Seen product';

      if (info.merged) {
        return { reply: `**${repoLabel} PR #${number}** is already **merged** — nothing to decide. [View PR](${info.url})`, sources: [`gh:${repo}#${number}`] };
      }
      if (info.state === 'closed') {
        return { reply: `**${repoLabel} PR #${number}** is **closed** (not merged). [View PR](${info.url})`, sources: [`gh:${repo}#${number}`] };
      }

      // CI + diff size (real fields). ciStatus/prFiles are best-effort — a failure there just drops that
      // line of evidence rather than sinking the whole verdict.
      const ci = await deps.ciStatus(info.headSha).catch(() => ({ state: 'unknown', runs: [] }));
      const files = await deps.prFiles({ repo, number }).catch(() => null);
      const fileCount = Array.isArray(files) ? files.length : null;

      const blockers = [];
      const cautions = [];
      if (info.draft) blockers.push('it is still a **draft**');
      if (info.mergeable === false || lc(info.mergeableState) === 'dirty') blockers.push('it has **merge conflicts** with the base branch');
      const fails = failingRuns(ci);
      const pend = pendingRuns(ci);
      if (ci.state === 'failing' && fails.length) blockers.push(`CI is **failing** (${fails.map((r) => r.name).join(', ')})`);
      else if (ci.state === 'failing') blockers.push('CI is **failing**');
      if (ci.state === 'running' && pend.length) blockers.push(`checks are **still running** (${pend.map((r) => r.name).join(', ')})`);
      if (lc(info.mergeableState) === 'blocked') cautions.push('branch protection reports it **blocked** (required review or checks)');
      if (lc(info.mergeableState) === 'behind') cautions.push('the branch is **behind** its base — update before merging');
      if (info.mergeable === null && info.mergeableState !== 'dirty') cautions.push('GitHub is still computing mergeability');
      if (fileCount != null && fileCount > 30) cautions.push(`it touches **${fileCount} files** — review carefully`);

      const evidence = [];
      evidence.push(`- Mergeable: ${info.mergeable === null ? 'computing…' : info.mergeable ? 'yes' : 'no'} (\`${info.mergeableState || 'unknown'}\`)`);
      evidence.push(`- CI: ${ci.state}${ci.runs?.length ? ` — ${ci.runs.length} check${ci.runs.length === 1 ? '' : 's'}` : ''}`);
      if (fileCount != null) evidence.push(`- Files changed: ${fileCount}`);
      if (info.draft) evidence.push('- Draft: yes');

      let verdict;
      if (blockers.length) {
        verdict = `⚠️ **Not yet — ${blockers.join('; ')}.**`;
      } else if (cautions.length) {
        verdict = `✅ **Looks safe to merge** — but ${cautions.join('; ')}.`;
      } else {
        verdict = '✅ **Looks safe to merge.**';
      }

      const reply = [
        `### ${repoLabel} PR #${number} — merge check`,
        '',
        verdict,
        '',
        evidence.join('\n'),
        '',
        `[View PR](${info.url})`,
        repo !== productRepo ? `\n_(Found in the tool repo \`${repo}\`, not the product repo.)_` : '',
      ].filter(Boolean).join('\n');

      return { reply, sources: [`gh:${repo}#${number}`] };
    },
  },

  // PR LIST — "what PRs are open?" across BOTH repos, with an at-a-glance state per PR.
  {
    id: 'pr-list',
    match(message) {
      const t = lc(message);
      if (/#?\d{2,6}\b/.test(t)) return null; // a specific number → pr-safety's territory
      return (/\bprs?\b|\bpull requests?\b/.test(t) && /\b(open|list|any|what|which|show|outstanding|pending|waiting)\b/.test(t))
        || /\bopen prs?\b|\bprs? open\b/.test(t);
    },
    async run({ deps }) {
      const repos = [...new Set([deps.githubRepo(), deps.commandRepo ? deps.commandRepo() : null].filter(Boolean))];
      const sections = [];
      const sources = [];
      let reachable = false;
      for (const repo of repos) {
        let prs;
        try { prs = await deps.openPRsFor(repo); reachable = true; } catch { continue; }
        sources.push(`gh:${repo}:pulls`);
        if (!prs.length) { sections.push(`**\`${repo}\`** — no open PRs.`); continue; }
        const lines = prs.slice(0, 8).map((p) => `- **#${p.number}** ${String(p.title || '').slice(0, 70)}${p.draft ? ' _(draft)_' : ''}${p.url ? ` — [view](${p.url})` : ''}`);
        sections.push(`**\`${repo}\`** — ${prs.length} open:\n${lines.join('\n')}${prs.length > 8 ? `\n_…and ${prs.length - 8} more._` : ''}`);
      }
      if (!reachable) throw new Unavailable('github unavailable');
      return { reply: `### Open PRs\n\n${sections.join('\n\n')}\n\n_Ask “is PR <n> safe to merge?” for a full merge check._`, sources };
    },
  },

  // TASK DETAIL — one live GitHub issue joined to its current local build record.
  {
    id: 'task-detail',
    match(message) {
      const t = lc(message);
      const m = t.match(/\b(?:task|issue)\s*#?\s*(\d{1,6})\b/);
      return m ? { number: Number(m[1]) } : null;
    },
    async run({ deps, m }) {
      if (deps.githubConfigured && !deps.githubConfigured()) throw new Unavailable('github unavailable');
      const repos = [...new Set([deps.commandRepo ? deps.commandRepo() : null, deps.githubRepo()].filter(Boolean))];
      let issue = null; let repo = null;
      for (const candidate of repos) {
        try { issue = await deps.issueInfo(candidate, m.number); } catch { issue = null; }
        if (issue) { repo = candidate; break; }
      }
      if (!issue) {
        return {
          reply: `I couldn't find **task #${m.number}** in ${repos.map((r) => `\`${r}\``).join(' or ')}. It may have been deleted or live in another repository.`,
          sources: repos.map((r) => `gh:${r}#${m.number}`),
        };
      }

      let builds = [];
      try { builds = deps.listBuilds() || []; } catch { /* GitHub state is still useful without local build records */ }
      const build = builds.find((b) => Number(b.issue?.number) === m.number && (!b.issue?.repo || b.issue.repo === repo))
        || builds.find((b) => b.id === `task-${m.number}`) || null;
      const stateWord = issue.state === 'closed' ? 'closed' : 'open';
      const parts = [`### Task #${m.number} — ${String(issue.title || '').replace(/^\[[^\]]+\]\s*/, '')}`, '',
        `**${stateWord === 'open' ? 'Open' : 'Closed'} on GitHub${build ? ` · latest build: \`${build.status}\`` : ' · no build started'}**`, '',
        `- Tracker: [\`${repo}#${m.number}\`](${issue.url || `https://github.com/${repo}/issues/${m.number}`})`,
      ];
      if (issue.labels?.length) parts.push(`- Labels: ${issue.labels.map((l) => `\`${l}\``).join(' ')}`);
      if (build) {
        parts.push(`- Build target: **${build.repo || 'unknown'}**`);
        if (build.pr) parts.push(`- Pull request: [${build.pr}](${build.pr})`);
        if (build.updatedAt || build.endedAt || build.startedAt) parts.push(`- Last builder update: \`${build.updatedAt || build.endedAt || build.startedAt}\``);
        if (build.error) parts.push(`- Failure/blocker: ${String(build.error).replace(/\s+/g, ' ').slice(0, 420)}`);
        const lastLog = Array.isArray(build.log) ? build.log[build.log.length - 1] : null;
        if (lastLog && !build.error) parts.push(`- Latest event: ${String(lastLog).replace(/\s+/g, ' ').slice(0, 320)}`);
      }
      const request = String(issue.body || '').split(/\n\s*---\s*\n/)[0]
        .replace(/^\*\*(?:Proposed by|Gate):\*\*.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
      if (request) parts.push('', '**Requested work**', '', request.slice(0, 600));
      if (build?.status === 'failed' && issue.state === 'open') parts.push('', '_The task is still open, so this failure is current work—not a completed Brain-memory item._');
      else if (['queued', 'building'].includes(build?.status)) parts.push('', '_This is live: the builder is actively working on it now._');
      else if (build?.status === 'pr_ready') parts.push('', '_The code is complete and gated; the linked PR is waiting for review/merge._');
      return { reply: parts.join('\n'), sources: [`gh:${repo}#${m.number}`, ...(build ? ['builds:records'] : [])] };
    },
  },

  // TASK LIST — the real open GitHub tasks (the Tasks tab's source of truth).
  {
    id: 'task-list',
    match(message) {
      const t = lc(message);
      return (/\b(tasks|issues|backlog|todo)\b/.test(t) && /\b(open|list|any|show|outstanding|pending|how many)\b/.test(t))
        || /\bwhat (tasks|issues) (?:are|do we have).*(?:open|pending|on the board|there)\b/.test(t)
        || /\bopen (tasks|issues)\b|\btask list\b|\bwhat'?s on the board\b/.test(t);
    },
    async run({ deps }) {
      const repos = [...new Set([deps.commandRepo ? deps.commandRepo() : null, deps.githubRepo()].filter(Boolean))];
      const sections = [];
      const sources = [];
      let reachable = false;
      for (const repo of repos) {
        let issues;
        try { issues = await deps.issuesFor(repo); reachable = true; } catch { continue; }
        sources.push(`gh:${repo}:issues`);
        if (!issues.length) { sections.push(`**\`${repo}\`** — no open tasks.`); continue; }
        const lines = issues.slice(0, 8).map((i) => `- **#${i.number}** ${String(i.title || '').slice(0, 70)}${i.labels?.length ? ` \`${i.labels.slice(0, 2).join('` `')}\`` : ''}${i.url ? ` — [view](${i.url})` : ''}`);
        sections.push(`**\`${repo}\`** — ${issues.length} open:\n${lines.join('\n')}${issues.length > 8 ? `\n_…and ${issues.length - 8} more._` : ''}`);
      }
      if (!reachable) throw new Unavailable('github unavailable');
      return { reply: `### Open tasks\n\n${sections.join('\n\n')}\n\n_The Tasks tab has ▶ Build buttons for each; or tell me “build task <n>”._`, sources };
    },
  },

  // BUILD STATUS — what the builder is doing / did, from the real build records.
  {
    id: 'build-status',
    match(message) {
      const t = lc(message);
      return (/\bbuilds?\b|\bbuilder\b/.test(t) && /\b(status|running|going|doing|queue|last|latest|recent|any|failed)\b/.test(t))
        || /\bis (anything|something) building\b|\bwhat('s| is) building\b/.test(t);
    },
    async run({ deps }) {
      let builds;
      try { builds = deps.listBuilds() || []; } catch { throw new Unavailable('build records unavailable'); }
      if (!builds.length) return { reply: '**No build records yet.** Approve an engineering action or hit ▶ Build on a task to start one.', sources: ['builds:records'] };
      const recent = builds.slice(0, 6);
      const icon = (s) => (s === 'pr_ready' ? '✅' : s === 'building' || s === 'queued' ? '⏳' : s === 'refused' ? '⏸' : s === 'failed' || s === 'preview_failed' || s === 'pr_closed' ? '❌' : '·');
      const lines = recent.map((b) => `- ${icon(b.status)} **${b.id}** (${b.repo || '?'}): ${b.status}${b.pr ? ` — [PR](${b.pr})` : ''}${b.title ? ` · ${String(b.title).slice(0, 60)}` : ''}`);
      const live = recent.filter((b) => b.status === 'building' || b.status === 'queued').length;
      return {
        reply: `### Builder status\n\n${live ? `**${live} build(s) in flight.**\n\n` : ''}${lines.join('\n')}\n\n_Every build runs the full gate (tests + the real production build) — a PR only opens on green._`,
        sources: ['builds:records'],
      };
    },
  },

  // ACTIVITY DIGEST — Brandon's "review seen command updates" loop, straight from the ledger.
  {
    id: 'activity-digest',
    match(message) {
      const t = lc(message);
      return /\breview seen command updates\b/.test(t)
        || /\bwhat did (seen command|the app|the system|you) (do|get done)\b/.test(t)
        || /\bactivity (log|ledger|digest|today)\b/.test(t)
        || /\bwhat happened today\b/.test(t)
        || /\btoday'?s (activity|events|log)\b/.test(t);
    },
    async run({ deps }) {
      let events;
      try { events = deps.readActivity({ days: 2 }) || []; } catch { throw new Unavailable('activity ledger unavailable'); }
      if (!events.length) return { reply: '**The activity ledger is empty for the last 2 days** — no meetings, builds, approvals, or verdicts recorded.', sources: ['ledger:activity'] };
      const recent = events.slice(-14).reverse();
      const lines = recent.map((e) => `- \`${String(e.ts || '').slice(11, 16) || '—'}\` **${e.kind}**${e.status ? ` (${e.status})` : ''}: ${String(e.summary || '').slice(0, 90)}`);
      const counts = {};
      for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;
      const tally = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' · ');
      return {
        reply: `### Seen Command activity (last 2 days)\n\n_${events.length} events — ${tally}_\n\n${lines.join('\n')}`,
        sources: ['ledger:activity'],
      };
    },
  },

  // APPROVAL QUEUE — the live edit/approve/deny surface, including stable ids and edit syntax.
  {
    id: 'approval-queue',
    match(message) {
      const t = lc(message);
      return /\b(pending|current|open) (approvals?|proposals?)\b/.test(t)
        || /\bwhat (needs|is waiting for) (my )?(approval|yes|decision)\b/.test(t)
        || /\bshow (me )?(the )?(approval|proposal) queue\b/.test(t);
    },
    async run({ state }) {
      const pending = (state?.approvals || []).filter((a) => a.status === 'pending');
      if (!pending.length) return { reply: '**Nothing is pending approval right now.** Run a board meeting to generate a fresh queue.', sources: ['state:approvals'] };
      const lines = pending.map((a, i) => `${i + 1}. **${a.title}** — ${String(a.summary || '').slice(0, 180)}\n   \`${a.id}\` · ${a.dept || 'unknown'} · ${a.action || 'action'}`);
      return {
        reply: `### Pending approvals (${pending.length})\n\n${lines.join('\n\n')}\n\nYou can say **“approve <title>”**, **“deny <title>”**, or **“edit approval 2 summary to <replacement>”**. Edits update both the card and the payload that will execute.`,
        sources: ['state:approvals'],
      };
    },
  },

  // DECISIONS — the locked-calls ledger.
  {
    id: 'decisions',
    match(message) {
      const t = lc(message);
      return /\bdecisions? (log|ledger|list|history)\b/.test(t)
        || /\bwhat (have we|did we) decide(d)?\b/.test(t)
        || /\b(recent|latest|last) decisions?\b/.test(t)
        || /\blocked calls?\b/.test(t);
    },
    async run({ deps }) {
      let decisions;
      try { decisions = deps.readDecisions(10) || []; } catch { throw new Unavailable('decision log unavailable'); }
      if (!decisions.length) return { reply: '**No decisions recorded yet** in the vault’s decision log.', sources: ['brain:decisions'] };
      const lines = decisions.map((d) => `- ${d.date ? `\`${String(d.date).slice(0, 10)}\` ` : ''}**${String(d.title || d.decision || '').slice(0, 90)}**${d.why ? ` — ${String(d.why).slice(0, 100)}` : ''}`);
      return { reply: `### Locked decisions (latest ${decisions.length})\n\n${lines.join('\n')}`, sources: ['brain:decisions'] };
    },
  },

  // 2) SHIP LOG — "what did we ship?" from the vault timeline + recently merged PRs.
  {
    id: 'ship-log',
    match(message) {
      const t = lc(message);
      return /\b(ship|shipped|shipping)\b/.test(t)
        || /\bwhat did we (do|get done|build|ship|accomplish)\b/.test(t)
        || /\bwhat(?:'s| has| have)? .*(happened|shipped|gotten done)\b/.test(t)
        || /\b(this week|lately|recently|progress|what happened)\b/.test(t);
    },
    async run({ deps }) {
      const digest = await deps.readTimelineDigest(7, 1400); // string; '' when no vault
      let merged = [];
      try {
        const commits = await deps.recentCommits(15);
        merged = (commits || [])
          .map((c) => ({ m: /^Merge pull request #(\d+)\s+from\s+(\S+)/i.exec(c.message || ''), c }))
          .filter((x) => x.m)
          .map((x) => ({ number: x.m[1], branch: x.m[2], url: x.c.url }));
      } catch { /* GitHub is a bonus here; the timeline is the primary source */ }

      // Turn the digest ("YYYY-MM-DD:\n  - heading: text") into flat bullets.
      const timelineBullets = String(digest)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .map((l) => `- ${l.slice(2)}`);

      if (!timelineBullets.length && !merged.length) {
        return {
          reply: "I don't see anything recorded in the vault timeline for the last 7 days, and no recent merged PRs. Nothing to report — honestly, not theater.",
          sources: ['vault:timeline'],
        };
      }

      const parts = ['### Shipped recently'];
      if (timelineBullets.length) {
        parts.push('', '**From the vault timeline (last 7 days):**', ...timelineBullets.slice(0, 12));
      }
      if (merged.length) {
        parts.push('', '**Merged PRs:**', ...merged.slice(0, 8).map((p) => `- [#${p.number}](${p.url}) — \`${p.branch}\``));
      }
      return { reply: parts.join('\n'), sources: ['vault:timeline', 'gh:commits'] };
    },
  },

  // OPS MASTER-KIT skills — Brandon's 2026-08-13 ability brief, served deterministically ($0, no
  // model) off lib/ops.mjs. credential-audit sits BEFORE self-diagnosis on purpose: "which tokens
  // are missing" deserves the per-credential audit, not the generic health map.
  {
    id: 'credential-audit',
    match(message) {
      const t = lc(message);
      return /\bcredential audit\b/.test(t)
        || /\baudit (?:the )?(?:credentials?|tokens?|keys?)\b/.test(t)
        || /\bwhich (?:tokens?|credentials?|keys?) (?:are )?(?:missing|invalid|broken|dead|expired|revoked)\b/.test(t);
    },
    async run({ deps }) {
      const a = await deps.credentialAudit();
      if (!a?.connectors) throw new Unavailable('credential audit unavailable');
      const icon = { broken: '🔴', degraded: '🟠', missing: '⚪', healthy: '✅', unprobed: '·' };
      const lines = a.connectors.map((c) => {
        const creds = c.credentials.map((f) => `\`${f.key}\` ${f.configured ? 'configured' : '**not set**'}`).join(' · ');
        return `- ${icon[c.live] || '·'} **${c.label}** — ${c.live}${c.detail ? `: ${c.detail}` : ''}\n  ${creds}${c.fix ? `\n  **Fix:** ${c.fix}` : ''}`;
      });
      return { reply: `### Credential audit\n\n**Overall: ${a.overall}.** Status only — values are never shown.\n\n${lines.join('\n')}`, sources: ['ops:credential-audit'] };
    },
  },

  {
    id: 'deploy-drift',
    match(message) {
      const t = lc(message);
      return /\bdeploy drift\b|\bdrift (?:check|status)\b/.test(t)
        || /\b(?:is )?prod(?:uction)? (?:is )?in sync\b/.test(t)
        || /\bdid (?:the|that) merge deploy\b/.test(t)
        || /\bmerged? (?:vs\.?|versus) deploy(?:ed)?\b/.test(t);
    },
    async run({ deps }) {
      const d = await deps.driftCheck();
      if (!d) throw new Unavailable('drift check unavailable');
      const head = d.checkable
        ? (d.drifted
          ? `🔴 **DRIFTED** — \`${d.branch}\` is at \`${String(d.branchSha || '').slice(0, 8)}\` but production serves \`${String(d.prodSha || '').slice(0, 8)}\`. A merge that never deployed looks exactly like a fix that didn't work — trigger a production deployment before drawing conclusions from prod behaviour.`
          : `✅ **In sync** — \`${d.branch}\` and production both at \`${String(d.branchSha || '').slice(0, 8)}\`${d.deployedAgoMin != null ? ` (deployed ${d.deployedAgoMin} min ago)` : ''}.`)
        : `⚠️ **Not checkable live right now** (needs gh auth + the Vercel token)${d.prodError ? ` — ${d.prodError}` : ''}. Not checkable is NOT "in sync".`;
      const last = d.lastRecorded ? `\n\n_Last recorded verdict (brain${d.lastRecorded.since ? `, since ${d.lastRecorded.since}` : ''}): ${d.lastRecorded.verdict}_` : '';
      return { reply: `### Merge vs deploy\n\n${head}${last}`, sources: ['ops:drift', 'brain:facts'] };
    },
  },

  // FAILURE QUEUE — "nothing should fail ever, and if it does it shouldn't just end there". Every
  // failure is queued to disk AND mirrored into Chronos, so asking about it is a real lookup, not a
  // guess. The blocked/actionable split leads because it answers the only question that matters
  // next: is this mine to fix, or is Brandon holding it up?
  // BUILD GAPS — the chat naming its OWN shortcomings. Brandon: "seen command chat bot cant identify
  // its own shortcomings so that we can have better skill completion." The failure queue says what is
  // stuck; this says what is MISSING, ranked by how many real failures each gap would have converted,
  // which is the difference between reporting symptoms and specifying the next update.
  {
    id: 'build-gaps',
    match(message) {
      const t = lc(message);
      return /\bwhat (?:are you|do you) missing\b/.test(t)
        || /\byour (?:own )?(?:shortcomings|weaknesses|gaps|limitations)\b/.test(t)
        || /\bwhy do (?:your |my )?(?:builds|tasks) (?:keep )?fail/.test(t)
        || /\bcompletion rate\b/.test(t)
        || /\bwhat (?:would|do you) need to (?:succeed|finish|complete)\b/.test(t)
        || /\bbuild gaps\b/.test(t);
    },
    async run({ deps }) {
      const r = await deps.buildGaps();
      if (!r || !r.totalBuilds) throw new Unavailable('no build records to learn from');
      const lines = r.gaps.map((g, i) => `${i + 1}. **${g.missing}**\n   _${g.why}_\n   Would have converted **${g.count}** failure(s) — e.g. \`${g.examples.join('`, `')}\``);
      const top3 = r.gaps.slice(0, 3);
      const covered = top3.reduce((n, g) => n + g.count, 0);
      return {
        reply: [
          `### What I'm missing — from ${r.failed} real failures across ${r.totalBuilds} builds`,
          '',
          `**Completion rate: ${r.completionRate}%** (${r.succeeded} succeeded, ${r.failed} failed or refused).`,
          '',
          ...lines,
          '',
          top3.length ? `**If you build only three:** the top three account for **${covered} of ${r.failed}** failures, and none of them need a better model.` : '',
          r.unclassified.length ? `\n_${r.unclassified.length} failure(s) I could not classify — a gap I have not learned to see yet: \`${r.unclassified.map((u) => u.id).join('`, `')}\`._` : '',
        ].filter(Boolean).join('\n'),
        sources: ['builds:records', 'ops:build-gaps'],
      };
    },
  },

  {
    id: 'failure-queue',
    match(message) {
      const t = lc(message);
      return /\bfailure queue\b|\bpatch queue\b/.test(t)
        || /\bwhat (?:failed|is failing|has failed|broke)\b/.test(t)
        || /\bwhat'?s stuck\b|\bwhat is stuck\b/.test(t)
        || /\b(?:show|list) (?:me )?(?:the )?(?:open )?failures\b/.test(t)
        || /\bany (?:failed|failing) (?:tasks?|builds?)\b/.test(t);
    },
    async run({ deps }) {
      const q = await deps.opsFailures();
      if (!q) throw new Unavailable('failure queue unavailable');
      if (!q.openCount) {
        return { reply: `✅ **Nothing is in the failure queue.**${q.resolved ? ` ${q.resolved} failure(s) have been recorded and resolved.` : ''}\n\n_Every build failure is queued to \`data/failures/\` and mirrored into Chronos, so this is a real lookup — not an absence of logging._`, sources: ['ops:failures'] };
      }
      const line = (f) => `- **${f.id}**${f.repo ? ` (${f.repo})` : ''} — ${f.reason}${f.at ? `\n  _${String(f.at).slice(0, 16).replace('T', ' ')}_` : ''}`;
      const blocked = q.open.filter((f) => f.blocked);
      const mine = q.open.filter((f) => !f.blocked);
      const parts = [`### Failure queue — ${q.openCount} open`];
      if (mine.length) parts.push('', `**${mine.length} actionable (ours to fix):**`, ...mine.slice(0, 8).map(line));
      if (blocked.length) parts.push('', `**${blocked.length} blocked on you** — retrying these just fails again:`, ...blocked.slice(0, 8).map(line));
      parts.push('', `_${q.resolved} resolved so far. Full queue: \`node scripts/ops.mjs failures\`._`);
      return { reply: parts.join('\n'), sources: ['ops:failures', 'brain:facts'] };
    },
  },

  {
    id: 'export-logs',
    match(message) {
      const t = lc(message);
      return /\bexport (?:all )?(?:the )?logs\b|\bbundle (?:the )?logs\b|\bcollect (?:the )?logs\b|\blogs? for debugging\b|\bexport-all-logs\b/.test(t);
    },
    async run({ deps }) {
      const r = await deps.exportLogs();
      if (!r?.dir) throw new Unavailable('log export unavailable');
      return {
        reply: `### Log bundle exported\n\n\`${r.dir}\`\n\n${(r.files || []).map((f) => `- \`${f}\``).join('\n')}\n\n_Sections that could not be fetched say so inside their file — a partial bundle names its gaps._`,
        sources: ['ops:export-logs'],
      };
    },
  },

  {
    id: 'search-everything',
    match(message) {
      const t = String(message || '');
      const m = /^\s*(?:search|find)\s+(?:code and facts|everything|all)\s+(?:for\s+)?(.{2,80})$/i.exec(t)
        || /\bwhere is\s+(.{3,60}?)\s+(?:defined|implemented)\??\s*$/i.exec(t);
      return m ? { query: m[1].replace(/[?.!\s]+$/, '').trim() } : null;
    },
    async run({ deps, m }) {
      const r = await deps.searchAll({ query: m.query, limit: 12 });
      if (r?.error) throw new Unavailable(r.error);
      const code = (r.code || []).slice(0, 12).map((c) => `- \`${c.repo}:${c.file}:${c.line}\` ${String(c.text).slice(0, 90)}`);
      const facts = (r.facts || []).slice(0, 5).map((f) => `- **${f.subject}** · ${f.predicate}: ${String(f.object).slice(0, 120)}`);
      if (!code.length && !facts.length) {
        return { reply: `**No code or brain hits for “${m.query}”** across both repos and the vault${r.errors ? ` (note: ${r.errors.map((e) => `${e.repo}: ${e.error}`).join('; ')})` : ''}.`, sources: ['ops:search'] };
      }
      const parts = [`### Search: “${m.query}”`];
      if (code.length) parts.push('', '**Code (git grep, both repos):**', ...code);
      if (facts.length) parts.push('', '**Brain facts:**', ...facts);
      if (r.errors) parts.push('', `_Partial: ${r.errors.map((e) => `${e.repo} — ${e.error}`).join('; ')}_`);
      return { reply: parts.join('\n'), sources: ['ops:search', 'brain:facts'] };
    },
  },

  // SELF DIAGNOSIS — the same full health report Settings uses: connection probes, local repos,
  // runtime/task/build state, Brain, and actionable repair instructions.
  {
    id: 'self-diagnosis',
    match(message) {
      const t = lc(message);
      return /\bself[- ]?diagnos/.test(t)
        || /\bdiagnos(e|tic|tics) (yourself|seen command|the app|the system)\b/.test(t)
        || /\b(api|connector|connection|credential)s?\b.*\b(health|status|working|broken|missing|fix)/.test(t)
        || /\bwhat (api|connector|connection|credential)s? (need|needs) fixing\b/.test(t)
        || /\bsettings (health|diagnostics?)\b/.test(t)
        || /\bwhy (are you|is the board room) blind\b/.test(t);
    },
    async run({ deps }) {
      const snapshot = await deps.platformStatus();
      const h = snapshot?.health;
      if (!h?.checks) throw new Unavailable('platform diagnostics unavailable');
      const attention = h.checks.filter((c) => c.status !== 'healthy');
      const healthy = h.checks.filter((c) => c.status === 'healthy');
      const icon = { broken: '🔴', degraded: '🟠', missing: '⚪' };
      const lines = attention.map((c) => `- ${icon[c.status] || '·'} **${c.label} — ${c.status}:** ${c.detail}${c.fix ? `\n  **Fix:** ${c.fix}` : ''}`);
      return {
        reply: `### Seen Command self-diagnosis\n\n**${h.overall === 'healthy' ? 'Healthy' : 'Needs attention'} — ${h.counts.broken} broken · ${h.counts.degraded} degraded · ${h.counts.missing} missing · ${healthy.length} healthy.**\n\n${lines.length ? lines.join('\n') : '✅ Every checked connection and runtime source is healthy.'}\n\n_${snapshot.at ? `Probed live at ${snapshot.at}. ` : ''}This report contains status only—never stored secret values._`,
        sources: [...new Set(h.checks.map((c) => c.source).filter(Boolean))],
      };
    },
  },

  // PLATFORM OVERVIEW — one live map across runtime, tasks, builds, approvals, repos, Brain, and health.
  {
    id: 'platform-overview',
    match(message) {
      const t = lc(message);
      return /\b(full|whole|complete) platform (overview|status|snapshot|state)\b/.test(t)
        || /\bwhat can you (see|access) (right now|live)?\b/.test(t)
        || /\bwhat'?s going on (across|with) (everything|the platform|seen command)\b/.test(t)
        || /\bshow (me )?(everything|the whole platform)\b/.test(t);
    },
    async run({ deps }) {
      const s = await deps.platformStatus();
      if (!s?.health) throw new Unavailable('platform snapshot unavailable');
      const active = (s.builds?.recent || []).filter((b) => ['queued', 'building'].includes(b.status));
      const attention = s.health.checks.filter((c) => c.status !== 'healthy').slice(0, 5);
      const tasks = (s.tasks?.recent || []).slice(0, 5).map((t) => `#${t.number} ${t.title}`).join(' · ') || 'none';
      return {
        reply: `### Live platform overview\n\n- **Runtime:** ${s.state?.runId || 'no meeting yet'} · focus ${s.state?.focusId || 'unknown'} · ${s.state?.pendingApprovals || 0} pending approvals\n- **Tasks:** ${s.tasks?.openCount ?? '?'} open — ${tasks}\n- **Builds:** ${active.length} in flight · ${(s.builds?.recent || []).length} recent records visible\n- **Activity:** ${s.activity?.count ?? 0} events visible from the last two days\n- **Brain:** ${s.brain?.available ? `${s.brain.factCount} current facts` : 'unavailable'}\n- **Local checkouts:** Seen Command ${s.repos?.commandRepo?.branch || 'unavailable'}@${s.repos?.commandRepo?.sha || '?'} · product ${s.repos?.productRepo?.branch || 'unavailable'}@${s.repos?.productRepo?.sha || '?'}\n- **System health:** ${s.health.overall}${attention.length ? ` — ${attention.map((c) => `${c.label}: ${c.status}`).join(' · ')}` : ' — all checked sources healthy'}\n\n_This is a fresh cross-source snapshot, not a Brain-only answer. Ask about a task/PR/build or say “diagnose yourself” to drill in._`,
        sources: ['platform:live', 'state:runtime', 'github-tasks', 'local-builds', 'local-git', 'brain'],
      };
    },
  },

  // 3) WHAT'S FAILING — failing CI, bad deploys, error counts, from signals().
  {
    id: 'whats-failing',
    match(message) {
      const t = lc(message);
      return /\b(failing|broken|red|down)\b/.test(t)
        || /\bany (errors?|issues|problems)\b/.test(t)
        || /\bis anything (broken|down|failing|wrong)\b/.test(t)
        || /\bwhat (needs attention|is wrong|is broken|is failing)\b/.test(t)
        || /\bwhat'?s (red|down|broken|failing|wrong)\b/.test(t)
        || /\bneeds attention\b/.test(t);
    },
    async run({ deps, message }) {
      const sig = await deps.signals();
      const gh = sig?.github;
      const vc = sig?.vercel;
      const admin = sig?.admin;

      // If NONE of the sources are reachable, fall through to the LLM.
      const reachable = [gh, vc, admin].some((v) => v && !isNotConfigured(v) && !isErrored(v));
      if (!reachable) throw new Unavailable('no signal sources reachable');

      const problems = [];
      const sources = [];

      if (gh && !isNotConfigured(gh) && !isErrored(gh)) {
        sources.push('gh:ci');
        const ci = gh.ci || {};
        if (ci.state === 'failing') {
          const names = failingRuns(ci).map((r) => r.name);
          problems.push(`🔴 CI failing on \`${gh.repo || 'repo'}\`${names.length ? `: ${names.join(', ')}` : ''}`);
        }
      }
      if (vc && !isNotConfigured(vc) && !isErrored(vc)) {
        sources.push('vercel:deploy');
        const d = vc.deployment || {};
        if (lc(d.state) === 'error') problems.push(`🔴 Latest Vercel deploy is **ERROR**${d.url ? ` (${d.url})` : ''}`);
      }
      if (admin && !isNotConfigured(admin) && !isErrored(admin)) {
        const errs = admin.errors || {};
        if ((errs.today ?? 0) > 0) { sources.push('admin:errors'); problems.push(`🟠 ${errs.today} error${errs.today === 1 ? '' : 's'} logged today${errs.thisWeek ? ` (${errs.thisWeek} this week)` : ''}`); }
        if (admin.jobs?.crisis) { sources.push('admin:jobs'); problems.push('🟠 Job-health **crisis** flag is set'); }
      }

      // Broad "what is broken" asks include the unified Settings/self-diagnostic map too, so the
      // hero shortcut cannot say green while (for example) Supabase advisors are returning 401.
      if (/\b(broken|failing|wrong|needs attention|red|down)\b/i.test(message)) {
        try {
          const platform = await deps.platformStatus();
          const bad = (platform?.health?.checks || []).filter((c) => c.status === 'broken' || c.status === 'degraded');
          for (const c of bad) {
            problems.push(`${c.status === 'broken' ? '🔴' : '🟠'} ${c.label}: ${c.detail}${c.fix ? ` — **Fix:** ${c.fix}` : ''}`);
            if (c.source) sources.push(c.source);
          }
        } catch { /* live CI/deploy/admin checks above remain useful */ }
      }

      if (!problems.length) {
        return { reply: '✅ **Nothing failing** — CI, deploy, and error counts are all clean right now.', sources: sources.length ? sources : ['gh:ci'] };
      }
      return {
        reply: ['### What needs attention', '', ...problems.map((p) => `- ${p}`)].join('\n'),
        sources: [...new Set(sources)],
      };
    },
  },

  // FORGE STATUS — is the owned coding engine ready? (models served, engines present, lessons learned)
  {
    id: 'forge-status',
    match(message) {
      const t = lc(message);
      return /\bforge\b/.test(t)
        || /\b(owned|coding|local) engine\b/.test(t)
        || (/\b(local )?(models?|engines?)\b/.test(t) && /\b(status|ready|served|available|running|health)\b/.test(t))
        || /\bwhat models? (are|do we have)\b/.test(t);
    },
    async run({ deps }) {
      let served = [];
      try { served = [...(await deps.servedTags())]; } catch { /* Ollama down — still report the rest */ }
      let clineReady = false; let clineModel = '';
      try { clineReady = existsSync(deps.clineBin()); clineModel = deps.clineSel()?.model || ''; } catch { /* absent */ }
      let lessons = 0;
      try { lessons = (deps.readBrainFacts() || []).filter((f) => lc(f.subject) === 'forge lessons').length; } catch { /* no vault */ }
      const forgeOn = process.env.CODER_FORGE !== '0';
      const lines = [
        `- **Forge (owned engine):** ${forgeOn ? 'ON — leads feature-shaped builds' : 'OFF (CODER_FORGE=0)'}`,
        `- **Local models served:** ${served.length ? served.join(', ') : '⚠️ none — is Ollama running?'}`,
        `- **Cline:** ${clineReady ? `installed${clineModel ? ` (${clineModel})` : ''}` : 'not installed'}`,
        `- **Lessons learned:** ${lessons} (every failed/successful build teaches the next one)`,
        '- **Paid API:** unreachable by default — free lanes only',
      ];
      return { reply: `### Owned coding engine\n\n${lines.join('\n')}\n\n_Every build: plan → best-of-N verified candidates → full gate (tests + real production build) → PR only on green._`, sources: ['forge:status'] };
    },
  },

  // BRAIN KNOWLEDGE — "what do we know about X" from the shared vault, cited, zero hallucination.
  {
    id: 'brain-know',
    match(message) {
      const t = lc(message);
      const m = t.match(/\bwhat do (?:we|you) know about (.{2,60})[?.!]?$/)
        || t.match(/\bdo we know (?:anything )?about (.{2,60})[?.!]?$/)
        || t.match(/\bwhat does the (?:brain|vault|memory) (?:say|know|have) (?:about|on) (.{2,60})[?.!]?$/)
        || t.match(/\bsearch the (?:brain|vault|memory) for (.{2,60})[?.!]?$/);
      return m ? { topic: m[1].replace(/[?.!\s]+$/, '').trim() } : null;
    },
    async run({ deps, m }) {
      let facts;
      try { facts = deps.readBrainFacts() || []; } catch { throw new Unavailable('brain unavailable'); }
      if (!facts.length) return { reply: `**The brain has no recorded facts yet** — nothing to search for “${m.topic}”.`, sources: ['brain:facts'] };
      const hits = deps.rankFacts(facts, m.topic, 8) || [];
      if (!hits.length) return { reply: `**Nothing recorded about “${m.topic}”** in the brain. If it matters, tell me and I'll remember it via the vault.`, sources: ['brain:facts'] };
      const lines = hits.map((f) => `- **${f.subject}** · ${f.predicate}: ${String(f.object).slice(0, 160)}${f.valid_from ? ` _(since ${String(f.valid_from).slice(0, 10)})_` : ''}`);
      return { reply: `### What the brain knows about “${m.topic}”\n\n${lines.join('\n')}\n\n_${facts.length} facts total in the vault — these are the top matches._`, sources: ['brain:facts'] };
    },
  },



  // CREATOR LIBRARY — researched creators, a creator's ranked insights, and "what <hooks|formats|…>
  // work?" answered from the cross-creator insight engine with citations (declines when it has none).
  {
    id: 'creators',
    match(message) {
      const t = lc(message);
      const named = t.match(/\bkey ?points? (?:for|from|on) @?([\w.-]{2,40})\b/)
        || t.match(/\bwhat did we learn from @?([\w.-]{2,40})\b/);
      if (named) return { project: named[1] };
      if (/\b(what|which)\b.*\b(hooks?|formats?|topics?|pain ?points?|audience pains?|posting cadence|ctas?)\b/.test(t)
        && /\b(work|works|working|use|uses|creators?|content|reels?|videos?|job[- ]?seekers?|audience|posts?)\b/.test(t)) return { question: message };
      return /\bcreator (library|intelligence|insights?)\b/.test(t)
        || /\b(researched|which) creators?\b/.test(t)
        || /\binstagram (library|research(ed)?|creators?)\b/.test(t)
        ? { list: true } : null;
    },
    async run({ deps, m }) {
      if (m.question) { // topical: answer only from evidence; nothing relevant → decline (the model answers)
        let lib; try { lib = await deps.creatorInsights(); } catch { return null; }
        const reply = await deps.answerCreatorQuestion(lib, m.question);
        return reply ? { reply, sources: ['ig:insights'] } : null;
      }
      let projects;
      try { projects = await deps.igProjects(); } catch { throw new Unavailable('creator library unavailable'); }
      if (!Array.isArray(projects) || !projects.length) {
        return { reply: '**No researched creators yet.** Say `research instagram <username>` to start a pipeline (ingest → transcribe → evidence → validated knowledge).', sources: ['ig:library'] };
      }
      if (m.list) {
        const lines = projects.slice(0, 10).map((p) => {
          const c = p.counts || {};
          return `- **@${p.username || p.name}** — ${c.videos || 0} videos · ${c.knowledge || 0} knowledge · ${c.evidence || 0} evidence`;
        });
        return { reply: `### Creator Library\n\n${lines.join('\n')}\n\n_Ask “key points from <name>” for one creator, “what hooks work for job-seeker content?” for the cross-creator view, or open the Creator Library tab._`, sources: ['ig:library'] };
      }
      const proj = projects.find((p) => lc(p.name) === lc(m.project) || lc(p.username || '') === lc(m.project));
      if (!proj) {
        return { reply: `**@${m.project} isn’t in the library.** Researched: ${projects.map((p) => `@${p.username || p.name}`).join(', ')}.`, sources: ['ig:library'] };
      }
      let ins = null; try { ins = await deps.creatorInsights(proj.name); } catch { /* unreadable → honest reply below */ }
      const top = (ins?.insights || []).filter((i) => i.strength !== 'anecdotal').slice(0, 6);
      if (!top.length) {
        return { reply: `**@${m.project}** is researched (${proj.counts?.knowledge || 0} knowledge records) but nothing repeats across enough of its videos to rank yet — open **Creator Library** for its videos and knowledge.`, sources: ['ig:library'] };
      }
      const lines = top.map((i) => `- **[${i.strength} · ${i.basis}] ${String(i.claim).slice(0, 120)}** — ${i.support.videos} video${i.support.videos === 1 ? '' : 's'}${i.citations?.[0] ? ` · e.g. ${i.citations[0].at || ''} “${String(i.citations[0].excerpt || '').slice(0, 80)}”` : ''}`);
      return { reply: `### What @${m.project}'s videos show\n\n${lines.join('\n')}\n\n_One creator alone never rates above “emerging” — the cross-creator view is in Creator Library → Insights._`, sources: [`ig:${proj.name}:insights`] };
    },
  },

  // KPI QUICK — one-number answers ("how many users?") straight from the KPI tiles.
  {
    id: 'kpi-quick',
    match(message) {
      const t = lc(message);
      const m = t.match(/\bhow many (users|signups|jobs|companies|paid users)\b/)
        || (/\b(mrr|revenue|sales)\b/.test(t) && /\b(what|how much|current)\b/.test(t) ? ['', 'revenue'] : null)
        || (/\berrors? today\b/.test(t) ? ['', 'errors'] : null);
      return m ? { metric: m[1] } : null;
    },
    async run({ state, deps, m }) {
      const tiles = state?.debrief?.kpis || [];
      const want = lc(m.metric);
      const alias = { users: ['users', 'total users', 'users_total'], signups: ['signups', 'users'], jobs: ['jobs', 'active jobs'], companies: ['companies'], 'paid users': ['paid', 'paying', 'paid users'], revenue: ['revenue', 'mrr'], errors: ['errors'] };
      const keys = alias[want] || [want];
      const hit = tiles.find((k) => keys.some((a) => lc(k.label).includes(a)));
      if (hit) return { reply: `**${hit.label}: ${hit.value}**${state?.runId ? `\n\n_As of the last board meeting (\`${state.runId}\`). Say “run a board meeting” for fresh numbers._` : ''}`, sources: ['state:kpis'] };
      // No tile → try live admin stats before giving up.
      let a;
      try { a = requireReachable(await deps.adminSnapshot(), 'admin-stats'); } catch { throw new Unavailable('admin stats unavailable'); }
      const flat = JSON.stringify(a).slice(0, 400);
      return { reply: `I don't have a “${m.metric}” tile from the last meeting, but live admin stats say:\n\n\`\`\`\n${flat}\n\`\`\``, sources: ['admin:stats'] };
    },
  },

  // 4) BUSINESS SUMMARY — a compact KPI readout from admin-stats (+ any state.debrief.kpis).
  {
    id: 'business-summary',
    match(message) {
      const t = lc(message);
      return /\bsummar(ize|y).*business\b/.test(t)
        || /\bstate of the business\b/.test(t)
        || /\bhow are we doing\b/.test(t)
        || /\bhow'?s (the )?business\b/.test(t)
        || /\bthe (numbers|metrics|kpis?)\b/.test(t)
        || /\b(business|company) (summary|overview|health)\b/.test(t);
    },
    async run({ state, deps }) {
      let a;
      try { a = requireReachable(await deps.adminSnapshot(), 'admin-stats'); }
      catch (e) {
        // Fall back to a cached KPI snapshot on the run state if the live connector is down.
        const kpis = state?.debrief?.kpis;
        if (kpis && Object.keys(kpis).length) {
          const lines = Object.entries(kpis).map(([k, v]) => `- **${k}:** ${v}`);
          return { reply: ['### Business snapshot (cached)', '', ...lines].join('\n'), sources: ['vault:debrief'] };
        }
        throw e instanceof Unavailable ? e : new Unavailable('admin-stats unavailable');
      }

      const u = a.users || {}; const r = a.revenue || {}; const j = a.jobs || {}; const e = a.errors || {};
      const lines = [
        `- **Users:** ${u.total ?? 0} total · ${u.newToday ?? 0} new today · ${u.dau ?? 0} DAU`,
        // Seen sells one-time products (e.g. Interview Prep, Job Search Pass) — revenue is the last 30 days.
        r.month == null ? `- **Revenue:** unknown — Seen's revenue funnel did not answer${r.funnelError ? ` (${r.funnelError})` : ''}`
          : `- **Revenue:** $${r.month} in the last 30 days, one-time · ${r.payingCustomers ?? 0} paying (${r.prepPurchases ?? 0} Interview Prep, ${r.passPurchases ?? 0} Job Search Pass)${r.interviews != null ? ` · ${r.interviews} tracked applications at an interview` : ''}`,
        `- **Jobs:** ${j.active ?? 0} active · ${j.stale ?? 0} stale${j.crisis ? ' · ⚠️ crisis' : ''}`,
        `- **Errors:** ${e.today ?? 0} today · ${e.thisWeek ?? 0} this week`,
      ];
      return { reply: ['### Business snapshot', '', ...lines].join('\n'), sources: ['admin:stats'] };
    },
  },

  // 5) DEPLOY STATUS — is prod up? Latest Vercel deployment state + URL.
  {
    id: 'deploy-status',
    match(message) {
      const t = lc(message);
      return /\bis prod(uction)? (up|live)\b/.test(t)
        || /\bdeploy(ment)? status\b/.test(t)
        || /\bdid it deploy\b/.test(t)
        || /\bis the site (live|up)\b/.test(t)
        || /\blatest deploy(ment)?\b/.test(t)
        || /\b(is )?prod up\b/.test(t);
    },
    async run({ deps }) {
      const d = await deps.vercelState();
      if (isNotConfigured(d) || isErrored(d)) throw new Unavailable('vercel unavailable');
      if (d?.none) return { reply: 'No deployments found on the Vercel project yet.', sources: ['vercel:deploy'] };

      const state = String(d.state || 'unknown').toUpperCase();
      const url = d.url ? `https://${d.url}` : null;
      let head;
      if (state === 'READY') head = '✅ **Production is live** (latest deploy READY).';
      else if (state === 'BUILDING' || state === 'QUEUED') head = `⏳ **Deploy in progress** (${state}).`;
      else if (state === 'ERROR') head = '⚠️ **Latest deploy errored** — prod may be on the previous build.';
      else if (state === 'CANCELED') head = '⚠️ **Latest deploy was canceled.**';
      else head = `Deploy state: **${state}**.`;

      const lines = [head];
      if (url) lines.push('', `Production URL: ${url}`);
      if (d.sha) lines.push(`Commit: \`${d.sha}\``);
      return { reply: lines.join('\n'), sources: ['vercel:deploy'] };
    },
  },

  // CAPABILITIES — what can you do? DERIVED from the live roster (SKILL_CATALOG + WIRED_ACTIONS +
  // the ops CLI's own usage block), so it can never again claim less than what is actually wired.
  {
    id: 'capabilities',
    match(message) {
      const t = lc(message);
      return /\bwhat can you do\b/.test(t)
        || /\bwhat are you\b/.test(t)
        || /\bwhat do you do\b/.test(t)
        || /\bhow do you work\b/.test(t)
        || /\b(?:explain|show me) (?:how )?you work\b/.test(t)
        || /\bwhat (?:skills|abilities|commands|tools) (?:do you have|are (?:there|available))\b/.test(t)
        || /\b(?:list|show) (?:me )?(?:your|the) (?:skills|abilities|commands|capabilities|tools)\b/.test(t)
        || /\bwhat are your (?:skills|abilities|capabilities)\b/.test(t)
        || /\bhelp\b/.test(t);
    },
    async run({ deps }) {
      // The roster is the SKILLS array itself — an id with no catalog entry still appears, so a new
      // skill can never be silently omitted from this answer.
      const skills = SKILL_IDS.map((id) => ({ id, ...(SKILL_CATALOG[id] || { what: '(no description registered)', ask: id }) }))
        .filter((s) => !['capabilities', 'can-i'].includes(s.id));
      let ops = [];
      try {
        const usage = await deps.opsUsage();
        ops = Object.entries(usage?.commands || {}).map(([cmd, what]) => `- \`${cmd.split(' ')[0]}\` — ${what}`);
      } catch { /* the ops CLI is optional context, not required for this answer */ }
      return {
        reply: [
          '### What I can actually do',
          '',
          "I'm Seen Command — your agentic exec OS, not a generic chatbot. This list is generated from what is really wired right now, so it can't go stale.",
          '',
          `**${skills.length} instant owned skills** ($0, real data, no external model):`,
          ...skills.map((s) => `- **${s.id}** — ${s.what} · _“${s.ask}”_`),
          '',
          `**${WIRED_ACTIONS.length} things I really DO on command** (these execute — they are not descriptions):`,
          ...WIRED_ACTIONS.map(([phrase, what]) => `- **“${phrase}”** — ${what}`),
          ...(ops.length ? ['', `**The ops master-kit** — ${ops.length} deterministic read-only commands I can run myself (\`node scripts/ops.mjs <cmd>\`):`, ...ops] : []),
          '',
          '_Anything not on this list routes to the full agent. Ask **“can you <x>?”** for a straight yes/no on one ability._',
        ].join('\n'),
        sources: ['owned:roster', 'ops:usage'],
      };
    },
  },
  // CAN I? — a straight yes/no about ONE specific ability, answered from the live roster. Brandon
  // asked the chat to confirm skills it had just been given and it could not, which is worse than a
  // missing feature: it makes him distrust the ones that DO work. Deliberately conservative — if the
  // question doesn't clearly match a wired ability it declines and lets the model answer, so a
  // knowledge question ("can you explain RLS?") is never mistaken for a capability question.
  {
    id: 'can-i',
    match(message) {
      const t = String(message || '').trim();
      const m = /\b(?:can|could)\s+you\s+(.{3,70}?)\s*\??$/i.exec(t)
        || /\bare\s+you\s+able\s+to\s+(.{3,70}?)\s*\??$/i.exec(t)
        || /\bdo\s+you\s+(?:have|support|know how to)\s+(.{3,70}?)\s*\??$/i.exec(t);
      return m ? { phrase: m[1].trim() } : null;
    },
    async run({ m }) {
      // Question words and filler carry no capability signal — without them, "can you explain how X
      // works" scored a hit purely on "how" (which appears in a skill's example question).
      const STOP = new Set(['the', 'for', 'you', 'can', 'and', 'with', 'any', 'all', 'get', 'see', 'tell',
        'show', 'give', 'what', 'does', 'have', 'able', 'about', 'from', 'this', 'that', 'your', 'our',
        'run', 'are', 'how', 'why', 'when', 'where', 'who', 'which', 'explain', 'work', 'works', 'thing',
        'things', 'something', 'anything', 'please', 'help', 'me']);
      const toks = [...new Set(lc(m.phrase).match(/[a-z0-9_]{3,}/g) || [])].filter((w) => !STOP.has(w));
      if (!toks.length) return null;
      // WHOLE-WORD matching, never substring: `hay.includes(tok)` let "how" match inside "show".
      // And the TRIGGER text (the id and the example phrasing) is weighted above the descriptive
      // prose, because an incidental word buried in a description is not evidence of an ability —
      // "write" appearing inside "read-after-write" once answered "can you write me a poem" with yes.
      const words = (s) => new Set(lc(s).match(/[a-z0-9_]+/g) || []);
      const score = (trigger, prose) => {
        const wt = words(trigger); const wp = words(prose);
        return toks.reduce((n, t) => n + (wt.has(t) ? 2 : wp.has(t) ? 1 : 0), 0);
      };
      const scored = Object.entries(SKILL_CATALOG)
        .map(([id, c]) => ({ id, c, s: score(`${id.replace(/-/g, ' ')} ${c.ask}`, c.what) }))
        .sort((a, b) => b.s - a.s);
      const actions = WIRED_ACTIONS.map(([phrase, what]) => ({ phrase, what, s: score(phrase, what) }))
        .sort((a, b) => b.s - a.s);
      const best = scored[0]; const bestAction = actions[0];
      // Needs a trigger-level hit (2) — a lone prose brush (1) is not enough to claim an ability.
      if ((best?.s || 0) < 2 && (bestAction?.s || 0) < 2) return null; // let the model answer instead
      if ((bestAction?.s || 0) > (best?.s || 0)) {
        return { reply: `**Yes.** Say **“${bestAction.phrase}”** and I ${bestAction.what} — that really executes, it isn't a description.`, sources: ['owned:roster'] };
      }
      const also = scored.filter((x) => x.s > 0 && x.id !== best.id).slice(0, 2)
        .map((x) => `- **${x.id}** — ${x.c.what} · _“${x.c.ask}”_`);
      return {
        reply: [`**Yes — that's the \`${best.id}\` skill:** ${best.c.what}.`, '', `Ask it like this: _“${best.c.ask}”_`,
          ...(also.length ? ['', 'Related:', ...also] : []),
          '', '_Answered from my live skill roster, not a description — say the phrase and it runs._'].join('\n'),
        sources: ['owned:roster'],
      };
    },
  },

];

// Exported for tests / introspection.
export const SKILL_IDS = SKILLS.map((s) => s.id);

/**
 * answerOwned — try each owned skill in priority order; the first whose match() fires runs.
 *
 * @param {{ message?: string, state?: object, deps?: object }} [args]
 * @returns {Promise<{handled:false} | {handled:true, reply:string, skill:string, engine:string, sources:string[]}>}
 *   - reply: Markdown (rendered)
 *   - skill: the skill id (e.g. 'pr-safety')
 *   - engine: `owned:<skill>`
 *   - sources: short provenance strings (e.g. 'gh:begindtheseen/seen#249', 'vault:timeline')
 */
export async function answerOwned({ message, state, deps } = {}) {
  const text = String(message || '').trim();
  if (!text) return { handled: false };
  const d = { ...DEFAULT_DEPS, ...(deps || {}) };

  for (const skill of SKILLS) {
    let m;
    try { m = skill.match(text); } catch { m = null; }
    if (!m) continue;

    try {
      const out = await skill.run({ message: text, state, deps: d, m });
      // An EXPLICIT decline (null) means "this isn't mine after all" — keep trying the remaining
      // skills. Returning handled:false here instead let one loose matcher swallow a question the
      // next skill would have answered perfectly: `can-i` matched "what can you do?" (capturing the
      // fragment "do?"), declined, and silently killed the capabilities answer. A THROW is different
      // — it means a real data source is down, so that still falls straight through to the model.
      if (!out || !out.reply) continue;
      return {
        handled: true,
        reply: out.reply,
        skill: skill.id,
        engine: `owned:${skill.id}`,
        sources: Array.isArray(out.sources) ? out.sources : [],
      };
    } catch {
      // Unavailable data source OR any unexpected throw → graceful fallthrough to the LLM agent.
      return { handled: false };
    }
  }
  return { handled: false };
}

export default answerOwned;

// Compact, run-derived aggregation context for the streaming Board Room agent (no network probes).
export async function aggregationContext() {
  try {
    const { aggregationManager } = await import('./aggregation-manager.mjs');
    return aggregationContextFromRuns(aggregationManager().listRuns({ limit: 200 }));
  } catch { return ''; }
}
