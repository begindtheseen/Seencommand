import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAgendaItem, slug, CONCRETE_ANCHOR } from './run.mjs';
import { digestTimelineDir } from '../lib/brain.mjs';

const DEPT = { id: 'product', workers: [
  { id: 'bugfix', title: 'Bug Triage & Fix', outputs: 'bugfix PR' },
  { id: 'feature', title: 'Feature Builder', outputs: 'feature PR' },
  { id: 'reviewer', title: 'Code Reviewer', outputs: 'review verdict' },
  { id: 'social', title: 'Social (dormant)', outputs: 'social plan', dormant: true },
] };
// Growth owns marketing kinds only (no engineering kind) — used to pin the KIND TRESPASS + TITLE/KIND
// DECOUPLING guards. 'feature PR' is a REAL org kind (product owns it), so a growth item claiming it is
// a trespass, not a typo — this is exactly today's mislabeled-queue shape.
const GROWTH = { id: 'growth', workers: [
  { id: 'reddit', title: 'Reddit Marketing / Community', outputs: 'reddit plan' },
  { id: 'ghost-report', title: 'Ghost Report Writer', outputs: 'intel brief' },
] };
const PLATFORM = { id: 'platform', workers: [
  { id: 'maintainer', title: 'Platform Maintainer', outputs: 'platform PR' },
] };

test('a valid agenda item binds to the matching worker and is gated by POLICY', () => {
  const p = normalizeAgendaItem(DEPT, { title: 'Fix the stale-jobs purge', detail: 'Purge listings older than 30d in scripts/purge-stale.mjs. Done means: no listing older than 30d survives a run.', kind: 'bugfix PR' }, DEPT.workers);
  assert.equal(p.agent, 'bugfix');
  assert.equal(p.kind, 'bugfix PR');
  assert.ok(p.gatedAction, 'engineering kinds are always gated');
  assert.equal(p.effect, 'gated');
});

test('an unknown/garbage kind is coerced to the dept lead worker (typos must not kill proposals)', () => {
  // 'made-up kind' coerces to the lead worker's 'bugfix PR' (an engineering kind), so it must also
  // carry a concrete anchor (app/thing/page.tsx) to clear the concreteness guard — the typo, not the
  // anchor, is what's under test here.
  const p = normalizeAgendaItem(DEPT, { title: 'Do a thing', detail: 'Update app/thing/page.tsx. Done means: the thing is visibly done.', kind: 'made-up kind' }, DEPT.workers);
  assert.equal(p.kind, 'bugfix PR'); // first ACTIVE worker's kind
  assert.notEqual(p.agent, 'social');
});

test('internal kinds stay internal regardless of what the model claims', () => {
  const p = normalizeAgendaItem(DEPT, { title: 'Review open PRs', detail: 'x. Done means: every open PR has a verdict.', kind: 'review verdict', needs_approval: true }, DEPT.workers);
  assert.equal(p.gatedAction, null);
  assert.equal(p.effect, 'internal');
});

test('junk items are rejected (no title / not an object)', () => {
  assert.equal(normalizeAgendaItem(DEPT, { detail: 'no title', kind: 'bugfix PR' }, DEPT.workers), null);
  assert.equal(normalizeAgendaItem(DEPT, 'a string', DEPT.workers), null);
  assert.equal(normalizeAgendaItem(DEPT, null, DEPT.workers), null);
});

// ---- queue-integrity guards: KIND TRESPASS / TITLE decoupling / DONE-MEANS ----------------------
// Today's approval queue held a "feature PR: Integrate Supabase Broadcast…" whose ACTUAL resolved kind
// was 'reddit plan' (gate: "Post to Reddit + reply in the thread"): the title said engineering, approve would
// have posted to Reddit. These pin the three guards that stop that decoupling at the source.

