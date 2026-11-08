// Single choke point for read-only SQLite access to a compiler project's state.sqlite.
//
// Why this exists: node:sqlite is a built-in but it is version-gated (Node ≥22.5, and it needs
// `--experimental-sqlite` until Node 24). The packaged Electron app runs engine/server.mjs as an
// ELECTRON_RUN_AS_NODE child of Electron's embedded Node, so availability depends on the Electron
// version + flag. Rather than crash the whole server at import time (a top-level `import ... from
// 'node:sqlite'` throws if the module is absent), we load it lazily via createRequire and surface a
// HONEST status: callers get a clear error, doctor reports it, and the rest of the app still boots.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let _mod; // cached { ok, DatabaseSync?, error? }

// Resolve node:sqlite synchronously. Never throws — returns a status object (cached).
export function loadSqlite() {
  if (_mod) return _mod;
  try {
    const m = require('node:sqlite');
    if (!m || typeof m.DatabaseSync !== 'function') throw new Error('node:sqlite present but DatabaseSync missing');
    _mod = { ok: true, DatabaseSync: m.DatabaseSync };
  } catch (e) {
    _mod = { ok: false, error: sqliteHint(e) };
  }
  return _mod;
}

export function sqliteAvailable() { return loadSqlite().ok; }
export function sqliteStatus() { const s = loadSqlite(); return s.ok ? { ok: true } : { ok: false, error: s.error }; }

function sqliteHint(e) {
  const msg = String((e && e.message) || e);
  if (/experimental-sqlite/i.test(msg) || /No such built-in module/i.test(msg) || /Cannot find module 'node:sqlite'/i.test(msg)) {
    return 'node:sqlite unavailable in this runtime — needs Node ≥22.5 with --experimental-sqlite (or Node ≥24). '
      + `The Creator Library reads SQLite directly; upgrade the runtime or enable the flag. (${msg})`;
  }
  return `node:sqlite load failed: ${msg}`;
}

// Open a project's state.sqlite read-only. Returns a DatabaseSync, or null if the file is missing or
// the runtime lacks node:sqlite. Never throws.
export function openProjectDb(projectDir) {
  const dbPath = join(projectDir, 'state.sqlite');
  if (!existsSync(dbPath)) return null;
  const s = loadSqlite();
  if (!s.ok) return null;
  try { return new s.DatabaseSync(dbPath, { readOnly: true }); }
  catch { return null; }
}
