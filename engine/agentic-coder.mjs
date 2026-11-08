#!/usr/bin/env node
// The AGENTIC coding lane — a model with FULL AGENCY over the repo, for the complex, feature-scale
// changes the local patch-coder (engine/coder.mjs) cannot do. That coder RETRIEVES a few windows and
// emits one-shot SEARCH/REPLACE blocks; it is excellent at a targeted fix with a concrete anchor, and it
// EXHAUSTED on all four whole-feature employer tasks (#93-#96 — 8-round deaths / stub PRs). Whole
// features need a loop, not a one-shot: ground in the real schema/auth/precedent → plan the smallest real
// version → implement across many files → verify against the gate → finish honestly.
//
// This is that loop. It was born speaking ONLY the Anthropic Messages API and died live with HTTP 400
// "credit balance too low" — so the loop is now PROVIDER-AGNOSTIC. ONE loop owns tools, budget, turns,
// the gate, and the ledger; provider translation lives behind createEngine(kind) adapters, so the same
// grounding/implement/verify machinery runs on $0 engines:
//
//   claude-cli  the local `claude` binary (a Claude subscription, not API credits) — its own agent, run
//               once, guarded post-hoc (it edits the tree directly).
//   cline       the open-source Cline CLI — full coding runtime with checkpoints, compaction, terminal,
//               retries, and model/provider routing; run headlessly, guarded post-hoc like claude-cli.
//   groq        OpenAI-compatible chat/completions + function tools           (free hosted)
//   cerebras    OpenAI-compatible chat/completions + function tools           (free hosted)
//   gemini      generateContent + functionDeclarations                        (free hosted)
//   anthropic   the original Messages tool_use shape                          (needs credits — last API resort)
//   ollama      optional local OpenAI-style tool calls                        ($0, private, if served)
//
// Dependency-free: `fetch` (injectable) for the API engines, spawnSync (injectable) for claude-cli, pure
// Node ESM. The API models never run shell — they propose FILE CONTENTS through a small, fully local,
// defensively-implemented tool surface, and the caller's TEST GATE (not any claim the model makes)
// decides whether the work ships. codeAgentically returns { summary, touched, engine } ONLY on a green
// gate and throws honestly otherwise — a drop-in alternative to codeLocally, so runBuild's
// git/branch/reviewer/commit/PR machinery downstream is UNCHANGED: agentic output ships the same way.
//
// Engine selection: env AGENTIC_ENGINE forces one. The DEFAULT is FREE-ONLY — cline (the open-source
// Cline CLI, if installed) → claude-cli (free subscription, if installed) → ollama (local) — so the
// coding path NEVER needs paid credits. The full chain (…groq → cerebras → gemini → anthropic → ollama,
// paid API last) is opt-in via AGENTIC_ENGINE=auto or CODER_PAID_OK=1. A STARTUP/auth failure (logged
// out, 401, 400 credit-balance, missing key, ECONNREFUSED) falls through to the next engine with an
// 'engine-fallthrough' ledger line. A mid-task error AFTER the first successful model turn does NOT
// switch engines — it throws honestly.
//
// Cost controls: a hard token budget (throws "agentic budget exhausted" when hit; usage is read from the
// provider when present, else estimated as JSON chars / 4 — conservative), a turn cap, a kill switch (the
// caller gates on CODER_AGENTIC + a configured engine), and one activity-ledger line per run.

import { execFileSync, spawnSync } from 'node:child_process';
import { nodeTestCommand } from './gate.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { config } from '../lib/config.mjs';
import { logActivity } from '../lib/activity.mjs';
import { clineSelection } from '../lib/credentials.mjs';
import { toolEnv, claudeCliEnv } from '../lib/tool-env.mjs';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const CEREBRAS_BASE = 'https://api.cerebras.ai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TOKENS_PER_CALL = 8000;   // per assistant turn — a whole file body + reasoning fits comfortably
const READ_LINES_CAP = 400;         // read_file never returns more than this many lines in one call
const GREP_LINES_CAP = 200;         // grep output cap
const TOOL_OUT_CAP = 6000;          // chars, per tool result fed back to the model
const CLAUDE_CLI_TIMEOUT_MS = 25 * 60 * 1000; // the `claude` agent gets a long leash for a whole feature
const CLINE_CLI_TIMEOUT_MS = 30 * 60 * 1000;
const FENCE_LINE = /^\s*`{3,}[\w-]*\s*$/; // a markdown code fence — never a real source file's first line (Seen #194)

// The playbook — verbatim spirit of what worked when four Claude implementation agents built these
// features by hand. The model is TOLD to ground before writing, to build the smallest REAL thing, to
// fake nothing, and to trust the gate over its own belief. The caller's repo stack + writable-path
// note arrive as extraContext (same as codeLocally receives) and are appended below.
const SYSTEM = `You are a precise senior engineer with FULL agency over a real, version-controlled repository. You implement complex, feature-scale changes the way a careful human does: ground, plan the smallest real version, implement across as many files as it truly takes, verify against a real test gate, then finish honestly.

THE PLAYBOOK — follow it in order:
1. GROUND FIRST. Before writing ANYTHING, read the code you are about to touch. grep for the relevant schema, auth, routes, config, and the nearest PRECEDENT; read_file the files that matter; list_dir to learn the layout. Match the repo's EXISTING patterns (imports, error handling, naming, house style). Never invent a convention this repo does not already use.
2. PLAN THE SMALLEST REAL VERSION. Deliver the smallest change that GENUINELY satisfies the task's "Done means" — real, wired-in, reachable code. Not a scaffold, not a demo, not a happy path that ignores the task.
3. IMPLEMENT coherently across every file the change needs (route + handler + helper + test, schema + reader + caller, etc.). Write whole file bodies with write_file. Wire everything up: a module nothing imports, a branch nothing reaches, or data nothing reads is NOT done.
4. NO FAKES. No placeholders, no lorem, no TODO stubs, no fabricated integrations, no invented function/module/endpoint names. If a piece of infrastructure the task assumes does NOT exist in this repo, do NOT invent it to make the premise "resolve" — implement what IS real and state plainly in your final summary what was missing and what you did instead.
5. VERIFY with run_gate and drive it to GREEN — it runs syntax checks plus the full test suite. If your change adds behavior, add or update a real test for it. A red gate is INFORMATION: read the errors, find the true cause, fix it. Never edit a test to hide a real failure.
6. FINISH HONESTLY. Only when run_gate is GREEN, call done({summary}). The summary states what actually changed and names any scope you deliberately cut — it is read by a human and by a senior reviewer, so it must be true.

