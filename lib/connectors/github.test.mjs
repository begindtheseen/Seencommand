import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';
process.env.SEEN_GITHUB_REPO = 'begindtheseen/seen';
const github = await import('./github.mjs');

const realFetch = globalThis.fetch;
function mock(routes) {
  globalThis.fetch = async (url) => {
    for (const [frag, body] of routes) if (String(url).includes(frag)) return { ok: true, status: 200, json: async () => body, text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
}
const restore = () => { globalThis.fetch = realFetch; };

test('openPRs maps the REST shape to our fields', async () => {
  mock([['/pulls', [{ number: 42, title: 'Fix funnel', user: { login: 'brandon' }, draft: false, base: { ref: 'next-migration' }, head: { ref: 'fix', sha: 'abc123' }, html_url: 'u', updated_at: 't' }]]]);
  const prs = await github.openPRs();
  restore();
  assert.equal(prs.length, 1);
  assert.deepEqual({ n: prs[0].number, t: prs[0].title, a: prs[0].author, b: prs[0].base }, { n: 42, t: 'Fix funnel', a: 'brandon', b: 'next-migration' });
});

test('ciStatus classifies check-runs (a failing run → failing)', async () => {
  mock([['/check-runs', { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure' }] }]]);
  const ci = await github.ciStatus('deadbeef');
  restore();
  assert.equal(ci.state, 'failing');
});

test('prInfo surfaces the mergeability shape the post-create status check reads', async () => {
  mock([['/pulls/188', {
    number: 188, state: 'open', merged_at: null, draft: false,
    head: { ref: 'exec/build-x', sha: 'abc123' },
    mergeable: false, mergeable_state: 'dirty', html_url: 'u',
  }]]);
  const info = await github.prInfo({ repo: 'begindtheseen/seen', number: 188 });
  restore();
  // state + merged drive reconcile; mergeable + mergeableState drive derivePrStatus.
  assert.deepEqual(
    { state: info.state, merged: info.merged, mergeable: info.mergeable, mergeableState: info.mergeableState },
    { state: 'open', merged: false, mergeable: false, mergeableState: 'dirty' },
  );
  assert.equal(info.headSha, 'abc123'); // the head sha the preview verdict keys on
});

test('prInfo maps a merged PR (merged_at present → merged:true) and a clean mergeable_state', async () => {
  mock([['/pulls/42', {
    number: 42, state: 'closed', merged_at: '2026-07-18T00:00:00Z',
    head: { ref: 'x', sha: 's' }, mergeable: true, mergeable_state: 'clean', html_url: 'u',
  }]]);
  const info = await github.prInfo({ repo: 'begindtheseen/seen', number: 42 });
  restore();
  assert.equal(info.merged, true);
  assert.equal(info.mergeableState, 'clean');
});

test('issueInfo does a DIRECT per-issue GET (not the eventually-consistent list) and maps the fields', async () => {
  let hit = '';
  globalThis.fetch = async (url) => {
    hit = String(url);
    return { ok: true, status: 200, text: async () => '', json: async () => ({
      number: 104, title: '[platform] Fix the thing', body: 'do the thing', state: 'open',
      labels: [{ name: 'auto-build' }, { name: 'bug' }], user: { login: 'brandon' }, html_url: 'u',
      created_at: '2026-08-04T01:00:00Z', updated_at: '2026-08-04T02:00:00Z', closed_at: null,
    }) };
  };
  const info = await github.issueInfo('begindtheseen/seen-command', 104);
  restore();
  // The crux of the #104 fix: a direct /issues/{n} GET (read-your-writes consistent), NEVER /issues?state=…
  // — the list lags a just-created task by seconds and 404'd it. See brain decision 2026-07-18.
  assert.ok(hit.includes('/repos/begindtheseen/seen-command/issues/104'), 'hits the per-issue endpoint');
  assert.ok(!/\/issues\?/.test(hit) && !hit.includes('state='), 'is not the list endpoint');
  // Field mapping mirrors issuesFor (labels flattened to names), plus state — so the build handler's
  // downstream title/body/taskShape reads are identical whether the issue came from the list or here.
  assert.deepEqual(info, { number: 104, title: '[platform] Fix the thing', body: 'do the thing', state: 'open', labels: ['auto-build', 'bug'],
    url: 'u', createdAt: '2026-08-04T01:00:00Z', updatedAt: '2026-08-04T02:00:00Z', closedAt: null });
});

test('issueInfo returns null on a 404 (missing/errored) so the build handler can 404 honestly', async () => {
  mock([]); // no route registered → every fetch is a 404
  const info = await github.issueInfo('begindtheseen/seen-command', 999999);
  restore();
  assert.equal(info, null);
});

test('issueStateFor still projects to open|closed|null (refactored onto issueInfo, contract unchanged)', async () => {
  mock([['/issues/104', { number: 104, state: 'closed', title: 't', body: '', labels: [] }]]);
  assert.equal(await github.issueStateFor('begindtheseen/seen-command', 104), 'closed');
  restore();
  mock([['/issues/105', { number: 105, state: 'open', title: 't', body: '', labels: [] }]]);
  assert.equal(await github.issueStateFor('begindtheseen/seen-command', 105), 'open');
  restore();
  mock([]); // fetch error → fail open (null), the builder's guard depends on this
  assert.equal(await github.issueStateFor('begindtheseen/seen-command', 106), null);
  restore();
});

test('snapshot throws when auth fails (does not masquerade as 0 PRs)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'Bad credentials' });
  await assert.rejects(() => github.snapshot(), /401/);
  restore();
});

test('executeClosePRIn comments on the issue endpoint, then PATCHes /pulls state=closed', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  await github.executeClosePRIn({ repo: 'begindtheseen/seen', number: 194, comment: 'preview build FAILED — withdrawing' });
  restore();
  const comment = calls.find((c) => c.url.includes('/repos/begindtheseen/seen/issues/194/comments'));
  const close = calls.find((c) => c.url.includes('/repos/begindtheseen/seen/pulls/194') && !c.url.includes('/comments'));
  assert.ok(comment, 'posts a comment first');
  assert.equal(comment.method, 'POST');
  assert.equal(comment.body.body, 'preview build FAILED — withdrawing');
  assert.ok(close, 'closes via the pulls endpoint');
  assert.equal(close.method, 'PATCH');
  assert.equal(close.body.state, 'closed');
});

test('executeClosePRIn still closes the PR when the comment POST fails', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.includes('/comments')) return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  await github.executeClosePRIn({ repo: 'begindtheseen/seen', number: 7, comment: 'x' });
  restore();
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('/pulls/7')), 'close proceeds despite comment failure');
});
