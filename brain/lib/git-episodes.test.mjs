// git→brain narration (brain/lib/git-episodes.mjs).
//
// ⚠ NOTHING HERE TOUCHES THE LIVE BRAIN. Every test injects a fake `git` runner (a function over
// fixture strings — no child process is ever spawned) and a fake `append` (a collector — the real
// writer in lib/brain.mjs is never imported), and points the cursor at a throwaway temp file. The
// module's own default paths (defaultRepos/defaultCursorFile) are never exercised against a real
// checkout or a real vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseMergeSubject, parseLog, collectFromLog, composeEpisode, groupByDay, dayOf,
  sanitizeHeading, collectRepo, appendGitEpisode, planBackfill, resolveTip,
  readCursorFile, writeCursorFile, LOG_FORMAT, MAX_LINES_PER_REPO, prLine, directLine,
} from './git-episodes.mjs';

const FLD = '\x1f';
const REC = '\x1e';

// Build the exact bytes `git log --pretty=format:LOG_FORMAT` emits: records joined by \x1e, and git
// puts a newline between formatted records.
const fakeLog = (commits) => commits
  .map((c) => `${c.sha}${FLD}${c.date}${FLD}${c.subject}${FLD}${c.body || ''}${REC}`)
  .join('\n');

const sha = (n) => String(n).repeat(40).slice(0, 40);

const merge = (n, num, branch, title, date = '2026-07-31T22:00:00-07:00') => ({
  sha: sha(n), date, subject: `Merge pull request #${num} from begindtheseen/${branch}`, body: title,
});

// A fake git runner over a per-repo script: { tip, log } where log is the raw fixture string.
function fakeGit(reposByPath) {
  const calls = [];
  return Object.assign((cwd, args) => {
    calls.push({ cwd, args });
    const r = reposByPath[cwd];
    if (!r) throw new Error(`fatal: not a git repository: ${cwd}`);
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      const ref = args[args.length - 1].replace('^{commit}', '');
      if (r.refs && r.refs[ref]) return `${r.refs[ref]}\n`;
      throw new Error('fatal: Needed a single revision');
    }
    if (args[0] === 'log') {
      if (r.logThrows) throw new Error(`fatal: bad revision '${args[args.length - 1]}'`);
      return r.log || '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  }, { calls });
}

const repoAt = (path, tip, log, { logThrows = false } = {}) => ({
  [path]: { refs: { 'refs/remotes/origin/main': tip, 'refs/heads/main': tip, HEAD: tip }, log, logThrows },
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'git-episodes-'));
  return { dir, cursor: join(dir, 'cursor.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- merge-subject parsing -----------------------------------------------------------------------

test('parseMergeSubject reads the PR number and the branch (branch may contain slashes)', () => {
  const m = parseMergeSubject('Merge pull request #136 from begindtheseen/codex/resume-skip-completed-batches');
  assert.deepEqual(m, { number: 136, owner: 'begindtheseen', branch: 'codex/resume-skip-completed-batches' });
});

test('parseMergeSubject handles odd branch names: dots, slashes, unicode, digits', () => {
  const cases = [
    ['Merge pull request #1 from owner/fix/instagram-gui-path', 1, 'fix/instagram-gui-path'],
    ['Merge pull request #2 from owner/release/v1.2.3', 2, 'release/v1.2.3'],
    ['Merge pull request #3 from owner/feat/ünïcode-brânch', 3, 'feat/ünïcode-brânch'],
    ['Merge pull request #4 from owner/a/b/c/d', 4, 'a/b/c/d'],
    ['Merge pull request #5 from owner/WIP_2026-07-31', 5, 'WIP_2026-07-31'],
  ];
  for (const [subject, num, branch] of cases) {
    const m = parseMergeSubject(subject);
    assert.equal(m.number, num, subject);
    assert.equal(m.branch, branch, subject);
  }
});

test('parseMergeSubject tolerates a fork ref with no owner prefix', () => {
  assert.deepEqual(parseMergeSubject('Merge pull request #9 from patch-1'), { number: 9, owner: '', branch: 'patch-1' });
});

test('parseMergeSubject rejects non-PR subjects (plain merges, squashes, junk)', () => {
  for (const s of ['Merge branch \'main\' into feat/x', 'fix: a thing (#137)', '', null, undefined, 'Merge pull request from owner/b']) {
    assert.equal(parseMergeSubject(s), null, String(s));
  }
});

// --- log parsing ---------------------------------------------------------------------------------

test('parseLog reads sha/date/subject and keeps MULTILINE bodies whole', () => {
  const raw = fakeLog([
    { sha: sha(1), date: '2026-07-31T22:38:13-07:00', subject: 'Merge pull request #136 from begindtheseen/codex/x', body: 'Resume knowledge at the first incomplete batch\n\nLonger body\nwith newlines' },
    { sha: sha(2), date: '2026-07-31T19:40:23-07:00', subject: 'Merge pull request #128 from begindtheseen/feat/y', body: 'feat: compiler' },
  ]);
  const recs = parseLog(raw);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].sha, sha(1));
  assert.equal(recs[0].date, '2026-07-31T22:38:13-07:00');
  assert.match(recs[0].body, /^Resume knowledge at the first incomplete batch/);
  assert.match(recs[0].body, /with newlines$/);
  assert.equal(recs[1].subject, 'Merge pull request #128 from begindtheseen/feat/y');
});

test('parseLog returns [] for empty output and drops malformed records', () => {
  assert.deepEqual(parseLog(''), []);
  assert.deepEqual(parseLog(null), []);
  assert.deepEqual(parseLog(`not-a-sha${FLD}d${FLD}s${FLD}b${REC}`), []);
});

test('parseLog survives a body containing the record separator-ish text and pipes/quotes', () => {
  const recs = parseLog(fakeLog([{ sha: sha(3), date: '2026-07-31T10:00:00-07:00', subject: 'Merge pull request #7 from o/b', body: 'a | b "c" \'d\' \\e\\' }]));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].body, 'a | b "c" \'d\' \\e\\');
});

