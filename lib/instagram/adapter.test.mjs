// Instagram adapter — safety-focused unit tests. No network, no Instagram, no real compiler run.
// The security-critical surfaces are username validation and argument-array construction (there must
// be no path where a username/query can become a shell command).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, toArgs, doctor } from './adapter.mjs';

test('normalizeUsername strips one @, enforces the IG charset, and rejects injection', () => {
  assert.equal(normalizeUsername('creator_a'), 'creator_a');
  assert.equal(normalizeUsername('@creator_a'), 'creator_a');
  assert.equal(normalizeUsername('  @Valid.99 '), 'Valid.99');
  assert.equal(normalizeUsername('a'.repeat(30)), 'a'.repeat(30)); // 30 ok
  assert.equal(normalizeUsername('a'.repeat(31)), null);           // 31 too long
  for (const bad of ['bad name!', 'rm -rf /', 'a;b', '$(whoami)', 'a/b', '../x', 'a\nb', '@@x', '', null, undefined, 42]) {
    assert.equal(normalizeUsername(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('toArgs builds a flat argv array (never a shell string); booleans are bare flags', () => {
  assert.deepEqual(toArgs({ project: 'x', limit: 50 }), ['--project', 'x', '--limit', '50']);
  assert.deepEqual(toArgs({ allVideos: true }), ['--all-videos']);
  assert.deepEqual(toArgs({ allVideos: false, session: null, missing: undefined }), []);
  assert.deepEqual(toArgs({ sessionUser: 'brandon' }), ['--session-user', 'brandon']); // camel→kebab
});

test('toArgs keeps an injection attempt as ONE argv element — it can never break out of the array', () => {
  assert.deepEqual(toArgs({ query: 'a; rm -rf /' }), ['--query', 'a; rm -rf /']);
  assert.deepEqual(toArgs({ input: '/path with spaces/$(whoami)' }), ['--input', '/path with spaces/$(whoami)']);
  assert.deepEqual(toArgs({ query: '`id`' }), ['--query', '`id`']);
});

test('doctor returns a structured report keyed by dependency', () => {
  const d = doctor();
  assert.equal(typeof d.ok, 'boolean');
  assert.ok(Array.isArray(d.missingRequired));
  assert.equal(typeof d.dataRoot, 'string');
  for (const k of ['compiler_python', 'compiler_tool', 'ffmpeg', 'ffprobe', 'tesseract', 'instaloader', 'gallery_dl', 'faster_whisper', 'claude_cli']) {
    assert.ok(k in d.checks, `doctor reports ${k}`);
    assert.equal(typeof d.checks[k].ok, 'boolean');
  }
});

test('doctor never requires an Instagram session (anonymous-first) and reports access separately', () => {
  const d = doctor();
  assert.ok(!('instagram_session' in d.checks), 'session is NOT a required dependency check');
  assert.ok(!d.missingRequired.includes('instagram_session'));
  assert.equal(d.ingestion.anonymousFirst, true);
  assert.equal(typeof d.ingestion.authenticatedSession.configured, 'boolean');
  assert.equal(typeof d.ingestion.authenticatedSession.available, 'boolean');
});

test('config.toolPath augments a minimal PATH with Homebrew/usr locations (GUI-app fix) and dedups', async () => {
  const { config } = await import('../config.mjs');
  const saved = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin';
    const parts = config.toolPath().split(':');
    assert.ok(parts.includes('/opt/homebrew/bin'), 'includes Homebrew bin so GUI-launched apps find ffmpeg/claude');
    assert.ok(parts.includes('/usr/local/bin'));
    assert.equal(parts.filter((p) => p === '/usr/bin').length, 1, 'no duplicate PATH entries');
  } finally { process.env.PATH = saved; }
});
