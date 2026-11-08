import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPlatform, platformContext, platformStatus } from './platform-status.mjs';

function fixture(over = {}) {
  return {
    cli: {
      claude: { id: 'claude-cli', installed: true, runnable: true, version: '2.1.231', authenticated: true, reason: 'logged in via claude.ai (max plan)', fix: null },
      cline: { id: 'cline', installed: true, runnable: true, version: '3.0.53', authenticated: null, provider: 'cline', model: 'codex', lastTest: { ok: true, at: 'now' }, lastTestStale: false, reason: 'Cline runs', fix: null },
    },
    credentials: { groups: [], cline: { installed: true, model: 'codex', lastTest: { ok: true, at: 'now' } } },
    llm: { groq: true },
    signals: {
      github: { repo: 'o/product', ci: { state: 'passing' } },
      admin: { users: { total: 1200 }, jobs: { active: 100 }, errors: { today: 0 } },
      supabase: { health: { configured: true, up: true, status: 200 }, advisors: { available: true, count: 0 } },
      vercel: { deployment: { configured: true, state: 'READY' } },
      stripe: { subscriptions: { activeCount: 1, mrr: 10 } },
    },
    repos: { commandRepo: { reachable: true, branch: 'main', sha: 'abc' }, productRepo: { reachable: true, branch: 'next', sha: 'def' } },
    state: { available: true, runId: 'run-1', pendingApprovals: 1, approvals: [{ id: 'a1', title: 'Ship it' }] },
    tasks: { openCount: 2, recent: [{ number: 20, title: 'Fix live tasks' }] },
    builds: { recent: [{ id: 'task-20', status: 'building' }], slot: { id: 'task-20' } },
    activity: { count: 3, recent: [] },
    brain: { available: true, factCount: 12 },
    ...over,
  };
}

test('assessPlatform reports fully healthy nested connector shapes', () => {
  const health = assessPlatform(fixture());
  assert.equal(health.overall, 'healthy');
  assert.equal(health.counts.broken, 0);
  assert.equal(health.checks.find((c) => c.id === 'vercel').status, 'healthy');
});

test('Supabase database can be healthy while advisors are correctly broken with an actionable 401 fix', () => {
  const s = fixture();
  s.signals.supabase.advisors = { available: false, status: 401 };
  const health = assessPlatform(s);
  assert.equal(health.checks.find((c) => c.id === 'supabase-db').status, 'healthy');
  const advisor = health.checks.find((c) => c.id === 'supabase-advisors');
  assert.equal(advisor.status, 'broken');
  assert.match(advisor.detail, /401/);
  assert.match(advisor.fix, /Management access token/i);
});

test('the advisor check carries the connector diagnosis instead of the generic guess', () => {
  const s = fixture();
  s.signals.supabase.advisors = { available: false, status: 401, message: 'Unauthorized', reason: 'token-rejected', fix: 'Create a new token at https://supabase.com/dashboard/account/tokens.' };
  const advisor = assessPlatform(s).checks.find((c) => c.id === 'supabase-advisors');
  assert.equal(advisor.status, 'broken');
  assert.match(advisor.detail, /HTTP 401\): Unauthorized/);
  assert.match(advisor.fix, /account\/tokens/);
});

test('advisors with no credentials read as missing, not broken', () => {
  const s = fixture();
  s.signals.supabase.advisors = { available: false, reason: 'not-configured', fix: 'Add a Management access token.' };
  const advisor = assessPlatform(s).checks.find((c) => c.id === 'supabase-advisors');
  assert.equal(advisor.status, 'missing');
  assert.match(advisor.fix, /Management access token/);
});

test('nested unconfigured Vercel response never paints a false green', () => {
  const s = fixture();
  s.signals.vercel = { deployment: { configured: false } };
  assert.equal(assessPlatform(s).checks.find((c) => c.id === 'vercel').status, 'missing');
});

test('platformStatus joins runtime sources and never includes credential values', async () => {
  const report = await platformStatus({
    signalsFn: async () => fixture().signals,
    issuesForFn: async () => [{ number: 20, title: 'Fix tasks', labels: [], url: 'u' }],
    credentialStatusFn: () => fixture().credentials,
    llmStatusFn: () => ({ groq: true }),
    loadStateFn: () => ({ runId: 'run-x', focusId: 'users', approvals: [{ id: 'a1', title: 'Approve me', status: 'pending' }], proposals: [] }),
    listBuildsFn: () => [{ id: 'task-20', title: 'Fix tasks', status: 'failed', error: 'gate red' }],
    buildSlotHolderFn: () => null,
    readActivityFn: () => [{ kind: 'build', summary: 'failed' }],
    currentFactsFn: () => [{ subject: 'Seen' }],
    configObj: { commandRepo: () => 'o/tool', commandRepoDir: () => '/tool', productRepoDir: () => '/product' },
    repoProbeFn: (dir) => ({ reachable: true, path: dir, branch: 'main', sha: 'abc' }),
    // Injected so the suite never spawns the real claude/cline binaries.
    claudeCliHealthFn: () => fixture().cli.claude,
    clineCliHealthFn: () => fixture().cli.cline,
  });
  assert.equal(report.tasks.openCount, 1);
  assert.equal(report.state.pendingApprovals, 1);
  assert.equal(report.builds.recent[0].error, 'gate red');
  assert.doesNotMatch(JSON.stringify(report), /secret-value/);
});

