// The relevance gate is ruthless on purpose (owner, 2026-10-21) — but never drops a real Seen signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relevance, knowledgeRelevance, accountVerdict, pruneFamily } from './relevance.mjs';

const keep = (t) => assert.equal(relevance(t).verdict, 'keep', `${t} → ${relevance(t).why}`);
const drop = (t) => assert.equal(relevance(t).verdict, 'prune', `${t} → ${relevance(t).why}`);

test('keeps job-search, content-craft, growth, trust, monetization and product rows — with the reason', () => {
  keep('Open with the pain: "Ghosted after the final interview?"');
  keep('Post three reels a week and keep a consistent posting schedule');
  keep('Put the call to action in the caption, not the video');
  keep('Recruiters at staffing agencies often stop replying after the first call');
  keep('Transparent pay ranges build trust with applicants');
  keep('Price the paid tier at one coffee a month');
  keep('Send new sign-ups a one-line onboarding email');
  assert.match(relevance('My boss ghosted me after the interview, said my dad').why, /job search.*despite personal life/);
});

test('ruthless: editing-software trivia, motivation, other niches and vague business talk are pruned', () => {
  drop('Apply easing to your keyframes in the graph editor for smoother motion');
  drop('Export with a transparent background from After Effects');
  drop('Use positioning and null objects to rig the layers');
  drop('Your mindset is everything — never give up');
  drop('Meal prep on Sundays to save time');
  drop('Real estate is the best long-term investment');
  drop('Grow your business by serving your customers well');
  drop('Lighting setup: one key light at 45 degrees');
  assert.equal(pruneFamily(relevance('Use keyframes')), 'editing-software / gear trivia');
  assert.equal(pruneFamily(relevance('Serve your customers')), 'generic business wording');
  assert.equal(pruneFamily(relevance('The sky is blue')), 'no link to Seen');
});

test('the gate reads title + description + conditions of a knowledge record', () => {
  assert.equal(knowledgeRelevance({ title: 'Smooth motion', description: 'Ease in and out', record: { conditions: ['when the viewer scrolls past in the first two seconds'] } }).verdict, 'keep');
  assert.equal(knowledgeRelevance({ title: 'Smooth motion', description: 'Ease in and out', record: {} }).verdict, 'prune');
});

test('account verdict: keep / prune / pending, always with the counts in the reason', () => {
  const k = (title, status = 'confirmed') => ({ knowledge_id: title, title, description: '', status, record: {} });
  const motion = { videos: [{ id: 'v1', caption: 'new AE tutorial' }, { id: 'v2', caption: 'keyframes' }],
    evidence: [{ video_id: 'v1', content: 'open the graph editor' }],
    knowledge: [k('Use keyframes'), k('Ease in the graph editor'), k('Pre-comp your layers'), k('Hooks in the first two seconds')] };
  const v = accountVerdict(motion);
  assert.equal(v.verdict, 'prune');
  assert.match(v.why, /1 of 4 knowledge records \(25%\) serve Seen; 0 of 2 videos \(0%\) touch job search/);
  const coach = { videos: [{ id: 'v1', caption: 'ghosted after my interview' }, { id: 'v2', caption: 'resume tips' }, { id: 'v3', caption: 'day in my life' }], evidence: [], knowledge: [k('Use keyframes')] };
  assert.equal(accountVerdict(coach).verdict, 'keep', 'its audience is job seekers even if its knowledge is thin');
  assert.equal(accountVerdict({ videos: [{ id: 'v1', caption: '' }], evidence: [], knowledge: [] }).verdict, 'pending');
  assert.equal(accountVerdict({ videos: [], evidence: [], knowledge: [k('Hook fast', 'contradicted')] }).verdict, 'pending', 'contradicted knowledge does not count');
});
