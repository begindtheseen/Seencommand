// Secure, local credential management for Seen Command's Settings screen.
//
// The browser is never given stored values. It receives only configured/not-configured booleans.
// Writes are limited to this allowlist, reject multiline/NUL input, replace the runtime .env
// atomically, and force owner-only permissions. Cline BYOK credentials are handed once to Cline's
// own auth command (which owns its credential storage); Seen Command does not duplicate that key.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, chmodSync, openSync, writeFileSync, closeSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { dataDir, envPath } from './paths.mjs';
import { recordAIUsage } from './ai-usage.mjs';
import { toolEnv, claudeToolEnv } from './tool-env.mjs';

export const CREDENTIAL_GROUPS = [
  { id: 'github', label: 'GitHub', help: 'Issues, pull requests, checks, and gated writes.', fields: [
    { key: 'GITHUB_TOKEN', label: 'GitHub token' },
  ] },
  { id: 'seen', label: 'Seen admin', help: 'Live users, jobs, revenue, and error metrics.', fields: [
    { key: 'SEEN_ADMIN_USERNAME', label: 'Admin username' },
    { key: 'SEEN_ADMIN_PASSWORD', label: 'Admin password' },
  ] },
  { id: 'supabase', label: 'Supabase', help: 'Database health, advisors, migrations, and the online brain.', fields: [
    { key: 'SUPABASE_URL', label: 'Project URL' },
    { key: 'SUPABASE_SERVICE_KEY', label: 'Service-role key' },
    { key: 'SUPABASE_ACCESS_TOKEN', label: 'Management access token' },
    { key: 'SUPABASE_PROJECT_REF', label: 'Project reference' },
  ] },
  { id: 'deploy', label: 'Deployment and billing', help: 'Vercel deploy status and Stripe subscription data.', fields: [
    { key: 'VERCEL_TOKEN', label: 'Vercel token' },
    { key: 'VERCEL_PROJECT_ID', label: 'Vercel project ID' },
    { key: 'VERCEL_TEAM_ID', label: 'Vercel team ID' },
    { key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key' },
  ] },
  { id: 'aggregation', label: 'Aggregation (Seen ingest)', help: 'Local collectors → Seen. Paste the SAME values as the Vercel secrets LOCAL_INDEED_INGEST_SECRET / LOCAL_COMPANY_INTEL_INGEST_SECRET.', fields: [
    { key: 'SEEN_LOCAL_INGEST_TOKEN', label: 'Indeed ingest token' },
    { key: 'SEEN_COMPANY_INTEL_INGEST_TOKEN', label: 'Company-intel ingest token' },
  ] },
  { id: 'ai', label: 'AI providers', help: 'Reasoning and coding lanes. Blank fields remain unchanged.', fields: [
    { key: 'GROQ_API_KEY', label: 'Groq API key' },
    { key: 'GEMINI_API_KEY', label: 'Gemini API key' },
    { key: 'CEREBRAS_API_KEY', label: 'Cerebras API key' },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' },
  ] },
];

const ALLOWED = new Set(CREDENTIAL_GROUPS.flatMap((g) => g.fields.map((f) => f.key)));
const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
export const DEFAULT_CLINE_PROVIDER = 'cline';
export const DEFAULT_CLINE_MODEL = 'openai/gpt-5.3-codex';

function clineBin() {
  const configured = String(process.env.CLINE_CLI_PATH || '').trim();
  if (configured && (isAbsolute(configured) || configured.includes('/'))) return configured;
  const name = configured || 'cline';
  return BIN_PATHS.map((p) => join(p, name)).find((p) => existsSync(p)) || name;
}
export const clineExecutable = () => clineBin();

export function clineSelection() {
  const configuredProvider = String(process.env.CLINE_PROVIDER || '').trim();
  const configuredModel = String(process.env.CLINE_MODEL || '').trim();
  const provider = configuredProvider || DEFAULT_CLINE_PROVIDER;
  // Brandon explicitly rejected Qwen for coding. A stale Cline-account default must never silently
  // route a Seen Command build back to it; use the verified Codex coding model instead.
  const model = /qwen/i.test(configuredModel) ? DEFAULT_CLINE_MODEL
    : configuredModel || (provider === DEFAULT_CLINE_PROVIDER ? DEFAULT_CLINE_MODEL : '');
  return { provider, model };
}

function lastClineTest() {
  try { return JSON.parse(readFileSync(join(dataDir(), 'cline-connection.json'), 'utf8')); } catch { return null; }
}

function recordClineTest(value, file = join(dataDir(), 'cline-connection.json')) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  // A fresh verdict must show up immediately, not after the health cache expires.
  try { resetCliHealthCache(); } catch { /* cache is best-effort */ }
}

