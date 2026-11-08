#!/usr/bin/env node
// brain-dedup — a SAFE cleanup for duplicate live facts the brain accumulated before the write-path
// dedup fix landed. The bug: brain/mcp/server.mjs `brain_add_fact` plain-appended, so every repeated
// add of the same subject+predicate piled on a NEW open fact (and `factTrueAsOf` surfaced all of them
// as currently true). Going forward that can't happen — both write paths now dedup through
// memory-write `recordFact`. This tool retires the duplicates that already exist.
//
// What it does, per note: group the OPEN facts (valid_to == null) by (note, subject, predicate)
// case-insensitively; where a group has more than one, KEEP the newest and CLOSE the rest via the
// bi-temporal primitive `closeFact` (valid_to + invalidated = today). Nothing is hard-deleted —
// as-of queries still see the retired facts as history. It also REPORTS (never touches) facts that
// look off-topic/orphaned, for Brandon to review by hand.
//
// DRY-RUN by default (prints what it WOULD collapse); pass --apply to write. `--json` for machine
// output. CLI:  node scripts/brain-dedup.mjs [--apply] [--json]

import { fileURLToPath } from 'node:url';
import { readIndex } from '../brain/lib/vault.mjs';
import { closeFact } from '../brain/lib/memory-write.mjs';
import { resolveSources } from '../brain/lib/sources.mjs';

// Recency key for a fact: full transaction timestamp first, then day-granular recorded, then the
// valid-from date. Newest sorts first; the fact id (which carries the -2/-3 append suffix) breaks ties
// so the LAST-written duplicate is the one we keep.
const stamp = (f) => String(f.recorded_at || f.recorded || f.valid_from || '');
function cmpNewestFirst(a, b) {
  const t = stamp(b).localeCompare(stamp(a));
  return t !== 0 ? t : String(b.id).localeCompare(String(a.id));
}

const pick = (f) => ({ note: f.note, id: f.id, subject: f.subject, predicate: f.predicate,
  object: f.object, confidence: f.confidence, recorded: f.recorded, valid_from: f.valid_from });

// Pure planner (exported for tests): from the full fact list, decide which duplicate live facts to
// collapse and which facts to merely FLAG. Never mutates anything.
//   collapses: [{ note, subject, predicate, keep, close: [facts…] }]  — close[] are retired, keep stays
//   review:    [{ reason, ...fact }]                                  — reported only, never collapsed
export function planDedup(facts = []) {
  const open = facts.filter((f) => f.valid_to == null);

  // group by (note, subject, predicate) — duplicates from the append bug live in the SAME note.
  const groups = new Map();
  for (const f of open) {
    const key = `${f.note}\u0000${String(f.subject).toLowerCase()}\u0000${String(f.predicate).toLowerCase()}`;
    const arr = groups.get(key); if (arr) arr.push(f); else groups.set(key, [f]);
  }
  const collapses = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const [keep, ...close] = [...arr].sort(cmpNewestFirst);
    collapses.push({ note: keep.note, subject: keep.subject, predicate: keep.predicate,
      keep: pick(keep), close: close.map(pick) });
  }

  // Off-topic / orphan REVIEW candidates — reported, never auto-collapsed. Deliberately conservative
  // so the list stays trustworthy: only low-confidence open facts (the shape a speculative one-off
  // free-form add takes). Contradictions + staleness already have a home in `keeper.mjs review`.
  const review = open
    .filter((f) => String(f.confidence).toLowerCase() === 'low')
    .map((f) => ({ reason: 'low confidence', ...pick(f) }));

  return { collapses, review };
}

// Apply a plan: close every duplicate (all but the kept newest). Returns the count closed.
export function applyDedup(vaultPath, plan, { date } = {}) {
  let closed = 0;
  for (const c of plan.collapses) {
    for (const f of c.close) { closeFact(vaultPath, { note: f.note, id: f.id, date }); closed++; }
  }
  return { closed };
}

// ---- CLI -------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');
  try {
    const vault = resolveSources().vaultPath;
    if (!vault) throw new Error('no vault found (set CHRONOS_VAULT to the seen repo\'s memory/ folder)');
    const plan = planDedup(readIndex(vault).facts);
    const dupTotal = plan.collapses.reduce((n, c) => n + c.close.length, 0);

    if (apply && dupTotal) applyDedup(vault, plan);

    if (asJson) {
      console.log(JSON.stringify({ vault, applied: apply, dupGroups: plan.collapses.length,
        factsClosed: dupTotal, review: plan.review, collapses: plan.collapses }, null, 2));
    } else {
      console.log(`Brain dedup — vault ${vault}`);
      console.log(`${apply ? 'CLOSED' : 'WOULD close'} ${dupTotal} duplicate live fact(s) across ${plan.collapses.length} group(s)${apply ? '' : '  (dry-run — pass --apply to write)'}\n`);
      for (const c of plan.collapses) {
        console.log(`• ${c.subject} — ${c.predicate}  (${c.note})`);
        console.log(`    keep : ${c.keep.id}  → ${c.keep.object}`);
        for (const f of c.close) console.log(`    close: ${f.id}  → ${f.object}`);
      }
      if (!plan.collapses.length) console.log('No duplicate live facts. ✓');
      console.log(`\nReview by hand (${plan.review.length}, NOT collapsed):`);
      for (const r of plan.review) console.log(`  • [${r.reason}] ${r.subject} — ${r.predicate} → ${r.object}  (${r.note})`);
      if (!plan.review.length) console.log('  none ✓');
    }
    if (!apply && dupTotal) process.exitCode = 1; // dry-run that found work → non-zero so scripts notice
  } catch (e) { console.error(`brain-dedup: ${e.message}`); process.exit(2); }
}
