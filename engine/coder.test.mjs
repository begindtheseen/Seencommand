import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keywords, parseEdits, applyEdits, closestWindow, codeLocally, stripCodeFence } from './coder.mjs';

test('keywords pulls identifiers, quoted strings, and salient words (drops stopwords)', () => {
  const k = keywords('Make `admin_granted` Pro durable so isPro is not reset to "credits"');
  assert.ok(k.includes('admin_granted'));
  assert.ok(k.includes('isPro'));
  assert.ok(k.includes('credits'));
  assert.ok(!k.includes('make') && !k.includes('reset')); // stopwords
});

test('parseEdits reads SEARCH/REPLACE + NEWFILE + summary blocks', () => {
  const text = `*** SUMMARY: fix it
*** FILE: lib/pay.js
<<<<<<< SEARCH
const pro = sub.active
=======
const pro = sub.active || user.admin_pro
>>>>>>> REPLACE
*** NEWFILE: lib/flag.js
<<<<<<< CONTENT
export const X = 1
=======
>>>>>>> END`;
  const p = parseEdits(text);
  assert.equal(p.summary, 'fix it');
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].path, 'lib/pay.js');
  assert.match(p.edits[0].replace, /admin_pro/);
  assert.equal(p.newFiles.length, 1);
  assert.equal(p.newFiles[0].path, 'lib/flag.js');
});

test('applyEdits replaces exact matches and writes new files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  writeFileSync(join(dir, 'pay.js'), 'const pro = sub.active\nexport { pro }\n');
  const r = applyEdits(dir, {
    edits: [{ path: 'pay.js', search: 'const pro = sub.active', replace: 'const pro = sub.active || user.admin_pro' }],
    newFiles: [{ path: 'flag.js', content: 'export const X = 1' }],
  }, () => {});
  assert.deepEqual(r.failures, []);
  assert.ok(r.touched.includes('pay.js') && r.touched.includes('flag.js'));
  assert.match(readFileSync(join(dir, 'pay.js'), 'utf8'), /admin_pro/);
  assert.match(readFileSync(join(dir, 'flag.js'), 'utf8'), /export const X = 1/);
});

test('applyEdits is whitespace-tolerant on the SEARCH block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  writeFileSync(join(dir, 'a.js'), 'function f() {\n  return 1   \n}\n'); // trailing spaces in file
  const r = applyEdits(dir, { edits: [{ path: 'a.js', search: 'function f() {\n  return 1\n}', replace: 'function f() {\n  return 2\n}' }], newFiles: [] }, () => {});
  assert.deepEqual(r.failures, []);
  assert.match(readFileSync(join(dir, 'a.js'), 'utf8'), /return 2/);
});

test('applyEdits reports a failure when SEARCH is not found (no silent no-op)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  writeFileSync(join(dir, 'a.js'), 'const x = 1\n');
  const r = applyEdits(dir, { edits: [{ path: 'a.js', search: 'const y = 2', replace: 'const y = 3' }], newFiles: [] }, () => {});
  assert.equal(r.touched.length, 0);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].why, /not found/);
});

test('applyEdits reports OFF-LIMITS paths as per-edit failures (never kills the build — task-31)', () => {
  const outer = mkdtempSync(join(tmpdir(), 'coder-'));
  const dir = join(outer, 'repo');
  mkdirSync(dir, { recursive: true });
  const guard = (p) => { if (p.includes('..') || p.startsWith('brain/')) throw new Error('refused: outside safe paths'); };
  const r = applyEdits(dir, {
    edits: [{ path: 'brain/mcp/server.mjs', search: 'a', replace: 'b' }],
    newFiles: [{ path: '../evil.js', content: 'x' }],
  }, guard);
  assert.equal(r.touched.length, 0);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0].why, /OFF-LIMITS/);
  assert.match(r.failures[1].why, /OFF-LIMITS/);
  assert.ok(!existsSync(join(outer, 'evil.js'))); // the rejected write never happened
});

test('applyEdits refuses an empty SEARCH block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  writeFileSync(join(dir, 'a.js'), 'const x = 1\n');
  const r = applyEdits(dir, { edits: [{ path: 'a.js', search: '\n', replace: 'const y = 2' }], newFiles: [] }, () => {});
  assert.equal(r.touched.length, 0);
  assert.match(r.failures[0].why, /SEARCH is empty/);
});

