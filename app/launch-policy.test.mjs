import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { meetingOnLaunch } = require('./launch-policy.js');

test('opening Seen Command does not spend model tokens on a board meeting by default', () => {
  assert.equal(meetingOnLaunch({}), false);
  assert.equal(meetingOnLaunch({ SEEN_MEETING_ON_LAUNCH: '' }), false);
  assert.equal(meetingOnLaunch({ SEEN_MEETING_ON_LAUNCH: 'false' }), false);
});

test('startup meetings remain available only through an explicit opt-in', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(meetingOnLaunch({ SEEN_MEETING_ON_LAUNCH: value }), true);
  }
});
