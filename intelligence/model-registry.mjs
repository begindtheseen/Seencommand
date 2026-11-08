import { execFileSync } from 'node:child_process';
import { cpus, freemem, platform, totalmem } from 'node:os';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODELS as LEGACY_MODELS } from '../org/models.mjs';
import { dataDir } from '../lib/paths.mjs';

const GB = 1024 ** 3;
const parseSizeGb = (s) => {
  const m = String(s).match(/([\d.]+)\s*(GB|MB)/i);
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'MB' ? 1 / 1024 : 1) : null;
};

export function detectHardware({ execFn = execFileSync } = {}) {
  let chip = platform() === 'darwin' ? 'Apple Silicon' : cpus()[0]?.model || 'unknown';
  let storage = null;
  try {
    const out = execFn('system_profiler', ['SPHardwareDataType'], { encoding: 'utf8' });
    chip = /Chip:\s*(.+)/.exec(out)?.[1]?.trim() || chip;
  } catch { /* portable fallback above */ }
  try {
    const out = execFn('df', ['-k', '/'], { encoding: 'utf8' }).trim().split('\n').pop().trim().split(/\s+/);
    storage = Number(out[3]) * 1024;
  } catch { /* unknown */ }
  return {
    platform: platform(), architecture: process.arch, chip,
    unifiedMemoryBytes: totalmem(), availableMemoryBytes: freemem(), availableStorageBytes: storage,
    logicalCpus: cpus().length,
  };
}

export const BUILTIN_MODELS = Object.freeze({
  'qwen2.5-coder-14b': {
    id: 'qwen2.5-coder-14b', family: 'Qwen2.5 Coder', version: '14B', providerId: 'ollama', runtime: 'local', quantization: 'Q4_K_M', parameterCount: 14.8e9, activeParameterCount: 14.8e9, contextLimit: 32768, memoryRequirementBytes: 10 * GB,
    capabilities: ['classify', 'summarize', 'plan', 'code', 'review', 'tool_use', 'structured_output', 'repository_reasoning'], license: 'Apache-2.0', source: 'installed Ollama manifest', ollamaTag: 'qwen2.5-coder:14b', pricingUsdPerMillion: { input: 0, output: 0 }, verified: true,
  },
  'qwen2.5-coder-32b': {
    id: 'qwen2.5-coder-32b', family: 'Qwen2.5 Coder', version: '32B', providerId: 'ollama', runtime: 'local', quantization: 'Q4_K_M', parameterCount: 32.8e9, activeParameterCount: 32.8e9, contextLimit: 32768, memoryRequirementBytes: 22 * GB,
    capabilities: ['classify', 'summarize', 'plan', 'code', 'review', 'security', 'tool_use', 'structured_output', 'repository_reasoning', 'long_context'], license: 'Apache-2.0', source: 'installed Ollama manifest', ollamaTag: 'qwen2.5-coder:32b', pricingUsdPerMillion: { input: 0, output: 0 }, verified: true,
  },
});

export const benchmarkStorePath = () => join(dataDir(), 'intelligence', 'model-benchmarks.json');
export function loadBenchmarks({ path = benchmarkStorePath() } = {}) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
export function recordBenchmark(result, { path = benchmarkStorePath() } = {}) {
  const current = loadBenchmarks({ path }); current[result.id] = {
    healthStatus: result.healthStatus, measuredMemoryBytes: result.measuredMemoryBytes, tokensPerSecond: result.tokensPerSecond,
    timeToFirstTokenMs: result.timeToFirstTokenMs, evaluationScore: result.evaluationScore, lastBenchmarkDate: result.lastBenchmarkDate,
  };
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(current, null, 2)); renameSync(tmp, path); return current[result.id];
}

export function discoverModels({ execFn = execFileSync, now = new Date(), benchmarks = loadBenchmarks() } = {}) {
  let lines = [];
  try { lines = execFn('ollama', ['list'], { encoding: 'utf8' }).trim().split('\n').slice(1); } catch { lines = []; }
  const installed = new Map();
  for (const line of lines) {
    const m = line.trim().match(/^(\S+)\s+\S+\s+([\d.]+\s*(?:GB|MB))/i);
    if (m) installed.set(m[1], { storageBytes: (parseSizeGb(m[2]) || 0) * GB });
  }
  const models = Object.values(BUILTIN_MODELS).map((model) => {
    const found = installed.get(model.ollamaTag);
    const measured = found ? (benchmarks[model.id] || {}) : {};
    return { ...model, installationStatus: found ? 'installed' : 'not_installed', healthStatus: found ? (measured.healthStatus || 'unbenchmarked') : 'unavailable', storageBytes: found?.storageBytes || null, measuredMemoryBytes: measured.measuredMemoryBytes || null, tokensPerSecond: measured.tokensPerSecond || null, timeToFirstTokenMs: measured.timeToFirstTokenMs ?? null, evaluationScore: measured.evaluationScore ?? null, lastBenchmarkDate: measured.lastBenchmarkDate || null, discoveredAt: now.toISOString() };
  });
  return { hardware: detectHardware({ execFn }), models };
}

