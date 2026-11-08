import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels, selectModel } from './model-registry.mjs';

test('hardware-aware discovery records installed local model metadata without downloading anything', () => {
  const execFn = (bin, args) => {
    if (bin === 'ollama') return 'NAME ID SIZE MODIFIED\nqwen2.5-coder:14b abc 9.0 GB now\n';
    if (bin === 'system_profiler') return 'Chip: Apple M5 Pro\n';
    if (bin === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1000 1 999 1% /\n';
    throw new Error('unexpected');
  };
  const registry = discoverModels({ execFn, benchmarks: {} }); const installed = registry.models.find((m) => m.id === 'qwen2.5-coder-14b');
  assert.equal(registry.hardware.chip, 'Apple M5 Pro'); assert.equal(installed.installationStatus, 'installed'); assert.equal(installed.license, 'Apache-2.0'); assert.ok(installed.contextLimit && installed.memoryRequirementBytes);
  assert.equal(selectModel(registry, { requiredCapabilities: ['code'], privacy: 'LOCAL_ONLY' }).id, 'qwen2.5-coder-14b');
});
