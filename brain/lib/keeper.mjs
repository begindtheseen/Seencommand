#!/usr/bin/env node
// Chronos Keeper — the AI that manages the brain itself. Its advantage: it sees the ENTIRE memory
// graph at once, so it's the right home for the two things the exec team isn't built for —
//   (1) ANSWER questions over everything you know ("ask your brain"), grounded in the real facts, and
//   (2) KEEP the memory clean: flag contradictions + stale facts before the brain rots.
// Complementary to Seen Command (which acts); this is the knowledge layer (which knows).
//
// CLI:  node brain/lib/keeper.mjs ask "what do we know about pricing?"
//       node brain/lib/keeper.mjs review

import { fileURLToPath } from 'node:url';
import { readIndex } from './vault.mjs';
import { resolveSources } from './sources.mjs';
import { findContradictions, factTrueAsOf } from './chronos/memoryGraph.mjs';
import { provenanceMix } from './provenance.mjs';
// `reason` (../../lib/llm.mjs) is imported lazily inside ask() — it lives OUTSIDE brain/, and the
// packaged Chronos.app bundles only brain/lib/**. A static import here would make this whole module
// unloadable inside the app, taking review() — which needs no model at all — down with it. review()
// is what Chronos's Health view calls, so it must depend on nothing but the vault.

const DAY = 864e5;
function vault() { return resolveSources().vaultPath; }
const fmtFact = (f) => `${f.subject} — ${f.predicate} → ${f.object}${f.valid_to ? ` (until ${f.valid_to})` : ''}`;

// Rank facts by keyword overlap with a query/topic — the RETRIEVAL the exec team uses to pull the
// relevant slice of the brain into each agent's reasoning (and the ask() flow uses it too). Pure.
export function rankFacts(facts, q, n = 40) {
  const terms = String(q).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const score = (f) => { const s = `${f.subject} ${f.predicate} ${f.object}`.toLowerCase(); return terms.reduce((a, t) => a + (s.includes(t) ? 1 : 0), 0); };
  return facts.map((f) => [score(f), f]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, n).map(([, f]) => f);
}
const relevant = rankFacts;

// Ask the brain a natural-language question; answer grounded ONLY in current facts.
export async function ask(question) {
  const v = vault(); if (!v) throw new Error('no vault (set CHRONOS_VAULT)');
  const idx = readIndex(v);
  const current = idx.facts.filter((f) => factTrueAsOf(f, null));
  let facts = relevant(current, question);
  if (!facts.length) facts = current.slice(0, 40);
  // The decisions ledger answers "what did we decide about X" — facts alone miss locked calls.
  let decisions = [];
  try {
    const { parseDecisionsMd } = await import('../../lib/brain.mjs');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const all = parseDecisionsMd(readFileSync(join(v, 'decisions', 'log.md'), 'utf8'));
    const q = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    decisions = all.filter((d) => q.some((w) => (d.title + ' ' + d.detail + ' ' + d.section).toLowerCase().includes(w))).slice(0, 6);
    if (!decisions.length) decisions = all.slice(0, 4);
  } catch { /* no ledger */ }
  const decBlock = decisions.length ? `\n\nLocked DECISIONS from the ledger (also truth — cite as "Decision YYYY-MM-DD"):\n${decisions.map((d) => `- ${d.date} — ${d.title}${d.detail ? `: ${d.detail}` : ''}`).join('\n')}` : '';
  const system = "You are the Keeper of Brandon's business brain (Seen — a hiring-intelligence SaaS). "
    + 'Answer his question using ONLY the facts and decisions below; they are the current truth in his memory. Be direct '
    + 'and specific, and name the facts/decisions you used. If the brain does not contain the answer, say so plainly '
    + 'and suggest what he should record. 2–5 sentences, no preamble.';
  const prompt = `Question: ${question}\n\nCurrent facts in the brain (${current.length} total, ${facts.length} most relevant shown):\n${facts.map(fmtFact).join('\n')}${decBlock}`;
  // Reasoning over the brain (recall + judgement) → the 'reason' competence (DeepSeek-R1 when served).
  const { reason } = await import('../../lib/llm.mjs');
  const r = await reason({ deptId: 'strategy', competence: 'reason', system, prompt, maxTokens: 400,
    fallback: `No model lane is reachable, but here are the ${Math.min(6, facts.length)} facts closest to your question:\n${facts.slice(0, 6).map(fmtFact).join('\n')}` });
  return { answer: r.text, engine: r.engine, used: facts.length, ofTotal: current.length,
    facts: facts.slice(0, 8).map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object })) };
}

