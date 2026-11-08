// Config & secrets — the one place Seen Command reads credentials. Dependency-free: on first import
// it parses a local `.env` file (if present) into process.env WITHOUT overriding anything already
// set by the shell/launchd, then every getter returns a typed value or null. A missing credential
// disables only that connector — the app still runs and the dashboard shows a "not configured" chip.
//
// Secrets live ONLY in `.env` (gitignored). `.env.example` documents the variable names.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, envPath, localVaultDir, seenHome, dataDir, primaryRepoRoot } from './paths.mjs';

// --- tiny .env parser (KEY=VALUE, # comments, optional quotes; never overrides real env) ----------
export function parseEnvValue(raw) {
  let val = String(raw ?? '').trim();
  if (val.startsWith('#')) return '';
  if (val.startsWith('"') && val.endsWith('"')) {
    try { return JSON.parse(val); } catch { return val.slice(1, -1); }
  }
  if (val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1);
  // dotenv-style inline comments begin after whitespace. Keep hashes inside real unquoted values
  // (tokens/URLs), but `KEY=   # explanation` is empty—not a literal path named "# explanation".
  val = val.replace(/\s+#.*$/, '').trim();
  return val;
}

function loadEnvFile(file) {
  if (!file || !existsSync(file)) return;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue; // real env wins
    process.env[key] = parseEnvValue(line.slice(eq + 1));
  }
}
// Runtime .env (SEEN_HOME/.env in the packaged app — seeded from the bundle) wins; the repo .env is
// the dev fallback. Loading both is additive since real/already-set keys are never overridden.
// Third: the PRIMARY checkout's .env when we're in a git worktree — .env is gitignored, so a worktree
// has none, and without this every credential silently reads as "not configured" (see primaryRepoRoot).
loadEnvFile(envPath());
loadEnvFile(join(REPO_ROOT, '.env'));
const primary = primaryRepoRoot();
if (primary) loadEnvFile(join(primary, '.env'));

const env = (k) => { const v = process.env[k]; return v && v.trim() ? v.trim() : null; };