test('KIND TRESPASS: a real kind this dept cannot own is dropped, not coerced', () => {
  // 'feature PR' is a real org kind but belongs to product, not growth → drop (do not relabel as
  // 'reddit plan' and quietly gate a Reddit post).
  const p = normalizeAgendaItem(GROWTH, { title: 'Build a real-time dashboard', detail: 'Ship it. Done means: the dashboard renders live data.', kind: 'feature PR' }, GROWTH.workers);
  assert.equal(p, null);
});

test('TITLE/KIND DECOUPLING: an engineering-PR title prefix over a different resolved kind is dropped', () => {
  // Title claims a feature-PR; the kind that would actually gate is 'reddit plan' → decoupled → drop.
  const p = normalizeAgendaItem(GROWTH, { title: 'feature PR: Integrate Supabase Broadcast Ping', detail: 'Wire it up. Done means: pings arrive within 1s.', kind: 'reddit plan' }, GROWTH.workers);
  assert.equal(p, null);
});

test('a matching engineering-PR prefix is stripped (cosmetic), the proposal is kept', () => {
  const p = normalizeAgendaItem(PLATFORM, { title: 'platform PR: Fix the slot lock', detail: 'Repair the mutex in engine/run.mjs. Done means: two runs never overlap.', kind: 'platform PR' }, PLATFORM.workers);
  assert.ok(p, 'a matching-prefix item is kept');
  assert.equal(p.kind, 'platform PR');
  assert.equal(p.title, 'Fix the slot lock');
  assert.ok(!/^(feature|bugfix|platform)\s*PR\s*[:—–-]/i.test(p.title), 'prefix stripped from the title');
});

test('DONE-MEANS CONTRACT: a proposal without an observable acceptance line is dropped', () => {
  const p = normalizeAgendaItem(PLATFORM, { title: 'Fix the slot lock', detail: 'Just do it — investigate and optimize.', kind: 'platform PR' }, PLATFORM.workers);
  assert.equal(p, null);
});

test('a fully-valid item (own kind, clean title, Done means) is kept and the Done-means rides in the body', () => {
  const p = normalizeAgendaItem(PLATFORM, { title: 'Fix the slot lock', detail: 'Repair the mutex in engine/run.mjs. Done means: two runs never overlap.', kind: 'platform PR' }, PLATFORM.workers);
  assert.ok(p, 'kept');
  assert.equal(p.kind, 'platform PR');
  assert.equal(p.title, 'Fix the slot lock');
  assert.match(p.body, /done means:/i, 'the Done-means text flows into the body → filed issue');
});

// ---- (d) CONCRETENESS ANCHOR: engineering proposals must name a concrete target ------------------
// Four employer feature tasks in a row (#93 "…Notification System", #94 "Optimize…Workflow", #95
// "Develop Employer Dashboard", #96 "…Analytics") each died "could not reach a green gate in 8 rounds":
// the patch-coder builds small SEARCH/REPLACE diffs against a retrieved window, never a whole feature.
// So an engineering proposal that names no path/file/route it can open is a feature, not a step → drop.

test('CONCRETENESS ANCHOR: an engineering proposal with no path/file target is dropped', () => {
  const p = normalizeAgendaItem(DEPT, { title: 'Develop Employer Dashboard', detail: 'Build the employer dashboard with jobs, applicants, and analytics. Done means: employers can view and manage all their postings.', kind: 'feature PR' }, DEPT.workers);
  assert.equal(p, null, 'a whole-feature ask with no concrete target is not buildable → dropped');
});

test('CONCRETENESS ANCHOR: an engineering proposal with a path anchor is kept', () => {
  const p = normalizeAgendaItem(DEPT, { title: 'Add app/employers/dashboard/page.tsx — read-only jobs list', detail: "Add app/employers/dashboard/page.tsx that reads the employer's jobs from the jobs table. Done means: the page lists every job the employer owns.", kind: 'feature PR' }, DEPT.workers);
  assert.ok(p, 'a named file path is a buildable single-PR step → kept');
  assert.equal(p.kind, 'feature PR');
});