You propose FILE CONTENTS, never shell scripts — you cannot run arbitrary commands. write_file enforces the repo's writable-path policy and rejects markdown-fenced bodies (write the RAW file contents, no \`\`\` wrapper). The test gate, not any claim you make, decides whether the work ships.`;

const KICKOFF = 'Begin by GROUNDING: grep and read the files this task touches, plus the nearest precedent, before you write anything. Then implement the smallest real version, verify with run_gate, and call done only once it is GREEN.';

// The brief handed to the `claude` CLI. It is that binary's OWN agent (its own file-editing + shell +
// test tools), so this is the playbook spirit — NOT a description of our internal tools — plus the one
// hard boundary: it may edit files but must never move the branch (we own git/commit/PR downstream).
function claudeBrief(task, extraContext) {
  return `${SYSTEM}

You are running in this repository via the claude CLI with your own editing and shell tools. GROUND in the real code first, implement the smallest REAL version across every file it needs, and run the project's test suite yourself until it is green. Fake nothing.

HARD BOUNDARY: edit files only. NEVER run git commit, git push, or otherwise move the branch — the calling system stages, commits, reviews, and opens the PR. Just leave the working tree with your edits.
${extraContext ? `\nREPO CONTEXT:\n${extraContext}\n` : ''}
When you are done, make the LAST line of your reply exactly:
SUMMARY: <one line, under 72 characters, imperative — it becomes the commit subject and PR title>

TASK:
${task}`;
}

// The tool surface, in a NEUTRAL shape (name + description + JSON schema). Each engine translates this to
// its provider's function/tool spec; each is implemented locally and defensively below — there is NO
// general shell; the API models propose contents, not commands.
const TOOL_DEFS = [
  { name: 'list_dir', description: 'List a directory (one level deep, with file sizes) to learn the repo layout. Path is relative to the repo root; defaults to the root.',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative directory, e.g. "engine" or "lib/connectors"' } } } },
  { name: 'read_file', description: 'Read a repo file with line numbers. Returns at most 400 lines per call; use offset to page through a larger file.',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative file path' }, offset: { type: 'integer', description: '1-based first line to read (default 1)' }, limit: { type: 'integer', description: 'max lines to read (default/cap 400)' } }, required: ['path'] } },
  { name: 'grep', description: 'Search tracked files with `git grep -n`. Use this to find where a symbol, string, route, or pattern lives before editing. Output is capped; pass a glob to narrow.',
    schema: { type: 'object', properties: { pattern: { type: 'string', description: 'the text/regex to search for' }, glob: { type: 'string', description: 'optional pathspec, e.g. "*.mjs" or "engine/*"' } }, required: ['pattern'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the given RAW contents (no markdown fences). Enforces the repo\'s writable-path policy; a rejected path returns an error you can react to. Write whole file bodies.',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative file path' }, content: { type: 'string', description: 'the full, raw file contents' } }, required: ['path', 'content'] } },
  { name: 'run_gate', description: 'Run the real verification gate (syntax check every touched file + the full test suite) and return {green, errors}. This is the source of truth for whether the change is correct.',
    schema: { type: 'object', properties: {} } },
  { name: 'run_cmd', description: 'Run one ALLOWLISTED read-only command: `node --check <file>`, `node --test <files>`, `ls`, `git status --porcelain`, or `git diff --stat`. Anything else is refused. Not a general shell.',
    schema: { type: 'object', properties: { cmd: { type: 'string', description: 'the exact command line' } }, required: ['cmd'] } },
  { name: 'done', description: 'Declare the work complete. Call ONLY after run_gate is green. The gate is re-run to confirm; if it is red you keep going. summary states what changed and any honest scope cuts.',
    schema: { type: 'object', properties: { summary: { type: 'string', description: 'what changed + any scope deliberately cut' } }, required: ['summary'] } },
];

// Provider-specific tool spec translations. Anthropic keeps its `input_schema` form (byte-identical to
// the original); the OpenAI-compatible lanes (groq/cerebras/ollama) use `{type:'function',function}`;
// Gemini uses one functionDeclarations block.
const anthropicTools = () => TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
const openaiTools = () => TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
const geminiTools = () => [{ functionDeclarations: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })) }];

// ---- path safety -----------------------------------------------------------
// Reads/inspections must stay INSIDE the repo. Writes are additionally governed by the caller's
// assertWritable (safe paths + PROTECTED intent). This resolves a model-supplied path and refuses any
// that escapes the root (../, absolute, or a symlinked breakout target).
function resolveInRepo(repoRoot, p) {
  const abs = resolve(repoRoot, String(p ?? '.'));
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the repo: ${p}`);
  return abs;
}

// ---- binaries that resolve in every launch context -------------------------
// A bare 'node'/'claude' is ENOENT under the packaged app's launchd PATH; probe the usual homes.
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const binPath = (name) => BIN_PATHS.map((p) => join(p, name)).find((f) => existsSync(f)) || name;
// Environment examples commonly use a bare command (`CLINE_CLI_PATH=cline`). Resolve that through
// the same packaged-app PATH probes; preserve explicit absolute/relative paths for custom installs.
const clineBinPath = () => {
  const configured = String(process.env.CLINE_CLI_PATH || '').trim();
  return configured && (isAbsolute(configured) || configured.includes('/')) ? configured : binPath(configured || 'cline');
};
function nodeBin() {
  const env = { ...process.env, PATH: [...BIN_PATHS, process.env.PATH || ''].join(':') };
  const real = BIN_PATHS.map((p) => join(p, 'node')).find((f) => existsSync(f));
  if (real) { delete env.ELECTRON_RUN_AS_NODE; return { bin: real, env }; }
  return { bin: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

const clip = (s, n = TOOL_OUT_CAP) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}\n… (truncated)` : t; };

// ---- tools (each returns { content, is_error?, ...meta }) -------------------
// list_dir: entries in `path`, plus one level of each subdirectory's contents (sizes for files).
function toolListDir(repoRoot, { path = '.' } = {}) {
  const abs = resolveInRepo(repoRoot, path);
  const st = statSync(abs);
  if (!st.isDirectory()) return { content: `${path} is a file (${st.size} bytes), not a directory` };
  const skip = new Set(['node_modules', '.git', 'dist', '.DS_Store']);
  const lines = [];
  const walk = (dir, prefix, depth) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(e.name) || lines.length > 300) continue;
      const child = join(dir, e.name);
      if (e.isDirectory()) { lines.push(`${prefix}${e.name}/`); if (depth > 0) walk(child, `${prefix}  `, depth - 1); }
      else { let size = 0; try { size = statSync(child).size; } catch { /* ignore */ } lines.push(`${prefix}${e.name} (${size}b)`); }
    }
  };
  walk(abs, '', 1);
  return { content: clip(`${path || '.'}:\n${lines.join('\n') || '(empty)'}`) };
}

