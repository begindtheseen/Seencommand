// paths — the ONE place that decides where Seen Command reads/writes at runtime. This is what lets
// the packaged .app run fully live from /Applications: a macOS .app bundle is READ-ONLY, so nothing
// may be written inside it. The Electron shell sets SEEN_HOME to app.getPath('userData')
// (…/Library/Application Support/Seen Command) — a per-user writable dir — and passes it to every
// child script. All runtime artifacts (state.json, the generated dashboard, the local fallback
// vault, the seeded .env) live under SEEN_HOME, never in the bundle.
//
// In a plain dev/CLI run SEEN_HOME is unset, so everything falls back to the repo — dev behavior is
// unchanged (npm run brief still writes command-os/data + command-os/public).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';

// The repo root (…/command-os), or …/Contents/Resources/app inside a packaged bundle. READ-ONLY
// when packaged — use it only to locate bundled read-only assets (org data, seed files), never to write.
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The PRIMARY checkout when REPO_ROOT is a git worktree, else null.
//
// `.env` is gitignored, so it exists only in the primary checkout — a worktree starts with no
// credentials at all. Every credential-gated check then degrades to a shrug: `deploy-drift.mjs` run
// from a worktree printed "not checkable (prod deploy unknown)" and exited 0, which is
// indistinguishable from "production is fine". Same silent-zero shape we keep paying for. In a
// worktree `.git` is a FILE reading `gitdir: <primary>/.git/worktrees/<name>`, so the primary root is
// that path with the `/.git/worktrees/<name>` tail removed.
export function parseWorktreeGitdir(text) {
  const m = /^gitdir:\s*(.+)$/m.exec(String(text ?? ''));
  if (!m) return null;
  const i = m[1].trim().indexOf('/.git/worktrees/');
  return i > 0 ? m[1].trim().slice(0, i) : null;
}

export function primaryRepoRoot() {
  try { return parseWorktreeGitdir(readFileSync(join(REPO_ROOT, '.git'), 'utf8')); }
  catch { return null; } // a directory (not a file) at .git means this IS the primary checkout
}

// The writable runtime home. Packaged: Electron's userData (set via SEEN_HOME). Dev: the repo.
export function seenHome() {
  const h = process.env.SEEN_HOME && process.env.SEEN_HOME.trim();
  return h || REPO_ROOT;
}

const ensure = (dir) => { mkdirSync(dir, { recursive: true }); return dir; };

export const dataDir = () => ensure(join(seenHome(), 'data'));
export const publicDir = () => ensure(join(seenHome(), 'public'));
export const statePath = () => join(dataDir(), 'state.json');
export const dashboardPath = () => join(publicDir(), 'command-center.html');
export const localVaultDir = () => join(dataDir(), 'brain'); // fallback vault when CHRONOS_VAULT unset
export const envPath = () => join(seenHome(), '.env');       // the runtime .env (seeded from the bundle)
