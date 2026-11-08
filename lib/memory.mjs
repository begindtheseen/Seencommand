// Shared Memory Service — the command base's brain. Generalized from Seen's Chronos engine:
// facts (durable truths), threads (the work queue agents pull from and route to each other),
// decisions (the approvals ledger), agent status, and run history. Pure + file-backed (JSON),
// so every agent reads/writes ONE shared source of truth.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { statePath, dataDir } from './paths.mjs';

// Seed: illustrative Seen context so the exec team has something to act on before the vault is connected.
export const SEED = {
  facts: [
    { subject: 'Seen', predicate: 'is_a', object: 'hiring-intelligence platform', confidence: 'high' },
    { subject: 'Seen', predicate: 'deploys_from', object: 'next-migration (merge = prod)', confidence: 'high' },
    { subject: 'Seen free tier', predicate: 'daily_ai_credits', object: '1', confidence: 'high' },
    { subject: 'Operation 50%', predicate: 'goal', object: 'reach a near-term revenue target (illustrative; four revenue engines, one-time sales)', confidence: 'high' },
    { subject: 'RESEND_KEY', predicate: 'status', object: 'live', confidence: 'high' },
    { subject: 'NEXT_PUBLIC_POSTHOG_KEY', predicate: 'status', object: 'pending (analytics not yet wired)', confidence: 'high' },
    { subject: 'Employer engine', predicate: 'status', object: 'built; featured $79/30d, verified $249/90d', confidence: 'high' },
  ],
  // The work queue. Each thread has an area that maps to a department, a priority, and status.
  threads: [
    { id: 'weekly-cadence', title: 'Run this week’s Operation 50% cadence (community post + replies)', area: 'growth', priority: 'high', status: 'open' },
    { id: 'ghost-report', title: 'Draft this week’s Ghost Report from company_scores', area: 'growth', priority: 'high', status: 'open' },
    { id: 'geo-restructure', title: 'Company-page GEO restructure for AI citations', area: 'growth', priority: 'medium', status: 'open' },
    { id: 'posthog', title: 'Analytics blind: NEXT_PUBLIC_POSTHOG_KEY not set', area: 'reliability', priority: 'high', status: 'open' },
    { id: 'cost-audit', title: 'Audit monthly spend + external dependencies (keep it lean)', area: 'reliability', priority: 'medium', status: 'open' },
    { id: 'employer-portal-163', title: 'Confirm employer portal (#163) fully landed', area: 'product', priority: 'high', status: 'open' },
    { id: 'schema-drift', title: 'Codify hand-applied prod schema drift into migrations', area: 'product', priority: 'medium', status: 'open' },
    { id: 'candidate-profiles', title: 'Phase-2 candidate profiles (owner-gated opt-in)', area: 'product', priority: 'medium', status: 'open' },
    { id: 'supabase-advisors', title: 'Scan Supabase advisors for RLS / perf gaps', area: 'reliability', priority: 'medium', status: 'open' },
    { id: 'supabase-limits', title: 'Assess Supabase as a scaling/cost risk — keep a low-lock-in exit path', area: 'reliability', priority: 'medium', status: 'open' },
    { id: 'conversion-audit', title: 'Find biggest drop-off in signup → paid', area: 'revenue', priority: 'high', status: 'open' },
    { id: 'employer-outreach', title: 'Draft outreach for 5 staffing agencies on the Ghost Index', area: 'revenue', priority: 'medium', status: 'open' },
    { id: 'kpi-pack', title: 'Pull the daily KPI pack from admin-stats', area: 'data', priority: 'high', status: 'open' },
    { id: 'anomaly-watch', title: 'Scan admin-stats for error / flag / ghost-surge anomalies', area: 'data', priority: 'medium', status: 'open' },
    { id: 'diagnose-funnel', title: 'Diagnose the biggest leak in signup → paid', area: 'strategy', priority: 'high', status: 'open' },
    { id: 'steering-plan', title: 'Draft this week’s steering game plan', area: 'strategy', priority: 'high', status: 'open' },
    { id: 'name-constraint', title: 'Name the #1 constraint on growth right now', area: 'strategy', priority: 'high', status: 'open' },
    { id: 'self-bughunt', title: 'Hunt bugs in Seen Command (runs, dashboard, JS errors)', area: 'platform', priority: 'high', status: 'open' },
    { id: 'self-wiring', title: 'Audit for missing connections (agents ↔ tools ↔ memory ↔ dashboard)', area: 'platform', priority: 'high', status: 'open' },
    { id: 'self-ux', title: 'Improve command-center usability', area: 'platform', priority: 'medium', status: 'open' },
  ],
  decisions: [],
};

export function loadState() {
  const STATE = statePath();
  if (!existsSync(STATE)) return null;
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; }
}

export function saveState(state) {
  dataDir(); // ensure the writable data dir exists (SEEN_HOME in the packaged app)
  const STATE = statePath();
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  return STATE;
}

export const openThreads = (threads) => threads.filter((t) => t.status !== 'done');
export const byArea = (threads, area) => openThreads(threads).filter((t) => t.area === area);
const PRI = { high: 0, medium: 1, low: 2 };
export const byPriority = (threads) => [...threads].sort((a, b) => (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1));

// A tiny knowledge graph for the Knowledge Vault tab: facts as subject→object edges.
export function memoryGraph(facts, threads) {
  const nodes = new Map();
  const add = (id, group) => { if (!nodes.has(id)) nodes.set(id, { id, label: id, group }); };
  const links = [];
  for (const f of facts) {
    add(f.subject, 'entity');
    const v = `${f.predicate}: ${f.object}`;
    add(v, 'value');
    links.push({ source: f.subject, target: v, kind: 'fact' });
  }
  for (const t of openThreads(threads)) { add(t.title, 'thread'); add(t.area, 'dept'); links.push({ source: t.area, target: t.title, kind: 'work' }); }
  return { nodes: [...nodes.values()], links };
}