function toolReadFile(repoRoot, { path, offset = 1, limit = READ_LINES_CAP } = {}) {
  if (!path) return { content: 'read_file needs a path', is_error: true };
  const abs = resolveInRepo(repoRoot, path);
  const all = readFileSync(abs, 'utf8').split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const cap = Math.min(Math.max(1, Number(limit) || READ_LINES_CAP), READ_LINES_CAP);
  const slice = all.slice(start - 1, start - 1 + cap);
  const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
  const end = start - 1 + cap;
  const more = all.length > end ? `\n… (${all.length - end} more lines — read_file with offset=${end + 1})` : '';
  return { content: clip(`${path} (${all.length} lines):\n${numbered}${more}`) };
}

function toolGrep(repoRoot, { pattern, glob } = {}) {
  if (!pattern) return { content: 'grep needs a pattern', is_error: true };
  const args = ['grep', '-n', '-I', '--no-color', '-e', String(pattern)];
  if (glob) args.push('--', String(glob));
  let out = '';
  try { out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { out = e.stdout ? String(e.stdout) : ''; } // git grep exits 1 on zero matches — not an error
  if (!out.trim()) return { content: `no matches for "${String(pattern).slice(0, 60)}"` };
  const lines = out.split('\n').filter(Boolean);
  const shown = lines.slice(0, GREP_LINES_CAP).join('\n');
  return { content: clip(lines.length > GREP_LINES_CAP ? `${shown}\n… (${lines.length - GREP_LINES_CAP} more — narrow with a glob)` : shown) };
}

// write_file — the ONE mutation. assertWritable violations and fence-wrapped bodies return an ERROR the
// model sees and reacts to; they NEVER throw (a bad edit must not kill the build — the task-31 lesson,
// and #194's fence). mkdir -p, ensure a trailing newline, record the touch.
function toolWriteFile(repoRoot, { path, content } = {}, { assertWritable, onTouched, touched }) {
  if (!path) return { content: 'write_file needs a path', is_error: true };
  try { assertWritable(path); }
  catch (err) { return { content: `path is OFF-LIMITS (${err.message}) — write under an allowed directory instead`, is_error: true }; }
  const body = String(content ?? '');
  const firstNonBlank = body.split('\n').find((l) => l.trim()) || '';
  if (FENCE_LINE.test(firstNonBlank)) {
    return { content: 'content begins with a markdown code fence (```) — write the RAW file body only, no fences (the Seen #194 non-compiling .tsx lesson)', is_error: true };
  }
  const abs = resolveInRepo(repoRoot, path); // belt-and-braces: assertWritable already blocks .. / .env / .git
  mkdirSync(dirname(abs), { recursive: true });
  const final = body.endsWith('\n') ? body : `${body}\n`;
  writeFileSync(abs, final);
  touched.add(path);
  if (onTouched) { try { onTouched(path); } catch { /* ignore */ } }
  const bytes = Buffer.byteLength(final);
  return { content: `wrote ${path} (${bytes} bytes)`, bytes };
}

function toolRunGate(repoRoot, gate, touched) {
  const g = gate(repoRoot, [...touched]) || { green: false, errors: ['gate returned nothing'] };
  const errCount = (g.errors || []).length;
  if (g.green) return { content: 'GATE GREEN ✓ — syntax + full test suite pass', green: true, errCount: 0 };
  return { content: clip(`GATE RED (${errCount}):\n${(g.errors || []).join('\n')}`), green: false, errCount };
}

// run_cmd — an ALLOWLIST, never a shell. The model gives a command line; we match it against a tiny set
// of read-only forms and run each via execFileSync with an EXPLICIT argv (no shell interpolation). File
// arguments are confined to the repo. Anything off the list returns a plain "not allowed".
function toolRunCmd(repoRoot, { cmd } = {}) {
  const raw = String(cmd || '').trim();
  const toks = raw.split(/\s+/).filter(Boolean);
  const notAllowed = () => ({ content: `not allowed: "${raw.slice(0, 60)}". Allowlist: node --check <file>, node --test <files>, ls [paths], git status --porcelain, git diff --stat. Propose file contents via write_file, not shell commands.` });
  const safe = (p) => { try { resolveInRepo(repoRoot, p); return true; } catch { return false; } };
  const run = (bin, args, env = process.env) => {
    try { return { content: clip(execFileSync(bin, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 180000, env }).trim() || '(no output)') }; }
    catch (e) { return { content: clip(`exit ${e.status ?? '?'}:\n${String(e.stdout || '').slice(-2000)}\n${String(e.stderr || e.message).slice(-500)}`) }; }
  };
  if (toks[0] === 'node' && toks[1] === '--check' && toks.length === 3) {
    if (!safe(toks[2])) return notAllowed();
    const nr = nodeBin(); return run(nr.bin, ['--check', toks[2]], nr.env);
  }
  if (toks[0] === 'node' && toks[1] === '--test' && toks.length >= 3) {
    const files = toks.slice(2);
    if (!files.every(safe)) return notAllowed();
    const cmd = nodeTestCommand(files); return run(cmd.bin, cmd.args, cmd.env); // the one definition (engine/gate.mjs)
  }
  if (toks[0] === 'ls') {
    const paths = toks.slice(1);
    if (!paths.every(safe)) return notAllowed();
    return run('ls', ['-la', ...paths]);
  }
  if (raw === 'git status --porcelain') return run('git', ['status', '--porcelain']);
  if (toks[0] === 'git' && toks[1] === 'diff' && toks[2] === '--stat' && toks.length === 3) return run('git', ['diff', '--stat']);
  return notAllowed();
}

