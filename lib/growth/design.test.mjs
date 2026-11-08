// Run: node --test lib/growth/design.test.mjs — the ad designer's pure parts (text fitting, frames, data
// checks, sizes) loaded from the browser module itself, the same way the server reads its template list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDesign, designMeta, templateSpec, DESIGN_FILE } from './design-meta.mjs';

// A fake 2D context: every glyph is 0.55 × the font size wide (monospace-ish), enough to test the fitting logic.
function fakeCtx() {
  const ctx = { font: '600 10px "Instrument Sans"', measureText(t) { const size = Number((/(\d+)px/.exec(ctx.font) || [0, 10])[1]); return { width: String(t).length * size * 0.55 }; } };
  return ctx;
}
const G = loadDesign();

test('five sizes, exactly the platform dimensions', () => {
  const s = designMeta().sizes;
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.w}x${v.h}`])), { square: '1080x1080', portrait: '1080x1350', story: '1080x1920', link: '1200x628', banner: '1500x500' });
  assert.deepEqual(designMeta().templates.map((t) => t.id), ['data-callout', 'agency-leaderboard', 'quote', 'cta-banner', 'steps']);
  assert.ok(templateSpec('data-callout').fields.includes('sourceLine')); assert.equal(templateSpec('nope'), null);
});

test('fitText: the largest size that fits the box, wrapped to maxLines', () => {
  const ctx = fakeCtx();
  const one = G.fitText(ctx, 'Robert Half', { maxWidth: 600, max: 120, min: 20 });
  assert.equal(one.lines.length, 1); assert.ok(one.size * 0.55 * 'Robert Half'.length <= 600); assert.ok(one.size >= 90 && one.size <= 120); assert.equal(one.overflow, false);
  const two = G.fitText(ctx, 'Check if they ghost before you apply.', { maxWidth: 500, maxLines: 2, max: 100, min: 20 });
  assert.ok(two.lines.length <= 2); assert.ok(two.lines.every((l) => l.length * two.size * 0.55 <= 500)); assert.equal(two.overflow, false);
  // a bigger box never gives a smaller size
  assert.ok(G.fitText(ctx, 'Check if they ghost before you apply.', { maxWidth: 900, maxLines: 2, max: 100, min: 20 }).size >= two.size);
});

test('fitText: at the minimum size it keeps maxLines and ellipsizes — text never spills', () => {
  const ctx = fakeCtx();
  const long = 'word '.repeat(200).trim();
  const f = G.fitText(ctx, long, { maxWidth: 300, maxLines: 3, max: 40, min: 14 });
  assert.equal(f.size, 14); assert.equal(f.lines.length, 3); assert.equal(f.overflow, true); assert.match(f.lines[2], /…$/);
  assert.ok(f.lines.every((l) => l.length * 14 * 0.55 <= 300));
  // a single word wider than the box is hard-broken instead of overflowing
  const w = G.wrap(fakeCtx(), 'Supercalifragilisticexpialidocious', 100);
  assert.ok(w.length > 1); assert.ok(w.every((l) => l.length * 10 * 0.55 <= 100));
  assert.deepEqual(Array.from(G.wrap(fakeCtx(), 'a\nb', 1000)), ['a', 'b']);
});

test('frames: safe margins scale with the canvas; stories keep clear of the top/bottom app UI', () => {
  const sq = G.frame(1080, 1080), st = G.frame(1080, 1920), ln = G.frame(1200, 628), bn = G.frame(1500, 500);
  assert.equal(sq.kind, 'square'); assert.equal(sq.m, 72); assert.equal(sq.x1 - sq.x0, 936);
  assert.equal(st.kind, 'story'); assert.ok(st.y0 >= 1920 * 0.12 && st.y1 <= 1920 * 0.83);
  assert.equal(ln.kind, 'wide'); assert.equal(bn.kind, 'wide'); assert.ok(bn.m >= 40);
  assert.equal(G.frame(1080, 1350).kind, 'portrait');
});

test('real data or a stamped sample: missing fields fall back to the sample layout', () => {
  assert.equal(G.missing('data-callout', { name: 'X', ghostPct: 50, reports: 9, sourceLine: 's' }).length, 0);
  assert.ok(G.missing('data-callout', { name: 'X', reports: 9 }).includes('ghostPct'));
  assert.ok(G.missing('agency-leaderboard', { rows: [] }).includes('rows'));
  assert.equal(G.TEMPLATES['data-callout'].sample.sample, true, 'data samples are flagged so render() stamps them');
  assert.equal(G.TEMPLATES['agency-leaderboard'].sample.sample, true);
  for (const id of Object.keys(G.TEMPLATES)) assert.equal(typeof G.TEMPLATES[id].draw, 'function');
});

test('the module is plain browser JS that parses on its own, and vendors only licensed icon paths', () => {
  const src = readFileSync(DESIGN_FILE, 'utf8');
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /Lucide v0\.460\.0/); assert.match(readFileSync(new URL('./assets/LICENSE-lucide.txt', import.meta.url), 'utf8'), /ISC License/);
  for (const f of ['OFL-Syne.txt', 'OFL-InstrumentSans.txt', 'OFL-DMMono.txt']) assert.match(readFileSync(new URL(`./assets/fonts/${f}`, import.meta.url), 'utf8'), /SIL Open Font License/);
});
