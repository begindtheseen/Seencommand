import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { compileContract, contractAllows, contractContext, taskKind, namedSymbols } from './task-contract.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'contract-'));
  for (const [p, b] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), b); }
  return root;
}
const FILES = {
  'lib/feed.mjs': 'export function loadFeed() {}\n',
  'lib/feed.test.mjs': "import { loadFeed } from './feed.mjs';\n",
  'lib/clock.mjs': 'export function nowMs() {}\n',
  'engine/run.mjs': "import { loadFeed } from '../lib/feed.mjs';\nimport { nowMs } from '../lib/clock.mjs';\nexport function run() { return loadFeed(nowMs()); }\n",
  'lib/hardware.mjs': 'export function detect() {}\n',
  'a/dup.mjs': 'export function twin() {}\n', 'b/dup.mjs': 'export function twin() {}\n',
};
const safePath = /^(engine|lib|a|b)\/[\w\-/.]+\.(mjs|js|md)$/;

test('a named file grounds the task in its real neighbourhood: tests, callers, imports — and nothing else', () => {
  const root = tree(FILES);
  const { ok, contract } = compileContract({ task: 'Add a staleness cutoff to lib/feed.mjs', repoRoot: root, safePath });
  assert.equal(ok, true);
  assert.equal(contract.grounded, true);
  assert.deepEqual(contract.allowedFiles, ['engine/run.mjs', 'lib/feed.mjs', 'lib/feed.test.mjs']);
  assert.deepEqual(contract.structure['lib/feed.mjs'].consumers, ['engine/run.mjs']);
  assert.equal(contractAllows(contract, 'lib/feed.test.mjs'), true);
  assert.equal(contractAllows(contract, 'lib/hardware.mjs'), false, 'the workflowStateCounts run touched hardware detection — not under a contract');
  assert.match(contractContext(contract), /lib\/feed\.mjs exports \[loadFeed\]; called from \[engine\/run\.mjs\]; tested by \[lib\/feed\.test\.mjs\]/);
});

test('a named SYMBOL grounds the task only when exactly one module exports it', () => {
  const root = tree(FILES);
  const one = compileContract({ task: 'Make `nowMs()` monotonic', repoRoot: root, safePath });
  assert.deepEqual(one.contract.targets.map((t) => t.path), ['lib/clock.mjs']);
  assert.deepEqual(one.contract.symbols, [{ name: 'nowMs', path: 'lib/clock.mjs' }]);
  const ambiguous = compileContract({ task: 'Speed up `twin()`', repoRoot: root, safePath, agenticOk: false });
  assert.equal(ambiguous.ok, false, 'two homes → not grounded → guessing is how unrelated files get edited');
  assert.deepEqual(namedSymbols('call isFresh(row, now) and `loadFeed` please'), ['loadFeed', 'isFresh']);
});

test('an ungrounded task is refused without an exploring agent, and handed ONLY to it when one exists', () => {
  const root = tree(FILES);
  const vague = 'Make the feed experience more robust and engaging';
  const refused = compileContract({ task: vague, repoRoot: root, safePath, agenticOk: false });
  assert.equal(refused.ok, false);
  assert.match(refused.refusal, /cannot be grounded/);
  const explore = compileContract({ task: vague, repoRoot: root, safePath, agenticOk: true });
  assert.equal(explore.ok, true);
  assert.equal(explore.contract.grounded, false);
  assert.equal(contractAllows(explore.contract, 'lib/hardware.mjs'), true, 'an exploring agent is bounded by safePath, not by an empty contract');
  assert.equal(contractContext(explore.contract), '');
});

test('the KIND — and so the proof the gate demands — comes from the task text, never from the coder', () => {
  const t = (path) => [{ path }];
  assert.equal(taskKind('Refactor lib/feed.mjs for readability', t('lib/feed.mjs')), 'refactor');
  assert.equal(taskKind('Simplify the run loop in engine/run.mjs', t('engine/run.mjs')), 'refactor');
  assert.equal(taskKind('Simplify engine/run.mjs and add retries when the feed is empty', t('engine/run.mjs')), 'behaviour', 'a refactor verb cannot launder new behaviour past the test requirement');
  assert.equal(taskKind('Fix the off-by-one in lib/feed.mjs', t('lib/feed.mjs')), 'behaviour');
  assert.equal(taskKind('Update docs/seen-command.md', t('docs/seen-command.md')), 'docs');
  assert.equal(taskKind('Restyle components/Nav.tsx', t('components/Nav.tsx')), 'ui');
});

test('creating a file is scoped to the directories the task names; the completion conditions are explicit', () => {
  const root = tree(FILES);
  const { contract } = compileContract({ task: 'Create a new module lib/cutoff.mjs and use it in lib/feed.mjs', repoRoot: root, repo: 'product', safePath });
  assert.equal(contract.mayCreate, true);
  assert.equal(contractAllows(contract, 'lib/cutoff.mjs'), true);
  assert.equal(contractAllows(contract, 'lib/cutoff.test.mjs'), true);
  assert.equal(contractAllows(contract, 'engine/surprise.mjs'), false);
  assert.ok(contract.completion.some((c) => /migration in the change is APPLIED/.test(c)));
  assert.ok(contract.completion.some((c) => /preview deployment/.test(c)));
});