// Dispatch one tool call (neutral { name, input }) → a tool_result payload, emitting a compact progress
// line. Any thrown error (missing file, bad input) becomes an is_error result — the loop never crashes.
function execTool(call, ctx) {
  const { name, input = {} } = call;
  const { repoRoot, say } = ctx;
  try {
    switch (name) {
      case 'list_dir': say(`[agentic] ls ${input.path || '.'}`); return toolListDir(repoRoot, input);
      case 'read_file': say(`[agentic] read ${input.path || '?'}`); return toolReadFile(repoRoot, input);
      case 'grep': say(`[agentic] grep ${String(input.pattern || '').slice(0, 48)}`); return toolGrep(repoRoot, input);
      case 'write_file': {
        const r = toolWriteFile(repoRoot, input, ctx);
        say(r.is_error ? `[agentic] write ${input.path || '?'} refused (${r.content.slice(0, 40)})` : `[agentic] wrote ${input.path} (${(r.bytes / 1024).toFixed(1)}kb)`);
        return r;
      }
      case 'run_gate': {
        const r = toolRunGate(repoRoot, ctx.gate, ctx.touched);
        say(`[agentic] gate ${r.green ? 'GREEN ✓' : `red (${r.errCount}) — iterating`}`);
        return r;
      }
      case 'run_cmd': say(`[agentic] cmd ${String(input.cmd || '').slice(0, 48)}`); return toolRunCmd(repoRoot, input);
      default: return { content: `unknown tool: ${name}`, is_error: true };
    }
  } catch (e) { return { content: `${name} failed: ${e.message}`, is_error: true }; }
}

// ---- token accounting ------------------------------------------------------
// Best-effort per provider: real usage when the provider reports it, else a conservative estimate of
// tokens ≈ JSON chars / 4 over the request + response (so the budget is still enforced when usage is
// absent, e.g. Ollama or a provider that omits the field).
const estimateTokens = (...objs) => Math.ceil(objs.reduce((n, o) => n + JSON.stringify(o ?? '').length, 0) / 4);
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// ---- fetch helper (injectable) ---------------------------------------------
// A non-2xx or a network throw is surfaced to the caller so the loop can classify it (startup → fall
// through; mid-task → honest). The response body is included so a credit-balance/401 reason is legible.
async function postJson(fetchFn, url, headers, body) {
  let res;
  try { res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error(`network error: ${e.message}`); }
  if (!res || !res.ok) {
    let detail = ''; try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${res ? res.status : '?'}: ${String(detail).slice(0, 200)}`);
  }
  return res.json();
}

// ---- engine adapters -------------------------------------------------------
// createEngine(kind) returns an adapter that owns its OWN native transcript and exposes a uniform
// interface to the one loop:
//   label                     the engine tag returned on success (agentic:<...>)
//   noToolCallLimit           how many bare "no tool call" nudges before a stall (Infinity = until turn cap)
//   pushUserText(text)        append a plain user message (the kickoff, or a nudge)
//   pushToolResults(results)  append the [{ id, name, content, is_error }] answers to the last tool calls
//   call() -> { text, toolCalls:[{ id, name, input }], tokens }   POST the transcript, append the reply
// A missing key / unconfigured provider throws from call() on turn 1 → the orchestrator treats any error
// before the first successful turn as a startup failure and falls through.
function createEngine(kind, { fetchFn, system, extraContext }) {
  const sys = system + (extraContext ? `\n\nREPO CONTEXT:\n${extraContext}` : '');

  if (kind === 'anthropic') {
    const model = process.env.AGENTIC_MODEL || config.anthropicModel();
    const messages = [];
    return {
      kind, model, label: `agentic:${model}`, noToolCallLimit: Infinity,
      pushUserText: (text) => messages.push({ role: 'user', content: text }),
      pushToolResults: (results) => messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) })) }),
      async call() {
        const key = config.anthropicKey();
        if (!key) throw new Error('agentic coder needs an Anthropic API key (ANTHROPIC_API_KEY / ANTHROPIC_KEY) — none configured');
        const body = { model, max_tokens: MAX_TOKENS_PER_CALL, system: sys, tools: anthropicTools(), messages };
        const json = await postJson(fetchFn, ANTHROPIC_URL, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body);
        const content = Array.isArray(json.content) ? json.content : [];
        messages.push({ role: 'assistant', content });
        const toolCalls = content.filter((b) => b && b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
        const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
        const u = json.usage || {};
        const tokens = (u.input_tokens || u.output_tokens) ? (u.input_tokens || 0) + (u.output_tokens || 0) : estimateTokens(body, json);
        return { text, toolCalls, tokens };
      },
    };
  }

  if (kind === 'groq' || kind === 'cerebras') {
    const isGroq = kind === 'groq';
    const base = isGroq ? GROQ_BASE : CEREBRAS_BASE;
    const keyOf = isGroq ? config.groqKey : config.cerebrasKey;
    const envName = isGroq ? 'GROQ_API_KEY' : 'CEREBRAS_API_KEY';
    const model = process.env.AGENTIC_MODEL || (isGroq ? config.groqCoderModel() : config.cerebrasModel());
    const messages = [{ role: 'system', content: sys }];
    return {
      kind, model, label: `agentic:${kind}:${model}`, noToolCallLimit: Infinity,
      pushUserText: (text) => messages.push({ role: 'user', content: text }),
      pushToolResults: (results) => { for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.is_error ? `ERROR: ${r.content}` : r.content }); },
      async call() {
        const key = keyOf();
        if (!base || !key) throw new Error(`agentic coder ${kind} lane needs ${envName} — none configured`);
        const body = { model, messages, tools: openaiTools(), tool_choice: 'auto', max_tokens: MAX_TOKENS_PER_CALL, temperature: 0.2 };
        const json = await postJson(fetchFn, `${base}/chat/completions`, { authorization: `Bearer ${key}` }, body);
        const msg = json.choices?.[0]?.message || {};
        messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
        const toolCalls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function?.name, input: safeJson(tc.function?.arguments || '{}') }));
        const tokens = json.usage?.total_tokens || estimateTokens(body, json);
        return { text: msg.content || '', toolCalls, tokens };
      },
    };
  }

  if (kind === 'gemini') {
    const model = process.env.AGENTIC_MODEL || config.geminiModel();
    const contents = [];
    return {
      kind, model, label: `agentic:gemini:${model}`, noToolCallLimit: Infinity,
      pushUserText: (text) => contents.push({ role: 'user', parts: [{ text }] }),
      pushToolResults: (results) => contents.push({ role: 'user', parts: results.map((r) => ({ functionResponse: { name: r.name, response: { content: r.content, ...(r.is_error ? { error: true } : {}) } } })) }),
      async call() {
        const key = config.geminiKey();
        if (!key) throw new Error('agentic coder gemini lane needs GEMINI_API_KEY / GOOGLE_API_KEY — none configured');
        const body = { systemInstruction: { parts: [{ text: sys }] }, contents, tools: geminiTools(), generationConfig: { maxOutputTokens: MAX_TOKENS_PER_CALL, temperature: 0.2 } };
        const json = await postJson(fetchFn, `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`, {}, body);
        const parts = json.candidates?.[0]?.content?.parts || [];
        contents.push({ role: 'model', parts });
        const toolCalls = parts.filter((p) => p && p.functionCall).map((p, i) => ({ id: `${p.functionCall.name}_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} }));
        const text = parts.filter((p) => p && p.text).map((p) => p.text).join('');
        const tokens = json.usageMetadata?.totalTokenCount || estimateTokens(body, json);
        return { text, toolCalls, tokens };
      },
    };
  }

  if (kind === 'ollama') {
    // Best served local coder first. Devstral 24B (agentic-tuned — Codex's find) leads for tool-call
    // work, then the strong qwen coders; if the preferred tag isn't pulled the first call 404s
    // "model not found" and we drop to the next candidate transparently.
    const candidates = process.env.AGENTIC_OLLAMA_MODEL
      ? [process.env.AGENTIC_OLLAMA_MODEL]
      : ['devstral:24b', 'qwen2.5-coder:32b', 'qwen3-coder:30b', 'qwen2.5-coder:14b'];
    let model = candidates[0];
    const messages = [{ role: 'system', content: sys }];
    return {
      kind, model, label: `agentic:ollama:${model}`, noToolCallLimit: 1, // one format-reminder, then it stalls (bounded)
      pushUserText: (text) => messages.push({ role: 'user', content: text }),
      pushToolResults: (results) => { for (const r of results) messages.push({ role: 'tool', content: r.is_error ? `ERROR: ${r.content}` : r.content }); },
      async call() {
        const body = { model, messages, tools: openaiTools(), stream: false, options: { num_ctx: Number(process.env.OLLAMA_NUM_CTX || 32768), num_predict: MAX_TOKENS_PER_CALL, temperature: 0.2 } };
        let json;
        try { json = await postJson(fetchFn, `${config.ollamaUrl()}/api/chat`, {}, body); }
        catch (e) {
          const next = candidates[candidates.indexOf(model) + 1];
          if (!next || !/not found|no such model|404/i.test(e.message)) throw e;
          model = next; this.model = model; this.label = `agentic:ollama:${model}`;
          json = await postJson(fetchFn, `${config.ollamaUrl()}/api/chat`, {}, { ...body, model });
        }
        const msg = json.message || {};
        messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
        const toolCalls = (msg.tool_calls || []).map((tc, i) => {
          const a = tc.function?.arguments;
          return { id: `oc_${i}_${tc.function?.name}`, name: tc.function?.name, input: typeof a === 'string' ? safeJson(a) : (a || {}) };
        });
        const tokens = (json.prompt_eval_count || 0) + (json.eval_count || 0) || estimateTokens(body, json);
        return { text: msg.content || '', toolCalls, tokens };
      },
    };
  }

  throw new Error(`unknown engine kind: ${kind}`);
}

