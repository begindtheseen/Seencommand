const test = require('node:test');
const assert = require('node:assert/strict');
const { selectChildRuntime, buildChildEnv } = require('./child-runtime.js');

test('prefers an installed system Node for packaged background workers', () => {
  const runtime = selectChildRuntime('/Applications/Seen Command.app/embedded', {
    candidates: ['/missing/node', '/opt/homebrew/bin/node'],
    existsSync: (candidate) => candidate === '/opt/homebrew/bin/node',
  });
  assert.deepEqual(runtime, { executable: '/opt/homebrew/bin/node', usesEmbeddedElectron: false });
  const env = buildChildEnv({ baseEnv: { ELECTRON_RUN_AS_NODE: 'old' }, runtime, userData: '/runtime', port: 4173, nodeOptions: '--experimental-sqlite', compilerToolDir: '/app/worker' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.SEEN_HOME, '/runtime');
  assert.equal(env.VSC_TOOL_DIR, '/app/worker');
});

test('falls back to Electron in Node mode when system Node is unavailable', () => {
  const runtime = selectChildRuntime('/embedded/electron', { candidates: ['/missing'], existsSync: () => false });
  assert.deepEqual(runtime, { executable: '/embedded/electron', usesEmbeddedElectron: true });
  const env = buildChildEnv({ baseEnv: {}, runtime, userData: '/runtime', port: 4173, nodeOptions: '--experimental-sqlite', compilerToolDir: '/app/worker' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});
