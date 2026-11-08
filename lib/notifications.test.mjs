import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNotifications } from './notifications.mjs';
import { noticeFromActivity } from './activity.mjs';
import { cloudRunNotice, pollCloudRuns } from './cloud-runs.mjs';

const store = () => { const d = mkdtempSync(join(tmpdir(), 'notes-')); return createNotifications({ dir: () => d }); };

test('newest first, unread counts, read state, key dedupe', () => {
  const n = store();
  n.notify({ title: 'one', level: 'success' }); n.notify({ title: 'two', key: 'k' }); n.notify({ title: 'two again', key: 'k' });
  const l = n.list();
  assert.deepEqual(l.items.map((x) => x.title), ['two', 'one']);
  assert.equal(l.unread, 2);
  assert.equal(n.list({ after: 1 }).items.length, 1, 'after = only newer ids (what the macOS poller asks for)');
  assert.equal(n.markRead([1]).unread, 1);
  assert.equal(n.markRead('all').unread, 0);
  assert.equal(n.notify({}), null, 'no title, no notification');
});

test('activity → notification for meetings, builds, PRs, self-updates; nothing for chatter', () => {
  assert.equal(noticeFromActivity({ kind: 'meeting', status: 'completed', summary: 'board meeting done — 3 queued' }).body, '3 queued');
  assert.equal(noticeFromActivity({ kind: 'build', status: 'failed', summary: 'build failed' }).level, 'error');
  assert.equal(noticeFromActivity({ kind: 'pr-status', status: 'ready', summary: 'PR x ready' }).title, 'PR ready to merge');
  assert.equal(noticeFromActivity({ kind: 'aggregation', status: 'completed', summary: 'x' }), null, 'runs notify from the manager, with their numbers');
  assert.equal(noticeFromActivity({ kind: 'meeting', status: 'started', summary: 'x' }), null);
});

test('cloud runs: one notification per finished run, none for a running one', async () => {
  const runs = [{ id: 2, pipeline: 'applicant_reports_cloud', status: 'running', started_at: 'x' },
    { id: 1, pipeline: 'applicant_reports_cloud', status: 'partial', finished_at: '2026-10-21T13:00:00Z', new_reports: 3, summary: { companies: [{ company: 'Axon', new_reports: 3 }] } }];
  assert.equal(cloudRunNotice(runs[0]), null);
  assert.match(cloudRunNotice(runs[1]).title, /3 new reports/);
  const n = store();
  const a = await pollCloudRuns({ fetchRuns: async () => ({ ok: true, runs }), notify: n.notify });
  const b = await pollCloudRuns({ fetchRuns: async () => ({ ok: true, runs }), notify: n.notify });
  assert.equal(a.added, 1); assert.equal(b.added, 0);
  assert.match(n.list().items[0].body, /Axon 3/);
});
