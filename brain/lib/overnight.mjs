// The Overnight view — what the unattended agents did while nobody was watching.
//
// Two 4am cloud routines run every night: one on the applications (11:00 UTC) and one on seenjobs.io
// (11:30 UTC, staggered so it can read what the first recorded). Each writes its findings as brain
// facts plus ONE timeline entry — the digest. Those digests were the whole point and yet had nowhere to
// be seen: the routines insert straight into Supabase's brain_timeline, syncDown pulled only
// brain_notes, and Chronos rendered neither. Work happened overnight and left no visible trace.
//
// cloud.mjs now brings those rows home into the vault's day-notes. This reads them back out. It shows
// EVERY recent timeline entry, not just the ones tagged 4am, and badges the overnight ones — so a
// routine that forgets the heading convention is still visible rather than silently dropped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTimelineSections } from './cloud.mjs';

// Which lane wrote this, or null for an ordinary (human/session) timeline entry. Keyed on the heading
// convention both routine prompts are instructed to use: `4am — applications: …` / `4am — seenjobs.io: …`.
export function classifyLane(heading) {
  const h = String(heading || '').trim().toLowerCase();
  if (!/^4\s*am\b/.test(h)) return null;
  if (h.includes('seenjobs') || h.includes('product')) return 'seenjobs.io';
  if (h.includes('application') || h.includes('chronos') || h.includes('brain')) return 'applications';
  return 'overnight';
}

const dayBefore = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// Newest entry first. `readFile` is injectable so the parsing/ordering is testable without a vault.
export function readOvernight({ vaultPath, days = 7, today = null, readFile = null } = {}) {
  const start = today || new Date().toISOString().slice(0, 10);
  const read = readFile || ((abs) => { try { return readFileSync(abs, 'utf8'); } catch { return null; } });
  const entries = [];
  const seen = [];
  for (let i = 0; i < Math.max(1, days); i++) {
    const date = dayBefore(start, i);
    const text = vaultPath ? read(join(vaultPath, 'timeline', `${date}.md`)) : null;
    if (!text) continue;
    const sections = parseTimelineSections(text);
    if (!sections.length) continue;
    seen.push(date);
    // Within a day the file is append-ordered, so the newest entry is last — reverse it.
    for (const s of sections.reverse()) {
      entries.push({ date, heading: s.heading, body: s.body, lane: classifyLane(s.heading) });
    }
  }
  const runs = entries.filter((e) => e.lane).length;
  return { entries, days: seen, counts: { entries: entries.length, runs } };
}
