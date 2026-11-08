import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explicitFileTargets, permitsNewFile, targetPremiseProblem, pathExistsAtGitRef } from './task-premise.mjs';

test('explicitFileTargets extracts the concrete primary path without line suffixes', () => {
  assert.deepEqual(explicitFileTargets('Modify org/focus.mjs:69 and compare lib/brain.mjs.'), ['org/focus.mjs', 'lib/brain.mjs']);
});

test('task #147 shape is refused before coder tokens: named product file does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'premise-'));
  const task = 'Add a new function to improve extraction, targeting scripts/content-parser.mjs. Done means: the file has a function.';
  assert.equal(permitsNewFile(task), false, '“new function” is not permission to fabricate a new file');
  assert.match(targetPremiseProblem({ task, repoRoot: root, repoLabel: 'product repo' }), /does not exist/);
});

test('an explicit create-new-file task remains buildable', () => {
  const root = mkdtempSync(join(tmpdir(), 'premise-'));
  const task = 'Create a new script at scripts/content-parser.mjs and wire it into the parser command.';
  assert.equal(permitsNewFile(task), true);
  assert.equal(targetPremiseProblem({ task, repoRoot: root, repoLabel: 'product repo' }), null);
});

test('an existing target passes, while protected and wrong-repo targets refuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'premise-'));
  mkdirSync(join(root, 'engine'), { recursive: true });
  writeFileSync(join(root, 'engine/server.mjs'), 'export {}\n');
  assert.equal(targetPremiseProblem({ task: 'Fix engine/server.mjs', repoRoot: root, safePath: /^engine\//, repoLabel: 'tool repo' }), null);
  assert.match(targetPremiseProblem({ task: 'Modify org/focus.mjs:69', repoRoot: root, repoLabel: 'tool repo' }), /protected/);
  assert.match(targetPremiseProblem({ task: 'Fix app/page.tsx', repoRoot: root, safePath: /^engine\//, repoLabel: 'tool repo' }), /outside the writable/);
});

test('pathExistsAtGitRef checks the base ref, not whichever branch is checked out', () => {
  const calls = [];
  const yes = pathExistsAtGitRef('/repo', 'origin/main', 'engine/server.mjs', (_bin, args) => { calls.push(args.join(' ')); });
  assert.equal(yes, true);
  assert.deepEqual(calls, ['rev-parse --verify origin/main', 'cat-file -e origin/main:engine/server.mjs']);
  const no = pathExistsAtGitRef('/repo', 'origin/main', 'missing.mjs', (_bin, args) => {
    if (args[0] === 'cat-file') throw new Error('missing');
  });
  assert.equal(no, false);
  const unknownRef = pathExistsAtGitRef('/repo', 'origin/main', 'missing.mjs', () => { throw new Error('offline'); });
  assert.equal(unknownRef, true, 'an unavailable ref fails open instead of blocking every proposal');
});