// Any completed Board Room Cline turn is a stronger connection proof than a synthetic test. Record
// it in the same secret-free status file so Settings/self-diagnosis does not call a working lane
// "unverified" immediately after the user watched it answer and use tools.
export function recordClineConnectionSuccess({ provider, model, latencyMs = 0, costUsd = 0, source = 'board-room' } = {}, { file } = {}) {
  const verified = {
    ok: true,
    at: new Date().toISOString(),
    provider: String(provider || 'cline'),
    model: String(model || 'provider default'),
    latencyMs: Number(latencyMs || 0),
    costUsd: Number(costUsd || 0),
    source,
  };
  recordClineTest(verified, file);
  return verified;
}

// ─── LOCAL AGENT-CLI HEALTH ───────────────────────────────────────────────────────────────────────
// Brandon, 2026-08-13: the Board Room "can barely tell if its running half the time". It could not,
// because nothing ever ASKED the lane whether it was alive. Settings replayed a RECORDED verdict
// (cline-connection.json) that outlives the binary it tested, so a lane that is 100% dead still
// rendered green. That is the exact failure on this machine right now: the last recorded Cline
// success is timestamped twelve seconds BEFORE the currently installed binary was written, and every
// invocation of that binary is SIGKILLed by macOS (exit 137, zero bytes on stdout AND stderr)
// because npm's copy invalidated its ad-hoc code signature.
//
// So: probe the lane, live, and let a recorded success only CONFIRM a probe that already passed.
// Three rules hold everywhere below, because a health check that lies is worse than none:
//   1. A failed probe is never "fine". Non-zero exit, a signal, or a spawn error is a failure.
//   2. UNKNOWN is its own answer (`null`), never `true`. A timeout is UNKNOWN, not healthy.
//   3. No credential value ever leaves this module — only booleans, versions, and classified reasons.
const CLI_HEALTH_TTL_MS = 60_000;
const CLI_PROBE_TIMEOUT_MS = 15_000;
const cliHealthCache = new Map();

// Diagnostics get called repeatedly (Settings render, every Board Room turn, `ops diagnose`). Cache
// briefly so that never means a process spawn per call, and expose a reset for tests/after a repair.
export function resetCliHealthCache() { cliHealthCache.clear(); }

function cachedHealth(key, { now, ttlMs }, compute) {
  const at = now();
  const hit = cliHealthCache.get(key);
  if (hit && at - hit.at >= 0 && at - hit.at < ttlMs) return { ...hit.value, cached: true };
  const value = compute();
  cliHealthCache.set(key, { at, value });
  return { ...value, cached: false };
}

// Third-party CLI output is echoed into diagnostics, so scrub anything token-shaped first. Cheap
// insurance: a health string is not worth leaking a key over.
const SECRETISH = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,})/g;
const clipSafe = (v, n = 200) => String(v ?? '').replace(SECRETISH, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, n);

// The default probe: ONE bounded, non-interactive spawn. stdin is /dev/null so a CLI that wants to
// prompt fails fast instead of hanging forever behind our timeout.
export function defaultCliProbe(bin, args, timeoutMs = CLI_PROBE_TIMEOUT_MS, { spawnSyncFn = spawnSync } = {}) {
  const r = spawnSyncFn(bin, args, {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], env: /(^|\/)claude$/.test(String(bin)) ? claudeToolEnv(bin) : toolEnv(bin),
  }) || {};
  const errCode = r.error ? (r.error.code || r.error.message) : null;
  return {
    exitCode: typeof r.status === 'number' ? r.status : null,
    signal: r.signal || null,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: errCode,
    timedOut: errCode === 'ETIMEDOUT',
  };
}

