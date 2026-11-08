import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, prStatus, mergePR, parsePrUrl, mergeVerdict } from './pr-merge.mjs';

const config = { commandRepo: () => 'begindtheseen/seen-command', githubRepo: () => 'begindtheseen/Seen' };
const HEAD = 'a'.repeat(40);

// A stub GitHub: routes by URL path (parsed, never by substring), records every call.
function stubGitHub({ pr = {}, runs = [], status = { state: 'success', total_count: 1, statuses: [] }, mergeReply = { merged: true, sha: 'b'.repeat(40) } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.hostname, 'api.github.com');
    calls.push({ method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    const reply = (code, body) => ({ ok: code < 400, status: code, text: async () => JSON.stringify(body) });
    if (/\/pulls\/\d+\/merge$/.test(u.pathname)) return reply(200, mergeReply);
    if (/\/pulls\/\d+$/.test(u.pathname)) return reply(200, { number: 5, title: 'Fix it', html_url: 'https://github.com/begindtheseen/seen-command/pull/5', state: 'open', draft: false,
      base: { ref: 'main' }, head: { ref: 'fix', sha: HEAD }, mergeable: true, mergeable_state: 'clean', user: { login: 'bot' }, ...pr });
    if (/\/check-runs$/.test(u.pathname)) return reply(200, { check_runs: runs });
    if (/\/status$/.test(u.pathname)) return reply(200, status);
    return reply(404, { message: 'Not Found' });
  };
  return { gh: createGitHub({ token: 'test-token', fetchImpl }), calls };
}
const green = [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }];
const target = { repo: 'begindtheseen/seen-command', number: 5, config };

test('merges only a clean PR with every check green, squash, pinned to the reviewed head commit', async () => {
  const { gh, calls } = stubGitHub({ runs: green });
  const st = await prStatus(gh, target);
  assert.equal(st.canMerge, true, st.reasons.join('; ')); assert.equal(st.checks, 'passing');
  const r = await mergePR(gh, { ...target, expectedHeadSha: HEAD });
  assert.equal(r.ok, true); assert.equal(r.merged, true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { merge_method: 'squash', sha: HEAD });
  assert.equal(put.path, '/repos/begindtheseen/seen-command/pulls/5/merge');
  assert.equal(put.auth, 'Bearer test-token');
});

test('refuses when a check is red or still running — and never calls the merge endpoint', async () => {
  for (const runs of [
    [...green, { name: 'e2e', status: 'completed', conclusion: 'failure' }],
    [...green, { name: 'e2e', status: 'in_progress', conclusion: null }],
    [],
  ]) {
    const { gh, calls } = stubGitHub({ runs, status: { state: 'pending', total_count: 0, statuses: [] } });
    const r = await mergePR(gh, { ...target, expectedHeadSha: HEAD });
    assert.equal(r.ok, false); assert.match(r.error, /^Not merging:/);
    assert.equal(calls.some((c) => c.method === 'PUT'), false);
  }
});

test('refuses a PR GitHub does not call mergeable: conflicts, blocked, behind, unstable, still computing, draft', async () => {
  for (const [pr, why] of [
    [{ mergeable: false, mergeable_state: 'dirty' }, /conflicts/],
    [{ mergeable_state: 'blocked' }, /required check or review/],
    [{ mergeable_state: 'behind' }, /behind its base/],
    [{ mergeable_state: 'unstable' }, /a check is failing/],
    [{ mergeable: null, mergeable_state: 'unknown' }, /still working out/],
    [{ draft: true }, /draft/],
    [{ state: 'closed' }, /closed/],
  ]) {
    const { gh, calls } = stubGitHub({ pr, runs: green });
    const r = await mergePR(gh, { ...target, expectedHeadSha: HEAD });
    assert.equal(r.ok, false, JSON.stringify(pr)); assert.match(r.error, why);
    assert.equal(calls.some((c) => c.method === 'PUT'), false);
  }
});

test('refuses a head that moved since review, Seen’s main, and any repo outside the two', async () => {
  let s = stubGitHub({ runs: green });
  let r = await mergePR(s.gh, { ...target, expectedHeadSha: 'c'.repeat(40) });
  assert.equal(r.ok, false); assert.match(r.error, /changed after you looked/);
  r = await mergePR(s.gh, { ...target });
  assert.equal(r.ok, false); assert.match(r.error, /head commit you reviewed is required/);
  s = stubGitHub({ runs: green, pr: { base: { ref: 'main' } } });
  r = await mergePR(s.gh, { repo: 'begindtheseen/Seen', number: 5, config, expectedHeadSha: HEAD });
  assert.equal(r.ok, false); assert.match(r.error, /never merged into/);
  assert.equal(s.calls.some((c) => c.method === 'PUT'), false);
  const v = mergeVerdict({ pr: { state: 'open', mergeable: true, mergeableState: 'clean', base: 'main' }, runs: green, repo: 'someone/else', config });
  assert.equal(v.canMerge, false); assert.match(v.reasons[0], /not one of the repositories/);
  // Into next-migration (how Seen deploys) is allowed when everything is green.
  s = stubGitHub({ runs: green, pr: { base: { ref: 'next-migration' } } });
  assert.equal((await mergePR(s.gh, { repo: 'begindtheseen/Seen', number: 5, config, expectedHeadSha: HEAD })).ok, true);
});

test('a GitHub refusal at merge time is reported, not swallowed', async () => {
  const { gh } = stubGitHub({ runs: green, mergeReply: { merged: false, message: 'Head branch was modified' } });
  const r = await mergePR(gh, { ...target, expectedHeadSha: HEAD });
  assert.equal(r.ok, false); assert.match(r.error, /Head branch was modified/);
  await assert.rejects(() => createGitHub({ token: '' })('/x'), /not connected/);
  assert.deepEqual(parsePrUrl('https://github.com/begindtheseen/Seen/pull/12'), { repo: 'begindtheseen/Seen', number: 12 });
  assert.equal(parsePrUrl('https://evil.example/begindtheseen/Seen/pull/12'), null);
});