test('applyEdits refuses an empty NEWFILE before it can count as gate-green progress (#147)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  const r = applyEdits(dir, { edits: [], newFiles: [{ path: 'scripts/content-parser.mjs', content: '  \n' }] }, () => {});
  assert.equal(r.touched.length, 0);
  assert.match(r.failures[0].why, /NEWFILE content is empty/);
  assert.equal(existsSync(join(dir, 'scripts/content-parser.mjs')), false);
});

test('applyEdits tolerates the model re-typing lines with WRONG indentation (trimmed-line match)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  writeFileSync(join(dir, 'g.mjs'), '      <div class="greet">Good morning, undefined. <span>hi</span></div>\n');
  const r = applyEdits(dir, { edits: [{ path: 'g.mjs',
    search: '<div class="greet">Good morning, undefined. <span>hi</span></div>',
    replace: '<div class="greet">Good morning, Brandon. <span>hi</span></div>' }], newFiles: [] }, () => {});
  assert.deepEqual(r.failures, []);
  const out = readFileSync(join(dir, 'g.mjs'), 'utf8');
  assert.match(out, /Good morning, Brandon\./);
  assert.match(out, /^ {6}<div/m); // original indentation preserved
});

test('trimmed-line match REFUSES ambiguous spans (never guesses)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  // two identical blocks; the model's search has NO inner indentation, so only the trimmed matcher
  // could apply it — and it must refuse because the span appears twice.
  writeFileSync(join(dir, 'a.mjs'), '  if (a) {\n    x = 1\n  }\n  if (a) {\n    x = 1\n  }\n');
  const r = applyEdits(dir, { edits: [{ path: 'a.mjs', search: 'if (a) {\nx = 1\n}', replace: 'if (a) {\nx = 2\n}' }], newFiles: [] }, () => {});
  assert.equal(r.touched.length, 0);
  assert.match(r.failures[0].why, /MULTIPLE/);
});

// ---- format drift: every shape below burned a WHOLE round under the old strict parser -------------
test('parseEdits tolerates code fences and a header without asterisks', () => {
  const p = parseEdits('```\nFILE: lib/pay.js\n<<<<<<< SEARCH\nconst a = 1\n=======\nconst a = 2\n>>>>>>> REPLACE\n```');
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].path, 'lib/pay.js');
  assert.equal(p.edits[0].search, 'const a = 1');
  assert.equal(p.edits[0].replace, 'const a = 2');
});

test('parseEdits tolerates a bare path line directly above the markers (aider-style drift)', () => {
  const p = parseEdits('api/reports.js\n<<<<<<< SEARCH\nconst x = 1\n=======\nconst x = 2\n>>>>>>> REPLACE');
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].path, 'api/reports.js');
});

test('parseEdits tolerates ### headers, backticked paths, and lowercase markers', () => {
  const p = parseEdits('### file: `lib/x.mjs`\n<<<<<<< search\nold\n=======\nnew\n>>>>>>> replace');
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].path, 'lib/x.mjs');
  assert.equal(p.edits[0].replace, 'new');
});

test('parseEdits skips a FILE block with no ======= separator (never invents a deletion)', () => {
  const p = parseEdits('*** FILE: a.js\n<<<<<<< SEARCH\nsomething\n>>>>>>> REPLACE');
  assert.equal(p.edits.length, 0);
});

test('parseEdits skips a truncated block (never guesses at content)', () => {
  const p = parseEdits('*** FILE: a.js\n<<<<<<< SEARCH\nsomething\n=======\nhalf of a repl');
  assert.equal(p.edits.length, 0);
});

test('parseEdits accepts a NEWFILE without the ======= separator', () => {
  const p = parseEdits('*** NEWFILE: lib/n.mjs\n<<<<<<< CONTENT\nexport const N = 1\n>>>>>>> END');
  assert.equal(p.newFiles.length, 1);
  assert.equal(p.newFiles[0].content, 'export const N = 1');
});

// ---- NEWFILE de-fencing: a markdown-fence wrapper is a coder artifact, never a real file (Seen #194)
test('stripCodeFence removes a leading+trailing wrapper pair, keeps the body', () => {
  const wrapped = '```typescript\nimport { z } from "zod";\nexport default function Page() { return null; }\n```';
  const out = stripCodeFence(wrapped);
  assert.equal(out.split('\n')[0], 'import { z } from "zod";'); // first line is the import, not the fence
  assert.ok(!out.includes('```')); // no fence survived
});

