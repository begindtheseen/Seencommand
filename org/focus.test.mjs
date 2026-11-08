// Focus title clamping + the custom-focus builder.
//
// The title matters beyond the UI: the board meeting records it into the shared brain as the
// bi-temporal fact `Seen Command · current_focus` (engine/run.mjs → lib/brain.mjs
// recordBoardMeeting), so a bad clamp becomes a bad durable fact. The old hard `.slice(0, 80)`
// stored a directive as "… instead of being fa".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampFocusTitle, buildCustomFocus, resolveFocus, focusFromText, FOCUS_TITLE_MAX, FOCUSES, DEFAULT_FOCUS } from './focus.mjs';

const LONG = 'making sure the brain is genuinely real and every number on the dashboard traces to a '
  + 'live source, so the whole system is honest about what it knows and what it is guessing at, '
  + 'instead of being faked with plausible-looking placeholder values that nobody ever checks '
  + 'against production and that quietly rot until a decision gets made on top of them';

test('the cap is 280 characters', () => {
  assert.equal(FOCUS_TITLE_MAX, 280);
});

test('a title at or under the cap is returned untouched — no ellipsis', () => {
  const s = 'expanding Seen Command capabilities';
  assert.equal(clampFocusTitle(s), s);
  assert.ok(!clampFocusTitle(s).includes('…'));
  const exact = 'x'.repeat(FOCUS_TITLE_MAX);
  assert.equal(clampFocusTitle(exact), exact, 'exactly at the cap must not be truncated');
});

test('an over-length title is cut on a word boundary, never mid-word', () => {
  assert.ok(LONG.length > FOCUS_TITLE_MAX, 'fixture must exceed the cap');
  const out = clampFocusTitle(LONG);
  assert.ok(out.length <= FOCUS_TITLE_MAX, `got ${out.length} chars`);
  assert.ok(out.endsWith('…'), 'over-length titles get an ellipsis');
  const body = out.slice(0, -1);
  // The cut point must coincide with a word boundary in the original: the kept text is a prefix,
  // and the next original character is whitespace (or the text ended there).
  assert.ok(LONG.startsWith(body), 'kept text must be a real prefix of the input');
  assert.match(LONG.charAt(body.length), /\s/, `cut mid-word at "${body.slice(-12)}"`);
});

test('the old 80-char bug is gone — the readable clause survives', () => {
  const out = clampFocusTitle(LONG);
  assert.ok(!out.endsWith('being fa…'), 'still cutting mid-word');
  assert.ok(out.length > 200, 'the 280 cap is not being applied');
  assert.ok(out.includes('honest about what it knows'), 'the substance of the directive is kept');
});

test('a single unbroken token longer than the cap falls back to a hard cut', () => {
  const out = clampFocusTitle('z'.repeat(400));
  assert.equal(out.length, FOCUS_TITLE_MAX);
  assert.ok(out.endsWith('…'));
});

test('trailing punctuation and whitespace are stripped (both paths)', () => {
  assert.equal(clampFocusTitle('  get users.  '), 'get users');
  assert.equal(clampFocusTitle('"get users"'), '"get users');   // pre-existing trailing-quote strip
  assert.ok(!/[\s,;:—-]…$/.test(clampFocusTitle(LONG)), 'ellipsis follows dangling punctuation');
});

test('empty / nullish input yields the fallback title, not an ellipsis', () => {
  assert.equal(clampFocusTitle(''), '');
  assert.equal(clampFocusTitle(null), '');
  assert.equal(buildCustomFocus('').title, 'Custom focus');
  assert.equal(buildCustomFocus(undefined).title, 'Custom focus');
});

test('buildCustomFocus clamps the title and gives every department a role', () => {
  const f = buildCustomFocus(LONG);
  assert.equal(f.title, clampFocusTitle(LONG));
  assert.equal(f.northStar, f.title);
  assert.equal(f.id, 'custom');
  assert.equal(f.custom, true);
  assert.equal(f.dept.strategy.role, 'lead');
  for (const id of ['growth', 'product', 'data', 'reliability', 'revenue', 'platform']) {
    assert.equal(f.dept[id].role, 'support', `${id} should support a custom focus`);
  }
  // Every preset department is covered, so no dept falls through to a default move.
  assert.equal(Object.keys(f.dept).length, 7);
});

// --- the value that reaches the brain ---------------------------------------
// resolveFocus() is what engine/run.mjs reads, and its .title is what gets recorded as
// `Seen Command · current_focus`. It must be STABLE across meetings for a given state, or the
// brain records a supersede every run even when nothing changed.

test('resolveFocus returns a stable title for the same state (no per-run drift)', () => {
  const state = { focusId: 'custom', customFocus: buildCustomFocus(LONG) };
  const a = resolveFocus(state).title;
  const b = resolveFocus(state).title;
  assert.equal(a, b);
  assert.equal(a, clampFocusTitle(LONG));
  // Re-clamping an already-clamped title is a fixed point — re-derivation cannot shorten it again.
  assert.equal(clampFocusTitle(a), a, 'clamp is not idempotent — a re-derived title would thrash');
});

test('resolveFocus falls back to the preset focus when no custom focus is set', () => {
  assert.equal(resolveFocus({ focusId: 'revenue' }).title, FOCUSES.revenue.title);
  assert.equal(resolveFocus({}).title, FOCUSES[DEFAULT_FOCUS].title);
  assert.equal(resolveFocus(null).title, FOCUSES[DEFAULT_FOCUS].title);
  assert.equal(resolveFocus({ focusId: 'nonsense' }).title, FOCUSES[DEFAULT_FOCUS].title);
  // Preset titles are constants, so they can never drift between meetings.
  assert.equal(focusFromText('we need paid conversions'), 'revenue');
});
