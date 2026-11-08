// base-health — the BASE branch's own gate, run in a throwaway worktree and cached as a QUEUE gate.
//
// Gap #4 (NEXT_UPDATE.md): task-63, task-65, task-176 and chat-mrea9fzb were all FAILED for something
// none of them caused — the base branch's own suite was already red, and every new task discovered it
// one build at a time and took the blame. task-63/65 even recorded "baseline tests are already red —
// fix main first: TESTS:" with NOTHING after the colon. The fix is to check the BASE on its own
// schedule and gate the QUEUE: `checkBaseHealth` runs the base's gate in a temp worktree off
// origin/<base> (the shared checkout is never switched or read for cleanliness — the same isolation
// argument engine/build-worktree.mjs bought the builder), records the verdict to
// data/base-health.json (BOTH repos in one file, so one read answers "is anything gating the
// queue?"), and `readBaseHealth` serves the cached verdict to whoever asks — lib/platform-status.mjs
// renders it as the 'base-health' check, and the builder queue can gate on it.
//
// The verdict is deliberately TRI-STATE (the claude-cli precedent in lib/credentials.mjs):
//   green: true  — the base's own gate RAN and passed;
//   green: false — the gate RAN and is red (the queue is gated; fix the base first, not the tasks);
//   green: null  — the gate COULD NOT RUN (no checkout, no origin/<base> ref, the child would not
//                  launch, the bound was exceeded, or it exited red with NO output — a broken gate,
//                  not a broken test). null must NEVER render as green: an unverifiable base is
//                  unverified, not healthy (the silent-zero rule).
//
// Every external touch is injectable with real defaults, so the tests run offline — no git, no npm,
// no network. The cache itself is real fs under dataDir(), which tests redirect via SEEN_HOME.

import { execFileSync } from 'node:child_process';
import { nodeTestCommand, hermeticEnv } from '../engine/gate.mjs';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.mjs';
import { dataDir } from './paths.mjs';

const clip = (v, n = 500) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// Where verdicts live. One file, keyed by repo ('tool' | 'product').
export function baseHealthPath() { return join(dataDir(), 'base-health.json'); }

// repo → { dir, base, envVar }: which checkout, which base branch, and the EXACT env var to fix —
// a reason that names no fix is the failure mode this whole module exists to end.
function repoTarget(repo, configObj) {
  if (repo === 'tool') return { dir: configObj.commandRepoDir(), base: configObj.commandBranch(), envVar: 'SEEN_COMMAND_REPO_DIR' };
  if (repo === 'product') return { dir: configObj.productRepoDir(), base: configObj.githubBranch(), envVar: 'SEEN_PRODUCT_REPO_DIR' };
  throw new Error(`checkBaseHealth: unknown repo '${repo}' — expected 'tool' or 'product'`);
}

// The gate child needs a PATH that actually contains node/npm: a Finder/launchd-launched app gets a
// bare PATH, and its child dies instantly with EMPTY output — the exact way task-63/65 recorded a
// red baseline naming no failure. Its environment is engine/gate.mjs hermeticEnv() — the SAME one
// the builder's gate uses: credentials and service endpoints stripped. This check used to hand the
// suite the whole app environment, so Seen's tests ran with the owner's real SUPABASE_URL and
// service key, missed their fixture URL and read RED (16 failing on 2026-10-20) while the builder's
// gate, on the same commit, was green.
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const binFor = (name) => BIN_PATHS.map((p) => join(p, name)).find((f) => existsSync(f)) || name;

// The base's OWN gate: `npm test` when the repo defines one (the product repo), else the tracked
// *.test.mjs suite under `node --test` (the tool repo ships no test script — this matches its
// builder gate). A repo with neither has NO gate — that is null (nothing can vouch for it), never green.
// Failing test names from node:test output, in either reporter: TAP ("not ok 12 - name") or spec
// ("✖ name (12.3ms)"). The spec summary repeats every failure under "✖ failing tests:", so names are
// de-duplicated, and suite/file lines are dropped.
export function failingTests(output, max = 6) {
  const names = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const l = raw.trim();
    let m = /^not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(l) || /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(l);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || /^failing tests:?$/i.test(name) || /\.test\.m?js$/.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return { total: names.length, names: names.slice(0, max).map((n) => (n.length > 90 ? `${n.slice(0, 87)}…` : n)) };
}

