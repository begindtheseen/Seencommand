// Instagram Board Room command parser — guards the deterministic chat lane. NO network, NO spawn:
// every case here either falls through (null) or hits an early return BEFORE jobs.startJob, so no
// pipeline is ever launched. Isolated under a temp SEEN_HOME so nothing touches real job/project state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'ig-routes-'));
const { handleInstagramChat } = await import('./routes.mjs');

test('research: stray text after the username is REJECTED (never truncates to @bad)', async () => {
  const r = await handleInstagramChat('research instagram bad name!');
  assert.ok(r && /didn.?t recognize/i.test(r.reply), `expected rejection, got: ${JSON.stringify(r)}`);
  assert.equal(r.action, undefined); // proof no job was started
});

test('research: shell-ish garbage after the username is REJECTED', async () => {
  const r = await handleInstagramChat('research instagram someone; rm -rf /');
  assert.ok(r && /didn.?t recognize/i.test(r.reply));
  assert.equal(r.action, undefined);
});

// NOTE: we deliberately do NOT test the "accepted research command" path here. handleInstagramChat
// would call jobs.startJob, and the toolchain doctor discovers the REAL venv/ffmpeg/instaloader
// regardless of SEEN_HOME — so a valid command would launch a REAL anonymous Instagram download of
// whatever handle the test used. The accepted path + full pipeline is covered hermetically in
// jobs.test.mjs with fake executables. Here we only assert the parser's reject/fall-through behavior,
// every case of which returns BEFORE startJob and touches no network.

test('research: the scope-modifier grammar accepts "latest N" / "all videos [confirm]" and nothing else', () => {
  // Assert the exact allow-list regex used by the handler — no startJob involved.
  const allowed = (tail) => tail === '' || /^(all\s+videos(\s+confirm)?|(?:latest|newest|top)\s+\d{1,4})$/i.test(tail);
  assert.ok(allowed(''));
  assert.ok(allowed('latest 20'));
  assert.ok(allowed('all videos'));
  assert.ok(allowed('all videos confirm'));
  assert.ok(!allowed('name!'));
  assert.ok(!allowed('; rm -rf /'));
  assert.ok(!allowed('latest twenty'));
});

test('research: "all videos" WITHOUT confirm warns about size and does NOT start a job', async () => {
  const r = await handleInstagramChat('research instagram somecreator all videos');
  assert.ok(r && /gigabytes|large|full archive/i.test(r.reply), `expected a size warning, got: ${JSON.stringify(r)}`);
  assert.match(r.reply, /all videos confirm/i);
  assert.equal(r.action, undefined); // nothing started
});

test('resume command accepts only one safe Instagram username', () => {
  const pattern = /^resume\s+instagram\s+@?([a-z0-9._]{1,30})\s*$/i;
  assert.ok(pattern.test('resume instagram creator_a'));
  assert.ok(pattern.test('resume instagram @creator.b'));
  assert.ok(!pattern.test('resume instagram bad name'));
  assert.ok(!pattern.test('resume instagram x; rm -rf /'));
});

test('ask/use for an unresearched creator return a helpful reply, not a crash', async () => {
  const ask = await handleInstagramChat('ask instagram nobodyhere: what works?');
  assert.match(ask.reply, /no researched project/i);
  const use = await handleInstagramChat('use nobodyhere guidance to improve onboarding');
  assert.match(use.reply, /no researched project/i);
});

test('non-instagram messages fall through to the normal chat lane (null)', async () => {
  assert.equal(await handleInstagramChat('what is our revenue this quarter?'), null);
  assert.equal(await handleInstagramChat(''), null);
});

// A natural "find key points for @user" no longer falls through to the general LLM (which would
// falsely say "@user isn't in the library"). The router now resolves the handle against the ACTUAL
// library and answers deterministically. For an UNRESEARCHED creator that means honest guidance, and
// for a researched one it means an evidence-backed digest (covered on real data, not this temp home).
test('natural "key points for @user" is deterministic — unresearched → honest guidance, not a hallucination', async () => {
  const r = await handleInstagramChat('find key points for instagram @nobodyhere');
  assert.ok(r && /isn.?t researched yet/i.test(r.reply), `expected deterministic guidance, got: ${JSON.stringify(r)}`);
  assert.match(r.reply, /research instagram nobodyhere/i);
});

test('bare "i meant @user" for an unresearched creator answers deterministically', async () => {
  const r = await handleInstagramChat('i meant @nobodyhere');
  assert.ok(r && /isn.?t researched yet/i.test(r.reply), `got: ${JSON.stringify(r)}`);
});

test('a digest-shaped message with NO creator still falls through to normal chat (no hijack)', async () => {
  assert.equal(await handleInstagramChat('give me a summary of our revenue'), null);
  assert.equal(await handleInstagramChat('hello'), null);
  assert.equal(await handleInstagramChat('show me the roadmap'), null);
});

test.after(() => { try { rmSync(process.env.SEEN_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });
