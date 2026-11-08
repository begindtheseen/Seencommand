#!/usr/bin/env node
// stamp-build — record WHICH CODE a packaged app is, at the moment it is built.
//
// Chronos.app has carried brain/build-info.json for months. Seen Command.app carried nothing: once
// installed, there was no way to tell which commit it was running, so "is the fix live?" could only be
// answered by memory — and the checkout, origin/main and the installed app routinely disagreed. This
// writes build-info.json at the repo root; electron-builder packages it; lib/running-code.mjs reads it.
// `dirty` is recorded, not hidden: an app built from uncommitted code matches NO commit, and must say so.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildStamp(root, { execFn = execFileSync, now = () => new Date() } = {}) {
  const git = (...a) => { try { return String(execFn('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' })).trim(); } catch { return ''; } };
  let version = null; try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null; } catch { /* unversioned */ }
  // Code only: the vault, runtime data and the generated dashboard are permanently "dirty" by design.
  // RAW, untrimmed: trimming the whole porcelain output eats the first line's leading status space.
  let raw = ''; try { raw = String(execFn('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })); } catch { /* not a checkout */ }
  const dirty = raw.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((p) => p && !/^(memory|data|public|dist|\.claude|\.agents|\.codex)\//.test(p) && !/build-info\.json$/.test(p));
  return { version, sha: git('rev-parse', 'HEAD') || null, branch: git('rev-parse', '--abbrev-ref', 'HEAD') || null, dirty, builtAt: now().toISOString() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const stamp = buildStamp(root);
  writeFileSync(join(root, 'build-info.json'), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`[stamp-build] ${stamp.sha ? stamp.sha.slice(0, 8) : 'NO COMMIT'} on ${stamp.branch}${stamp.dirty.length ? ` — DIRTY (${stamp.dirty.length} uncommitted code file(s): this build matches no commit)` : ''}`);
}
