import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../lib/paths.mjs';
import { TERMINAL_STATES, WORKFLOW_STATES, assertWorkflowTask } from './contracts.mjs';
import { redactSecrets } from './security.mjs';

const TRANSITIONS = Object.freeze({
  RECEIVED: ['CONTEXT_BUILDING', 'CANCELLED', 'FAILED'],
  CONTEXT_BUILDING: ['CONTEXT_READY', 'FAILED', 'CANCELLED'],
  CONTEXT_READY: ['PLANNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['AWAITING_APPROVAL', 'QUEUED', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['QUEUED', 'CANCELLED', 'FAILED'],
  QUEUED: ['EXECUTING', 'CANCELLED', 'FAILED'],
  EXECUTING: ['TESTING', 'REPAIRING', 'FAILED', 'CANCELLED'],
  TESTING: ['REVIEWING', 'REPAIRING', 'FAILED', 'CANCELLED'],
  REVIEWING: ['REPAIRING', 'SECURITY_CHECK', 'FAILED', 'CANCELLED'],
  REPAIRING: ['EXECUTING', 'TESTING', 'FAILED', 'CANCELLED'],
  SECURITY_CHECK: ['READY_FOR_PR', 'REPAIRING', 'FAILED', 'CANCELLED'],
  READY_FOR_PR: ['AWAITING_DEPLOY_APPROVAL', 'COMPLETED', 'CANCELLED'],
  AWAITING_DEPLOY_APPROVAL: ['DEPLOYING', 'CANCELLED', 'FAILED'],
  DEPLOYING: ['VERIFYING', 'ROLLED_BACK', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'ROLLED_BACK', 'FAILED'],
  COMPLETED: [], FAILED: ['QUEUED', 'CANCELLED'], ROLLED_BACK: [], CANCELLED: [],
});

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
const clone = (value) => JSON.parse(JSON.stringify(value));

export class WorkflowStore {
  constructor({ dir = join(dataDir(), 'intelligence', 'workflows'), now = () => new Date() } = {}) { this.dir = dir; this.now = now; }
  path(id) { return join(this.dir, `${safeId(id)}.json`); }
  read(id) { try { return JSON.parse(readFileSync(this.path(id), 'utf8')); } catch { return null; } }
  list() {
    try { return readdirSync(this.dir).filter((f) => f.endsWith('.json')).flatMap((f) => { try { return [JSON.parse(readFileSync(join(this.dir, f), 'utf8'))]; } catch { return []; } }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
    catch { return []; }
  }
  write(workflow) {
    const value = redactSecrets({ ...workflow, updatedAt: this.now().toISOString() });
    mkdirSync(this.dir, { recursive: true });
    const path = this.path(value.id); const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, path);
    return clone(value);
  }
  create({ id = `wf-${Date.now().toString(36)}`, objective, repoRoot, riskLevel = 'LOW', permission = 'BRANCH_WRITE', budget = {}, metadata = {} } = {}) {
    if (!objective || !repoRoot) throw new Error('workflow objective and repoRoot are required');
    if (existsSync(this.path(id))) throw new Error(`workflow already exists: ${id}`);
    const at = this.now().toISOString();
    return this.write({ id: safeId(id), objective, repoRoot, state: 'RECEIVED', riskLevel, permission, budget, metadata: redactSecrets(metadata), tasks: [], artifacts: {}, approvals: [], cancellationRequested: false, error: null, createdAt: at, updatedAt: at, lastSafeCheckpoint: 'RECEIVED', history: [{ at, from: null, to: 'RECEIVED', reason: 'workflow created', evidence: null }] });
  }
  transition(id, to, { reason = null, evidence = null, checkpoint = null } = {}) {
    const workflow = this.read(id); if (!workflow) throw new Error(`workflow not found: ${id}`);
    if (!WORKFLOW_STATES.includes(to)) throw new Error(`unknown workflow state: ${to}`);
    if (!(TRANSITIONS[workflow.state] || []).includes(to)) throw new Error(`invalid workflow transition ${workflow.state} → ${to}`);
    const at = this.now().toISOString(); const from = workflow.state;
    workflow.state = to; workflow.error = to === 'FAILED' ? (reason || 'failed') : workflow.error;
    workflow.history.push(redactSecrets({ at, from, to, reason, evidence }));
    if (checkpoint || ['CONTEXT_READY', 'QUEUED', 'READY_FOR_PR', 'COMPLETED'].includes(to)) workflow.lastSafeCheckpoint = checkpoint || to;
    return this.write(workflow);
  }
  setArtifact(id, name, artifact) { const workflow = this.read(id); if (!workflow) throw new Error(`workflow not found: ${id}`); workflow.artifacts[name] = redactSecrets(artifact); return this.write(workflow); }
  addTask(id, task) {
    const workflow = this.read(id); if (!workflow) throw new Error(`workflow not found: ${id}`);
    assertWorkflowTask(task);
    if (task.workflowId !== id) throw new Error('task workflowId mismatch');
    if (workflow.tasks.some((t) => t.id === task.id)) throw new Error(`task already exists: ${task.id}`);
    const known = new Set(workflow.tasks.map((t) => t.id));
    for (const dep of task.dependencies || []) if (!known.has(dep)) throw new Error(`unknown task dependency: ${dep}`);
    workflow.tasks.push(redactSecrets(task)); return this.write(workflow);
  }
  updateTask(id, taskId, patch) {
    const workflow = this.read(id); if (!workflow) throw new Error(`workflow not found: ${id}`);
    const task = workflow.tasks.find((t) => t.id === taskId); if (!task) throw new Error(`task not found: ${taskId}`);
    Object.assign(task, redactSecrets(patch), { updatedAt: this.now().toISOString() }); return this.write(workflow);
  }
  runnableTasks(id) {
    const workflow = this.read(id); if (!workflow) return [];
    const done = new Set(workflow.tasks.filter((t) => t.status === 'COMPLETED').map((t) => t.id));
    return workflow.tasks.filter((t) => ['QUEUED', 'RETRY'].includes(t.status) && (t.dependencies || []).every((dep) => done.has(dep)));
  }
  requestCancellation(id, by = 'operator') {
    const workflow = this.read(id); if (!workflow) throw new Error(`workflow not found: ${id}`);
    workflow.cancellationRequested = true; workflow.cancelledBy = by; workflow.cancelRequestedAt = this.now().toISOString();
    if (!TERMINAL_STATES.includes(workflow.state) && (TRANSITIONS[workflow.state] || []).includes('CANCELLED')) {
      const from = workflow.state; workflow.state = 'CANCELLED'; workflow.history.push({ at: this.now().toISOString(), from, to: 'CANCELLED', reason: `cancelled by ${by}`, evidence: null });
    }
    return this.write(workflow);
  }
  approve(id, { kind, by, scope, expiresAt = null } = {}) {
    const workflow = this.read(id); if (!workflow) throw new Error(`workflow not found: ${id}`);
    if (!kind || !by) throw new Error('approval kind and by are required');
    const approval = { id: `approval-${Date.now().toString(36)}`, kind, by, scope: scope || null, at: this.now().toISOString(), expiresAt };
    workflow.approvals.push(redactSecrets(approval)); this.write(workflow); return approval;
  }
  hasApproval(id, kind) {
    const workflow = this.read(id); if (!workflow) return false; const now = +this.now();
    return workflow.approvals.some((a) => a.kind === kind && (!a.expiresAt || +new Date(a.expiresAt) > now));
  }
  recoverInterrupted() {
    const recovered = [];
    for (const workflow of this.list()) {
      if (TERMINAL_STATES.includes(workflow.state) || ['RECEIVED', 'CONTEXT_READY', 'AWAITING_APPROVAL', 'AWAITING_DEPLOY_APPROVAL', 'READY_FOR_PR', 'QUEUED'].includes(workflow.state)) continue;
      const from = workflow.state;
      workflow.state = ['RECEIVED', 'CONTEXT_READY', 'QUEUED'].includes(workflow.lastSafeCheckpoint) ? workflow.lastSafeCheckpoint : 'RECEIVED';
      workflow.history.push({ at: this.now().toISOString(), from, to: workflow.state, reason: 'process restart recovery from last safe checkpoint', evidence: { lastSafeCheckpoint: workflow.lastSafeCheckpoint } });
      this.write(workflow); recovered.push(workflow.id);
    }
    return recovered;
  }
}

export function requiresProductionApproval(workflow, action) {
  return ['PRODUCTION_WRITE', 'DESTRUCTIVE'].includes(action?.permission) && !workflow?.approvals?.some((a) => a.kind === 'production' && (!a.expiresAt || +new Date(a.expiresAt) > Date.now()));
}
