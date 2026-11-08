// Policy — the safety layer for autonomous runs. The design question isn't "what can agents do,"
// it's "what may they do UNSUPERVISED at 3 AM." Everything splits by REVERSIBILITY:
//
//   • internal (safe to execute overnight): research, drafting, analyses, opening DRAFT PRs,
//     writing to the memory graph. Reversible / no outside blast radius → agents just do it.
//   • gated (wake-up-and-wait): anything OUTBOUND or IRREVERSIBLE — posting content, merging code,
//     charging via Stripe, emailing a human. These PARK at the approval gate until Brandon says yes.
//
// So a worker always EXECUTES its internal drafting; if that draft implies an irreversible act, it
// parks that specific act (not the drafting) for morning review. The morning debrief is the only
// deliverable that must be perfect — it's the entire interface to what happened overnight.

// The irreversible action a given worker output implies, or null if the output is fully internal.
const GATED_ACTION = {
  'reddit plan': 'Post to Reddit + reply in the thread',
  'social plan': 'Post to social',
  'intel brief': 'Publish the Ghost Report',
  'bugfix PR': 'Merge the bugfix PR to next-migration',
  'feature PR': 'Green-light the build / merge the feature PR',
  'migration draft': 'Apply the Supabase migration to prod',
  'funnel experiment': 'Launch the live A/B experiment',
  'pricing proposal': 'Apply the pricing change',
  'sales draft': 'Send the outreach emails',
  'dunning action': 'Act on failed payments and refunds (emails, no charges)',
  'platform PR': 'Merge the Seen Command self-improvement PR',
  // fully internal (no gate): research memo, review verdict, health report, cost alert,
  // perf proposal, kpi pack, retention read, bottleneck finding.
};

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { explicitFileTargets } from './task-premise.mjs';
export function gatedActionFor(outputType) {
  return GATED_ACTION[outputType] || null;
}

// Which gated actions are ENGINEERING work the builder can actually pick up. Approving one of these
// doesn't just file an issue — it kicks the test-gated builder (engine/builder.mjs) in the background
// to write the code, run the gate, and open a PR. Everything else stays a filed task.
//   • 'platform PR'  → the TOOL repo (Seen Command self-improvement) — safe fixes may auto-merge.
//   • 'bugfix PR'    → the PRODUCT repo (seen) — always PR-only (merging there deploys prod).
//   • 'feature PR'   → the PRODUCT repo (seen) — always PR-only.
// 'migration draft' is deliberately NOT here: schema/RLS changes to prod stay a human call (issue only).
const BUILD_TARGET = {
  'platform PR': 'tool',
  'bugfix PR': 'product',
  'feature PR': 'product',
};

// The repo the builder should target for an approved action's output kind, or null if this action is
// not autonomous-buildable (stays a filed task). 'tool' = Seen Command's own repo, 'product' = seen.
export function buildTargetFor(outputType) {
  return BUILD_TARGET[outputType] || null;
}

