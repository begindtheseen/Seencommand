// Agent-to-agent communication — the message bus. Workers don't just report up to the CEO; they
// route asks to each OTHER department. The CDO diagnostician finds a funnel leak → hands off to CMO
// ("raise Reddit cadence") and Reliability ("set POSTHOG to unblind the funnel"). The orchestrator
// collects these, routes them to the target department's inbox, and surfaces the whole cross-team
// flow in the debrief. Pure functions over the proposals array.

import { departmentById } from '../org/org.mjs';

const deptTitle = (id) => departmentById(id)?.title || id;

// A proposal may carry `handoffs: [{ toDept, ask }]`. Collect + tag them with the sender.
export function collectHandoffs(proposals) {
  const routed = [];
  for (const p of proposals) {
    for (const h of p.handoffs || []) {
      if (!h.toDept || !h.ask) continue;
      routed.push({ fromDept: p.dept, fromAgent: p.agentTitle, toDept: h.toDept, ask: h.ask });
    }
  }
  return routed;
}

// Group routed messages by recipient department (the "inbox" each dept sees next run).
export function inboxByDept(routed) {
  const inbox = {};
  for (const r of routed) (inbox[r.toDept] ||= []).push(r);
  return inbox;
}

// Human-readable one-liners for the "Cross-team routing" strip in the debrief.
export function routingLines(routed) {
  return routed.map((r) => `${deptTitle(r.fromDept)} → ${deptTitle(r.toDept)}: ${r.ask}`);
}

// Rule-based handoff derivation from live signals — so cross-team messaging happens even before the
// model proposes it. These encode Seen's real dependency chains (distribution → funnel → revenue).
export function deriveHandoffs(deptId, ctx) {
  const hs = [];
  const admin = ctx.admin_stats;
  if (deptId === 'data' && admin && !admin.error && !admin.notConfigured) {
    const s = admin.raw || {};
    const posthogBlind = !process.env.NEXT_PUBLIC_POSTHOG_KEY; // funnel unblinding is a known lever
    if ((s.users?.new_today ?? 0) < 5) hs.push({ toDept: 'growth', ask: 'Top-of-funnel is thin today — raise Reddit cadence to bring in signups.' });
    if (posthogBlind) hs.push({ toDept: 'reliability', ask: 'Set NEXT_PUBLIC_POSTHOG_KEY so the signup→paid funnel is measurable.' });
  }
  if (deptId === 'strategy' && admin && admin.raw) {
    const m = admin.raw.monetization || {};
    if (m.stripe_connected && (m.active_paid ?? m.pro_users ?? 0) === 0) {
      hs.push({ toDept: 'revenue', ask: 'Stripe is live but 0 paid — test one post-win upsell placement.' });
    }
  }
  if (deptId === 'reliability') {
    const jh = admin?.raw?.job_health;
    if (jh?.crisis) hs.push({ toDept: 'command', ask: 'Job board in crisis — needs an emergency refresh approval.' });
  }
  return hs;
}
