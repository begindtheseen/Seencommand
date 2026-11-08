// The competence router — assigns each kind of work to the RIGHT local model, best-first, and reports
// which of them are actually SERVED so lib/llm.mjs only tries reachable ones (no wasted timeouts).
//
// Philosophy: LOCAL-FIRST + QUALITY-FIRST. For a given competence we prefer the strongest fitting local
// model; the hosted free lanes and the frontier backstop are appended by llm.mjs as the safety net. When
// nothing local is served (today), localChainFor() returns [] and routing is exactly the hosted chain.
//
// "Served" = a model whose ollamaTag is either listed in LOCAL_MODELS (explicit) OR present on the live
// Ollama /api/tags probe (auto-detect). The probe is cached and fail-soft: no Ollama → empty set.

import { MODELS } from '../org/models.mjs';
import { config } from './config.mjs';

// competence → ordered model ids (best first). Frontier is intentionally OMITTED here — llm.mjs owns the
// hosted/frontier fallback; this map is only about the local fleet's competence ranking.
// Every chain ends with the served mid coder (qwen2.5-coder-14b) as the local last resort: it is a
// competent generalist, and it means reasoning NEVER dies to hosted rate limits — the CEO always has
// a lane (local, $0) before the deterministic fallback.
export const COMPETENCE = {
  orchestrate:  ['qwen3-32b', 'glm-4.5-air', 'qwen2.5-coder-14b'],
  decide:       ['qwen3-32b', 'deepseek-r1-32b', 'qwen2.5-coder-14b'],
  plan:         ['glm-4.5-air', 'qwen3-32b', 'qwen2.5-coder-32b', 'qwen2.5-coder-14b'],
  'route-agents': ['glm-4.5-air', 'qwen3-32b', 'qwen2.5-coder-14b'],
  code:         ['qwen3-coder-30b', 'kimi-k2-7-code', 'kimi-k2-6', 'qwen2.5-coder-32b', 'qwen2.5-coder-14b', 'deepseek-coder-v2-lite'],
  'code-heavy': ['kimi-k2-7-code', 'kimi-k2-6', 'qwen3-coder-30b', 'qwen2.5-coder-32b', 'qwen2.5-coder-14b'],
  'code-light': ['qwen2.5-coder-32b', 'qwen2.5-coder-14b', 'deepseek-coder-v2-lite', 'qwen3-coder-30b'],
  review:       ['deepseek-r1-32b', 'qwen2.5-coder-32b', 'qwen2.5-coder-14b'],
  reason:       ['deepseek-r1-32b', 'qwen3-32b', 'qwen2.5-coder-32b', 'qwen2.5-coder-14b'],
  generalist:   ['mistral-small-119b', 'llama-3.1', 'qwen2.5-coder-14b'],
  polish:       ['mistral-small-119b', 'llama-3.1', 'qwen2.5-coder-14b'],
  longcontext:  ['mistral-small-119b', 'qwen3-32b', 'qwen2.5-coder-14b'],
  route:        ['qwen3-8b', 'llama-3.1', 'qwen2.5-coder-14b'],
  classify:     ['qwen3-8b', 'llama-3.1', 'qwen2.5-coder-14b'],
  summarize:    ['qwen3-8b', 'llama-3.1', 'qwen2.5-coder-14b'],
  assist:       ['llama-3.1', 'qwen3-8b', 'qwen2.5-coder-14b'],
};

// Map a department + coder flag to a default competence, so existing callers route sensibly with no code
// changes. Coder work always routes to 'code'; otherwise the dept's lead competence.
const DEPT_COMPETENCE = {
  command: 'orchestrate', strategy: 'reason', data: 'classify',
  product: 'code', platform: 'code', growth: 'assist', reliability: 'assist', revenue: 'assist',
};
export function competenceFor({ deptId = 'command', coder = false } = {}) {
  if (coder) return 'code';
  return DEPT_COMPETENCE[deptId] || 'assist';
}

// Loose tag match: served "qwen3:32b" or "qwen3:32b-instruct-q4" both satisfy model tag "qwen3:32b".
function tagServed(modelTag, servedSet) {
  if (!modelTag) return false;
  if (servedSet.has(modelTag)) return true;
  for (const s of servedSet) { if (s === modelTag || s.startsWith(modelTag) || modelTag.startsWith(s)) return true; }
  return false;
}

// ---- served-set resolution (env ∪ live Ollama probe), cached + fail-soft ----
let _probeCache = { at: 0, tags: [] };
const PROBE_TTL_MS = 30000;
async function probeOllama() {
  if (Date.now() - _probeCache.at < PROBE_TTL_MS) return _probeCache.tags;
  let tags = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${config.ollamaUrl()}/api/tags`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (res.ok) { const j = await res.json(); tags = (j.models || []).map((m) => m.name || m.model).filter(Boolean); }
  } catch { tags = []; }
  _probeCache = { at: Date.now(), tags };
  return tags;
}

// The set of served tags = LOCAL_MODELS env (authoritative) ∪ Ollama probe. Awaitable; never throws.
export async function servedTags() {
  const env = config.localModels();
  const probe = await probeOllama();
  return new Set([...env, ...probe]);
}

// The ordered list of SERVED local models for a competence, best-first. Pure given the served set.
export function localChainFor(competence, servedSet) {
  const ids = COMPETENCE[competence] || COMPETENCE.assist;
  const out = [];
  for (const id of ids) { const m = MODELS[id]; if (m && m.type === 'local' && tagServed(m.ollamaTag, servedSet)) out.push(m); }
  return out;
}

// Convenience: resolve served + build the local model lane descriptors for llm.mjs to run.
// Returns [{ id, name, tag, engine }] — engine names the model so the debrief shows who answered.
export async function localLanesFor(competence) {
  const served = await servedTags();
  return localChainFor(competence, served).map((m) => ({ id: m.id, name: m.name, tag: m.ollamaTag, engine: `local:${m.id}` }));
}
