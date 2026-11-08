// The deliverable drafter — turns an approved NON-engineering action into REAL content, not an empty
// stub. It pulls grounding from Chronos (brain facts + the live Supabase/GitHub layer) first, then
// produces the actual thing: a Ghost Report written from company_scores, a pricing change with the real
// current numbers, or a grounded brief. So approving a task files the work already done — you review +
// do the final irreversible click (post / apply), never chase an empty issue.
//
// No required API calls: the Ghost Report is data-driven from the Ghost Index; the optional narrative
// polish uses the LOCAL model only and degrades to a deterministic summary.

import { fetchGhostIndex } from '../brain/lib/live.mjs';
import { rankFacts } from '../brain/lib/keeper.mjs';
import { readBrainFacts } from '../lib/brain.mjs';
import { reason } from '../lib/llm.mjs';

const today = () => new Date().toISOString().slice(0, 10);
// ghost_rate may be a fraction (0.52) or already a percent (52). Normalize to an integer percent.
const pct = (v) => (v == null ? null : Math.round(v <= 1 ? v * 100 : v));

// ---- Ghost Report ----------------------------------------------------------
export async function draftGhostReport() {
  const rows = (await fetchGhostIndex(12)).filter((r) => r && r.company_name);
  if (!rows.length) {
    return { title: `Ghost Report — ${today()} (no data)`,
      body: 'The Ghost Index (company_scores) returned no companies with enough reports to rank yet. Gather more reports before publishing.' };
  }
  const tbl = ['| # | Company | Ghost rate | Reports | Avg wait | Industry |', '|---|---------|-----------|---------|----------|----------|'];
  rows.forEach((r, i) => {
    tbl.push(`| ${i + 1} | ${r.company_name} | ${pct(r.ghost_rate) ?? '?'}% | ${r.report_count ?? '?'} | ${r.avg_wait_days != null ? r.avg_wait_days + 'd' : '—'} | ${r.industry || '—'} |`);
  });
  const worst = rows[0];
  const totalReports = rows.reduce((n, r) => n + (r.report_count || 0), 0);
  const dataLine = `Across ${rows.length} companies and ${totalReports} verified reports, **${worst.company_name}** tops the index at a ${pct(worst.ghost_rate)}% ghost rate.`;

  // Optional punchy intro from the LOCAL model; deterministic fallback keeps it zero-API-cost.
  const r = await reason({ competence: 'generalist', localOnly: true, maxTokens: 220,
    system: 'You write sharp, factual intros for a job-seeker newsletter. 2 sentences, no hype, no markdown.',
    prompt: `Write a 2-sentence intro for this week's Seen Ghost Report — the companies that ghost applicants most. Data: ${dataLine}`,
    fallback: `This week's Ghost Report ranks the companies most likely to leave applicants hanging — sourced from real reports on Seen. ${dataLine}` });

  const body = [
    `# Seen Ghost Report — ${today()}`, '',
    r.text, '',
    '## The Ghost Index (highest ghost rates)', '',
    ...tbl, '',
    `_Sourced live from Seen's company_scores (the Ghost Index) via Chronos. Draft — review and post to r/recruitinghell + the site. Nothing was posted automatically._`,
  ].join('\n');
  return { title: `Ghost Report — ${today()}: ${worst.company_name} tops the index`, body, engine: r.engine };
}

// ---- Grounded brief (pricing / generic) ------------------------------------
// Pulls the facts Chronos knows that bear on the task and states the concrete current-state + the
// specific proposed change, so the task has real substance to act on.
export async function draftGroundedBrief({ task, dept }) {
  let facts = [];
  try { facts = rankFacts(readBrainFacts(), `${task} ${dept || ''}`, 10); } catch { facts = []; }
  const grounding = facts.length
    ? facts.map((f) => `- ${f.subject} · ${f.predicate}: ${f.object}`).join('\n')
    : '- (no matching facts in the brain yet)';
  const r = await reason({ deptId: dept || 'strategy', competence: 'reason', localOnly: true, maxTokens: 400,
    system: 'You are drafting a concrete, actionable brief. Use ONLY the grounding facts. State the exact current state and the specific proposed change with numbers. No fluff.',
    prompt: `Task: ${task}\n\nGrounding (from Chronos):\n${grounding}\n\nWrite the brief: current state, the specific change proposed, and what the human must do to apply it.`,
    fallback: `**Grounding from Chronos:**\n${grounding}\n\n**Proposed:** ${task}\n\n(No local model reachable to expand — the facts above are the current state; specify the exact change and apply it.)` });
  return { title: task, body: `## ${task}\n\n${r.text}\n\n---\n_Grounded from Chronos. Draft — review and apply._`, engine: r.engine };
}

// Route an approved action's kind to the right deliverable. Returns { title, body } or null if this
// kind isn't a draftable deliverable (engineering builds go through the builder instead).
export async function draftDeliverable({ kind, task, dept }) {
  if (kind === 'intel brief' || /ghost report/i.test(String(task))) return draftGhostReport();
  if (kind === 'pricing proposal' || kind === 'reddit plan' || kind === 'seo draft' || kind === 'sales draft'
      || kind === 'funnel experiment' || kind === 'dunning action' || kind === 'social plan') {
    return draftGroundedBrief({ task, dept });
  }
  return null;
}

// Which non-engineering kinds produce a real drafted deliverable on approval.
export function isDeliverable(kind) {
  return ['intel brief', 'pricing proposal', 'reddit plan', 'seo draft', 'sales draft',
    'funnel experiment', 'dunning action', 'social plan'].includes(kind);
}

// Draft the document a DOCUMENT-SHAPED task wants (see policy.taskShape) — the route the Tasks tab
// takes instead of the code builder for plans/audits/reports. Ghost-report tasks get the live-data
// report; everything else gets a Chronos-grounded brief.
export async function draftForTask({ title, dept = null } = {}) {
  const clean = String(title || '').replace(/^\[[^\]]+\]\s*/, ''); // drop the [dept] prefix
  if (/ghost report/i.test(clean)) return draftGhostReport();
  return draftGroundedBrief({ task: clean, dept });
}
