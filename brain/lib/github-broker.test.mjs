import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFileUpdatePR } from './github-broker.mjs';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test('broker creates only a codex branch and draft PR without returning the GitHub token', async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ url: String(url), method: init.method || 'GET', body, headers: init.headers });
    if (String(url).includes('/git/ref/heads/')) return response({ object: { sha: 'base-sha' } });
    if (String(url).includes('/contents/') && (init.method || 'GET') === 'GET') return response({ message: 'not found' }, 404);
    if (String(url).endsWith('/pulls')) return response({ number: 42, html_url: 'https://github.com/o/r/pull/42' }, 201);
    return response({}, 201);
  };
  const out = await openFileUpdatePR({ repo: 'o/r', base: 'main', path: 'src/a.js', content: 'export const a = 1;\n', title: 'Update A', client: 'codex' }, {
    token: 'test-token-never-returned', fetch, allowedRepos: new Set(['o/r']),
  });
  assert.match(out.head, /^codex\/chronos-codex-/); assert.equal(out.draft, true);
  assert.equal(JSON.stringify(out).includes('test-token'), false);
  assert.equal(calls.find((c) => c.url.endsWith('/pulls')).body.draft, true);
  assert.equal(calls.some((c) => c.method === 'PUT' && /git\/refs\/heads\/(main|master)$/.test(c.url)), false);
});

test('broker denies unallowlisted repos, protected paths, secret-like content, and oversized content', async () => {
  const deps = { token: 'x', fetch: async () => response({}), allowedRepos: new Set(['o/r']) };
  await assert.rejects(() => openFileUpdatePR({ repo: 'evil/r', base: 'main', path: 'a', content: 'x', title: 'x' }, deps), /not allowlisted/);
  await assert.rejects(() => openFileUpdatePR({ repo: 'o/r', base: 'main', path: '.github/workflows/pwn.yml', content: 'x', title: 'x' }, deps), /protected/);
  await assert.rejects(() => openFileUpdatePR({ repo: 'o/r', base: 'main', path: 'x.txt', content: '-----BEGIN PRIVATE KEY-----', title: 'x' }, deps), /credential-like/);
  await assert.rejects(() => openFileUpdatePR({ repo: 'o/r', base: 'main', path: 'x.txt', content: 'x'.repeat(1024 * 1024 + 1), title: 'x' }, deps), /exceeds/);
});
