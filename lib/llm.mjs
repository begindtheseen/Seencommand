// LLM adapter — the one place agents get a brain. `reason()` is the single entry point every
// department calls to think over live data. It tries a chain of lanes and returns the FIRST that
// answers, so the board meeting always produces something and never hard-fails on a dead provider:
//
//   groq → gemini → cerebras   (free / fast hosted lanes — the workhorses)
//   → local Ollama             (private, $0, if the daemon is up)
//   → Anthropic                (emergency frontier backstop — costs money, last resort)
//   → deterministic fallback   (the caller's own text; engine:'fallback' — always succeeds)
//
// A lane that errors, times out, or is rate-limited (HTTP 429) simply falls through to the next.
// Every call returns { text, engine } where engine names the lane that answered.

import { config, llmStatus } from './config.mjs';
import { logActivity } from './activity.mjs';
import { localLanesFor, competenceFor, COMPETENCE } from './router.mjs';

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20000);
// Code generation over big files takes far longer than a 2-sentence board-meeting reply — a short
// timeout aborts a large-context lane mid-answer. Coder calls get a generous window: the LOCAL 32B
// coder emits ~12 tok/s, so a 4000-token patch is ~5-6 minutes — the old 120s ceiling aborted every
// strong-model answer and silently degraded the whole pipeline to the weak 14B (machine attempt 1's
// root failure). Free lanes mean patience costs nothing; a hung lane still falls through at the cap.
const CODER_TIMEOUT_MS = Number(process.env.LLM_CODER_TIMEOUT_MS || 480000);

// fetch with an abort timeout so one hung provider can't stall the whole board meeting.
async function fetchT(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// A provider error worth falling through on (rate limit, server error, network). We throw a tagged
// error so reason() knows to try the next lane rather than surface it.
class LaneError extends Error {}

// --- OpenAI-compatible chat lanes (Groq, Cerebras) -------------------------
export const REASONING_MODEL = /gpt-oss|deepseek-r1|qwen3|\bo[134]-/i;
async function openaiChat({ endpoint, key, model, system, prompt, maxTokens, timeoutMs }) {
  const res = await fetchT(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      // A REASONING model (gpt-oss…) spends max_tokens on its reasoning FIRST. The reviewer asks for 500:
      // the model thought for 500 tokens and returned an EMPTY completion, which silently demoted every
      // semantic review to the same local model that wrote the code (found live, 2026-09-18). Give reasoning
      // room on top of the answer budget, and ask for low effort — a verdict, not an essay.
      max_tokens: REASONING_MODEL.test(String(model)) ? Math.max(maxTokens * 2, maxTokens + 3000) : maxTokens,
      ...(REASONING_MODEL.test(String(model)) ? { reasoning_effort: 'low' } : {}),
      temperature: 0.4,
    }),
  }, timeoutMs);
  if (res.status === 429) throw new LaneError('rate limited (429)');
  if (!res.ok) throw new LaneError(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new LaneError('empty completion');
  return text;
}

