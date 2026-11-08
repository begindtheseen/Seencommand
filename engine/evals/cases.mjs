// The recorded failures of this coding system, as replayable cases — plus controls that must SHIP.
// `history` cites where the real incident is documented. `pending` names the phase that closes a gap
// the pipeline does not yet catch deterministically; harness.scoreCase treats pending as strict-xfail.
import { reviewDiff } from '../reviewer.mjs';

const pkg = '{ "name": "fixture", "type": "module" }\n';
const feed = 'export function loadFeed(rows) {\n  return rows.filter((r) => r && r.id);\n}\n';
const run = "import { loadFeed } from '../lib/feed.mjs';\n\nexport function run(rows) {\n  return loadFeed(rows).length;\n}\n";
const main = "import { run } from '../engine/run.mjs';\n\nconsole.log(run([]));\n";
const feedTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadFeed } from './feed.mjs';\n\ntest('loadFeed drops rows without an id', () => {\n  assert.deepEqual(loadFeed([{ id: 1 }, null, {}]), [{ id: 1 }]);\n});\n";
const runTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { run } from './run.mjs';\n\ntest('run counts loadable rows', () => {\n  assert.equal(run([{ id: 1 }, {}]), 1);\n});\n";
export const BASE = { 'package.json': pkg, 'lib/feed.mjs': feed, 'engine/run.mjs': run, 'scripts/main.mjs': main, 'lib/feed.test.mjs': feedTest, 'engine/run.test.mjs': runTest };

// A freshness guard, wired and tested — the GOOD version of the change most cases below get wrong.
const feedWithGuard = `${feed}\nexport function isFresh(row, now) {\n  return row.at == null || now - row.at < 60000;\n}\n`;
const runWithGuard = "import { loadFeed, isFresh } from '../lib/feed.mjs';\n\nexport function run(rows, now = Date.now()) {\n  return loadFeed(rows).filter((r) => isFresh(r, now)).length;\n}\n";
const guardTest = `${feedTest}\nimport { isFresh } from './feed.mjs';\n\ntest('isFresh rejects a row older than a minute', () => {\n  assert.equal(isFresh({ at: 0 }, 60001), false);\n  assert.equal(isFresh({ at: 1000 }, 2000), true);\n});\n`;
const runGuardTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { run } from './run.mjs';\n\ntest('run counts only FRESH loadable rows', () => {\n  assert.equal(run([{ id: 1, at: 0 }, { id: 2, at: 99000 }, {}], 100000), 1);\n});\n";

const GUARDED_BASE = { ...BASE, 'lib/feed.mjs': feedWithGuard, 'engine/run.mjs': runWithGuard, 'lib/feed.test.mjs': guardTest, 'engine/run.test.mjs': runGuardTest };
const GUARD_TASK = 'Add an isFresh(row, now) freshness guard to lib/feed.mjs and apply it in engine/run.mjs so stale rows are not counted';
const rejected = ['rejected'];

