// build-gaps — Seen Command reading its OWN failure record and naming what it is missing.
//
// Brandon, 2026-08-13: "seen command chat bot cant identify its own shortcomings so that we can have
// better skill completion, current completion rate is 0."
//
// The failure queue answers "what is stuck". This answers the harder question: across EVERY build we
// have ever run, what capability was absent, and how many failures would it have converted? That is
// the difference between a system that reports symptoms and one that can specify its own next update.
//
// The classifier is deterministic and pattern-based — no model — because the recorded reasons are our
// own strings. Each pattern carries the MISSING capability, not just a label: a bucket named
// "reviewer rejection" tells you nothing, while "the gate proves a change breaks nothing, never that
// it does anything — an empty file passes" tells you what to build.
//
// Reads every build record (both the packaged app's runtime home and a dev checkout, deduped by id,
// newest wins) so a diagnosis run from the repo does not silently miss the 96 records that only exist
// in ~/Library/Application Support — the exact trap that made this look healthy from the checkout.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dataDir } from './paths.mjs';

// Ordered: the first pattern that matches a reason wins, so put the specific ones first.
export const GAP_RULES = [
  {
    id: 'semantic-gate',
    test: (r) => /reviewer rejected the change twice|changed only comments|is empty|placeholder\/stub|does not actually accomplish/i.test(r),
    missing: 'A deterministic "did this actually do the work?" check before the reviewer — reject a diff that creates an empty file, references a symbol defined nowhere, changes only comments, or adds a test with no assertions.',
    why: 'The gate proves a change BREAKS nothing, never that it DOES anything, so an empty file passes and only the probabilistic reviewer catches it — twice, then it gives up.',
  },
  {
    id: 'isolate-self-update',
    test: (r) => /uncommitted CODE changes|working tree has uncommitted|local changes that conflict/i.test(r),
    missing: 'Run self-update in the same isolated worktree the builder already uses, and stop counting UNTRACKED junk as a blocker.',
    why: 'engine/builder.mjs was converted to isolated worktrees; engine/self-update.mjs still gates on the shared checkout, so unrelated stray files block every update.',
  },
  {
    id: 'lane-preflight',
    test: (r) => /credit balance is too low|rate limit|HTTP 429|no LOCAL coder is served|model call failed/i.test(r),
    missing: 'Probe lane health BEFORE claiming a build slot, fall through to the next working lane, and derive LOCAL_MODELS from the live Ollama probe instead of hand config.',
    why: 'A build that runs for minutes and dies on a billing or quota problem wastes a slot to discover something checkable in milliseconds.',
  },
  {
    id: 'base-branch-health',
    test: (r) => /baseline tests are already red|base branch's own test suite is red/i.test(r),
    missing: 'A scheduled base-branch health check that blocks the QUEUE (or files a fix-main task) instead of letting each new task discover a red base and take the blame.',
    why: 'These tasks were failed for something none of them caused.',
  },
  {
    id: 'proposal-time-validation',
    test: (r) => /is closed — a closed task|duplicate of open PR|outside the writable code paths|refused to write outside safe paths/i.test(r),
    missing: 'Run the premise checks at PROPOSAL time, so a closed issue, work already covered by an open PR, or a wrong-repo target never becomes a queued task.',
    why: 'The refusal guard works — this is caught before tokens are spent. The waste is upstream: the board proposed work that was already done or in flight.',
  },
  {
    id: 'environment-preflight',
    test: (r) => /is not a git checkout|ETIMEDOUT|spawn failed/i.test(r),
    missing: 'Validate at startup that both configured checkouts exist, are git repos, and are writable — surfaced in Settings with the exact fix.',
    why: 'Builds tried to write inside the read-only .app bundle because a repo dir was unset, and each one failed separately.',
  },
  {
    id: 'coder-capability',
    test: (r) => /could not reach a green gate/i.test(r),
    missing: 'Task decomposition — a task that fails N rounds should be split into smaller verifiable steps rather than retried whole.',
    why: 'These are genuine model-quality limits, not plumbing. failureBrief() now tells a retry what already failed, which should convert some.',
  },
  {
    id: 'reason-required',
    test: (r) => !String(r || '').trim() || /^\(no reason recorded\)$/i.test(r),
    missing: 'No record may reach a terminal state with an empty reason — pr_closed and preview_failed can still land bare.',
    why: 'A failure with no reason is indistinguishable from one nobody looked at.',
  },
];

const BAD = new Set(['failed', 'refused', 'preview_failed', 'pr_closed']);

// Every build record this machine can see, deduped by id with the newest write winning.
export function readAllBuilds({ dirs = null, exists = existsSync, list = readdirSync, read = readFileSync } = {}) {
  const roots = dirs || [
    dataDir(),
    join(homedir(), 'Library', 'Application Support', 'seen-command', 'data'),
  ].map((d) => join(d, 'builds'));
  const byId = new Map();
  for (const dir of [...new Set(roots)]) {
    if (!exists(dir)) continue;
    let files = [];
    try { files = list(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let b; try { b = JSON.parse(String(read(join(dir, f), 'utf8'))); } catch { continue; }
      const id = b?.id || f.replace(/\.json$/, '');
      const stamp = String(b?.updatedAt || b?.endedAt || b?.startedAt || '');
      const prev = byId.get(id);
      if (!prev || stamp > String(prev.updatedAt || prev.endedAt || prev.startedAt || '')) byId.set(id, { ...b, id });
    }
  }
  return [...byId.values()];
}

// The whole point: gaps ranked by how many real failures each one explains.
export function buildGaps(opts = {}) {
  const builds = opts.builds || readAllBuilds(opts);
  const bad = builds.filter((b) => BAD.has(b.status));
  const gaps = new Map();
  const unclassified = [];
  for (const b of bad) {
    const reason = String(b.error || '');
    const rule = GAP_RULES.find((g) => g.test(reason));
    if (!rule) { unclassified.push({ id: b.id, reason: reason.slice(0, 120) }); continue; }
    if (!gaps.has(rule.id)) gaps.set(rule.id, { id: rule.id, missing: rule.missing, why: rule.why, count: 0, examples: [] });
    const g = gaps.get(rule.id);
    g.count += 1;
    if (g.examples.length < 4) g.examples.push(b.id);
  }
  const ranked = [...gaps.values()].sort((a, b) => b.count - a.count);
  const succeeded = builds.filter((b) => ['pr_ready', 'merged', 'green_dry', 'delivered', 'updated'].includes(b.status)).length;
  return {
    totalBuilds: builds.length,
    succeeded,
    failed: bad.length,
    completionRate: builds.length ? Math.round((succeeded / builds.length) * 100) : 0,
    gaps: ranked,
    // Naming what we could NOT classify matters: an unclassified failure is a gap we have not learned
    // to see yet, and silently dropping it would make this report quietly optimistic.
    unclassified,
  };
}
