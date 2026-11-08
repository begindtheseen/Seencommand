// From the first real-model run (2026-09-18): the top rung failed and the record said only "exited 1".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_AUTH_FAILURE, claudeCliEnv } from './agentic-coder.mjs';

test('every wording of "log in again" is recognised — including the one that actually happened', () => {
  for (const said of ['Failed to authenticate: OAuth session expired and could not be refreshed', 'You are not logged in', 'Please run /login', 'Invalid API key', 'OAuth token expired'])
    assert.equal(CLAUDE_AUTH_FAILURE.test(said), true, said);
  for (const fine of ['Edited lib/feed.mjs', 'error TS2322: not assignable', 'refreshed the cache'])
    assert.equal(CLAUDE_AUTH_FAILURE.test(fine), false, fine);
});

test('the CLI authenticates as ITSELF: a parent Claude Code session\'s markers and routing never reach it', () => {
  const env = claudeCliEnv({ PATH: '/usr/bin', HOME: '/Users/x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', ANTHROPIC_BASE_URL: 'http://proxy', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't' });
  assert.deepEqual(Object.keys(env).sort(), ['GITHUB_TOKEN', 'HOME', 'PATH']);
});

test('a local model in a tool loop is NOT an exploring agent — only a frontier agent or an explicitly chosen hosted engine is', async () => {
  const { exploringAgentConfigured, agenticEngineConfigured } = await import('./agentic-coder.mjs');
  const withEnv = (env, fn) => { const prev = {}; for (const k of ['AGENTIC_ENGINE', 'CODER_PAID_OK', 'CLINE_AGENT']) { prev[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, env); try { return fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
  assert.equal(agenticEngineConfigured(), true, 'the lane is always offered — which is exactly why grounding cannot use it');
  assert.equal(withEnv({ AGENTIC_ENGINE: 'ollama' }, () => exploringAgentConfigured()), false);
  assert.equal(withEnv({ CLINE_AGENT: '0' }, () => exploringAgentConfigured({ exists: () => false })), false, 'free chain, no claude binary, cline off → ollama only');
  assert.equal(withEnv({ CLINE_AGENT: '0' }, () => exploringAgentConfigured({ exists: () => true })), true, 'the claude CLI is installed');
  assert.equal(withEnv({ AGENTIC_ENGINE: 'groq' }, () => exploringAgentConfigured({ exists: () => false })), true, 'an explicitly selected hosted engine');
});