// A startup failure — thrown before an engine's first successful model turn (missing key, 401, 400
// credit-balance, ECONNREFUSED, logged-out CLI, binary absent). The orchestrator falls through to the
// next engine on this; every OTHER error throws honestly.
class EngineStartupError extends Error { constructor(kind, reason) { super(`${kind} unavailable: ${reason}`); this.name = 'EngineStartupError'; this.kind = kind; this.reason = reason; } }

// A neutral tool_call → tool_result answer, shared by every engine. `done` is special (handled in the
// loop). Returns { id, name, content, is_error }.
function answerToolCall(call, ctx) {
  const r = execTool(call, ctx);
  return { id: call.id, name: call.name, content: r.content, is_error: !!r.is_error };
}

// ---- the one loop (API engines) --------------------------------------------
// Owns tools, budget, turns, the gate, and the ledger — identical for anthropic/groq/cerebras/gemini/
// ollama. Only the wire translation differs (the engine adapter). Throws EngineStartupError before the
// first successful turn (→ fall through); throws honestly after (budget, turn cap, mid-task API error).
async function runApiEngine(engine, ctx) {
  const { task, gate, repoRoot, touched, say, maxTurns, budgetTokens, taskSlice } = ctx;
  logActivity({ kind: 'agentic-coder', status: 'started', summary: taskSlice, detail: `engine ${engine.kind} · model ${engine.model}` });
  const fail = (why) => logActivity({ kind: 'agentic-coder', status: 'failed', summary: taskSlice, detail: `${engine.kind}: ${String(why).slice(0, 260)}` });

  engine.pushUserText(`TASK:\n${task}\n\n${KICKOFF}`);
  let totalTokens = 0;
  let turnsCompleted = 0;
  let noToolCalls = 0;

  const overBudget = (turn) => { fail(`budget: ${totalTokens} tokens over ${turn} turns`); return new Error(`agentic budget exhausted (${totalTokens} tokens, ${turn} turns) — needs a human or a bigger budget`); };

  for (let turn = 1; turn <= maxTurns; turn++) {
    let round;
    try { round = await engine.call(); }
    catch (e) {
      if (turnsCompleted === 0) throw new EngineStartupError(engine.kind, e.message); // never got a turn → fall through
      fail(`api error: ${e.message}`);
      throw new Error(`agentic coder (${engine.kind}): model call failed — ${e.message}`); // mid-task → honest
    }
    turnsCompleted += 1;
    totalTokens += round.tokens || 0;

    if (!round.toolCalls.length) {
      // The model talked without acting. Nudge it back to the tools. Ollama gets ONE reminder then
      // stalls (bounded); the frontier lanes nudge until the turn cap, as before.
      noToolCalls += 1;
      if (noToolCalls > engine.noToolCallLimit) {
        fail(`stalled: ${noToolCalls} turns with no tool call`);
        throw new Error(`agentic coder (${engine.kind}) stalled — produced no tool call after a format reminder`);
      }
      engine.pushUserText('Use the tools to do the work: ground with read_file/grep, edit with write_file, verify with run_gate, then call done({summary}) once the gate is GREEN. Respond with a tool call, not prose.');
      if (totalTokens >= budgetTokens) throw overBudget(turn);
      continue;
    }
    noToolCalls = 0;

    // Execute each tool call in order. `done` is special: re-run the gate OURSELVES (never trust the
    // model's claim). Green → return. Red → answer with the errors and keep going (budget permitting).
    const results = [];
    let finished = false; let finishedSummary = taskSlice;
    for (const call of round.toolCalls) {
      if (call.name === 'done') {
        const g = gate(repoRoot, [...touched]) || { green: false, errors: ['gate returned nothing'] };
        if (g.green) { results.push({ id: call.id, name: 'done', content: 'GATE GREEN — build accepted.', is_error: false }); finished = true; finishedSummary = String(call.input?.summary || task).slice(0, 400); break; }
        say(`[agentic] done called but gate red (${(g.errors || []).length}) — iterating`);
        results.push({ id: call.id, name: 'done', content: clip(`Not done — the gate is RED:\n${(g.errors || []).join('\n')}\nFix the real cause, re-run run_gate, then call done again.`), is_error: false });
        continue;
      }
      results.push(answerToolCall(call, ctx));
    }

    if (finished) {
      logActivity({ kind: 'agentic-coder', status: 'green', summary: taskSlice, detail: `${engine.kind} · ${turn} turns, ${totalTokens} tokens` });
      say(`[agentic] done — gate GREEN via ${engine.kind} (${turn} turns, ${totalTokens} tokens, ${touched.size} file(s))`);
      return { summary: finishedSummary, touched: [...touched], engine: engine.label };
    }

    engine.pushToolResults(results);
    if (totalTokens >= budgetTokens) throw overBudget(turn);
  }
  fail(`turn cap: ${maxTurns} turns, ${totalTokens} tokens`);
  throw new Error(`agentic coder hit its turn cap (${maxTurns} turns, ${totalTokens} tokens) without a green gate — needs a human or a bigger budget`);
}

