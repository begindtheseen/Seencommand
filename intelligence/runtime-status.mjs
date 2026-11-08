import { loadRuntimeConfig } from './runtime-config.mjs';
import { discoverModels } from './model-registry.mjs';

export function intelligenceRuntimeStatus({ workflows = [], config = loadRuntimeConfig(), registry = discoverModels(), now = new Date() } = {}) {
  const active = workflows.filter((w) => !['COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED'].includes(w.state));
  const latest = [...workflows].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
  return {
    generatedAt: now.toISOString(),
    operational: true,
    localFirst: config.runtime.localFirst,
    remoteEscalationEnabled: config.routing.remoteEscalationEnabled,
    remoteBudget: config.budget,
    hardware: registry.hardware,
    models: registry.models,
    workflows: { total: workflows.length, active: active.length, latest, byState: workflowStateCounts(workflows) },
    approvalBoundaries: { production: true, destructive: true, billing: true, secrets: true },
  };
}

export function workflowStateCounts(workflows) {
  const counts = {};
  for (const workflow of workflows) {
    if (!counts[workflow.state]) {
      counts[workflow.state] = 0;
    }
    counts[workflow.state] += 1;
  }
  return { total: workflows.length, ...counts };
}
