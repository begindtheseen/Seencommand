import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, parseTimelineEpisode } from './memoryGraph.mjs';

test('timeline index recovers type-less and headerless day notes by their canonical path', () => {
  const index = buildIndex([
    { path: 'timeline/2026-08-13.md', text: '---\ntitle: 2026-08-13\ndate: 2026-08-13\ntags: [timeline]\n---\n\n## Cloud\n\npulled' },
    { path: 'timeline/2026-08-14.md', text: '## Protected Brain hardening branches merged\n\ndone' },
  ]);
  assert.equal(index.episodes.length, 2);
  assert.deepEqual(index.episodes.map((e) => e.date).sort(), ['2026-08-13', '2026-08-14']);
  assert.equal(index.episodes.find((e) => e.date === '2026-08-14').sections['Protected Brain hardening branches merged'], 'done');
});

test('timeline index does not reinterpret an ordinary dated note as an episode', () => {
  assert.equal(parseTimelineEpisode({ title: 'Release', date: '2026-08-14' }, '## Notes\nbody', 'knowledge/release.md'), null);
});
