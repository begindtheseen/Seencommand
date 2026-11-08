// Connector registry — maps tool ids (matching org/tools.mjs) to live handlers, gathers ALL live
// data once per run (degrading per-connector), slices it per department, builds the signals strip,
// and executes gated writes on approval. This is the bridge between the org chart and the real world.

import { config, connectorStatus } from '../config.mjs';
import { DEPT_TOOLS } from '../../org/tools.mjs';
import * as github from './github.mjs';
import * as adminStats from './adminStats.mjs';
import * as supabase from './supabase.mjs';
import * as vercel from './vercel.mjs';
import * as stripe from './stripe.mjs';
import { recordApproval } from '../brain.mjs';

export const CONNECTORS = { github, admin_stats: adminStats, supabase, vercel, stripe };

// Non-HTTP exec targets (the brain). Kept out of CONNECTORS so gatherLive() doesn't probe them.
const BRAIN_EXEC = { recordApproval };

// Fetch every configured connector's snapshot ONCE, in parallel. Unconfigured → {notConfigured};
// failures → {error}. Reused by the whole run so admin-stats isn't hit four times.
export async function gatherLive() {
  const status = connectorStatus();
  const ids = Object.keys(CONNECTORS);
  const entries = await Promise.all(ids.map(async (id) => {
    const c = CONNECTORS[id];
    if (typeof c.configured === 'function' && !c.configured()) return [id, { notConfigured: true }];
    try { return [id, await c.snapshot()]; }
    catch (e) { return [id, { error: e.message }]; }
  }));
  return { status, ...Object.fromEntries(entries) };
}

// Slice a pre-fetched live bundle down to one department's wired tools.
export function pickDeptContext(live, deptId) {
  const out = {};
  for (const id of DEPT_TOOLS[deptId] || []) if (live[id] !== undefined) out[id] = live[id];
  return out;
}

// Per-dept live context (standalone fetch — used by the server outside a full run).
export async function contextForDept(deptId) {
  const live = await gatherLive();
  return pickDeptContext(live, deptId);
}

// The live "signals" strip: GitHub PRs/CI, deploy, KPIs, and what's configured.
export function signalsFrom(live) {
  return { status: live.status, github: live.github, admin: live.admin_stats, supabase: live.supabase,
    vercel: live.vercel, stripe: live.stripe, at: new Date().toISOString() };
}
export async function signals() { return signalsFrom(await gatherLive()); }

// Execute a gated action after Brandon approves it — { connector, method, args } from /api/approve.
export async function executeGated({ connector, method, args = [] }) {
  if (connector === 'brain') {
    const fn = BRAIN_EXEC[method];
    if (typeof fn !== 'function') throw new Error(`Unknown brain action: ${method}`);
    return fn(...args);
  }
  const c = CONNECTORS[connector];
  if (!c) throw new Error(`Unknown connector: ${connector}`);
  const fn = c[method];
  if (typeof fn !== 'function') throw new Error(`Unknown action: ${connector}.${method}`);
  return fn(...args);
}

export { connectorStatus, config };
