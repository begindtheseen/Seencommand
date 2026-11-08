#!/usr/bin/env node
// git-episodes — narrate the WORK into the brain: one dated "Dev log" episode per board meeting,
// listing the PRs merged since the previous meeting.
//
// THE GAP THIS CLOSES. The board meeting records live KPIs as bi-temporal facts (users, MRR, jobs,
// errors) and one "Board meeting <runId>" episode. It records nothing about what was BUILT. On
// 2026-07-31 twelve PRs (#123–#131, #134–#136) merged on the Mac and left ZERO trace in the vault —
// a later session reading the brain sees numbers move with no explanation, and every "what did we
// ship?" question has to re-derive the answer from GitHub. Git is the only honest record of the
// work; this module reads it and writes the narrative back.
//
// SHAPE. Pure parsing/composition (parseLog, parseMergeSubject, collectFromLog, composeEpisode,
// groupByDay) is separated from I/O so it is unit-testable with fixture strings. The I/O is exactly
// three things, all injectable:
//   1. `git log` through a runner (default: execFileSync) — READ-ONLY, no fetch, no network;
//   2. a tiny JSON cursor under the writable data/ dir;
//   3. the append itself, which is INJECTED — engine/run.mjs passes lib/brain.mjs's recordDevLog, so
//      every episode goes through the SAME one-writer dispatch (shared seen writer → vendored
//      fallback) as the board-meeting episode. This module never touches the vault or Supabase.
//
// SAFETY. A board meeting must never fail because narration failed: appendGitEpisode() catches per
// repo and never throws for I/O reasons, and the caller wraps it again. The cursor advances ONLY
// after a successful append, so a failed write is retried next run rather than silently lost.
//
// CLI (one-time catch-up, run from the repo on the Mac):
//   node brain/lib/git-episodes.mjs                       # dry-run of what the next meeting writes
//   node brain/lib/git-episodes.mjs --apply               # write that episode now
//   node brain/lib/git-episodes.mjs --backfill-days=7     # dry-run: one episode per calendar day
//   node brain/lib/git-episodes.mjs --backfill-days=7 --apply
//   node brain/lib/git-episodes.mjs --backfill-days=7 --apply --force-from 7027589

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../lib/config.mjs';
import { dataDir } from '../../lib/paths.mjs';

// ---- limits -------------------------------------------------------------------------------------
export const CURSOR_FILE = 'brain-git-cursor.json';
export const MAX_LINES_PER_REPO = 20;    // per the spec: cap each repo's list, then say how many more
export const MAX_LINE = 160;             // one PR line
export const MAX_SUMMARY = 300;          // the first line (carries the idempotency key — see below)
export const MAX_HEADING = 120;
export const MAX_EPISODE_CHARS = 4000;   // defensive ceiling on the whole episode body
export const MAX_COMMITS = 300;          // bound the log read; overflow is reported, never dropped silently
const GIT_TIMEOUT_MS = 20000;

// ---- git log record format ----------------------------------------------------------------------
// ASCII record/field separators: a commit BODY is free text and routinely contains newlines, pipes
// and quotes, so any printable delimiter is ambiguous. \x1e/\x1f cannot appear in a git subject and
// will not appear in a body written by a human or by GitHub.
const REC = '\x1e';
const FLD = '\x1f';
export const LOG_FORMAT = `%H${FLD}%cI${FLD}%s${FLD}%b${REC}`;

