// Run: node --test lib/room.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomAddress, meetingDigest, createMeetingRelay, roomBrief } from './room.mjs';

test('addressing a department or the whole board in plain words', () => {
  assert.deepEqual(parseRoomAddress('@growth why is this the top move?'), { dept: 'growth', question: 'why is this the top move?' });
  assert.deepEqual(parseRoomAddress('product, what would it take to ship the jobs alert?'), { dept: 'product', question: 'what would it take to ship the jobs alert?' });
  assert.deepEqual(parseRoomAddress('ask revenue: should we raise Pro to $12?'), { dept: 'revenue', question: 'should we raise Pro to $12?' });
  assert.deepEqual(parseRoomAddress('ask the CTO what broke the deploy'), { dept: 'product', question: 'what broke the deploy' });
  assert.deepEqual(parseRoomAddress('ask the board whether we should focus on staffing agencies'), { board: true, question: 'whether we should focus on staffing agencies' });
  for (const t of ['growth is slow this week', 'what is our data saying', 'search welder jobs', 'productivity tips']) assert.equal(parseRoomAddress(t), null, t);
});

test('a meeting digest names the focus, constraint, each department’s top move and what waits on Brandon', () => {
  const st = { runId: 'run-1', reasonEngine: 'groq', debrief: { focus: { title: 'Raw user growth' }, headline: 'Focus: growth.', topConstraint: 'Only 800 users.' },
    proposals: [{ dept: 'growth', title: 'Post the Ghost Index' }, { dept: 'growth', title: 'second' }, { dept: 'product', title: 'Job alerts' }],
    approvals: [{ id: 'a1', status: 'pending', title: 'Publish the Ghost Report' }, { id: 'a2', status: 'approved', title: 'done' }] };
  const d = meetingDigest(st);
  assert.match(d, /Board meeting run-1/); assert.match(d, /Biggest constraint:\*\* Only 800 users/);
  assert.match(d, /CMO · Growth: Post the Ghost Index/); assert.doesNotMatch(d, /second/);
  assert.match(d, /Waiting on you \(1\)/); assert.match(d, /`a1`/); assert.doesNotMatch(d, /done/);
  assert.equal(meetingDigest({}), null);
});

test('the relay posts each NEW meeting once — never the one already there at start', async () => {
  let state = { runId: 'run-1', debrief: {} }; const posted = [];
  const r = createMeetingRelay({ loadState: () => state, post: async (t) => posted.push(t) });
  await r.tick(); assert.equal(posted.length, 0);
  state = { runId: 'run-2', debrief: { headline: 'H' } }; await r.tick(); await r.tick();
  assert.equal(posted.length, 1); assert.match(posted[0], /run-2/);
});

test('the meeting reads the room: Brandon’s noted vision + recent turns', () => {
  const b = roomBrief({ conversation: [{ role: 'you', text: 'the chatbot must act' }, { role: 'ceo', text: 'noted' }, { role: 'system', text: 'x' }], facts: [{ subject: 'owner:vision', predicate: 'chatbot', object: 'acts for me', valid_to: null }, { subject: 'owner:vision', predicate: 'old', object: 'gone', valid_to: '2026-10-01' }, { subject: 'seen:users', predicate: 'n', object: '8' }] });
  assert.match(b, /vision · chatbot: acts for me/); assert.doesNotMatch(b, /gone|seen:users/);
  assert.match(b, /Brandon: the chatbot must act/); assert.doesNotMatch(b, /: x$/m);
  assert.equal(roomBrief({}), '');
});
