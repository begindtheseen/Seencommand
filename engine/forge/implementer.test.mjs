// Tests for the Forge implementer — the best-of-N verified loop. Everything external is faked: a
// scripted reasonFn stands in for the model, a scripted verify stands in for the gate, and the repo
// is a throwaway temp git checkout. NO network, NO model, NO Ollama — the invariants under test are
// the loop's own: first green wins, red candidates are reverted byte-for-byte, failures become the
// next candidate's feedback, and exhaustion throws honestly with the tree left clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEdits } from '../coder.mjs';
import { implementStep, revertTouched, focusedVerify, PROTOCOL } from './implementer.mjs';

// ---- fixture: a real (temp) git repo, because revert semantics ARE git semantics ----------------
const ORIGINAL = 'export const x = 1;\nexport const y = 2;\n';
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }); }
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-impl-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.mjs'), ORIGINAL);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// A scripted model: replies in order, records every args object so tests can inspect the prompts.
function scriptedReason(replies, calls) {
  let i = 0;
  return async (args) => { calls.push(args); const text = replies[Math.min(i++, replies.length - 1)]; return { text, engine: 'fake' }; };
}

// Protocol-shaped replies (built with the same markers PROTOCOL teaches).
const EDIT_X2 = `*** SUMMARY: bump x
*** FILE: a.mjs
<<<<<<< SEARCH
export const x = 1;
=======
export const x = 2;
>>>>>>> REPLACE`;
const EDIT_Y9 = `*** SUMMARY: bump y
*** FILE: a.mjs
<<<<<<< SEARCH
export const y = 2;
=======
export const y = 9;
>>>>>>> REPLACE`;
const EDIT_BAD_ANCHOR = `*** SUMMARY: hallucinated anchor
*** FILE: a.mjs
<<<<<<< SEARCH
export const z = 999; // this text does not exist in the file
=======
export const z = 1000;
>>>>>>> REPLACE`;
const NEWFILE_FRESH = `*** SUMMARY: add fresh module
*** NEWFILE: fresh.mjs
<<<<<<< CONTENT
export const fresh = true;
=======
>>>>>>> END`;

test('candidate 1 red → reverted (content provably restored), candidate 2 green → {candidate: 2}', async () => {
  const dir = makeRepo();
  const calls = [];
  const seenByCandidate2 = { content: null };
  const reasonFn = async (args) => {
    calls.push(args);
    if (calls.length === 2) seenByCandidate2.content = readFileSync(join(dir, 'a.mjs'), 'utf8'); // what the tree held when candidate 2 sampled
    return { text: calls.length === 1 ? EDIT_X2 : EDIT_Y9, engine: 'fake' };
  };
  let verifyCalls = 0;
  const verify = ({ touched }) => {
    verifyCalls++;
    assert.deepEqual(touched, ['a.mjs']);
    return verifyCalls === 1 ? { green: false, errors: ['TESTS: x must stay 1 (fake red)'] } : { green: true, errors: [] };
  };
  const events = [];
  const r = await implementStep({
    step: { title: 'bump a value', doneMeans: 'a.mjs exports the new value', targetFiles: ['a.mjs'], hints: ['keep it minimal'] },
    task: 'demo task', repoRoot: dir, context: '----- a.mjs -----\n' + ORIGINAL,
    reasonFn, candidates: 3, verify, assertWritable: () => {}, onEvent: (m) => events.push(m),
  });
  assert.equal(r.candidate, 2);
  assert.equal(r.engine, 'fake');
  assert.deepEqual(r.touched, ['a.mjs']);
  // The PROOF of precise revert: candidate 2 sampled against the ORIGINAL text (candidate 1 had set
  // x = 2; a lingering x = 2 would also have made candidate 2's y-edit apply on top of dirty state).
  assert.equal(seenByCandidate2.content, ORIGINAL);
  // The green candidate's edit STAYS; the red one is gone.
  const final = readFileSync(join(dir, 'a.mjs'), 'utf8');
  assert.match(final, /y = 9/);
  assert.match(final, /x = 1/); // candidate 1's x = 2 did not survive
  // candidate 2's prompt carried candidate 1's verify-red feedback
  assert.match(calls[1].prompt, /x must stay 1/);
  assert.match(calls[1].prompt, /REVERTED/);
  // reasonFn contract pinned (the coder-lane routing args)
  assert.equal(calls[0].deptId, 'product');
  assert.equal(calls[0].coder, true);
  assert.equal(calls[0].competence, 'code');
  assert.equal(calls[0].maxTokens, 4000);
  assert.equal(calls[0].fallback, '');
  // narration covers the phases
  assert.ok(events.some((m) => /candidate 1\/3/.test(m)));
  assert.ok(events.some((m) => /verify red/.test(m)));
  assert.ok(events.some((m) => /reverted a\.mjs/.test(m)));
  assert.ok(events.some((m) => /verify GREEN/.test(m)));
});

