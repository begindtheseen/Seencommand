// ops — the Board Room's deterministic MASTER-KIT: one read-only tool surface over everything the
// platform can see, so the chat agent pulls live truth with a single command instead of guessing or
// paying model turns for exploration. Brandon's 2026-08-13 brief, all 8 abilities:
//   1 fetch-all-state  2 search code+facts  3 diagnose(+safe fix)  4 snapshot  5 run-query
//   6 credential-audit 7 drift-check        8 export-all-logs
//
// READ-ONLY BY DESIGN. The only writes are (a) exportLogs' bundle under data/exports and (b)
// diagnose(--fix)'s `git fetch` (remote refs only — it NEVER touches a working tree; the exact
// reconcile command is reported, not run). No credential VALUE ever appears in any output — status
// booleans and health verdicts only. Every external call is injectable so tests run offline, and a
// failed request is surfaced as { error }, never disguised as an empty result (the silent-zero class
// this repo has been bitten by six times).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signals } from './connectors/index.mjs';
import { llmStatus, config } from './config.mjs';
import { platformStatus } from './platform-status.mjs';
import { currentFacts } from './brain.mjs';
import { rankFacts } from '../brain/lib/keeper.mjs';
import { readActivity } from './activity.mjs';
import { listBuilds } from './builds.mjs';
import { loadState } from './memory.mjs';
import { dataDir } from './paths.mjs';

