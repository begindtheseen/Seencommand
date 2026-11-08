// PROPOSAL SANITY GATE — the approval queue's phantom-reference lint.
//
// engine/lint.mjs stops the CODER from shipping code that references things that don't exist. This is
// the same idea one layer up: it stops the AGENDA from putting proposals in Brandon's approval queue
// that can't or shouldn't be there. Issue #81 ("Integrate the Chronos SDK … for Real-Time Data
// Exchange", approved by Brandon) exposed three distinct ways a proposal reaches the queue broken:
//
//   1. PHANTOM PREMISE — it names a thing that does not exist. There is no Chronos SDK: Chronos and
//      Seen Command are dependency-free pure Node (brain/mcp/server.mjs: "no SDK, no npm install").
//      The task was filed and closed as unfulfillable SIX times (#45/#62/#64/#65/#68/#81). The real
//      Chronos↔Seen integration already exists — the shared vault + brain MCP + the 30s cloud poll.
//   2. RESURRECTION — it's a closed task reworded. The old filter compared the proposal title against
//      the FULL GitHub issue title (which carries a "— long description" tail); the description's
//      tokens diluted the Jaccard match to ~0.09, so reworded resurrections sailed through. We compare
//      against the de-noised SUBJECT of the closed title instead.
//   3. OFF-CHARTER — content that doesn't match the raising dept's gate. #81 was a growth-dept
//      `reddit plan` whose gate is "Post to Reddit + reply in the thread" (engine/policy.mjs) carrying an
//      engineering integration task. Title and executable action were fully decoupled — approving the
//      words would have run something unrelated. (The draft-first guardrail caught it; the mismatch is
//      the bug.)
//
// Precision-first, exactly like the lint: only NAMED, deterministic rejections — never a fuzzy guess.
// A dropped proposal is logged (visible), never silently swallowed, and Brandon can always re-raise a
// real one. Set PROPOSAL_GATE=0 to disable the whole gate.

import { sameWork } from '../lib/text.mjs';