test('all N red → throws with per-candidate reasons AND the tree is clean', async () => {
  const dir = makeRepo();
  const calls = [];
  const reasonFn = scriptedReason([EDIT_X2, EDIT_Y9, EDIT_X2], calls);
  let n = 0;
  const verify = () => ({ green: false, errors: [`RED reason ${++n}`, 'second error (also fed back)'] });
  await assert.rejects(
    () => implementStep({ step: { title: 'doomed step' }, task: 't', repoRoot: dir, reasonFn, candidates: 3, verify, assertWritable: () => {} }),
    (e) => {
      assert.match(e.message, /all 3 candidate\(s\) failed/);
      assert.match(e.message, /candidate 1: verify red — RED reason 1/);
      assert.match(e.message, /candidate 2: verify red — RED reason 2/);
      assert.match(e.message, /candidate 3: verify red — RED reason 3/);
      return true;
    },
  );
  // Every red candidate was reverted — nothing of any attempt survives in the working tree.
  assert.equal(git(dir, 'status', '--porcelain').trim(), '');
  assert.equal(readFileSync(join(dir, 'a.mjs'), 'utf8'), ORIGINAL);
});

test('apply-failure feedback (with the real why text) reaches candidate 2\'s prompt', async () => {
  const dir = makeRepo();
  const calls = [];
  const reasonFn = scriptedReason([EDIT_BAD_ANCHOR, EDIT_Y9], calls);
  const verify = () => ({ green: true, errors: [] });
  const r = await implementStep({ step: { title: 'anchor drift' }, task: 't', repoRoot: dir, reasonFn, candidates: 3, verify, assertWritable: () => {} });
  assert.equal(r.candidate, 2);
  // candidate 1 applied NOTHING (SEARCH not found) → candidate consumed, failure quoted verbatim
  assert.match(calls[1].prompt, /SEARCH block not found/);
  assert.match(calls[1].prompt, /a\.mjs/);
  // the variation steer differs by index — candidate 2 is explicitly told to try differently
  assert.match(calls[1].prompt, /DIFFERENT approach/);
  assert.ok(!/DIFFERENT approach/.test(calls[0].prompt)); // candidate 1 got no steer
});

test('off-format reply consumes a candidate with format feedback', async () => {
  const dir = makeRepo();
  const calls = [];
  const reasonFn = scriptedReason(['Sure! I would edit a.mjs like this…', EDIT_Y9], calls);
  const r = await implementStep({ step: { title: 'format drift' }, task: 't', repoRoot: dir, reasonFn, candidates: 2, verify: () => ({ green: true, errors: [] }), assertWritable: () => {} });
  assert.equal(r.candidate, 2);
  assert.match(calls[1].prompt, /no valid edit blocks/);
  assert.match(calls[1].prompt, /protocol format/);
});

test('an untracked new file from a red candidate is deleted by the revert', async () => {
  const dir = makeRepo();
  const calls = [];
  const reasonFn = scriptedReason([NEWFILE_FRESH, EDIT_Y9], calls);
  let v = 0;
  const verify = ({ touched }) => {
    v++;
    if (v === 1) {
      assert.deepEqual(touched, ['fresh.mjs']);
      assert.ok(existsSync(join(dir, 'fresh.mjs'))); // it really reached the tree before verify
      return { green: false, errors: ['LINT: fresh.mjs is phantom (fake red)'] };
    }
    return { green: true, errors: [] };
  };
  const r = await implementStep({ step: { title: 'new file' }, task: 't', repoRoot: dir, reasonFn, candidates: 2, verify, assertWritable: () => {} });
  assert.equal(r.candidate, 2);
  assert.ok(!existsSync(join(dir, 'fresh.mjs'))); // untracked → rm'd by revertTouched, not left as junk
  assert.match(readFileSync(join(dir, 'a.mjs'), 'utf8'), /y = 9/); // the green edit stays
});