// --- collection ----------------------------------------------------------------------------------

test('collectFromLog splits merged PRs from direct commits and titles PRs from the merge body', () => {
  const recs = parseLog(fakeLog([
    merge(1, 136, 'codex/resume-skip-completed-batches', 'Resume knowledge at the first incomplete batch'),
    { sha: sha(2), date: '2026-07-31T21:00:00-07:00', subject: 'hotfix: bump timeout', body: '' },
    merge(3, 128, 'feat/instagram-compiler', 'feat(instagram): Creator Intelligence Compiler'),
  ]));
  const { prs, direct } = collectFromLog(recs);
  assert.equal(prs.length, 2);
  assert.equal(direct.length, 1);
  assert.equal(prLine(prs[0]), '#136 — Resume knowledge at the first incomplete batch (codex/resume-skip-completed-batches)');
  assert.equal(directLine(direct[0]), 'direct: hotfix: bump timeout');
});

test('a merge commit with an EMPTY body falls back to the branch, without repeating it', () => {
  const { prs } = collectFromLog(parseLog(fakeLog([merge(1, 55, 'fix/no-title', '')])));
  assert.equal(prLine(prs[0]), '#55 — fix/no-title'); // real history: #122 and #124 merged with no body
});

// --- heading safety ------------------------------------------------------------------------------

test('sanitizeHeading strips regex metacharacters (the vendored writer interpolates it into a RegExp)', () => {
  const h = sanitizeHeading('Dev log — 3 PR(s) merged (seen-command + seen) [x] {y} ^$.|?*\\');
  for (const bad of ['(', ')', '[', ']', '{', '}', '+', '*', '?', '^', '$', '|', '\\', '.', '#']) {
    assert.ok(!h.includes(bad), `heading still contains ${bad}: ${h}`);
  }
  assert.doesNotThrow(() => new RegExp(`^##\\s+${h}\\s*$`, 'm'));
});