const clip = (v, n = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

export const DEFAULT_OPS_DEPS = {
  signals,
  llmStatus,
  platformStatus,
  currentFacts,
  rankFacts,
  readActivity,
  listBuilds,
  loadState,
  config,
  execFile: execFileSync,
  fetchFn: (...a) => fetch(...a),
  exists: existsSync,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeFile: writeFileSync,
  dataDir,
  // Lazy so a plain `ops state` never pays to load the failure queue.
  failureLoop: () => import('./failure-loop.mjs'),
};

// 1) fetch-all-state — every live connector in ONE call (github / admin / supabase / vercel /
// stripe + AI lanes). Unconfigured connectors stay {notConfigured:true}, failures stay {error} —
// per-connector degradation is the honesty contract, same as the board meeting's gatherLive().
export async function fetchAllState(deps = DEFAULT_OPS_DEPS) {
  const sig = await deps.signals();
  return {
    at: new Date().toISOString(),
    status: sig.status || null,
    connectors: { github: sig.github, admin: sig.admin, supabase: sig.supabase, vercel: sig.vercel, stripe: sig.stripe },
    llm: deps.llmStatus(),
  };
}

// 4) snapshot — the deterministic full-visibility dump: focus, pending approvals, open tasks,
// recent builds, brain, connector health, repos, activity. One source of truth for investigations.
export async function opsSnapshot(deps = DEFAULT_OPS_DEPS) {
  const s = await deps.platformStatus();
  return {
    at: s.at,
    runId: s.state?.runId || null,
    focus: s.state?.focusId || null,
    pendingApprovals: s.state?.approvals || [],
    openTasks: { count: s.tasks?.openCount ?? 0, recent: s.tasks?.recent || [], error: s.tasks?.error || null },
    recentBuilds: s.builds?.recent || [],
    brain: s.brain || { available: false },
    connectorHealth: { overall: s.health?.overall, counts: s.health?.counts, checks: s.health?.checks || [] },
    repos: s.repos || {},
    activity: s.activity?.recent || [],
  };
}

// 2) search-code-and-facts — git grep across BOTH repos + a ranked brain-fact lookup in one step,
// with source references. `git grep` exits 1 on "no matches" — that is a clean empty, not an error;
// anything else (bad repo, timeout) is reported per-repo so a broken search never reads as "no hits".
export function searchAll({ query, limit = 20 } = {}, deps = DEFAULT_OPS_DEPS) {
  const q = String(query || '').trim();
  if (!q) return { error: 'query required' };
  const roots = [
    { repo: 'command', dir: deps.config.commandRepoDir() },
    { repo: 'product', dir: deps.config.productRepoDir() },
  ].filter((r, i, all) => r.dir && all.findIndex((x) => x.dir === r.dir) === i);
  const code = [];
  const errors = [];
  for (const { repo, dir } of roots) {
    if (!deps.exists(dir)) { errors.push({ repo, error: `checkout not found: ${dir}` }); continue; }
    let out = '';
    try {
      out = deps.execFile('git', ['grep', '-nI', '--', q], { cwd: dir, encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    } catch (e) {
      if (e && e.status === 1 && !String(e.stderr || '').trim()) { continue; } // exit 1 = no matches
      errors.push({ repo, error: clip(e.message, 200) });
      continue;
    }
    for (const line of String(out).split('\n')) {
      if (!line) continue;
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      code.push({ repo, file: m[1], line: Number(m[2]), text: clip(m[3], 200) });
      if (code.filter((c) => c.repo === repo).length >= limit) break;
    }
  }
  let facts = [];
  try {
    const all = deps.currentFacts() || [];
    facts = (deps.rankFacts(all, q, 10) || []).map((f) => ({
      subject: f.subject, predicate: f.predicate, object: clip(f.object, 240), note: f.note || null, valid_from: f.valid_from || null,
    }));
  } catch (e) { errors.push({ repo: 'brain', error: clip(e.message, 200) }); }
  return { query: q, code, facts, ...(errors.length ? { errors } : {}) };
}

// 6) credential-audit — which connectors are missing VALID tokens, without exposing them. Joins the
// configured/not-configured field booleans with the LIVE health verdicts, so "configured but the API
// rejects it" (the dead Supabase management token) is distinguishable from "not set at all".
const GROUP_CHECKS = {
  github: ['github', 'task-tracker'],
  seen: ['seen-admin'],
  supabase: ['supabase-db', 'supabase-advisors'],
  deploy: ['vercel', 'stripe'],
  ai: ['ai-lanes', 'cline-test', 'claude-cli'],
};
export async function credentialAudit(deps = DEFAULT_OPS_DEPS) {
  const s = await deps.platformStatus();
  const checks = s.health?.checks || [];
  const order = { broken: 0, degraded: 1, missing: 2, healthy: 3 };
  const connectors = (s.credentials?.groups || []).map((g) => {
    const mine = checks.filter((c) => (GROUP_CHECKS[g.id] || []).includes(c.id));
    const worst = mine.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))[0] || null;
    return {
      id: g.id,
      label: g.label,
      credentials: (g.fields || []).map((f) => ({ key: f.key, configured: !!f.configured })),
      live: worst ? worst.status : 'unprobed',
      detail: worst ? worst.detail : null,
      fix: mine.find((c) => c.fix)?.fix || null,
      checks: mine.map((c) => ({ id: c.id, status: c.status })),
    };
  });
  return { at: s.at, overall: s.health?.overall || 'unknown', connectors };
}

// 7) drift-check — is what's MERGED what's DEPLOYED? Live probe (gh branch tip vs newest READY
// Vercel production deploy) when credentials allow, PLUS the last recorded merge_vs_deploy brain
// fact (the Mac's hourly deploy-drift.mjs writes it), so an uncredentialed environment still answers
// honestly. NOT CHECKABLE IS NOT "IN SYNC" — checkable:false means exactly that.
export async function driftCheck(deps = DEFAULT_OPS_DEPS) {
  const repo = deps.config.githubRepo();
  const branch = deps.config.githubBranch();
  let tip = null;
  try { tip = clip(deps.execFile('gh', ['api', `repos/${repo}/commits/${branch}`, '-q', '.sha'], { encoding: 'utf8', timeout: 30000 }), 40) || null; }
  catch { tip = null; }
  let prod = null;
  const v = deps.config.vercel();
  if (v) {
    try {
      const params = new URLSearchParams({ target: 'production', limit: '10' });
      if (v.projectId) params.set('projectId', v.projectId);
      if (v.teamId) params.set('teamId', v.teamId);
      const res = await deps.fetchFn(`https://api.vercel.com/v6/deployments?${params}`, { headers: { authorization: `Bearer ${v.token}` } });
      if (res.ok) {
        const j = await res.json();
        const d = (j.deployments || []).find((x) => x.state === 'READY');
        if (d) prod = { sha: String(d.meta?.githubCommitSha || ''), created: d.created };
      } else { prod = { error: `Vercel HTTP ${res.status}` }; }
    } catch (e) { prod = { error: clip(e.message, 160) }; }
  }
  let lastRecorded = null;
  try {
    const f = (deps.currentFacts() || []).find((x) => x.subject === 'Seen production deploy' && x.predicate === 'merge_vs_deploy');
    if (f) lastRecorded = { verdict: clip(f.object, 400), since: f.valid_from || null };
  } catch { /* no vault — lastRecorded stays null */ }
  const checkable = !!(tip && prod && prod.sha);
  return {
    repo, branch, checkable,
    drifted: checkable ? tip !== prod.sha : null,
    branchSha: tip, prodSha: checkable ? prod.sha : null,
    deployedAgoMin: checkable && prod.created ? Math.round((Date.now() - Number(prod.created)) / 60000) : null,
    ...(prod && prod.error ? { prodError: prod.error } : {}),
    lastRecorded,
  };
}

// 5) run-query — parameterized read-only queries over the brain, the product DB (PostgREST GET
// only), the activity ledger, build records, and runtime state. No mutation is reachable from here:
// the DB path is a GET with no body, and every other target reads local JSON/vault data.
export async function runQuery(params = {}, deps = DEFAULT_OPS_DEPS) {
  const target = String(params.target || '');
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 25));
  if (target === 'facts') {
    let facts = [];
    try { facts = deps.currentFacts() || []; } catch (e) { return { error: `brain unavailable: ${clip(e.message, 120)}` }; }
    const has = (hay, needle) => !needle || String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
    const rows = facts
      .filter((f) => has(f.subject, params.subject) && has(f.predicate, params.predicate)
        && (!params.contains || has(`${f.subject} ${f.predicate} ${f.object}`, params.contains)))
      .slice(0, limit)
      .map((f) => ({ subject: f.subject, predicate: f.predicate, object: clip(f.object, 300), note: f.note || null, valid_from: f.valid_from || null }));
    return { target, count: rows.length, rows };
  }
  if (target === 'db') {
    const sb = deps.config.supabase();
    if (!sb) return { error: 'supabase not configured' };
    const table = String(params.table || '');
    if (!/^[a-z0-9_]+$/i.test(table)) return { error: 'table must match [a-z0-9_]+' };
    const qs = new URLSearchParams({ select: String(params.select || '*'), limit: String(limit) });
    if (params.order) qs.set('order', String(params.order));
    let url = `${sb.url}/rest/v1/${table}?${qs}`;
    if (params.filter) url += `&${String(params.filter)}`; // raw PostgREST params, e.g. status=eq.active
    let res;
    try { res = await deps.fetchFn(url, { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }); }
    catch (e) { return { error: `fetch failed: ${clip(e.message, 160)}` }; }
    const body = await res.text().catch(() => '');
    if (!res.ok) return { error: `HTTP ${res.status}`, body: clip(body, 300) };
    try { const rows = JSON.parse(body); return { target, table, count: Array.isArray(rows) ? rows.length : 1, rows }; }
    catch { return { error: 'non-JSON response', body: clip(body, 300) }; }
  }
  if (target === 'activity') {
    let events = [];
    try { events = deps.readActivity({ days: Math.max(1, Math.min(14, Number(params.days) || 2)) }) || []; }
    catch (e) { return { error: `activity unavailable: ${clip(e.message, 120)}` }; }
    if (params.kind) events = events.filter((e) => e.kind === params.kind);
    return { target, count: events.length, rows: events.slice(-limit).reverse() };
  }
  if (target === 'builds') {
    let builds = [];
    try { builds = deps.listBuilds() || []; } catch (e) { return { error: `build records unavailable: ${clip(e.message, 120)}` }; }
    return { target, count: builds.length, rows: builds.slice(0, limit).map((b) => ({ ...b, log: undefined, logTail: (b.log || []).slice(-3) })) };
  }
  if (target === 'state') {
    let s = null;
    try { s = deps.loadState(); } catch (e) { return { error: `state unavailable: ${clip(e.message, 120)}` }; }
    if (!s) return { error: 'no state — run a board meeting' };
    let value = s;
    if (params.path) for (const k of String(params.path).split('.')) value = value == null ? value : value[k];
    return { target, path: params.path || null, value: JSON.parse(JSON.stringify(value ?? null, (k, v) => (typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v))) };
  }
  return { error: `unknown target "${target}" — valid: facts, db, activity, builds, state` };
}

