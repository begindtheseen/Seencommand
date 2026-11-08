import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTargetFor, buildTargetForTask, isEngineering, gatedActionFor, effectOf, repoOfNamedPaths } from './policy.mjs';

test('engineering actions map to the right build target repo', () => {
  assert.equal(buildTargetFor('platform PR'), 'tool');   // Seen Command self-improvement
  assert.equal(buildTargetFor('bugfix PR'), 'product');  // the Seen product
  assert.equal(buildTargetFor('feature PR'), 'product');
});

test('non-buildable actions return null (stay a filed task)', () => {
  assert.equal(buildTargetFor('migration draft'), null); // DB/RLS stays a human call
  assert.equal(buildTargetFor('reddit plan'), null);
  assert.equal(buildTargetFor('pricing proposal'), null);
  assert.equal(buildTargetFor('kpi pack'), null);
});

test('isEngineering agrees with buildTargetFor', () => {
  assert.equal(isEngineering('platform PR'), true);
  assert.equal(isEngineering('bugfix PR'), true);
  assert.equal(isEngineering('reddit plan'), false);
});

test('engineering kinds are still gated (irreversible → park at the gate)', () => {
  // A build opens a PR (outbound) so it must remain a gated action, not auto-internal.
  assert.ok(gatedActionFor('platform PR'));
  assert.equal(effectOf('bugfix PR'), 'gated');
});

test('buildTargetForTask maps a filed issue back to its repo via the gate line', () => {
  // Filed issues quote their gate verbatim — that is the strongest signal.
  assert.equal(buildTargetForTask('**Gate:** Merge the bugfix PR to next-migration\n\nFix the table'), 'product');
  assert.equal(buildTargetForTask('**Gate:** Green-light the build / merge the feature PR'), 'product');
  assert.equal(buildTargetForTask('**Gate:** Merge the Seen Command self-improvement PR'), 'tool');
});

test('buildTargetForTask falls back to codebase keywords, then tool', () => {
  assert.equal(buildTargetForTask('Fix the job board filters on the site'), 'product');
  assert.equal(buildTargetForTask('Improve error logging in Seen Command'), 'tool');
  assert.equal(buildTargetForTask('Weekly progress report automation'), 'tool'); // ambiguous → tool (PR-only either way)
});

// ---- subject-aware routing: a task about Seen Command ITSELF is a TOOL build (the #115/#117 fix) ----
// Root cause: buildTargetForTask read the gate line FIRST, so #115 ("Update Seen Command documentation")
// carrying gate "Merge the bugfix PR…" routed to the PRODUCT repo — where the coder could only stub and
// the reviewer rightly rejected. The TOOL-subject override now wins over the gate line / [product] tag.
test('a documentation/test task about Seen Command itself routes TOOL despite a product gate line', () => {
  // The real #115, exactly as engine/server.mjs feeds it: `${title}\n${body}` including the filing
  // boilerplate (Proposed by / Gate / "Filed by Seen Command" footer). The override strips that
  // boilerplate, sees "Update Seen Command documentation" + the docs/seen-command.md path, and flips.
  const issue115 = '[product] Update Seen Command documentation\n'
    + '**Proposed by:** Bug Triage & Fix (product dept)\n'
    + '**Gate:** Merge the bugfix PR to next-migration\n\n'
    + 'Update docs/seen-command.md to reflect the current capabilities and limitations of Seen Command. '
    + 'Done means: The documentation accurately describes the current state of Seen Command\n\n'
    + '---\n_Filed by Seen Command when Brandon approved it._';
  assert.equal(buildTargetForTask(issue115), 'tool');
  // A test-suite-for-Seen-Command task: tool even bare, and tool even when a bugfix gate line is present.
  assert.equal(buildTargetForTask('[product] Create a test suite for Seen Command'), 'tool');
  assert.equal(buildTargetForTask('[product] Create a test suite for Seen Command\n\n**Gate:** Merge the bugfix PR to next-migration'), 'tool');
  // A concrete tool-repo path is proof on its own — no self-reference needed.
  assert.equal(buildTargetForTask('[product] Refactor engine/policy.mjs routing\n\n**Gate:** Merge the bugfix PR to next-migration'), 'tool');
});

test('the tool override is vetoed by a strong product signal (a real product task merely name-dropping Seen Command)', () => {
  // "board meeting" co-occurs with "Seen Command" here, but seenjobs/employer/job-board are the SUBJECT,
  // so this stays PRODUCT — precision-first: never flip a genuine product task to the tool repo.
  assert.equal(buildTargetForTask('[product] Fix the employer job board on seenjobs — flagged in the Seen Command board meeting\n\n**Gate:** Merge the bugfix PR to next-migration'), 'product');
  assert.equal(buildTargetForTask('Refresh stale jobs surfaced by the Seen Command board meeting'), 'product');
});

// ---- task shape: documents go to the deliverer, code goes to the builder --------------------------
// Pinned against the REAL tasks that produced the 2026-07-10 theater PRs when everything was routed
// to the code builder (comment spam for the SDK task, console.logs for the plan task).
const { taskShape } = await import('./policy.mjs');

test('plan/audit/report-shaped tasks are deliverables', () => {
  assert.equal(taskShape('Chronos and Seen Command Optimization Plan — Develop a concrete plan to maximize the capabilities'), 'deliverable'); // #31
  assert.equal(taskShape('[product] Chronos and Seen Command Capabilities Audit'), 'deliverable'); // #30
  assert.equal(taskShape('Ghost Report — 2026-07-10: amazon tops the index'), 'deliverable');      // #28
  assert.equal(taskShape('Q3 pricing strategy brief'), 'deliverable');
});

