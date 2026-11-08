// Instagram Knowledge Compiler — the safe Node↔Python adapter.
//
// The vendored Python video-to-software-compiler (tools/video-software-compiler) is the WORKER; this
// module is the ONLY bridge Seen Command uses to invoke it. Non-negotiable safety rules:
//   • Always spawn a FIXED executable (the venv python) with an ARGUMENT ARRAY. Never a shell string,
//     never `shell: true`, never string-interpolate a username / path / query / limit / phrase.
//   • Validate every Instagram username BEFORE any process starts.
//   • Minimal, controlled child environment — only the VSC_* the tool needs. Seen Command's `.env`
//     is never forwarded, read, or echoed.
//   • Bounded output + timeout. The compiler emits JSON on stdout for machine commands; we parse it.
//
// Dependency-free: built-in child_process / fs / path only.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.mjs';
import { sqliteStatus } from './db.mjs';

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

// Strip one optional leading `@`, then require the Instagram username charset. Returns the clean
// username, or null if invalid. Callers MUST reject null before spawning anything.
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().replace(/^@/, '');
  return USERNAME_RE.test(u) ? u : null;
}

// Flatten an options object into a typer-style flag array:
//   { project: 'x', limit: 50, allVideos: true } → ['--project','x','--limit','50','--all-videos']
// Only string / finite-number / boolean values are accepted; a true boolean becomes a bare flag, a
// false/null/undefined value is omitted. Everything is a discrete argv element — never concatenated.
export function toArgs(opts = {}) {
  const args = [];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null || v === false) continue;
    const flag = '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (v === true) { args.push(flag); continue; }
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    args.push(flag, String(v));
  }
  return args;
}

// The controlled child environment. PATH lets the tool find ffmpeg/ffprobe/tesseract; VSC_DATA_ROOT
// scopes ALL project I/O to our data root. Nothing from Seen Command's `.env`/process secrets is
// forwarded beyond the OS essentials.
function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: process.env.HOME || '',
    LANG: process.env.LANG || 'en_US.UTF-8',
    VSC_DATA_ROOT: config.vscDataRoot(),
    ...extra,
  };
}

// Redact the user's home path out of any human-facing string (never surface session/secret hints).
function redact(s) {
  const home = process.env.HOME;
  let out = String(s);
  if (home) out = out.split(home).join('~');
  return out.slice(0, 2000);
}

// Run ONE compiler subcommand with an argument array. Never a shell. Resolves (never rejects) with
// { ok, data|null, raw, error?, code? }. `data` is parsed JSON when the command emitted JSON.
export function runCompiler(subcommand, opts = {}, { timeoutMs = 20000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    const py = config.vscPython();
    if (!existsSync(py)) {
      resolvePromise({ ok: false, error: `compiler python not found (run the Instagram doctor/setup)`, code: 'NO_PYTHON', data: null, raw: '' });
      return;
    }
    if (typeof subcommand !== 'string' || !/^[a-z][a-z-]{1,40}$/.test(subcommand)) {
      resolvePromise({ ok: false, error: 'invalid compiler subcommand', code: 'BAD_SUBCOMMAND', data: null, raw: '' });
      return;
    }
    const args = ['-m', 'video_software_compiler', subcommand, ...toArgs(opts)];
    execFile(py, args, { cwd: config.vscToolDir(), env: childEnv(), timeout: timeoutMs, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      const raw = String(stdout || '');
      let data = null;
      try { data = JSON.parse(raw); } catch { /* plain-text command output */ }
      if (err) {
        resolvePromise({ ok: false, error: redact(String(stderr || err.message || 'compiler failed')), code: err.code || 'RUN_FAILED', data, raw });
        return;
      }
      resolvePromise({ ok: true, data, raw });
    });
  });
}

// --- doctor: explicit, visible dependency resolution (a packaged app has a restricted PATH) --------

function whichSync(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) return existsSync(cmd);
  // Resolve against an augmented PATH so Homebrew-installed tools (ffmpeg/claude) are found even when a
  // GUI-launched app inherits a minimal PATH.
  try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore', env: { ...process.env, PATH: config.toolPath() } }); return true; } catch { return false; }
}

