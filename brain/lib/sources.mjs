// sources — locate the two memory stores Chronos.app unifies, with sensible defaults + overrides.
//
//   1. Seen Command's board-meeting state  → data/state.json (this repo).      [state.memoryGraph]
//   2. Seen's Chronos temporal vault        → the `seen` repo's memory/ folder. [typed facts + notes]
//
// Both repos normally sit as siblings on the Mac (…/seen-command, …/seen). We default to that and
// let env vars override, so a packaged .app still finds live data. If the vault can't be found the
// app still runs on the Command graph alone (unify.mjs reports vaultFound:false and the UI shows it).

import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// brain/lib/sources.mjs → repo root is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
export const SEEN_COMMAND_ROOT = resolve(HERE, '..', '..');

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// Resolution precedence (first that exists wins): env var → saved config override (from the app's
// first-run folder picker) → auto-probe (dev run / cwd-relative / sibling layouts). This lets a
// Finder-launched .app — which has no useful cwd and no shell env — still find live data once the
// user has pointed it at their repos once.

// data/state.json — the Command graph. Override with SEEN_COMMAND_STATE or `override`.
export function resolveStatePath(override) {
  const cwd = process.cwd();
  const candidates = [
    process.env.SEEN_COMMAND_STATE,
    override,
    join(SEEN_COMMAND_ROOT, 'data', 'state.json'),
    join(cwd, 'data', 'state.json'),
    join(cwd, '..', 'data', 'state.json'),
  ].filter(Boolean);
  for (const c of candidates) { const p = resolve(c); if (isFile(p)) return p; }
  return candidates.length ? resolve(candidates[0]) : join(SEEN_COMMAND_ROOT, 'data', 'state.json');
}

// The Chronos vault (a folder of .md notes). Override with CHRONOS_VAULT or `override`; else probe
// the usual sibling layouts. Returns an absolute path or null if none exists.
export function resolveVaultPath(override) {
  const cwd = process.cwd();
  const candidates = [
    process.env.CHRONOS_VAULT,
    override,
    join(SEEN_COMMAND_ROOT, '..', 'seen', 'memory'),        // …/seen-command + …/seen (siblings)
    join(SEEN_COMMAND_ROOT, '..', '..', 'seen', 'memory'),  // one level deeper
    join(SEEN_COMMAND_ROOT, 'seen', 'memory'),              // seen checked out inside this repo
    join(cwd, '..', 'seen', 'memory'),                      // cwd sibling (packaged, run from repo)
    join(cwd, '..', '..', 'seen', 'memory'),
  ].filter(Boolean);
  for (const c of candidates) {
    const p = resolve(c);
    if (isDir(p)) return p;
  }
  return null;
}

// overrides: { statePath?, vaultPath? } — typically the app's saved config.
export function resolveSources(overrides = {}) {
  const statePath = resolveStatePath(overrides.statePath);
  const vaultPath = resolveVaultPath(overrides.vaultPath);
  return {
    statePath,
    vaultPath,
    stateFound: existsSync(statePath),
    vaultFound: !!vaultPath,
    seenCommandRoot: SEEN_COMMAND_ROOT,
  };
}