function binaryChangedAt(bin) {
  try { return new Date(statSync(bin).mtime).toISOString(); } catch { return null; }
}

// Why a probe that ran did not produce a usable answer. Returns null when the run was clean.
function probeFailure(label, p) {
  if (p.timedOut) return { runnable: null, reason: `${label} did not respond within the health-check timeout, so its state is UNKNOWN` };
  if (p.error === 'ENOENT') return { runnable: false, reason: `${label} is not installed on this machine` };
  if (p.error) return { runnable: false, reason: `${label} could not be started (${clipSafe(p.error, 80)})` };
  // SIGKILL with nothing on stdout OR stderr is macOS refusing to exec a binary whose ad-hoc code
  // signature no longer matches its contents — the exact state npm's global install leaves behind.
  if (p.signal === 'SIGKILL' || p.exitCode === 137) {
    return { runnable: false, reason: `${label} was killed by macOS the moment it launched (SIGKILL, no output) — its code signature is invalid` };
  }
  if (p.signal) return { runnable: false, reason: `${label} was terminated by ${p.signal} before it could answer` };
  if (p.exitCode !== 0) return { runnable: false, reason: `${label} exited ${p.exitCode ?? '?'}${p.stderr.trim() ? `: ${clipSafe(p.stderr, 160)}` : ' with no output'}` };
  return null;
}

export function claudeExecutable() {
  const configured = String(process.env.CLAUDE_CLI_PATH || '').trim();
  if (configured && configured !== 'claude' && existsSync(configured)) return configured;
  return BIN_PATHS.map((p) => join(p, 'claude')).find((f) => existsSync(f)) || configured || 'claude';
}

const CLAUDE_INSTALL_FIX = 'Install the Claude CLI (npm i -g @anthropic-ai/claude-code), then re-run diagnostics.';
const CLAUDE_LOGIN_FIX = 'Run `claude` then /login in Terminal (or `claude auth login`) to sign the CLI back in.';
const CLINE_RESIGN_FIX = 'Run `npm run agent:setup` to reinstall and re-sign the Cline binary (codesign --force --sign - …), then use Test connection in Settings.';
const CLINE_INSTALL_FIX = 'Run `npm run agent:setup` to install Cline, then `cline auth` to choose a provider.';

// Health of the LOCAL claude CLI — the lane that gives the Board Room real tools on a subscription
// rather than API credits. `authenticated` is TRI-STATE: true / false / null(UNKNOWN). Callers must
// render null as "unknown", never as working.
//
// Auth is read from `claude auth status --json`, which costs nothing and spends no tokens. Only
// loggedIn/authMethod/plan are kept — the account email and org id in that payload are deliberately
// dropped, because diagnostics has no need for them.
export function claudeCliHealth({
  probe = defaultCliProbe, bin = null, now = Date.now, ttlMs = CLI_HEALTH_TTL_MS, timeoutMs = CLI_PROBE_TIMEOUT_MS,
} = {}) {
  const path = bin || claudeExecutable();
  return cachedHealth(`claude:${path}`, { now, ttlMs }, () => computeClaudeHealth(probe, path, timeoutMs));
}