function venvImport(mod) {
  const py = config.vscPython();
  if (!existsSync(py)) return false;
  try { execFileSync(py, ['-c', `import ${mod}`], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; }
}

// Instaloader stores a per-user session file locally; presence means a live run can OPTIONALLY
// authenticate. We never read its contents or the credentials — only whether the file exists.
// An authenticated session is NEVER required to run the feature: public profiles are ingested
// anonymously, and a login is only needed if Instagram itself rejects/rate-limits anonymous access.
function sessionState() {
  const user = config.instagramSessionUser();
  if (!user) {
    return { configured: false, available: false,
      detail: 'optional — no INSTAGRAM_SESSION_USER set; public profiles are ingested anonymously' };
  }
  const home = process.env.HOME || '';
  const candidates = [
    join(home, 'Library', 'Application Support', 'instaloader', `session-${user}`),
    join(home, '.config', 'instaloader', `session-${user}`),
    join(home, `.instaloader-session-${user}`),
  ];
  const available = candidates.some(existsSync);
  return { configured: true, available,
    detail: available
      ? `local Instaloader session for @${user}`
      : `@${user} configured but no local session — optional; authenticate in Terminal: instaloader --login ${user}` };
}

// A structured, honest availability report. `ok` is true only when every REQUIRED dependency is met.
export function doctor() {
  const py = config.vscPython();
  const pyOk = existsSync(py);
  const td = config.vscToolDir();
  // Verify the ACTUAL worker payload at the resolved (packaged or dev) location — not just that a dir
  // exists. A packaged bundle must carry pyproject.toml, the package, and cleanup.py.
  const toolFiles = { pyproject: existsSync(join(td, 'pyproject.toml')), pkg: existsSync(join(td, 'video_software_compiler')), cleanup: existsSync(join(td, 'video_software_compiler', 'cleanup.py')) };
  const toolOk = toolFiles.pyproject && toolFiles.pkg && toolFiles.cleanup;
  const sq = sqliteStatus();
  const checks = {
    compiler_python: { ok: pyOk, required: true, detail: pyOk ? py : `missing venv python (${py}) — set up the worker venv (npm run vsc:setup); dependencies are never silently installed` },
    compiler_tool: { ok: toolOk, required: true, detail: toolOk ? td : `incomplete worker payload at ${td} (${Object.entries(toolFiles).filter(([, v]) => !v).map(([k]) => k).join(', ')} missing)` },
    sqlite: { ok: sq.ok, required: true, detail: sq.ok ? 'node:sqlite (Library reads)' : sq.error },
    ffmpeg: { ok: whichSync('ffmpeg'), required: true, detail: 'audio/probe' },
    ffprobe: { ok: whichSync('ffprobe'), required: true, detail: 'metadata' },
    tesseract: { ok: whichSync('tesseract'), required: true, detail: 'OCR (visual text)' },
    instaloader: { ok: venvImport('instaloader'), required: true, detail: 'Instagram ingestion' },
    gallery_dl: { ok: venvImport('gallery_dl'), required: true, detail: 'business-profile fallback ingestion' },
    faster_whisper: { ok: venvImport('faster_whisper'), required: true, detail: 'spoken transcripts' },
    claude_cli: { ok: whichSync(config.claudeCliPath()), required: true, detail: 'knowledge extraction (local Claude Code CLI)' },
  };
  const missingRequired = Object.entries(checks).filter(([, c]) => c.required && !c.ok).map(([k]) => k);
  // Instagram ACCESS is reported separately and never makes the doctor fail: public profiles are
  // ingested anonymously; an authenticated session is optional and only needed if the actual live
  // retrieval is rejected/rate-limited (the job then stops honestly as needs_login).
  const ingestion = {
    anonymousFirst: true,
    authenticatedSession: sessionState(),
    note: 'Public profiles ingest anonymously with no login. An authenticated session is optional and '
      + 'used only when Instagram rejects/rate-limits anonymous access. Any login happens in Terminal '
      + 'outside Seen Command; no password ever enters .env, requests, job state, logs, or arguments.',
  };
  return { ok: missingRequired.length === 0, missingRequired, dataRoot: config.vscDataRoot(), checks, ingestion };
}
