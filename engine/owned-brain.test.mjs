// Tests for the OWNED, deterministic answer engine (engine/owned-brain.mjs). Every skill is exercised
// with INJECTED fake deps returning fixtures — no network, no LLM, no real connectors. We prove: each
// skill matches its trigger phrases and NOT unrelated ones; pr-safety extracts the number and returns
// ⚠️ on a conflicting/failing PR and ✅ on a clean one; ship-log formats timeline + merged-PR fixtures;
// a thrown dep in a matched skill falls through to handled:false; and every reply carries Markdown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerOwned, SKILL_IDS, SKILL_CATALOG } from './owned-brain.mjs';

// ---- fixtures ---------------------------------------------------------------
const REPO = 'begindtheseen/seen';
const TOOL_REPO = 'begindtheseen/seen-command';

// A clean, mergeable PR with green CI and a small diff → ✅.
const CLEAN_PR = {
  number: 249, state: 'open', merged: false, draft: false, head: 'feature/x',
  headSha: 'abc1234', mergeable: true, mergeableState: 'clean', url: `https://github.com/${REPO}/pull/249`,
};
// A conflicting PR with failing CI and a huge diff → ⚠️.
const BAD_PR = {
  number: 250, state: 'open', merged: false, draft: false, head: 'feature/y',
  headSha: 'def5678', mergeable: false, mergeableState: 'dirty', url: `https://github.com/${REPO}/pull/250`,
};

function baseDeps(over = {}) {
  return {
    githubRepo: () => REPO,
    commandRepo: () => TOOL_REPO,
    async openPRsFor() { return [CLEAN_PR]; },
    async prInfo({ number }) { return number === 250 ? BAD_PR : CLEAN_PR; },
    async ciStatus(sha) {
      if (sha === 'def5678') return { state: 'failing', sha, runs: [{ name: 'unit', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }] };
      return { state: 'passing', sha, runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] };
    },
    async prFiles({ number }) { return number === 250 ? Array.from({ length: 42 }, (_, i) => `src/f${i}.js`) : ['src/one.js', 'src/two.js']; },
    async recentCommits() {
      return [
        { sha: 'aaa', message: 'Merge pull request #137 from begindtheseen/claude/brain-git-episodes', url: `https://github.com/${REPO}/pull/137` },
        { sha: 'bbb', message: 'regular commit, not a merge', url: `https://github.com/${REPO}/commit/bbb` },
      ];
    },
    async readTimelineDigest() { return '2026-08-01:\n  - Board meeting run-42: focus "self-capable"\n  - Approved action — Ghost Report: drafted live'; },
    async readTimelineEntries() { return [{ date: '2026-08-01', entries: [{ heading: 'x', text: 'y' }] }]; },
    async signals() {
      return {
        github: { repo: REPO, ci: { state: 'failing', runs: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }] }, openPRs: [] },
        vercel: { deployment: { state: 'READY', url: 'seen.vercel.app' } },
        admin: { errors: { today: 3, thisWeek: 9 }, jobs: { crisis: false } },
      };
    },
    async adminSnapshot() {
      return { users: { total: 1200, newToday: 14, dau: 300 }, revenue: { month: 4200, payingCustomers: 88, prepPurchases: 70, passPurchases: 18, interviews: 140 }, jobs: { active: 500, stale: 40, crisis: false }, errors: { today: 3, thisWeek: 9 } };
    },
    async vercelState() { return { configured: true, state: 'READY', url: 'seen.vercel.app', sha: 'abc1234' }; },
    capabilities: () => '• WRITE CODE — YES. details here.\n• LIVE CONNECTORS — GitHub, Supabase.\n• CHRONOS BRAIN — the shared memory graph.',
    async platformStatus() {
      return {
        at: '2026-08-04T00:00:00Z',
        health: { overall: 'healthy', counts: { broken: 0, degraded: 0, missing: 0, healthy: 2 }, checks: [
          { label: 'GitHub', status: 'healthy', detail: 'live', source: 'github' },
          { label: 'Brain', status: 'healthy', detail: 'live', source: 'brain' },
        ] },
        state: { runId: 'run-99', focusId: 'users', pendingApprovals: 1 },
        tasks: { openCount: 1, recent: [{ number: 7, title: 'Wire forge status' }] },
        builds: { recent: [{ id: 'task-7', status: 'building' }] },
        activity: { count: 2 }, brain: { available: true, factCount: 10 },
        repos: { commandRepo: { branch: 'main', sha: 'abc' }, productRepo: { branch: 'next', sha: 'def' } },
      };
    },
    ...over,
  };
}

const hasMarkdown = (s) => /(^|\n)#{1,3} |\*\*|(^|\n)- |\[.+\]\(.+\)/.test(s);

