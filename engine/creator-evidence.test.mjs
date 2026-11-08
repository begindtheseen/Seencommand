// Board meeting ← Creator Library: the department prompt carries the cited creator-evidence block when
// (and only when) the library has lines strong enough for that department, and a proposal that quotes a
// creator count it was never shown is caught in code. reason() is stubbed — no model, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights, creatorEvidenceBlock, checkCreatorCitations } from '../lib/instagram/insights.mjs';
import { fixtureCorpora, FIXTURE_NOW } from '../lib/instagram/insights.fixtures.mjs';

const { deptAgenda } = await import('./run.mjs');
const { departmentById } = await import('../org/org.mjs');
const FOCUS = { title: 'Test focus', northStar: 'test', dept: {} };
const ARGS = { focus: FOCUS, kpisStr: '', digest: '', memBlock: '', timeline: '', directiveBlock: '', openTaskTitles: [], decidedLines: [] };
const lib = buildInsights(fixtureCorpora(), { now: FIXTURE_NOW });

async function promptFor(deptId, creatorBlock) {
  let seen = '';
  await deptAgenda({ ...ARGS, dept: departmentById(deptId), creatorBlock,
    reasonFn: async ({ prompt }) => { seen = prompt; return { text: '', engine: 'fallback' }; } });
  return seen;
}

test('growth prompt carries the cited CREATOR EVIDENCE block + the cite-your-support rule', async () => {
  const block = creatorEvidenceBlock(lib, 'growth');
  const p = await promptFor('growth', block.text);
  assert.match(p, /CREATOR EVIDENCE \(Creator Library: 3 public creators, 17 videos/);
  assert.match(p, /\[hook · observed · strong\]/);
  assert.match(p, /3 creators \/ 10 videos/);
  assert.match(p, /never invent a count/);
  // Size: the block is a bounded slice of the prompt, not the archive.
  assert.ok(block.text.length <= 1500);
});

test('no block → the prompt has neither the evidence nor the citation rule', async () => {
  const empty = creatorEvidenceBlock(buildInsights([]), 'growth');
  assert.equal(empty.text, '');
  const p = await promptFor('growth', empty.text);
  assert.doesNotMatch(p, /CREATOR EVIDENCE/);
  assert.doesNotMatch(p, /never invent a count/);
  // A department the library has nothing for gets nothing, even with a full library.
  const rel = creatorEvidenceBlock(lib, 'reliability');
  assert.equal(rel.text, '');
  assert.doesNotMatch(await promptFor('reliability', rel.text), /CREATOR EVIDENCE/);
});

test('the departments wired to the Creator Library are exactly the ones that receive its block', async () => {
  const { DEPT_TOOLS } = await import('../org/tools.mjs');
  const { DEPT_TYPES } = await import('../lib/instagram/insights.mjs');
  const wired = Object.keys(DEPT_TOOLS).filter((d) => DEPT_TOOLS[d].includes('instagram_compiler')).sort();
  assert.deepEqual(wired, Object.keys(DEPT_TYPES).sort());
});

test('proposal citations are checked against what the department was shown', () => {
  const { used } = creatorEvidenceBlock(lib, 'growth');
  const hook = used.find((i) => i.type === 'hook');
  const ok = checkCreatorCitations(`Open every Ghost Index reel with a pain-first question (${hook.support.creators} creators / ${hook.support.videos} videos). Done means: …`, used);
  assert.deepEqual(ok.cited, [hook.id]);
  assert.deepEqual(ok.phantom, []);
  const bad = checkCreatorCitations('Post 5x a day (9 creators / 40 videos). Done means: …', used);
  assert.deepEqual(bad.cited, []);
  assert.deepEqual(bad.phantom, ['9 creators / 40 videos']);
  assert.deepEqual(checkCreatorCitations('No creator claims here.', used), { cited: [], phantom: [] });
});
