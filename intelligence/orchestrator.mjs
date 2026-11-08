// INTELLIGENCE WORKFLOW — a durable, inspectable record around the ONE coding pipeline.
//
// This file used to BE a second coding system: its own planner, its own lexical context builder (two
// 36-line windows per file), a whole-file-replacement editor driven by a 14B model, its own test gate,
// its own reviewer and its own security scan — none of which shared a safeguard with engine/builder.mjs.
// Measured on 2026-09: nine runs at one trivial helper, eight failures, ~168k input tokens; the first
// run planned five unrelated tasks (lint engine, git episodes, hardware detection), was accepted because
// the plan was valid JSON, and passed 65 test files without implementing the function at all.
//
// A safeguard added to one engine does not protect the others, so there is now one engine. What was
// worth keeping here is the WORKFLOW: a state machine with history, checkpoints and recovery that the
// server and dashboard read. runVerticalSlice keeps that contract and delegates every coding decision
// — grounding, write scope, gate, proof, semantic review — to engine/builder.mjs.
import { WorkflowStore } from './workflow-store.mjs';
import { runBuild, explainBuildFailure } from '../engine/builder.mjs';
import { config } from '../lib/config.mjs';

export const CODING_TIMEOUT_MS = 600000;

// Builder progress lines → the workflow states they genuinely correspond to. A state is entered when
// the pipeline reports the step, never on a timer and never for decoration.
const MILESTONES = [
  { re: /\[builder\] contract:/, to: ['CONTEXT_READY', 'PLANNING', 'QUEUED', 'EXECUTING'], reason: 'task contract compiled from the repository' },
  { re: /\[builder\] (SEMANTIC GATE|REVIEWER|reviewer)/, to: ['TESTING', 'REVIEWING'], reason: 'gate green; semantic review' },
];

export async function runVerticalSlice({ objective, repoRoot, workflowId, store = new WorkflowStore(), buildFn = runBuild, dryRun = true, onEvent = null } = {}) {
  if (!objective) throw new Error('runVerticalSlice needs an objective');
  const id = workflowId || `wf-slice-${Date.now().toString(36)}`;
  store.create({ id, objective, repoRoot: repoRoot || config.commandRepoDir(), riskLevel: 'LOW', permission: 'BRANCH_WRITE', budget: { remoteUsd: 0 }, metadata: { verticalSlice: true, engine: 'engine/builder.mjs', dryRun } });
  const entered = new Set(['RECEIVED']);
  const go = (to, extra = {}) => { if (entered.has(to)) return; entered.add(to); store.transition(id, to, extra); };
  go('CONTEXT_BUILDING', { reason: 'grounding the objective in the repository' });

  // The builder resolves its checkout from config; a slice aimed at another checkout points it there.
  const prevRepo = process.env.SEEN_COMMAND_REPO_DIR;
  if (repoRoot) process.env.SEEN_COMMAND_REPO_DIR = repoRoot;
  try {
    const out = await buildFn({ task: objective, repo: 'tool', dryRun, onEvent: (m) => {
      if (typeof onEvent === 'function') { try { onEvent(m); } catch { /* observer errors never fail a build */ } }
      for (const ms of MILESTONES) if (ms.re.test(m)) for (const to of ms.to) go(to, { reason: ms.reason, evidence: { line: String(m).slice(0, 240) } });
    } });
    for (const to of ['CONTEXT_READY', 'PLANNING', 'QUEUED', 'EXECUTING', 'TESTING', 'REVIEWING', 'SECURITY_CHECK']) go(to, { reason: 'performed inside the builder pipeline' });
    const contract = out.contract ? { kind: out.contract.kind, grounded: out.contract.grounded, targets: out.contract.targets.map((t) => t.path), allowedFiles: out.contract.allowedFiles, completion: out.contract.completion } : null;
    // ONE task, because one change was built. The old planner emitted up to six "subtasks" and then applied
    // every edit as one global batch attributed to tasks[0] — structure on paper, a one-shot change in fact.
    store.addTask(id, { id: 'task-1', workflowId: id, objective, riskLevel: 'LOW', permissions: 'BRANCH_WRITE', status: 'COMPLETED', dependencies: [],
      acceptanceCriteria: contract ? contract.completion : [], requiredTests: contract ? contract.allowedFiles.filter((f) => /\.test\./.test(f)) : [],
      modelPolicy: { selectedBy: 'engine/builder.mjs lane routing' }, executionBudget: { remoteUsd: 0 } });
    const evidence = { touched: out.touched, engine: out.engine, stat: out.stat || null, pr: out.pr || null, contract };
    go('READY_FOR_PR', { reason: 'contract satisfied: gate green, proof bites, semantic review approved', evidence });
    const wf = store.read(id);
    wf.artifacts = { ...(wf.artifacts || {}), prPackage: { summary: out.summary, ...evidence, dryRun } };
    store.write(wf);
    // A dry run has nothing further to prove. A real PR is NOT complete: it stays READY_FOR_PR until
    // its completion conditions are OBSERVED (engine/completion.mjs) — code committed is not code working.
    if (dryRun) go('COMPLETED', { reason: 'dry run: committed in an isolated worktree, nothing pushed', evidence: { stat: out.stat || null } });
    return store.read(id);
  } catch (error) {
    const why = explainBuildFailure(error);
    try { store.transition(id, 'FAILED', { reason: (why && why.reason) || error.message, evidence: { kind: why ? why.kind : null, blocked: !!(why && why.blocked), refusal: !!error.refusal, detail: String(error.message).slice(0, 600) } }); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    if (prevRepo === undefined) delete process.env.SEEN_COMMAND_REPO_DIR; else process.env.SEEN_COMMAND_REPO_DIR = prevRepo;
  }
}

export function resumableWorkflows(store = new WorkflowStore()) { return store.recoverInterrupted(); }