// --- a retired model id must not silently remove a lane ---------------------------------------------
// Hosted providers decommission models. Groq retired qwen-2.5-coder-32b, then llama-3.3-70b-versatile —
// and each time the lane answered 404 on EVERY call and "fell through" in a log line nobody reads, which
// quietly removed the free hosted rung for the coder AND the semantic reviewer (found on the first
// real-model run, 2026-09-18). A default id cannot stay right. So: on "model does not exist", ask the
// provider what it serves, pick by preference, retry ONCE, remember it for this process, and record the
// switch in the activity ledger so the stale default gets fixed by a human instead of rotting again.
const MODEL_GONE = /model_not_found|does not exist|decommissioned|no longer supported|not have access to it/i;
const NOT_CHAT = /whisper|guard|orpheus|allam|tts|embed|safeguard|compound/i;
const GROQ_PREFER = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const healed = new Map(); // endpoint → the model id that works
// A board meeting fires many lanes at once, so several concurrent calls all discover the SAME dead
// default before any of them records the switch — each captured `known` as undefined and each heals.
// The `healed` map dedups the RETRY, but not the ledger line: without this guard the same
// "groq retired X → Y" fact lands seven times in one run. Announce each distinct switch exactly once
// per process; a genuinely different switch (new from/to) is still reported.
const announcedSwitches = new Set(); // "endpoint\0from\0to" already written to the ledger
export function pickModel(ids, prefer = []) {
  const usable = ids.filter((id) => !NOT_CHAT.test(id));
  for (const p of prefer) { const hit = usable.find((id) => id === p || id.endsWith(`/${p}`)); if (hit) return hit; }
  // no preference matched → the largest general model by its parameter count in the name (…-120b > …-27b)
  return usable.map((id) => ({ id, b: Number((/(\d+(?:\.\d+)?)b\b/i.exec(id) || [])[1] || 0) })).sort((a, b) => b.b - a.b)[0]?.id || null;
}
export async function openaiChatHealing(args, { prefer = [], chat = openaiChat, listModels = null, onHeal = null } = {}) {
  const known = healed.get(args.endpoint);
  try { return await chat(known ? { ...args, model: known } : args); }
  catch (e) {
    if (!MODEL_GONE.test(String(e && e.message))) throw e;
    const list = listModels || (async () => {
      const r = await fetchT(args.endpoint.replace(/\/chat\/completions$/, '/models'), { headers: { authorization: `Bearer ${args.key}` } }, 15000);
      if (!r.ok) throw new LaneError(`could not list models (${r.status})`);
      return ((await r.json()).data || []).map((m) => m.id);
    });
    const next = pickModel(await list(), prefer);
    if (!next || next === (known || args.model)) throw e;
    healed.set(args.endpoint, next);
    const from = known || args.model;
    // The has/add pair is synchronous — no await between them — so concurrent healers can't both pass:
    // the first to arrive records the switch, the rest see it and stay quiet.
    const switchKey = `${args.endpoint}\u0000${from}\u0000${next}`;
    if (typeof onHeal === 'function' && !announcedSwitches.has(switchKey)) {
      announcedSwitches.add(switchKey);
      try { onHeal({ from, to: next }); } catch { /* never fail a lane over a log line */ }
    }
    return chat({ ...args, model: next });
  }
}

// --- Google Gemini generateContent ----------------------------------------
async function geminiChat({ key, model, system, prompt, maxTokens, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
    }),
  }, timeoutMs);
  if (res.status === 429) throw new LaneError('rate limited (429)');
  if (!res.ok) throw new LaneError(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!text) throw new LaneError('empty completion');
  return text;
}

// --- local Ollama ----------------------------------------------------------
async function ollamaChat({ model, system, prompt, maxTokens, timeoutMs }) {
  const res = await fetchT(`${config.ollamaUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // num_ctx must be large or Ollama silently truncates a big prompt to its small default (~2k),
    // wrecking code generation over real files. Sized for the coder payloads; override via OLLAMA_NUM_CTX.
    body: JSON.stringify({ model, system, prompt, stream: false, options: { num_predict: maxTokens, num_ctx: Number(process.env.OLLAMA_NUM_CTX || 32768) } }),
  }, timeoutMs);
  if (!res.ok) throw new LaneError(`ollama ${res.status}`);
  const json = await res.json();
  const text = (json.response || '').trim();
  if (!text) throw new LaneError('empty completion');
  return text;
}

// --- Anthropic Messages (emergency backstop) -------------------------------
async function anthropicChat({ key, model, system, prompt, maxTokens, timeoutMs }) {
  const res = await fetchT('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  }, timeoutMs);
  if (res.status === 429) throw new LaneError('rate limited (429)');
  if (!res.ok) throw new LaneError(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  const text = json.content?.map((b) => b.text || '').join('').trim();
  if (!text) throw new LaneError('empty completion');
  return text;
}

// The hosted lanes — the free workhorses (groq/gemini/cerebras) + the frontier backstop. For code
// (coder:true) Groq uses a coder-tuned model and the strong free lanes go first; reliability then comes
// from the caller's test gate, not a paid model.
function hostedLanes({ coder }) {
  const groq = { engine: 'groq', when: () => !!config.groqKey(), run: (a) => openaiChatHealing({ endpoint: 'https://api.groq.com/openai/v1/chat/completions', key: config.groqKey(), model: coder ? config.groqCoderModel() : config.groqModel(), ...a },
      { prefer: GROQ_PREFER, onHeal: ({ from, to }) => logActivity({ kind: 'llm', status: 'model-retired', summary: `groq retired \`${from}\` — switched to \`${to}\` for this run; update GROQ_MODEL / GROQ_CODER_MODEL (lib/config.mjs defaults)` }) }) };
  const gemini = { engine: 'gemini', when: () => !!config.geminiKey(), run: (a) => geminiChat({ key: config.geminiKey(), model: config.geminiModel(), ...a }) };
  const cerebras = { engine: 'cerebras', when: () => !!config.cerebrasKey(), run: (a) => openaiChat({ endpoint: 'https://api.cerebras.ai/v1/chat/completions', key: config.cerebrasKey(), model: config.cerebrasModel(), ...a }) };
  const frontier = { engine: 'frontier', when: () => !!config.anthropicKey(), run: (a) => anthropicChat({ key: config.anthropicKey(), model: config.anthropicModel(), ...a }) };
  return coder ? [groq, cerebras, gemini, frontier] : [groq, gemini, cerebras, frontier];
}