// ---- small helpers ------------------------------------------------------------------------------
export const short = (sha) => String(sha || '').slice(0, 7);
export const todayISO = () => new Date().toISOString().slice(0, 10);
const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim()) || '';
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};
// A body line must never open a markdown section: the cloud mirror splits day-notes on /^## +/m
// (brain/lib/cloud.mjs timelineSections) and Obsidian renders '#' as a heading — a stray '#' would
// split ONE episode into two rows under a bogus heading. clip() has already collapsed newlines, so
// only the START of a line can do this. The pattern is the ATX-heading one — `#` FOLLOWED BY SPACE —
// precisely so a PR number ('#136 — …') keeps its hash.
const safeLine = (s, n = MAX_LINE) => clip(s, n).replace(/^#{1,6}\s+/, '');

// The vendored writer interpolates the heading straight into a RegExp (brain/lib/memory-write.mjs
// appendTimeline: `new RegExp('^##\\s+' + heading + '\\s*$', 'm')`). A heading carrying regex
// metacharacters would fail to match its own existing section — or, if unbalanced, throw. So the
// heading is restricted to a metacharacter-free charset. It stays deterministic for the same
// content, which is what makes brain_timeline's unique (date, heading, body) a real backstop.
export function sanitizeHeading(s) {
  return clip(String(s ?? '').replace(/[\\^$.|?*+()[\]{}#\n\r]+/g, ' '), MAX_HEADING);
}

// ---- pure parsing -------------------------------------------------------------------------------

// GitHub's merge-commit subject. The ref after "from" is `<owner>/<branch>` and the BRANCH may itself
// contain slashes (codex/resume-skip-completed-batches), so only the FIRST slash separates the owner.
const MERGE_RE = /^Merge pull request #(\d+) from (\S+)/;

export function parseMergeSubject(subject) {
  const m = MERGE_RE.exec(String(subject ?? '').trim());
  if (!m) return null;
  const ref = m[2];
  const slash = ref.indexOf('/');
  return {
    number: Number(m[1]),
    owner: slash === -1 ? '' : ref.slice(0, slash),
    branch: slash === -1 ? ref : ref.slice(slash + 1),
  };
}

// Parse `git log --pretty=format:LOG_FORMAT` output into records. Bodies are multiline by design.
export function parseLog(raw) {
  const out = [];
  for (const rec of String(raw ?? '').split(REC)) {
    // git joins formatted records with a newline; it belongs to the separator, not to the sha.
    const r = rec.replace(/^[\r\n]+/, '');
    if (!r.trim()) continue;
    const parts = r.split(FLD);
    const sha = (parts[0] || '').trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue; // never trust half-read output
    out.push({
      sha,
      date: (parts[1] || '').trim(),
      subject: (parts[2] || '').trim(),
      body: parts.slice(3).join(FLD).trim(), // a body containing FLD would be pathological; keep it whole
    });
  }
  return out;
}

// Split records into merged PRs and direct-to-branch commits.
// NOTE on squash merges: GitHub's squash strategy produces a NON-merge commit (`Title (#137)`), which
// git cannot distinguish from a hand-pushed commit. Those are reported as `direct: Title (#137)` —
// honest (it IS a single commit on the branch) and the PR number survives in the text. This repo
// merges with merge commits, so the PR path is the one that fires in practice.
export function collectFromLog(records) {
  const prs = [];
  const direct = [];
  for (const r of records || []) {
    const m = parseMergeSubject(r.subject);
    if (m) {
      // GitHub puts the PR TITLE in the merge commit body; fall back to the branch when it is empty.
      prs.push({ number: m.number, branch: m.branch, title: firstLine(r.body) || m.branch, sha: r.sha, date: r.date });
    } else {
      direct.push({ subject: r.subject, sha: r.sha, date: r.date });
    }
  }
  return { prs, direct };
}

// `#136 — <PR title> (<branch>)`. When the merge body was empty the title already fell back to the
// branch, so the branch is not repeated — real history has several of these (#122, #124).
export const prLine = (pr) => `#${pr.number} — ${pr.title}${pr.title === pr.branch ? '' : ` (${pr.branch})`}`;
export const directLine = (c) => `direct: ${c.subject}`;

// The calendar day a commit landed, in the COMMITTER's own timezone (%cI carries the offset). Using
// the local day is deliberate: a 22:38 PDT merge belongs to that night's work, not to the next UTC day.
export const dayOf = (iso) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? ''));
  return m ? m[1] : null;
};

// Group records by calendar day, oldest day first. Used by the backfill so a burst of merges on one
// night lands as ONE dated episode.
export function groupByDay(records) {
  const days = new Map();
  for (const r of records || []) {
    const day = dayOf(r.date);
    if (!day) continue;
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(r);
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, recs]) => ({ day, records: recs }));
}

