import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameWork } from '../lib/text.mjs';
import {
  screenProposal, screenProposals, screenAndDemote, phantomPremise, resurrectionOf, titleSubject, offCharter, PHANTOM_CONCEPTS, duplicateOfOpenPR } from './proposal-gate.mjs';

// The exact issue-#81 proposal the gate exists to stop: a growth-dept `reddit plan` whose gate is
// "Post to Reddit + reply in the thread" carrying an engineering "integrate the Chronos SDK" task.
const ISSUE_81 = {
  title: 'Integrate Chronos SDK with Seen Command for Real-Time Data Exchange',
  body: 'Create a new PR to integrate the Chronos SDK with Seen Command, enabling real-time data exchange.',
  kind: 'reddit plan', dept: 'growth',
};

test('#81 regression: the phantom "Chronos SDK" proposal is dropped', () => {
  const v = screenProposal(ISSUE_81);
  assert.equal(v.ok, false);
  assert.equal(v.check, 'phantom-premise');
  assert.match(v.reason, /no Chronos SDK/);
});

test('phantom premise needs the PAIRED phrase — a real SDK in the product passes', () => {
  assert.ok(phantomPremise('Integrate the Chronos SDK'));
  // Distant pairing ("upgrade chronos to the latest SDK release") is deliberately OUT of scope:
  // precision-first — all 6 real filed phantoms used the adjacent phrase, and co-occurrence matching
  // was a reproduced false-positive source (review defect 1). The build-entrance screen + reviewer
  // still back this up for exotic phrasings.
  assert.equal(phantomPremise('upgrade chronos to the latest SDK release'), null);
  assert.equal(phantomPremise('Upgrade the Supabase SDK client in the product'), null); // real dep, not chronos
  assert.equal(phantomPremise('Improve the Chronos cloud sync poll interval'), null);   // chronos, but no phantom SDK
  assert.equal(phantomPremise('Add an SDK-style helper to the coder'), null);            // sdk word, no entity
});

test('Seen Command has no SDK either', () => {
  assert.ok(phantomPremise('Publish a Seen Command SDK for third parties'));
  assert.equal(phantomPremise('Improve Seen Command board meeting speed'), null);
});

test('resurrection is caught after de-noising the closed title — the dilution bug is fixed', () => {
  const closedFull = 'Implement Real-Time Monitoring Dashboard — Create a real-time dashboard to monitor the '
    + 'performance of Chronos and Seen Command, providing insights into system health and areas needing improvement.';
  const prop = 'Build a real-time monitoring dashboard';
  // The OLD filter compared against the FULL title and the description diluted the match away:
  assert.equal(sameWork(prop, closedFull), false);
  // The gate compares de-noised subjects and catches it:
  assert.ok(resurrectionOf(prop, [closedFull]));
  assert.equal(screenProposal({ title: prop, kind: 'perf proposal' }, { closedTitles: [closedFull] }).check, 'resurrection');
});

test('titleSubject strips the "— description" tail but not a "PR 187:" head', () => {
  assert.equal(titleSubject('Optimize Chronos SDK for Better Performance — Investigate and optimize the SDK.'),
    'Optimize Chronos SDK for Better Performance');
  assert.equal(titleSubject('Fix the alignment - it wraps on mobile'), 'Fix the alignment');
  assert.equal(titleSubject('PR 187: Integrate Chronos SDK'), 'PR 187: Integrate Chronos SDK'); // colon NOT a split
});

test('a genuinely new proposal is not a false resurrection', () => {
  const closed = ['Enhance User Onboarding Experience — Revise the onboarding process to improve adoption.'];
  assert.equal(resurrectionOf('Add Stripe dunning retries for failed charges', closed), null);
});

test('off-charter: a marketing kind carrying engineering content is dropped (the #81 shape)', () => {
  assert.ok(offCharter('reddit plan', 'Integrate the SDK connector and add an API endpoint'));
  assert.ok(offCharter('social plan', 'Refactor the database schema and deploy the migration'));
});

test('off-charter: a marketing kind with marketing content passes', () => {
  assert.equal(offCharter('reddit plan', 'Post a value-first thread to r/recruitinghell and reply to a few relevant comments'), null);
});

test('off-charter: an engineering kind with ONLY marketing content is dropped', () => {
  assert.ok(offCharter('bugfix PR', 'Post to Reddit and send cold outreach emails'));
  // but engineering content (even if it also mentions posting results) is fine on an engineering kind
  assert.equal(offCharter('bugfix PR', 'Fix the API endpoint that powers the Reddit share button'), null);
});