// ---- claude-cli engine (separate execution path) ---------------------------
// Every wording the CLI uses for "you need to log in again". The original pattern missed the one that
// actually happened — "Failed to authenticate: OAuth session expired and could not be refreshed" — so an
// expired login read as an anonymous crash instead of the owner action it is.
export const CLAUDE_AUTH_FAILURE = /not logged in|please run .*login|authentication.*required|invalid api key|failed to authenticate|oauth (session|token).*(expired|invalid)|could not be refreshed/i;
// The CLI must authenticate as ITSELF. When the builder is launched from inside another Claude Code session
// (a developer running a build by hand), that session's markers and API routing leak into the child and
// break its own login. Strip them; everything else (PATH, HOME, the keychain) passes through.
export { claudeCliEnv };
// The local `claude` binary is its OWN agent: it edits the tree directly, so there is no in-loop tool
// surface to guard. We guard POST-HOC — diff the working tree before/after, enforce assertWritable + the
// no-fence rule on every file it touched, and gate the result. A startup failure (binary absent, logged
// out, nonzero exit) falls through to the next engine; a guard violation or a red gate throws honestly.
function gitPorcelainMap(repoRoot) {
  let out = '';
  // --untracked-files=all lists every NEW file individually; without it git collapses a brand-new
  // directory to a single "?? dir/" entry, which would hide the actual file paths the CLI created.
  try { out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }); } catch { return new Map(); }
  const m = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(' -> '); // a rename shows "old -> new"; the new path is what exists now
    if (arrow !== -1) path = path.slice(arrow + 4);
    m.set(path.replace(/^"|"$/g, ''), status);
  }
  return m;
}

async function runClaudeCli(ctx) {
  const { task, repoRoot, gate, assertWritable, onTouched, touched, say, extraContext, taskSlice, spawn, spawnInjected } = ctx;
  const bin = binPath('claude');
  if (!spawnInjected && !existsSync(bin)) throw new EngineStartupError('claude-cli', 'the `claude` binary is not installed on PATH');

  const git = (...a) => { try { return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }); } catch { return ''; } };
  const gitOk = (...a) => { try { execFileSync('git', a, { cwd: repoRoot, stdio: 'ignore' }); return true; } catch { return false; } };
  const before = gitPorcelainMap(repoRoot);
  logActivity({ kind: 'agentic-coder', status: 'started', summary: taskSlice, detail: 'engine claude-cli' });
  const fail = (why) => logActivity({ kind: 'agentic-coder', status: 'failed', summary: taskSlice, detail: `claude-cli: ${String(why).slice(0, 260)}` });
  say('[agentic] claude-cli — handing the task to the local claude agent (acceptEdits, no git)');

  let res;
  try {
    res = spawn(bin, ['-p', claudeBrief(task, extraContext), '--permission-mode', 'acceptEdits'],
      { cwd: repoRoot, encoding: 'utf8', timeout: CLAUDE_CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: toolEnv(bin, claudeCliEnv()) });
  } catch (e) { throw new EngineStartupError('claude-cli', `spawn failed: ${e.message}`); }

  const stdout = String(res?.stdout || ''); const stderr = String(res?.stderr || '');
  // Compute what it touched so a startup fall-through never leaves a half-edited tree for the next engine.
  const after = gitPorcelainMap(repoRoot);
  const touchedList = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
  const revert = () => { for (const f of touchedList) { if (gitOk('ls-files', '--error-unmatch', f)) gitOk('checkout', '--', f); else { try { execFileSync('rm', ['-f', join(repoRoot, f)], { stdio: 'ignore' }); } catch { /* ignore */ } } } };

  if (res?.error) { revert(); throw new EngineStartupError('claude-cli', `spawn error: ${res.error.message}`); }
  if (CLAUDE_AUTH_FAILURE.test(`${stdout}\n${stderr}`)) { revert(); throw new EngineStartupError('claude-cli', 'the claude CLI is not logged in'); }
  // Say what the CLI SAID. "claude CLI exited 1" was the whole record of the first real-model run's top
  // rung failing (2026-09-18) — the actual words were "OAuth session expired and could not be refreshed".
  if (res?.status !== 0) { revert(); const said = `${stderr}\n${stdout}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ⏎ ').slice(0, 240); throw new EngineStartupError('claude-cli', `claude CLI exited ${res?.status ?? '?'}${res?.signal ? ` (signal ${res.signal})` : ''}${said ? ` — ${said}` : ''}`); }

  // Post-hoc guards (the CLI has already edited the tree): every touched file must be writable per the
  // caller's policy and must NOT begin with a markdown fence. Any violation reverts the WHOLE change and
  // throws honestly — this is a real, completed attempt that broke a rule, not a fall-through condition.
  for (const f of touchedList) {
    try { assertWritable(f); }
    catch (e) { revert(); fail(`edited off-limits path ${f}`); throw new Error(`claude-cli edited an off-limits path (${f}): ${e.message} — reverted`); }
    let firstNonBlank = '';
    try { firstNonBlank = (readFileSync(join(repoRoot, f), 'utf8').split('\n').find((l) => l.trim()) || ''); } catch { /* deleted/binary — skip fence check */ }
    if (FENCE_LINE.test(firstNonBlank)) { revert(); fail(`wrote a markdown-fenced file ${f}`); throw new Error(`claude-cli wrote a markdown-fenced file (${f}) — reverted (the Seen #194 lesson)`); }
  }

  if (!touchedList.length) { fail('made no edits'); throw new Error('claude-cli produced no file changes — nothing to ship'); }
  for (const f of touchedList) { touched.add(f); if (onTouched) { try { onTouched(f); } catch { /* ignore */ } } }

  // The gate — not the CLI's word — decides. Green → ship; red → honest throw (the builder reverts via
  // onTouched and falls back to the patch-coder, exactly as for any other lane).
  const g = gate(repoRoot, touchedList) || { green: false, errors: ['gate returned nothing'] };
  if (!g.green) { fail(`gate red: ${(g.errors || [])[0] || ''}`); throw new Error(`claude-cli's change failed the gate:\n${(g.errors || []).join('\n')}`); }
  logActivity({ kind: 'agentic-coder', status: 'green', summary: taskSlice, detail: `claude-cli · ${touchedList.length} file(s)` });
  say(`[agentic] done — gate GREEN via claude-cli (${touchedList.length} file(s))`);
  // The agent's reply ends with a prose report, so the LAST line was whatever it happened to mention
  // last: PR Seen#293 was titled "- No brain/memory write-back: the `brain` MCP server failed to connect
  // this session (credential denied)." Prefer the SUMMARY: line the brief asks for; the builder sanitises
  // whatever any lane returns before it can become a subject (commitSubject).
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const declared = [...lines].reverse().find((l) => /^SUMMARY:/i.test(l));
  const summary = (declared ? declared.replace(/^SUMMARY:\s*/i, '') : `implemented via claude CLI: ${taskSlice}`).slice(0, 400);
  return { summary, touched: touchedList, engine: 'agentic:claude-cli' };
}

