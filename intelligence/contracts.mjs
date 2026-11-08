// Intelligence Runtime contracts. These are dependency-free runtime validators rather than
// TypeScript-only types: malformed model/workflow data is rejected at the boundary in production.

export const WORKFLOW_STATES = Object.freeze([
  'RECEIVED', 'CONTEXT_BUILDING', 'CONTEXT_READY', 'PLANNING', 'AWAITING_APPROVAL',
  'QUEUED', 'EXECUTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'SECURITY_CHECK',
  'READY_FOR_PR', 'AWAITING_DEPLOY_APPROVAL', 'DEPLOYING', 'VERIFYING', 'COMPLETED',
  'FAILED', 'ROLLED_BACK', 'CANCELLED',
]);

export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED']);

export const PERMISSIONS = Object.freeze([
  'READ_ONLY', 'LOCAL_WRITE', 'BRANCH_WRITE', 'PREVIEW_DEPLOY', 'PRODUCTION_WRITE', 'DESTRUCTIVE',
]);

export const PRIVACY_LEVELS = Object.freeze(['PUBLIC', 'INTERNAL', 'SENSITIVE', 'LOCAL_ONLY']);
export const MODEL_CAPABILITIES = Object.freeze([
  'classify', 'summarize', 'plan', 'code', 'review', 'security', 'tool_use',
  'structured_output', 'repository_reasoning', 'long_context',
]);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const finite = (v) => Number.isFinite(Number(v));

export function validateJsonSchema(value, schema = {}) {
  const errors = [];
  const walk = (v, s, at) => {
    if (!s || typeof s !== 'object') return;
    if (s.type === 'object') {
      if (!isObject(v)) { errors.push(`${at} must be an object`); return; }
      for (const key of s.required || []) if (!(key in v)) errors.push(`${at}.${key} is required`);
      for (const [key, child] of Object.entries(s.properties || {})) if (key in v) walk(v[key], child, `${at}.${key}`);
      if (s.additionalProperties === false) {
        const allowed = new Set(Object.keys(s.properties || {}));
        for (const key of Object.keys(v)) if (!allowed.has(key)) errors.push(`${at}.${key} is not allowed`);
      }
    } else if (s.type === 'array') {
      if (!Array.isArray(v)) { errors.push(`${at} must be an array`); return; }
      if (finite(s.maxItems) && v.length > Number(s.maxItems)) errors.push(`${at} exceeds maxItems`);
      v.forEach((item, i) => walk(item, s.items, `${at}[${i}]`));
    } else if (s.type === 'string' && typeof v !== 'string') errors.push(`${at} must be a string`);
    else if (s.type === 'number' && !finite(v)) errors.push(`${at} must be a number`);
    else if (s.type === 'integer' && (!Number.isInteger(v))) errors.push(`${at} must be an integer`);
    else if (s.type === 'boolean' && typeof v !== 'boolean') errors.push(`${at} must be a boolean`);
    if (Array.isArray(s.enum) && !s.enum.includes(v)) errors.push(`${at} is not an allowed value`);
  };
  walk(value, schema, '$');
  return { valid: errors.length === 0, errors };
}

export function validateModelRequest(request) {
  const errors = [];
  if (!isObject(request)) return { valid: false, errors: ['request must be an object'] };
  if (!nonEmpty(request.taskType)) errors.push('taskType is required');
  if (!Array.isArray(request.messages) || !request.messages.length) errors.push('messages must be a non-empty array');
  else request.messages.forEach((m, i) => {
    if (!isObject(m) || !['system', 'user', 'assistant', 'tool'].includes(m.role) || !nonEmpty(m.content)) errors.push(`messages[${i}] is invalid`);
  });
  if (!isObject(request.budget)) errors.push('budget is required');
  else {
    for (const key of ['maxInputTokens', 'maxOutputTokens', 'timeoutMs']) if (!finite(request.budget[key]) || Number(request.budget[key]) <= 0) errors.push(`budget.${key} must be positive`);
    if (!finite(request.budget.maxCostUsd) || Number(request.budget.maxCostUsd) < 0) errors.push('budget.maxCostUsd must be non-negative');
  }
  if (!PRIVACY_LEVELS.includes(request.privacy)) errors.push('privacy is invalid');
  if (!Array.isArray(request.requiredCapabilities)) errors.push('requiredCapabilities must be an array');
  else for (const c of request.requiredCapabilities) if (!MODEL_CAPABILITIES.includes(c)) errors.push(`unknown capability: ${c}`);
  if (request.context != null && !Array.isArray(request.context)) errors.push('context must be an array');
  if (request.tools != null && !Array.isArray(request.tools)) errors.push('tools must be an array');
  return { valid: errors.length === 0, errors };
}

export function assertModelRequest(request) {
  const result = validateModelRequest(request);
  if (!result.valid) throw new TypeError(`invalid ModelRequest: ${result.errors.join('; ')}`);
  return request;
}

export function normalizedModelResponse(input = {}) {
  const response = {
    output: input.output,
    modelId: String(input.modelId || 'unknown'),
    providerId: String(input.providerId || 'unknown'),
    runtime: input.runtime === 'local' ? 'local' : 'remote',
    latencyMs: Math.max(0, Number(input.latencyMs || 0)),
    ...(finite(input.inputTokens) ? { inputTokens: Math.max(0, Number(input.inputTokens)) } : {}),
    ...(finite(input.outputTokens) ? { outputTokens: Math.max(0, Number(input.outputTokens)) } : {}),
    estimatedCostUsd: Math.max(0, Number(input.estimatedCostUsd || 0)),
    cacheHit: !!input.cacheHit,
    toolCalls: Array.isArray(input.toolCalls) ? input.toolCalls : [],
    validation: input.validation && typeof input.validation === 'object' ? input.validation : { valid: true, errors: [] },
  };
  return response;
}

export function assertWorkflowTask(task) {
  const required = ['id', 'workflowId', 'objective', 'riskLevel', 'permissions', 'acceptanceCriteria', 'requiredTests', 'modelPolicy', 'executionBudget', 'status'];
  const missing = required.filter((key) => task?.[key] == null);
  if (missing.length) throw new TypeError(`invalid task: missing ${missing.join(', ')}`);
  if (!PERMISSIONS.includes(task.permissions)) throw new TypeError(`invalid task permission: ${task.permissions}`);
  return task;
}