// Compose ONE episode from per-repo results. `null` when nothing merged anywhere — an empty episode
// is never written. Each result: { name, prs, direct, from, to }.
export function composeEpisode(repoResults, { cap = MAX_LINES_PER_REPO, maxChars = MAX_EPISODE_CHARS } = {}) {
  const active = (repoResults || []).filter((r) => r && ((r.prs?.length || 0) + (r.direct?.length || 0)) > 0);
  if (!active.length) return null;

  const totalPrs = active.reduce((n, r) => n + r.prs.length, 0);
  const totalDirect = active.reduce((n, r) => n + r.direct.length, 0);
  const multi = active.length > 1;

  const lines = [];
  for (const r of active) {
    const tag = multi ? `[${r.name}] ` : ''; // clearly labelled per repo whenever both contributed
    const all = [...r.prs.map(prLine), ...r.direct.map(directLine)];
    for (const l of all.slice(0, cap)) lines.push(`  - ${tag}${safeLine(l)}`);
    if (all.length > cap) lines.push(`  - ${tag}…and ${all.length - cap} more in ${r.name} (capped at ${cap})`);
  }

  const counts = [];
  if (totalPrs) counts.push(`${totalPrs} PR${totalPrs === 1 ? '' : 's'} merged`);
  if (totalDirect) counts.push(`${totalDirect} direct commit${totalDirect === 1 ? '' : 's'}`);
  const names = active.map((r) => r.name);
  const where = multi ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const heading = sanitizeHeading(`Dev log — ${counts.join(', ')} in ${where}`);

  // The range string doubles as the idempotency key: the vendored writer's `key` check is
  // `content.includes(key)`, so the key MUST be present in the text — it lives in the summary line.
  const ranges = active.map((r) => `${r.name} ${short(r.from) || 'root'}..${short(r.to)}`).join(' · ');
  const summary = safeLine(`${counts.join(', ')} — ${ranges}`, MAX_SUMMARY);

  let body = [summary, ...lines].join('\n');
  if (body.length > maxChars) {
    const kept = [];
    let n = summary.length;
    for (const l of lines) {
      if (n + 1 + l.length > maxChars - 60) break;
      kept.push(l);
      n += 1 + l.length;
    }
    kept.push(`  - …episode truncated at ${kept.length} of ${lines.length} lines`);
    body = [summary, ...kept].join('\n');
  }

  // Only claim key-idempotency if the key really survived into the text (clipping could drop it).
  const key = body.includes(ranges) ? ranges : null;
  return { heading, text: body, key, prs: totalPrs, direct: totalDirect, repos: names, ranges };
}

// ---- cursor -------------------------------------------------------------------------------------
// One small JSON file: the last commit each repo was narrated up to. Runtime state, gitignored.

export const defaultCursorFile = () => join(dataDir(), CURSOR_FILE);

export function readCursorFile(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && j.repos && typeof j.repos === 'object') return { version: 1, repos: { ...j.repos } };
  } catch { /* missing or corrupt → start clean; a bad cursor must never crash the meeting */ }
  return { version: 1, repos: {} };
}