// Cline is the primary advanced open-source worker. `--yolo` is intentionally single-agent in Cline:
// spawn/team tools are disabled, avoiding parallel writers in one worktree. Cline still supplies its
// mature repo exploration, terminal, apply-patch, checkpoint, retry, and context-compaction runtime.
// Seen Command remains the authority: post-hoc path guards + our full gate decide whether it may ship.
async function runClineCli(ctx) {
  const { task, repoRoot, gate, assertWritable, onTouched, touched, say, extraContext, taskSlice, spawn, spawnInjected } = ctx;
  const bin = clineBinPath();
  if (!spawnInjected && !existsSync(bin)) throw new EngineStartupError('cline', 'the open-source `cline` CLI is not installed (run `npm install -g cline`)');

  const gitOk = (...a) => { try { execFileSync('git', a, { cwd: repoRoot, stdio: 'ignore' }); return true; } catch { return false; } };
  const before = gitPorcelainMap(repoRoot);
  const startHead = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch { return ''; } })();
  logActivity({ kind: 'agentic-coder', status: 'started', summary: taskSlice, detail: 'engine cline · checkpointed headless runtime' });
  const fail = (why) => logActivity({ kind: 'agentic-coder', status: 'failed', summary: taskSlice, detail: `cline: ${String(why).slice(0, 260)}` });
  say('[agentic] cline — checkpointed headless coding runtime (single writer, agentic compaction)');

  const system = `${SYSTEM}\n\nYou are running through the open-source Cline coding runtime. You may inspect the repo, edit files, and run tests. NEVER commit, push, change branches, deploy, or access .env/secrets; Seen Command owns git and shipping.${extraContext ? `\n\nREPO CONTEXT:\n${extraContext}` : ''}`;
  const args = ['--yolo', '--json', '--cwd', repoRoot, '--timeout', String(Math.floor(CLINE_CLI_TIMEOUT_MS / 1000)), '--retries', '5', '--compaction', 'agentic', '--thinking', 'high', '--system', system];
  const selected = clineSelection();
  args.push('--provider', selected.provider);
  if (selected.model) args.push('--model', selected.model);
  args.push(task);
  let res;
  try { res = spawn(bin, args, { cwd: repoRoot, encoding: 'utf8', timeout: CLINE_CLI_TIMEOUT_MS + 30000, maxBuffer: 64 * 1024 * 1024, env: toolEnv(bin) }); }
  catch (e) { throw new EngineStartupError('cline', `spawn failed: ${e.message}`); }

  const stdout = String(res?.stdout || ''); const stderr = String(res?.stderr || '');
  const after = gitPorcelainMap(repoRoot);
  const touchedList = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
  const revert = () => { for (const f of touchedList) { if (gitOk('ls-files', '--error-unmatch', f)) gitOk('checkout', '--', f); else { try { execFileSync('rm', ['-f', join(repoRoot, f)], { stdio: 'ignore' }); } catch { /* ignore */ } } } };
  const endHead = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch { return ''; } })();
  if (startHead && endHead !== startHead) { revert(); fail('moved git HEAD'); throw new Error('cline moved git HEAD despite the hard boundary — change rejected'); }
  if (res?.error) { revert(); throw new EngineStartupError('cline', `spawn error: ${res.error.message}`); }
  if (/unauthorized|missing api key|not authenticated|not logged in|authentication required/i.test(`${stdout}\n${stderr}`)) { revert(); throw new EngineStartupError('cline', 'Cline is not authenticated (run `cline auth`)'); }
  if (res?.status !== 0) { revert(); throw new EngineStartupError('cline', `Cline exited ${res?.status ?? '?'}${res?.signal ? ` (${res.signal})` : ''}: ${(stderr || stdout).slice(-240)}`); }

  for (const f of touchedList) {
    try { assertWritable(f); } catch (e) { revert(); fail(`edited off-limits path ${f}`); throw new Error(`cline edited an off-limits path (${f}): ${e.message} — reverted`); }
    let first = ''; try { first = readFileSync(join(repoRoot, f), 'utf8').split('\n').find((l) => l.trim()) || ''; } catch { /* deleted file */ }
    if (FENCE_LINE.test(first)) { revert(); fail(`wrote markdown-fenced file ${f}`); throw new Error(`cline wrote a markdown-fenced file (${f}) — reverted`); }
  }
  if (!touchedList.length) { fail('made no edits'); throw new Error('cline produced no file changes — nothing to ship'); }
  for (const f of touchedList) { touched.add(f); if (onTouched) { try { onTouched(f); } catch { /* ignore */ } } }
  const g = gate(repoRoot, touchedList) || { green: false, errors: ['gate returned nothing'] };
  if (!g.green) { fail(`gate red: ${(g.errors || [])[0] || ''}`); throw new Error(`cline's change failed the Seen Command gate:\n${(g.errors || []).join('\n')}`); }

  let summary = '';
  for (const line of stdout.split('\n')) { try { const event = JSON.parse(line); const text = event?.event?.text || event?.text || event?.result?.text; if (text) summary = String(text); } catch { /* NDJSON only */ } }
  summary = (summary.trim().split('\n').filter(Boolean).slice(-1)[0] || `implemented via Cline: ${taskSlice}`).slice(0, 400);
  logActivity({ kind: 'agentic-coder', status: 'green', summary: taskSlice, detail: `cline · ${touchedList.length} file(s) · external gate green` });
  say(`[agentic] done — Seen Command gate GREEN after Cline (${touchedList.length} file(s))`);
  return { summary, touched: touchedList, engine: 'agentic:cline' };
}

