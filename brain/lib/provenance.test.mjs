// Trust derived from evidence, not from the writer's word.
//
// `confidence` is written by the same agent that writes the claim and is validated by nothing.
// Measured on the live vault: 209 of 233 open facts say "high" (89.7%), 14 medium, 3 verified,
// 7 unset. A field that says "high" nine times in ten cannot discriminate.
//
// provenance is computed from `source`, so it cannot be asserted. It does NOT replace confidence —
// both are surfaced, so a reader can see a "high" claim resting on a bare note-pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvenance, provenanceMix, PROVENANCE, UNCLASSIFIED, UNSOURCED } from './provenance.mjs';

const cls = (s) => classifyProvenance(s).name;

test('a measurement or an exact code location is the strongest class', () => {
  assert.equal(cls('brain/lib/cloud.mjs:253'), 'measured');
  assert.equal(cls('prod probe 2026-07-30'), 'measured');
  assert.equal(cls('source gate 1042/1042'), 'measured');
  assert.equal(cls('readback after write, 2026-08-15'), 'measured');
});

test('a commit, PR or URL is an artifact a reader can independently open', () => {
  assert.equal(cls('commit 598cf4a'), 'artifact');
  assert.equal(cls('PR #239'), 'artifact');
  assert.equal(cls('https://github.com/begindtheseen/Seen/pull/239'), 'artifact');
});

test('a file with no line points at the neighbourhood, not the claim', () => {
  assert.equal(cls('brain/lib/cloud.mjs'), 'code');
});

test('an owner statement is authoritative but is not a measurement', () => {
  // Deliberately its own class rather than folded into "measured": the owner DECIDES policy, which
  // is not the same as having measured a fact.
  assert.equal(cls('owner decision, session 2026-07-29'), 'owner');
});

test('a bare wiki-link cites no evidence — it points at more prose', () => {
  // This is the LARGEST group in the real vault: 30% of open facts.
  assert.equal(cls('[[claude-observations]]'), 'note-pointer');
  assert.equal(classifyProvenance('[[claude-observations]]').weight, 0.3);
});

test('missing or contentless sources are the weakest, and never throw', () => {
  for (const s of [undefined, null, '', '   ', 'null', 'session 2026-07-30']) {
    assert.equal(cls(s), 'unsourced', `${JSON.stringify(s)} must read as unsourced`);
  }
  assert.equal(classifyProvenance(undefined).weight, UNSOURCED.weight);
});

test('an unrecognised source falls back to a prior, not to zero or to strong', () => {
  // Mirrors SOURCE_TRUST's `?? 0.5`: unknown is a prior, not a verdict either way.
  const r = classifyProvenance('a sentence that cites nothing in particular');
  assert.equal(r.name, 'unclassified');
  assert.equal(r.weight, UNCLASSIFIED.weight);
  assert.ok(r.weight > UNSOURCED.weight && r.weight < 1.0);
});

test('classes are ordered strongest-first and weights stay on the 0..1 scale', () => {
  for (const c of PROVENANCE) {
    assert.ok(c.weight > 0 && c.weight <= 1, `${c.name} weight out of range`);
    assert.equal(typeof c.test, 'function');
  }
  const byName = Object.fromEntries(PROVENANCE.map((c) => [c.name, c.weight]));
  assert.ok(byName.measured > byName.code, 'a measurement outranks a bare file path');
  assert.ok(byName.code > byName['note-pointer'], 'code outranks a pointer to prose');
});

test('the mix separates evidence-backed facts from ones that merely claim to be', () => {
  const facts = [
    { source: 'brain/lib/cloud.mjs:253', confidence: 'high' },
    { source: 'PR #239', confidence: 'high' },
    { source: '[[claude-observations]]', confidence: 'high' },
    { source: '', confidence: 'high' },
  ];
  const mix = provenanceMix(facts);
  assert.equal(mix.total, 4);
  assert.equal(mix.evidenceBacked, 2);
  assert.equal(mix.weak, 2, 'a note-pointer and an unsourced fact are both weak');
  // All four assert "high". Provenance is what tells them apart.
  assert.equal(new Set(facts.map((f) => f.confidence)).size, 1);
});

test('provenanceMix is total on empty and malformed input', () => {
  assert.equal(provenanceMix([]).total, 0);
  assert.equal(provenanceMix([null, undefined, {}]).total, 3);
});

test('array order matches weight order, because first match wins', () => {
  // The order IS the semantics: classifyProvenance returns the first class that matches, so a
  // class sitting below a weaker one silently loses to it. owner (0.9) was originally placed after
  // artifact (0.8) and code (0.7), which made an owner source naming a file classify as `code`.
  const weights = PROVENANCE.map((c) => c.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a),
    `PROVENANCE must be strongest-first: ${PROVENANCE.map((c) => `${c.name}(${c.weight})`).join(' > ')}`);
});

test('an owner source still classifies as owner when it also names a file', () => {
  assert.equal(classifyProvenance('Owner instruction 2026-08-15; brain/lib/x.mjs').name, 'owner');
});

test('a date range is not a measurement, and a bare number is not a commit', () => {
  // Both observed in the real vault. "2026-08-05/06" is a day range, not a gate count; a long run
  // of digits is an epoch or an id, not a sha.
  assert.equal(classifyProvenance('nightly wave #7, 2026-08-05/06').name, 'unclassified');
  assert.equal(classifyProvenance('row 1786708807362').name, 'unclassified');
  // …while the real things still classify.
  assert.equal(classifyProvenance('source gate 1042/1042').name, 'measured');
  assert.equal(classifyProvenance('commit d814595').name, 'artifact');
});