test('CONCRETENESS ANCHOR: a file-ish anchor without a slash still counts', () => {
  const p = normalizeAgendaItem(PLATFORM, { title: 'fix greeting in command-center.html', detail: "Correct the welcome banner copy. Done means: the banner reads 'Welcome back'.", kind: 'platform PR' }, PLATFORM.workers);
  assert.ok(p, 'a bare filename (command-center.html) is a concrete target → kept');
  assert.equal(p.title, 'fix greeting in command-center.html');
});

test('CONCRETENESS ANCHOR does not touch non-engineering kinds (no anchor required)', () => {
  const p = normalizeAgendaItem(GROWTH, { title: 'Post the weekly Ghost Report thread', detail: 'Draft this week’s value post for the recruiting subreddit from company_scores. Done means: a ready-to-post thread is filed.', kind: 'reddit plan' }, GROWTH.workers);
  assert.ok(p, 'a marketing proposal needs no path anchor');
  assert.equal(p.kind, 'reddit plan');
});

test('CONCRETE_ANCHOR matches paths + known file types, not bare prose', () => {
  for (const s of ['app/employers/page.tsx', 'scripts/foo.mjs', 'api/refresh-jobs', 'command-center.html', 'run.mjs', 'add a 0007_jobs.sql migration']) {
    assert.ok(CONCRETE_ANCHOR.test(s), `${s} should read as a concrete anchor`);
  }
  for (const s of ['Develop the Employer Dashboard', 'optimize the job posting workflow', 'improve analytics overall']) {
    assert.equal(CONCRETE_ANCHOR.test(s), false, `${s} should NOT read as a concrete anchor`);
  }
});

test('slug is stable + filesystem/key safe', () => {
  assert.equal(slug('Fix: the Stale-Jobs purge!!'), 'fix-the-stale-jobs-purge');
  assert.equal(slug('Fix: the Stale-Jobs purge!!'), slug('Fix: the Stale-Jobs purge!!'));
});

test('digestTimelineDir returns recent days with headings, capped, oldest→newest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'));
  writeFileSync(join(dir, '2026-07-01.md'), '# t\n\n## Old entry\nancient work\n');
  writeFileSync(join(dir, '2026-07-08.md'), '# t\n\n## Shipped approve→builder\nVerified live on the app.\n\n## Overnight loop\nMorning briefing works.\n');
  writeFileSync(join(dir, '2026-07-09.md'), '# t\n\n## Local coding agent\nPR #167 opened from the local model.\n');
  const d = digestTimelineDir(dir, 2, 2000);
  assert.ok(d.includes('2026-07-08') && d.includes('2026-07-09'), 'keeps the last N days');
  assert.ok(!d.includes('2026-07-01'), 'drops older days beyond N');
  assert.ok(d.includes('Shipped approve→builder: Verified live on the app.'), 'heading + first line');
  assert.ok(d.indexOf('2026-07-08') < d.indexOf('2026-07-09'), 'oldest → newest');
});

test('digestTimelineDir is safe on a missing dir', () => {
  assert.equal(digestTimelineDir('/nope/nothing/here', 7, 500), '');
});

// ---- Vault workspace parsers ----
import { parseDecisionsMd, parseTimelineMd } from '../lib/brain.mjs';

test('parseDecisionsMd extracts dated bullets with section + detail, newest first', () => {
  const md = `# Decision Log\n\n## Product / pricing (Plan A, see [[plan-a]])\n- **2026-07-02 — Free tier = N credits/day.** SUPERSEDES an earlier value.\n- **2026-07-04 — One-time SKUs:** Example SKU **$X**\n\n## Process\n- **2026-07-06 — Ship draft PRs only.** See [[protocol]].\n`;
  const d = parseDecisionsMd(md);
  assert.equal(d.length, 3);
  assert.equal(d[0].date, '2026-07-06');
  assert.match(d[0].title, /draft PRs/);
  assert.match(d[2].detail, /SUPERSEDES/);
  assert.match(d[2].section, /Product \/ pricing/);
  assert.ok(!d[0].detail.includes('[['), 'wiki-links stripped');
});