// ---- engine selection ------------------------------------------------------
const ALL_ENGINES = ['cline', 'claude-cli', 'groq', 'cerebras', 'gemini', 'anthropic', 'ollama'];
// FREE-ONLY is the default: the open-source Cline CLI (Codex's addition — routes to local/free
// providers), the free `claude` subscription (if installed), and the local Ollama coder. No paid API,
// no credits, no external service that can cut us off. Brandon's directive (2026-08-03): "make this
// free… we don't ever need to rely on an AI we didn't build." The paid/hosted lanes are opt-in only.
const FREE_ENGINES = ['cline', 'claude-cli', 'ollama'];
const AUTO_WORDS = ['auto', 'auto-all', 'all'];
// Cline joins a chain only when it's actually installed + not disabled — a missing binary would just
// burn a fallthrough on every run (Codex's clineConfigured guard, applied to BOTH chains).
const withCline = (chain) => (process.env.CLINE_AGENT !== '0' && existsSync(clineBinPath())
  ? chain : chain.filter((kind) => kind !== 'cline'));
function selectChain() {
  const forced = String(process.env.AGENTIC_ENGINE || '').trim().toLowerCase();
  if (forced && ![...AUTO_WORDS, 'free'].includes(forced)) {
    if (!ALL_ENGINES.includes(forced)) throw new Error(`unknown AGENTIC_ENGINE "${forced}" — valid: ${ALL_ENGINES.join(', ')} (or auto/free)`);
    return [forced];
  }
  // Full chain (includes the paid Anthropic API as a last resort) ONLY on explicit opt-in.
  if (AUTO_WORDS.includes(forced) || process.env.CODER_PAID_OK === '1') return withCline([...ALL_ENGINES]);
  return withCline([...FREE_ENGINES]); // DEFAULT (env unset, or AGENTIC_ENGINE=free)
}

// Whether ANY agentic engine is configured — used by the builder's kill-switch so the lane is offered
// whenever a $0 engine exists (claude CLI installed, or a free hosted key), not only when an Anthropic
// key is present. Ollama isn't cheaply probed here; a forced engine always counts.
export function agenticEngineConfigured() {
  // The free default chain's baseline is the local Ollama coder, which is always "available" — if the
  // server isn't up, the run startup-fails and the builder falls through to the patch coder honestly.
  // So the agentic lane is offered at $0 with no key (cline/claude-cli/hosted keys only ADD engines).
  return true;
}

// Is there an agent here that can be trusted to EXPLORE — to be handed a task the contract could not ground
// and find the right files itself? That is a different question from agenticEngineConfigured() above, which
// is always true because the local Ollama loop counts as "an engine". A 14B/32B model in a tool loop is not
// an exploring agent: on the first real-model run (2026-09-18) it "stalled — produced no tool call after a
// format reminder". Handing it an UNGROUNDED task is how unrelated, green, useless changes get made. So
// the grounding decision (engine/task-contract.mjs) asks THIS: a frontier agent (Cline, the claude CLI) is
// installed, or a hosted/frontier engine was explicitly selected. Login state is not probed here — an
// installed-but-logged-out agent fails at startup with its own words, which is an owner action, not a
// reason to fall back to guessing with a small model.
export function exploringAgentConfigured({ exists = existsSync } = {}) {
  let chain = [];
  try { chain = selectChain(); } catch { return false; }
  return chain.some((kind) => (kind === 'ollama' ? false : kind === 'claude-cli' ? exists(binPath('claude')) : true));
}

// ---- codeAgentically — the agentic build lane ------------------------------
// Same call shape as codeLocally so runBuild can swap lanes. Runs the selected engine chain: a startup
// failure falls through to the next engine (with an 'engine-fallthrough' ledger line); the first engine
// to reach a GREEN gate returns { summary, touched, engine }. If every engine falls through, the last
// engine's failure is thrown honestly. A mid-task error (after a successful turn) is thrown immediately —
// engines are NOT switched underneath a run that already started producing work.
export async function codeAgentically({ task, repoRoot, gate, assertWritable, extraContext = '', onEvent, onTouched,
  maxTurns = 48, budgetTokens = 600000, fetchFn = fetch, spawnFn = null } = {}) {
  const say = (m) => { if (onEvent) { try { onEvent(m); } catch { /* ignore */ } } };
  if (!task) throw new Error('agentic coder needs a task');
  if (typeof gate !== 'function') throw new Error('agentic coder needs a gate');
  if (typeof assertWritable !== 'function') throw new Error('agentic coder needs assertWritable');

  const touched = new Set();
  const taskSlice = String(task).slice(0, 140);
  const spawn = spawnFn || ((bin, args, opts) => spawnSync(bin, args, opts));
  const spawnInjected = !!spawnFn;
  const ctx = { task, repoRoot, gate, assertWritable, onTouched, touched, say, extraContext, maxTurns, budgetTokens, taskSlice, spawn, spawnInjected };

  const chain = selectChain();
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const kind = chain[i];
    const isLast = i === chain.length - 1;
    try {
      if (kind === 'cline') return await runClineCli(ctx);
      if (kind === 'claude-cli') return await runClaudeCli(ctx);
      const engine = createEngine(kind, { fetchFn, system: SYSTEM, extraContext });
      return await runApiEngine(engine, ctx);
    } catch (e) {
      if (e instanceof EngineStartupError && !isLast) {
        logActivity({ kind: 'agentic-coder', status: 'engine-fallthrough', summary: taskSlice, detail: `${kind}: ${e.reason}`.slice(0, 300) });
        say(`[agentic] ${kind} unavailable (${e.reason}) — falling through to ${chain[i + 1]}`);
        lastErr = e;
        continue;
      }
      // Last engine's startup failure, or any mid-task/honest error: surface it. Unwrap the startup
      // wrapper so the message the caller keys off (e.g. "needs an Anthropic API key") is preserved.
      if (e instanceof EngineStartupError) throw new Error(e.reason);
      throw e;
    }
  }
  throw lastErr ? new Error(lastErr.reason || lastErr.message) : new Error('no agentic engine available');
}
