// Deterministic task-premise checks shared by the board proposal gate and the builder entrance.
// A concrete-looking path is not proof that the path is real: task #147 named a nonexistent product
// file, so the patch coder fabricated an empty file twice before the reviewer stopped it. Reject that
// shape before any model tokens are spent. Creating a genuinely new file remains allowed when the task
// says so explicitly.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { touchesProtected } from './policy.mjs';

const FILE_TARGET = /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+\.(?:html?|tsx?|jsx?|mjs|cjs|css|sql|md|json|ya?ml))(?=$|[\s`"'),.:;])/gi;
const CREATE_FILE = /\b(?:create|introduce)\s+(?:a\s+)?(?:new\s+)?(?:file|page|module|route|script)\b|\badd\s+(?:a\s+)?new\s+(?:file|page|module|route|script)\b/i;

export function explicitFileTargets(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FILE_TARGET)) {
    const p = m[1].replace(/[.:;,]+$/, '');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function permitsNewFile(text) {
  return CREATE_FILE.test(String(text || ''));
}

// Returns a precise refusal reason, or null when the premise is safe to hand to a coder. The first
// explicit file is the proposal's required concrete anchor and therefore its primary target. Later
// paths often appear only in grounding/evidence, so treating every mentioned path as a write target
// would create false refusals.
export function pathExistsAtGitRef(repoRoot, ref, path, execFn = execFileSync) {
  try { execFn('git', ['rev-parse', '--verify', ref], { cwd: repoRoot, stdio: 'ignore' }); }
  catch { return true; } // cannot validate the ref → fail open on availability, not on the task
  try { execFn('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: repoRoot, stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function targetPremiseProblem({ task, repoRoot, targetExists = null, safePath = null, repoLabel = 'target repo' } = {}) {
  const [target] = explicitFileTargets(task);
  if (!target) return null;
  if (touchesProtected([target]).length) {
    return `the task targets protected owner/safety file \`${target}\`, which the autonomous builder is not allowed to rewrite`;
  }
  if (safePath && !safePath.test(target)) {
    return `the named target \`${target}\` is outside the writable code paths for the ${repoLabel} (the task is likely routed to the wrong repo)`;
  }
  const exists = typeof targetExists === 'function' ? targetExists(target)
    : repoRoot ? existsSync(join(repoRoot, target)) : true;
  if (!exists && !permitsNewFile(task)) {
    return `the task says to change \`${target}\`, but that file does not exist in the ${repoLabel}; name the real existing target or explicitly request creation of a new file`;
  }
  return null;
}
