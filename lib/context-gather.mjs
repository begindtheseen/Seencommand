// Capability-scoped local context retrieval for the Board Room's default conversational model.
// The model itself receives no write-capable shell. Instead, Seen Command performs narrowly-scoped,
// read-only path/search operations, then injects the evidence into the prompt. Explicit absolute files
// under the user's home may be read; broad searches stay inside the two configured repositories.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { config } from './config.mjs';

const MAX_FILE = 12000;
const MAX_SEARCH = 10000;
const pathInside = (file, root) => file === root || file.startsWith(`${root}${sep}`);
const clip = (s, n) => String(s || '').slice(0, n);
const sensitivePath = (file) => /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials?(?:\.[^/]*)?|\.ssh|\.aws|\.gnupg|Keychains?)(?:\/|$)/i.test(String(file || ''));
const SKIP_DIRS = new Set(['.git', '.claude', 'dist', 'node_modules', 'data']);

function fallbackSearch(root, needle, { readFile, readDir, stat, maxFiles = 2500 } = {}) {
  const queue = [root]; const hits = []; let scanned = 0;
  while (queue.length && scanned < maxFiles && hits.length < 20) {
    const dir = queue.shift();
    let entries = []; try { entries = readDir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (hits.length >= 20 || scanned >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) queue.push(file); continue; }
      if (!entry.isFile() || sensitivePath(file)) continue;
      let info; try { info = stat(file); } catch { continue; }
      if (!info.isFile() || info.size > 512 * 1024) continue;
      scanned += 1;
      let content; try { content = String(readFile(file, 'utf8')); } catch { continue; }
      if (content.includes('\0')) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < 20; i += 1) {
        if (lines[i].includes(needle)) hits.push(`${relative(root, file)}:${i + 1}:${lines[i]}`);
      }
    }
  }
  return hits.join('\n');
}

function allowedExplicitPath(candidate, roots, home) {
  if (!candidate || !isAbsolute(candidate)) return null;
  try {
    const real = realpathSync(candidate);
    const allowed = [...roots, home].some((root) => root && pathInside(real, realpathSync(root)));
    return allowed && !sensitivePath(real) ? real : null;
  } catch { return null; }
}