test('composeEpisode headings are regex-safe and stable for identical content', () => {
  const results = [{ name: 'seen-command', prs: [{ number: 1, branch: 'b', title: 't' }], direct: [], from: sha(9), to: sha(1) }];
  const a = composeEpisode(results);
  const b = composeEpisode(JSON.parse(JSON.stringify(results)));
  assert.equal(a.heading, b.heading);
  assert.equal(a.text, b.text);
  assert.doesNotThrow(() => new RegExp(`^##\\s+${a.heading}\\s*$`, 'm'));
});

// --- episode composition -------------------------------------------------------------------------

test('composeEpisode returns null when nothing merged — an empty episode is never written', () => {
  assert.equal(composeEpisode([]), null);
  assert.equal(composeEpisode([{ name: 'seen-command', prs: [], direct: [], from: sha(1), to: sha(1) }]), null);
});

test('composeEpisode writes one line per PR and carries the range key inside the text', () => {
  const ep = composeEpisode([{
    name: 'seen-command',
    prs: [{ number: 136, branch: 'codex/resume-skip-completed-batches', title: 'Resume knowledge at the first incomplete batch' },
      { number: 128, branch: 'feat/instagram-compiler', title: 'Creator Intelligence Compiler' }],
    direct: [{ subject: 'hotfix: bump timeout' }],
    from: sha(9), to: sha(1),
  }]);
  assert.match(ep.heading, /^Dev log — 2 PRs merged, 1 direct commit in seen-command$/);
  const lines = ep.text.split('\n');
  assert.equal(lines.length, 4); // summary + 3
  assert.equal(lines[1], '  - #136 — Resume knowledge at the first incomplete batch (codex/resume-skip-completed-batches)');
  assert.equal(lines[3], '  - direct: hotfix: bump timeout');
  assert.ok(ep.key, 'a key must be produced');
  assert.ok(ep.text.includes(ep.key), 'the vendored writer dedupes with content.includes(key) — the key MUST be in the text');
  assert.equal(ep.prs, 2);
  assert.equal(ep.direct, 1);
});

test('composeEpisode labels each line per repo when BOTH repos contributed', () => {
  const ep = composeEpisode([
    { name: 'seen-command', prs: [{ number: 1, branch: 'a', title: 'A' }], direct: [], from: sha(9), to: sha(1) },
    { name: 'seen', prs: [{ number: 200, branch: 'b', title: 'B' }], direct: [], from: sha(8), to: sha(2) },
  ]);
  assert.match(ep.heading, /2 PRs merged in seen-command and seen/);
  assert.ok(ep.text.includes('  - [seen-command] #1 — A (a)'));
  assert.ok(ep.text.includes('  - [seen] #200 — B (b)'));
  assert.deepEqual(ep.repos, ['seen-command', 'seen']);
});

test('a repo with nothing merged is dropped from the episode entirely', () => {
  const ep = composeEpisode([
    { name: 'seen-command', prs: [{ number: 1, branch: 'a', title: 'A' }], direct: [], from: sha(9), to: sha(1) },
    { name: 'seen', prs: [], direct: [], from: sha(8), to: sha(8) },
  ]);
  assert.deepEqual(ep.repos, ['seen-command']);
  assert.ok(!ep.text.includes('[seen]'), 'no per-repo tags when only one repo contributed');
});

test('composeEpisode caps lines per repo and says how many were left out', () => {
  const prs = Array.from({ length: 25 }, (_, i) => ({ number: i + 1, branch: `b${i}`, title: `T${i}` }));
  const ep = composeEpisode([{ name: 'seen-command', prs, direct: [], from: sha(9), to: sha(1) }]);
  const bullets = ep.text.split('\n').slice(1);
  assert.equal(bullets.length, MAX_LINES_PER_REPO + 1, 'capped lines plus one overflow note');
  assert.match(bullets[bullets.length - 1], /…and 5 more in seen-command \(capped at 20\)/);
  assert.match(ep.heading, /25 PRs merged/, 'the heading still reports the TRUE total');
});

