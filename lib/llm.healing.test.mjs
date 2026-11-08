import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiChatHealing, pickModel } from './llm.mjs';

const IDS = ['whisper-large-v3', 'meta-llama/llama-prompt-guard-2-86m', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'groq/compound', 'openai/gpt-oss-safeguard-20b'];
const gone = () => { throw new Error('404: {"error":{"message":"The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.","code":"model_not_found"}}'); };

test('a retired model id heals ONCE: list what is served, pick by preference, retry, and report the switch', async () => {
  const calls = []; let heal = null;
  const chat = async (a) => { calls.push(a.model); if (a.model === 'llama-3.3-70b-versatile') gone(); return `answered by ${a.model}`; };
  const args = { endpoint: 'https://heal-1.test/v1/chat/completions', key: 'k', model: 'llama-3.3-70b-versatile', prompt: 'x' };
  const out = await openaiChatHealing(args, { prefer: ['openai/gpt-oss-120b'], chat, listModels: async () => IDS, onHeal: (h) => { heal = h; } });
  assert.equal(out, 'answered by openai/gpt-oss-120b');
  assert.deepEqual(heal, { from: 'llama-3.3-70b-versatile', to: 'openai/gpt-oss-120b' });
  await openaiChatHealing(args, { chat, listModels: async () => { throw new Error('must not list twice'); } });
  assert.deepEqual(calls, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b'], 'the healed id is remembered — the dead one is not retried every call');
});

test('the same retired-model switch is written to the ledger ONCE per run, even when many lanes heal at once', async () => {
  // One board meeting fans out across departments: seven lanes hit the SAME dead default concurrently,
  // each finds `known` still unset, each heals. The RETRY is deduped by the healed map — but without the
  // announce-once guard every one of them also fires onHeal, so the identical "model-retired" fact lands
  // seven times in a single run. Assert it is recorded exactly once, and that a real second switch still is.
  const chat = async (a) => { if (a.model === 'llama-3.3-70b-versatile') gone(); return `answered by ${a.model}`; };
  const heals = [];
  const endpoint = 'https://heal-concurrent.test/v1/chat/completions';
  const outs = await Promise.all(Array.from({ length: 7 }, () =>
    openaiChatHealing({ endpoint, key: 'k', model: 'llama-3.3-70b-versatile', prompt: 'x' },
      { prefer: ['openai/gpt-oss-120b'], chat, listModels: async () => IDS, onHeal: (h) => heals.push(h) })));
  for (const o of outs) assert.equal(o, 'answered by openai/gpt-oss-120b', 'every concurrent lane still gets a healed answer');
  assert.deepEqual(heals, [{ from: 'llama-3.3-70b-versatile', to: 'openai/gpt-oss-120b' }],
    'seven concurrent heals of the SAME switch → exactly one ledger line');

  // A genuinely different switch (a different target model) is still reported — the guard dedups, it does not mute.
  const out2 = await openaiChatHealing({ endpoint: 'https://heal-other.test/v1/chat/completions', key: 'k', model: 'llama-3.3-70b-versatile', prompt: 'x' },
    { chat, listModels: async () => ['whisper-large-v3', 'openai/gpt-oss-20b'], onHeal: (h) => heals.push(h) });
  assert.equal(out2, 'answered by openai/gpt-oss-20b');
  assert.deepEqual(heals[heals.length - 1], { from: 'llama-3.3-70b-versatile', to: 'openai/gpt-oss-20b' }, 'a different switch is still recorded');
  assert.equal(heals.length, 2, 'one line for the repeated switch, one for the genuinely new one');
});

test('only "the model is gone" heals — a rate limit, an outage or a bad key still fall through honestly', async () => {
  for (const msg of ['rate limited (429)', '503: high demand', '401: invalid api key']) {
    await assert.rejects(openaiChatHealing({ endpoint: `https://heal-2.test/${msg.length}`, key: 'k', model: 'm' }, { chat: async () => { throw new Error(msg); }, listModels: async () => { throw new Error('must not list'); } }), new RegExp(msg.slice(0, 6)));
  }
  await assert.rejects(openaiChatHealing({ endpoint: 'https://heal-3.test/x', key: 'k', model: 'm' }, { chat: gone, listModels: async () => ['whisper-large-v3'] }), /does not exist/, 'nothing usable is served → the original error stands');
});

test('pickModel never chooses a speech, guard or tool model, and falls back to the largest general one', () => {
  assert.equal(pickModel(IDS, ['qwen3.8-27b']), 'qwen/qwen3.8-27b', 'a preference may omit the vendor prefix');
  assert.equal(pickModel(IDS, ['not-served']), 'openai/gpt-oss-120b');
  assert.equal(pickModel(['whisper-large-v3', 'groq/compound']), null);
});

test('a REASONING model gets room to think on top of the answer budget — a 500-token review used to come back EMPTY', async () => {
  const { REASONING_MODEL } = await import('./llm.mjs');
  for (const m of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'deepseek-r1-distill']) assert.equal(REASONING_MODEL.test(m), true, m);
  for (const m of ['llama-3.3-70b-versatile', 'gemini-2.5-flash', 'qwen2.5-coder:32b']) assert.equal(REASONING_MODEL.test(m), false, m);
});