test('stripCodeFence strips a LONE leading fence (no matching close)', () => {
  assert.equal(stripCodeFence('```\nimport x\nexport default x'), 'import x\nexport default x');
});

test('stripCodeFence preserves mid-file fences and only strips a TRUE wrapper (a .md NEWFILE)', () => {
  // no wrapper: first line is not a fence → returned untouched even though a fenced block sits inside
  const md = '# Notes\n```js\nconst x = 1\n```\nmore text';
  assert.equal(stripCodeFence(md), md);
  // wrapped .md: the outer ```markdown … ``` pair is stripped; the INNER ```js block is preserved intact
  const wrappedMd = '```markdown\n# Notes\nHere is code:\n```js\nconst x = 1\n```\nDone.\n```';
  assert.equal(stripCodeFence(wrappedMd), '# Notes\nHere is code:\n```js\nconst x = 1\n```\nDone.');
});

test('stripCodeFence leaves fence-free content exactly as-is', () => {
  const src = 'export const A = 1;\nexport const B = 2;\n';
  assert.equal(stripCodeFence(src), src);
});

test('applyEdits strips the markdown fence a model wrapped a NEWFILE in (the non-compiling Seen #194 .tsx)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  const content = '```typescript\nimport { z } from "zod";\nexport default function Page() { return null; }\n```';
  const r = applyEdits(dir, { edits: [], newFiles: [{ path: 'page.tsx', content }] }, () => {});
  assert.deepEqual(r.failures, []);
  assert.ok(r.touched.includes('page.tsx'));
  const out = readFileSync(join(dir, 'page.tsx'), 'utf8');
  assert.equal(out.split('\n')[0], 'import { z } from "zod";'); // written file starts at the real code
  assert.ok(!out.includes('```')); // the fence never reached disk
});

test('applyEdits keeps a .md NEWFILE with an inner code block intact (only a wrapper would be stripped)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  const content = '# Guide\n```js\nconst x = 1\n```\ndone';
  const r = applyEdits(dir, { edits: [], newFiles: [{ path: 'GUIDE.md', content }] }, () => {});
  assert.deepEqual(r.failures, []);
  const out = readFileSync(join(dir, 'GUIDE.md'), 'utf8');
  assert.match(out, /```js\nconst x = 1\n```/); // the legit inner fence is preserved verbatim
  assert.equal(out.split('\n')[0], '# Guide');
});

// ---- re-anchoring: quote the closest REAL text back at the model ----------------------------------
test('closestWindow finds the real region a drifted SEARCH was aiming at', () => {
  const cur = 'function pay() {\n  const pro = sub.active && !expired\n  return pro\n}\n';
  const w = closestWindow(cur, 'function pay() {\nconst pro = something_wrong\nreturn pro');
  assert.ok(w);
  assert.match(w, /sub\.active && !expired/); // the text the model SHOULD copy
});

test('a not-found failure carries the closest actual text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coder-'));
  writeFileSync(join(dir, 'a.js'), 'const x = 1\nconst y = 2\n');
  const r = applyEdits(dir, { edits: [{ path: 'a.js', search: 'const x = 1\nWRONG LINE', replace: 'z' }], newFiles: [] }, () => {});
  assert.equal(r.touched.length, 0);
  assert.match(r.failures[0].closest, /const x = 1/);
});

// ---- the loop: local-first, hosted rescue on stall -------------------------------------------------
// A scripted reason() stands in for the models; the gate checks real file content. No network, no LLM.
const GOOD_EDIT = { engine: 'hosted:fake', text: '*** SUMMARY: hosted fix\n*** FILE: a.mjs\n<<<<<<< SEARCH\nexport const A = 1;\n=======\nexport const A = 2; // FIXED\n>>>>>>> REPLACE' };
const BAD_EDIT = { engine: 'local:fake', text: '*** SUMMARY: wrong fix\n*** FILE: a.mjs\n<<<<<<< SEARCH\nexport const A = 1;\n=======\nexport const A = 3;\n>>>>>>> REPLACE' };
const GARBAGE = { engine: 'local:fake', text: 'I think the fix would involve changing A. Let me explain my reasoning at length…' };
const DEAD = { engine: 'fallback', text: '' };
const makeFake = (script, calls) => async (o) => {
  calls.push({ localOnly: o.localOnly, hostedOnly: o.hostedOnly });
  return script.length ? script.shift() : DEAD;
};
const contentGate = (dir) => (root) =>
  readFileSync(join(dir, 'a.mjs'), 'utf8').includes('FIXED')
    ? { green: true, errors: [] } : { green: false, errors: ['TESTS: expected A = 2'] };

