// The UNMOCKED end-to-end proof: the REAL modules composed through the REAL orchestrator on a real
// temp git repo — real planTask JSON parsing, real implementStep (real parseEdits/applyEdits), real
// verifyStep (real fenceErrors / nodeRunner syntax check / hasEffectiveChange), real repo-map on real
// git. Only reasonFn is scripted (no model in tests) and the brain is faked (the vault stays untouched).
// If ANY cross-module contract is wrong, this breaks even when every module's own suite is green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Repo-map caches go to the app data home — isolate it so the e2e never touches real app data.
process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'forge-e2e-home-'));
import { forgeTask } from './index.mjs';
import { nodeRunner } from '../builder.mjs';

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'util.mjs'), 'export function greet(name) {\n  return `hello ${name}`;\n}\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  return dir;
}

// A real-ish fast gate: syntax-check every touched .mjs with the real node binary resolution.
const syntaxGate = (repoRoot, touched) => {
  const errors = [];
  const nr = nodeRunner();
  for (const f of (touched || []).filter((p) => /\.mjs$/.test(p))) {
    try { execFileSync(nr.bin, ['--check', join(repoRoot, f)], { cwd: repoRoot, stdio: 'pipe', env: nr.env }); }
    catch (e) { errors.push(`SYNTAX ${f}: ${String(e.stderr || e.message).slice(0, 300)}`); }
  }
  return { green: errors.length === 0, errors };
};

const PLAN_JSON = JSON.stringify({
  approach: 'add a shout helper, then use it from greet',
  steps: [
    { title: 'add shout helper', doneMeans: 'lib/shout.mjs exports shout()', targetFiles: ['lib/shout.mjs'], hints: 'new file' },
    { title: 'wire shout into util', doneMeans: 'greet uses shout for emphasis', targetFiles: ['lib/util.mjs'], hints: 'import + call' },
  ],
  risks: [],
});

const NEWFILE_REPLY = `*** SUMMARY: add the shout helper
*** NEWFILE: lib/shout.mjs
<<<<<<< CONTENT
export function shout(s) {
  return String(s).toUpperCase();
}
=======
>>>>>>> END`;

// Step 2's SEARCH matches the SEEDED util.mjs content exactly (proves sequential steps edit the live tree).
const EDIT_REPLY = `*** SUMMARY: use shout from greet
*** FILE: lib/util.mjs
<<<<<<< SEARCH
export function greet(name) {
  return \`hello \${name}\`;
}
=======
import { shout } from './shout.mjs';

export function greet(name) {
  return shout(\`hello \${name}\`);
}
>>>>>>> REPLACE`;

function scriptedReason({ implReplies }) {
  let impl = 0;
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (args.competence === 'plan') return { text: PLAN_JSON, engine: 'scripted-plan' };
    if (args.competence === 'review') return { text: 'APPROVE', engine: 'scripted-review' };
    if (args.coder) { const t = implReplies[Math.min(impl, implReplies.length - 1)]; impl += 1; return { text: t, engine: 'scripted-code' }; }
    return { text: '', engine: 'fallback' };
  };
  fn.calls = calls;
  return fn;
}

const brainDeps = (lessons) => ({
  recordLessonFn: (l) => lessons.push(l),
  lessonsForFn: () => ['a prior lesson: never leave stubs'],
});

test('e2e: the real pipeline plans, creates a file, edits the seeded file, and returns green', async () => {
  const dir = seedRepo();
  const lessons = [];
  const reasonFn = scriptedReason({ implReplies: [NEWFILE_REPLY, EDIT_REPLY] });
  const r = await forgeTask({
    task: 'give greet real emphasis via a shout helper', repoRoot: dir,
    gate: syntaxGate, assertWritable: (p) => { if (!p.startsWith('lib/')) throw new Error(`refused: ${p}`); },
    reasonFn, deps: brainDeps(lessons),
  });
  assert.deepEqual(r.touched.sort(), ['lib/shout.mjs', 'lib/util.mjs']);
  assert.match(r.engine, /^forge:scripted-plan/);
  assert.match(r.summary, /2 step\(s\)/);
  assert.ok(existsSync(join(dir, 'lib', 'shout.mjs')), 'the new file exists');
  const util = readFileSync(join(dir, 'lib', 'util.mjs'), 'utf8');
  assert.match(util, /import { shout } from '\.\/shout\.mjs'/, 'step 2 edited the live tree step 1 left behind');
  assert.equal(lessons.filter((l) => l.kind === 'success').length, 1, 'a success lesson was recorded');
  // the injected prior lesson reached the model's prompts
  assert.ok(reasonFn.calls.some((c) => /never leave stubs/.test(c.prompt || '')), 'brain lessons reach the prompts');
});

test('e2e: all-red candidates fail honestly and leave ZERO residue in the tree', async () => {
  const dir = seedRepo();
  const lessons = [];
  const BROKEN = `*** SUMMARY: broken attempt
*** NEWFILE: lib/broken.mjs
<<<<<<< CONTENT
export function oops( {   // unclosed — node --check reds this
=======
>>>>>>> END`;
  const reasonFn = scriptedReason({ implReplies: [BROKEN, BROKEN, BROKEN, BROKEN, BROKEN, BROKEN] });
  await assert.rejects(
    () => forgeTask({
      task: 'give greet real emphasis via a shout helper', repoRoot: dir,
      gate: syntaxGate, assertWritable: () => {}, reasonFn, deps: brainDeps(lessons),
    }),
    /could not reach green after 3 verified candidates/,
  );
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(status, '', `every red candidate was reverted — tree must be clean, got:\n${status}`);
  assert.equal(lessons.filter((l) => l.kind === 'failure').length, 1, 'a failure lesson was recorded for the next run');
});