function computeClaudeHealth(probe, path, timeoutMs) {
  const base = {
    id: 'claude-cli', label: 'Claude CLI', path,
    installed: false, runnable: false, version: null,
    authenticated: null, authMethod: null, plan: null,
    reason: '', fix: CLAUDE_INSTALL_FIX, checkedAt: new Date().toISOString(),
  };
  if (path.includes('/') && !existsSync(path)) {
    return { ...base, reason: `the claude CLI is not installed at ${path}` };
  }
  const v = probe(path, ['--version'], timeoutMs);
  const vFail = probeFailure('the claude CLI', v);
  if (vFail) {
    const installed = v.error !== 'ENOENT';
    return {
      ...base, installed, runnable: vFail.runnable, reason: vFail.reason,
      fix: installed
        ? `Reinstall the Claude CLI (npm i -g @anthropic-ai/claude-code); the copy at ${path} exists but will not run.`
        : CLAUDE_INSTALL_FIX,
    };
  }
  const version = clipSafe(String(v.stdout).split('\n')[0], 80) || null;
  const a = probe(path, ['auth', 'status', '--json'], timeoutMs);
  const aFail = probeFailure('the claude CLI auth check', a);
  if (aFail) {
    // A logged-out CLI is a DEFINITE no, not an unknown — say so and hand over the exact fix.
    if (!a.timedOut && /not logged in|logged out|please (?:run )?.*login|\/login|no credentials/i.test(`${a.stdout}\n${a.stderr}`)) {
      return { ...base, installed: true, runnable: true, version, authenticated: false, reason: 'the claude CLI is installed but not logged in', fix: CLAUDE_LOGIN_FIX };
    }
    return {
      ...base, installed: true, runnable: true, version, authenticated: null,
      reason: `the claude CLI is installed (${version || 'version unknown'}) but its login state is UNKNOWN — ${aFail.reason}`,
      fix: `Run \`claude auth status\` in Terminal to see why the check failed; ${CLAUDE_LOGIN_FIX}`,
    };
  }
  let parsed = null;
  try { parsed = JSON.parse(a.stdout); } catch { parsed = null; }
  if (!parsed || typeof parsed.loggedIn !== 'boolean') {
    return {
      ...base, installed: true, runnable: true, version, authenticated: null,
      reason: `the claude CLI is installed (${version || 'version unknown'}) but \`claude auth status\` returned no readable login state — UNKNOWN`,
      fix: `Run \`claude auth status\` in Terminal; ${CLAUDE_LOGIN_FIX}`,
    };
  }
  if (!parsed.loggedIn) {
    return { ...base, installed: true, runnable: true, version, authenticated: false, reason: 'the claude CLI is installed but not logged in', fix: CLAUDE_LOGIN_FIX };
  }
  return {
    ...base, installed: true, runnable: true, version, authenticated: true,
    authMethod: clipSafe(parsed.authMethod, 40) || null,
    plan: clipSafe(parsed.subscriptionType, 40) || null,
    reason: `logged in via ${clipSafe(parsed.authMethod, 40) || 'the Claude CLI'}${parsed.subscriptionType ? ` (${clipSafe(parsed.subscriptionType, 40)} plan)` : ''}`,
    fix: null,
  };
}

// Health of the LOCAL Cline CLI. Cline exposes no free, non-interactive auth status subcommand — its
// only auth surface is the interactive `cline auth` — so `authenticated` here is UNKNOWN by design
// whenever the binary runs. What we CAN prove for free is whether it runs at all, and whether the
// recorded connection test still describes THIS binary.
export function clineCliHealth({
  probe = defaultCliProbe, bin = null, now = Date.now, ttlMs = CLI_HEALTH_TTL_MS, timeoutMs = CLI_PROBE_TIMEOUT_MS,
  lastTestFn = lastClineTest,
} = {}) {
  const path = bin || clineBin();
  return cachedHealth(`cline:${path}`, { now, ttlMs }, () => computeClineHealth(probe, path, timeoutMs, lastTestFn));
}