test('PROTOCOL round-trips through the REAL parseEdits (lockstep pin)', () => {
  // A reply written exactly in the taught format must parse — if coder.mjs's markers ever drift from
  // this module's PROTOCOL, this test is the tripwire.
  const reply = `*** SUMMARY: demo
*** FILE: lib/demo.mjs
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
*** NEWFILE: lib/fresh.mjs
<<<<<<< CONTENT
export const fresh = 1;
=======
>>>>>>> END`;
  const p = parseEdits(reply);
  assert.equal(p.summary, 'demo');
  assert.equal(p.edits.length, 1);
  assert.deepEqual(p.edits[0], { path: 'lib/demo.mjs', search: 'const a = 1;', replace: 'const a = 2;' });
  assert.equal(p.newFiles.length, 1);
  assert.equal(p.newFiles[0].path, 'lib/fresh.mjs');
  assert.equal(p.newFiles[0].content, 'export const fresh = 1;');
  // and the PROTOCOL text itself teaches those exact markers
  for (const marker of ['*** FILE:', '*** NEWFILE:', '<<<<<<< SEARCH', '<<<<<<< CONTENT', '=======', '>>>>>>> REPLACE', '>>>>>>> END']) {
    assert.ok(PROTOCOL.includes(marker), `PROTOCOL must teach ${marker}`);
  }
});

test('revertTouched: tracked → checkout, untracked → rm, other paths untouched', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 42;\n'); // tracked, modified
  writeFileSync(join(dir, 'junk.mjs'), 'export const junk = 1;\n'); // untracked
  writeFileSync(join(dir, 'bystander.mjs'), 'export const keep = 1;\n'); // untracked, NOT in touched
  revertTouched(dir, ['a.mjs', 'junk.mjs']);
  assert.equal(readFileSync(join(dir, 'a.mjs'), 'utf8'), ORIGINAL); // restored to HEAD
  assert.ok(!existsSync(join(dir, 'junk.mjs'))); // untracked touched → deleted
  assert.ok(existsSync(join(dir, 'bystander.mjs'))); // never touches a path it wasn't given
});

test('focusedVerify adapts a builder-style gate to the verify({repoRoot, touched}) shape', () => {
  const seen = [];
  const gate = (root, touched) => { seen.push({ root, touched }); return { green: true, errors: [] }; };
  const verify = focusedVerify('/repo', { gate });
  const out = verify({ repoRoot: '/repo', touched: ['a.mjs'] });
  assert.deepEqual(out, { green: true, errors: [] });
  assert.deepEqual(seen, [{ root: '/repo', touched: ['a.mjs'] }]);
});

// ---- REPLACEFN: the attempts-7-10 lesson — deterministic whole-function swap for giant files ----
const { parseReplaceFns, functionSpan, applyReplaceFns } = await import('./implementer.mjs');
const { mkdirSync } = await import('node:fs');

test('parseReplaceFns extracts blocks and leaves the rest for parseEdits', () => {
  const reply = `*** SUMMARY: swap renderer
*** REPLACEFN: scripts/big.mjs :: renderKPIs
<<<<<<< CONTENT
function renderKPIs(list) {
  return list.map((k) => \`<div>\${k}</div>\`).join('');
}
=======
>>>>>>> END
*** FILE: lib/other.mjs
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE`;
  const { fns, rest } = parseReplaceFns(reply);
  assert.equal(fns.length, 1);
  assert.equal(fns[0].path, 'scripts/big.mjs');
  assert.equal(fns[0].fn, 'renderKPIs');
  assert.match(fns[0].content, /function renderKPIs\(list\)/);
  assert.match(fns[0].content, /join\(''\)/);
  assert.match(rest, /\*\*\* FILE: lib\/other\.mjs/, 'non-REPLACEFN blocks flow through untouched');
  assert.ok(!/REPLACEFN/.test(rest));
});