// Subject-aware routing signals (#115/#117). A filed task can carry a gate line or a [product] tag
// that points at the PRODUCT repo while actually being about Seen Command ITSELF — its own docs,
// tests, or engine code. #115 ("Update Seen Command documentation", gate "Merge the bugfix PR…") is
// the canonical break: the gate line routed it to the product repo, where the coder could only stub
// and the reviewer (correctly) rejected. So before trusting the gate line, check the SUBJECT.
//
//   • TOOL_WORK  — verbs/nouns for working on Seen Command itself (docs, tests, refactor, lint, gate,
//     self-update, board meeting). Only counts when it co-occurs with a self-reference (TOOL_SELF) in
//     the task's real subject — never the filing boilerplate, which is stripped first.
//   • TOOL_PATH  — a path in THIS repo's conventions (engine//org//lib/ .mjs, docs/, HANDOFF, CLAUDE).
//     A concrete tool-repo path is itself proof; it needs no self-reference.
//   • STRONG_PRODUCT — the VETO. seenjobs / the site / employers / the jobs data. When present, the
//     words are about the PRODUCT even if "Seen Command" is name-dropped, so we never flip to tool.
const TOOL_WORK = /\b(?:document(?:ation|ed|s)?|docs?|test(?:s|ing)?|readme|refactor\w*|lint\w*|gate|self[- ]?updat\w*|board meetings?|exec os)\b/i;
const TOOL_SELF = /\bseen command\b|\bexec os\b/i;
const TOOL_PATH = /\b(?:engine|org|lib)\/[\w./-]*\.mjs\b|\bdocs\/[\w./-]+|\bHANDOFF(?:\.md)?\b|\bCLAUDE(?:\.md)?\b/;
const STRONG_PRODUCT = /\bseenjobs\b|\bthe (site|website|product)\b|\bemployers?\b|\bjobs? table\b|\badmin (page|site|dashboard)\b|\bjob (board|page|listing)|\bonboard\w*|\btutorials?\b|\bsign[- ]?ups?\b|\buser (adoption|experience|retention|acquisition)\b|\bnew users\b|\bstale (jobs?|listings?)\b|\bjob (status(es)?|refresh(es|ing)?|listings?|data)\b/i;

// Infer the build target repo for a FILED task (GitHub issue) being started by hand. Filed issues
// record their gate line verbatim ("**Gate:** Merge the bugfix PR to next-migration"), so map that
// text back through GATED_ACTION → BUILD_TARGET; otherwise go by which codebase the words point at.
// Defaults to 'tool' — a manual task-build is always PR-only, so the wrong guess costs one draft PR.
// A concrete path that EXISTS in exactly one of the two repos settles the question — no keyword can
// outvote a fact. Live on 2026-09-21: a task naming `brain/lib/memory-read.mjs` (a tool-repo path) was
// routed to the PRODUCT repo by the filed issue's `**Gate:**` line, then refused as outside that repo's
// writable paths. Existence in both repos, or in neither, decides nothing and falls through to the wording.
export function repoOfNamedPaths(text, { toolRoot = null, productRoot = null, exists = existsSync } = {}) {
  if (!toolRoot && !productRoot) return null;
  let tool = 0; let product = 0;
  for (const rel of explicitFileTargets(text)) {
    const inTool = !!toolRoot && exists(join(toolRoot, rel));
    const inProduct = !!productRoot && exists(join(productRoot, rel));
    if (inTool && !inProduct) tool++;
    else if (inProduct && !inTool) product++;
  }
  if (tool && !product) return 'tool';
  if (product && !tool) return 'product';
  return null;
}

export function buildTargetForTask(text, roots = null) {
  const t = String(text || '');
  const named = roots ? repoOfNamedPaths(t, roots) : null;
  if (named) return named;
  // TOOL-subject override — runs BEFORE the gate line so a task about Seen Command itself wins over a
  // mislabeled gate/[product] tag (the #115/#117 root cause). Strip the filing boilerplate first: the
  // "Proposed by"/"Gate" lines and the "Filed by Seen Command…" footer are on EVERY issue (see
  // engine/run.mjs), so leaving them in would make every task read as "about Seen Command". What
  // remains is the real title + description.
  const subject = t
    .replace(/^\s*\*\*Proposed by:\*\*.*$/gim, '')
    .replace(/^\s*\*\*Gate:\*\*.*$/gim, '')
    .replace(/Filed by Seen Command\b.*/gi, '')
    .replace(/^\s*-{3,}\s*$/gm, '');
  // Precision-first: fire only on a STRONG tool signal (a repo path, or a tool-work word paired with a
  // self-reference) AND only when NO strong product signal is present. A tool task that name-drops the
  // product just loses the override and costs one draft PR — never a wrong repo for a real product task.
  const toolSignal = TOOL_PATH.test(subject) || (TOOL_WORK.test(subject) && TOOL_SELF.test(subject));
  if (toolSignal && !STRONG_PRODUCT.test(subject)) return 'tool';

  for (const [kind, target] of Object.entries(BUILD_TARGET)) {
    if (t.includes(GATED_ACTION[kind])) return target;
  }
  // User-facing words mean the PRODUCT: "onboarding" built in the board-meeting engine (#74) could
  // only ever produce prose edits, not the feature. A wrong guess costs one draft PR — bias product
  // for anything about the people who USE Seen.
  if (/\bseenjobs\b|\bthe (site|website|product)\b|\badmin (page|site|dashboard)\b|\bjob (board|page|listing)|\bonboard\w*|\btutorials?\b|\bsign[- ]?ups?\b|\buser (adoption|experience|retention|acquisition)\b|\bnew users\b|\bstale (jobs?|listings?)\b|\bjob (status(es)?|refresh(es|ing)?|listings?|data)\b/i.test(t)) return 'product';
  return 'tool';
}