// Audit the brain's health: contradictions + facts that look stale (open but not refreshed).
export function review() {
  const v = vault(); if (!v) throw new Error('no vault (set CHRONOS_VAULT)');
  const idx = readIndex(v);
  const contradictions = findContradictions(idx.facts)
    .map((p) => `${p.a.subject} / ${p.a.predicate}: "${p.a.object}" (${p.a.note}) vs "${p.b.object}" (${p.b.note})`);
  const now = Date.now();
  const staleFacts = idx.facts
    .filter((f) => f.valid_to == null && f.recorded && (now - new Date(f.recorded).getTime()) > 14 * DAY);
  // Oldest computed WITHOUT reordering staleFacts: brain/renderer.html renders d.stale in array
  // order, and quietly changing the Health view's ordering is not part of this change.
  const oldestStaleRecorded = staleFacts.reduce(
    (oldest, f) => (oldest === null || String(f.recorded) < String(oldest) ? f.recorded : oldest), null);
  const stale = staleFacts.map((f) => `${fmtFact(f)} — last recorded ${f.recorded}`);
  const currentOpen = idx.facts.filter((f) => factTrueAsOf(f, null));
  const currentFacts = currentOpen.length;
  // How much of the brain is actually EVIDENCE-BACKED, as opposed to how much of it claims to be.
  // Consistency compares facts to each other and confidence is self-asserted; neither can answer
  // this. Derived from `source`, so no writer can inflate it.
  const provenance = provenanceMix(currentOpen);
  const clean = contradictions.length === 0 && stale.length === 0;
  return {
    facts: idx.facts.length,
    currentFacts,
    contradictions,
    stale,
    clean,
    // Consistency and health are DIFFERENT claims. `consistent` is the narrow one findContradictions
    // can actually decide: no two current facts disagree with each other. It says nothing about
    // whether any of them is still true, which is why a vault can be perfectly consistent and full
    // of rot. Surfaced separately so no caller has to infer one from the other.
    consistent: contradictions.length === 0,
    provenance,
    oldestStaleRecorded,
    // The corpus this verdict was computed over. The local vault and the Supabase mirror can and do
    // diverge, so a verdict that does not name its corpus invites a reader to treat a local-only
    // result as global. Deliberately NOT the absolute vault path — review() is returned verbatim as
    // an HTTP body by engine/server.mjs, and main.js already reports `sources` for that.
    corpus: 'local vault',
    // ONE definition of the verdict sentence, so a caller cannot re-derive a different one. The
    // recorded hygiene fact used to be built separately and branched only on contradictions, which
    // let it say "clean" while this same function reported clean:false with dozens of stale facts.
    verdict: verdictLine({ contradictions, stale, currentFacts, clean, oldestStaleRecorded }),
  };
}

// The single verdict sentence. Never says "clean" unless every dimension is clear.
//
// Its parameter names match review()'s own field names on purpose, so verdictLine(review()) returns
// exactly review().verdict. Callers that need to re-derive the sentence (brain-sync's fallback) can
// hand it the whole review object and get an identical result rather than a lookalike missing a
// field — a mismatch the round-trip test below caught during review.
//
// currentFacts defaults to null, not 0: an unknown count must read as unknown. Reporting a count
// nobody measured as "0 current facts" is the same overclaim this function exists to prevent.
export function verdictLine({ contradictions = [], stale = [], currentFacts = null, clean = false, oldestStaleRecorded = null } = {}) {
  const oldest = oldestStaleRecorded;
  const scope = `${currentFacts ?? '?'} current facts, local vault`;
  if (contradictions.length) {
    return `${contradictions.length} contradiction(s) — ${scope}: ${contradictions.slice(0, 3).join(' | ').slice(0, 400)}`;
  }
  if (stale.length) {
    return `consistent but NOT verified — ${scope}, 0 contradictions, ${stale.length} stale`
      + `${oldest ? ` (oldest recorded ${oldest})` : ''}`;
  }
  return clean
    ? `clean — ${scope}, 0 contradictions, 0 stale`
    : `unclear — ${scope}, 0 contradictions, 0 stale, but the health check did not pass`;
}

// ---- CLI -------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'ask') {
      const q = process.argv.slice(3).join(' ');
      if (!q) { console.error('usage: keeper.mjs ask "your question"'); process.exit(1); }
      const r = await ask(q);
      console.log(`\n${r.answer}\n\n— Keeper (${r.engine}, reasoned over ${r.used}/${r.ofTotal} facts)`);
    } else if (cmd === 'review') {
      const r = review();
      console.log(`Brain health — ${r.currentFacts} current facts of ${r.facts} total`);
      console.log(`Contradictions (${r.contradictions.length}):\n${r.contradictions.map((c) => '  • ' + c).join('\n') || '  none ✓'}`);
      console.log(`Possibly stale (${r.stale.length}):\n${r.stale.map((s) => '  • ' + s).join('\n') || '  none ✓'}`);
      console.log(r.clean ? '\n✓ Brain is clean.' : '\n⚠ Worth a look.');
    } else {
      console.log('usage:\n  keeper.mjs ask "question"\n  keeper.mjs review');
    }
  } catch (e) { console.error(`keeper ${cmd}: ${e.message}`); process.exit(1); }
}
