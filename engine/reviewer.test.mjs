import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewDiff, groundingFor, reviewParts, REVIEW_PART_CHARS } from './reviewer.mjs';
import { readActivity } from '../lib/activity.mjs';

// The reviewer lands a ledger line on every BLOCKED review. Redirect the whole activity ledger at a temp
// dir (the SEEN_COMMAND_REPO_DIR seam config.commandRepoDir() honors) so those writes never touch the
// real repo ledger — same trick pr-verify.test.mjs uses for its verdict writes.
process.env.SEEN_COMMAND_REPO_DIR = mkdtempSync(join(tmpdir(), 'reviewer-ledger-'));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.mjs'), 'export const A = 1;\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  writeFileSync(join(dir, 'a.mjs'), 'export const A = 1;\nexport const chips = sig.chronos;\n'); // the #73 shape
  return dir;
}

test('a rejecting reviewer verdict comes back parsed with its defects', async () => {
  const dir = repo();
  const r = await reviewDiff({ task: 'add monitoring', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async ({ prompt }) => {
      assert.match(prompt, /EXISTENCE EVIDENCE/);
      return { text: '{"ship": false, "defects": ["a.mjs reads sig.chronos which exists nowhere"]}', engine: 'stub-hosted' };
    } });
  assert.equal(r.ship, false);
  assert.equal(r.defects.length, 1);
  assert.match(r.defects[0], /sig\.chronos/);
});

test('an accepting verdict ships; hosted-dead falls back to local; garbage is BLOCKED, never shipped', async () => {
  const dir = repo();
  const ok = await reviewDiff({ task: 't', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async () => ({ text: '{"ship": true, "defects": []}', engine: 'stub' }) });
  assert.equal(ok.ship, true);

  const calls = [];
  const fallback = await reviewDiff({ task: 't', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async (o) => { calls.push(o.hostedOnly ? 'hosted' : 'local'); return calls.length === 1 ? { text: '', engine: 'fallback' } : { text: '{"ship": true}', engine: 'local:stub' }; } });
  assert.deepEqual(calls, ['hosted', 'local']);
  assert.equal(fallback.ship, true);

  const garbage = await reviewDiff({ task: 't', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async () => ({ text: 'I think this looks fine to me!', engine: 'stub' }) });
  assert.equal(garbage.ship, false); // fail CLOSED: prose is not a verdict, and nothing vouched for the change
  assert.match(garbage.blocked, /no parseable verdict/);
});

// Retry ladder step (a): an unparseable first reply is NOT a skip — reprompt the SAME lane with a
// stricter instruction, and honor the verdict that comes back. (#195/#106 shipped on the first skip.)
test('an unparseable first reply is reprompted on the SAME lane, then honored', async () => {
  const dir = repo();
  const seen = [];
  const r = await reviewDiff({ task: 'add monitoring', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async ({ prompt, hostedOnly, localOnly }) => {
      seen.push({ prompt, hostedOnly: !!hostedOnly, localOnly: !!localOnly });
      return seen.length === 1
        ? { text: 'here is my review: this looks fine to me', engine: 'gemini' }                 // garbage first
        : { text: '{"ship": false, "defects": ["a.mjs reads sig.chronos which exists nowhere"]}', engine: 'gemini' }; // valid on the stricter retry
    } });
  assert.equal(seen.length, 2);                                                    // exactly one reprompt
  assert.match(seen[1].prompt, /not valid JSON\. Answer ONLY the JSON object/);     // stricter instruction prepended
  assert.equal(seen[1].hostedOnly, true);                                          // SAME lane (hosted) as the first call
  assert.equal(r.ship, false);                                                     // the retried verdict is honored
  assert.equal(r.defects.length, 1);
});

// Retry ladder step (b): when the same-lane retry is ALSO unparseable, try the OTHER side (hosted→local)
// once and honor its verdict.
test('after a same-lane retry still fails, the OTHER side is tried and honored', async () => {
  const dir = repo();
  const sides = [];
  const r = await reviewDiff({ task: 'add monitoring', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async ({ hostedOnly, localOnly }) => {
      sides.push(hostedOnly ? 'hosted' : localOnly ? 'local' : '?');
      return sides.length < 3
        ? { text: 'no json here, just vibes', engine: 'gemini' }             // calls 1 & 2 garbage
        : { text: '{"ship": true, "defects": []}', engine: 'local:qwen' };   // call 3 (other side) valid
    } });
  assert.equal(sides.length, 3);                            // full ladder: first, same-lane retry, other side
  assert.deepEqual(sides, ['hosted', 'hosted', 'local']);   // the third call flipped hostedOnly→localOnly
  assert.equal(r.ship, true);                               // the other-side verdict is honored
  assert.equal(r.engine, 'local:qwen');
});

