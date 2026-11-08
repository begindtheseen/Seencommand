// A handoff written as a timeline episode is invisible to its addressee.
//
// The real instance: a session flagged another agent's stale fact only inside a timeline entry.
// The addressee reads FACTS, so it would never have seen it, and the stale fact would have stayed
// current indefinitely. Both writes return ok:true and neither knows the content was addressed to
// someone — that missing signal is what this adds.
//
// The detector is tuned for PRECISION. These entries name each other constantly in ordinary
// narration, so a rule that fires on any mention is alarm fatigue and would be ignored, which is
// worse than no warning at all. Measured against the real vault: 0 hits across 66 narrative
// episodes spanning three days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHandoff, handoffWarning } from './handoff-detect.mjs';

const fires = (heading, text) => detectHandoff({ heading, text }).handoff;

test('addressed handoffs are detected', () => {
  assert.ok(fires('HANDOFF FOR claude-brain from claude-seenjobs', 'read this'));
  assert.ok(fires('HANDOFF: rerun the canary', 'body'));
  assert.ok(fires('torch', 'Handing off to codex: please rerun the canary.'));
  assert.ok(fires('note', 'This is a handoff for codex.'));
  assert.ok(fires('note', 'Passing this over to claude-brain.'));
});

test('a request aimed at another agent is a handoff', () => {
  assert.ok(fires('note', 'claude-seenjobs should run the same sequence from a fresh container.'));
  assert.ok(fires('note', 'codex must close the duplicate open row.'));
});

test('ordinary narration that merely NAMES an agent stays quiet', () => {
  // This is the precision case that decides whether the warning gets read or ignored.
  assert.ok(!fires('x', 'claude-seenjobs closed the canary leg while I was writing.'));
  assert.ok(!fires('x', 'Codex squash-merged PR #189 into main as a785659.'));
  assert.ok(!fires('x', 'Every row resolved as exactly claude-brain with zero denials.'));
  assert.ok(!fires('x', 'Torch handoff closed with the writer issue delegated.'));
});

test('reading HANDOFF.md does not look like a handoff', () => {
  // Not hypothetical: every session reads HANDOFF.md at orientation and says so, and a bare
  // /\bHANDOFF\b/ fired on exactly this in real timeline data.
  assert.ok(!fires('x', 'Orientation read: AGENTS.md, brain/BRAIN.md and HANDOFF.md.'));
  assert.ok(!fires('x', 'On HANDOFF.md I read the current-state sections.'));
});

test('the warning names the consequence and the remedy, not just the match', () => {
  const w = handoffWarning(['handoff-banner']);
  assert.match(w, /does not surface in fact search/);
  assert.match(w, /brain_add_fact/);
  assert.match(w, /handoff-banner/);
});

test('detectHandoff is total — missing fields do not throw', () => {
  assert.equal(detectHandoff().handoff, false);
  assert.equal(detectHandoff({}).handoff, false);
  assert.equal(detectHandoff({ heading: null, text: undefined }).handoff, false);
});

test('a signal name containing $ cannot corrupt the warning', () => {
  // String.replace with a replacement STRING expands $&, $', $` and $1. A function replacement
  // does not, so the name appears literally.
  const w = handoffWarning(["weird-$&-name"]);
  assert.match(w, /weird-\$&-name/);
});