function seedRepo({ git = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coder-loop-'));
  writeFileSync(join(dir, 'a.mjs'), 'export const A = 1;\n');
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    g('add', '-A'); g('commit', '-m', 'seed');
  }
  return dir;
}

test('loop: two off-format rounds escalate to the hosted lanes, which finish the job', async () => {
  const dir = seedRepo();
  const calls = [];
  const r = await codeLocally({ task: 'fix A', repoRoot: dir, assertWritable: () => {}, gate: contentGate(dir),
    reasonFn: makeFake([GARBAGE, GARBAGE, GOOD_EDIT], calls), escalate: true, retryWaitMs: 1 });
  assert.equal(r.engine, 'hosted:fake');
  assert.match(readFileSync(join(dir, 'a.mjs'), 'utf8'), /FIXED/);
  assert.deepEqual(calls.map((c) => (c.hostedOnly ? 'hosted' : 'local')), ['local', 'local', 'hosted']);
});

test('loop: the gate failing the SAME way twice escalates (and the revert kept the base clean)', async () => {
  const dir = seedRepo({ git: true });
  const calls = [];
  const r = await codeLocally({ task: 'fix A', repoRoot: dir, assertWritable: () => {}, gate: contentGate(dir),
    reasonFn: makeFake([BAD_EDIT, BAD_EDIT, GOOD_EDIT], calls), escalate: true, retryWaitMs: 1 });
  // BAD_EDIT round 2 could only re-apply if round 1 was properly REVERTED (search matches the original)
  assert.equal(r.engine, 'hosted:fake');
  assert.match(readFileSync(join(dir, 'a.mjs'), 'utf8'), /FIXED/);
  assert.deepEqual(calls.map((c) => (c.hostedOnly ? 'hosted' : 'local')), ['local', 'local', 'hosted']);
});

test('loop: a starved local lane escalates within the round instead of dying (task-26)', async () => {
  const dir = seedRepo();
  const calls = [];
  const r = await codeLocally({ task: 'fix A', repoRoot: dir, assertWritable: () => {}, gate: contentGate(dir),
    reasonFn: makeFake([DEAD, DEAD, DEAD, GOOD_EDIT], calls), escalate: true, retryWaitMs: 1 });
  assert.equal(r.engine, 'hosted:fake');
  assert.deepEqual(calls.map((c) => (c.hostedOnly ? 'hosted' : 'local')), ['local', 'local', 'local', 'hosted']);
});

test('loop: dead hosted lanes fall back to the still-answering local model', async () => {
  const dir = seedRepo();
  const calls = [];
  const localGood = { ...GOOD_EDIT, engine: 'local:fake' };
  const r = await codeLocally({ task: 'fix A', repoRoot: dir, assertWritable: () => {}, gate: contentGate(dir),
    reasonFn: makeFake([GARBAGE, GARBAGE, DEAD, localGood], calls), escalate: true, retryWaitMs: 1 });
  assert.equal(r.engine, 'local:fake');
  assert.deepEqual(calls.map((c) => (c.hostedOnly ? 'hosted' : 'local')), ['local', 'local', 'hosted', 'local']);
});

test('loop: CODER_ESCALATE=0 keeps every round strictly local and fails honestly', async () => {
  const dir = seedRepo();
  const calls = [];
  await assert.rejects(
    () => codeLocally({ task: 'fix A', repoRoot: dir, assertWritable: () => {}, gate: contentGate(dir),
      reasonFn: makeFake([GARBAGE, GARBAGE, GARBAGE], calls), escalate: false, retryWaitMs: 1, maxRounds: 3 }),
    /could not reach a green gate in 3 rounds/,
  );
  assert.ok(calls.every((c) => c.localOnly === true && c.hostedOnly === false));
});