// reason — think over `prompt` with `system` framing; return { text, engine }. Routes by COMPETENCE:
// the local fleet's best fit for the task goes first (local-first, $0, private), then the hosted free
// lanes, then the frontier backstop. `competence` overrides the dept/coder-derived default. `fallback`
// is the deterministic text used when every lane is unavailable, so a caller ALWAYS gets a usable
// answer. Never throws. When no local model is served the chain is exactly the hosted lanes.
export async function reason({ deptId = 'command', system = '', prompt = '', maxTokens = 320, fallback = '', coder = false, competence = null, timeoutMs = null, localOnly = false, hostedOnly = false } = {}) {
  const comp = competence || competenceFor({ deptId, coder });
  const args = { system, prompt, maxTokens, timeoutMs: timeoutMs || (coder ? CODER_TIMEOUT_MS : TIMEOUT_MS) };
  let localLanes = [];
  let primaryServed = false;
  try {
    const locals = await localLanesFor(comp); // served local models for this competence, best-first
    localLanes = locals.map((L) => ({ engine: L.engine, when: () => true, run: (a) => ollamaChat({ model: L.tag, ...a }) }));
    // Quality-first ordering: local leads ONLY when the competence's intended primary model is the one
    // actually served (e.g. qwen2.5-coder-14b for code-light). A weaker stand-in stays the LAST resort
    // behind the hosted lanes — so chat quality never degrades, but reasoning never dies to 429s either.
    const primary = (COMPETENCE[comp] || [])[0];
    primaryServed = !!primary && locals.some((L) => L.id === primary);
  } catch { localLanes = []; }
  // localOnly = never touch a paid/hosted API (the coding agent's default — no cloud, no cost).
  // hostedOnly = skip local entirely (the coder's ESCALATION path: when the local model is the thing
  // that's stalling, putting it first in the chain would just hand the round back to it).
  const chain = hostedOnly ? hostedLanes({ coder })
    : localOnly ? localLanes
    : primaryServed ? [...localLanes, ...hostedLanes({ coder })]
    : [...hostedLanes({ coder }), ...localLanes];
  for (const lane of chain) {
    if (lane.when && !lane.when()) continue;
    try {
      const text = await lane.run(args);
      if (text) return { text, engine: lane.engine };
    } catch (e) {
      process.stderr.write(`[llm] ${lane.engine} lane fell through: ${e.message}\n`);
    }
  }
  return { text: fallback, engine: 'fallback' };
}

// Pull the first balanced JSON object out of model text (code-fence tolerant). Throws if none.
export function extractJson(text) {
  const fence = String(text).match(/```json\s*([\s\S]*?)```/) || String(text).match(/```\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : String(text);
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model output');
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}' && --depth === 0) return JSON.parse(raw.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON in model output');
}

// Which lanes are live + a one-liner, for the dashboard/debrief.
export function llmInfo() {
  const s = llmStatus();
  const live = Object.entries(s).filter(([, v]) => v).map(([k]) => k);
  return { lanes: s, order: ['groq', 'gemini', 'cerebras', 'local', 'frontier'], live };
}