export function writeCursorFile(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, repos: state.repos || {} }, null, 2)}\n`);
}

// ---- git I/O ------------------------------------------------------------------------------------

// A read-only git runner. GIT_OPTIONAL_LOCKS=0 keeps this observer from touching the index while the
// owner is working in the same checkout; GIT_TERMINAL_PROMPT=0 guarantees it can never block on input.
export function makeGit(exec = execFileSync) {
  return (cwd, args) => String(exec('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }) || '');
}

// Which commit is "the tip we narrate"? The owner's checkout may be sitting on a feature branch, so
// HEAD alone would narrate the wrong line of history. Prefer the repo's configured default branch —
// origin's copy first (what actually merged on GitHub, as of the last fetch), then the local branch,
// then HEAD. We never fetch: this narrates what the local checkout already knows.
export function resolveTip(git, path, branch) {
  const refs = [];
  if (branch) refs.push(`refs/remotes/origin/${branch}`, `refs/heads/${branch}`);
  refs.push('HEAD');
  for (const ref of refs) {
    try {
      const sha = git(path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return { ref, sha };
    } catch { /* ref does not exist here — try the next one */ }
  }
  return null;
}

// Read one repo. Returns a result object; NEVER throws for I/O reasons.
//   { skipped:true, reason }                          — no path / not a git repo / no commits
//   { initialize:true, head }                         — first sight of this repo (or a stale cursor)
//   { head, from, to, prs, direct, records, overflow } — commits to narrate
export function collectRepo(repo, { git, from = null, sinceDays = null, maxCount = MAX_COMMITS } = {}) {
  const name = repo?.name || basename(repo?.path || '') || 'repo';
  const path = repo?.path;
  if (!path) return { name, path: null, skipped: true, reason: 'no path configured' };
  if (!existsSync(path)) return { name, path, skipped: true, reason: 'path not found' };

  const tip = resolveTip(git, path, repo?.branch);
  if (!tip) return { name, path, skipped: true, reason: 'not a git checkout (or no commits)' };

  // First sight of this repo: adopt the tip and write NOTHING. Never dump the whole history.
  if (!from && !sinceDays) return { name, path, head: tip.sha, ref: tip.ref, initialize: true, prs: [], direct: [] };

  const args = ['log', '--first-parent', '--no-color', `--max-count=${maxCount}`, `--pretty=format:${LOG_FORMAT}`];
  if (from) args.push(`${from}..${tip.sha}`);
  else args.push(`--since=${sinceDays} days ago`, tip.sha);

  let raw;
  try {
    raw = git(path, args);
  } catch (e) {
    // The commonest cause is a cursor sha that is no longer in this history (rebase, re-clone,
    // force-push). Re-adopt the tip and write nothing rather than re-narrating everything.
    return {
      name, path, head: tip.sha, ref: tip.ref, initialize: true, prs: [], direct: [],
      reason: from ? `cursor ${short(from)} not in history — re-initialised` : `git log failed: ${firstLine(e?.message)}`,
    };
  }

  const records = parseLog(raw);
  const { prs, direct } = collectFromLog(records);
  return {
    name, path, head: tip.sha, ref: tip.ref, records, prs, direct,
    from: from || (records.length ? records[records.length - 1].sha : null),
    to: tip.sha,
    overflow: records.length >= maxCount,
  };
}

// The repos this machine narrates. Both come from the EXISTING checkout resolution
// (lib/config.mjs commandRepoDir/productRepoDir) so there is exactly one scheme in the codebase;
// SEEN_REPO_PATH is the documented explicit override for the product repo.
export function defaultRepos() {
  const out = [];
  const seen = new Set();
  const add = (p, branch) => {
    if (!p) return;
    const abs = resolve(p);
    if (seen.has(abs)) return; // both getters can resolve to the same dir on an odd layout
    seen.add(abs);
    out.push({ name: basename(abs) || 'repo', path: abs, branch });
  };
  try { add(config.commandRepoDir(), config.commandBranch()); } catch { /* unresolvable → skip */ }
  try { add((process.env.SEEN_REPO_PATH || '').trim() || config.productRepoDir(), config.githubBranch()); } catch { /* skip */ }
  return out;
}

const defaultLog = (m) => process.stderr.write(`[git-episodes] ${m}\n`);

function persistCursor(file, state, advances, log) {
  if (!advances.length) return;
  const next = { version: 1, repos: { ...(state.repos || {}) } };
  const at = new Date().toISOString();
  for (const a of advances) next.repos[a.name] = { sha: a.sha, path: a.path, updatedAt: at };
  try { writeCursorFile(file, next); }
  catch (e) { log(`cursor not persisted (${e.message}) — the next run may re-narrate this range (deduped by key + unique(date,heading,body))`); }
}

// ---- the per-run hook ---------------------------------------------------------------------------
// Called once per board meeting. `append` is REQUIRED and must return a falsy value on failure —
// lib/brain.mjs recordDevLog returns null — because that is how we decide NOT to advance the cursor.
export function appendGitEpisode({
  append,
  date = todayISO(),
  repos = null,
  cursorFile = null,
  git = makeGit(),
  cap = MAX_LINES_PER_REPO,
  log = defaultLog,
} = {}) {
  if (typeof append !== 'function') throw new Error('appendGitEpisode: `append` is required');
  const file = cursorFile || defaultCursorFile();
  const list = repos || defaultRepos();
  const state = readCursorFile(file);

  const results = [];
  const skipped = [];
  const initialized = [];
  const advances = [];

  for (const repo of list) {
    const prev = state.repos?.[repo?.name]?.sha || null;
    const r = collectRepo(repo, { git, from: prev, cap });
    if (r.skipped) { skipped.push({ name: r.name, reason: r.reason }); log(`${r.name}: skipped — ${r.reason}`); continue; }
    advances.push({ name: r.name, path: r.path, sha: r.head });
    if (r.initialize) {
      initialized.push(r.name);
      log(`${r.name}: cursor set to ${short(r.head)}${r.reason ? ` (${r.reason})` : ''} — no episode on first sight`);
      continue;
    }
    if (r.overflow) log(`${r.name}: more than ${MAX_COMMITS} commits since the last run — narrating the newest ${MAX_COMMITS}`);
    results.push(r);
  }

  const episode = composeEpisode(results, { cap });
  if (!episode) {
    persistCursor(file, state, advances, log); // first-run initialisation must persist
    return { wrote: false, reason: 'nothing merged since the last run', skipped, initialized };
  }

  let out = null;
  let error = null;
  try { out = append({ date, heading: episode.heading, text: episode.text, key: episode.key }); }
  catch (e) { error = e?.message || String(e); }

  if (!out) {
    // Cursor deliberately left where it was: the next run retries this exact range.
    log(`append failed (${error || 'writer returned null'}) — cursor unchanged, retrying next run`);
    return { wrote: false, retry: true, error: error || 'writer returned null', heading: episode.heading, skipped, initialized };
  }

  persistCursor(file, state, advances, log);
  return {
    wrote: true,
    heading: episode.heading,
    prs: episode.prs,
    direct: episode.direct,
    repos: episode.repos,
    note: out?.note || null,
    skipped,
    initialized,
  };
}

// ---- one-time catch-up --------------------------------------------------------------------------
// Plan the last N days as ONE episode per calendar day, per the union of both repos. Pure w.r.t. the
// brain: it returns the plan; the caller decides whether to write.
export function planBackfill({ days = 7, repos = null, git = makeGit(), cap = MAX_LINES_PER_REPO, from = null, log = defaultLog } = {}) {
  const list = repos || defaultRepos();
  const byDay = new Map(); // day → [{ name, prs, direct, from, to }]
  const skipped = [];
  const heads = [];

  for (const repo of list) {
    const r = collectRepo(repo, { git, from, sinceDays: from ? null : days });
    if (r.skipped) { skipped.push({ name: r.name, reason: r.reason }); log(`${r.name}: skipped — ${r.reason}`); continue; }
    heads.push({ name: r.name, path: r.path, sha: r.head });
    if (r.initialize || !r.records?.length) continue;
    for (const { day, records } of groupByDay(r.records)) {
      const { prs, direct } = collectFromLog(records);
      const shas = records.map((x) => x.sha);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ name: r.name, prs, direct, from: shas[shas.length - 1], to: shas[0] });
    }
  }

  const episodes = [];
  for (const [day, perRepo] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ep = composeEpisode(perRepo, { cap });
    if (ep) episodes.push({ date: day, ...ep });
  }
  return { episodes, skipped, heads };
}

// ---- CLI ----------------------------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valueOf = (flag) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };

  const apply = has('--apply');
  const backfillDays = valueOf('--backfill-days');
  const forceFrom = valueOf('--force-from');
  const file = defaultCursorFile();

  // Exactly what lands in the day-note: the writer emits `- <first line>` and keeps the rest as-is.
  const preview = (ep) => {
    const [first, ...rest] = ep.text.split('\n');
    return [`## ${ep.heading}`, `- ${first}`, ...rest].join('\n');
  };

  // The writer is imported LAZILY: a dry run must not load .env, resolve the shared seen writer, or
  // touch the vault. Nothing here writes until --apply.
  const loadWriter = async () => (await import('../../lib/brain.mjs')).recordDevLog;

  if (backfillDays) {
    const days = Math.max(1, Math.min(365, Number(backfillDays) || 7));
    const state = readCursorFile(file);
    const tracked = Object.keys(state.repos || {});
    if (tracked.length && !forceFrom) {
      console.error(`Cursor already initialised for ${tracked.join(', ')} — those days may already be narrated.`);
      console.error('Re-run with --force-from <sha|days> to backfill anyway (duplicates are absorbed by the key + unique(date,heading,body)).');
      process.exit(2);
    }
    // --force-from takes a sha OR a day count; a number means "this many days" and overrides --backfill-days.
    const numeric = forceFrom && /^\d+$/.test(forceFrom);
    const plan = planBackfill({
      days: numeric ? Number(forceFrom) : days,
      from: forceFrom && !numeric ? forceFrom : null,
    });
    if (!plan.episodes.length) {
      console.log(`Nothing to backfill in the last ${days} day(s).`);
      if (plan.skipped.length) for (const s of plan.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);
      process.exit(0);
    }
    console.log(`${apply ? 'Writing' : 'DRY RUN —'} ${plan.episodes.length} episode(s):\n`);
    for (const ep of plan.episodes) console.log(`── ${ep.date} ──\n${preview(ep)}\n`);
    if (!apply) { console.log('Nothing was written. Re-run with --apply to write these to the brain.'); process.exit(0); }

    const recordDevLog = await loadWriter();
    let ok = 0;
    for (const ep of plan.episodes) {
      const r = recordDevLog({ date: ep.date, heading: ep.heading, text: ep.text, key: ep.key });
      if (r) { ok += 1; console.log(`wrote ${ep.date} → ${r.note}${r.skipped ? ' (already present)' : ''}`); }
      else console.error(`FAILED ${ep.date} — left unwritten`);
    }
    if (ok === plan.episodes.length && plan.heads.length) {
      // Everything landed: park the cursor at each tip so the next board meeting starts from here
      // instead of re-narrating the days we just wrote.
      persistCursor(file, readCursorFile(file), plan.heads, defaultLog);
      console.log(`Cursor parked at ${plan.heads.map((h) => `${h.name} ${short(h.sha)}`).join(', ')} → ${file}`);
    }
    process.exit(ok === plan.episodes.length ? 0 : 1);
  }

  // Default: the same thing the board meeting does — dry-run unless --apply.
  if (!apply) {
    const state = readCursorFile(file);
    const results = [];
    for (const repo of defaultRepos()) {
      const r = collectRepo(repo, { git: makeGit(), from: state.repos?.[repo.name]?.sha || null });
      if (r.skipped) { console.log(`skipped ${r.name}: ${r.reason}`); continue; }
      if (r.initialize) { console.log(`${r.name}: first sight — would set the cursor to ${short(r.head)} and write nothing`); continue; }
      results.push(r);
    }
    const ep = composeEpisode(results);
    console.log(ep ? `DRY RUN — would write:\n${preview(ep)}` : 'DRY RUN — nothing merged since the last run; no episode.');
    console.log(`\nCursor: ${file}`);
    process.exit(0);
  }

  const recordDevLog = await loadWriter();
  const r = appendGitEpisode({ append: recordDevLog, log: (m) => console.log(`[git-episodes] ${m}`) });
  console.log(r.wrote ? `Wrote: ${r.heading} → ${r.note || 'vault'}` : `No episode: ${r.reason || r.error || 'nothing to narrate'}`);
  process.exit(r.wrote || !r.retry ? 0 : 1);
}