test('legit proposals of every kind pass the whole gate (no false positives)', () => {
  const closed = ['Some Closed Thing — with a description tail'];
  const good = [
    { title: 'Fix the Ghost Report table alignment on mobile', body: 'CSS fix', kind: 'bugfix PR' },
    { title: 'Ship a saved-search feature on the job board', body: 'New feature', kind: 'feature PR' },
    { title: 'Cut board-meeting cold-start with fact caching', body: 'Perf', kind: 'platform PR' },
    { title: 'This week r/recruitinghell value-first post + 3 replies', body: 'Draft only', kind: 'reddit plan' },
    { title: 'Upgrade the Supabase client to v2 in the product', body: 'Real dependency', kind: 'feature PR' },
  ];
  for (const p of good) assert.deepEqual(screenProposal(p, { closedTitles: closed }), { ok: true }, p.title);
});

test('screenProposals partitions kept vs rejected and logs a reason per drop', () => {
  const proposals = [
    { title: 'Integrate the Chronos SDK', kind: 'platform PR' },              // phantom
    { title: 'Fix the login redirect bug', kind: 'bugfix PR' },               // good
    { title: 'Draft this week Reddit cadence', kind: 'reddit plan' },         // good
  ];
  const { kept, rejected } = screenProposals(proposals);
  assert.equal(kept.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].check, 'phantom-premise');
  assert.ok(rejected[0].reason);
});

test('PROPOSAL_GATE=0 disables the gate (everything kept)', () => {
  process.env.PROPOSAL_GATE = '0';
  try {
    const { kept, rejected } = screenProposals([ISSUE_81]);
    assert.equal(kept.length, 1);
    assert.equal(rejected.length, 0);
  } finally { delete process.env.PROPOSAL_GATE; }
});

test('phantom check requires the PAIRED phrase — co-occurrence with a real SDK passes (review defect 1)', () => {
  // Reproduced false positives from the adversarial review of PR #82 — all must PASS now:
  assert.equal(phantomPremise('Compare Chronos poll latency against the Supabase SDK'), null);
  assert.equal(phantomPremise('Improve Chronos poll interval; separately bump the Supabase SDK'), null);
  assert.equal(phantomPremise('Chronos vault sync improvements. Also, upgrade the Stripe SDK in the product.'), null);
  // The paired phrases still drop:
  assert.ok(phantomPremise('Integrate the Chronos SDK with Seen Command'));
  assert.ok(phantomPremise('build an SDK for Chronos'));
  assert.ok(phantomPremise('chronos-sdk upgrade'));
});

test('off-charter is symmetric — a marketing proposal that DOES its marketing action passes (review defect 2)', () => {
  // Reproduced false positives: legit Reddit posts that merely name a product feature.
  assert.equal(offCharter('reddit plan', 'Post about our Supabase integration to r/SaaS'), null);
  assert.equal(offCharter('reddit plan', 'Share our new API on r/webdev, value-first'), null);
  // Engineering-ONLY content in a marketing kind still drops (the #81 shape):
  assert.ok(offCharter('reddit plan', 'Integrate the connector API endpoint with the database schema'));
});

test('screenAndDemote keeps blocked proposals VISIBLE but inert (never queued/filed/built)', () => {
  const proposals = [
    { title: 'Integrate the Chronos SDK', body: 'phantom', kind: 'platform PR', gatedAction: 'Merge the PR', effect: 'gated' },
    { title: 'Fix the login redirect bug', body: 'real', kind: 'bugfix PR', gatedAction: 'Merge the bugfix PR', effect: 'gated' },
  ];
  const logs = [];
  const out = screenAndDemote(proposals, {}, (m) => logs.push(m));
  assert.equal(out.length, 2); // nothing silently disappears
  const [blocked, ok] = out;
  assert.equal(blocked.gatedAction, null);
  assert.equal(blocked.effect, 'internal');
  assert.equal(blocked.gateBlocked, 'phantom-premise');
  assert.match(blocked.body, /⛔ blocked by the proposal gate/);
  assert.equal(ok.gatedAction, 'Merge the bugfix PR'); // untouched
  assert.equal(logs.length, 1);
  assert.match(logs[0], /phantom-premise/);
});

test('screenProposal demotes an engineering proposal when its concrete target is not grounded', () => {
  const p = { title: 'Update Creator Library', body: 'Target scripts/content-parser.mjs. Done means: extraction improves.', kind: 'feature PR' };
  const v = screenProposal(p, { targetCheck: () => 'scripts/content-parser.mjs does not exist in the product repo' });
  assert.equal(v.ok, false);
  assert.equal(v.check, 'bad-target');
  assert.match(v.reason, /does not exist/);
});

test('titleSubject handles unspaced em-dash and spaced unicode dashes (review nit)', () => {
  assert.equal(titleSubject('Fix the header—it clips on mobile'), 'Fix the header');
  assert.equal(titleSubject('Ship saved search ― users asked twice'), 'Ship saved search');
  assert.equal(titleSubject('Support 2024–2025 fiscal ranges in reports'), 'Support 2024–2025 fiscal ranges in reports');
});