function runBaseGate(wt, { base, execFn, exists, read, timeoutMs }) {
  let pkg = null;
  try { if (exists(join(wt, 'package.json'))) pkg = JSON.parse(String(read(join(wt, 'package.json'), 'utf8'))); } catch { pkg = null; }
  let cmd; let label; let cmdEnv;
  if (pkg && pkg.scripts && pkg.scripts.test) { cmd = [binFor('npm'), ['test']]; label = 'npm test'; cmdEnv = hermeticEnv(); }
  else {
    let files = [];
    // git ls-files sees only TRACKED tests — .claude session worktrees and other junk never leak in.
    try { files = String(execFn('git', ['ls-files', '*.test.mjs'], { cwd: wt, encoding: 'utf8', stdio: 'pipe', timeout: 60000 })).split('\n').map((s) => s.trim()).filter(Boolean); }
    catch { files = []; }
    if (!files.length) return { green: null, reason: `cannot run: origin/${base} defines no test script and tracks no *.test.mjs files — there is no gate to vouch for it.` };
    const nt = nodeTestCommand(files); // the one definition of how node:test is launched (engine/gate.mjs)
    cmd = [nt.bin, nt.args]; label = `node --test (${files.length} file(s))`; cmdEnv = nt.env;
  }
  const started = Date.now();
  try {
    execFn(cmd[0], cmd[1], { cwd: wt, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, env: cmdEnv });
    return { green: true, reason: `origin/${base} gate green (${label}, ${Math.round((Date.now() - started) / 1000)}s).` };
  } catch (e) {
    // Classify HOW it failed: "ran and is red" is a verdict; "could not run" is not (silent-zero).
    if (e && e.code === 'ENOENT') return { green: null, reason: `cannot run: ${label} could not launch (${cmd[0]}: ENOENT) — the gate is broken in this launch context, not the base.` };
    if (e && (e.killed || e.signal)) return { green: null, reason: `cannot run: ${label} exceeded the ${Math.round(timeoutMs / 1000)}s bound and was killed — raise timeoutMs or run the gate by hand.` };
    const out = `${String(e.stdout || '')}\n${String(e.stderr || '')}`;
    const evidence = clip(`${String(e.stdout || '').slice(-1200)} ${String(e.stderr || '').slice(-400)}`, 380);
    if (!evidence) return { green: null, reason: `cannot run: ${label} exited red but produced NO output — the test child probably failed to launch at all; treat this as a broken gate, not a red base (the task-63/65 shape).` };
    // Name the failing tests (what the owner can act on) instead of an arbitrary tail of the log.
    const failing = failingTests(out);
    if (failing.names.length) {
      const more = failing.total > failing.names.length ? ` (+${failing.total - failing.names.length} more)` : '';
      return { green: false, reason: `origin/${base} is red — ${failing.total} failing test${failing.total === 1 ? '' : 's'}: ${failing.names.join('; ')}${more}` };
    }
    return { green: false, reason: `origin/${base} is red — fix ${base} first: ${evidence}` };
  }
}

// Merge one repo's verdict into the shared cache file. Read-modify-write is fine here: the checker
// runs on a schedule, one repo at a time — this is a cache, not a ledger. A corrupt cache is rebuilt,
// never trusted. Cache I/O is real fs on purpose (tests redirect SEEN_HOME), so a write failure
// THROWS out of checkBaseHealth instead of pretending the verdict was recorded.
function recordVerdict(repo, verdict) {
  const p = baseHealthPath();
  let all = {};
  try { if (existsSync(p)) all = JSON.parse(readFileSync(p, 'utf8')); } catch { all = {}; }
  if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
  all[repo] = verdict;
  writeFileSync(p, JSON.stringify(all, null, 2));
  return verdict;
}