// ─── LOCAL AGENT-CLI LANES ───────────────────────────────────────────────────────────────────────
// The regression that made Brandon say the Board Room "can barely tell if its running": Settings
// replayed a RECORDED Cline verdict, so a lane macOS was SIGKILLing on every launch still rendered
// green. A recorded success is never proof that the lane runs now.

test('a SIGKILLed Cline is broken even when a successful test is on record', () => {
  const s = fixture();
  s.cli.cline = { id: 'cline', installed: true, runnable: false, authenticated: null, lastTest: { ok: true, at: '2026-08-12T09:37:26.837Z' }, reason: 'Cline was killed by macOS the moment it launched (SIGKILL, no output) — its code signature is invalid', fix: 'Run `npm run agent:setup` to reinstall and re-sign the Cline binary.' };
  const health = assessPlatform(s);
  const cline = health.checks.find((c) => c.id === 'cline-test');
  assert.equal(cline.status, 'broken', 'a recorded green can never outvote a live kill');
  assert.match(cline.detail, /SIGKILL/);
  assert.match(cline.fix, /agent:setup/);
});

test('a Cline test recorded before the installed binary reads degraded, not healthy', () => {
  const s = fixture();
  s.cli.cline = { ...s.cli.cline, lastTestStale: true, lastTest: { ok: true, at: '2026-08-12T09:37:26.837Z' }, binaryChangedAt: '2026-08-12T09:37:35.841Z' };
  const cline = assessPlatform(s).checks.find((c) => c.id === 'cline-test');
  assert.equal(cline.status, 'degraded');
  assert.match(cline.detail, /stale/);
});

test('the claude CLI is a first-class check: healthy only when it runs AND is logged in', () => {
  assert.equal(assessPlatform(fixture()).checks.find((c) => c.id === 'claude-cli').status, 'healthy');

  const out = fixture();
  out.cli.claude = { id: 'claude-cli', installed: true, runnable: true, authenticated: false, reason: 'the claude CLI is installed but not logged in', fix: 'Run `claude` then /login in Terminal.' };
  const loggedOut = assessPlatform(out).checks.find((c) => c.id === 'claude-cli');
  assert.equal(loggedOut.status, 'broken');
  assert.match(loggedOut.fix, /\/login/);

  const absent = fixture();
  absent.cli.claude = { id: 'claude-cli', installed: false, runnable: false, authenticated: null, reason: 'the claude CLI is not installed', fix: 'Install the Claude CLI.' };
  assert.equal(assessPlatform(absent).checks.find((c) => c.id === 'claude-cli').status, 'missing');
});

test('an UNKNOWN claude auth state is degraded — never healthy, never broken', () => {
  const s = fixture();
  s.cli.claude = { id: 'claude-cli', installed: true, runnable: true, authenticated: null, reason: 'login state is UNKNOWN — the auth check timed out', fix: 'Run `claude auth status`.' };
  const c = assessPlatform(s).checks.find((c) => c.id === 'claude-cli');
  assert.equal(c.status, 'degraded');
  assert.match(c.detail, /UNVERIFIED/);

  // A snapshot with no probe at all is also unknown, not a silent pass.
  const unprobed = fixture(); delete unprobed.cli;
  const both = assessPlatform(unprobed);
  assert.equal(both.checks.find((c) => c.id === 'claude-cli').status, 'degraded');
  assert.notEqual(both.overall, 'healthy');
});

test('an installed-but-unrunnable Cline no longer counts as an available AI lane', () => {
  const s = fixture();
  s.llm = {};
  s.cli.cline = { id: 'cline', installed: true, runnable: false, authenticated: null, reason: 'killed on launch', fix: 'run npm run agent:setup' };
  s.cli.claude = { id: 'claude-cli', installed: true, runnable: false, authenticated: null, reason: 'will not run', fix: 'reinstall' };
  const lanes = assessPlatform(s).checks.find((c) => c.id === 'ai-lanes');
  assert.equal(lanes.status, 'broken', 'installed is not the same as usable');

  // The claude CLI alone is enough to keep the lane check honest-green.
  s.cli.claude = { id: 'claude-cli', installed: true, runnable: true, authenticated: true, reason: 'logged in', fix: null };
  const withClaude = assessPlatform(s).checks.find((c) => c.id === 'ai-lanes');
  assert.equal(withClaude.status, 'healthy');
  assert.match(withClaude.detail, /claude CLI/);
});