test('build-verbs with no marketing action are off-charter in a marketing kind (first live-meeting survivor)', () => {
  // "Implement Automated Stale Job Resolution" queued as a reddit plan on the first gated meeting —
  // implement/automate/monitor/alert are engineering content when nothing marketing-shaped appears.
  assert.ok(offCharter('reddit plan', 'Implement Automated Stale Job Resolution'));
  assert.ok(offCharter('reddit plan', 'Implement automated error monitoring and alerting'));
  // The symmetric guard keeps REAL marketing automation passing:
  assert.equal(offCharter('reddit plan', 'Automate the weekly r/recruitinghell posting cadence'), null);
  assert.equal(offCharter('social plan', 'Monitor subreddit mentions and draft replies'), null);
});

test('PHANTOM_CONCEPTS entries are well-formed (id + test + why)', () => {
  assert.ok(PHANTOM_CONCEPTS.length >= 1);
  for (const p of PHANTOM_CONCEPTS) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.test, 'function');
    assert.match(p.why, /\w+/);
  }
});

// --- duplicate-open-PR screening (gap #5: 7 failures) -------------------------------------------
// task-88 and task-132 were each proposed, approved, queued, and only THEN refused by the builder for
// duplicating an already-open PR. The refusal was correct; the waste was upstream. Screening here with
// the builder's own metric means the duplicate never becomes a task.

test('a proposal duplicating an OPEN PR is blocked, naming the PR', () => {
  const v = screenProposal(
    { title: 'Implement Automated Job Refresh (stale-jobs liveness re-check)', kind: 'engineering' },
    { openPRTitles: ['Implement Automated Job Refresh (stale-jobs liveness re-check) — Closes seen-com'] },
  );
  assert.equal(v.ok, false);
  assert.equal(v.check, 'duplicate-open-pr');
  assert.match(v.reason, /already covered by open PR/);
  assert.match(v.reason, /review or merge that instead/);
});

test('unrelated work is not blocked by an open PR', () => {
  const v = screenProposal({ title: 'Add a --version flag to the ops CLI', kind: 'engineering' },
    { openPRTitles: ['Implement Automated Job Refresh (stale-jobs liveness re-check)'] });
  assert.equal(v.ok, true);
});

// THE honesty case: a connector outage must never read as "no duplicates exist".
test('an unreadable GitHub (null) skips the check instead of blocking or passing blindly', () => {
  const p = { title: 'Implement Automated Job Refresh (stale-jobs liveness re-check)', kind: 'engineering' };
  assert.equal(screenProposal(p, { openPRTitles: null }).ok, true, 'null = could not look; do not block');
  assert.equal(screenProposal(p, {}).ok, true, 'absent context behaves the same');
  // ...but an EMPTY array is a real answer ("GitHub says there are no open PRs") and still passes.
  assert.equal(screenProposal(p, { openPRTitles: [] }).ok, true);
});

test('duplicateOfOpenPR returns the matching PR title, or null', () => {
  assert.equal(duplicateOfOpenPR('Enhance ghost rate monitoring script', ['Enhance ghost rate monitoring script to include more granular logging']),
    'Enhance ghost rate monitoring script to include more granular logging');
  assert.equal(duplicateOfOpenPR('Something else entirely', ['Enhance ghost rate monitoring']), null);
  assert.equal(duplicateOfOpenPR('x', null), null);
  assert.equal(duplicateOfOpenPR(null, ['a']), null);
});

test('screenAndDemote makes a duplicate inert but still visible in the meeting', () => {
  const props = [{ title: 'Enhance ghost rate monitoring script', kind: 'engineering', body: 'do it', gatedAction: { x: 1 }, effect: 'external' }];
  const out = screenAndDemote(props, { openPRTitles: ['Enhance ghost rate monitoring script to include logging'] });
  assert.equal(out[0].gateBlocked, 'duplicate-open-pr');
  assert.equal(out[0].gatedAction, null, 'never queued for approval');
  assert.equal(out[0].effect, 'internal');
  assert.match(out[0].body, /⛔ blocked by the proposal gate \(duplicate-open-pr\)/);
});

// PARITY with engine/builder.mjs duplicateOpenPR, which compares the full task text sliced to 140 —
// not the title. Title-only matching missed the REAL task-132 pair below, which the builder then
// caught at build time. The two checks disagreeing is the exact split this gate exists to prevent.
test('screening compares the same text the builder does — the real task-132 pair', () => {
  const v = screenProposal({
    title: 'Optimize Ghost Rate Monitoring',
    body: 'Enhance the ghost rate monitoring script to include more granular logging and alerting for anomalies.',
    kind: 'engineering',
  }, { openPRTitles: ['Enhance ghost rate monitoring script to include more granular logging and alerti'] });
  assert.equal(v.ok, false, 'the builder catches this one; the board must too');
  assert.equal(v.check, 'duplicate-open-pr');
});
