// Minimal dependency-free cross-process mutex for small synchronous filesystem transactions.
// An atomic lock-directory create serializes read-modify-write sections across MCP processes and
// Chronos.app. The directory is intentionally empty so a crashed holder can be recovered safely
// after a conservative stale interval.
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function withSyncDirectoryLock(lockPath, fn, {
  timeoutMs = 10_000,
  staleMs = 5 * 60_000,
  pollMs = 10,
} = {}) {
  if (typeof fn !== 'function') throw new TypeError('lock callback required');
  const path = String(lockPath || '');
  if (!path) throw new Error('lock path required');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let held = false;
  while (!held) {
    try {
      mkdirSync(path, { mode: 0o700 });
      held = true;
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      // No other holder can replace this directory while it exists. If it is stale, removing the
      // empty directory is safe; after removal, every contender must race through mkdir again.
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          rmdirSync(path);
          continue;
        }
      } catch (staleError) {
        if (staleError && staleError.code !== 'ENOENT') throw staleError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`lock busy: ${path}`);
      Atomics.wait(sleeper, 0, 0, Math.max(1, Number(pollMs) || 1));
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(path); } catch { /* a failed cleanup becomes a recoverable stale lock */ }
  }
}