function computeClineHealth(probe, path, timeoutMs, lastTestFn) {
  const selected = clineSelection();
  let lastTest = null;
  try { lastTest = lastTestFn(); } catch { lastTest = null; }
  const base = {
    id: 'cline', label: 'Cline', path,
    installed: false, runnable: false, version: null,
    authenticated: null, provider: selected.provider, model: selected.model,
    lastTest, lastTestStale: false, binaryChangedAt: null,
    reason: '', fix: CLINE_INSTALL_FIX, checkedAt: new Date().toISOString(),
  };
  if (!existsSync(path)) return { ...base, reason: `Cline is not installed at ${path}` };
  const changedAt = binaryChangedAt(path);
  const v = probe(path, ['--version'], timeoutMs);
  const fail = probeFailure('Cline', v);
  if (fail) {
    const signatureKill = v.signal === 'SIGKILL' || v.exitCode === 137;
    return {
      ...base, installed: true, runnable: fail.runnable, binaryChangedAt: changedAt,
      reason: fail.reason,
      fix: signatureKill ? CLINE_RESIGN_FIX : `${CLINE_RESIGN_FIX} If it still fails, run \`cline --version\` in Terminal to see the raw error.`,
    };
  }
  // The binary runs. A recorded success is only proof of THIS binary if it happened after the binary
  // was written — a reinstall silently replaces the thing the green verdict was about.
  const stale = !!(lastTest?.ok && changedAt && lastTest.at && new Date(lastTest.at) < new Date(changedAt));
  return {
    ...base, installed: true, runnable: true, binaryChangedAt: changedAt, lastTestStale: stale,
    version: clipSafe(String(v.stdout).split('\n')[0], 80) || null,
    reason: stale
      ? 'Cline runs, but the recorded connection test predates the installed binary — that green is stale'
      : lastTest?.ok ? 'Cline runs and has a recorded successful connection test' : 'Cline runs but has no successful recorded connection test',
    fix: lastTest?.ok && !stale ? null : 'Use Test connection in Settings to verify this Cline build end to end.',
  };
}

function safeValue(value) {
  const v = String(value ?? '');
  if (v.length > 32768) throw new Error('credential value is too long');
  if (/[\r\n\0]/.test(v)) throw new Error('credential values cannot contain newlines or NUL bytes');
  return v;
}

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('refusing to replace a symlinked credential file');
  const tmp = join(dirname(file), `.env.seen-${process.pid}-${Date.now()}`);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, text, 'utf8');
    closeSync(fd); fd = null;
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function credentialStatus() {
  const selected = clineSelection();
  return {
    groups: CREDENTIAL_GROUPS.map((g) => ({ ...g, fields: g.fields.map((f) => ({ ...f, configured: !!String(process.env[f.key] || '').trim() })) })),
    cline: { installed: existsSync(clineBin()), provider: selected.provider, model: selected.model, lastTest: lastClineTest() },
  };
}

export function saveCredentials({ values = {}, clear = [] } = {}, { file = envPath() } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be an object');
  if (!Array.isArray(clear)) throw new Error('clear must be an array');
  const unknown = [...Object.keys(values), ...clear].filter((key) => !ALLOWED.has(key));
  if (unknown.length) throw new Error(`credential key is not allowed: ${unknown[0]}`);

  const changes = new Map();
  for (const [key, raw] of Object.entries(values)) {
    const value = safeValue(raw);
    if (!value) continue; // blank means unchanged; use clear for an intentional removal
    changes.set(key, value);
  }
  for (const key of clear) changes.set(key, '');
  if (!changes.size) return credentialStatus();

  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const seen = new Set();
  const lines = [];
  for (const line of original.split(/\r?\n/)) {
    const m = KEY_LINE.exec(line);
    const key = m && m[1];
    if (!key || !changes.has(key)) { lines.push(line); continue; }
    if (seen.has(key)) continue; // remove duplicate active definitions; first-definition precedence stays clear
    lines.push(`${key}=${JSON.stringify(changes.get(key))}`);
    seen.add(key);
  }
  for (const [key, value] of changes) if (!seen.has(key)) lines.push(`${key}=${JSON.stringify(value)}`);
  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  atomicWrite(file, text);
  for (const [key, value] of changes) process.env[key] = value;
  return credentialStatus();
}

function authPart(value, name, max = 256) {
  const v = String(value || '').trim();
  if (!v || v.length > max || /[\r\n\0]/.test(v)) throw new Error(`${name} is invalid`);
  return v;
}

