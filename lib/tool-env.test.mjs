// A Finder-launched app has macOS's bare PATH, so a `#!/usr/bin/env node` CLI died with exit 127
// "env: node: No such file or directory" (Settings → System diagnostics: "Cline exited 127").
// Run: node --test lib/tool-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { toolPathFor, toolEnv } from './tool-env.mjs';

const BARE = '/usr/bin:/bin:/usr/sbin:/sbin';

test('reproduces the 127 under a bare PATH, and toolEnv finds the node the CLI was installed with', (t) => {
  // An npm-global layout: <prefix>/bin/node, <prefix>/lib/node_modules/fakecli/cli.js, and the
  // CLI linked from a SEPARATE bin dir (like /usr/local/bin → an nvm prefix).
  const root = mkdtempSync(join(tmpdir(), 'tool-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'nvm', 'v22');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(prefix, 'lib', 'node_modules', 'fakecli'), { recursive: true });
  symlinkSync(process.execPath, join(prefix, 'bin', 'node'));
  const script = join(prefix, 'lib', 'node_modules', 'fakecli', 'cli.js');
  writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write("ok " + process.version)\n');
  chmodSync(script, 0o755);
  mkdirSync(join(root, 'linkbin'));
  const bin = join(root, 'linkbin', 'fakecli');
  symlinkSync(script, bin);

  const bare = spawnSync(bin, [], { env: { PATH: BARE }, encoding: 'utf8' });
  assert.equal(bare.status, 127, 'the original failure: env cannot find node');
  assert.match(bare.stderr, /node/);

  const fixed = spawnSync(bin, [], { env: toolEnv(bin, { PATH: BARE }, { home: '' }), encoding: 'utf8' });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /^ok v/);
});

test('PATH order: the binary dir, its npm prefix bin, Homebrew/system, then the inherited PATH — deduped', () => {
  const p = toolPathFor('/usr/local/bin/cline', '/usr/bin:/custom', { realpath: () => '/Users/b/.nvm/versions/node/v22/lib/node_modules/cline/bin/cline', home: '/Users/b' }).split(':');
  assert.deepEqual(p.slice(0, 4), ['/usr/local/bin', '/Users/b/.nvm/versions/node/v22/lib/node_modules/cline/bin', '/Users/b/.nvm/versions/node/v22/bin', '/opt/homebrew/bin']);
  assert.ok(p.includes('/custom'));
  assert.equal(p.filter((d) => d === '/usr/bin').length, 1);
  assert.ok(toolPathFor('cline', '', { realpath: () => { throw new Error('x'); } }).startsWith('/opt/homebrew/bin'), 'a bare name adds no binary dir');
  const base = { PATH: '/x', KEEP: '1' };
  const env = toolEnv('/a/b', base, { realpath: (x) => x, home: '' });
  assert.equal(env.KEEP, '1');
  assert.equal(base.PATH, '/x', 'the input is never mutated');
});

import { claudeCliEnv, claudeToolEnv } from './tool-env.mjs';
test('claudeCliEnv strips every Claude auth override and keeps the rest', () => {
  const base = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', HOME: '/h', USER: 'b', GITHUB_TOKEN: 'g', PATH: '/usr/bin' };
  const e = claudeCliEnv(base);
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) assert.equal(e[k], undefined, k);
  assert.equal(e.HOME, '/h'); assert.equal(e.USER, 'b'); assert.equal(e.GITHUB_TOKEN, 'g');
  assert.equal(base.ANTHROPIC_API_KEY, 'k', 'the input is not mutated');
  const t = claudeToolEnv('/opt/homebrew/bin/claude', base, { realpath: (p) => p });
  assert.equal(t.ANTHROPIC_API_KEY, undefined); assert.match(t.PATH, /^\/opt\/homebrew\/bin/);
});