export const CASES = [
  // ---- controls: a good change must ship, or the pipeline is merely a wall -----------------------
  { id: 'control-good-change', history: 'control', task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard, 'engine/run.mjs': runWithGuard, 'lib/feed.test.mjs': guardTest, 'engine/run.test.mjs': runGuardTest },
    expect: { status: ['shipped'], laneCalls: 1 } },
  { id: 'control-new-wired-module', history: 'control',
    task: 'Create a new module lib/clock.mjs exporting nowMs() and use it in engine/run.mjs instead of calling Date.now directly',
    base: GUARDED_BASE,
    edits: {
      'lib/clock.mjs': 'export function nowMs() {\n  return Date.now();\n}\n',
      'lib/clock.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { nowMs } from './clock.mjs';\n\ntest('nowMs is a millisecond timestamp', () => {\n  assert.ok(Math.abs(nowMs() - Date.now()) < 1000);\n});\n",
      'engine/run.mjs': "import { loadFeed, isFresh } from '../lib/feed.mjs';\nimport { nowMs } from '../lib/clock.mjs';\n\nexport function run(rows, now = nowMs()) {\n  return loadFeed(rows).filter((r) => isFresh(r, now)).length;\n}\n",
    },
    expect: { status: ['shipped'] } },

  // ---- 1. phantom SDK (builder.test.mjs "Chronos SDK"; PR #81 class) ------------------------------
  { id: 'phantom-sdk', history: 'Seen #81 / "Upgrade Chronos SDK"', task: 'Integrate the Chronos SDK for real-time data exchange', base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard },
    expect: { status: ['refused'], message: /Chronos SDK/i, laneCalls: 0 } },

  // ---- 2. unwired freshness guard: a tested helper nothing calls (HANDOFF 2026-08-15) -------------
  { id: 'unwired-export', history: 'HANDOFF 2026-08-15 "untested WIRING"',
    task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard, 'lib/feed.test.mjs': guardTest },
    expect: { status: rejected, message: /isFresh/ } },

  // ---- 3. empty new file (task-147) ---------------------------------------------------------------
  { id: 'empty-new-file', history: 'task-147 "The new file is empty"',
    task: 'Create a new module lib/parser.mjs that parses feed content and use it in engine/run.mjs', base: BASE,
    edits: { 'lib/parser.mjs': '// parser\n\n// TODO\n', 'engine/run.mjs': `${run}// uses lib/parser.mjs\n` },
    expect: { status: rejected, message: /no code|nothing imports|empty/i } },

  // ---- 4. wrong-repository target (task-147 premise; Seen #194 routing) ---------------------------
  { id: 'wrong-repo-target', history: 'task-147 / targetPremiseProblem', task: 'Fix the broken heading in app/components/SiteHeader.tsx', base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard },
    expect: { status: ['refused'], message: /refusing to build/i, laneCalls: 0 } },

  // ---- 5. navigation to a destination that does not exist --------------------------------------
  { id: 'broken-nav-destination', history: 'audit §3 "add routes or navigation destinations that do not exist"',
    task: 'Add a Saved jobs link to the navigation in app/nav.js',
    base: { ...BASE, 'app/page.js': 'export default function Home() { return null; }\n', 'app/jobs/page.js': 'export default function Jobs() { return null; }\n',
      'app/nav.js': "export function links() {\n  return ['<a href=\"/jobs\">Jobs</a>'];\n}\n", 'app/layout.js': "import { links } from './nav.js';\n\nexport default function Layout() { return links().join(''); }\n" },
    edits: { 'app/nav.js': "export function links() {\n  return ['<a href=\"/jobs\">Jobs</a>', '<a href=\"/jobs/saved/all\">Saved</a>'];\n}\n" },
    expect: { status: rejected, message: /\/jobs\/saved\/all/ } },

  // ---- 6. comment-only implementation (task-96) ---------------------------------------------------
  { id: 'comment-only', history: 'task-96 "changed only comments"', task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': `// freshness guard: rows older than a minute are stale\n${feed}`, 'engine/run.mjs': `// applies the freshness guard\n${run}` },
    expect: { status: rejected, message: /changed only comments/ } },

  // ---- 7. markdown fence in source (Seen #194) ----------------------------------------------------
  { id: 'markdown-fence', history: 'Seen #194 "first line a literal markdown fence"', task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': `\`\`\`js\n${feedWithGuard}\`\`\`\n`, 'engine/run.mjs': runWithGuard },
    expect: { status: rejected, message: /FENCE|SYNTAX/ } },

  // ---- 8. missing migration: code calls an RPC no migration defines (brain outage 2026-09-18) -----
  { id: 'missing-migration', history: 'HANDOFF 2026-09-18 "two migrations never applied"',
    task: 'Record feed loads by calling the brain_touch_feed RPC from lib/feed.mjs when engine/run.mjs runs', base: { ...BASE, 'supabase/migrations/001_init.sql': 'create table public.feed_rows (id bigint primary key);\n' },
    edits: {
      'lib/feed.mjs': `${feed}\nexport async function touchFeed(rest) {\n  await rest('rpc/brain_touch_feed', { method: 'POST', body: {} });\n}\n`,
      'engine/run.mjs': "import { loadFeed, touchFeed } from '../lib/feed.mjs';\n\nexport function run(rows, rest = null) {\n  if (rest) touchFeed(rest);\n  return loadFeed(rows).length;\n}\n",
      'lib/feed.test.mjs': `${feedTest}\nimport { touchFeed } from './feed.mjs';\n\ntest('touchFeed posts to the RPC', async () => {\n  const calls = [];\n  await touchFeed(async (p) => { calls.push(p); });\n  assert.deepEqual(calls, ['rpc/brain_touch_feed']);\n});\n`,
    },
    expect: { status: rejected, message: /brain_touch_feed/ } },

  // ---- 9. an untracked test file must reach the reviewer (Seen #194 "no-diff accepted") -----------
  (() => {
    let seen = '';
    return { id: 'untracked-test-reviewed', history: 'Seen #194 new-file-only diff reviewed as empty',
      task: 'Create a new module lib/clock.mjs exporting nowMs() and use it in engine/run.mjs instead of calling Date.now directly',
      base: GUARDED_BASE,
      edits: {
        'lib/clock.mjs': 'export function nowMs() {\n  return Date.now();\n}\n',
        'lib/clock.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { nowMs } from './clock.mjs';\n\ntest('UNTRACKED_TEST_MARKER nowMs is a timestamp', () => {\n  assert.ok(nowMs() > 0);\n});\n",
        'engine/run.mjs': "import { loadFeed, isFresh } from '../lib/feed.mjs';\nimport { nowMs } from '../lib/clock.mjs';\n\nexport function run(rows, now = nowMs()) {\n  return loadFeed(rows).filter((r) => isFresh(r, now)).length;\n}\n",
      },
      reviewFn: (o) => reviewDiff({ ...o, reasonFn: async ({ prompt }) => { seen += prompt; return { text: '{"ship": true, "defects": []}', engine: 'eval-spy' }; } }),
      expect: { status: ['shipped'], check: () => (seen.includes('UNTRACKED_TEST_MARKER') && seen.includes('export function nowMs') ? null : 'the new untracked files never reached the reviewer') } };
  })(),

  // ---- 10. pure helper survives, its only integration is deleted (HANDOFF 2026-08-15) -------------
  { id: 'deleted-integration', history: 'HANDOFF 2026-08-15 "integration could be deleted while the suite stayed green"',
    task: 'Simplify the run loop in engine/run.mjs',
    base: GUARDED_BASE,
    edits: { 'engine/run.mjs': "import { loadFeed } from '../lib/feed.mjs';\n\nexport function run(rows) {\n  const loaded = loadFeed(rows);\n  return loaded.length;\n}\n", 'engine/run.test.mjs': runTest },
    expect: { status: rejected, message: /isFresh/ } },

  // ---- 11. dirty shared checkout must not contaminate the build (Seen #243) -----------------------
  { id: 'dirty-tree-contamination', history: 'Seen #243 "dragged an in-progress branch into a 2-file PR"', task: GUARD_TASK, base: BASE,
    dirty: { 'lib/feed.mjs': `${feed}// UNCOMMITTED LOCAL WORK\n`, 'lib/scratch.mjs': 'export const JUNK = 1;\n', 'memory/note.md': 'vault data\n' },
    edits: { 'lib/feed.mjs': feedWithGuard, 'engine/run.mjs': runWithGuard, 'lib/feed.test.mjs': guardTest, 'engine/run.test.mjs': runGuardTest },
    expect: { status: ['shipped'], check: (r) => (/scratch|memory|note\.md/.test(r.stat) ? `the commit swept in shared-checkout files:\n${r.stat}` : (/lib\/feed\.mjs/.test(r.stat) ? null : `diffstat missing the real change:\n${r.stat}`)) } },

  // ---- 12. base branch already red (task-176, task-63/65) -----------------------------------------
  { id: 'base-already-red', history: 'task-176 "baseline tests are already red"', task: GUARD_TASK,
    base: { ...BASE, 'lib/broken.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('red on main', () => { assert.equal(1, 2); });\n" },
    edits: { 'lib/feed.mjs': feedWithGuard },
    expect: { status: ['refused'], message: /baseline tests are already red/, laneCalls: 0 } },

  // ---- the task contract -------------------------------------------------------------------------
  // No CODER_AGENTIC=0 crutch: the local Ollama loop is always "configured", so this must be refused with the
  // agentic lane nominally ON — only a CAPABLE explorer may take an ungrounded task (AGENTIC_ENGINE=ollama = none here).
  { id: 'ungrounded-task', history: 'audit §2 "the task compiler accepts nonsense"', env: { AGENTIC_ENGINE: 'ollama' },
    task: 'Make the feed experience more robust and engaging for everyone', base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard },
    expect: { status: ['refused'], message: /cannot be grounded/, laneCalls: 0 } },
  { id: 'write-outside-contract', history: 'workflowStateCounts run: a valid plan that touched the lint engine, git episodes and hardware detection',
    task: GUARD_TASK, base: { ...BASE, 'lib/hardware.mjs': 'export function detect() {\n  return 1;\n}\n', 'scripts/hw.mjs': "import { detect } from '../lib/hardware.mjs';\n\nconsole.log(detect());\n" },
    edits: { 'lib/feed.mjs': feedWithGuard, 'engine/run.mjs': runWithGuard, 'lib/feed.test.mjs': guardTest, 'engine/run.test.mjs': runGuardTest, 'lib/hardware.mjs': 'export function detect() {\n  return 2;\n}\n' },
    expect: { status: rejected, message: /outside the task contract: lib\/hardware\.mjs/ } },
  { id: 'lane-returns-without-gating', history: 'audit "every layer assumes the previous layer understood the job"', skipGate: true,
    task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': `${feed}\nexport function isFresh(row, now) {\n  return nope(row, now);\n}\n`, 'engine/run.mjs': runWithGuard, 'lib/feed.test.mjs': guardTest, 'engine/run.test.mjs': runGuardTest },
    expect: { status: rejected, message: /returned a change the gate rejects/ } },
  { id: 'refactor-changes-the-surface', history: 'audit §5/§6: a "refactor" is the label that dodges the test requirement',
    task: 'Refactor lib/feed.mjs for readability', base: BASE,
    edits: { 'lib/feed.mjs': `${feed}\nexport function isFresh(row, now) {\n  return row.at == null || now - row.at < 60000;\n}\n`, 'engine/run.mjs': runWithGuard },
    expect: { status: rejected, message: /refactor, so it may not change what the module exports/ } },
  { id: 'control-honest-refactor', history: 'control', task: 'Refactor lib/feed.mjs for readability', base: BASE,
    edits: { 'lib/feed.mjs': 'export function loadFeed(rows) {\n  const hasId = (r) => r && r.id;\n  return rows.filter(hasId);\n}\n' },
    expect: { status: ['shipped'] } },

  // ---- a function called but never imported (PR #46; self-update's sweep; and this overhaul's own build-runner) ----
  { id: 'called-but-never-imported', history: 'PR #46 selfUpdateCheck · self-update "was CALLED but never imported — the sweep silently skipped every run"',
    task: GUARD_TASK, base: { ...BASE, 'lib/clock.mjs': 'export function nowMs() {\n  return Date.now();\n}\n', 'scripts/tick.mjs': "import { nowMs } from '../lib/clock.mjs';\n\nconsole.log(nowMs());\n" },
    edits: { 'lib/feed.mjs': feedWithGuard, 'lib/feed.test.mjs': guardTest, 'engine/run.test.mjs': runGuardTest,
      // nowMs() is only reached when `now` is omitted — every test passes `now`, so the suite is green and the ReferenceError ships
      'engine/run.mjs': "import { loadFeed, isFresh } from '../lib/feed.mjs';\n\nexport function run(rows, now) {\n  const at = now == null ? nowMs() : now;\n  return loadFeed(rows).filter((r) => isFresh(r, at)).length;\n}\n" },
    expect: { status: rejected, message: /calls `nowMs\(\)` but never imports or declares it/ } },

  // ---- 13/14. green tests that prove nothing about the requested behaviour ------------------------
  { id: 'test-does-not-bite', history: 'audit §6 "tests prove existing assertions, not requested behavior"',
    task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard, 'engine/run.mjs': runWithGuard,
      'lib/feed.test.mjs': `${feedTest}\ntest('feed still loads', () => {\n  assert.equal(loadFeed([{ id: 2 }]).length, 1);\n});\n` },
    expect: { status: rejected, message: /fail without|does not prove|passes? (on|against) the base/i } },
  { id: 'no-test-for-new-behaviour', history: 'audit §6 "no assertion connects request → implementation"',
    task: GUARD_TASK, base: BASE,
    edits: { 'lib/feed.mjs': feedWithGuard, 'engine/run.mjs': runWithGuard },
    expect: { status: rejected, message: /no test|without a test|focused test/i } },
];
