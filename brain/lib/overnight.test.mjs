import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readOvernight, classifyLane } from './overnight.mjs';

const day = (date, sections) => `---\ntitle: ${date}\ndate: ${date}\ntags: [timeline]\n---\n\n`
  + sections.map(([h, b]) => `## ${h}\n\n${b}`).join('\n\n') + '\n';

test('classifyLane tags each 4am routine and leaves ordinary entries untagged', () => {
  assert.equal(classifyLane('4am — applications: brain is clean'), 'applications');
  assert.equal(classifyLane('4am — seenjobs.io: board count still 27'), 'seenjobs.io');
  assert.equal(classifyLane('4AM — Product lane report'), 'seenjobs.io');
  assert.equal(classifyLane('4am run, lane unstated'), 'overnight'); // tagged, lane unknown
  // An ordinary entry a human or session wrote is NOT a run — it still shows, just unbadged.
  assert.equal(classifyLane('Both 4am lanes are live'), null); // "4am" mid-heading is not a run
  assert.equal(classifyLane('Fixed the worktree .env fallback'), null);
  assert.equal(classifyLane(''), null);
});

test('newest day first, and newest entry first WITHIN a day (files are append-ordered)', () => {
  const files = {
    '2026-08-13.md': day('2026-08-13', [['first of today', 'a'], ['4am — applications: second', 'b']]),
    '2026-08-12.md': day('2026-08-12', [['yesterday', 'c']]),
  };
  const r = readOvernight({
    vaultPath: '/v', days: 7, today: '2026-08-13',
    readFile: (abs) => files[abs.split('/').pop()] || null,
  });
  assert.deepEqual(r.entries.map((e) => e.heading),
    ['4am — applications: second', 'first of today', 'yesterday']);
  assert.deepEqual(r.days, ['2026-08-13', '2026-08-12']);
  assert.equal(r.counts.entries, 3);
  assert.equal(r.counts.runs, 1); // only the tagged one counts as an agent run
  assert.equal(r.entries[0].lane, 'applications');
  assert.equal(r.entries[1].lane, null);
});

test('missing days, empty files, and no vault are all quiet — never a thrown error', () => {
  const r = readOvernight({ vaultPath: '/v', days: 3, today: '2026-08-13', readFile: () => null });
  assert.deepEqual(r.entries, []);
  assert.equal(r.counts.runs, 0);

  // A day-note with frontmatter but no `##` sections yet contributes nothing and is not listed.
  const bare = readOvernight({
    vaultPath: '/v', days: 2, today: '2026-08-13',
    readFile: () => '---\ntitle: 2026-08-13\n---\n',
  });
  assert.deepEqual(bare.days, []);
  assert.deepEqual(bare.entries, []);

  const noVault = readOvernight({ vaultPath: null, today: '2026-08-13' });
  assert.deepEqual(noVault.entries, []);
});

test('the window walks back calendar days, including across a month boundary', () => {
  const asked = [];
  readOvernight({
    vaultPath: '/v', days: 3, today: '2026-09-01',
    readFile: (abs) => { asked.push(abs); return null; },
  });
  assert.deepEqual(asked, [
    join('/v', 'timeline', '2026-09-01.md'),
    join('/v', 'timeline', '2026-08-31.md'),
    join('/v', 'timeline', '2026-08-30.md'),
  ]);
});