// ---- check 1: phantom premise ------------------------------------------------------------------
// Proposals that name a system entity that does not exist. Seeded with the one the agenda keeps
// re-inventing; extend as new phantoms prove recurring. The product repo (../seen) is a Next.js app
// that legitimately uses SDKs (Supabase, Stripe) — so this targets OUR OWN dependency-free components
// (Chronos, Seen Command) paired with SDK/package/library, never the bare word "SDK".
// PAIRED phrases only ("Chronos SDK", "SDK for Chronos") — never mere co-occurrence. The adversarial
// review of PR #82 reproduced the co-occurrence bug: "Compare Chronos poll latency against the
// Supabase SDK" names a REAL third-party SDK in a sentence unrelated to Chronos and must pass.
export const PHANTOM_CONCEPTS = [
  {
    id: 'chronos-sdk',
    test: (t) => /\bchronos['’\s-]*sdk\b/.test(t) || /\bsdk\s+(?:for|of)\s+chronos\b/.test(t),
    why: 'there is no Chronos SDK — Chronos and Seen Command are dependency-free pure Node (brain/mcp/server.mjs: "no SDK, no npm install"). The real Chronos↔Seen integration already exists: the shared vault + brain MCP + the 30s cloud poll (brain/main.js). This has been filed and closed as unfulfillable 6× (#45/#62/#64/#65/#68/#81).',
  },
  {
    id: 'seen-command-sdk',
    test: (t) => /\bseen[\s-]command['’\s-]*(?:sdk|npm package|client library)\b/.test(t) || /\b(?:sdk|npm package|client library)\s+(?:for|of)\s+seen[\s-]command\b/.test(t),
    why: 'Seen Command is a dependency-free pure-Node repo — it has no SDK/package to integrate or upgrade. There is nothing to build here.',
  },
];

// The reason a proposal names a nonexistent entity, or null. Case-insensitive over title+body.
export function phantomPremise(text) {
  const t = String(text || '').toLowerCase();
  for (const p of PHANTOM_CONCEPTS) { try { if (p.test(t)) return p.why; } catch { /* skip */ } }
  return null;
}

// ---- check 2: resurrection (de-noised) ---------------------------------------------------------
// The distinctive SUBJECT of a task title, without its "— long description" tail. GitHub issue titles
// here are "Short Title — one-paragraph description"; the description tokens are what diluted the match
// so badly that reworded closed tasks slipped past. Split on a spaced em/en dash or " - " only (NOT a
// colon — that would eat a "PR 187: …" head into nothing useful).
export function titleSubject(title) {
  // em-dash splits spaced or not; en-dash/horizontal-bar only when spaced (unspaced en-dash is a
  // range, "2024–2025"); " - " as before. Review nit: unicode dash variants left tails attached.
  return String(title || '').split(/\s*—\s*|\s+[–―]\s+| - /)[0].trim();
}

// The closed title this proposal re-raises (reworded), or null. Compares de-noised subject to
// de-noised subject so the description tail can't drown the shared concept.
export function resurrectionOf(title, closedTitles = [], threshold = 0.5) {
  const subj = titleSubject(title);
  if (!subj) return null;
  for (const c of closedTitles) { if (sameWork(subj, titleSubject(c), threshold)) return c; }
  return null;
}

// ---- check 3: off-charter (kind ↔ content mismatch) --------------------------------------------
// Each proposal KIND carries a fixed gate (engine/policy.mjs). When the CONTENT belongs to a different
// domain than the kind, approving the words executes something unrelated. The two dangerous mismatches:
// a marketing/outbound kind carrying engineering work (the #81 shape), and an engineering kind carrying
// pure marketing work.
const MARKETING_KINDS = new Set(['reddit plan', 'social plan', 'seo draft', 'sales draft', 'dunning action']);
const ENGINEERING_KINDS = new Set(['platform PR', 'bugfix PR', 'feature PR', 'migration draft']);
// implement/automate/monitor/alert/stale-job joined after the first LIVE gated meeting still queued
// "Implement Automated Stale Job Resolution" as a reddit plan — build-verbs with zero marketing
// action are engineering content; the symmetric !MARKETING guard keeps real posts ("Automate the
// weekly r/recruitinghell cadence") passing.
const ENGINEERING_CONTENT = /\b(sdk|api|integrat\w+|connector|endpoint|migrat\w+|refactor|deploy|codebase|repositor\w+|\brepo\b|back[- ]?end|front[- ]?end|database|schema|component|module|package|library|pull request|test gate|self[- ]?improv\w+|implement\w*|automat\w+|monitor\w+|alert\w+|stale job)\b/i;
const MARKETING_CONTENT = /\b(reddit|subreddit|r\/\w+|tweet|twitter|\bdms?\b|direct message|post to|social (post|media)|campaign|outreach|cold email|newsletter|\bseo\b|backlink)\b/i;

export function offCharter(kind, text) {
  const t = String(text || '');
  // SYMMETRIC guards (review fix): a marketing proposal that actually does its marketing action may
  // freely mention product/engineering nouns ("post about our Supabase integration to r/SaaS") —
  // only content with NO marketing action in a marketing kind is decoupled. Mirrors the other branch.
  if (MARKETING_KINDS.has(kind) && ENGINEERING_CONTENT.test(t) && !MARKETING_CONTENT.test(t)) {
    return `a "${kind}" proposal (its gate is an outbound post) is carrying engineering content — approving it would execute an action unrelated to what it describes`;
  }
  if (ENGINEERING_KINDS.has(kind) && MARKETING_CONTENT.test(t) && !ENGINEERING_CONTENT.test(t)) {
    return `a "${kind}" proposal (its gate merges/deploys code) is carrying marketing content — kind and content are mismatched`;
  }
  return null;
}

// The builder already refuses to build a task that duplicates an OPEN PR (engine/builder.mjs uses
// sameWork at 0.4). Catching it only there means the board still proposed it, Brandon still saw it in
// the approval queue, and it still consumed a decision — task-88 and task-132 both died that way.
// Screening here with the SAME metric means the duplicate never becomes a task at all. Reusing
// sameWork rather than inventing a second similarity rule is deliberate: two thresholds that disagree
// would let a proposal pass the board and then be refused by the builder, the worst of both.
export function duplicateOfOpenPR(title, openPRTitles = [], threshold = 0.4) {
  if (!title || !Array.isArray(openPRTitles)) return null;
  for (const t of openPRTitles) if (t && sameWork(title, t, threshold)) return t;
  return null;
}

// ---- the gate ----------------------------------------------------------------------------------
// Screen ONE proposal ({ title, body/detail, kind }). Returns { ok } or { ok:false, check, reason }.
export function screenProposal(p, { closedTitles = [], targetCheck = null, openPRTitles = null } = {}) {
  if (!p) return { ok: false, check: 'empty', reason: 'no proposal' };
  const text = `${p.title || ''} ${p.body || p.detail || ''}`.trim();
  const phantom = phantomPremise(text);
  if (phantom) return { ok: false, check: 'phantom-premise', reason: phantom };
  const res = resurrectionOf(p.title, closedTitles);
  if (res) return { ok: false, check: 'resurrection', reason: `same work as a closed task ("${String(res).slice(0, 90)}")` };
  // openPRTitles === null/undefined means GitHub could not be read. An unrunnable check must not
  // block a proposal: "I could not look" is not "it is a duplicate" (the silent-zero rule).
  if (Array.isArray(openPRTitles)) {
    // Compare the SAME text the builder compares — engine/builder.mjs duplicateOpenPR uses the full
    // task text sliced to 140, not the title. Title-only matching missed task-132 ("Enhance ghost
    // rate monitoring script") against its own PR, which the builder then caught at build time: the
    // two checks disagreeing is exactly the split this gate exists to prevent.
    const dup = duplicateOfOpenPR(text.slice(0, 140), openPRTitles);
    if (dup) return { ok: false, check: 'duplicate-open-pr', reason: `already covered by open PR "${String(dup).slice(0, 90)}" — review or merge that instead of building it again` };
  }
  const oc = offCharter(p.kind, text);
  if (oc) return { ok: false, check: 'off-charter', reason: oc };
  const targetProblem = typeof targetCheck === 'function' ? targetCheck(p) : null;
  if (targetProblem) return { ok: false, check: 'bad-target', reason: targetProblem };
  return { ok: true };
}

// Screen a dept's proposals. Returns { kept[], rejected[{ proposal, check, reason }] }. PROPOSAL_GATE=0
// disables (everything kept) — the escape hatch, mirroring CODER_LINT=0 / CODER_REVIEW=0.
export function screenProposals(proposals = [], ctx = {}) {
  if (process.env.PROPOSAL_GATE === '0') return { kept: [...proposals], rejected: [] };
  const kept = []; const rejected = [];
  for (const p of proposals) {
    const v = screenProposal(p, ctx);
    if (v.ok) kept.push(p); else rejected.push({ proposal: p, check: v.check, reason: v.reason });
  }
  return { kept, rejected };
}

// Screen and DEMOTE-in-place: a blocked proposal stays visible in the meeting (auditable — the
// review flagged that a silent stderr-only drop is invisible if nobody reads stderr) but is made
// INERT: never gated, never queued for approval, never filed, never built. Mirrors the dedupe
// path's demote-to-internal idiom in run.mjs. Returns the same array; blocked items carry
// gateBlocked + a ⛔ note in the body. Also logs one line per drop via `log`.
export function screenAndDemote(proposals = [], ctx = {}, log = () => {}) {
  const { rejected } = screenProposals(proposals, ctx);
  for (const { proposal: p, check, reason } of rejected) {
    p.gatedAction = null;
    p.effect = 'internal';
    p.gateBlocked = check;
    p.body = `${p.body || p.title} — ⛔ blocked by the proposal gate (${check}): ${String(reason).slice(0, 160)}`;
    try { log(`[proposal-gate] blocked (${check}) "${String(p.title).slice(0, 90)}": ${String(reason).slice(0, 120)}\n`); } catch { /* never throw from logging */ }
  }
  return proposals;
}