test('the cap applies PER REPO, not to the episode as a whole', () => {
  const mk = (n, o) => Array.from({ length: n }, (_, i) => ({ number: o + i, branch: `b${i}`, title: `T${i}` }));
  const ep = composeEpisode([
    { name: 'seen-command', prs: mk(25, 100), direct: [], from: sha(9), to: sha(1) },
    { name: 'seen', prs: mk(25, 200), direct: [], from: sha(8), to: sha(2) },
  ]);
  const bullets = ep.text.split('\n').slice(1);
  assert.equal(bullets.length, (MAX_LINES_PER_REPO + 1) * 2);
});

test('episode text never contains a markdown heading line (the cloud mirror splits on /^## +/m)', () => {
  const ep = composeEpisode([{
    name: 'seen-command',
    prs: [{ number: 1, branch: 'b', title: '## not a heading\n### nor this' }],
    direct: [{ subject: '# neither' }],
    from: sha(9), to: sha(1),
  }]);
  for (const line of ep.text.split('\n')) assert.ok(!/^#{1,6}\s/.test(line), `line opens a section: ${line}`);
  assert.ok(!/^## /m.test(ep.text), 'the cloud mirror would split this episode in two');
});

test('a PR number keeps its hash — the heading guard must not eat "#136"', () => {
  const ep = composeEpisode([{ name: 'r', prs: [{ number: 136, branch: 'b', title: 'T' }], direct: [], from: sha(9), to: sha(1) }]);
  assert.ok(ep.text.includes('#136 — T (b)'), ep.text);
});

test('composeEpisode truncates a runaway episode instead of writing an unbounded body', () => {
  const prs = Array.from({ length: 200 }, (_, i) => ({ number: i, branch: 'b'.repeat(60), title: 'T'.repeat(120) }));
  const ep = composeEpisode([{ name: 'r', prs, direct: [], from: sha(9), to: sha(1) }], { cap: 200, maxChars: 1000 });
  assert.ok(ep.text.length <= 1000, `episode was ${ep.text.length} chars`);
  assert.match(ep.text, /episode truncated at \d+ of 200 lines/);
});

// --- per-day grouping ----------------------------------------------------------------------------

test('dayOf uses the COMMITTER\'s local day, so a 22:38 PDT merge stays on that night', () => {
  assert.equal(dayOf('2026-07-31T22:38:13-07:00'), '2026-07-31'); // 2026-08-01T05:38Z — NOT the next day
  assert.equal(dayOf('nonsense'), null);
});

test('groupByDay buckets records per calendar day, oldest day first', () => {
  const recs = parseLog(fakeLog([
    merge(1, 136, 'a', 'A', '2026-07-31T22:38:13-07:00'),
    merge(2, 128, 'b', 'B', '2026-07-31T19:40:23-07:00'),
    merge(3, 122, 'c', 'C', '2026-07-29T08:53:11-07:00'),
  ]));
  const days = groupByDay(recs);
  assert.deepEqual(days.map((d) => d.day), ['2026-07-29', '2026-07-31']);
  assert.equal(days[1].records.length, 2, "last night's burst groups into ONE day");
});

// --- cursor file ---------------------------------------------------------------------------------

test('readCursorFile returns an empty cursor for a missing OR corrupt file (never throws)', () => {
  const t = tmp();
  try {
    assert.deepEqual(readCursorFile(t.cursor), { version: 1, repos: {} });
    writeFileSync(t.cursor, '{not json');
    assert.deepEqual(readCursorFile(t.cursor), { version: 1, repos: {} });
    writeFileSync(t.cursor, '{"repos": "nope"}');
    assert.deepEqual(readCursorFile(t.cursor), { version: 1, repos: {} });
  } finally { t.cleanup(); }
});

test('writeCursorFile round-trips and creates the directory', () => {
  const t = tmp();
  try {
    const nested = join(t.dir, 'a', 'b', 'cursor.json');
    writeCursorFile(nested, { repos: { r: { sha: sha(1) } } });
    assert.equal(readCursorFile(nested).repos.r.sha, sha(1));
  } finally { t.cleanup(); }
});

// --- collectRepo ---------------------------------------------------------------------------------

test('collectRepo skips a path that does not exist and one that is not a git checkout', () => {
  const t = tmp();
  try {
    const git = fakeGit({});
    const gone = collectRepo({ name: 'seen', path: join(t.dir, 'nope') }, { git });
    assert.equal(gone.skipped, true);
    assert.match(gone.reason, /path not found/);

    const notRepo = collectRepo({ name: 'seen', path: t.dir }, { git });
    assert.equal(notRepo.skipped, true);
    assert.match(notRepo.reason, /not a git checkout/);
  } finally { t.cleanup(); }
});

test('collectRepo with NO cursor initialises at the tip and lists nothing', () => {
  const t = tmp();
  try {
    const git = fakeGit(repoAt(t.dir, sha(1), fakeLog([merge(2, 1, 'a', 'A')])));
    const r = collectRepo({ name: 'seen-command', path: t.dir, branch: 'main' }, { git, from: null });
    assert.equal(r.initialize, true);
    assert.equal(r.head, sha(1));
    assert.deepEqual(r.prs, []);
    assert.ok(!git.calls.some((c) => c.args[0] === 'log'), 'first sight must not read the log at all');
  } finally { t.cleanup(); }
});

test('resolveTip prefers origin/<branch>, then the local branch, then HEAD', () => {
  const t = tmp();
  try {
    const all = { [t.dir]: { refs: { 'refs/remotes/origin/main': sha(1), 'refs/heads/main': sha(2), HEAD: sha(3) } } };
    assert.deepEqual(resolveTip(fakeGit(all), t.dir, 'main'), { ref: 'refs/remotes/origin/main', sha: sha(1) });

    const local = { [t.dir]: { refs: { 'refs/heads/main': sha(2), HEAD: sha(3) } } };
    assert.equal(resolveTip(fakeGit(local), t.dir, 'main').sha, sha(2));

    const detached = { [t.dir]: { refs: { HEAD: sha(3) } } };
    assert.equal(resolveTip(fakeGit(detached), t.dir, 'main').sha, sha(3), 'a checkout on a feature branch still resolves');

    assert.equal(resolveTip(fakeGit({}), t.dir, 'main'), null);
  } finally { t.cleanup(); }
});

test('a STALE cursor (sha no longer in history) re-initialises instead of dumping history', () => {
  const t = tmp();
  try {
    const git = fakeGit(repoAt(t.dir, sha(1), '', { logThrows: true }));
    const r = collectRepo({ name: 'seen-command', path: t.dir, branch: 'main' }, { git, from: 'deadbee' });
    assert.equal(r.initialize, true);
    assert.equal(r.head, sha(1));
    assert.match(r.reason, /not in history — re-initialised/);
    assert.deepEqual(r.prs, []);
  } finally { t.cleanup(); }
});

// --- appendGitEpisode: cursor semantics -----------------------------------------------------------

function harness(commits, { tip = sha(1), name = 'seen-command' } = {}) {
  const t = tmp();
  const git = fakeGit(repoAt(t.dir, tip, fakeLog(commits)));
  const writes = [];
  const append = (a) => { writes.push(a); return { recorded: true, note: `timeline/${a.date}.md` }; };
  return { t, git, writes, append, repos: [{ name, path: t.dir, branch: 'main' }], cursor: t.cursor };
}

test('FIRST run initialises the cursor at HEAD and writes NO episode', () => {
  const h = harness([merge(2, 136, 'a', 'A'), merge(3, 135, 'b', 'B')]);
  try {
    const r = appendGitEpisode({ append: h.append, repos: h.repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r.wrote, false);
    assert.deepEqual(r.initialized, ['seen-command']);
    assert.equal(h.writes.length, 0, 'never dump history on the first run');
    assert.equal(readCursorFile(h.cursor).repos['seen-command'].sha, sha(1));
  } finally { h.t.cleanup(); }
});

test('SECOND run narrates the new merges and advances the cursor to the tip', () => {
  const h = harness([merge(2, 136, 'codex/x', 'Resume knowledge'), merge(3, 135, 'codex/y', 'Fix login env')]);
  try {
    writeCursorFile(h.cursor, { repos: { 'seen-command': { sha: sha(9) } } });
    const r = appendGitEpisode({ append: h.append, date: '2026-08-01', repos: h.repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r.wrote, true);
    assert.equal(r.prs, 2);
    assert.equal(h.writes.length, 1, 'ONE episode per run, not one per PR');
    assert.equal(h.writes[0].date, '2026-08-01');
    assert.match(h.writes[0].text, /#136 — Resume knowledge \(codex\/x\)/);
    assert.match(h.writes[0].text, /#135 — Fix login env \(codex\/y\)/);
    assert.equal(readCursorFile(h.cursor).repos['seen-command'].sha, sha(1));
  } finally { h.t.cleanup(); }
});

test('a run with nothing merged writes NO episode and leaves the cursor at the tip', () => {
  const h = harness([]);
  try {
    writeCursorFile(h.cursor, { repos: { 'seen-command': { sha: sha(9) } } });
    const r = appendGitEpisode({ append: h.append, repos: h.repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r.wrote, false);
    assert.match(r.reason, /nothing merged/);
    assert.equal(h.writes.length, 0);
    assert.equal(readCursorFile(h.cursor).repos['seen-command'].sha, sha(1));
  } finally { h.t.cleanup(); }
});

test('append FAILURE (writer returns null) leaves the cursor so the next run retries the same range', () => {
  const h = harness([merge(2, 136, 'a', 'A')]);
  try {
    writeCursorFile(h.cursor, { repos: { 'seen-command': { sha: sha(9) } } });
    const r = appendGitEpisode({ append: () => null, repos: h.repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r.wrote, false);
    assert.equal(r.retry, true);
    assert.equal(readCursorFile(h.cursor).repos['seen-command'].sha, sha(9), 'cursor must NOT advance on a failed append');

    // the retry succeeds and narrates the identical range
    const r2 = appendGitEpisode({ append: h.append, repos: h.repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r2.wrote, true);
    assert.equal(h.writes.length, 1);
    assert.match(h.writes[0].text, /#136/);
    assert.equal(readCursorFile(h.cursor).repos['seen-command'].sha, sha(1));
  } finally { h.t.cleanup(); }
});

test('append THROWING is caught, reported, and also holds the cursor', () => {
  const h = harness([merge(2, 136, 'a', 'A')]);
  try {
    writeCursorFile(h.cursor, { repos: { 'seen-command': { sha: sha(9) } } });
    const r = appendGitEpisode({ append: () => { throw new Error('vault is read-only'); }, repos: h.repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r.wrote, false);
    assert.equal(r.retry, true);
    assert.match(r.error, /vault is read-only/);
    assert.equal(readCursorFile(h.cursor).repos['seen-command'].sha, sha(9));
  } finally { h.t.cleanup(); }
});

test('a missing second repo is skipped with a note; the present repo is still narrated', () => {
  const h = harness([merge(2, 136, 'a', 'A')]);
  try {
    writeCursorFile(h.cursor, { repos: { 'seen-command': { sha: sha(9) } } });
    const repos = [...h.repos, { name: 'seen', path: join(h.t.dir, 'missing'), branch: 'next-migration' }];
    const r = appendGitEpisode({ append: h.append, repos, cursorFile: h.cursor, git: h.git, log: () => {} });
    assert.equal(r.wrote, true);
    assert.deepEqual(r.repos, ['seen-command']);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'seen');
    assert.match(r.skipped[0].reason, /path not found/);
    assert.equal(readCursorFile(h.cursor).repos.seen, undefined, 'a skipped repo gets no cursor entry');
  } finally { h.t.cleanup(); }
});

test('two repos are narrated together in ONE episode and both cursors advance', () => {
  const a = tmp();
  const b = tmp();
  try {
    const git = fakeGit({
      ...repoAt(a.dir, sha(1), fakeLog([merge(2, 136, 'x', 'X')])),
      ...repoAt(b.dir, sha(3), fakeLog([merge(4, 200, 'y', 'Y')])),
    });
    const cursor = join(a.dir, 'cursor.json');
    writeCursorFile(cursor, { repos: { 'seen-command': { sha: sha(9) }, seen: { sha: sha(8) } } });
    const writes = [];
    const r = appendGitEpisode({
      append: (x) => { writes.push(x); return { recorded: true, note: 'timeline/x.md' }; },
      repos: [{ name: 'seen-command', path: a.dir, branch: 'main' }, { name: 'seen', path: b.dir, branch: 'main' }],
      cursorFile: cursor, git, log: () => {},
    });
    assert.equal(r.wrote, true);
    assert.equal(writes.length, 1, 'ONE episode covering both repos');
    assert.match(writes[0].text, /\[seen-command\] #136/);
    assert.match(writes[0].text, /\[seen\] #200/);
    const c = readCursorFile(cursor).repos;
    assert.equal(c['seen-command'].sha, sha(1));
    assert.equal(c.seen.sha, sha(3));
  } finally { a.cleanup(); b.cleanup(); }
});

test('appendGitEpisode demands an append function rather than writing anywhere itself', () => {
  assert.throws(() => appendGitEpisode({}), /`append` is required/);
});

test('the cursor keeps a per-repo entry, so repos advance independently', () => {
  const a = tmp();
  const b = tmp();
  try {
    // repo A has new work, repo B has none
    const git = fakeGit({
      ...repoAt(a.dir, sha(1), fakeLog([merge(2, 136, 'x', 'X')])),
      ...repoAt(b.dir, sha(3), ''),
    });
    const cursor = join(a.dir, 'cursor.json');
    writeCursorFile(cursor, { repos: { 'seen-command': { sha: sha(9) }, seen: { sha: sha(8) } } });
    const r = appendGitEpisode({
      append: () => ({ recorded: true, note: 'n' }),
      repos: [{ name: 'seen-command', path: a.dir, branch: 'main' }, { name: 'seen', path: b.dir, branch: 'main' }],
      cursorFile: cursor, git, log: () => {},
    });
    assert.deepEqual(r.repos, ['seen-command']);
    const c = readCursorFile(cursor).repos;
    assert.equal(c['seen-command'].sha, sha(1));
    assert.equal(c.seen.sha, sha(3), 'a quiet repo still advances to its tip');
  } finally { a.cleanup(); b.cleanup(); }
});

// --- backfill ------------------------------------------------------------------------------------

test('planBackfill groups the last N days into ONE episode per calendar day', () => {
  const t = tmp();
  try {
    const git = fakeGit(repoAt(t.dir, sha(1), fakeLog([
      merge(1, 136, 'codex/resume', 'Resume knowledge', '2026-07-31T22:38:13-07:00'),
      merge(2, 135, 'codex/login', 'Fix login env', '2026-07-31T22:33:53-07:00'),
      merge(3, 128, 'feat/compiler', 'Creator Intelligence Compiler', '2026-07-31T19:40:23-07:00'),
      merge(4, 122, 'claude/brain', 'Brain integrity fixes', '2026-07-29T08:53:11-07:00'),
    ])));
    const plan = planBackfill({ days: 7, repos: [{ name: 'seen-command', path: t.dir, branch: 'main' }], git, log: () => {} });
    assert.equal(plan.episodes.length, 2);
    assert.deepEqual(plan.episodes.map((e) => e.date), ['2026-07-29', '2026-07-31']);
    const night = plan.episodes[1];
    assert.equal(night.prs, 3, "last night's burst lands as one dated episode");
    assert.match(night.heading, /3 PRs merged in seen-command/);
    assert.match(night.text, /#136 — Resume knowledge/);
    assert.match(night.text, /#128 — Creator Intelligence Compiler/);
    assert.ok(!night.text.includes('#122'), 'a different day must not leak into this episode');
  } finally { t.cleanup(); }
});

test('planBackfill writes nothing itself and reports skipped repos', () => {
  const t = tmp();
  try {
    const git = fakeGit(repoAt(t.dir, sha(1), ''));
    const plan = planBackfill({
      days: 7,
      repos: [{ name: 'seen-command', path: t.dir, branch: 'main' }, { name: 'seen', path: join(t.dir, 'nope'), branch: 'main' }],
      git, log: () => {},
    });
    assert.deepEqual(plan.episodes, []);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].name, 'seen');
    assert.equal(plan.heads[0].sha, sha(1), 'heads are reported so the caller can park the cursor after a successful apply');
  } finally { t.cleanup(); }
});

test('planBackfill merges BOTH repos into the same per-day episode', () => {
  const a = tmp();
  const b = tmp();
  try {
    const git = fakeGit({
      ...repoAt(a.dir, sha(1), fakeLog([merge(1, 136, 'x', 'X', '2026-07-31T22:00:00-07:00')])),
      ...repoAt(b.dir, sha(2), fakeLog([merge(2, 200, 'y', 'Y', '2026-07-31T21:00:00-07:00')])),
    });
    const plan = planBackfill({
      days: 7,
      repos: [{ name: 'seen-command', path: a.dir, branch: 'main' }, { name: 'seen', path: b.dir, branch: 'main' }],
      git, log: () => {},
    });
    assert.equal(plan.episodes.length, 1);
    assert.equal(plan.episodes[0].date, '2026-07-31');
    assert.match(plan.episodes[0].text, /\[seen-command\] #136/);
    assert.match(plan.episodes[0].text, /\[seen\] #200/);
  } finally { a.cleanup(); b.cleanup(); }
});

test('backfill episodes are byte-identical across two plans — the unique (date,heading,body) dedupe holds', () => {
  const t = tmp();
  try {
    const log = fakeLog([merge(1, 136, 'x', 'X', '2026-07-31T22:00:00-07:00')]);
    const repos = [{ name: 'seen-command', path: t.dir, branch: 'main' }];
    const one = planBackfill({ days: 7, repos, git: fakeGit(repoAt(t.dir, sha(1), log)), log: () => {} });
    const two = planBackfill({ days: 7, repos, git: fakeGit(repoAt(t.dir, sha(1), log)), log: () => {} });
    assert.equal(one.episodes[0].date, two.episodes[0].date);
    assert.equal(one.episodes[0].heading, two.episodes[0].heading);
    assert.equal(one.episodes[0].text, two.episodes[0].text);
  } finally { t.cleanup(); }
});

// --- the real vault writer is never reachable from here ------------------------------------------

test('the module cannot reach the vault or the cloud except through the injected append', () => {
  const src = readFileSync(new URL('./git-episodes.mjs', import.meta.url), 'utf8');
  const imports = src.split('\n').filter((l) => /^import\s/.test(l));
  for (const forbidden of ['memory-write.mjs', 'cloud.mjs', 'vault.mjs', 'brain.mjs']) {
    assert.ok(!imports.some((l) => l.includes(forbidden)), `git-episodes.mjs statically imports ${forbidden} — episodes must go through the injected writer`);
  }
});

test('this suite never wrote the real cursor file in the repo', () => {
  assert.ok(!existsSync(new URL('../../data/brain-git-cursor.json', import.meta.url)), 'a test wrote the live cursor');
});
