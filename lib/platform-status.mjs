// Unified, secret-free platform vision for Settings and the Board Room.
//
// This is intentionally a READ-ONLY collector. It joins live connector probes, credentials (booleans
// only), GitHub task state, local build/activity state, the Brain, and both git checkouts. Callers get
// the same truth whether they are rendering Settings, answering "diagnose yourself", or grounding an
// open-ended Board Room model response. Every dependency is injectable so the health rules are tested
// without touching the network or the user's machine.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { signals } from './connectors/index.mjs';
import { issuesFor } from './connectors/github.mjs';
import { credentialStatus, claudeCliHealth, clineCliHealth } from './credentials.mjs';
import { llmStatus, config } from './config.mjs';
import { loadState } from './memory.mjs';
import { listBuilds, buildSlotHolder } from './builds.mjs';
import { readActivity } from './activity.mjs';
import { currentFacts } from './brain.mjs';
import { readBaseHealth } from './base-health.mjs';

const STATUS_ORDER = { broken: 0, degraded: 1, missing: 2, healthy: 3 };
const clip = (v, n = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const failed = (v) => !!(v && typeof v.error === 'string');
const unavailable = (v) => !v || v.notConfigured === true || v.configured === false;

// What to do about a failed issues read, in words the owner can act on. GitHub answers 404 "Not Found"
// (not 403) when a token cannot see a PRIVATE repository, so a 404 here almost always means the token
// in Settings → GitHub does not include this repository, not that the repository is missing.
export function taskTrackerFix(error, repo) {
  const e = String(error || ''); const r = repo || 'the Seen Command repository';
  if (/\b404\b/.test(e)) return `The GitHub token in Settings → GitHub cannot see ${r} (GitHub says "Not Found" for private repositories a token is not allowed to read). On github.com → Settings → Developer settings → Personal access tokens, edit that token: add ${r} under Repository access and give it Issues: Read and write. Or paste a token that has it into Settings → GitHub.`;
  if (/\b401\b/.test(e)) return 'The GitHub token in Settings → GitHub is expired or revoked. Create a new one on github.com → Settings → Developer settings → Personal access tokens and paste it into Settings → GitHub.';
  if (/\b403\b/.test(e)) return `The GitHub token can see ${r} but lacks permission to read its issues. Edit the token and give it Issues: Read and write.`;
  return 'Repair GitHub access in Settings → GitHub; Board Room task answers need live issue reads.';
}

function check(id, label, status, detail, fix = null, source = null) {
  return { id, label, status, detail: clip(detail), fix: fix ? clip(fix, 500) : null, source };
}

export function probeRepo(dir, { execFile = execFileSync, exists = existsSync } = {}) {
  if (!dir || !exists(dir)) return { configured: !!dir, reachable: false, path: dir || null, error: 'checkout directory does not exist' };
  try {
    const run = (args) => execFile('git', args, { cwd: dir, encoding: 'utf8', timeout: 5000 }).trim();
    return {
      configured: true,
      reachable: true,
      path: dir,
      branch: run(['branch', '--show-current']) || '(detached)',
      sha: run(['rev-parse', '--short', 'HEAD']),
      dirty: !!run(['status', '--porcelain']),
    };
  } catch (e) {
    return { configured: true, reachable: false, path: dir, error: clip(e.message) };
  }
}

function fieldMap(creds) {
  const out = {};
  for (const group of creds?.groups || []) for (const f of group.fields || []) out[f.key] = !!f.configured;
  return out;
}

// The claude CLI is the Board Room's full-capability lane (real tools, a Claude subscription rather
// than API credits). Status vocabulary is deliberate and never optimistic:
//   missing  — not installed
//   broken   — installed but will not run, or definitively logged OUT
//   degraded — runs, but the login state could NOT be determined (probe timed out / unreadable)
//   healthy  — runs AND `claude auth status` says logged in
// UNKNOWN never renders as working; that is the whole point of the tri-state.
function claudeCliCheck(h) {
  if (!h) {
    return check('claude-cli', 'Claude CLI', 'degraded', 'The local claude CLI was not probed, so its state is unknown.',
      'Refresh diagnostics to probe the claude CLI; if it stays unknown, run `claude auth status` in Terminal.', 'claude-cli');
  }
  const where = h.path ? ` (${h.path})` : '';
  if (h.installed === null) {
    return check('claude-cli', 'Claude CLI', 'degraded', `${h.reason || 'The claude CLI could not be probed.'} Treat this lane as UNVERIFIED, not working.`,
      h.fix || 'Run `claude auth status` in Terminal to check the lane by hand.', 'claude-cli');
  }
  if (!h.installed) return check('claude-cli', 'Claude CLI', 'missing', h.reason || 'The claude CLI is not installed.', h.fix, 'claude-cli');
  if (h.runnable === false) return check('claude-cli', 'Claude CLI', 'broken', h.reason || `The claude CLI will not run${where}.`, h.fix, 'claude-cli');
  if (h.runnable === null || h.authenticated === null) {
    return check('claude-cli', 'Claude CLI', 'degraded', `${h.reason || 'The claude CLI login state is unknown.'} Treat this lane as UNVERIFIED, not working.`, h.fix, 'claude-cli');
  }
  if (h.authenticated === false) return check('claude-cli', 'Claude CLI', 'broken', h.reason || 'The claude CLI is logged out.', h.fix, 'claude-cli');
  return check('claude-cli', 'Claude CLI', 'healthy', `${h.version || 'installed'} · ${h.reason || 'logged in'}.`, null, 'claude-cli');
}

// Cline exposes no free non-interactive auth status, so a green here means: the binary RUNS and a
// recorded end-to-end connection test describes THIS binary. A recorded success older than the
// installed binary is stale by definition — a reinstall replaces the thing that verdict was about.
function clineCliCheck(h, recorded) {
  if (!h) {
    return !recorded.installed
      ? check('cline-test', 'Cline connection', 'missing', 'Cline is not installed.', 'Run `npm run agent:setup`, then test the connection in Settings.', 'cline')
      : check('cline-test', 'Cline connection', 'degraded', 'Cline was not probed, so it is unverified; a recorded test is not proof the lane runs now.', 'Refresh diagnostics to probe Cline, then use Test connection in Settings.', 'cline');
  }
  if (h.installed === null) {
    return check('cline-test', 'Cline connection', 'degraded', `${h.reason || 'Cline could not be probed.'} Treat this lane as UNVERIFIED.`,
      h.fix || 'Run `cline --version` in Terminal to check the lane by hand.', 'cline');
  }
  if (!h.installed) return check('cline-test', 'Cline connection', 'missing', h.reason || 'Cline is not installed.', h.fix, 'cline');
  if (h.runnable === false) return check('cline-test', 'Cline connection', 'broken', h.reason || 'Cline will not run.', h.fix, 'cline');
  if (h.runnable === null) return check('cline-test', 'Cline connection', 'degraded', `${h.reason || 'Cline did not respond to the health probe.'} Treat this lane as UNVERIFIED.`, h.fix, 'cline');
  if (h.lastTestStale) {
    return check('cline-test', 'Cline connection', 'degraded',
      `Cline runs, but the last successful test (${h.lastTest?.at || 'unknown time'}) predates the installed binary (${h.binaryChangedAt || 'unknown'}) — that verdict is stale.`,
      h.fix || 'Use Test connection in Settings to verify the currently installed Cline build.', 'cline');
  }
  if (h.lastTest?.ok) {
    return check('cline-test', 'Cline connection', 'healthy', `Runs, and verified ${h.provider || ''}/${h.model || ''} at ${h.lastTest.at || 'unknown time'}.`, null, 'cline');
  }
  return check('cline-test', 'Cline connection', 'degraded', 'Cline runs but has no successful recorded connection test.', h.fix || 'Use Test connection in Settings.', 'cline');
}

// Pure health classifier over a collected snapshot. Kept separate so regressions in nested connector
// shapes (Vercel is {deployment}, Supabase is {health,advisors}) cannot silently paint a false green.
export function assessPlatform(snapshot) {
  const c = snapshot.credentials || {};
  const fields = fieldMap(c);
  const sig = snapshot.signals || {};
  const checks = [];

  const gh = sig.github;
  checks.push(unavailable(gh)
    ? check('github', 'GitHub', 'missing', 'No live GitHub connection.', 'Add a GitHub token in Settings.', 'github')
    : failed(gh)
      ? check('github', 'GitHub', 'broken', `Connection failed: ${gh.error}`, 'Replace or re-authorize the GitHub token, then refresh diagnostics.', 'github')
      : check('github', 'GitHub', 'healthy', `Live: ${gh.repo || 'repository'} · CI ${gh.ci?.state || 'unknown'}.`, null, 'github'));

  const admin = sig.admin;
  checks.push(unavailable(admin)
    ? check('seen-admin', 'Seen admin', 'missing', 'Live users, jobs, revenue, and errors are unavailable.', 'Add both Seen admin credentials in Settings.', 'seen-admin')
    : failed(admin)
      ? check('seen-admin', 'Seen admin', 'broken', `Connection failed: ${admin.error}`, 'Verify the Seen admin username/password and that /api/admin-stats is reachable.', 'seen-admin')
      : check('seen-admin', 'Seen admin', 'healthy', `Live: ${admin.users?.total ?? 0} users · ${admin.jobs?.active ?? 0} active jobs · ${admin.errors?.today ?? 0} errors today.`, null, 'seen-admin'));

  const sb = sig.supabase;
  const sbHealth = sb?.health;
  checks.push(unavailable(sb) || sbHealth?.configured === false
    ? check('supabase-db', 'Supabase database', 'missing', 'Database health is not configured.', 'Add the project URL and service-role key in Settings.', 'supabase')
    : failed(sb) || sbHealth?.up === false
      ? check('supabase-db', 'Supabase database', 'broken', `Health probe failed${sbHealth?.status ? ` (HTTP ${sbHealth.status})` : ''}${sbHealth?.error ? `: ${sbHealth.error}` : ''}.`, 'Verify the project URL/service-role key and project availability.', 'supabase')
      : check('supabase-db', 'Supabase database', 'healthy', `PostgREST is responding${sbHealth?.status ? ` (HTTP ${sbHealth.status})` : ''}.`, null, 'supabase'));
  // The connector diagnoses its own failure (dead token vs. wrong credential type vs. wrong project
  // ref) and carries the exact fix; prefer it over the generic guess below.
  const adv = sb?.advisors;
  const advFailed = !!adv && !adv.available && adv.reason !== 'not-configured' && !!(adv.status || adv.reason);
  checks.push(adv?.available
    ? check('supabase-advisors', 'Supabase advisors', 'healthy', `${adv.count ?? 0} security advisor finding(s) visible.`, null, 'supabase-management')
    : advFailed
      ? check('supabase-advisors', 'Supabase advisors', 'broken',
        `Management API rejected the advisor request${adv.status ? ` (HTTP ${adv.status})` : ''}${adv.message || adv.error ? `: ${adv.message || adv.error}` : ''}.`,
        adv.fix || 'Replace the Supabase Management access token/project reference; the database service-role key cannot authorize this API.', 'supabase-management')
      : check('supabase-advisors', 'Supabase advisors', 'missing', 'Security/performance advisors are not connected.', adv?.fix || 'Add SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in Settings.', 'supabase-management'));

  const deployment = sig.vercel?.deployment;
  checks.push(unavailable(sig.vercel) || deployment?.configured === false
    ? check('vercel', 'Vercel', 'missing', 'Deploy status is unavailable.', 'Add the Vercel token and project ID in Settings.', 'vercel')
    : failed(sig.vercel) || failed(deployment)
      ? check('vercel', 'Vercel', 'broken', `Connection failed: ${sig.vercel?.error || deployment?.error}`, 'Verify the Vercel token, project ID, and team ID.', 'vercel')
      : String(deployment?.state || '').toUpperCase() === 'ERROR'
        ? check('vercel', 'Vercel', 'degraded', 'The connection works, but the latest deployment is ERROR.', 'Inspect the latest Vercel deployment logs before merging or deploying again.', 'vercel')
        : check('vercel', 'Vercel', 'healthy', `Latest deployment: ${deployment?.state || (deployment?.none ? 'none yet' : 'reachable')}.`, null, 'vercel'));

  const stripe = sig.stripe;
  checks.push(unavailable(stripe)
    ? check('stripe', 'Stripe', 'missing', 'The direct Stripe cross-check of one-time payments is unavailable.', 'Add the Stripe secret key in Settings if direct billing visibility is wanted.', 'stripe')
    : failed(stripe)
      ? check('stripe', 'Stripe', 'broken', `Connection failed: ${stripe.error}`, 'Replace or re-authorize the Stripe secret key.', 'stripe')
      : check('stripe', 'Stripe', 'healthy', `Live: ${stripe.oneTime ? `${stripe.oneTime.count} one-time payment(s) · $${stripe.oneTime.total} in 30 days` : 'one-time payments not read'}${stripe.subscriptions?.activeCount ? ` · ${stripe.subscriptions.activeCount} legacy subscription(s)` : ''}.`, null, 'stripe'));

  // The two LOCAL agent CLIs the Board Room actually runs. These are live probes, not replayed
  // verdicts: "installed" and "worked once, some time ago" are not evidence that the lane runs now,
  // and treating them as evidence is why the chat could not tell whether it was running.
  const cliClaude = snapshot.cli?.claude || null;
  checks.push(claudeCliCheck(cliClaude));

  const cliCline = snapshot.cli?.cline || null;
  checks.push(clineCliCheck(cliCline, c.cline || {}));

  const lanes = snapshot.llm || {};
  const liveLanes = Object.entries(lanes).filter(([, on]) => on).map(([name]) => name);
  // A lane only counts if it can actually answer. An installed-but-unrunnable Cline is not a lane,
  // and used to be the sole reason this check read healthy on a machine with nothing working.
  const clineUsable = cliCline ? cliCline.runnable !== false : !!(c.cline || {}).installed;
  const claudeUsable = !!(cliClaude && cliClaude.runnable === true && cliClaude.authenticated !== false);
  const laneNames = [...liveLanes, ...(clineUsable ? ['Cline'] : []), ...(claudeUsable ? ['claude CLI'] : [])];
  checks.push(laneNames.length
    ? check('ai-lanes', 'AI reasoning lanes', 'healthy', `${laneNames.join(', ')} available.`, null, 'ai')
    : check('ai-lanes', 'AI reasoning lanes', 'broken', 'No model lane, Cline, or claude CLI can answer right now.', 'Connect an AI provider, or repair Cline (npm run agent:setup) / log in the claude CLI.', 'ai'));

  for (const [id, label] of [['commandRepo', 'Seen Command checkout'], ['productRepo', 'Seen product checkout']]) {
    const repo = snapshot.repos?.[id];
    checks.push(repo?.reachable
      ? check(`repo-${id}`, label, 'healthy', `${repo.branch}@${repo.sha}${repo.dirty ? ' · local changes present' : ' · clean'}.`, null, 'local-git')
      : check(`repo-${id}`, label, 'broken', repo?.error || 'Checkout is unavailable.', `Set the correct local ${label} directory in the runtime environment.`, 'local-git'));
  }

  // WRITABILITY — five builds died one at a time trying to write inside the read-only .app bundle
  // because a repo dir was unset (run-202607100119-a1 and friends). A checkout that is not a writable
  // git clone is a setup fault to surface ONCE here, not to rediscover per build.
  for (const [id, label, key] of [['commandRepo', 'Seen Command checkout', 'commandRepo'], ['productRepo', 'Seen product checkout', 'productRepo']]) {
    const repo = snapshot.repos?.[key];
    const inBundle = /\.app\/Contents\//.test(String(repo?.path || ''));
    if (repo?.reachable && !inBundle) continue; // the existing repo-* check already reports it healthy
    checks.push(check(`writable-${id}`, `${label} is writable`, 'broken',
      inBundle ? `${repo.path} is inside the read-only application bundle — builds cannot write there.` : (repo?.error || 'not a reachable git checkout.'),
      `Set ${key === 'productRepo' ? 'SEEN_PRODUCT_REPO_DIR' : 'SEEN_COMMAND_REPO_DIR'} to a writable clone, then restart the app.`, 'local-git'));
  }
  // BASE HEALTH — task-63/65/176 were each failed for a red BASE branch they did not cause. green:null
  // is "never checked", which must never render as green (the silent-zero rule).
  // Only reported when the collector actually ran: a caller that never gathered base health has not
  // learned "unknown", it simply did not ask, and inventing a degraded check for it would be noise.
  for (const repo of (snapshot.baseHealth ? ['tool', 'product'] : [])) {
    const h = snapshot.baseHealth[repo] || { green: null, reason: 'never checked' };
    checks.push(h.green === true
      ? check(`base-health-${repo}`, `${repo === 'tool' ? 'Seen Command' : 'Seen product'} base branch`, 'healthy', `${h.base || 'base'} is green.`, null, 'base-health')
      : h.green === false
        ? check(`base-health-${repo}`, `${repo === 'tool' ? 'Seen Command' : 'Seen product'} base branch`, 'broken', `${h.base || 'base'} is RED: ${h.reason || 'its own suite fails'}`, `The builder queue is gated — fix ${h.base || 'the base branch'} first; new tasks are not at fault.`, 'base-health')
        : check(`base-health-${repo}`, `${repo === 'tool' ? 'Seen Command' : 'Seen product'} base branch`, 'degraded', `Unknown — ${h.reason || 'never checked'}. Unknown is not green.`, 'Press “Check now”: it runs this repository’s tests on a clean copy of its base branch (a few minutes, in the background). It also runs on its own once a day while Seen Command is open.', 'base-health'));
  }
  checks.push(snapshot.state?.available
    ? check('runtime-state', 'Seen Command runtime', 'healthy', `${snapshot.state.pendingApprovals} pending approval(s) · run ${snapshot.state.runId || 'not run yet'}.`, null, 'local-state')
    : check('runtime-state', 'Seen Command runtime', 'degraded', 'No board-meeting state exists yet.', 'Run a board meeting to create live state.', 'local-state'));
  checks.push(snapshot.brain?.available
    ? check('brain', 'Brain / vault', 'healthy', `${snapshot.brain.factCount} current fact(s) available.`, null, 'brain')
    : check('brain', 'Brain / vault', 'broken', snapshot.brain?.error || 'The Brain has no readable current facts.', 'Repair CHRONOS_VAULT / the local vault path, then run Brain self-diagnosis.', 'brain'));
  checks.push(snapshot.tasks?.error
    ? check('task-tracker', 'Live task tracker', 'broken', snapshot.tasks.error, taskTrackerFix(snapshot.tasks.error, snapshot.tasks.repo), 'github-tasks')
    : check('task-tracker', 'Live task tracker', 'healthy', `${snapshot.tasks?.openCount ?? 0} open Seen Command task(s) visible.`, null, 'github-tasks'));

  const active = (snapshot.builds?.recent || []).filter((b) => ['queued', 'building'].includes(b.status));
  checks.push(check('builder', 'Builder queue', 'healthy', active.length
    ? `${active.length} build(s) active${snapshot.builds?.slot?.id ? ` · slot held by ${snapshot.builds.slot.id}` : ''}.`
    : 'No builds in flight; the queue is available.', null, 'local-builds'));
  checks.push(check('activity', 'Activity ledger', 'healthy', `${snapshot.activity?.count ?? 0} event(s) visible from the last two days.`, null, 'local-activity'));

  checks.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  const counts = checks.reduce((out, item) => { out[item.status] = (out[item.status] || 0) + 1; return out; }, { broken: 0, degraded: 0, missing: 0, healthy: 0 });
  const overall = counts.broken ? 'broken' : counts.degraded || counts.missing ? 'attention' : 'healthy';
  return { overall, counts, checks };
}

export async function platformStatus({
  signalsFn = signals,
  issuesForFn = issuesFor,
  credentialStatusFn = credentialStatus,
  llmStatusFn = llmStatus,
  loadStateFn = loadState,
  listBuildsFn = listBuilds,
  buildSlotHolderFn = buildSlotHolder,
  readActivityFn = readActivity,
  currentFactsFn = currentFacts,
  configObj = config,
  repoProbeFn = probeRepo,
  claudeCliHealthFn = claudeCliHealth,
  clineCliHealthFn = clineCliHealth,
  baseHealthFn = () => { const out = {}; for (const r of ['tool', 'product']) { try { out[r] = readBaseHealth(r); } catch (e) { out[r] = { green: null, reason: clip(e.message) }; } } return out; },
} = {}) {
  const settled = await Promise.allSettled([
    signalsFn(),
    issuesForFn(configObj.commandRepo()),
  ]);
  const sig = settled[0].status === 'fulfilled' ? settled[0].value : { error: settled[0].reason?.message || 'signals unavailable' };
  const tasks = settled[1].status === 'fulfilled'
    ? { openCount: settled[1].value.length, recent: settled[1].value.slice(0, 8).map((t) => ({ number: t.number, title: t.title, labels: t.labels, url: t.url })) }
    : { openCount: 0, recent: [], repo: configObj.commandRepo(), error: clip(settled[1].reason?.message || 'task tracker unavailable') };
  let state = null; let builds = []; let activity = []; let facts = []; let brainError = null;
  try { state = loadStateFn(); } catch { state = null; }
  try { builds = listBuildsFn() || []; } catch { builds = []; }
  try { activity = readActivityFn({ days: 2 }) || []; } catch { activity = []; }
  try { facts = currentFactsFn() || []; } catch (e) { brainError = clip(e.message); }
  const repos = {
    commandRepo: repoProbeFn(configObj.commandRepoDir()),
    productRepo: repoProbeFn(configObj.productRepoDir()),
  };
  // Live probes of the two local agent CLIs. Both are cached in credentials.mjs, so calling this on
  // every snapshot costs one bounded spawn per binary per minute. A probe that THROWS must read as
  // unknown — never as absent and never as healthy — so the failure is visible instead of green.
  const probeCli = (fn, label) => {
    try { return fn(); } catch (e) { return { installed: null, runnable: null, authenticated: null, reason: `${label} health probe failed: ${clip(e.message, 160)}`, fix: null, checkedAt: new Date().toISOString() }; }
  };
  const cli = {
    claude: probeCli(claudeCliHealthFn, 'the claude CLI'),
    cline: probeCli(clineCliHealthFn, 'Cline'),
  };
  const snapshot = {
    at: new Date().toISOString(),
    cli,
    credentials: credentialStatusFn(),
    llm: llmStatusFn(),
    signals: sig,
    repos,
    state: {
      available: !!state,
      runId: state?.runId || null,
      focusId: state?.focusId || null,
      pendingApprovals: (state?.approvals || []).filter((a) => a.status === 'pending').length,
      approvals: (state?.approvals || []).filter((a) => a.status === 'pending').slice(0, 10).map((a) => ({ id: a.id, title: a.title, dept: a.dept, action: a.action })),
      proposalCount: (state?.proposals || []).length,
    },
    tasks,
    builds: { recent: builds.slice(0, 10).map((b) => ({ id: b.id, title: b.title, repo: b.repo, status: b.status, error: b.error || null, pr: b.pr || null, updatedAt: b.updatedAt })), slot: buildSlotHolderFn() },
    activity: { count: activity.length, recent: activity.slice(-12).reverse() },
    brain: { available: facts.length > 0 && !brainError, factCount: facts.length, error: brainError },
    baseHealth: baseHealthFn(),
  };
  snapshot.health = assessPlatform(snapshot);
  return snapshot;
}

// Compact enough for a model prompt, specific enough to prevent stale Brain facts from overriding
// runtime truth. Secrets and full issue bodies never enter this text.
export function platformContext(snapshot) {
  if (!snapshot) return '';
  const h = snapshot.health || { checks: [] };
  const attention = h.checks.filter((c) => c.status !== 'healthy').slice(0, 8);
  const tasks = (snapshot.tasks?.recent || []).slice(0, 6).map((t) => `#${t.number} ${clip(t.title, 90)}`).join(' · ');
  const builds = (snapshot.builds?.recent || []).slice(0, 6).map((b) => `${b.id}:${b.status}${b.error ? ` (${clip(b.error, 100)})` : ''}`).join(' · ');
  const approvals = (snapshot.state?.approvals || []).map((a, i) => `${i + 1}. ${a.title} [${a.id}]`).join(' · ');
  const gh = snapshot.signals?.github || {};
  const admin = snapshot.signals?.admin || {};
  const supabase = snapshot.signals?.supabase || {};
  const deploy = snapshot.signals?.vercel?.deployment || {};
  const stripe = snapshot.signals?.stripe || {};
  const prs = (gh.openPRs || []).slice(0, 6).map((p) => `#${p.number} ${clip(p.title, 70)}${p.draft ? ' [draft]' : ''}`).join(' · ');
  const productIssues = (gh.openIssues || []).slice(0, 6).map((i) => `#${i.number} ${clip(i.title, 70)}`).join(' · ');
  return `LIVE PLATFORM SNAPSHOT (${snapshot.at}; runtime truth overrides Brain/history):
Health: ${h.overall || 'unknown'} · ${h.counts?.broken || 0} broken · ${h.counts?.degraded || 0} degraded · ${h.counts?.missing || 0} missing.
Needs attention: ${attention.length ? attention.map((c) => `${c.label}: ${c.detail}${c.fix ? ` Fix: ${c.fix}` : ''}`).join(' | ') : 'none'}
Runtime: run ${snapshot.state?.runId || 'none'} · focus ${snapshot.state?.focusId || 'unknown'} · ${snapshot.state?.pendingApprovals || 0} pending approval(s): ${approvals || 'none'}
Open Seen Command tasks (${snapshot.tasks?.openCount ?? '?'}): ${tasks || snapshot.tasks?.error || 'none'}
Recent builds: ${builds || 'none'}
Brain: ${snapshot.brain?.available ? `${snapshot.brain.factCount} current facts` : `unavailable (${snapshot.brain?.error || 'empty'})`}
Local repos: command ${snapshot.repos?.commandRepo?.branch || 'unavailable'}@${snapshot.repos?.commandRepo?.sha || '?'}; product ${snapshot.repos?.productRepo?.branch || 'unavailable'}@${snapshot.repos?.productRepo?.sha || '?'}.
LIVE CONNECTORS:
GitHub ${gh.repo || 'unavailable'} branch ${gh.branch || '?'} · CI ${gh.ci?.state || gh.error || 'unknown'} · open PRs: ${prs || 'none'} · product issues: ${productIssues || 'none'}
Seen admin · users ${admin.users?.total ?? '?'} (${admin.users?.newToday ?? '?'} new today, ${admin.users?.dau ?? '?'} DAU) · revenue ${admin.revenue?.month == null ? 'unknown' : `$${admin.revenue.month}`} one-time in 30 days / ${admin.revenue?.payingCustomers ?? '?'} paying · jobs ${admin.jobs?.active ?? '?'} active/${admin.jobs?.stale ?? '?'} stale · errors ${admin.errors?.today ?? '?'} today/${admin.errors?.thisWeek ?? '?'} week
Supabase · database ${supabase.health?.up === true ? 'up' : supabase.health?.error || 'unavailable'}${supabase.health?.status ? ` HTTP ${supabase.health.status}` : ''} · advisors ${supabase.advisors?.available ? `${supabase.advisors.count ?? 0} visible` : supabase.advisors?.status ? `HTTP ${supabase.advisors.status}` : 'not connected'}
Vercel · ${deploy.state || deploy.error || 'unavailable'}${deploy.url ? ` · ${deploy.url}` : ''}${deploy.sha ? ` · ${deploy.sha}` : ''}
Stripe · ${stripe.error || `${stripe.oneTime ? `${stripe.oneTime.count} one-time payments · $${stripe.oneTime.total} in 30 days` : 'one-time payments unknown'}${stripe.subscriptions?.activeCount ? ` · ${stripe.subscriptions.activeCount} legacy subscriptions` : ''}`}
AI lanes · ${Object.entries(snapshot.llm || {}).filter(([, on]) => on).map(([name]) => name).join(', ') || 'none'}.
Local agent CLIs · ${laneLine('claude CLI', snapshot.cli?.claude)} · ${laneLine('Cline', snapshot.cli?.cline)}`;
}

// One honest line per local lane, so the chat can answer "are you actually running?" from probed
// fact instead of guessing at its own plumbing.
function laneLine(name, h) {
  if (!h) return `${name}: not probed (unknown)`;
  if (h.installed === null || h.runnable === null) return `${name}: UNKNOWN — ${clip(h.reason, 120) || 'not determined'}`;
  if (!h.installed) return `${name}: not installed`;
  if (h.runnable === false) return `${name}: BROKEN — ${clip(h.reason, 120)}`;
  if (h.authenticated === false) return `${name}: logged out — ${clip(h.reason, 120)}`;
  if (h.authenticated === null && h.id === 'claude-cli') return `${name}: login UNKNOWN — ${clip(h.reason, 120)}`;
  return `${name}: usable${h.version ? ` (${h.version})` : ''}${h.lastTestStale ? ' — but its recorded connection test is stale' : ''}`;
}
