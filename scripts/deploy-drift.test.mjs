// A monitor must not bake a decaying claim into a durable fact.
//
// deploy-drift writes its verdict into the brain as `Seen production deploy / merge_vs_deploy`.
// It used to say "(deployed 10 min ago)". Two things were wrong with that, and both are the same
// mistake: a point-in-time assertion embedded in prose with no validity window.
//
//   1. It DECAYS. "deployed 10 min ago" is false ten minutes later and absurd a day later, and it
//      sits in a fact that stays current until something supersedes it. The bi-temporal fields
//      already answer "when was this checked" — `recorded`/`recorded_at` exist for exactly that.
//   2. It CHURNED. recordFacts supersedes on change, and the age differed on every run, so an
//      unchanged deploy minted a new row every hour. Measured in the real vault: all 6
//      merge_vs_deploy rows carried an age (10, 2, 12, 5 …) and differed only by it — while the
//      module header claimed the fact "cannot churn".
//
// Importing this module is itself part of the test: before the isMain guard, deploy-drift ran its
// whole check and called process.exit() at import, so none of this could be tested at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftVerdict, isDrifted, isMainModule } from './deploy-drift.mjs';

const DEPLOYED = Date.parse('2026-08-15T05:06:02Z');
const RELATIVE = /\b(\d+\s*(?:min|minute|hour|hr|day)s?\s+ago|just now|moments ago|right now)\b/i;

test('the verdict is a pure function of deploy state, not of when it is read', () => {
  const args = { branch: 'next-migration', tip: 'a'.repeat(40), prodSha: 'a'.repeat(40), deployedMs: DEPLOYED };
  // Same state evaluated twice must be byte-identical. When it was not, an unchanged deploy still
  // superseded the fact on every hourly run.
  assert.equal(driftVerdict(args), driftVerdict(args));
});

test('no decaying relative age appears in either verdict', () => {
  const inSync = driftVerdict({ branch: 'b', tip: 'x'.repeat(40), prodSha: 'x'.repeat(40), deployedMs: DEPLOYED });
  const drifted = driftVerdict({ branch: 'b', tip: 'x'.repeat(40), prodSha: 'y'.repeat(40), deployedMs: DEPLOYED });
  assert.ok(!RELATIVE.test(inSync), `in-sync verdict must not decay: ${inSync}`);
  assert.ok(!RELATIVE.test(drifted), `drifted verdict must not decay: ${drifted}`);
  // The deploy time is stated absolutely, so it stays true however long the fact lives.
  assert.match(inSync, /deployed 2026-08-15T05:06:02\.000Z/);
});

test('drift is reported with both shas, in sync reports one', () => {
  const drifted = driftVerdict({ branch: 'next-migration', tip: 'aaaaaaaa'.repeat(5), prodSha: 'bbbbbbbb'.repeat(5), deployedMs: DEPLOYED });
  assert.match(drifted, /^DRIFTED/);
  assert.match(drifted, /aaaaaaaa/);
  assert.match(drifted, /bbbbbbbb/);
  const inSync = driftVerdict({ branch: 'next-migration', tip: 'cccccccc'.repeat(5), prodSha: 'cccccccc'.repeat(5), deployedMs: DEPLOYED });
  assert.match(inSync, /^in sync/);
  assert.match(inSync, /cccccccc/);
});

test('an unknown deploy time says so instead of inventing one', () => {
  // Number(undefined) is NaN and Number(0) is falsy; both must read as unknown rather than
  // rendering the epoch, which would be a confident wrong timestamp.
  for (const deployedMs of [0, undefined, null, NaN, '']) {
    const v = driftVerdict({ branch: 'b', tip: 'z'.repeat(40), prodSha: 'z'.repeat(40), deployedMs });
    assert.match(v, /deployed unknown time/, `deployedMs=${String(deployedMs)} must not invent a date`);
    assert.ok(!/1970/.test(v), 'must never render the epoch as a real deploy time');
  }
});

test('the CLI guard survives a percent-encoded argv and a path with a space', () => {
  // Not hypothetical: this script ships inside "/Applications/Seen Command.app", and brain-sync
  // used to spawn it with new URL(...).pathname, which percent-encodes the space. A strict
  // string compare made isMain false, main() never ran, and the hourly check recorded nothing —
  // dead in the packaged app while looking fine in the repo.
  const metaUrl = 'file:///Applications/Seen%20Command.app/Contents/Resources/app/scripts/deploy-drift.mjs';
  const decoded = '/Applications/Seen Command.app/Contents/Resources/app/scripts/deploy-drift.mjs';
  const encoded = '/Applications/Seen%20Command.app/Contents/Resources/app/scripts/deploy-drift.mjs';
  assert.equal(isMainModule(decoded, metaUrl), true, 'a decoded argv must run the check');
  assert.equal(isMainModule(encoded, metaUrl), true, 'a percent-encoded argv must also run it');
  assert.equal(isMainModule('/some/other/script.mjs', metaUrl), false);
  assert.equal(isMainModule(undefined, metaUrl), false);
  assert.equal(isMainModule('%E0%A4%A', metaUrl), false, 'a malformed escape must not throw');
});

test('drift is decided in exactly one place', () => {
  // The exit code and the recorded sentence must never disagree.
  assert.equal(isDrifted('a', 'b'), true);
  assert.equal(isDrifted('a', 'a'), false);
  assert.match(driftVerdict({ branch: 'b', tip: 'a'.repeat(40), prodSha: 'c'.repeat(40), deployedMs: DEPLOYED }), /^DRIFTED/);
  assert.match(driftVerdict({ branch: 'b', tip: 'a'.repeat(40), prodSha: 'a'.repeat(40), deployedMs: DEPLOYED }), /^in sync/);
});
