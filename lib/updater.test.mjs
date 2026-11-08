// Run: node --test lib/updater.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateVerdict, commitsBetween, createUpdater } from './updater.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
test('verdict: up to date / available with what is new / blocked by local changes / offline', () => {
  assert.equal(updateVerdict({ originMain: A, apps: { seenCommand: { sha: A, behind: 0 } }, checkout: {} }).state, 'up-to-date');
  const v = updateVerdict({ originMain: B, apps: { seenCommand: { sha: A, behind: 3 } }, checkout: { dirty: [] } }, [{ sha: B, subject: 'x' }]);
  assert.equal(v.state, 'available'); assert.equal(v.behind, 3); assert.equal(v.commits.length, 1);
  assert.match(updateVerdict({ originMain: B, apps: { seenCommand: { sha: A, behind: 1 } }, checkout: { dir: '/r', dirty: ['engine/x.mjs'] } }).reason, /uncommitted code changes \(engine\/x\.mjs\)/);
  assert.equal(updateVerdict({ originMain: null, apps: {} }).state, 'unknown');
  assert.equal(updateVerdict({ originMain: B, apps: { seenCommand: null }, checkout: {} }).state, 'available', 'an unstamped copy can always update');
});

test('commits between two versions come from git log, newest first', () => {
  let args = null;
  const out = commitsBetween(A, B, { repoDir: '/r', execFn: (bin, a) => { args = a; return `${B}\t2026-10-21T09:00:00-07:00\tJobs tab\n${A.slice(0, 39)}c\t2026-10-21T08:00:00-07:00\tSearch: titles\tand tabs\n`; } });
  assert.deepEqual(out.map((c) => c.subject), ['Jobs tab', 'Search: titles\tand tabs']);
  assert.ok(args.includes(`${A}..${B}`) && args.includes('--no-merges'));
  assert.deepEqual(commitsBetween(A, B, { execFn: () => { throw new Error('no git'); } }), []);
});

test('updater: notifies once per new version; install starts the tested self-update detached', async () => {
  const notes = []; const spawned = [];
  const u = createUpdater({ repoDir: () => '/r', report: () => ({ originMain: B, apps: { seenCommand: { sha: A, behind: 2 } }, checkout: { dirty: [] } }), execFn: () => `${B}\t2026-10-21T09:00:00-07:00\tA change\n`,
    notify: (n) => notes.push(n), spawn: (bin, args, opts) => { spawned.push({ bin, args, opts }); return { unref() {} }; }, builds: () => [], stampPath: '/nope' });
  const v = await u.check(); await u.check();
  assert.equal(v.state, 'available');
  assert.equal(notes.filter((n) => n.kind === 'update').length <= 1, true, 'one notification per version');
  const r = u.apply();
  assert.equal(r.started, true);
  assert.deepEqual(spawned[0].args, ['engine/self-update.mjs', '--no-merge']);
  assert.equal(spawned[0].opts.detached, true);
  const busy = createUpdater({ builds: () => [{ kind: 'self-update', status: 'building', startedAt: '2026-10-21T16:00:00Z', log: ['[self-update] gate…'] }], spawn: () => { throw new Error('must not start twice'); }, stampPath: '/nope' });
  assert.equal(busy.apply().already, true);
  assert.deepEqual(busy.progress().log, ['[self-update] gate…']);
});