test('code words win ties — automation/fix/feature tasks stay with the builder', () => {
  assert.equal(taskShape('[product] Weekly Progress Report Automation'), 'code');                  // #33: report + AUTOMATION
  assert.equal(taskShape('[platform] Upgrade Chronos SDK to Latest Stable Version'), 'code');      // #45
  assert.equal(taskShape('Update Command Center Greeting String to Good morning, Brandon'), 'code'); // #42
  assert.equal(taskShape('[product] Fix Ghost Report Table Alignment'), 'code');                   // #26: report + FIX
  assert.equal(taskShape('Error Monitoring and Logging Feature PR'), 'code');                      // #32
  assert.equal(taskShape('[product] Review and Merge Feature PR'), 'code');                        // #27
  assert.equal(taskShape(''), 'code'); // unknown → builder, which fails honestly if unfulfillable
});

// ---- protected intent files (the PR #56 class) -----------------------------------------------------
const { PROTECTED_PATHS, touchesProtected } = await import('./policy.mjs');

test('the intent set is protected: focus, capabilities, policy itself, package manifests', () => {
  for (const p of ['org/focus.mjs', 'org/capabilities.mjs', 'engine/policy.mjs', 'package.json']) {
    assert.ok(PROTECTED_PATHS.includes(p), p);
  }
  assert.deepEqual(touchesProtected(['engine/run.mjs', 'org/focus.mjs', 'lib/llm.mjs']), ['org/focus.mjs']);
  assert.deepEqual(touchesProtected(['engine/run.mjs']), []);
  assert.deepEqual(touchesProtected([]), []);
  assert.deepEqual(touchesProtected(null), []);
});

test('user-facing tasks route to the PRODUCT repo (the #69/#74 misroute)', () => {
  assert.equal(buildTargetForTask('Enhance User Onboarding Experience — intuitive tutorials for new users'), 'product');
  assert.equal(buildTargetForTask('Improve signup conversion on the landing flow'), 'product');
  assert.equal(buildTargetForTask('Implement Real-Time Monitoring Dashboard for Chronos and Seen Command'), 'tool');
  assert.equal(buildTargetForTask('platform self-improvement: faster board meetings'), 'tool');
});

test('job-data tasks route to the PRODUCT repo (the #88 misroute)', () => {
  // #88 said "in Seen Command", but jobs are PRODUCT data (the Supabase `jobs` table in seen) — the
  // board-meeting engine can never touch them. "stale jobs"/"job statuses" now bias product; the tool
  // repo's own builder-job/slot phrasing (no paired phrase) stays 'tool'.
  assert.equal(buildTargetForTask('Implement Automated Job Refresh — Develop a feature to automatically refresh stale jobs in Seen Command… creating a scheduled task that periodically updates job statuses. Done means: The number of stale jobs in Seen Command is reduced by 20%'), 'product');
  assert.equal(buildTargetForTask('Refresh stale job listings nightly'), 'product');
  assert.equal(buildTargetForTask('Fix the builder job slot lock'), 'tool');
  assert.equal(buildTargetForTask("Speed up the coder's retrieval job"), 'tool');
});

// Live on 2026-09-21: a task naming `brain/lib/memory-read.mjs` (a tool path) was routed to the PRODUCT
// repo by the filed issue's `**Gate:**` line and refused as outside that repo's writable paths — a yellow
// "needs your review" card for a routing mistake. A path that exists in exactly one repo is a FACT.
test('a named path that exists in exactly one repo outvotes every keyword and gate line', () => {
  const tool = new Set(['brain/lib/memory-write.mjs', 'engine/policy.mjs']);
  const product = new Set(['components/ApplyCheckpoint.tsx', 'lib/server/geo.js']);
  const roots = { toolRoot: '/tool', productRoot: '/product',
    exists: (p) => (p.startsWith('/tool/') ? tool.has(p.slice(6)) : product.has(p.slice(9))) };

  assert.equal(buildTargetForTask('Modify the user count in brain/lib/memory-write.mjs. **Gate:** Merge the bugfix PR to next-migration', roots), 'tool');
  assert.equal(buildTargetForTask('Onboarding for new sign-ups on the site, in engine/policy.mjs', roots), 'tool', 'product wording cannot outvote a real tool path');
  assert.equal(buildTargetForTask('Fix the salary line in components/ApplyCheckpoint.tsx', roots), 'product');
  assert.equal(buildTargetForTask('Document the gate in lib/server/geo.js for Seen Command', roots), 'product', 'tool wording cannot outvote a real product path');

  // Undecidable by fact → the wording decides, exactly as before.
  assert.equal(repoOfNamedPaths('targeting brain/lib/memory-read.mjs', roots), null, 'a path in NEITHER repo settles nothing');
  assert.equal(repoOfNamedPaths('lib/server/geo.js and engine/policy.mjs both', roots), null, 'one each → no fact');
  assert.equal(repoOfNamedPaths('no paths at all here', roots), null);
  assert.equal(repoOfNamedPaths('engine/policy.mjs', {}), null, 'no roots → nothing to check');
  assert.equal(buildTargetForTask('Improve onboarding for new sign-ups on the site', roots), 'product');
  assert.equal(buildTargetForTask('Document the board meeting in Seen Command'), 'tool', 'the old single-argument call still works');
});