// ---- router basics ----------------------------------------------------------
test('unrelated prompt is not handled', async () => {
  const r = await answerOwned({ message: 'write me a poem about the sea', deps: baseDeps() });
  assert.equal(r.handled, false);
});

test('empty message is not handled', async () => {
  const r = await answerOwned({ message: '   ', deps: baseDeps() });
  assert.equal(r.handled, false);
});

test('exposes the full skill roster, most-specific first', () => {
  assert.deepEqual(SKILL_IDS, [
    'aggregation', 'pr-safety', 'pr-list', 'task-detail', 'task-list', 'build-status', 'activity-digest',
    'approval-queue', 'decisions', 'ship-log',
    'credential-audit', 'deploy-drift', 'build-gaps', 'failure-queue', 'export-logs', 'search-everything',
    'self-diagnosis', 'platform-overview', 'whats-failing', 'forge-status', 'brain-know',
    'creators', 'kpi-quick', 'business-summary', 'deploy-status', 'capabilities', 'can-i',
  ]);
});

// The Board Room could not confirm abilities it demonstrably had, because the capability answer was
// a hand-written prose list that drifted the moment a skill shipped. The roster is now derived — and
// this test is the thing that keeps it derived: add a skill without cataloguing it and this fails.
test('every owned skill is catalogued, so the capability answer can never go stale', () => {
  const missing = SKILL_IDS.filter((id) => !SKILL_CATALOG[id]);
  assert.deepEqual(missing, [], `skills missing a SKILL_CATALOG entry: ${missing.join(', ')}`);
  for (const [id, c] of Object.entries(SKILL_CATALOG)) {
    assert.ok(SKILL_IDS.includes(id), `SKILL_CATALOG has a stale entry for a removed skill: ${id}`);
    assert.ok(c.what && c.ask, `${id} needs both a description and an example question`);
  }
});

test('capabilities lists every live skill and the ops commands, not a frozen blurb', async () => {
  const r = await answerOwned({ message: 'what can you do', deps: { opsUsage: async () => ({ commands: { drift: 'merged vs deployed' } }) } });
  assert.equal(r.skill, 'capabilities');
  for (const id of ['credential-audit', 'deploy-drift', 'export-logs', 'search-everything', 'pr-safety']) {
    assert.match(r.reply, new RegExp(id), `capabilities answer must mention ${id}`);
  }
  assert.match(r.reply, /record fact/);   // the wired brain-write action
  assert.match(r.reply, /merged vs deployed/); // the ops CLI usage, pulled live
});

test('"what skills do you have" and "list your commands" reach the roster', async () => {
  for (const q of ['what skills do you have', 'list your capabilities', 'what are your abilities']) {
    const r = await answerOwned({ message: q, deps: { opsUsage: async () => ({ commands: {} }) } });
    assert.equal(r.skill, 'capabilities', `"${q}" should hit capabilities`);
  }
});

test('can-i answers a specific ability question with the exact trigger phrasing', async () => {
  const r = await answerOwned({ message: 'can you search the code?' });
  assert.equal(r.skill, 'can-i');
  assert.match(r.reply, /search-everything/);
  assert.match(r.reply, /search everything for/); // tells him how to actually ask
});

test('can-i confirms a wired ACTION as something that really executes', async () => {
  const r = await answerOwned({ message: 'can you remember things' });
  assert.equal(r.skill, 'can-i');
  assert.match(r.reply, /remember/);
  assert.match(r.reply, /really executes/);
});

// The dangerous failure is the opposite of the original bug: claiming an ability it lacks. A
// knowledge question must fall through to the model, never be answered "yes" off a stray word.
test('can-i declines non-capability questions instead of claiming yes', async () => {
  for (const q of ['can you explain how supabase RLS works', 'can you write me a poem']) {
    const r = await answerOwned({ message: q });
    assert.equal(r.handled, false, `"${q}" must fall through to the model`);
  }
});

// ---- pr-safety --------------------------------------------------------------
for (const phrase of ['is PR 249 safe to merge', 'what\'s wrong with pr 249', 'look at pr 249', 'should I merge 249', 'review pr 249']) {
  test(`pr-safety matches: "${phrase}"`, async () => {
    const r = await answerOwned({ message: phrase, deps: baseDeps() });
    assert.equal(r.handled, true);
    assert.equal(r.skill, 'pr-safety');
    assert.equal(r.engine, 'owned:pr-safety');
    assert.ok(hasMarkdown(r.reply));
  });
}