test('platformStatus probes both local CLIs and a throwing probe reads unknown, not healthy', async () => {
  const base = {
    signalsFn: async () => fixture().signals,
    issuesForFn: async () => [],
    credentialStatusFn: () => fixture().credentials,
    llmStatusFn: () => ({}),
    loadStateFn: () => null,
    listBuildsFn: () => [],
    buildSlotHolderFn: () => null,
    readActivityFn: () => [],
    currentFactsFn: () => [{ subject: 'Seen' }],
    configObj: { commandRepo: () => 'o/tool', commandRepoDir: () => '/tool', productRepoDir: () => '/product' },
    repoProbeFn: (dir) => ({ reachable: true, path: dir, branch: 'main', sha: 'abc' }),
  };
  const report = await platformStatus({
    ...base,
    claudeCliHealthFn: () => ({ id: 'claude-cli', installed: true, runnable: true, authenticated: true, version: '2.1.231', reason: 'logged in' }),
    clineCliHealthFn: () => { throw new Error('probe exploded'); },
  });
  assert.equal(report.cli.claude.authenticated, true);
  assert.equal(report.cli.cline.installed, null, 'a probe that throws is unknown, not absent');
  const cline = report.health.checks.find((c) => c.id === 'cline-test');
  assert.equal(cline.status, 'degraded');
  assert.match(cline.detail, /probe exploded/);
  assert.equal(report.health.checks.find((c) => c.id === 'claude-cli').status, 'healthy');
});

test('platformContext tells the chat which local lane can actually answer', () => {
  const s = fixture(); s.at = '2026-08-13T00:00:00Z';
  s.cli.cline = { id: 'cline', installed: true, runnable: false, authenticated: null, reason: 'killed by macOS on launch (SIGKILL) — invalid code signature' };
  s.health = assessPlatform(s);
  const text = platformContext(s);
  assert.match(text, /Local agent CLIs/);
  assert.match(text, /claude CLI: usable/);
  assert.match(text, /Cline: BROKEN — killed by macOS/);
});

test('platformContext prioritizes live tasks, builds, approvals, and health in a compact model block', () => {
  const s = fixture(); s.health = assessPlatform(s); s.at = '2026-08-04T00:00:00Z';
  const text = platformContext(s);
  assert.match(text, /runtime truth overrides Brain/);
  assert.match(text, /#20 Fix live tasks/);
  assert.match(text, /task-20:building/);
  assert.match(text, /Ship it/);
});


// Five builds died one at a time trying to write inside the read-only .app bundle (run-202607100119-a1
// and friends), and task-63/65/176 were failed for a red BASE branch they did not cause. Both are
// setup faults to surface ONCE, here.
test('a checkout inside the .app bundle is reported broken, not merely unreachable', () => {
  const h = assessPlatform({
    repos: { commandRepo: { reachable: true, path: '/Applications/Seen Command.app/Contents/Resources/seen', branch: 'main', sha: 'a' },
             productRepo: { reachable: true, path: '/Users/b/seen', branch: 'next', sha: 'b' } },
  });
  const w = h.checks.find((c) => c.id === 'writable-commandRepo');
  assert.equal(w.status, 'broken');
  assert.match(w.detail, /read-only application bundle/);
  assert.match(w.fix, /SEEN_COMMAND_REPO_DIR/);
  assert.equal(h.checks.find((c) => c.id === 'writable-productRepo'), undefined, 'a healthy checkout adds no writability check');
});

test('base-branch health: red gates the queue, and unknown is NEVER green', () => {
  const red = assessPlatform({ baseHealth: { tool: { green: false, base: 'main', reason: 'its suite fails' }, product: { green: true, base: 'next-migration' } } });
  const t = red.checks.find((c) => c.id === 'base-health-tool');
  assert.equal(t.status, 'broken');
  assert.match(t.fix, /queue is gated/);
  assert.match(t.fix, /not at fault/);
  assert.equal(red.checks.find((c) => c.id === 'base-health-product').status, 'healthy');

  const unknown = assessPlatform({ baseHealth: { tool: { green: null, reason: 'never checked' }, product: { green: null } } });
  assert.equal(unknown.checks.find((c) => c.id === 'base-health-tool').status, 'degraded');
  assert.match(unknown.checks.find((c) => c.id === 'base-health-tool').detail, /Unknown is not green/);
});

test('a caller that never gathered base health gets no invented verdict', () => {
  const h = assessPlatform({});
  assert.equal(h.checks.filter((c) => c.id.startsWith('base-health')).length, 0);
});
