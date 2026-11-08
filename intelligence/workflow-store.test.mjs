import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowStore, requiresProductionApproval } from './workflow-store.mjs';

const make = () => { const dir = mkdtempSync(join(tmpdir(), 'seen-workflow-')); return { dir, store: new WorkflowStore({ dir }) }; };

test('workflow persists every transition and resumes from its last safe checkpoint after crash', () => {
  const { dir, store } = make();
  try {
    store.create({ id: 'w1', objective: 'x', repoRoot: '/tmp/repo' }); store.transition('w1', 'CONTEXT_BUILDING'); store.transition('w1', 'CONTEXT_READY'); store.transition('w1', 'PLANNING');
    assert.deepEqual(new WorkflowStore({ dir }).recoverInterrupted(), ['w1']);
    const recovered = store.read('w1'); assert.equal(recovered.state, 'CONTEXT_READY'); assert.match(recovered.history.at(-1).reason, /restart recovery/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task graph blocks dependencies, allows retry, and supports partial completion', () => {
  const { dir, store } = make();
  try {
    store.create({ id: 'w1', objective: 'x', repoRoot: '/tmp/repo' });
    const task = (id, dependencies = []) => ({ id, workflowId: 'w1', objective: id, dependencies, riskLevel: 'LOW', permissions: 'BRANCH_WRITE', relevantFiles: [], acceptanceCriteria: ['green'], requiredTests: ['unit'], modelPolicy: {}, executionBudget: {}, status: 'QUEUED' });
    store.addTask('w1', task('a')); store.addTask('w1', task('b', ['a']));
    assert.deepEqual(store.runnableTasks('w1').map((t) => t.id), ['a']);
    store.updateTask('w1', 'a', { status: 'COMPLETED' }); assert.deepEqual(store.runnableTasks('w1').map((t) => t.id), ['b']);
    store.updateTask('w1', 'b', { status: 'RETRY' }); assert.deepEqual(store.runnableTasks('w1').map((t) => t.id), ['b']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation is durable and production deployment requires explicit approval', () => {
  const { dir, store } = make();
  try {
    store.create({ id: 'w1', objective: 'x', repoRoot: '/tmp/repo' });
    assert.equal(requiresProductionApproval(store.read('w1'), { permission: 'PRODUCTION_WRITE' }), true);
    store.approve('w1', { kind: 'production', by: 'owner' }); assert.equal(requiresProductionApproval(store.read('w1'), { permission: 'PRODUCTION_WRITE' }), false);
    store.requestCancellation('w1', 'operator'); assert.equal(store.read('w1').state, 'CANCELLED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed validation cannot transition directly to PR-ready', () => {
  const { dir, store } = make();
  try { store.create({ id: 'w1', objective: 'x', repoRoot: '/tmp/repo' }); assert.throws(() => store.transition('w1', 'READY_FOR_PR'), /invalid workflow transition/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