test('parseTimelineMd extracts heading + first body line per entry', () => {
  const md = `---\ntitle: x\n---\n\n## Board meeting run-1\n\nrun-1: focus "Users" · 19 auto\n\n## Shipped the coder\nPR #167 opened.\n`;
  const e = parseTimelineMd(md);
  assert.equal(e.length, 2);
  assert.equal(e[0].heading, 'Board meeting run-1');
  assert.match(e[0].text, /focus "Users"/);
  assert.match(e[1].text, /PR #167/);
});

test('the baked dashboard client JS PARSES (template-literal escaping guard)', async () => {
  const fs = await import('node:fs');
  const p = new URL('../public/command-center.html', import.meta.url).pathname;
  if (!fs.existsSync(p)) return; // no baked dashboard in this env
  const m = fs.readFileSync(p, 'utf8').match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, 'script tag present');
  assert.doesNotThrow(() => new Function(m[1])); // parse-only — a syntax error here kills every button
});

// ---- deptAgenda smoke: EXECUTE the whole body (the PR #46 landmine guard) --------------------------
// PR #46 added a call to an undefined function inside deptAgenda and the gate stayed green because
// no test ever ran this path. These do — with reason() stubbed so no model or network is touched.
const { deptAgenda } = await import('./run.mjs');
const { departmentById } = await import('../org/org.mjs');
const FOCUS = { title: 'Test focus', northStar: 'test', dept: {} };
const ARGS = { focus: FOCUS, kpisStr: '', digest: '', memBlock: '', timeline: '', directiveBlock: '', openTaskTitles: [], decidedLines: [] };

test('deptAgenda executes end-to-end and returns null on an unusable model reply (never throws)', async () => {
  const dept = departmentById('growth');
  const out = await deptAgenda({ ...ARGS, dept, reasonFn: async () => ({ text: 'not json at all', engine: 'stub' }) });
  assert.equal(out, null);
  const dead = await deptAgenda({ ...ARGS, dept, reasonFn: async () => ({ text: '', engine: 'fallback' }) });
  assert.equal(dead, null);
});

test('deptAgenda returns normalized proposals on a good reply', async () => {
  const dept = departmentById('growth');
  const kind = dept.workers.find((w) => !w.dormant).outputs;
  const reply = JSON.stringify({ read: 'Growth read.', proposals: [{ title: 'Do the thing', detail: 'Concretely. Done means: the thing is live and observable.', kind }] });
  const out = await deptAgenda({ ...ARGS, dept, reasonFn: async () => ({ text: reply, engine: 'stub' }) });
  assert.ok(out);
  assert.equal(out.proposals.length, 1);
  assert.equal(out.engine, 'stub');
});

test('deptAgenda tells the model what was ALREADY closed (the resurrection guard)', async () => {
  const dept = departmentById('growth');
  let seenPrompt = '';
  await deptAgenda({ ...ARGS, dept, closedTaskTitles: ['Upgrade Chronos SDK to Latest Stable Version'],
    reasonFn: async ({ prompt }) => { seenPrompt = prompt; return { text: '', engine: 'fallback' }; } });
  assert.match(seenPrompt, /ALREADY DONE OR REJECTED/);
  assert.match(seenPrompt, /Upgrade Chronos SDK/);
});

// ---- proposal copy for BUILDABLE kinds is load-bearing (PR #74 deleted 'platform PR') ---------------
test('every buildable kind keeps its dedicated proposal copy', async () => {
  const { draftProposal } = await import('./run.mjs');
  const { buildTargetFor } = await import('./policy.mjs');
  for (const kind of ['platform PR', 'bugfix PR', 'feature PR']) {
    assert.ok(buildTargetFor(kind), `${kind} is buildable`);
    const p = draftProposal({ id: 'w', title: 'W', dept: 'd', charter: 'the charter', outputs: kind }, null, null);
    assert.ok(p.body && p.body !== 'Owns: the charter', `${kind} has dedicated copy (got: ${p.body})`);
    assert.match(p.body, /Approve to build/i, `${kind} copy tells Brandon it builds`);
  }
});