// 8) export-all-logs — one call bundles recent CI runs (+ the newest failed run's log tail), Vercel
// deployments, local build records with logs, the activity ledger, and the health map into a dated
// directory under data/exports. Every section that fails records {error} in its file — a partial
// bundle SAYS which parts are missing instead of silently shrinking.
export async function exportLogs(deps = DEFAULT_OPS_DEPS) {
  const dir = join(deps.dataDir(), 'exports', `logs-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  deps.mkdir(dir);
  const files = [];
  const summary = {};
  const put = (name, value) => {
    deps.writeFile(join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    files.push(name);
  };
  const repos = [...new Set([deps.config.commandRepo(), deps.config.githubRepo()].filter(Boolean))];
  let newestFailed = null;
  try {
    const ci = {};
    for (const repo of repos) {
      try {
        const out = deps.execFile('gh', ['api', `repos/${repo}/actions/runs?per_page=10`, '-q', '.workflow_runs'], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        const runs = (JSON.parse(out) || []).map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, sha: clip(r.head_sha, 12), status: r.status, conclusion: r.conclusion, url: r.html_url, created_at: r.created_at }));
        ci[repo] = runs;
        const failed = runs.find((r) => r.conclusion === 'failure');
        if (failed && (!newestFailed || failed.created_at > newestFailed.created_at)) newestFailed = { ...failed, repo };
      } catch (e) { ci[repo] = { error: clip(e.message, 200) }; }
    }
    put('ci.json', ci);
    summary.ciRepos = repos.length;
  } catch (e) { put('ci.json', { error: clip(e.message, 200) }); }
  if (newestFailed) {
    try {
      const log = deps.execFile('gh', ['run', 'view', String(newestFailed.id), '--log-failed', '-R', newestFailed.repo], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
      put('ci-failed.txt', `# ${newestFailed.repo} run ${newestFailed.id} (${newestFailed.name})\n${String(log).split('\n').slice(-400).join('\n')}`);
    } catch (e) { put('ci-failed.txt', `could not fetch failed-run log for ${newestFailed.repo} run ${newestFailed.id}: ${clip(e.message, 200)}`); }
  }
  const v = deps.config.vercel();
  if (v) {
    try {
      const params = new URLSearchParams({ limit: '10' });
      if (v.projectId) params.set('projectId', v.projectId);
      if (v.teamId) params.set('teamId', v.teamId);
      const res = await deps.fetchFn(`https://api.vercel.com/v6/deployments?${params}`, { headers: { authorization: `Bearer ${v.token}` } });
      if (res.ok) {
        const j = await res.json();
        put('vercel.json', (j.deployments || []).map((d) => ({ state: d.state || d.readyState, url: d.url, sha: clip(d.meta?.githubCommitSha, 12), target: d.target, created: d.created })));
      } else put('vercel.json', { error: `Vercel HTTP ${res.status}` });
    } catch (e) { put('vercel.json', { error: clip(e.message, 200) }); }
  } else put('vercel.json', { error: 'vercel not configured' });
  try { put('builds.json', (deps.listBuilds() || []).slice(0, 10)); } catch (e) { put('builds.json', { error: clip(e.message, 200) }); }
  try { put('activity.json', deps.readActivity({ days: 2 }) || []); } catch (e) { put('activity.json', { error: clip(e.message, 200) }); }
  try { put('health.json', (await deps.platformStatus()).health); } catch (e) { put('health.json', { error: clip(e.message, 200) }); }
  summary.files = files.length;
  return { dir, files, summary };
}