// Run the base branch's own gate in a temp worktree off origin/<base>; record and return
// { repo, base, green: true|false|null, reason, checkedAt }. Bounded by timeoutMs; a check that
// cannot run records green:null WITH why — it never throws for environmental problems (only for a
// caller bug like an unknown repo name, or a cache that cannot be written).
export async function checkBaseHealth({
  repo = 'tool',
  configObj = config,
  execFn = execFileSync,
  exists = existsSync,
  read = readFileSync,
  mkdtemp = mkdtempSync,
  rm = rmSync,
  symlink = symlinkSync,
  timeoutMs = 10 * 60 * 1000, // the product gate (npm test) is slow; builder.mjs allows the same order
  now = () => new Date(),
} = {}) {
  const { dir, base, envVar } = repoTarget(repo, configObj); // unknown repo throws — a caller bug, not a verdict
  const finish = (green, reason) => recordVerdict(repo, { repo, base, green, reason: clip(reason, 600), checkedAt: now().toISOString() });

  if (!dir || !exists(dir)) {
    return finish(null, `cannot run: the ${repo} checkout ${dir || '(unset)'} does not exist — set ${envVar} to a writable git clone.`);
  }
  const inBundle = /\.app\//i.test(dir); // the five-failure shape: an unset env var resolved into the read-only bundle
  const git = (args, opts = {}) => String(execFn('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000, ...opts }));
  try { git(['rev-parse', '--is-inside-work-tree']); }
  catch (e) {
    return finish(null, `cannot run: ${dir} is not a git checkout${inBundle ? ' (that path is inside the read-only .app bundle)' : ''} — set ${envVar} to a writable git clone${inBundle ? ' outside the app' : ''}. (${clip(e.message, 120)})`);
  }

  // The verdict must be about the REMOTE base — the branch PRs actually merge into — so fetch first.
  // Offline, an already-present origin/<base> ref still yields an honest (if stale) verdict, and the
  // staleness is SAID; with no ref at all there is nothing real to check, and that is null, not a guess.
  let fetched = true;
  try { git(['fetch', 'origin', base], { timeout: 120000 }); }
  catch { fetched = false; }
  if (!fetched) {
    try { git(['rev-parse', '--verify', `origin/${base}`]); }
    catch { return finish(null, `cannot run: could not fetch origin/${base} and no local origin/${base} ref exists — check the network and the remote, then re-run.`); }
  }

  let wt = null;
  try {
    wt = mkdtemp(join(tmpdir(), 'seen-base-health-'));
    git(['worktree', 'add', '--detach', wt, `origin/${base}`]);
  } catch (e) {
    if (wt) { try { rm(wt, { recursive: true, force: true }); } catch { /* best effort */ } }
    return finish(null, `cannot run: could not create a worktree off origin/${base}: ${clip(e.message, 200)}`);
  }
  try {
    // Product gates need dependencies; symlink, never copy (a product node_modules is gigabytes).
    try {
      if (exists(join(dir, 'node_modules')) && !exists(join(wt, 'node_modules'))) symlink(join(dir, 'node_modules'), join(wt, 'node_modules'), 'dir');
    } catch { /* the gate will say so if deps were truly needed */ }
    const verdict = runBaseGate(wt, { base, execFn, exists, read, timeoutMs });
    const staleNote = fetched ? '' : ` (origin/${base} could not be re-fetched — this verdict is from the last fetched state)`;
    return finish(verdict.green, `${verdict.reason}${staleNote}`);
  } finally {
    // Cleanup is best-effort and always runs: a leftover tmpdir must never change a verdict.
    try { git(['worktree', 'remove', '--force', wt]); } catch { /* fall through to rm */ }
    try { rm(wt, { recursive: true, force: true }); } catch { /* ignore */ }
    try { git(['worktree', 'prune']); } catch { /* ignore */ }
  }
}

// The cached verdict for one repo, or an honest "never checked". Callers MUST branch on
// `green === true`: null is unknown and must never render as green — that is the whole contract.
// A smuggled non-boolean `green` in the cache also reads as null, never as a pass.
export function readBaseHealth(repo, { read = readFileSync, exists = existsSync } = {}) {
  const never = (reason) => ({ repo, base: null, green: null, reason, checkedAt: null });
  const p = baseHealthPath();
  if (!exists(p)) return never('never checked');
  let all;
  try { all = JSON.parse(String(read(p, 'utf8'))); }
  catch (e) { return never(`the base-health cache is unreadable (${clip(e.message, 120)}) — re-run checkBaseHealth`); }
  const v = all && typeof all === 'object' ? all[repo] : null;
  if (!v || typeof v !== 'object') return never('never checked');
  const green = v.green === true ? true : v.green === false ? false : null;
  const reason = String(v.reason || '').trim()
    || (green === null ? 'never checked' : green ? 'gate green' : 'recorded red with no reason — re-run checkBaseHealth');
  return { repo, base: v.base ?? null, green, reason, checkedAt: v.checkedAt ?? null };
}

// CLI: node lib/base-health.mjs [tool|product|both] — one manual check, honest output. This is the
// command the Settings fix text points at.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2] || 'both';
  const repos = which === 'both' ? ['tool', 'product'] : [which];
  Promise.all(repos.map((r) => checkBaseHealth({ repo: r })))
    .then(async (v) => {
      console.log(JSON.stringify(v, null, 2));
      // A red base branch is a trackable ticket in the brain; a green one closes it. Unknown (null) is
      // neither — an unverifiable base must not open or close anything.
      try {
        const { ticketSources, flushTicketsToCloud } = await import('./ticket-wire.mjs');
        const { config } = await import('./config.mjs');
        for (const x of v) {
          const repo = x.repo === 'tool' ? config.commandRepo() : config.githubRepo();
          const thing = `base ${x.base || x.repo}`;
          if (x.green === false) ticketSources.reportFrom({ kind: 'test_red', repo, thing, title: `Base branch ${x.base || x.repo} is red`, error: x.reason, ref: x.checkedAt, blocked: false, source: 'lib/base-health.mjs' });
          else if (x.green === true) ticketSources.resolveFrom({ kind: 'test_red', repo, thing, ref: x.checkedAt, how: x.reason });
        }
        await flushTicketsToCloud();
      } catch (e) { console.error(`[base-health] ticket not recorded: ${e.message}`); }
      process.exit(v.some((x) => x.green !== true) ? 1 : 0);
    })
    .catch((e) => { console.error(`[base-health] ${e.message}`); process.exit(1); });
}