// True if approving this action should start a background build rather than only filing a task.
export function isEngineering(outputType) {
  return !!BUILD_TARGET[outputType];
}

// Files that encode BRANDON'S INTENT or the safety layer itself — the builder must never rewrite
// them, and self-update must never auto-merge a PR that touches them. PR #56 (2026-07-10) proved
// the class: a gate-green "engagement strategy" build reactivated the deliberately-dormant social
// channel and reworded the north-star focus text, then self-merged minutes later. Self-improvement
// means better machinery — never new values, new gates, or new claims about what the system can do.
export const PROTECTED_PATHS = [
  'engine/policy.mjs',      // this safety layer
  'org/focus.mjs',          // Brandon's brief — the north star and each dept's move
  'org/capabilities.mjs',   // the grounding truth of what the system can actually do
  'package.json', 'package-lock.json', '.mcp.json',
];
export function touchesProtected(files) {
  return (files || []).map(String).filter((f) => PROTECTED_PATHS.includes(f));
}

// What SHAPE of work a filed task's title describes: 'code' (the builder writes a gated change) or
// 'deliverable' (the task wants a DOCUMENT — plan, audit, report, brief). Pointing the code builder
// at a document task is how the 2026-07-10 theater PRs happened (comment spam for "Upgrade Chronos
// SDK", console.logs for "Optimization Plan") — the model can only pass the gate, not produce the
// document. Code words WIN ties: "Weekly Progress Report AUTOMATION" is code (build the automation),
// "Capabilities Audit" is a document.
const DELIVERABLE_WORDS = /\b(report|audit|plan|brief|strategy|proposal|analysis|write[- ]?up|summary|roadmap|memo)\b/i;
const CODE_WORDS = /\b(fix|bug|implement|automat(?:e|ion|ed|ically)|script|endpoint|api|component|refactor|migrat\w+|crash|button|ui|ux|upgrade|install|dependen\w+|rename|deploy|feature|string|page|table|tab|dashboard|modal|css|style|test|build)\b/i;
export function taskShape(title) {
  const t = String(title || '');
  return DELIVERABLE_WORDS.test(t) && !CODE_WORDS.test(t) ? 'deliverable' : 'code';
}

export function effectOf(outputType) {
  return GATED_ACTION[outputType] ? 'gated' : 'internal';
}

export function riskOf(outputType) {
  if (/pricing|dunning/.test(outputType)) return 'high';   // money / irreversible
  if (GATED_ACTION[outputType]) return 'medium';           // outbound but recoverable
  return 'low';
}

// Guardrails for the autonomous runner (P5 — the 6 AM board meeting). Encoded now so the design
// is real, not a comment. The on-demand P1 runner doesn't loop overnight, so these are inert here;
// the scheduled runner will enforce them.
export const GUARDRAILS = {
  selfCheckEveryNTasks: 5,        // re-read the goal + yesterday's rejections before continuing
  maxTasksPerNight: 60,
  budgetCapUsd: 15,               // hard stop if the night's token spend hits this
  stopConditions: [
    'budget cap reached',
    'same tool fails 3× in a row',
    'confidence on a thread drops below 0.4 → park it, do not improvise',
    'an action would be irreversible AND is not in the gated set → refuse + park',
  ],
  onStop: 'park the thread with a note in Chronos and surface it in the morning debrief',
};
