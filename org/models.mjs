// Model layer — the brains the exec team can run on, and the COMPETENCE ROUTER that assigns the right
// one to each kind of work. OPEN-SOURCE / LOCAL FIRST: the catalog is the local GGUF fleet Brandon is
// standing up (self-hosted via Ollama/llama.cpp — $0 per token, private, no lock-in). Frontier (Claude)
// stays an opt-in backstop for the hardest judgment/code. Quality-first: pick by competence, not cost.
//
// Nothing local is SERVED yet, so `served()` returns false for the fleet and the router degrades to the
// hosted free lanes (groq/gemini/cerebras) then frontier — exactly today's behaviour. The moment a tag
// is served (listed in LOCAL_MODELS or found on the Ollama /api/tags probe), that model slots into the
// chain at its competence priority automatically. See lib/router.mjs for the routing + the live probe.

// ---- the fleet ------------------------------------------------------------------------------------
// role         — the plain-English job (mirrors Brandon's brief).
// competences  — task tags this model is a first choice for (see COMPETENCE in lib/router.mjs).
// ollamaTag    — the tag to pull/serve it under (ollama pull <tag>); the router matches served tags.
// tier         — rough weight class, for display + tie-breaking (xl > lg > md > sm).
export const MODELS = {
  'qwen3-32b': {
    id: 'qwen3-32b', name: 'Qwen3-32B', role: 'CEO orchestrator / main brain', tier: 'lg',
    competences: ['orchestrate', 'plan', 'decide'], ollamaTag: 'qwen3:32b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Best default for planning, product decisions, agent coordination.' },
  'qwen3-coder-30b': {
    id: 'qwen3-coder-30b', name: 'Qwen3-Coder-30B-A3B', role: 'Lead coding agent', tier: 'lg',
    competences: ['code', 'code-light'], ollamaTag: 'qwen3-coder:30b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Repo edits, bug fixes, Next.js/React/TypeScript, patches.' },
  'deepseek-r1-32b': {
    id: 'deepseek-r1-32b', name: 'DeepSeek-R1-Distill-Qwen-32B', role: 'Reasoning reviewer', tier: 'lg',
    competences: ['review', 'reason'], ollamaTag: 'deepseek-r1:32b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Criticize plans, check logic, review scoring/matching/ranking, catch bad assumptions.' },
  'glm-4.5-air': {
    id: 'glm-4.5-air', name: 'GLM-4.5-Air', role: 'Agentic planner / tool-use', tier: 'lg',
    competences: ['plan', 'route-agents'], ollamaTag: 'glm-4.5-air', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Multi-step planning, tool routing, coordinating agents, app-wide updates.' },
  'mistral-small-119b': {
    id: 'mistral-small-119b', name: 'Mistral-Small-4-119B', role: 'Premium local generalist', tier: 'xl',
    competences: ['generalist', 'polish', 'longcontext'], ollamaTag: 'mistral-small:119b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Long-context review, polished UX copy, product strategy, higher-quality final outputs.' },
  'kimi-k2-6': {
    id: 'kimi-k2-6', name: 'Kimi-K2.6', role: 'Long-horizon autonomous coder', tier: 'xl',
    competences: ['code-heavy', 'code'], ollamaTag: 'kimi-k2:6', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Large repo-wide tasks, multi-file updates, design-to-code, bigger feature builds.' },
  'kimi-k2-7-code': {
    id: 'kimi-k2-7-code', name: 'Kimi-K2.7-Code', role: 'Advanced coding agent', tier: 'xl',
    competences: ['code-heavy', 'code'], ollamaTag: 'kimi-k2.7-code', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Complex SWE, long-horizon code changes, big implementation tasks.' },
  'qwen3-8b': {
    id: 'qwen3-8b', name: 'Qwen3-8B', role: 'Fast router / cheap assistant', tier: 'sm',
    competences: ['route', 'classify', 'summarize'], ollamaTag: 'qwen3:8b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Quick classification, routing to the right agent, simple summaries, cheap background decisions.' },
  'llama-3.1': {
    id: 'llama-3.1', name: 'Llama-3.1 (8B/70B)', role: 'General assistant backup', tier: 'md',
    competences: ['assist', 'generalist'], ollamaTag: 'llama3.1', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Normal chat, fallback tasks, simple writing, lightweight assistant behaviour.' },
  'deepseek-coder-v2-lite': {
    id: 'deepseek-coder-v2-lite', name: 'DeepSeek-Coder-V2-Lite', role: 'Lightweight coding backup', tier: 'sm',
    competences: ['code-light'], ollamaTag: 'deepseek-coder-v2:lite', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Smaller code edits, quick bug fixes, cheap local coding when the lead coder is too heavy.' },
  'qwen2.5-coder-32b': {
    id: 'qwen2.5-coder-32b', name: 'Qwen2.5-Coder-32B', role: 'Strong local coding agent (served)', tier: 'lg',
    competences: ['code', 'code-heavy', 'code-light'], ollamaTag: 'qwen2.5-coder:32b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'The strongest pulled local coder (2026-08-03) — near-frontier on real repo edits; the free-lane default when served.' },
  'qwen2.5-coder-14b': {
    id: 'qwen2.5-coder-14b', name: 'Qwen2.5-Coder-14B', role: 'Mid coding agent (served)', tier: 'md',
    competences: ['code', 'code-light'], ollamaTag: 'qwen2.5-coder:14b', type: 'local', runtime: 'Ollama',
    cost: '$0 · self-hosted', note: 'Capable local coder — real repo edits/bug fixes when the 30B lead coder is not pulled. Currently served on the local machine.' },
  // The opt-in frontier backstop — Claude, for the hardest judgment/code when Brandon enables it.
  'frontier': {
    id: 'frontier', name: 'Claude (opt-in)', role: 'Frontier judgment/code backstop', tier: 'xl',
    competences: ['orchestrate', 'code', 'review', 'plan', 'generalist'], ollamaTag: null, type: 'hosted', runtime: 'Anthropic API',
    cost: '$ per token', note: 'Quality-first backstop for the hardest reasoning/code — opt in with ANTHROPIC_API_KEY.' },
};

// Default model shown per department (Agents tab). Maps each dept to its lead competence's model so the
// UI reflects the router's intent even before anything is served.
export const DEPT_MODEL = {
  command:     'qwen3-32b',        // orchestrator / main brain
  growth:      'llama-3.1',        // general assistant
  product:     'qwen3-coder-30b',  // lead coding agent
  reliability: 'llama-3.1',
  revenue:     'llama-3.1',
  data:        'qwen3-8b',         // fast router / classify
  strategy:    'deepseek-r1-32b',  // reasoning reviewer / hardest reasoning
  platform:    'qwen3-coder-30b',  // code (self-improvement)
};

// Depts where flipping up to the frontier backstop is worth it (hardest judgment/code).
export const FRONTIER_OPTIONAL = new Set(['command', 'product', 'strategy', 'platform']);

export const modelFor = (deptId) => MODELS[DEPT_MODEL[deptId]] || MODELS['llama-3.1'];
export const isFrontierOptional = (deptId) => FRONTIER_OPTIONAL.has(deptId);
export const modelById = (id) => MODELS[id] || null;