// --- typed getters ---------------------------------------------------------
export const config = {
  // GitHub — control of the Seen repo (PRs, CI, issues; gated writes).
  githubToken: () => env('GITHUB_TOKEN') || env('GH_TOKEN'),
  githubRepo: () => env('SEEN_GITHUB_REPO') || 'begindtheseen/seen',
  githubBranch: () => env('SEEN_DEFAULT_BRANCH') || 'next-migration',
  // Seen Command's OWN repo — where the platform dept's self-improvement PRs land (not the product).
  commandRepo: () => env('SEEN_COMMAND_GITHUB_REPO') || 'begindtheseen/seen-command',
  commandBranch: () => env('SEEN_COMMAND_DEFAULT_BRANCH') || 'main',

  // Local git CHECKOUTS the builder operates on (branch/commit/push happen here). The builder needs a
  // real, writable git working tree — NOT the read-only packaged .app bundle (whose REPO_ROOT is
  // .../Contents/Resources/app). Resolution order, so the PACKAGED app works with zero config:
  //   product: SEEN_PRODUCT_REPO_DIR → the vault's parent (CHRONOS_VAULT = <seen>/memory, exactly how
  //            the brain finds the shared writer) → REPO_ROOT/../seen (dev layout).
  //   command: SEEN_COMMAND_REPO_DIR → REPO_ROOT if it is a real checkout (dev) → a `command-os`
  //            sibling of the product repo (the documented machine layout).
  productRepoDir: () => {
    const explicit = env('SEEN_PRODUCT_REPO_DIR');
    if (explicit) return resolve(explicit);
    const vault = env('CHRONOS_VAULT');
    if (vault) { const derived = resolve(vault, '..'); if (existsSync(join(derived, '.git'))) return derived; }
    return resolve(join(REPO_ROOT, '..', 'seen'));
  },
  commandRepoDir: () => {
    const explicit = env('SEEN_COMMAND_REPO_DIR');
    if (explicit) return resolve(explicit);
    if (existsSync(join(REPO_ROOT, '.git'))) return resolve(REPO_ROOT); // dev/CLI: this repo IS the checkout
    const vault = env('CHRONOS_VAULT');
    if (vault) { const sib = resolve(vault, '..', '..', 'command-os'); if (existsSync(join(sib, '.git'))) return sib; }
    return resolve(REPO_ROOT);
  },

  // Seen admin-stats — live business truth. No stored token; login with these at runtime.
  seenBaseUrl: () => (env('SEEN_BASE_URL') || 'https://seenjobs.io').replace(/\/+$/, ''),
  adminCreds: () => {
    const username = env('SEEN_ADMIN_USERNAME');
    const password = env('SEEN_ADMIN_PASSWORD');
    return username && password ? { username, password } : null;
  },

  // Supabase — health/advisors reads; migrations stay gated.
  supabase: () => {
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
    return url && key ? { url: url.replace(/\/+$/, ''), key } : null;
  },

  // Stripe — optional direct read of one-time payments (admin-stats' revenue funnel is the primary source).
  stripeKey: () => env('STRIPE_SECRET_KEY'),

  // Vercel — deploy status (optional).
  vercel: () => {
    const token = env('VERCEL_TOKEN');
    if (!token) return null;
    return { token, projectId: env('VERCEL_PROJECT_ID'), teamId: env('VERCEL_TEAM_ID') };
  },

  // Free/low-cost hosted LLM lanes — the reasoning workhorses. Tried in order (groq → gemini →
  // cerebras) before local Ollama and before the Anthropic backstop. Each is OpenAI- or Google-
  // compatible; a missing key just skips that lane.
  groqKey: () => env('GROQ_API_KEY'),
  // Groq has retired its defaults twice (qwen-2.5-coder-32b, then llama-3.3-70b-versatile — 2026-09). These are
  // today's ids; when they rot too, lib/llm.mjs openaiChatHealing finds a served model and logs the switch.
  groqModel: () => env('GROQ_MODEL') || 'openai/gpt-oss-120b',
  groqCoderModel: () => env('GROQ_CODER_MODEL') || 'openai/gpt-oss-120b',
  geminiKey: () => env('GEMINI_API_KEY') || env('GOOGLE_API_KEY'),
  geminiModel: () => env('GEMINI_MODEL') || 'gemini-2.5-flash',
  cerebrasKey: () => env('CEREBRAS_API_KEY'),
  cerebrasModel: () => env('CEREBRAS_MODEL') || 'gpt-oss-120b',

  // Frontier reasoning (emergency backstop only) — Anthropic Messages API.
  anthropicKey: () => env('ANTHROPIC_API_KEY') || env('ANTHROPIC_KEY'),
  anthropicModel: () => env('ANTHROPIC_MODEL') || 'claude-opus-4-8',

  // Local models. ollamaUrl is where the fleet is served; LOCAL_MODELS is an explicit comma-list of
  // served Ollama tags (e.g. "qwen3:32b,qwen3-coder:30b") the competence router treats as available —
  // authoritative even if the live probe is slow/off. Empty (default) → router relies on the probe only.
  ollamaUrl: () => (env('OLLAMA_URL') || 'http://localhost:11434').replace(/\/+$/, ''),
  localModels: () => (env('LOCAL_MODELS') || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Overnight co-CEO loop. The builder auto-ships ONLY tool-repo issues carrying this label (a human
  // or the board marks an issue safe-to-autobuild); nothing labeled → nothing built (no theater).
  // Caps the number of autonomous builds per night; auto-merge stays OFF unless explicitly enabled.
  overnightLabel: () => env('OVERNIGHT_BUILD_LABEL') || 'auto-build',
  overnightMaxBuilds: () => Number(env('OVERNIGHT_MAX_BUILDS') || 5),
  overnightAutoMerge: () => env('OVERNIGHT_AUTOMERGE') === '1',

  // Shared brain — the Chronos vault dir both Seen Command and Claude read/write. Defaults to a
  // local vault inside command-os; point at the seen repo's `memory/` to share with Claude's MCP.
  memoryDir: () => resolve(env('CHRONOS_VAULT') || env('SEEN_COMMAND_MEMORY_DIR') || localVaultDir()),

  // Instagram Knowledge Compiler (the local video-to-software worker). All values are non-secret
  // local paths / a username — NEVER an Instagram password (that stays in a local Instaloader session).
  // Safe defaults so the packaged app works with zero config: vendored tool dir, a venv under the
  // writable SEEN_HOME, projects under SEEN_HOME/data. A restricted packaged PATH means the doctor
  // command must resolve availability explicitly.
  vscToolDir: () => {
    const explicit = env('VSC_TOOL_DIR'); if (explicit) return resolve(explicit);
    // Packaged app: the worker is copied to <resources>/video-software-compiler (electron-builder
    // extraResources, outside asar so Python can execute it). Dev: the vendored source in the repo.
    const cands = [];
    if (process.resourcesPath) cands.push(join(process.resourcesPath, 'video-software-compiler'));
    cands.push(join(REPO_ROOT, 'tools', 'video-software-compiler'));
    for (const c of cands) { try { if (existsSync(join(c, 'pyproject.toml'))) return c; } catch { /* skip */ } }
    return cands[cands.length - 1];
  },
  vscPython: () => {
    const explicit = env('VSC_PYTHON');
    if (explicit) return explicit;
    // The venv is per-machine runtime state living under a writable data dir. Discover it in both
    // the packaged (userData) and dev (repo) locations so the doctor resolves it either way.
    const cands = [
      join(seenHome(), 'data', 'vsc-venv', 'bin', 'python'),
      join(process.env.HOME || '', 'Library', 'Application Support', 'seen-command', 'data', 'vsc-venv', 'bin', 'python'),
    ];
    for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* skip */ } }
    return cands[0];
  },
  // A PATH that also includes the usual macOS/Linux tool locations. A GUI-launched app (Electron)
  // inherits a minimal PATH (no /opt/homebrew/bin), so `which ffmpeg` / `which claude` would falsely
  // fail even when installed. Used for doctor lookups AND the compiler/Claude spawns so the worker can
  // actually find ffmpeg/ffprobe/tesseract/claude at runtime.
  toolPath: () => {
    const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', join(process.env.HOME || '', '.local', 'bin')];
    const cur = (process.env.PATH || '').split(':').filter(Boolean);
    return [...new Set([...cur, ...extra])].filter(Boolean).join(':');
  },
  vscDataRoot: () => resolve(env('VSC_DATA_ROOT') || join(dataDir(), 'instagram-projects')),
  vscDefaultLimit: () => { const n = Number(env('VSC_DEFAULT_LIMIT') || 50); return Number.isInteger(n) && n > 0 ? n : 50; },
  claudeCliPath: () => env('CLAUDE_CLI_PATH') || 'claude',
  instagramSessionUser: () => env('INSTAGRAM_SESSION_USER'),

  port: () => Number(env('PORT') || 4173),
};

// One-line configured/not-configured status per connector — the dashboard renders this so Brandon
// sees exactly what's live vs. what needs a key.
export function connectorStatus() {
  return {
    github: !!config.githubToken(),
    admin_stats: !!config.adminCreds(),
    supabase: !!config.supabase(),
    stripe: !!config.stripeKey(),
    vercel: !!config.vercel(),
    frontier: !!config.anthropicKey(),
  };
}

// Which reasoning lanes are wired, in the order reason() tries them. The dashboard shows this so
// Brandon sees the board meeting is running on a real model, not the deterministic fallback.
export function llmStatus() {
  return {
    groq: !!config.groqKey(),
    gemini: !!config.geminiKey(),
    cerebras: !!config.cerebrasKey(),
    anthropic: !!config.anthropicKey(),
  };
}