export function configureCline({ provider, apiKey, model } = {}, { spawnSyncFn = spawnSync } = {}) {
  const p = authPart(provider, 'provider', 64);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(p)) throw new Error('provider is invalid');
  const key = authPart(apiKey, 'API key', 32768);
  if (/qwen/i.test(String(model || ''))) throw new Error('Qwen is disabled for Seen Command coding');
  const args = ['auth', '--provider', p, '--apikey', key];
  if (String(model || '').trim()) args.push('--modelid', authPart(model, 'model', 256));
  const result = spawnSyncFn(clineBin(), args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv(clineBin()) });
  if (result?.error) throw new Error(`Cline authentication could not start: ${result.error.code || 'spawn failed'}`);
  if (result?.status !== 0) throw new Error(`Cline rejected the credentials (exit ${result?.status ?? '?'})`);
  process.env.CLINE_PROVIDER = p;
  if (String(model || '').trim()) process.env.CLINE_MODEL = String(model).trim();
  return { ok: true, provider: p, modelConfigured: !!String(model || '').trim() };
}

export function startClineSignIn({ provider = 'cline' } = {}, { spawnFn = spawn } = {}) {
  const p = authPart(provider, 'provider', 64).toLowerCase();
  if (!['cline', 'openai-codex', 'oca'].includes(p)) throw new Error('that provider does not support browser sign-in');
  const child = spawnFn(clineBin(), ['auth', p], { detached: true, stdio: 'ignore', env: toolEnv(clineBin()) });
  child.on?.('error', () => {});
  child.unref?.();
  return { ok: true, provider: p, started: true };
}

export function testClineConnection(_input = {}, { spawnSyncFn = spawnSync } = {}) {
  const bin = clineBin();
  if (!existsSync(bin)) throw new Error('Cline is not installed. Run npm run agent:setup.');
  const selected = clineSelection();
  const dir = mkdtempSync(join(tmpdir(), 'seen-cline-test-'));
  const marker = 'CLINE_CONNECTION_OK';
  const args = ['--json', '--provider', selected.provider];
  if (selected.model) args.push('--model', selected.model);
  args.push('--cwd', dir, '--timeout', '60', '--thinking', 'low', '--auto-approve', 'false', '--system',
    `Connection check only. Do not call tools, inspect files, or modify anything. Reply with exactly ${marker}.`,
    `Reply with exactly ${marker}.`);
  const started = Date.now();
  let result;
  try { result = spawnSyncFn(bin, args, { encoding: 'utf8', timeout: 75000, stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv(bin) }); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* created temp only */ } }
  if (result?.error) {
    const killed = result.error.code === 'ETIMEDOUT' || result.signal === 'SIGKILL';
    throw new Error(killed ? 'Cline was stopped before it could answer. Run npm run agent:setup to repair its macOS signature.' : `Cline test could not start: ${result.error.code || 'spawn failed'}`);
  }
  if (result?.status !== 0) throw new Error(`Cline connection test failed (exit ${result?.status ?? '?'})`);
  let run = null;
  for (const line of String(result.stdout || '').split('\n')) {
    try { const event = JSON.parse(line); if (event.type === 'run_result') run = event; } catch { /* NDJSON only */ }
  }
  if (!run || !String(run.text || '').includes(marker)) throw new Error('Cline answered, but the connection test response was incomplete');
  const verified = {
    ok: true,
    at: new Date().toISOString(),
    provider: run.model?.provider || selected.provider,
    model: run.model?.id || selected.model || 'provider default',
    latencyMs: Number(run.durationMs || (Date.now() - started)),
    costUsd: Number(run.usage?.totalCost || 0),
  };
  if (/qwen/i.test(verified.model)) throw new Error('Cline selected Qwen, which is disabled for Seen Command coding');
  recordClineTest(verified);
  try { recordAIUsage({ provider: verified.provider, model: verified.model, surface: 'connection-test', costUsd: verified.costUsd }); } catch { /* diagnostics remain usable */ }
  return verified;
}