export function registerLegacyModels(registry) {
  const ids = new Set(registry.models.map((m) => m.id));
  for (const legacy of Object.values(LEGACY_MODELS)) if (!ids.has(legacy.id)) registry.models.push({
    id: legacy.id, family: legacy.name, version: 'configured', providerId: legacy.type === 'local' ? 'ollama' : 'anthropic', runtime: legacy.type === 'local' ? 'local' : 'remote', quantization: null,
    parameterCount: null, activeParameterCount: null, contextLimit: null, memoryRequirementBytes: null,
    capabilities: legacy.competences || [], license: 'unverified', source: 'org/models.mjs legacy catalog', ollamaTag: legacy.ollamaTag || null,
    pricingUsdPerMillion: { input: 0, output: 0 }, verified: false, installationStatus: 'configured', healthStatus: 'unverified', measuredMemoryBytes: null, tokensPerSecond: null, timeToFirstTokenMs: null, evaluationScore: null, lastBenchmarkDate: null,
  });
  return registry;
}

export function selectModel(registry, { requiredCapabilities = [], privacy = 'INTERNAL', localFirst = true, allowRemote = false } = {}) {
  const eligible = registry.models.filter((m) => m.installationStatus === 'installed' && requiredCapabilities.every((c) => m.capabilities.includes(c)) && (privacy !== 'LOCAL_ONLY' || m.runtime === 'local'));
  eligible.sort((a, b) => {
    if (localFirst && a.runtime !== b.runtime) return a.runtime === 'local' ? -1 : 1;
    return (b.parameterCount || 0) - (a.parameterCount || 0);
  });
  const chosen = eligible.find((m) => m.runtime === 'local' || allowRemote);
  if (!chosen) throw new Error(`no verified installed model satisfies: ${requiredCapabilities.join(', ')}`);
  return chosen;
}

export async function benchmarkOllama(model, { fetchFn = fetch, baseUrl = 'http://127.0.0.1:11434', now = () => new Date() } = {}) {
  const started = Date.now();
  const res = await fetchFn(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.ollamaTag, prompt: 'Return exactly: READY', stream: true, options: { num_predict: 8, temperature: 0 } }) });
  if (!res.ok) throw new Error(`Ollama benchmark failed: HTTP ${res.status}`);
  let body = {}; let output = ''; let firstTokenAt = null;
  if (res.body?.getReader) {
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue; const event = JSON.parse(line);
        if (event.response && firstTokenAt == null) firstTokenAt = Date.now();
        output += event.response || ''; if (event.done) body = event;
      }
    }
    if (pending.trim()) { const event = JSON.parse(pending); if (event.response && firstTokenAt == null) firstTokenAt = Date.now(); output += event.response || ''; if (event.done) body = event; }
  } else { body = await res.json(); output = body.response || ''; firstTokenAt = Date.now(); }
  const evalCount = Number(body.eval_count || 0); const evalSeconds = Number(body.eval_duration || 0) / 1e9;
  let measuredMemoryBytes = null;
  try { const ps = await fetchFn(`${baseUrl}/api/ps`); if (ps.ok) { const loaded = (await ps.json()).models?.find((m) => m.name === model.ollamaTag || m.model === model.ollamaTag); measuredMemoryBytes = Number(loaded?.size_vram || loaded?.size || 0) || null; } } catch { /* benchmark remains valid */ }
  return { ...model, healthStatus: /READY/i.test(output) ? 'healthy' : 'invalid_output', measuredMemoryBytes, tokensPerSecond: evalSeconds > 0 ? evalCount / evalSeconds : null, timeToFirstTokenMs: firstTokenAt == null ? null : firstTokenAt - started, evaluationScore: /READY/i.test(output) ? 1 : 0, lastBenchmarkDate: now().toISOString() };
}
