// Run: node --test lib/priority.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutTheTool, failureBehind, seenJobsFirst } from './priority.mjs';

test('SeenJobs work always passes; a tool pitch with no failure behind it is held back', () => {
  assert.deepEqual(seenJobsFirst({ dept: 'growth', title: 'Post the Ghost Index to r/recruitinghell', body: 'value-first post' }, { build: null }), { keep: true });
  assert.deepEqual(seenJobsFirst({ dept: 'product', title: 'Add job alerts to seenjobs.io', body: '' }, { build: 'product' }), { keep: true });
  const held = seenJobsFirst({ dept: 'platform', title: 'Redesign the Board Room sidebar', body: 'nicer UX for the command center' }, { build: 'tool' });
  assert.equal(held.keep, false); assert.match(held.why, /SeenJobs comes first/);
  assert.equal(seenJobsFirst({ dept: 'strategy', title: 'Upgrade the Chronos brain graph', body: '' }).keep, false, 'subject is the tool even without a build target');
});

test('a tool fix tied to a recorded failure IS proposed, and names the failure', () => {
  const failures = [{ id: 'f-indeed-1', reason: 'Indeed collector: every search failed — opencli session expired' }];
  const v = seenJobsFirst({ dept: 'platform', title: 'Fix the Indeed collector session handling', body: 'every search failed because the opencli session expired' }, { build: 'tool', failures });
  assert.deepEqual(v, { keep: true, failure: 'f-indeed-1' });
  assert.equal(failureBehind({ title: 'x', body: 'see f-indeed-1' }, failures)?.id, 'f-indeed-1');
  assert.equal(failureBehind({ title: 'Improve the dashboard', body: 'search feels slow' }, failures), null, 'one shared word is not enough');
  assert.equal(aboutTheTool({ dept: 'growth', title: 'Publish the board meeting notes?' }, 'product'), false, 'an explicit product build wins');
});
