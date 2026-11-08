// RUNNING CODE — one answer to "which code is actually running?"
//
// Three things can each hold a different version of this system: origin/main (what was merged), the
// shared checkout (what self-update installs FROM), and Seen Command.app (what actually runs). Chronos.app
// was a fourth until it was retired into Seen Command's Brain tab (2026-10-21); a copy still installed is
// reported, because it would sync the same vault from old code. Nothing compared them, so a merged fix was routinely assumed live when it was not: the
// checkout sat behind origin with a dirty file that blocked self-update, and the apps ran whatever they
// were last built from. A change is complete when its behaviour is observed where it RUNS — this is
// the chain that makes "where it runs" checkable.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

export const APP_STAMPS = {
  seenCommand: '/Applications/Seen Command.app/Contents/Resources/app/build-info.json',
};
// Apps that must NOT be installed any more, and how to remove them.
export const RETIRED_APPS = {
  '/Applications/Chronos.app': 'Chronos.app is retired (its screens are Seen Command → Brain) but is still installed — run `npm run brain:app` (or `npm run app:install`) to quit it and move it to the Trash.',
};
const APP_LABEL = { seenCommand: 'Seen Command.app' };
const IGNORE_DIRTY = /^(memory|data|public|dist|\.claude|\.agents|\.codex)\//;
const short = (s) => (s ? String(s).slice(0, 8) : 'unknown');

function readStamp(path, readFn, existsFn) {
  if (!existsFn(path)) return null;
  try { const j = JSON.parse(String(readFn(path, 'utf8'))); return { sha: j.sha || null, builtAt: j.builtAt || null, dirty: Array.isArray(j.dirty) ? j.dirty : [], version: j.version || null }; }
  catch { return { sha: null, builtAt: null, dirty: [], version: null, unreadable: true }; }
}

export function runningCode({ repoDir = config.commandRepoDir(), execFn = execFileSync, readFn = readFileSync, existsFn = existsSync, fetch = true, stamps = APP_STAMPS, retired = RETIRED_APPS } = {}) {
  const git = (...a) => { try { return String(execFn('git', a, { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' })).trim(); } catch { return null; } };
  // RAW, untrimmed: porcelain lines are `XY path`, and trimming the whole output eats the first line's
  // leading status space — shifting its path by one character (`ublic/…`) and defeating IGNORE_DIRTY.
  const porcelain = () => { try { return String(execFn('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' })).split('\n').filter(Boolean).map((l) => { const x = l.slice(3); const i = x.indexOf(' -> '); return i >= 0 ? x.slice(i + 4) : x; }); } catch { return []; } };
  if (fetch) git('fetch', '-q', 'origin', 'main');
  const origin = git('rev-parse', 'origin/main');
  const head = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = porcelain().filter((p) => p && !IGNORE_DIRTY.test(p));
  const ahead = origin && head ? Number(git('rev-list', '--count', `${origin}..${head}`) || 0) : null;
  const behind = origin && head ? Number(git('rev-list', '--count', `${head}..${origin}`) || 0) : null;
  // Is `sha` contained in origin/main? (an app built from main's history, however old) — null = unknown.
  const onMain = (sha) => { if (!sha || !origin) return null; try { execFn('git', ['merge-base', '--is-ancestor', sha, origin], { cwd: repoDir, stdio: 'pipe' }); return true; } catch (e) { return e && e.status === 1 ? false : null; } };
  const lag = (sha) => { if (!sha || !origin) return null; const n = git('rev-list', '--count', `${sha}..${origin}`); return n == null ? null : Number(n); };

  const apps = {};
  for (const [name, path] of Object.entries(stamps)) {
    const s = readStamp(path, readFn, existsFn);
    apps[name] = s ? { ...s, onMain: onMain(s.sha), behind: lag(s.sha) } : null;
  }

  const problems = [];
  if (!origin) problems.push('origin/main could not be resolved — nothing can be compared (offline, or not a checkout).');
  if (behind) problems.push(`the shared checkout (${branch} @ ${short(head)}) is ${behind} commit(s) behind origin/main (${short(origin)}) — self-update installs from here, so merged work is not reaching the apps.`);
  if (ahead) problems.push(`the shared checkout (${branch} @ ${short(head)}) is ${ahead} commit(s) ahead of origin/main (${short(origin)}) — unpushed commits in the shared checkout are as invisible to the apps as unmerged ones.`);
  if (branch && branch !== 'main' && branch !== 'HEAD') problems.push(`the shared checkout is on \`${branch}\`, not main — an app rebuilt from here would not be main.`);
  if (dirty.length) problems.push(`the shared checkout has ${dirty.length} uncommitted code file(s) (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}) — this is what has blocked self-update before.`);
  for (const [name, a] of Object.entries(apps)) {
    const label = APP_LABEL[name] || name;
    if (!a) { problems.push(`${label} has no build stamp — it cannot say which commit it is running (rebuild it: the stamp is written at build time).`); continue; }
    if (a.unreadable || !a.sha) { problems.push(`${label}'s build stamp is unreadable or has no commit.`); continue; }
    if (a.dirty.length) problems.push(`${label} was built from UNCOMMITTED code (${a.dirty.length} file(s)) — it matches no commit.`);
    if (a.onMain === false) problems.push(`${label} runs ${short(a.sha)}, which is NOT on origin/main — it was built from a branch.`);
    else if (a.behind) problems.push(`${label} runs ${short(a.sha)}, ${a.behind} commit(s) behind origin/main (${short(origin)}) — merged work is not running yet.`);
  }
  for (const [path, why] of Object.entries(retired || {})) if (existsFn(path)) problems.push(why);
  return { checkedAt: new Date().toISOString(), originMain: origin, checkout: { dir: repoDir, head, branch, ahead, behind, dirty }, apps, inSync: problems.length === 0, problems };
}

// Is a specific commit RUNNING in an installed app? true / false / null (cannot tell — never guessed).
export function isRunning(sha, report, app = 'seenCommand', { execFn = execFileSync } = {}) {
  const a = report && report.apps && report.apps[app];
  if (!sha || !a || !a.sha || a.dirty.length) return a && a.sha && a.dirty.length ? false : null;
  if (a.sha.startsWith(sha) || sha.startsWith(a.sha)) return true;
  try { execFn('git', ['merge-base', '--is-ancestor', sha, a.sha], { cwd: report.checkout.dir, stdio: 'pipe' }); return true; }
  catch (e) { return e && e.status === 1 ? false : null; }
}