// 9) failures — the patch queue. Every build failure is queued to disk and mirrored into Chronos
// (lib/failure-loop.mjs), so "what is broken and whose fault is it" is one command instead of an
// archaeology dig through data/builds. The blocked/actionable split is the useful part: a blocked
// failure retried by an agent just fails again.
export async function opsFailures({ days = 14 } = {}, deps = DEFAULT_OPS_DEPS) {
  const { openFailures } = await deps.failureLoop();
  const out = openFailures({ days });
  return {
    openCount: out.open.length,
    blocked: out.blocked,
    actionable: out.actionable,
    resolved: out.resolved,
    open: out.open.map((f) => ({
      id: f.id, at: f.at, kind: f.kind, repo: f.repo, blocked: !!f.blocked,
      errorKind: f.errorKind || null, reason: clip(f.reason, 300), title: f.title || null,
    })),
  };
}

// 3) diagnose — the Settings health map, plus SAFE auto-remediation with --fix: `git fetch origin`
// on each configured checkout (remote refs only), an ahead/behind report with the EXACT reconcile
// command (reported, never run — a working tree is Brandon's), then a re-probe to show which checks
// actually changed. Credential repairs can't be automated; their exact fixes are surfaced verbatim.
export async function diagnose({ fix = false } = {}, deps = DEFAULT_OPS_DEPS) {
  const summarize = (s) => ({ overall: s.health?.overall, counts: s.health?.counts, at: s.at });
  const statusById = (s) => Object.fromEntries((s.health?.checks || []).map((c) => [c.id, c.status]));
  const before = await deps.platformStatus();
  const actions = [];
  let after = null;
  if (fix) {
    const targets = [
      { name: 'command', dir: deps.config.commandRepoDir(), branch: deps.config.commandBranch() },
      { name: 'product', dir: deps.config.productRepoDir(), branch: deps.config.githubBranch() },
    ];
    for (const t of targets) {
      if (!t.dir || !deps.exists(t.dir)) { actions.push({ id: `fetch-${t.name}`, did: 'skipped', result: 'checkout not found' }); continue; }
      try {
        deps.execFile('git', ['fetch', 'origin'], { cwd: t.dir, encoding: 'utf8', timeout: 20000 });
        let pos = '';
        try {
          const counts = clip(deps.execFile('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${t.branch}`], { cwd: t.dir, encoding: 'utf8', timeout: 10000 }), 40);
          const [ahead, behind] = counts.split(/\s+/).map(Number);
          pos = behind > 0
            ? `${behind} behind origin/${t.branch}${ahead ? `, ${ahead} ahead` : ''} — reconcile with: git -C ${t.dir} merge --ff-only origin/${t.branch}`
            : `up to date with origin/${t.branch}${ahead ? ` (${ahead} ahead)` : ''}`;
        } catch (e) { pos = `position unknown: ${clip(e.message, 120)}`; }
        actions.push({ id: `fetch-${t.name}`, did: 'git fetch origin', result: pos });
      } catch (e) { actions.push({ id: `fetch-${t.name}`, did: 'git fetch origin', result: `failed: ${clip(e.message, 160)}` }); }
    }
    after = await deps.platformStatus();
  }
  const remediation = (before.health?.checks || []).filter((c) => c.status !== 'healthy' && c.fix)
    .map((c) => ({ id: c.id, status: c.status, fix: c.fix }));
  const changed = [];
  if (after) {
    const b = statusById(before); const a = statusById(after);
    for (const id of Object.keys(a)) if (b[id] !== a[id]) changed.push({ id, before: b[id], after: a[id] });
  }
  return { before: summarize(before), checks: before.health?.checks || [], actions, remediation, ...(after ? { after: summarize(after), changed } : {}) };
}
