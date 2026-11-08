import { test } from 'node:test';
import assert from 'node:assert/strict';

// Force EVERY hosted lane off and local Ollama unreachable so we exercise the deterministic
// fallback with no network. Keys are set to '' (defined-but-empty) BEFORE importing config, so its
// .env loader won't repopulate them and every getter reports the lane as unconfigured.
for (const k of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CEREBRAS_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_KEY']) {
  process.env[k] = '';
}
process.env.OLLAMA_URL = 'http://127.0.0.1:1'; // nothing listening
process.env.LLM_TIMEOUT_MS = '1500';
const { reason } = await import('./llm.mjs');

const ENGINES = ['groq', 'gemini', 'cerebras', 'local', 'frontier', 'fallback'];

test('reason() always returns text + a known engine, even fully offline', async () => {
  const r = await reason({ deptId: 'data', prompt: 'summarize', fallback: 'FALLBACK-BODY', maxTokens: 32 });
  assert.ok(ENGINES.includes(r.engine));
  assert.ok(r.text && r.text.length > 0);
});

test('every lane down → fallback engine returns the provided fallback verbatim', async () => {
  const r = await reason({ deptId: 'growth', prompt: 'x', fallback: 'FALLBACK-BODY' });
  assert.equal(r.engine, 'fallback');
  assert.equal(r.text, 'FALLBACK-BODY');
});
