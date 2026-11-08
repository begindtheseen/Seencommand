import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEnvText, parseEnvEntries, ownedKeys } from './env-merge.js';

// The exact regression this exists for: SEEN_PRODUCT_REPO_DIR shipped in an app update (2026-07-09)
// but the runtime .env was seeded once on first launch and never picked the new key up.
test('a key new to the bundle is appended to the runtime file', () => {
  const bundled = 'GITHUB_TOKEN=ghp_bundle\nSEEN_PRODUCT_REPO_DIR=/Users/you/seen\n';
  const runtime = 'GITHUB_TOKEN=ghp_real_user_token\n';
  const { text, added } = mergeEnvText(bundled, runtime);
  assert.deepEqual(added, ['SEEN_PRODUCT_REPO_DIR']);
  assert.match(text, /^SEEN_PRODUCT_REPO_DIR=\/Users\/you\/seen$/m);
});

test('values the user changed in the runtime copy are NEVER overwritten', () => {
  const bundled = 'GROQ_MODEL=llama-3.3-70b-versatile\nGROQ_API_KEY=stale_bundle_key\n';
  const runtime = 'GROQ_MODEL=qwen-32b\nGROQ_API_KEY=gsk_users_real_key\n';
  const { text, added } = mergeEnvText(bundled, runtime);
  assert.deepEqual(added, []);
  assert.equal(text, runtime); // untouched — caller can skip the write entirely
});

test('user lines are preserved byte-for-byte around the appended block', () => {
  const bundled = 'A=1\nNEW_KEY=fresh\n';
  const runtime = '# Brandon\'s notes — do not lose\nA=user-value   \n\nB=kept\n';
  const { text } = mergeEnvText(bundled, runtime);
  assert.ok(text.startsWith(runtime)); // append-only: existing content is a strict prefix
  assert.match(text, /^NEW_KEY=fresh$/m);
});

test('a key the user commented out is not resurrected', () => {
  const bundled = 'VERCEL_TOKEN=tok\nSTRIPE_SECRET_KEY=sk_live\n';
  const runtime = '# VERCEL_TOKEN=tok   <- disabled on purpose\n';
  const { added } = mergeEnvText(bundled, runtime);
  assert.deepEqual(added, ['STRIPE_SECRET_KEY']);
});

test('merge is idempotent — the second run adds nothing', () => {
  const bundled = 'A=1\nB=2\nC=3\n';
  const first = mergeEnvText(bundled, 'B=user\n');
  assert.deepEqual(first.added, ['A', 'C']);
  const second = mergeEnvText(bundled, first.text);
  assert.deepEqual(second.added, []);
  assert.equal(second.text, first.text);
});

test('runtime file without a trailing newline still merges cleanly', () => {
  const { text } = mergeEnvText('NEW=x\n', 'OLD=y'); // no trailing \n
  assert.match(text, /^OLD=y$/m);
  assert.match(text, /^NEW=x$/m);
  assert.ok(!/^OLD=y#/m.test(text) && !text.includes('OLD=yNEW')); // no line gluing
});

test('bundle lines are appended verbatim (quotes and inline comments survive)', () => {
  const bundled = 'MSG="hello world"   # keep the quotes\n';
  const { text } = mergeEnvText(bundled, 'OTHER=1\n');
  assert.ok(text.includes('MSG="hello world"   # keep the quotes'));
});

test('parser mirrors lib/config.mjs: comments, blanks, CRLF, first-occurrence wins', () => {
  const entries = parseEnvEntries('# comment\r\n\r\nA=1\r\nA=2\r\nnot a pair\r\nB = spaced \r\n');
  assert.deepEqual(entries.map((e) => e.key), ['A', 'B']);
  assert.equal(entries[0].raw, 'A=1'); // first occurrence wins, like loadEnvFile()
});

test('ownedKeys counts both set and commented-out keys', () => {
  const keys = ownedKeys('A=1\n# B=2\n## C=3\n# just a note, no key\n');
  assert.deepEqual([...keys].sort(), ['A', 'B', 'C']);
});

// End-to-end sanity against lib/config.mjs semantics: run the merged text through a replica of
// loadEnvFile() (importing config.mjs mutates process.env on import, so we mirror its parser here)
// and check the user's value wins for existing keys while new bundle keys become visible.
function loadLikeConfig(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || env[key] !== undefined) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}

test('merged file loads with user values intact and new keys present', () => {
  const bundled = 'GITHUB_TOKEN=bundle_token\nSEEN_PRODUCT_REPO_DIR=/repos/seen\nOVERNIGHT_MAX_BUILDS=5\n';
  const runtime = 'GITHUB_TOKEN=ghp_user\nOVERNIGHT_MAX_BUILDS=2\n';
  const env = loadLikeConfig(mergeEnvText(bundled, runtime).text);
  assert.equal(env.GITHUB_TOKEN, 'ghp_user');            // runtime value kept
  assert.equal(env.OVERNIGHT_MAX_BUILDS, '2');           // runtime value kept
  assert.equal(env.SEEN_PRODUCT_REPO_DIR, '/repos/seen'); // new key now applies
});
