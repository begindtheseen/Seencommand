// Notifications — the one place Seen Command tells the owner something finished, failed or needs them.
// Producers: the aggregation manager (every run end, the automatic re-run of a partial run, a scheduled run
// that could not start), board meetings, builds, and the cloud collector runs on Seen (read by the server).
// Consumers: the Notifications tab, the nav badge, and the Electron shell, which turns every new one into a
// native macOS notification and a Dock badge (app/main.js polls GET /api/notifications?after=<id>).
//
// Stored as one small JSON file under the runtime data dir (newest first, 500 kept). Writes are atomic and
// serialized in-process; read state is per notification. A `key` dedupes: the same key is recorded once
// (used for cloud runs, which are re-read every poll).
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from './paths.mjs';

export const LEVELS = ['success', 'info', 'warning', 'error'];
const KEEP = 500;

export function createNotifications({ dir = () => dataDir(), now = () => new Date() } = {}) {
  const file = () => { const d = dir(); mkdirSync(d, { recursive: true }); return join(d, 'notifications.json'); };
  const read = () => { try { const v = JSON.parse(readFileSync(file(), 'utf8')); return Array.isArray(v.items) ? v : { seq: 0, items: [] }; } catch { return { seq: 0, items: [] }; } };
  const write = (v) => { const f = file(); const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); renameSync(tmp, f); };

  function notify({ kind = 'info', level = 'info', title, body = '', tab = null, ref = null, key = null, at = null } = {}) {
    if (!title) return null;
    const v = read();
    if (key && v.items.some((n) => n.key === key)) return null;
    const n = { id: (v.seq || 0) + 1, at: at || now().toISOString(), kind: String(kind).slice(0, 40), level: LEVELS.includes(level) ? level : 'info',
      title: String(title).slice(0, 160), body: String(body || '').slice(0, 600), tab, ref, key, read: false };
    v.seq = n.id; v.items = [n, ...v.items].slice(0, KEEP);
    write(v);
    return n;
  }
  function list({ limit = 100, after = 0, unread = false } = {}) {
    const v = read();
    const items = v.items.filter((n) => n.id > Number(after || 0) && (!unread || !n.read)).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    return { items, unread: v.items.filter((n) => !n.read).length, latest: v.seq || 0 };
  }
  function markRead(ids = 'all') {
    const v = read(); const set = ids === 'all' ? null : new Set([].concat(ids).map(Number));
    let changed = 0;
    for (const n of v.items) if (!n.read && (!set || set.has(n.id))) { n.read = true; changed++; }
    if (changed) write(v);
    return { changed, unread: v.items.filter((n) => !n.read).length };
  }
  function clear() { const v = read(); write({ seq: v.seq || 0, items: [] }); return { cleared: v.items.length }; }
  return { notify, list, markRead, clear };
}

let singleton = null;
export const notifications = () => (singleton ||= createNotifications());
export const notify = (n) => { try { return notifications().notify(n); } catch { return null; } };