test('functionSpan finds function/const/window forms, brace-balanced; ambiguous and missing refuse', () => {
  const src = [
    '// header', 'function alpha(x) {', '  if (x) { return 1; }', '  return 2;', '}',
    'const beta = (y) => {', '  return `t ${y}`;', '};', 'window.gamma = function () {', '  return 3;', '};',
  ].join('\n');
  assert.deepEqual(functionSpan(src, 'alpha'), { start: 1, end: 4 });
  assert.deepEqual(functionSpan(src, 'beta'), { start: 5, end: 7 });
  assert.deepEqual(functionSpan(src, 'gamma'), { start: 8, end: 10 });
  assert.equal(functionSpan(src, 'nope'), null);
  assert.equal(functionSpan(`function dup() {}\nfunction dup() {}`, 'dup'), 'ambiguous');
});

test('applyReplaceFns swaps ONLY the named function — template literals and neighbors intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rfn-'));
  const before = [
    'const KEEP_TOP = 1;',
    'function target(rows) {',
    "  let h = '';",
    "  rows.forEach(function(r){h+='<div class=\"kp\">'+r+'</div>';});",
    '  return h;',
    '}',
    'const KEEP_BOTTOM = `template ${KEEP_TOP} stays`;',
  ].join('\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'big.mjs'), `${before}\n`);
  const { touched, failures } = applyReplaceFns(dir, [{ path: 'scripts/big.mjs', fn: 'target', content: 'function target(rows) {\n  return rows.map((r) => `<div class="kp">${r} <span class="age">now</span></div>`).join(\'\');\n}' }], () => {});
  assert.deepEqual(failures, []);
  assert.deepEqual(touched, ['scripts/big.mjs']);
  const after = readFileSync(join(dir, 'scripts', 'big.mjs'), 'utf8');
  assert.match(after, /KEEP_TOP = 1/);
  assert.match(after, /KEEP_BOTTOM = `template \$\{KEEP_TOP\} stays`/, 'neighbor template literal untouched');
  assert.match(after, /span class="age"/, 'new body in place');
  assert.ok(!/rows\.forEach/.test(after), 'old body gone');
  // and the result is valid syntax
  execFileSync(process.execPath, ['--check', join(dir, 'scripts', 'big.mjs')], { stdio: 'pipe' });
});

test('applyReplaceFns failure contract: missing file, unknown fn, empty content — feedback, no throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rfn2-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'x.mjs'), 'function real() { return 1; }\n');
  const { touched, failures } = applyReplaceFns(dir, [
    { path: 'lib/absent.mjs', fn: 'a', content: 'function a(){}' },
    { path: 'lib/x.mjs', fn: 'ghost', content: 'function ghost(){}' },
    { path: 'lib/x.mjs', fn: 'real', content: '   ' },
  ], () => {});
  assert.equal(touched.length, 0);
  assert.equal(failures.length, 3);
  assert.match(failures[0].why, /does not exist/);
  assert.match(failures[1].why, /not found/);
  assert.match(failures[2].why, /empty CONTENT/);
});

test('implementStep end-to-end with a REPLACEFN reply: applies, verifies, wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rfn3-'));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'dash.mjs'), 'function kpiRow(k) {\n  return `<b>${k}</b>`;\n}\nexport { kpiRow };\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  const REPLY = `*** SUMMARY: age in kpiRow
*** REPLACEFN: scripts/dash.mjs :: kpiRow
<<<<<<< CONTENT
function kpiRow(k) {
  return \`<b>\${k}</b><i class="age">now</i>\`;
}
=======
>>>>>>> END`;
  const r = await implementStep({
    step: { id: 's1', title: 'age', doneMeans: 'kpiRow shows age', targetFiles: ['scripts/dash.mjs'] },
    task: 't', repoRoot: dir, reasonFn: async () => ({ text: REPLY, engine: 'scripted' }),
    candidates: 1, verify: () => ({ green: true, errors: [] }), assertWritable: () => {}, onEvent: () => {},
  });
  assert.deepEqual(r.touched, ['scripts/dash.mjs']);
  assert.match(readFileSync(join(dir, 'scripts', 'dash.mjs'), 'utf8'), /class="age"/);
});