test('pr-safety extracts the number and returns ✅ on a clean PR', async () => {
  const r = await answerOwned({ message: 'is PR 249 safe to merge?', deps: baseDeps() });
  assert.equal(r.skill, 'pr-safety');
  assert.match(r.reply, /PR #249/);
  assert.match(r.reply, /✅/);
  assert.ok(r.sources.includes(`gh:${REPO}#249`));
});

test('pr-safety resolves "latest PR" without an LLM', async () => {
  const r = await answerOwned({ message: 'is the latest PR safe to merge?', deps: baseDeps() });
  assert.equal(r.engine, 'owned:pr-safety'); assert.match(r.reply, /PR #249/); assert.match(r.reply, /✅/);
});

test('pr-safety returns ⚠️ on a CONFLICTING + failing + huge PR with reasons', async () => {
  const r = await answerOwned({ message: 'should I merge 250?', deps: baseDeps() });
  assert.equal(r.skill, 'pr-safety');
  assert.match(r.reply, /⚠️/);
  assert.match(r.reply, /conflict/i);
  assert.match(r.reply, /failing/i);
  assert.match(r.reply, /Files changed:\s*42/); // diff size surfaced
});

test('pr-safety falls back to the tool repo when product 404s, then notes it', async () => {
  const deps = baseDeps({
    async prInfo({ repo, number }) {
      if (repo === REPO) throw new Error(`GitHub GET /repos/${REPO}/pulls/${number} → 404: Not Found`);
      return { ...CLEAN_PR, number, url: `https://github.com/${TOOL_REPO}/pull/${number}` };
    },
  });
  const r = await answerOwned({ message: 'is pr 12 safe to merge', deps });
  assert.equal(r.handled, true);
  assert.match(r.reply, /tool repo/i);
  assert.ok(r.sources.includes(`gh:${TOOL_REPO}#12`));
});

test('pr-safety honors an explicit Seen Command repo even when the same PR number exists in product', async () => {
  const calls = [];
  const deps = baseDeps({
    async prInfo({ repo, number }) {
      calls.push(repo);
      return { ...CLEAN_PR, number, merged: true, url: `https://github.com/${repo}/pull/${number}` };
    },
  });
  const r = await answerOwned({ message: 'what is Seen Command PR 151?', deps });
  assert.deepEqual(calls, [TOOL_REPO]);
  assert.match(r.reply, /Seen Command PR #151/);
  assert.match(r.reply, new RegExp(`${TOOL_REPO}/pull/151`));
  assert.ok(r.sources.includes(`gh:${TOOL_REPO}#151`));
});

test('pr-safety honors an explicit product repo and labels the answer', async () => {
  const calls = [];
  const deps = baseDeps({
    async prInfo({ repo, number }) { calls.push(repo); return { ...CLEAN_PR, number, url: `https://github.com/${repo}/pull/${number}` }; },
  });
  const r = await answerOwned({ message: 'review SeenJobs product PR 251', deps });
  assert.deepEqual(calls, [REPO]);
  assert.match(r.reply, /Seen product PR #251/);
  assert.ok(r.sources.includes(`gh:${REPO}#251`));
});

test('an explicit repo miss never silently falls across to the other repo', async () => {
  const calls = [];
  const deps = baseDeps({ async prInfo({ repo }) { calls.push(repo); throw new Error('GitHub 404'); } });
  const r = await answerOwned({ message: 'review Seen Command PR 999', deps });
  assert.deepEqual(calls, [TOOL_REPO]);
  assert.match(r.reply, new RegExp(TOOL_REPO));
  assert.doesNotMatch(r.reply, new RegExp(`or.*${REPO}`));
});

test('pr-safety graceful not-found when PR missing in both repos', async () => {
  const deps = baseDeps({ async prInfo() { throw new Error('GitHub GET → 404: Not Found'); } });
  const r = await answerOwned({ message: 'review pr 999', deps });
  assert.equal(r.handled, true);
  assert.match(r.reply, /couldn't find/i);
});

test('pr-safety falls through (handled:false) when GitHub is not configured', async () => {
  const deps = baseDeps({ async prInfo() { throw new Error('GitHub not configured (set GITHUB_TOKEN)'); } });
  const r = await answerOwned({ message: 'is pr 249 safe to merge', deps });
  assert.equal(r.handled, false);
});

test('pr-safety reports already-merged', async () => {
  const deps = baseDeps({ async prInfo() { return { ...CLEAN_PR, merged: true }; } });
  const r = await answerOwned({ message: 'merge pr 249?', deps });
  assert.match(r.reply, /already \*\*merged\*\*/);
});

// ---- ship-log ---------------------------------------------------------------
for (const phrase of ['what did we ship this week', 'what did we get done lately', 'show me recent progress', 'what happened recently']) {
  test(`ship-log matches: "${phrase}"`, async () => {
    const r = await answerOwned({ message: phrase, deps: baseDeps() });
    assert.equal(r.skill, 'ship-log');
    assert.ok(hasMarkdown(r.reply));
  });
}

test('ship-log formats timeline + merged PR fixtures', async () => {
  const r = await answerOwned({ message: 'what did we ship this week', deps: baseDeps() });
  assert.match(r.reply, /Shipped recently/);
  assert.match(r.reply, /Board meeting run-42/);   // from the timeline digest
  assert.match(r.reply, /#137/);                    // merged PR extracted from commits
  assert.ok(r.sources.includes('vault:timeline'));
});

test('ship-log is honest when timeline + commits are empty', async () => {
  const deps = baseDeps({ async readTimelineDigest() { return ''; }, async recentCommits() { return []; } });
  const r = await answerOwned({ message: 'what did we ship this week', deps });
  assert.equal(r.handled, true);
  assert.match(r.reply, /don't see anything/i);
});

// ---- whats-failing ----------------------------------------------------------
for (const phrase of ['what\'s failing', 'is anything broken', 'any errors today', 'what needs attention']) {
  test(`whats-failing matches: "${phrase}"`, async () => {
    const r = await answerOwned({ message: phrase, deps: baseDeps() });
    assert.equal(r.skill, 'whats-failing');
  });
}

test('whats-failing lists failing CI + error counts', async () => {
  const r = await answerOwned({ message: 'is anything broken?', deps: baseDeps() });
  assert.match(r.reply, /CI failing/);
  assert.match(r.reply, /e2e/);
  assert.match(r.reply, /error/i);
});

test('whats-failing says nothing failing when clean', async () => {
  const deps = baseDeps({
    async signals() {
      return { github: { repo: REPO, ci: { state: 'passing', runs: [] }, openPRs: [] }, vercel: { deployment: { state: 'READY' } }, admin: { errors: { today: 0, thisWeek: 0 }, jobs: {} } };
    },
  });
  const r = await answerOwned({ message: 'what\'s failing?', deps });
  assert.match(r.reply, /Nothing failing/);
});

test('whats-failing falls through when no signal source is reachable', async () => {
  const deps = baseDeps({ async signals() { return { github: { notConfigured: true }, vercel: { configured: false }, admin: { error: 'boom' } }; } });
  const r = await answerOwned({ message: 'is anything broken', deps });
  assert.equal(r.handled, false);
});

// ---- business-summary -------------------------------------------------------
for (const phrase of ['summarize the business', 'how are we doing', 'state of the business', 'show me the numbers']) {
  test(`business-summary matches: "${phrase}"`, async () => {
    const r = await answerOwned({ message: phrase, deps: baseDeps() });
    assert.equal(r.skill, 'business-summary');
  });
}

test('business-summary renders KPI tiles', async () => {
  const r = await answerOwned({ message: 'summarize the business', deps: baseDeps() });
  assert.match(r.reply, /1200 total/);
  assert.match(r.reply, /\$4200 in the last 30 days, one-time · 88 paying \(70 Interview Prep, 18 Job Search Pass\)/);
  assert.doesNotMatch(r.reply, /MRR/);
  assert.match(r.reply, /500 active/);
  assert.ok(r.sources.includes('admin:stats'));
});

test('business-summary falls back to cached state.debrief.kpis when admin-stats is down', async () => {
  const deps = baseDeps({ async adminSnapshot() { throw new Error('admin-stats not configured'); } });
  const r = await answerOwned({ message: 'how are we doing', state: { debrief: { kpis: { MRR: '$4200', Users: 1200 } } }, deps });
  assert.equal(r.handled, true);
  assert.match(r.reply, /cached/i);
  assert.match(r.reply, /MRR/);
});

test('business-summary falls through when admin-stats down and no cache', async () => {
  const deps = baseDeps({ async adminSnapshot() { throw new Error('admin-stats not configured'); } });
  const r = await answerOwned({ message: 'how are we doing', deps });
  assert.equal(r.handled, false);
});

// ---- deploy-status ----------------------------------------------------------
for (const phrase of ['is prod up', 'deploy status', 'did it deploy', 'is the site live', 'latest deployment']) {
  test(`deploy-status matches: "${phrase}"`, async () => {
    const r = await answerOwned({ message: phrase, deps: baseDeps() });
    assert.equal(r.skill, 'deploy-status');
  });
}

test('deploy-status reports READY prod + URL', async () => {
  const r = await answerOwned({ message: 'is prod up?', deps: baseDeps() });
  assert.match(r.reply, /Production is live/);
  assert.match(r.reply, /seen\.vercel\.app/);
  assert.ok(r.sources.includes('vercel:deploy'));
});

test('deploy-status reports ERROR state', async () => {
  const deps = baseDeps({ async vercelState() { return { configured: true, state: 'ERROR', url: 'seen.vercel.app' }; } });
  const r = await answerOwned({ message: 'deploy status', deps });
  assert.match(r.reply, /errored/i);
});

test('deploy-status falls through when Vercel is unconfigured', async () => {
  const deps = baseDeps({ async vercelState() { return { configured: false }; } });
  const r = await answerOwned({ message: 'is prod up', deps });
  assert.equal(r.handled, false);
});

// ---- capabilities -----------------------------------------------------------
for (const phrase of ['what can you do', 'what are you', 'help', 'how do you work', 'show me you work', 'briefly explain how you work']) {
  test(`capabilities matches: "${phrase}"`, async () => {
    const r = await answerOwned({ message: phrase, deps: baseDeps() });
    assert.equal(r.skill, 'capabilities');
    assert.ok(hasMarkdown(r.reply));
  });
}

test('capabilities answers from the live roster, with example phrasings', async () => {
  const r = await answerOwned({ message: 'what can you do?', deps: baseDeps() });
  assert.match(r.reply, /instant owned skills/i);
  assert.match(r.reply, /pr-safety/);            // a real skill id, not a prose paraphrase
  assert.match(r.reply, /is PR 249 safe to merge/); // the phrasing that actually triggers it
  assert.ok(r.sources.includes('owned:roster'));
});

// ---- fallthrough on a thrown dep --------------------------------------------
test('a thrown dep in a matched skill yields handled:false (graceful fallthrough)', async () => {
  const deps = baseDeps({ async signals() { throw new Error('network down'); } });
  const r = await answerOwned({ message: 'is anything broken?', deps });
  assert.equal(r.handled, false);
});

// ---- default deps present ---------------------------------------------------
test('answerOwned works with default deps injected (no deps arg) for a no-network skill', async () => {
  // capabilities uses only the CAPABILITIES manifest (no network), so real defaults are safe here.
  const r = await answerOwned({ message: 'what can you do' });
  assert.equal(r.handled, true);
  assert.equal(r.skill, 'capabilities');
});

// ---- the 10x expansion: nine new owned skills, all fixture-fed ----------------------------------
function bigDeps(over = {}) {
  return baseDeps({
    async issuesFor(repo) { return repo === TOOL_REPO ? [{ number: 7, title: 'Wire forge status into the dashboard', labels: ['self-improvement'], url: 'u7' }] : []; },
    githubConfigured: () => true,
    async issueInfo(repo, number) {
      if (repo !== TOOL_REPO || number !== 7) return null;
      return { number: 7, title: '[platform] Wire forge status into the dashboard', body: 'Show the live Forge state.', state: 'open', labels: ['self-improvement'], url: 'u7', updatedAt: '2026-08-04T06:00:00Z' };
    },
    listBuilds: () => [
      { id: 'task-7', repo: 'tool', status: 'building', title: 'wire forge status' },
      { id: 'chat-abc', repo: 'product', status: 'pr_ready', pr: 'https://github.com/x/y/pull/9', title: 'freshness note' },
    ],
    readActivity: () => [
      { ts: '2026-08-04T05:00:00Z', kind: 'board-meeting', status: 'ok', summary: 'run-99: 12 proposals' },
      { ts: '2026-08-04T06:00:00Z', kind: 'build', status: 'green', summary: 'task-7 gate green' },
    ],
    servedTags: async () => new Set(['qwen2.5-coder:32b', 'devstral:24b']),
    clineBin: () => '/bin/sh', // exists on every mac — stands in for an installed cline
    clineSel: () => ({ provider: 'cline', model: 'openai/gpt-5.3-codex' }),
    readBrainFacts: () => [
      { subject: 'Seen', predicate: 'ghost_rate_source', object: 'company_scores table', valid_from: '2026-07-01' },
      { subject: 'Forge lessons', predicate: 'failure-abc', object: 'windows cut template literals' },
    ],
    rankFacts: (facts, q) => facts.filter((f) => `${f.subject} ${f.predicate} ${f.object}`.toLowerCase().includes(String(q).split(' ')[0].toLowerCase())),
    readDecisions: () => [{ date: '2026-08-03', title: 'Free-only coding lanes by default', why: 'no paid credits ever' }],
    igProjects: async () => [{ name: 'creator-alpha', username: 'creator_alpha', counts: { videos: 40, knowledge: 100, evidence: 1000 } }],
    creatorInsights: async (p = null) => {
      const { buildInsights } = await import('../lib/instagram/insights.mjs');
      const { fixtureCorpora, FIXTURE_NOW } = await import('../lib/instagram/insights.fixtures.mjs');
      const all = fixtureCorpora();
      return buildInsights(p ? all.filter((c) => c.project === 'instagram-alpha' && p === 'creator-alpha') : all, { now: FIXTURE_NOW });
    },
    answerCreatorQuestion: async (lib, q) => (await import('../lib/instagram/insights.mjs')).answerCreatorQuestion(lib, q),
    ...over,
  });
}

test('pr-list: both repos listed; a numbered ask stays with pr-safety', async () => {
  const r = await answerOwned({ message: 'what PRs are open?', deps: bigDeps() });
  assert.equal(r.skill, 'pr-list');
  assert.match(r.reply, /Open PRs/);
  assert.match(r.reply, /#249/); // the fixture PR
  const r2 = await answerOwned({ message: 'is PR 250 safe to merge?', deps: bigDeps() });
  assert.equal(r2.skill, 'pr-safety', 'numbers still route to the merge check');
});

test('task-list: real open issues with labels + build hint', async () => {
  const r = await answerOwned({ message: 'any open tasks?', deps: bigDeps() });
  assert.equal(r.skill, 'task-list');
  assert.match(r.reply, /#7/);
  assert.match(r.reply, /Wire forge status/);
});

test('task-list does not hijack a conversational follow-up about the previously inspected task', async () => {
  const r = await answerOwned({ message: 'What task number did you just inspect, and had its build started?', deps: bigDeps() });
  assert.equal(r.handled, false);
});

test('task-detail: “what is going on with task N” joins live GitHub state to its current build record', async () => {
  const r = await answerOwned({ message: "what's going on with task 7?", deps: bigDeps() });
  assert.equal(r.skill, 'task-detail');
  assert.match(r.reply, /Task #7/);
  assert.match(r.reply, /Open on GitHub/);
  assert.match(r.reply, /latest build: `building`/);
  assert.match(r.reply, /actively working on it now/);
  assert.ok(r.sources.includes(`gh:${TOOL_REPO}#7`));
  assert.ok(r.sources.includes('builds:records'));
});

test('task-detail: failed open task reports the live blocker instead of stale Brain history', async () => {
  const r = await answerOwned({ message: 'status of issue #7', deps: bigDeps({
    listBuilds: () => [{ id: 'task-7', issue: { repo: TOOL_REPO, number: 7 }, repo: 'tool', status: 'failed', error: 'reviewer rejected an empty file', updatedAt: '2026-08-04T06:10:00Z' }],
  }) });
  assert.equal(r.skill, 'task-detail');
  assert.match(r.reply, /reviewer rejected an empty file/);
  assert.match(r.reply, /current work/);
});

test('build-status: in-flight counts + per-record icons', async () => {
  const r = await answerOwned({ message: 'build status?', deps: bigDeps() });
  assert.equal(r.skill, 'build-status');
  assert.match(r.reply, /1 build\(s\) in flight/);
  assert.match(r.reply, /task-7/);
  assert.match(r.reply, /pr_ready/);
});

test('activity-digest: Brandon trigger phrase → ledger tally + lines', async () => {
  const r = await answerOwned({ message: 'review seen command updates', deps: bigDeps() });
  assert.equal(r.skill, 'activity-digest');
  assert.match(r.reply, /2 events/);
  assert.match(r.reply, /board-meeting×1/);
});

test('approval-queue: pending Seen Command proposals include ids and edit/approve controls', async () => {
  const state = { approvals: [{ id: 'run-a2', status: 'pending', title: 'Ghost Report', summary: 'Publish a redacted report', dept: 'growth', action: 'intel brief' }] };
  const r = await answerOwned({ message: 'show me the approval queue', state, deps: bigDeps() });
  assert.equal(r.skill, 'approval-queue');
  assert.match(r.reply, /Ghost Report/);
  assert.match(r.reply, /edit approval 2 summary/i);
});

test('self-diagnosis: connection failures and exact fixes come from the unified live health map', async () => {
  const deps = bigDeps({ async platformStatus() {
    return { at: '2026-08-04T00:00:00Z', health: { overall: 'broken', counts: { broken: 1, degraded: 0, missing: 0, healthy: 1 }, checks: [
      { label: 'Supabase advisors', status: 'broken', detail: 'HTTP 401', fix: 'replace management token', source: 'supabase-management' },
      { label: 'GitHub', status: 'healthy', detail: 'live', source: 'github' },
    ] } };
  } });
  const r = await answerOwned({ message: 'what API connections need fixing?', deps });
  assert.equal(r.skill, 'self-diagnosis');
  assert.match(r.reply, /Supabase advisors/);
  assert.match(r.reply, /HTTP 401/);
  assert.match(r.reply, /replace management token/);
});

test('platform-overview: runtime, tasks, builds, Brain, and local checkouts are joined', async () => {
  const r = await answerOwned({ message: 'show me the whole platform', deps: bigDeps() });
  assert.equal(r.skill, 'platform-overview');
  assert.match(r.reply, /run-99/);
  assert.match(r.reply, /#7 Wire forge status/);
  assert.match(r.reply, /Seen Command main@abc/);
});

test('forge-status: served models, cline, lessons count', async () => {
  const r = await answerOwned({ message: 'forge status', deps: bigDeps() });
  assert.equal(r.skill, 'forge-status');
  assert.match(r.reply, /qwen2\.5-coder:32b/);
  assert.match(r.reply, /Cline:\*\* installed \(openai\/gpt-5\.3-codex\)/);
  assert.match(r.reply, /Lessons learned:\*\* 1/);
});

test('brain-know: topic extracted (punctuation stripped), facts cited; empty topic honest', async () => {
  const r = await answerOwned({ message: 'what do we know about ghost rate?', deps: bigDeps() });
  assert.equal(r.skill, 'brain-know');
  assert.match(r.reply, /“ghost rate”/);
  assert.match(r.reply, /company_scores table/);
  const r2 = await answerOwned({ message: 'what do we know about martian geology?', deps: bigDeps() });
  assert.match(r2.reply, /Nothing recorded about/);
});

test('decisions: the locked-calls ledger renders', async () => {
  const r = await answerOwned({ message: 'what did we decide recently?', deps: bigDeps() });
  assert.equal(r.skill, 'decisions');
  assert.match(r.reply, /Free-only coding lanes/);
});

test('creators: list + one creator\'s ranked insights from the insight engine', async () => {
  const r = await answerOwned({ message: 'which creators have we researched?', deps: bigDeps() });
  assert.equal(r.skill, 'creators');
  assert.match(r.reply, /@creator_alpha/);
  const r2 = await answerOwned({ message: 'key points from creator_alpha', deps: bigDeps() });
  assert.equal(r2.skill, 'creators');
  assert.match(r2.reply, /\[emerging · observed\]/, 'one creator alone is labelled emerging, never strong');
  assert.doesNotMatch(r2.reply, /\[strong ·/);
});

test('creators: "what hooks work for job-seeker content?" is answered from the library with citations', async () => {
  const r = await answerOwned({ message: 'what hooks work for job-seeker content?', deps: bigDeps() });
  assert.equal(r.skill, 'creators');
  assert.match(r.reply, /What the Creator Library shows — hook/);
  assert.match(r.reply, /\[hook · observed · strong\]/);
  assert.match(r.reply, /3 creators \/ 10 videos/);
  assert.match(r.reply, /@alpha 0:00–0:02 https:\/\/example\.invalid/);
  // Nothing in the library for the question → the skill declines and the model answers.
  const none = await answerOwned({ message: 'what hooks work for job-seeker content?', deps: bigDeps({ creatorInsights: async () => ({ insights: [], totals: {} }) }) });
  assert.notEqual(none.skill, 'creators');
});

test('kpi-quick: single-metric answer from the KPI tiles', async () => {
  const state = { runId: 'run-x', debrief: { kpis: [{ label: 'Total users', value: '1,200' }, { label: 'MRR', value: '$4,200' }] } };
  const r = await answerOwned({ message: 'how many users do we have?', state, deps: bigDeps() });
  assert.equal(r.skill, 'kpi-quick');
  assert.match(r.reply, /Total users: 1,200/);
});

test('new skills fall through gracefully when their source is unreachable', async () => {
  const r = await answerOwned({ message: 'review seen command updates', deps: bigDeps({ readActivity: () => { throw new Error('no ledger'); } }) });
  assert.equal(r.handled, false, 'ledger down → the LLM takes over, never a crash');
});

// --- ops master-kit skills (2026-08-13) -------------------------------------------------------

test('credential-audit skill renders the join without exposing values', async () => {
  const out = await answerOwned({ message: 'run a credential audit', deps: { credentialAudit: async () => ({ overall: 'broken', connectors: [{ id: 'supabase', label: 'Supabase', live: 'broken', detail: 'HTTP 401', fix: 'mint a new token', credentials: [{ key: 'SUPABASE_ACCESS_TOKEN', configured: true }] }] }) } });
  assert.equal(out.handled, true);
  assert.equal(out.skill, 'credential-audit');
  assert.match(out.reply, /mint a new token/);
  assert.match(out.reply, /SUPABASE_ACCESS_TOKEN/);
});

test('deploy-drift skill: drifted, and honest when not checkable', async () => {
  const drifted = await answerOwned({ message: 'drift check', deps: { driftCheck: async () => ({ checkable: true, drifted: true, branch: 'next-migration', branchSha: 'aaaa1111', prodSha: 'bbbb2222', lastRecorded: null }) } });
  assert.equal(drifted.skill, 'deploy-drift');
  assert.match(drifted.reply, /DRIFTED/);
  const unknown = await answerOwned({ message: 'is production in sync?', deps: { driftCheck: async () => ({ checkable: false, drifted: null, lastRecorded: { verdict: 'in sync — abc', since: '2026-08-13' } }) } });
  assert.equal(unknown.skill, 'deploy-drift');
  assert.match(unknown.reply, /Not checkable/);
  assert.match(unknown.reply, /NOT "in sync"/);
  assert.match(unknown.reply, /in sync — abc/);
});

test('export-logs skill reports the bundle path and files', async () => {
  const out = await answerOwned({ message: 'export all logs', deps: { exportLogs: async () => ({ dir: '/data/exports/logs-x', files: ['ci.json', 'health.json'], summary: { files: 2 } }) } });
  assert.equal(out.skill, 'export-logs');
  assert.match(out.reply, /logs-x/);
  assert.match(out.reply, /ci\.json/);
});

test('search-everything skill groups code and facts with references', async () => {
  const out = await answerOwned({ message: 'search everything for ghost rate', deps: { searchAll: async () => ({ code: [{ repo: 'product', file: 'lib/x.js', line: 3, text: 'ghostRate()' }], facts: [{ subject: 'Seen', predicate: 'ghost_rate', object: '12%' }] }) } });
  assert.equal(out.skill, 'search-everything');
  assert.match(out.reply, /product:lib\/x\.js:3/);
  assert.match(out.reply, /ghost_rate/);
});

test('ops skills fall through when their source is unavailable', async () => {
  const out = await answerOwned({ message: 'credential audit', deps: { credentialAudit: async () => { throw new Error('nope'); } } });
  assert.equal(out.handled, false);
});

test('ops skills do not shadow existing skills', async () => {
  const diag = await answerOwned({ message: 'diagnose yourself', deps: { platformStatus: async () => ({ at: 't', health: { overall: 'healthy', counts: { broken: 0, degraded: 0, missing: 0 }, checks: [{ id: 'github', label: 'GitHub', status: 'healthy', detail: 'ok', source: 'github' }] } }) } });
  assert.equal(diag.skill, 'self-diagnosis');
  const dep = await answerOwned({ message: 'latest deploy?', deps: { vercelState: async () => ({ configured: true, state: 'READY', url: 'x.vercel.app' }) } });
  assert.equal(dep.skill, 'deploy-status');
});

// "Nothing should fail ever. And if it does it shouldn't just end there." The chat must be able to
// answer what is stuck, and must lead with whether it is ours to fix or blocked on Brandon.
test('failure-queue splits actionable work from what is blocked on the owner', async () => {
  const r = await answerOwned({ message: "what's stuck?", deps: { opsFailures: async () => ({
    openCount: 2, blocked: 1, actionable: 1, resolved: 3,
    open: [
      { id: 'task-99', repo: 'tool', reason: 'the coder produced an empty file', blocked: false, at: '2026-08-13T01:00:00Z' },
      { id: 'task-111', repo: 'product', reason: 'the Anthropic lane is out of credit', blocked: true, at: '2026-08-13T02:00:00Z' },
    ],
  }) } });
  assert.equal(r.skill, 'failure-queue');
  assert.match(r.reply, /1 actionable/);
  assert.match(r.reply, /1 blocked on you/);
  assert.match(r.reply, /retrying these just fails again/);
  assert.match(r.reply, /out of credit/);
});

test('an empty failure queue says so as a real lookup, not as missing logging', async () => {
  const r = await answerOwned({ message: 'show me the open failures', deps: { opsFailures: async () => ({ openCount: 0, blocked: 0, actionable: 0, resolved: 4, open: [] }) } });
  assert.equal(r.skill, 'failure-queue');
  assert.match(r.reply, /Nothing is in the failure queue/);
  assert.match(r.reply, /4 failure\(s\) have been recorded and resolved/);
});

// "seen command chat bot cant identify its own shortcomings" — the chat must be able to read its own
// failure record and name what is MISSING, ranked by how many failures each gap would have converted.
test('build-gaps names missing capabilities ranked by failures converted', async () => {
  const r = await answerOwned({ message: 'what are you missing?', deps: { buildGaps: async () => ({
    totalBuilds: 100, succeeded: 60, failed: 40, completionRate: 60,
    gaps: [
      { id: 'semantic-gate', missing: 'a did-this-do-the-work check', why: 'the gate proves nothing broke', count: 10, examples: ['task-78', 'task-81'] },
      { id: 'lane-preflight', missing: 'probe lane health first', why: 'billing failures waste a slot', count: 4, examples: ['task-111'] },
    ],
    unclassified: [{ id: 'chat-x', reason: 'weird' }],
  }) } });
  assert.equal(r.skill, 'build-gaps');
  assert.match(r.reply, /Completion rate: 60%/);
  assert.match(r.reply, /a did-this-do-the-work check/);
  assert.match(r.reply, /converted \*\*10\*\* failure/);
  assert.match(r.reply, /task-78/);
  // An unclassified failure must be surfaced, not silently dropped into an optimistic report.
  assert.match(r.reply, /could not classify/);
});

test('build-gaps falls through when there is nothing to learn from', async () => {
  const r = await answerOwned({ message: 'what are you missing?', deps: { buildGaps: async () => ({ totalBuilds: 0, gaps: [] }) } });
  assert.equal(r.handled, false);
});
