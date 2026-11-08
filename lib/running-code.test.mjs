import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningCode, isRunning } from './running-code.mjs';
import { buildStamp } from '../scripts/stamp-build.mjs';

// A fake git: origin/main = O, with ancestry  A → B → O.
function fakeGit({ head = 'O', branch = 'main', status = '', ancestors = { A: ['A'], B: ['A', 'B'], O: ['A', 'B', 'O'] } } = {}) {
  const resolve = (r) => (r === 'origin/main' ? 'O' : r === 'HEAD' ? head : r);
  return (_bin, a) => {
    if (a[0] === 'fetch') return '';
    if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return `${branch}\n`;
    if (a[0] === 'rev-parse') return `${resolve(a[1])}\n`;
    if (a[0] === 'status') return status;
    if (a[0] === 'rev-list') { const [from, to] = a[2].split('..').map(resolve); return `${(ancestors[to] || []).filter((c) => !(ancestors[from] || []).includes(c)).length}\n`; }
    if (a[0] === 'merge-base') { if ((ancestors[resolve(a[3])] || []).includes(resolve(a[2]))) return ''; const e = new Error('not ancestor'); e.status = 1; throw e; }
    return '';
  };
}
const stamps = { seenCommand: '/sc.json' };
const retired = { '/old/Chronos.app': 'Chronos.app is retired but is still installed' };
const files = (m) => ({ existsFn: (p) => p in m, readFn: (p) => JSON.stringify(m[p]) });

test('in sync: checkout at origin/main, clean, the app built from it', () => {
  const r = runningCode({ repoDir: '/r', execFn: fakeGit(), stamps, retired, ...files({ '/sc.json': { sha: 'O', dirty: [] } }) });
  assert.equal(r.inSync, true);
  assert.deepEqual(r.problems, []);
});

test('every way the four can disagree is named in a sentence a human can act on', () => {
  const r = runningCode({ repoDir: '/r', stamps,
    execFn: fakeGit({ head: 'A', branch: 'feat/x', status: ' M public/command-center.html\n M engine/run.mjs\n?? memory/note.md\n' }),
    ...files({ '/sc.json': { sha: 'B', dirty: ['engine/x.mjs'] } }) });
  assert.equal(r.inSync, false);
  assert.deepEqual(r.checkout.dirty, ['engine/run.mjs'], 'the generated dashboard and the vault are not code — and the FIRST porcelain line keeps its first letter');
  const all = r.problems.join('\n');
  assert.match(all, /2 commit\(s\) behind origin\/main/);
  assert.match(all, /is on `feat\/x`, not main/);
  assert.match(all, /1 uncommitted code file\(s\) \(engine\/run\.mjs\)/);
  assert.match(all, /Seen Command\.app was built from UNCOMMITTED code/);
  assert.match(all, /Seen Command\.app runs B, 1 commit\(s\) behind/);
  assert.doesNotMatch(all, /Chronos/, 'Chronos.app is retired — it has no stamp to compare');
});

test('a retired app still installed is named, with how to remove it', () => {
  const r = runningCode({ repoDir: '/r', execFn: fakeGit(), stamps, retired, ...files({ '/sc.json': { sha: 'O', dirty: [] }, '/old/Chronos.app': {} }) });
  assert.equal(r.inSync, false);
  assert.deepEqual(r.problems, ['Chronos.app is retired but is still installed']);
});

test('isRunning answers true / false / null — null when it cannot tell, never a guess', () => {
  const rep = (sha, dirty = []) => ({ checkout: { dir: '/r' }, apps: { seenCommand: sha ? { sha, dirty } : null } });
  const execFn = fakeGit();
  assert.equal(isRunning('B', rep('O'), 'seenCommand', { execFn }), true, 'the app runs a DESCENDANT of the merge commit');
  assert.equal(isRunning('O', rep('B'), 'seenCommand', { execFn }), false, 'the app is older than the merge commit');
  assert.equal(isRunning('O', rep(null), 'seenCommand', { execFn }), null);
  assert.equal(isRunning('O', rep('O', ['x.mjs']), 'seenCommand', { execFn }), false);
});

test('the build stamp records the commit AND whether the build matched it', () => {
  const s = buildStamp('/r', { now: () => new Date('2026-09-18T00:00:00Z'), execFn: (_b, a) => (a[0] === 'status' ? ' M engine/run.mjs\n M public/command-center.html\n?? build-info.json\n' : a[1] === '--abbrev-ref' ? 'main\n' : 'abc123\n') });
  assert.equal(s.sha, 'abc123');
  assert.deepEqual(s.dirty, ['engine/run.mjs']);
  assert.equal(s.builtAt, '2026-09-18T00:00:00.000Z');
});

test('ahead checkout reports a problem', () => {
  const r = runningCode({ repoDir: '/r', stamps,
    execFn: fakeGit({ head: 'C', branch: 'main', status: '', ancestors: { A: ['A'], B: ['A', 'B'], O: ['A', 'B', 'O'], C: ['A', 'B', 'O', 'C'] } }),
    ...files({ '/sc.json': { sha: 'O', dirty: [] } }) });
  assert.equal(r.inSync, false);
  const all = r.problems.join('\n');
  assert.match(all, /1 commit\(s\) ahead of origin\/main/);
});
