import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherLocalContext, brainContext } from './context-gather.mjs';

test('gathers an explicit repo file as fresh read-only evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'seen-context-'));
  try {
    mkdirSync(join(root, 'engine'));
    writeFileSync(join(root, 'engine', 'server.mjs'), 'export const LIVE_MARKER = 20;\n');
    const out = gatherLocalContext('look at file engine/server.mjs', { roots: [root], home: root });
    assert.match(out, /READ-ONLY LOCAL EVIDENCE/);
    assert.match(out, /LIVE_MARKER = 20/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('searches identifiers only inside configured repos', () => {
  const root = mkdtempSync(join(tmpdir(), 'seen-context-'));
  try {
    writeFileSync(join(root, 'one.mjs'), 'function platformStatus() {}\n');
    const out = gatherLocalContext('where is `platformStatus` implemented in the code?', { roots: [root], home: root });
    assert.match(out, /SEARCH/);
    assert.match(out, /one\.mjs:1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('search falls back to bounded Node reads when ripgrep is not installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'seen-context-'));
  try {
    writeFileSync(join(root, 'one.mjs'), 'export function livePlatformSnapshot() {}\n');
    const execFile = () => { const error = new Error('spawn rg ENOENT'); error.code = 'ENOENT'; throw error; };
    const out = gatherLocalContext('find `livePlatformSnapshot` in the repo', { roots: [root], home: root, execFile });
    assert.match(out, /SEARCH/);
    assert.match(out, /one\.mjs:1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unrelated chat does not trigger a broad local scan', () => {
  assert.equal(gatherLocalContext('what should our growth strategy be?', { roots: [] }), '');
});

test('credential and key files are never injected into a model prompt', () => {
  const root = mkdtempSync(join(tmpdir(), 'seen-context-'));
  try {
    writeFileSync(join(root, '.env'), 'GITHUB_TOKEN=secret-value\n');
    const out = gatherLocalContext(`read file ${join(root, '.env')}`, { roots: [root], home: root });
    assert.equal(out, '');
    assert.doesNotMatch(out, /secret-value/);
    const execFile = () => { const error = new Error('spawn rg ENOENT'); error.code = 'ENOENT'; throw error; };
    const searched = gatherLocalContext('find `secret-value` in the repo', { roots: [root], home: root, execFile });
    assert.equal(searched, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// brainContext — the brain as chat context
//
// The live Board Room lane (Cline) gets no brain MCP tools, so the chat used to answer from the
// platform snapshot alone. That is how a stale user count survived while the brain
// itself correctly held the current one. These lock in that the brain reaches the chat and outranks the snapshot.
// ---------------------------------------------------------------------------

const BRAIN_FACTS = [
  { subject: 'Seen', predicate: 'paid_users', object: '15' },
  { subject: 'Seen', predicate: 'users_total', object: '1200', note: 'seen-command-observations.md' },
  { subject: 'Seen Jobs listings', predicate: 'has real trust-score coverage of', object: '42%' },
];

test('brainContext ranks question-relevant facts above irrelevant ones', () => {
  const out = brainContext('how many users do we have?', BRAIN_FACTS);
  const bullets = out.split('\n').filter((l) => l.startsWith('•'));
  const rank = (re) => bullets.findIndex((l) => re.test(l));
  // Both user facts legitimately match "users" and tie, so their relative order is not meaningful.
  // What must hold is that BOTH outrank the fact with no bearing on the question.
  assert.ok(rank(/users_total: 1200/) >= 0, 'the answering fact is present');
  assert.ok(rank(/users_total: 1200/) < rank(/trust-score coverage/), 'relevant beats irrelevant');
  assert.ok(rank(/paid_users/) < rank(/trust-score coverage/), 'relevant beats irrelevant');
});

test('brainContext states that the brain outranks the snapshot', () => {
  const out = brainContext('users?', BRAIN_FACTS);
  assert.match(out, /THE BRAIN IS RIGHT/);
});

test('brainContext is empty with no facts, so the snapshot path is unaffected', () => {
  assert.equal(brainContext('users?', []), '');
  assert.equal(brainContext('users?', null), '');
});

test('brainContext caps output and truncates long objects', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ subject: `S${i}`, predicate: 'p', object: 'x'.repeat(500) }));
  const out = brainContext('anything', many, { max: 5, objectChars: 50 });
  assert.equal(out.split('\n').filter((l) => l.startsWith('•')).length, 5);
  assert.match(out, /…/);
  assert.ok(!out.includes('x'.repeat(60)), 'the long object must be truncated');
});

test('brainContext includes the note so the chat can cite where a fact lives', () => {
  assert.match(brainContext('users', BRAIN_FACTS), /\[seen-command-observations\.md\]/);
});

test('brainContext weights a fact NAME above its body, so the metric beats prose that merely mentions it', () => {
  const facts = [
    // Long prose that happens to contain "users" several times in its object.
    { subject: 'Seen resume export', predicate: 'watermark_policy',
      object: 'the footer renders only for free/anonymous users; Pro users get a clean résumé, and users on trial keep users-level branding' },
    { subject: 'Seen', predicate: 'users_total', object: '1200' },
  ];
  const bullets = brainContext('how many users do we have?', facts).split('\n').filter((l) => l.startsWith('•'));
  assert.match(bullets[0], /users_total: 1200/,
    'the metric must outrank long prose, or a free model is handed the wrong figure');
});

// summarizeTranscript lives in scripts/session-hook.mjs — tested here because that file is also an
// importable module and this suite already runs in the gate.
test('session-hook summarizeTranscript distills ask, outcome, and tool counts', async () => {
  const { summarizeTranscript } = await import('../scripts/session-hook.mjs');
  const rows = [
    { type: 'user', message: { content: [{ type: 'text', text: 'fix the users count' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done — 7 from the brain.' }] } },
  ];
  const s = summarizeTranscript(rows);
  assert.equal(s.ask, 'fix the users count');
  assert.equal(s.outcome, 'Done — 7 from the brain.');
  assert.equal(s.toolCalls, 3);
  assert.match(s.tools, /Bash×2/);
});

test('session-hook summarizeTranscript is safe on malformed rows', async () => {
  const { summarizeTranscript } = await import('../scripts/session-hook.mjs');
  const s = summarizeTranscript([null, {}, { type: 'assistant' }, { type: 'assistant', message: { content: 'not-array' } }]);
  assert.equal(s.ask, '');
  assert.equal(s.outcome, '');
  assert.equal(s.toolCalls, 0);
});
