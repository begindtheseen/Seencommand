import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  runtime: { localFirst: true, preferredAppleRuntime: 'ollama', fallbackLocalRuntime: null, maxConcurrentWorkers: 1 },
  models: { discoveryEnabled: true, benchmarkBeforeAssignment: true, allowUnverifiedModels: false },
  routing: { remoteEscalationEnabled: false, maxLocalAttemptsBeforeEscalation: 2 },
  budget: { dailyRemoteUsd: 3, monthlyRemoteUsd: 40, perTaskRemoteUsd: 1, perModelRemoteUsd: 10, perWorkerRemoteUsd: 5, requireApprovalAboveUsd: 0.5, maxRetries: 2, maximumContextTokens: 12000 },
  permissions: { default: 'READ_ONLY', codingWorker: 'BRANCH_WRITE', deploymentWorker: 'PREVIEW_DEPLOY', productionRequiresApproval: true },
  memory: { provider: 'chronos', citationsRequired: true, invalidateOnGitChange: true, maximumContextTokens: 12000 },
  safety: { protectedBranches: ['main', 'master', 'production', 'next-migration'], blockDestructiveDatabaseCommands: true, redactSecrets: true },
});

const merge = (base, override) => {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key] || {}, value) : value;
  return out;
};

export function loadRuntimeConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const configured = env.SEEN_INTELLIGENCE_CONFIG ? resolve(cwd, env.SEEN_INTELLIGENCE_CONFIG) : null;
  let fileConfig = {};
  if (configured) {
    if (!existsSync(configured)) throw new Error(`intelligence config not found: ${configured}`);
    fileConfig = JSON.parse(readFileSync(configured, 'utf8'));
  }
  const result = merge(DEFAULT_RUNTIME_CONFIG, fileConfig);
  if (env.SEEN_REMOTE_ESCALATION != null) result.routing.remoteEscalationEnabled = /^(1|true|yes|on)$/i.test(env.SEEN_REMOTE_ESCALATION);
  if (env.SEEN_DAILY_REMOTE_USD != null) result.budget.dailyRemoteUsd = Number(env.SEEN_DAILY_REMOTE_USD);
  if (env.SEEN_MONTHLY_REMOTE_USD != null) result.budget.monthlyRemoteUsd = Number(env.SEEN_MONTHLY_REMOTE_USD);
  if (env.SEEN_TASK_REMOTE_USD != null) result.budget.perTaskRemoteUsd = Number(env.SEEN_TASK_REMOTE_USD);
  if (env.SEEN_MAX_CONTEXT_TOKENS != null) result.budget.maximumContextTokens = Number(env.SEEN_MAX_CONTEXT_TOKENS);
  return result;
}
