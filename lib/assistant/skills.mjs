// Board Room SKILLS — instructions the assistant follows for a kind of request, written once as a file so
// the owner never has to explain it again (owner, 2026-10-21: "give it the ability to have new skills added
// in the future so I don't have to burn up my keypad explaining what I need it to do … we give it skill
// files and it notices when skills are added or removed or updated").
//
// A skill is a Markdown file with a small header:
//
//   ---
//   name: weekly-review
//   description: One line — what it does and when to use it.
//   when: phrases that should trigger it, comma separated (optional)
//   ---
//   Step-by-step instructions in plain words. They can name `act` verbs (node scripts/act.mjs …).
//
// Two folders, both live: `skills/` in this repo (shipped with the app) and `<data>/skills/` on this Mac
// (the owner's own; wins on a name clash). The roster (name + description) goes into every chat turn; the
// full text of a skill goes in when the message matches its `when` phrases or names it. Changes are
// noticed by a content hash, so an added / edited / removed skill is announced once (notification +
// the next chat turn) — never silently.
import { readdirSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT, dataDir } from '../paths.mjs';

export const SKILL_DIRS = () => [join(REPO_ROOT, 'skills'), join(dataDir(), 'skills')];
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function parseSkill(text, file = '') {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { error: `${basename(file)}: no '---' header` };
  const head = {};
  for (const line of m[1].split('\n')) { const kv = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line.trim()); if (kv) head[kv[1].toLowerCase()] = kv[2].trim(); }
  const name = String(head.name || basename(file, '.md')).toLowerCase();
  if (!NAME_RE.test(name)) return { error: `${basename(file)}: name must be lowercase letters, digits and dashes` };
  const description = String(head.description || '').slice(0, 300);
  if (!description) return { error: `${basename(file)}: needs a description` };
  const when = String(head.when || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3).slice(0, 20);
  const body = m[2].trim().slice(0, 8000);
  if (!body) return { error: `${basename(file)}: has no instructions` };
  return { name, description, when, body, hash: createHash('sha256').update(String(text)).digest('hex').slice(0, 16) };
}

export function loadSkills({ dirs = SKILL_DIRS() } = {}) {
  const byName = new Map(); const errors = [];
  for (const [i, dir] of dirs.entries()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('.')).sort()) {
      const path = join(dir, f);
      try {
        if (statSync(path).size > 64 * 1024) { errors.push(`${f}: larger than 64 KB`); continue; }
        const s = parseSkill(readFileSync(path, 'utf8'), f);
        if (s.error) { errors.push(s.error); continue; }
        byName.set(s.name, { ...s, file: path, origin: i === 0 ? 'built-in' : 'yours' }); // the Mac's own folder wins
      } catch (e) { errors.push(`${f}: ${e.message}`); }
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

// Which skills this message calls for: named outright, or one of its `when` phrases appears.
export function matchSkills(message, skills) {
  const t = ` ${String(message || '').toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ')} `;
  return skills.filter((s) => t.includes(` ${s.name.replace(/-/g, ' ')} `) || t.includes(` ${s.name} `) || s.when.some((w) => t.includes(` ${w.replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim()} `))).slice(0, 3);
}

// What changed since the last look: { added, updated, removed } by name. `prev` = { name: hash }.
export function diffSkills(prev = {}, skills = []) {
  const now = Object.fromEntries(skills.map((s) => [s.name, s.hash]));
  return {
    added: Object.keys(now).filter((n) => !(n in prev)),
    updated: Object.keys(now).filter((n) => n in prev && prev[n] !== now[n]),
    removed: Object.keys(prev).filter((n) => !(n in now)),
    now,
  };
}

// The block every chat turn gets: the roster, any skill this message calls for in full, and the changes
// not yet announced in chat.
export function skillsContext(message, { skills, changes = null } = {}) {
  if (!skills?.length && !changes) return '';
  const lines = [`SKILLS (${skills.length}) — follow a skill's steps when the request fits it; the owner can add, edit or remove skill files any time:`];
  for (const s of skills) lines.push(`• ${s.name} — ${s.description}`);
  const hit = matchSkills(message, skills);
  for (const s of hit) lines.push('', `SKILL "${s.name}" (this request matches it — follow these steps):`, s.body);
  if (changes && (changes.added.length || changes.updated.length || changes.removed.length)) {
    lines.push('', `SKILL CHANGES since you last looked — mention them briefly: ${[
      changes.added.length ? `added ${changes.added.join(', ')}` : '', changes.updated.length ? `updated ${changes.updated.join(', ')}` : '', changes.removed.length ? `removed ${changes.removed.join(', ')}` : ''].filter(Boolean).join('; ')}.`);
  }
  return lines.join('\n');
}

// A live watcher: checks the folders (cheap — a stat + hash of small files) every `everyMs` and on demand;
// calls onChange(diff) once per change. Keeps the last-seen hashes in memory and in `<data>/skills-seen.json`
// so a change made while the app was closed is still announced at the next start.
export function createSkillWatcher({ onChange = () => {}, everyMs = 15_000, statePath = join(dataDir(), 'skills-seen.json'), dirs } = {}) {
  let seen = {}; try { seen = JSON.parse(readFileSync(statePath, 'utf8')); } catch { seen = null; }
  let pendingForChat = null; let timer = null; let current = { skills: [], errors: [] };
  const save = (now) => { try { mkdirSync(dataDir(), { recursive: true }); writeJsonAtomic(statePath, now); } catch { /* best effort */ } };
  function check() {
    current = loadSkills(dirs ? { dirs } : undefined);
    const d = diffSkills(seen || {}, current.skills);
    if (seen === null) { seen = d.now; save(d.now); return current; } // first run ever: nothing to announce
    if (d.added.length || d.updated.length || d.removed.length) {
      seen = d.now; save(d.now);
      pendingForChat = pendingForChat ? { added: [...new Set([...pendingForChat.added, ...d.added])], updated: [...new Set([...pendingForChat.updated, ...d.updated])], removed: [...new Set([...pendingForChat.removed, ...d.removed])] } : d;
      try { onChange(d, current); } catch { /* a listener never breaks the watcher */ }
    }
    return current;
  }
  return {
    check,
    start() { check(); if (!timer) { timer = setInterval(check, everyMs); timer.unref?.(); } return this; },
    stop() { clearInterval(timer); timer = null; },
    list: () => current,
    // The chat turn takes the unannounced changes (once).
    takeChanges() { const c = pendingForChat; pendingForChat = null; return c; },
  };
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, path);
}
