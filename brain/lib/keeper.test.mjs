// The hygiene verdict must not be able to claim more than it checked.
//
// What this pins, measured on the real vault 2026-08-15: keeper.review() already computed a
// staleness dimension and already set clean:false when it found any (contradictions 0, stale 53,
// clean false) — but scripts/brain-sync.mjs built the RECORDED fact separately, branching only on
// contradictions, and therefore wrote the literal string "clean — 218 current facts, 0
// contradictions". The hourly `Brain hygiene / keeper_verdict` fact every other session reads was
// asserting clean at the same moment its own producer said otherwise.
//
// Two claims are pinned here:
//   1. the word "clean" appears only when every dimension is clear, and
//   2. consistency and health are reported as DIFFERENT claims, because contradiction detection
//      compares facts to each other and can never notice that all of them are uniformly stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verdictLine, review } from './keeper.mjs';

// A vault holding ONE open fact recorded long enough ago to be stale. Written as raw note YAML
// because addFact always stamps `recorded` with today and the whole point is an old date.
function staleVault() {
  const v = mkdtempSync(join(tmpdir(), 'keeper-vault-'));
  mkdirSync(join(v, 'knowledge'), { recursive: true });
  writeFileSync(join(v, 'knowledge', 'k.md'),
    '---\ntitle: K\ntags: [knowledge]\nupdated: 2026-07-01\nfacts:\n'
    + '  - id: a-b\n    subject: A\n    predicate: b\n    object: one\n'
    + '    valid_from: 2026-07-01\n    valid_to: null\n    confidence: high\n    recorded: 2026-07-01\n'
    + '---\n\n# K\n');
  return v;
}

test('a vault with stale facts is never called clean', () => {
  const v = verdictLine({ contradictions: [], stale: ['a', 'b', 'c'], currentFacts: 218, clean: false, oldestStaleRecorded: '2026-07-07' });
  assert.ok(!/\bclean\b/.test(v), `verdict must not say clean: ${v}`);
  assert.match(v, /NOT verified/);
  assert.match(v, /3 stale/);
  assert.match(v, /oldest recorded 2026-07-07/);
});

test('the clean verdict states every dimension it checked, and its corpus', () => {
  const v = verdictLine({ contradictions: [], stale: [], currentFacts: 218, clean: true });
  assert.match(v, /^clean/);
  assert.match(v, /218 current facts/);
  assert.match(v, /0 contradictions/);
  assert.match(v, /0 stale/);
  // A verdict that does not name its corpus reads as vault-wide; the local vault and the Supabase
  // mirror genuinely disagree, so the scope has to travel with the number.
  assert.match(v, /local vault/);
});

test('contradictions lead the verdict and are quoted', () => {
  const v = verdictLine({ contradictions: ['X / y: "1" vs "2"'], stale: [], currentFacts: 10, clean: false });
  assert.match(v, /^1 contradiction\(s\)/);
  assert.match(v, /X \/ y/);
  assert.ok(!/\bclean\b/.test(v));
});

test('stale facts alone still report zero contradictions honestly', () => {
  // Consistency is a real, separate result: nothing disagrees. The verdict must say so without
  // letting it stand in for health.
  const v = verdictLine({ contradictions: [], stale: ['a'], currentFacts: 5, clean: false });
  assert.match(v, /consistent/);
  assert.match(v, /0 contradictions/);
  assert.match(v, /1 stale/);
});

// THE REGRESSION THIS FILE EXISTS FOR. The original bug was not in the sentence — it was in the
// WIRING: review() computed staleness correctly and brain-sync recorded a string it built itself.
// Testing verdictLine() alone leaves that hole wide open; reverting brain-sync to its old form kept
// the whole suite green. These two tests close it from both ends.
test('review() publishes the verdict, and it is the same one verdictLine produces', () => {
  const v = staleVault();
  const prev = process.env.CHRONOS_VAULT;
  process.env.CHRONOS_VAULT = v;
  try {
    const r = review();
    assert.equal(r.stale.length, 1, 'the backdated open fact reads as stale');
    assert.equal(r.contradictions.length, 0);
    assert.equal(r.clean, false, 'stale facts mean not clean');
    assert.equal(r.consistent, true, 'nothing disagrees, which is a separate claim from clean');
    assert.equal(r.oldestStaleRecorded, '2026-07-01');
    assert.equal(r.corpus, 'local vault', 'corpus names the store without leaking its path');
    // The published sentence must BE the shared one, not a lookalike.
    assert.equal(r.verdict, verdictLine(r));
    assert.ok(!/\bclean\b/.test(r.verdict), `review() must not publish a clean verdict here: ${r.verdict}`);
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_VAULT; else process.env.CHRONOS_VAULT = prev;
    rmSync(v, { recursive: true, force: true });
  }
});

test('brain-sync records the keeper verdict instead of rebuilding one', () => {
  // A source-level guard, in the same spirit as scripts/source-hygiene.test.mjs. The defect was a
  // SECOND definition of the verdict living in the recorder; this fails if one reappears.
  const src = readFileSync(new URL('../../scripts/brain-sync.mjs', import.meta.url), 'utf8');
  assert.match(src, /const verdict = r\.verdict \|\| verdictLine\(r\)/,
    'brain-sync must take the keeper verdict (falling back to the SAME verdictLine)');
  assert.ok(!/`clean — \$\{/.test(src),
    'brain-sync must not build its own "clean —" verdict string again');
});

test('a not-clean vault with no findings does not silently read as clean', () => {
  // Defensive: if some future dimension makes clean false without populating contradictions or
  // stale, the sentence must not fall through to "clean".
  const v = verdictLine({ contradictions: [], stale: [], currentFacts: 3, clean: false });
  assert.ok(!/^clean/.test(v), `must not open with clean: ${v}`);
  assert.match(v, /unclear/);
});

test('review() publishes the provenance mix of the facts it actually read', () => {
  // Wiring, not just the helper: the distribution has to reach the caller, or nothing can report
  // how much of the brain is evidence-backed rather than how much of it claims to be.
  const v = staleVault();
  const prev = process.env.CHRONOS_VAULT;
  process.env.CHRONOS_VAULT = v;
  try {
    const r = review();
    assert.ok(r.provenance, 'review() must publish provenance');
    assert.equal(r.provenance.total, r.currentFacts, 'the mix covers exactly the current facts');
    assert.equal(typeof r.provenance.evidenceBacked, 'number');
    assert.equal(typeof r.provenance.weak, 'number');
    assert.ok(r.provenance.counts && typeof r.provenance.counts === 'object');
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_VAULT; else process.env.CHRONOS_VAULT = prev;
    rmSync(v, { recursive: true, force: true });
  }
});
