// Build status store — the shared truth for autonomous builds kicked off from the approval gate.
// Each build is one small JSON file under data/builds/<id>.json, written by the background build-runner
// and read by the server's GET /api/builds (which the dashboard polls to show "building… → PR ready").
//
// Kept as separate per-build files (NOT inside state.json) on purpose: a board meeting rewrites
// state.json wholesale, and a build runs concurrently — separate files mean the two writers never race.

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dataDir } from './paths.mjs';

const MAX_LOG = 40; // keep the last N log lines per build

export function buildsDir() {
  const d = join(dataDir(), 'builds');
  mkdirSync(d, { recursive: true });
  return d;
}
const safeId = (id) => String(id).replace(/[^\w.-]/g, '_').slice(0, 120);
export function buildPath(id) { return join(buildsDir(), `${safeId(id)}.json`); }

export function readBuild(id) {
  const p = buildPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Merge `patch` into the build record (create if new) and persist. Returns the merged record.
export function writeBuild(id, patch = {}) {
  const cur = readBuild(id) || { id: safeId(id), status: 'queued', log: [] };
  const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
  if (patch.log) next.log = patch.log.slice(-MAX_LOG); // allow full replacement
  writeFileSync(buildPath(id), JSON.stringify(next, null, 2));
  return next;
}

// QUEUE a build under `id`. Build ids are STABLE (`task-176`), so a re-run merges onto the last run's
// record — and the field that must never carry over is `pid`. It did: the server queued the record
// without clearing it, so between that write and the runner recording its own pid, the next runner's
// stale sweep saw a pid from a run that ended weeks ago, found it dead, and reaped the build one second
// after it was kicked. The dashboard then showed a red "build failed" card for a build that went on to
// run normally (live, 2026-09-21: task-175 and task-176, pids 50117/50147 from an earlier run).
// Every field here is the PREVIOUS run's verdict; a fresh run must wear none of them.
export const STALE_RUN_FIELDS = Object.freeze({
  pid: null, status: 'queued', error: null, errorKind: null, errorDetail: null, blocked: false,
  endedAt: null, summary: null, touched: [], engine: null, pr: null, prNumber: null, merged: false,
  prStatus: null, preview: null, proof: null, reconciled: null, log: [],
});
export function queueBuild(id, fields = {}) {
  return writeBuild(id, { ...STALE_RUN_FIELDS, startedAt: new Date().toISOString(), ...fields });
}

// Append one log line to a build (bounded) and persist.
export function appendBuildLog(id, line) {
  const cur = readBuild(id) || { id: safeId(id), status: 'building', log: [] };
  const log = [...(cur.log || []), `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-MAX_LOG);
  return writeBuild(id, { log });
}

// All builds, most-recently-updated first. Used by GET /api/builds.
export function listBuilds() {
  let names = [];
  try { names = readdirSync(buildsDir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names
    .map((n) => { try { return JSON.parse(readFileSync(join(buildsDir(), n), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// ---- zombie reconciliation: a dead build must never show as in-flight forever --------------------
// A build record reaches a terminal status only because the runner LIVED long enough to write one.
// Kill the app mid-build, crash, or reboot, and the record is frozen at 'queued'/'building' — the
// dashboard then paints "building…" forever for a process that has not existed for days, which reads
// as "still working on it" when the truth is "it died". That is a failure rendered as progress.
//
// engine/reconcile.mjs does NOT cover this: it only walks records that already have a PR (closing
// tasks whose PR merged, and flipping stale-green `pr_ready` cards to `pr_closed`). A build that died
// before opening a PR has no `pr`, so that sweep skips it entirely (`if (!pr) continue`).
//
// The test here is deterministic, not a guess:
//   • the record names a pid and that pid is GONE  → definitively dead, reap it;
//   • the record has NO pid (written before pids were recorded) → fall back to a staleness age, so an
//     ancient 'building' still gets a verdict instead of lingering as a permanent lie.
// A record whose pid is still alive is LEFT ALONE — a slow build is not a dead one.
export const NON_TERMINAL_BUILD = new Set(['queued', 'building']);
const STALE_BUILD_MS = 6 * 60 * 60 * 1000; // no pid to check → older than this is not plausibly live

export function staleBuildReason(build, { now = Date.now(), isAlive = pidAlive, staleMs = STALE_BUILD_MS } = {}) {
  if (!build || !NON_TERMINAL_BUILD.has(build.status)) return null;
  if (build.pid != null) {
    if (isAlive(build.pid)) return null; // still running — honest in-flight
    return `the build process (pid ${build.pid}) exited without recording an outcome — the app was quit, crashed, or the machine restarted mid-build. Nothing was shipped; re-run the task to try again.`;
  }
  const started = Date.parse(build.updatedAt || build.startedAt || '');
  if (!Number.isFinite(started)) return null;         // undatable → don't guess
  const ageMs = now - started;
  if (ageMs < staleMs) return null;                    // recent enough to still be real
  const hours = Math.max(1, Math.round(ageMs / 3600000));
  return `stuck in '${build.status}' with no progress for ${hours}h and no live build process to check — treating it as dead. Nothing was shipped; re-run the task to try again.`;
}

// Sweep every non-terminal record; mark each dead one 'failed' with an actionable reason. Returns the
// reaped records so a caller can log them. Fully injectable — tests never touch a real process table.
export function reconcileStaleBuilds({ builds = null, now = Date.now(), isAlive = pidAlive, staleMs = STALE_BUILD_MS, write = writeBuild, log = () => {} } = {}) {
  const records = builds || listBuilds();
  const reaped = [];
  for (const b of records) {
    const reason = staleBuildReason(b, { now, isAlive, staleMs });
    if (!reason) continue;
    try {
      write(b.id, { status: 'failed', error: reason, endedAt: new Date(now).toISOString(), reapedFrom: b.status });
      reaped.push({ id: b.id, from: b.status, reason });
      log(`reaped zombie build ${b.id} (was '${b.status}'): ${reason}`);
    } catch (e) { log(`could not reap ${b.id}: ${e.message}`); }
  }
  return reaped;
}

// ---- the build slot: ONE builder at a time -------------------------------------------------------
// Every build shares one local coder (Ollama saturates and rounds crawl) and tool-repo builds share
// ONE git checkout (two builders switching branches under each other corrupts both). So the runner
// takes this lock before building; later builds wait in 'queued' until the slot frees. The lock is a
// pid file — a holder whose process is gone is stale and gets cleared, so a crashed build never
// wedges the queue.
const lockPath = () => join(buildsDir(), '.runner.lock');

// Is `pid` a live process? `kill(pid, 0)` sends no signal — it only asks the kernel. ESRCH means the
// process is genuinely gone; EPERM means it EXISTS but belongs to another user, so it is very much
// alive. Treating EPERM as dead (the old `catch → dead`) would yank a live builder's lock and let two
// builders share one checkout — the exact corruption the slot exists to prevent.
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { kill(Number(pid), 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// The live holder ({ pid, id, at }) or null. Clears a stale/corrupt lock as a side effect.
export function buildSlotHolder() {
  let h = null;
  try { h = JSON.parse(readFileSync(lockPath(), 'utf8')); } catch { h = null; }
  if (h && h.pid && pidAlive(h.pid)) return h;
  try { unlinkSync(lockPath()); } catch { /* nothing to clear */ }
  return null;
}

// Wait for the slot, then take it for this process. Calls onWait(holder) once per poll while blocked.
export async function acquireBuildSlot(id, onWait, { pollMs = 10000, timeoutMs = 60 * 60 * 1000 } = {}) {
  const started = Date.now();
  for (;;) {
    const holder = buildSlotHolder();
    if (!holder) {
      try {
        writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, id, at: new Date().toISOString() }), { flag: 'wx' });
        return;
      } catch { /* raced another runner for the free slot — re-check */ }
    } else {
      if (Date.now() - started >= timeoutMs) throw new Error(`gave up waiting for the build slot after ${Math.round(timeoutMs / 60000)} min (held by ${holder.id})`);
      if (onWait) onWait(holder);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Free the slot — only if THIS process holds it (never yank the lock out from under another build).
export function releaseBuildSlot() {
  try {
    const h = JSON.parse(readFileSync(lockPath(), 'utf8'));
    if (h.pid === process.pid) unlinkSync(lockPath());
  } catch { /* already gone */ }
}
