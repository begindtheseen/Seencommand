import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// sweepCompletion writes one activity line per state change, and logActivity is module-level (not
// injectable). Redirect the WHOLE ledger at a temp dir before importing, or this suite writes into the
// real one — it did: seven `proof … https://github.com/o/r/pull/7` lines sat in Brandon's live activity
// feed from this file's fixtures (2026-09-19/21).
process.env.SEEN_COMMAND_REPO_DIR = mkdtempSync(join(tmpdir(), 'completion-ledger-'));
const { conditionsFor, initialProof, proofState, observeBuild, sweepCompletion, proofSummary } = await import('./completion.mjs');

const pr = (over = {}) => async () => ({ number: 7, headSha: 'abc1234def', merged: false, mergeSha: null, ...over });
const checks = (state, runs = [{ name: 'test', conclusion: state === 'failing' ? 'failure' : 'success', status: 'completed' }]) => async () => ({ state, sha: 'abc1234', runs });
const schemaOk = async () => ({ checked: 2, live: 8, missing: [] });
const running = (sha, dirty = []) => () => ({ checkout: { dir: '/nowhere' }, apps: { seenCommand: sha ? { sha, dirty } : null } });
const at = () => new Date('2026-09-18T12:00:00Z');
// ancestry is git's business (covered in running-code.test.mjs); here the app either runs the merge commit or it does not
const sameSha = (sha, rep) => { const a = rep.apps.seenCommand; return !a || !a.sha ? null : (a.dirty.length ? false : a.sha === sha); };
const build = (over = {}) => ({ id: 'b1', repo: 'tool', kind: 'behaviour', status: 'pr_ready', pr: 'https://github.com/o/r/pull/7', ...over });

test('the conditions come from the repo and the contract kind — never from the coder', () => {
  assert.deepEqual(conditionsFor({ repo: 'tool', kind: 'behaviour' }), ['ci', 'schema', 'running']);
  assert.deepEqual(conditionsFor({ repo: 'product', kind: 'ui' }), ['ci', 'schema', 'preview', 'ui']);
  assert.equal(initialProof({ repo: 'product', kind: 'ui' }).conditions.find((c) => c.id === 'ui').status, 'manual', 'a rendered screen is never INFERRED');
});

test('an opened PR is AWAITING, not done: CI running, not merged, nothing claimed', async () => {
  const p = await observeBuild(build(), { prInfoFn: pr(), checkRunsFn: checks('running'), schemaFn: schemaOk, runningFn: running(null), now: at });
  assert.equal(p.state, 'awaiting');
  assert.deepEqual(p.conditions.map((c) => [c.id, c.status]), [['ci', 'pending'], ['schema', 'observed'], ['running', 'pending']]);
  assert.match(proofSummary(p), /^AWAITING — 1\/3 observed · open: ci: checks still running \| running: not merged yet/);
});

test('merged is still not done until the INSTALLED app is running the merge commit', async () => {
  const merged = pr({ merged: true, mergeSha: 'feedface00' });
  const stale = await observeBuild(build({ status: 'merged' }), { prInfoFn: merged, checkRunsFn: checks('passing'), schemaFn: schemaOk, runningFn: running('0000aaaa'), isRunningFn: sameSha, now: at });
  assert.equal(stale.state, 'awaiting');
  assert.match(stale.conditions.find((c) => c.id === 'running').evidence, /merged as feedface, but the installed app is still running older code/);
  const noStamp = await observeBuild(build({ status: 'merged' }), { prInfoFn: merged, checkRunsFn: checks('passing'), schemaFn: schemaOk, runningFn: running(null), isRunningFn: sameSha, now: at });
  assert.match(noStamp.conditions.find((c) => c.id === 'running').evidence, /no readable build stamp/, 'cannot tell ≠ running');
  const live = await observeBuild(build({ status: 'merged' }), { prInfoFn: merged, checkRunsFn: checks('passing'), schemaFn: schemaOk, runningFn: running('feedface00'), isRunningFn: sameSha, now: at });
  assert.equal(live.state, 'proven');
  const dirtyApp = await observeBuild(build({ status: 'merged' }), { prInfoFn: merged, checkRunsFn: checks('passing'), schemaFn: schemaOk, runningFn: running('feedface00', ['engine/x.mjs']), isRunningFn: sameSha, now: at });
  assert.equal(dirtyApp.state, 'awaiting', 'an app built from uncommitted code matches no commit');
});

test('a merged-but-unapplied migration FAILS the proof by name — the 2026-09-18 outage, caught on day one', async () => {
  const p = await observeBuild(build({ repo: 'product', preview: { state: 'READY', url: 'https://p.vercel.app' } }), {
    prInfoFn: pr(), checkRunsFn: checks('passing'), now: at,
    schemaFn: async () => ({ checked: 2, live: 7, missing: [{ fn: 'brain_replace_note', files: ['seen/lib/server/brainStore.js'] }] }) });
  assert.equal(p.state, 'failed');
  assert.match(p.conditions.find((c) => c.id === 'schema').evidence, /MISSING brain_replace_note — a migration is merged but not applied/);
});

test('"could not check" is PENDING with the reason — never observed, never failed', async () => {
  const p = await observeBuild(build(), { prInfoFn: pr(), checkRunsFn: async () => { throw new Error('GitHub 502'); }, schemaFn: async () => { throw new Error('no Supabase URL / service key configured'); }, runningFn: running(null), now: at });
  assert.equal(p.state, 'awaiting');
  assert.match(p.conditions.find((c) => c.id === 'ci').evidence, /not checked: GitHub 502/);
  assert.match(p.conditions.find((c) => c.id === 'schema').evidence, /not checked: no Supabase URL/);
});

test('a failure can recover, an observation is final, and a UI change ends at needs-human', async () => {
  const failed = await observeBuild(build({ repo: 'product', kind: 'ui', preview: { state: 'READY' } }), { prInfoFn: pr(), checkRunsFn: checks('failing'), schemaFn: schemaOk, now: at });
  assert.equal(failed.state, 'failed');
  let ciCalls = 0;
  const recovered = await observeBuild(build({ repo: 'product', kind: 'ui', preview: { state: 'READY' }, proof: failed }), { prInfoFn: pr(), checkRunsFn: async (a) => { ciCalls++; return checks('passing')(a); }, schemaFn: async () => { throw new Error('schema must not be re-asked once observed'); }, now: at });
  assert.equal(ciCalls, 1);
  assert.equal(recovered.state, 'needs-human', 'everything a machine can see is seen; the screen still needs eyes');
  assert.equal(proofState([{ status: 'observed' }, { status: 'manual' }]), 'needs-human');
});

test('the sweep re-observes only builds still waiting, records transitions, and leaves proven ones alone', async () => {
  const written = []; const logged = [];
  const builds = [build({ id: 'wait' }), build({ id: 'done', proof: { state: 'proven', conditions: [] } }), build({ id: 'nopr', pr: null }), build({ id: 'failed-build', status: 'failed' })];
  const r = await sweepCompletion({ builds, write: (id, patch) => written.push([id, patch.proof.state]), log: (m) => logged.push(m),
    deps: { prInfoFn: pr(), checkRunsFn: checks('running'), schemaFn: schemaOk, runningFn: running(null), now: at } });
  assert.deepEqual(written, [['wait', 'awaiting']]);
  assert.equal(r.checked, 1);
  assert.match(logged[0], /^wait: AWAITING/);
});