// Retry ladder step (c): all three rounds unparseable → BLOCKED (this used to ship: Seen #195,
// seen-command #106) with the ':unparseable' tag AND a visible ledger line naming the slice + why.
test('three unparseable replies BLOCK the change with a ledger line naming why', async () => {
  const dir = repo();
  const marker = 'settings-panel-7731'; // unique so we can find our own line among the file's ledger writes
  let calls = 0;
  const r = await reviewDiff({ task: `build slice ${marker}: add the settings panel`, repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async () => { calls++; return { text: 'sure, this all looks good to me!', engine: 'gemini' }; } });
  assert.equal(calls, 3);                    // the full three-round ladder ran before skipping
  assert.equal(r.ship, false);               // nothing vouched for the change → it does not ship
  assert.match(r.blocked, /no parseable verdict after retries/);
  assert.deepEqual(r.defects, [], 'blocked is not a rejection — there is nothing to teach the coder');
  assert.match(r.engine, /:unparseable$/);   // still tagged unparseable
  const line = readActivity().find((e) => e.kind === 'review' && e.status === 'blocked' && String(e.summary).includes(marker));
  assert.ok(line, 'a review/blocked ledger line naming the build slice was written');
  assert.match(line.summary, /no parseable verdict after retries/);
});

test('no lanes at all BLOCKS the change with the review marked unavailable', async () => {
  const dir = repo();
  const r = await reviewDiff({ task: 't', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async () => ({ text: '', engine: 'fallback' }) });
  assert.equal(r.ship, false);
  assert.equal(r.engine, 'unavailable');
  assert.match(r.blocked, /no reviewer lane answered/);
});

