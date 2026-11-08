// Runs the base-branch health check (lib/base-health.mjs) in the BACKGROUND, from Settings → System
// diagnostics ("Check now") and once a day on its own.
//
// Why a child process: checkBaseHealth runs each repository's whole test suite synchronously (minutes).
// Called inside the server it would freeze every request until it finished. The CLI entry
// `node lib/base-health.mjs both` records its verdicts to data/base-health.json, which the diagnostics
// already read (readBaseHealth) — so this module only starts it, tracks it, and decides when it is due.
//
// Before this, nothing ever ran the check: both "base branch" cards said "Unknown — never checked" and
// told the owner to "Run checkBaseHealth", a function name, not something they could press.
// Tests: lib/base-health-job.test.mjs.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { readBaseHealth } from './base-health.mjs';

export const STALE_MS = 24 * 60 * 60 * 1000;

export function createBaseHealthJob({
  spawnFn = spawn,
  read = readBaseHealth,
  now = () => new Date(),
  execPath = process.execPath,
  env = () => process.env,
  script = join(REPO_ROOT, 'lib', 'base-health.mjs'),
  staleMs = STALE_MS,
} = {}) {
  let state = { running: false, trigger: null, startedAt: null, finishedAt: null, exitCode: null, error: null };
  const snapshot = () => ({ ...state });

  function start(trigger = 'manual') {
    if (state.running) return { ok: true, alreadyRunning: true, job: snapshot() };
    let child;
    try {
      child = spawnFn(execPath, [script, 'both'], { cwd: REPO_ROOT, env: env(), stdio: 'ignore' });
    } catch (e) {
      state = { ...state, running: false, error: `could not start the check: ${String(e.message || e).slice(0, 160)}` };
      return { ok: false, error: state.error, job: snapshot() };
    }
    state = { running: true, trigger, startedAt: now().toISOString(), finishedAt: null, exitCode: null, error: null };
    child.on?.('error', (e) => { state = { ...state, running: false, finishedAt: now().toISOString(), error: `the check could not run: ${String(e.message || e).slice(0, 160)}` }; });
    // Exit 1 is normal: the CLI exits non-zero whenever a base is not green. The verdict is in the file.
    child.on?.('exit', (code) => { state = { ...state, running: false, finishedAt: now().toISOString(), exitCode: code }; });
    return { ok: true, started: true, job: snapshot() };
  }

  // Due when either repository has no verdict, or its newest verdict is older than staleMs.
  function due() {
    for (const repo of ['tool', 'product']) {
      let v; try { v = read(repo); } catch { return true; }
      const at = Date.parse(v?.checkedAt || '');
      if (!Number.isFinite(at) || now().getTime() - at > staleMs) return true;
    }
    return false;
  }
  function tick() { return !state.running && due() ? start('daily') : { ok: true, skipped: true, job: snapshot() }; }

  // First look a few minutes after launch (never slow the app's start), then hourly.
  let timers = [];
  function startSchedule({ firstDelayMs = 3 * 60 * 1000, everyMs = 60 * 60 * 1000 } = {}) {
    if (timers.length) return;
    const t1 = setTimeout(() => { try { tick(); } catch { /* next hour */ } }, firstDelayMs);
    const t2 = setInterval(() => { try { tick(); } catch { /* next hour */ } }, everyMs);
    t1.unref?.(); t2.unref?.();
    timers = [t1, t2];
  }
  function stopSchedule() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  return { start, status: snapshot, due, tick, startSchedule, stopSchedule };
}

let singleton = null;
export const baseHealthJob = () => (singleton ||= createBaseHealthJob());
