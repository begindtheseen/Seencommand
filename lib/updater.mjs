// In-app updates, the way ORBIT and LAUNCHPAD do them (owner, 2026-10-21: "an in app updater like how our
// other projects, orbit and launchpad have, for all future updates"): the app checks on its own (at launch
// and every hour), says when a new version exists and WHAT is new, and one click installs it and restarts.
//
// Seen Command ships from git, not GitHub Releases, so "a new version" = commits on origin/main the
// installed app was not built from (its build-info.json stamp, lib/running-code.mjs). Installing reuses the
// proven path, engine/self-update.mjs --no-merge: the full test suite runs in an ISOLATED worktree of
// origin/main first (red → nothing is installed), then the checkout fast-forwards, packages install when
// they changed, the app is rebuilt into /Applications and reopened. Progress is that run's own log.
// After the restart the app compares its stamp with the last one it ran and shows "Updated — what's new".
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { dataDir, REPO_ROOT } from './paths.mjs';
import { APP_STAMPS } from './running-code.mjs';
import { listBuilds } from './builds.mjs';

const short = (s) => (s ? String(s).slice(0, 7) : '');
const stateFile = () => join(dataDir(), 'update-state.json');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { try { mkdirSync(dataDir(), { recursive: true }); const t = `${p}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v, null, 2)); renameSync(t, p); } catch { /* best effort */ } };

// The commits between two shas, newest first, as { sha, subject, at }. Pure over `git`.
export function commitsBetween(from, to, { repoDir, execFn = execFileSync, max = 40 } = {}) {
  if (!to) return [];
  const range = from ? `${from}..${to}` : to;
  try {
    const out = String(execFn('git', ['log', '--no-merges', `--max-count=${max}`, '--format=%H%x09%cI%x09%s', range], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }));
    return out.split('\n').filter(Boolean).map((l) => { const [sha, at, ...s] = l.split('\t'); return { sha, at, subject: s.join('\t') }; });
  } catch { return []; }
}

// Decide what the update card says from the running-code report. Pure — unit tested.
export function updateVerdict(report, commits = []) {
  const app = report?.apps?.seenCommand || null;
  const latest = report?.originMain || null;
  if (!latest) return { state: 'unknown', reason: 'Could not reach GitHub to check (offline?).', latest: null, current: app?.sha || null, commits: [] };
  if (!app || !app.sha) return { state: 'available', reason: 'This copy has no version stamp — updating rebuilds it from the latest code.', latest, current: null, commits };
  if (app.sha === latest || app.behind === 0) return { state: 'up-to-date', latest, current: app.sha, commits: [] };
  const ck = report.checkout || {};
  const blocked = (ck.dirty || []).length ? `The Seen Command folder (${ck.dir}) has uncommitted code changes (${ck.dirty.slice(0, 3).join(', ')}) — commit or stash them first.`
    : ck.ahead ? `The Seen Command folder has ${ck.ahead} local commit(s) that are not on GitHub — push or drop them first.` : null;
  return { state: blocked ? 'blocked' : 'available', reason: blocked, latest, current: app.sha, behind: app.behind ?? commits.length, commits };
}

// The check itself runs `git fetch` + several `git` reads synchronously (lib/running-code.mjs). Inside the
// server that froze every request for seconds each hour, so by default it runs in a CHILD process
// (scripts/update-check.mjs) and only its JSON comes back. Tests inject `report` and stay in-process.
export function checkInChild({ repoDir, spawnFn = nodeSpawn, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    const child = spawnFn(process.execPath, [join(REPO_ROOT, 'scripts', 'update-check.mjs'), repoDir], { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ report: { originMain: null, apps: {}, problems: ['the update check timed out'] }, commits: [] }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish({ report: { originMain: null, apps: {}, problems: ['the update check could not start'] }, commits: [] }));
    child.on('close', () => { try { finish(JSON.parse(out.trim().split('\n').pop())); } catch { finish({ report: { originMain: null, apps: {}, problems: ['the update check returned nothing'] }, commits: [] }); } });
  });
}

export function createUpdater({ repoDir = () => config.commandRepoDir(), execFn = execFileSync, spawn = nodeSpawn, report = null, notify = () => {}, builds = listBuilds, stampPath = APP_STAMPS.seenCommand, now = () => new Date(), inChild = checkInChild } = {}) {
  let last = readJson(stateFile()) || {};
  let timer = null; let checking = null;

  async function check({ quiet = false } = {}) {
    if (checking) return checking;
    checking = (async () => {
      const dir = repoDir();
      let r; let commits;
      if (report) { // in-process (tests)
        try { r = report({ repoDir: dir, execFn, fetch: true }); } catch (e) { r = { originMain: null, apps: {}, problems: [e.message] }; }
        commits = r.originMain ? commitsBetween(r.apps?.seenCommand?.sha || null, r.originMain, { repoDir: dir, execFn }) : [];
      } else ({ report: r, commits } = await inChild({ repoDir: dir }));
      const v = { ...updateVerdict(r, commits), checkedAt: now().toISOString() };
      // One notification per new version (not every hour).
      if (v.state === 'available' && v.latest && last.notifiedFor !== v.latest && !quiet) {
        notify({ kind: 'update', level: 'info', title: `Seen Command update ready — ${v.commits.length || 'new'} change${v.commits.length === 1 ? '' : 's'}`, body: v.commits.slice(0, 3).map((c) => c.subject).join(' · '), tab: 'settings', key: `update:${v.latest}` });
        last.notifiedFor = v.latest;
      }
      last = { ...last, verdict: v };
      writeJson(stateFile(), last);
      return v;
    })().finally(() => { checking = null; });
    return checking;
  }

  // The live install, if one is running or just ended (the newest self-update run in the builds store).
  function progress() {
    const run = (builds() || []).filter((b) => b.kind === 'self-update').sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
    if (!run) return null;
    return { id: run.id, status: run.status, startedAt: run.startedAt || null, endedAt: run.endedAt || null, error: run.error || null, summary: run.summary || null, log: (run.log || []).slice(-30) };
  }

  function apply() {
    const p = progress();
    if (p && (p.status === 'building' || p.status === 'queued')) return { ok: true, already: true, progress: p };
    // Same launch as the Board Room's "update yourself" (engine/server.mjs): the server's own runtime (node,
    // or Electron with ELECTRON_RUN_AS_NODE set by app/main.js), detached so it survives the app quitting.
    const child = spawn(process.execPath, ['engine/self-update.mjs', '--no-merge'], { cwd: REPO_ROOT, env: process.env, detached: true, stdio: 'ignore' });
    child.unref?.();
    last = { ...last, applyingFrom: last.verdict?.current || null, applyingTo: last.verdict?.latest || null, appliedAt: now().toISOString() };
    writeJson(stateFile(), last);
    return { ok: true, started: true };
  }

  // Run once at launch: did we just come back from an update? → "Updated — what's new" (once).
  function announceIfUpdated() {
    const stamp = readJson(stampPath) || readJson(join(REPO_ROOT, 'build-info.json'));
    const sha = stamp?.sha || null;
    if (!sha) return null;
    const prev = last.ranSha || null;
    last.ranSha = sha; writeJson(stateFile(), last);
    if (!prev || prev === sha) return null;
    const commits = commitsBetween(prev, sha, { repoDir: repoDir(), execFn });
    notify({ kind: 'update', level: 'success', title: `Updated to ${short(sha)} — what's new`, body: commits.length ? commits.slice(0, 6).map((c) => c.subject).join(' · ') : `from ${short(prev)}`, tab: 'settings', key: `updated:${sha}` });
    last.whatsNew = { from: prev, to: sha, commits, at: now().toISOString() }; writeJson(stateFile(), last);
    return last.whatsNew;
  }

  return {
    check, apply, progress, announceIfUpdated,
    status: () => ({ verdict: last.verdict || null, progress: progress(), whatsNew: last.whatsNew || null, running: readJson(stampPath) || readJson(join(REPO_ROOT, 'build-info.json')) || null }),
    start({ everyMs = 60 * 60_000, firstMs = 8000 } = {}) {
      try { announceIfUpdated(); } catch { /* never blocks start */ }
      setTimeout(() => check().catch(() => {}), firstMs).unref?.();
      if (!timer) { timer = setInterval(() => check().catch(() => {}), everyMs); timer.unref?.(); }
    },
  };
}