// #194: a build whose ONLY output is a new, untracked file used to hit the empty-diff early-return and
// ship with no semantic review. The new file's content must now reach the reviewer, and a rejection stick.
test('a new untracked file reaches the reviewer and a rejection ships false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-new-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.mjs'), 'export const A = 1;\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  // the #194 shape: the build's only output is an untracked stub whose first line is a literal fence
  writeFileSync(join(dir, 'stub.tsx'), '```tsx\nexport default function Page() { return <div>PLACEHOLDER_STUB</div>; }\n');
  let seen = '';
  const r = await reviewDiff({ task: 'add the settings page', repoRoot: dir, touched: ['stub.tsx'],
    reasonFn: async ({ prompt }) => {
      seen = prompt;
      return { text: '{"ship": false, "defects": ["stub.tsx is a placeholder with a markdown fence"]}', engine: 'stub-hosted' };
    } });
  assert.match(seen, /PLACEHOLDER_STUB/);   // the new file's body reached the reviewer as +content
  assert.match(seen, /```tsx/);             // including the literal markdown fence
  assert.equal(r.ship, false);              // and the fake reviewer's rejection flows through
  assert.equal(r.defects.length, 1);
});

test('a genuine no-op is blocked as no-diff without consulting the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-noop-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.mjs'), 'export const A = 1;\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  const r = await reviewDiff({ task: 't', repoRoot: dir, touched: [],
    reasonFn: async () => { throw new Error('model must not be consulted when there is no diff'); } });
  assert.equal(r.ship, false); // an empty diff is not an approved diff (the builder refuses it earlier, with a better reason)
  assert.equal(r.engine, 'no-diff');
});

test('groundingFor flags names that appear only in the diff', () => {
  const dir = repo();
  const diff = execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
  const g = groundingFor(dir, diff);
  assert.match(g, /"chronos": \d+ occurrence/);
  assert.match(g, /appears ONLY in this diff/);
});

test('CODER_REVIEW=0 turns the reviewer off — and an unreviewed change is blocked, not approved', async () => {
  process.env.CODER_REVIEW = '0';
  try {
    const r = await reviewDiff({ task: 't', repoRoot: '/nowhere', touched: [], reasonFn: async () => { throw new Error('must not be called'); } });
    assert.equal(r.ship, false);
    assert.equal(r.engine, 'disabled');
    assert.match(r.blocked, /CODER_REVIEW=0/);
  } finally { delete process.env.CODER_REVIEW; }
});

// `j.ship !== false` used to read ANY object without a ship key as an approval.
test('a reply with no explicit boolean `ship` is not an approval', async () => {
  const dir = repo();
  for (const text of ['{}', '{"defects": []}', '{"ship": "yes"}', '{"verdict": "looks good"}']) {
    const r = await reviewDiff({ task: 't', repoRoot: dir, touched: ['a.mjs'], reasonFn: async () => ({ text, engine: 'stub' }) });
    assert.equal(r.ship, false, `${text} must not ship`);
    assert.match(r.blocked, /no parseable verdict/);
  }
});

test('an approval that lists defects contradicts itself — the defects win', async () => {
  const dir = repo();
  const r = await reviewDiff({ task: 't', repoRoot: dir, touched: ['a.mjs'],
    reasonFn: async () => ({ text: '{"ship": true, "defects": ["a.mjs reads sig.chronos which exists nowhere"]}', engine: 'stub' }) });
  assert.equal(r.ship, false);
  assert.equal(r.blocked, undefined, 'a real verdict was rendered — this is a rejection the coder can act on');
  assert.match(r.defects[0], /sig\.chronos/);
});

// The reviewer used to judge `diff.slice(0, 9000)`: everything past the cut shipped unreviewed.
function bigRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-big-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.mjs'), 'export const S = 1;\n'); g('add', '-A'); g('commit', '-m', 'seed');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const filler = (tag, chars) => Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `export const ${tag}_${i} = ${i}; // padding`).join('\n') + '\n';

test('a diff larger than one part is reviewed IN FULL, part by part — the tail is never skipped', async () => {
  const per = Math.floor(REVIEW_PART_CHARS * 0.6);
  const dir = bigRepo({ 'one.mjs': filler('one', per), 'two.mjs': filler('two', per), 'three.mjs': `${filler('three', per)}export const TAIL_MARKER_9931 = 1;\n` });
  const prompts = [];
  const r = await reviewDiff({ task: 'add three modules', repoRoot: dir, touched: ['one.mjs', 'two.mjs', 'three.mjs'],
    reasonFn: async ({ prompt }) => { prompts.push(prompt); return { text: '{"ship": true, "defects": []}', engine: 'stub' }; } });
  assert.equal(r.ship, true);
  assert.equal(prompts.length, 3, 'one round per part');
  assert.ok(prompts.some((p) => p.includes('TAIL_MARKER_9931')), 'the END of the change reached a reviewer');
  assert.ok(prompts.every((p) => /PART \d OF 3/.test(p) && p.includes('- one.mjs') && p.includes('- three.mjs')), 'every part sees the whole manifest');
});

test('one rejecting part rejects the whole change; one blocked part blocks it', async () => {
  const per = Math.floor(REVIEW_PART_CHARS * 0.6);
  const dir = bigRepo({ 'one.mjs': filler('one', per), 'two.mjs': filler('two', per) });
  let n = 0;
  const rejected = await reviewDiff({ task: 't', repoRoot: dir, touched: ['one.mjs', 'two.mjs'],
    reasonFn: async () => (++n === 2 ? { text: '{"ship": false, "defects": ["two.mjs is padding, not the task"]}', engine: 'stub' } : { text: '{"ship": true, "defects": []}', engine: 'stub' }) });
  assert.equal(rejected.ship, false);
  assert.match(rejected.defects[0], /two\.mjs/);

  let m = 0;
  const blocked = await reviewDiff({ task: 't', repoRoot: dir, touched: ['one.mjs', 'two.mjs'],
    reasonFn: async () => (++m === 1 ? { text: '{"ship": true, "defects": []}', engine: 'stub' } : { text: '', engine: 'fallback' }) });
  assert.equal(blocked.ship, false);
  assert.match(blocked.blocked, /no reviewer lane answered \(part 2\/2\)/);
});

test('a single file too large for any part cannot be reviewed, so it cannot ship', async () => {
  const dir = bigRepo({ 'huge.mjs': filler('huge', REVIEW_PART_CHARS * 1.5) });
  const r = await reviewDiff({ task: 't', repoRoot: dir, touched: ['huge.mjs'],
    reasonFn: async () => { throw new Error('an unreviewable diff must not spend a model round'); } });
  assert.equal(r.ship, false);
  assert.match(r.blocked, /huge\.mjs is too large to review/);
  assert.deepEqual(reviewParts('').parts, []);
});
