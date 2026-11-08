const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedRuntimeAssets } = require('./runtime-assets.js');

test('app update refreshes dashboard code but preserves the live runtime state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-runtime-assets-'));
  const bundle = path.join(root, 'bundle');
  const userData = path.join(root, 'user');
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(path.join(userData, 'public'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });

  const dashboard = path.join(bundle, 'command-center.html');
  const state = path.join(bundle, 'state.json');
  fs.writeFileSync(dashboard, 'Seen Command v0.4.2');
  fs.writeFileSync(state, '{"source":"bundle"}');
  fs.writeFileSync(path.join(userData, 'public', 'command-center.html'), 'Seen Command v0.4.1');
  fs.writeFileSync(path.join(userData, 'data', 'state.json'), '{"source":"live"}');

  try {
    seedRuntimeAssets({ userData, bundledDashboard: dashboard, bundledState: state });
    assert.equal(fs.readFileSync(path.join(userData, 'public', 'command-center.html'), 'utf8'), 'Seen Command v0.4.2');
    assert.equal(fs.readFileSync(path.join(userData, 'data', 'state.json'), 'utf8'), '{"source":"live"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first launch seeds both dashboard and state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-runtime-assets-'));
  const dashboard = path.join(root, 'dashboard.html');
  const state = path.join(root, 'state.json');
  const userData = path.join(root, 'user');
  fs.writeFileSync(dashboard, 'new dashboard');
  fs.writeFileSync(state, 'new state');

  try {
    seedRuntimeAssets({ userData, bundledDashboard: dashboard, bundledState: state });
    assert.equal(fs.readFileSync(path.join(userData, 'public', 'command-center.html'), 'utf8'), 'new dashboard');
    assert.equal(fs.readFileSync(path.join(userData, 'data', 'state.json'), 'utf8'), 'new state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