function explicitPaths(message) {
  // Token-shaped paths only. Avoid a nested, space-tolerant regex here: ordinary prose caused
  // catastrophic backtracking and could wedge the whole Board Room before the model even started.
  const matches = String(message).match(/\S+\/\S+\.[a-z0-9]{1,8}(?::\d+)?/gi) || [];
  return matches.map((p) => p.replace(/^[`"'(]+|[`"'),.;!?]+$/g, '').replace(/:\d+$/, '').trim()).filter(Boolean).slice(0, 3);
}

function searchNeedle(message) {
  const quoted = String(message).match(/[`"']([^`"'\n]{3,100})[`"']/);
  if (quoted) return quoted[1].trim();
  const m = String(message).match(/\b(?:find|search for|where is|where does|look for|locate)\s+(.{3,100}?)(?:\s+in\s+(?:the\s+)?(?:code|repo|repository|project))?[?.!]?$/i);
  return m ? m[1].replace(/[?.!]+$/, '').trim() : null;
}

function findNamedFile(name, roots, execFile) {
  const hits = [];
  for (const root of roots) {
    try {
      const files = execFile('rg', ['--files', '-g', `**/${basename(name)}`], { cwd: root, encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 });
      for (const rel of String(files).split('\n').filter(Boolean).slice(0, 3)) hits.push(resolve(root, rel));
    } catch { /* no match / rg unavailable */ }
  }
  return hits;
}

export function gatherLocalContext(message, {
  roots = [config.commandRepoDir(), config.productRepoDir()],
  home = homedir(),
  execFile = execFileSync,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
} = {}) {
  const text = String(message || '');
  const wantsLocal = /\b(file|code|repo|repository|local|implementation|implemented|source|function|class|module|route|endpoint)\b/i.test(text)
    || explicitPaths(text).length || /[`][^`]+[`]/.test(text);
  if (!wantsLocal) return '';
  const cleanRoots = roots.filter((r) => { try { return !!r && exists(r); } catch { return false; } });
  const blocks = [];
  const seen = new Set();
  for (const raw of explicitPaths(text)) {
    let candidates = [];
    if (isAbsolute(raw)) candidates = [allowedExplicitPath(raw, cleanRoots, home)].filter(Boolean);
    else {
      candidates = cleanRoots.map((r) => resolve(r, raw)).filter((p) => { try { return exists(p) && !sensitivePath(p); } catch { return false; } });
      if (!candidates.length) candidates = findNamedFile(raw, cleanRoots, execFile);
    }
    for (const file of candidates.slice(0, 2)) {
      if (seen.has(file) || sensitivePath(file)) continue;
      try {
        if (!stat(file).isFile()) continue;
        seen.add(file);
        blocks.push(`FILE ${file}\n${clip(readFile(file, 'utf8'), MAX_FILE)}`);
      } catch { /* unreadable */ }
    }
  }
  const needle = searchNeedle(text);
  if (needle && needle.length >= 3) {
    for (const root of cleanRoots) {
      try {
        const out = execFile('rg', ['-n', '-F', '--max-count', '20', '--glob', '!**/dist/**', '--glob', '!**/node_modules/**',
          '--glob', '!**/data/**', '--glob', '!**/.git/**', '--glob', '!**/.env*', '--glob', '!**/credentials*', needle, '.'],
          { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
        if (String(out).trim()) blocks.push(`SEARCH ${root} for ${JSON.stringify(needle)}\n${clip(out, MAX_SEARCH)}`);
      } catch (error) {
        // The packaged Mac normally has ripgrep, while a clean Linux CI/server may not. Preserve the
        // same bounded, repo-only read capability without making rg a hidden runtime dependency.
        if (error?.code === 'ENOENT' || error?.status == null) {
          const out = fallbackSearch(root, needle, { readFile, readDir, stat });
          if (out) blocks.push(`SEARCH ${root} for ${JSON.stringify(needle)}\n${clip(out, MAX_SEARCH)}`);
        }
      }
    }
  }
  return blocks.length ? `READ-ONLY LOCAL EVIDENCE (freshly gathered for this message):\n${blocks.join('\n\n')}` : '';
}

// ---------------------------------------------------------------------------
// The BRAIN as chat context — Chronos, not a snapshot
//
// The live Board Room lane (Cline, the free model) never receives the brain MCP tools; those are only
// on the claude-CLI path. So without this, the chat answered from an injected platform SNAPSHOT while
// the brain sat unread — which is how the chat once quoted a stale user count when the brain itself
// correctly held the current one. The snapshot is a derived board-meeting artifact; the brain is the durable record,
// so the brain WINS when they disagree, and the header says so explicitly.
//
// PURE: facts are passed in (server.mjs already holds `currentFacts`), so this needs no vault access
// and is fully unit-testable. Message-relevant facts are ranked first, then the remainder, capped.
export function brainContext(message, facts, { max = 40, objectChars = 240 } = {}) {
  if (!Array.isArray(facts) || !facts.length) return '';
  const toks = [...new Set(String(message || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || [])];
  // Weight the NAME of a fact far above its body. A predicate like `users_total` is what actually
  // answers "how many users"; a long prose fact that merely happens to contain the word "users"
  // somewhere in its object is not an answer. Scoring the concatenation equally let those long facts
  // outrank the real metric purely by having more text to match against, which would hand a free
  // model the wrong figure. Distinct tokens only, so repetition inside one object cannot inflate.
  const score = (f) => {
    const name = `${f.subject || ''} ${f.predicate || ''}`.toLowerCase();
    const body = String(f.object ?? '').toLowerCase();
    let s = 0;
    for (const t of toks) {
      if (name.includes(t)) s += 5;
      else if (body.includes(t)) s += 1;
    }
    return s;
  };
  const ranked = facts
    .map((f, i) => ({ f, s: score(f), i }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .slice(0, max);
  const line = ({ subject, predicate, object, note }) => {
    const o = String(object ?? '').replace(/\s+/g, ' ').trim();
    return `• ${subject} — ${predicate}: ${o.length > objectChars ? `${o.slice(0, objectChars)}…` : o}`
      + (note ? `  [${note}]` : '');
  };
  const hits = ranked.filter((r) => r.s > 0).length;
  return [
    'THE BRAIN (Chronos) — durable typed facts, bi-temporal, the authoritative record.',
    'If any of these disagree with the platform snapshot above, THE BRAIN IS RIGHT: the snapshot is a',
    'derived board-meeting artifact that can be stale or undercounting. Answer from these facts and say',
    'which fact you used. Never present a snapshot number as truth when a brain fact contradicts it.',
    hits ? `(${hits} of ${ranked.length} shown are keyword-relevant to this question.)` : '',
    ...ranked.map((r) => line(r.f)),
  ].filter(Boolean).join('\n');
}
