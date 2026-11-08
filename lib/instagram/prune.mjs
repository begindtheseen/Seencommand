// Prune — archive what does not serve Seen, reversibly; purge only on an explicit confirmation.
//
//   plan    → what the relevance gate (relevance.mjs) would archive: accounts whose verdict is "prune"
//             and knowledge rows that inform nothing of Seen's growth, content, brand or product. Each
//             item carries its reason. Nothing changes.
//   prune   → writes that plan to the archive (data/instagram-archive.json). Archived rows/accounts
//             vanish from every view, the board-meeting block and the chat context — and come back with
//             restore. The compiler's own data is untouched.
//   purge   → for disk space, only with confirm === PURGE_PHRASE: each archived WRITABLE account's whole
//             research folder (videos, audio, frames, evidence, knowledge) is deleted for good; archived
//             rows become permanently hidden. Read-only / registered datasets are never deleted (they
//             stay archived). Returns what was freed.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dataDir } from '../paths.mjs';

export const PURGE_PHRASE = 'PURGE ARCHIVED';
const file = () => join(dataDir(), 'instagram-archive.json');
const empty = () => ({ accounts: {}, rows: {}, purged: { accounts: {}, rows: {} } });

export function readArchive() {
  try { if (!existsSync(file())) return empty(); const a = JSON.parse(readFileSync(file(), 'utf8')); return { ...empty(), ...a, purged: { ...empty().purged, ...(a.purged || {}) } }; }
  catch { return empty(); }
}
function writeArchive(a) { const p = file(); mkdirSync(dirname(p), { recursive: true }); const t = `${p}.tmp`; writeFileSync(t, JSON.stringify(a, null, 2)); renameSync(t, p); }

const hiddenRows = (a, project) => new Set([...Object.keys(a.rows[project] || {}), ...Object.keys(a.purged.rows[project] || {})]);
export const isArchivedAccount = (project, a = readArchive()) => !!(a.accounts[project] || a.purged.accounts[project]);

// Remove archived accounts and rows from a list of corpora (applied before any insight is built).
export function applyArchive(corpora, a = readArchive()) {
  return (corpora || []).filter((c) => c && !isArchivedAccount(c.project, a)).map((c) => {
    const hide = hiddenRows(a, c.project);
    return hide.size ? { ...c, knowledge: (c.knowledge || []).filter((k) => !hide.has(k.knowledge_id)) } : c;
  });
}

// What prune WOULD archive, from a buildInsights() result over the un-archived library.
export function planPrune(lib, { bytesFor = () => null } = {}) {
  const accounts = (lib?.creators || []).filter((c) => c.verdict?.verdict === 'prune')
    .map((c) => ({ project: c.project, handle: c.handle, why: c.verdict.why, bytes: bytesFor(c.project) }));
  const gone = new Set(accounts.map((a) => a.project));
  const rows = (lib?.pruned || []).filter((r) => !gone.has(r.project)); // an archived account takes its rows with it
  return { accounts, rows, counts: { accounts: accounts.length, rows: rows.length, bytes: accounts.reduce((s, a) => s + (a.bytes || 0), 0) } };
}

export function applyPrune(plan, { now = new Date().toISOString() } = {}) {
  const a = readArchive();
  for (const x of plan.accounts || []) a.accounts[x.project] = { at: now, why: x.why, handle: x.handle };
  for (const r of plan.rows || []) { (a.rows[r.project] ||= {})[r.knowledge_id] = { at: now, why: r.why, title: r.title }; }
  writeArchive(a);
  return { ok: true, archived: { accounts: (plan.accounts || []).length, rows: (plan.rows || []).length } };
}

// Undo: everything, one account (and its rows), or specific rows.
export function restore({ project = null, knowledgeIds = null, all = false } = {}) {
  const a = readArchive(); let accounts = 0; let rows = 0;
  if (all) { accounts = Object.keys(a.accounts).length; rows = Object.values(a.rows).reduce((s, r) => s + Object.keys(r).length, 0); a.accounts = {}; a.rows = {}; }
  else if (project && Array.isArray(knowledgeIds) && knowledgeIds.length) { for (const id of knowledgeIds) if (a.rows[project]?.[id]) { delete a.rows[project][id]; rows++; } }
  else if (project) { if (a.accounts[project]) { delete a.accounts[project]; accounts++; } rows = Object.keys(a.rows[project] || {}).length; delete a.rows[project]; }
  else return { ok: false, code: 400, error: 'say what to restore: { all: true } | { project } | { project, knowledgeIds: [...] }' };
  writeArchive(a);
  return { ok: true, restored: { accounts, rows } };
}

// Permanent. deleteProject is injected (jobs.deleteProject) so tests never remove real folders.
export function purgeArchived({ confirm, deleteProject, now = new Date().toISOString() } = {}) {
  if (confirm !== PURGE_PHRASE) return { ok: false, code: 400, error: `type "${PURGE_PHRASE}" to permanently delete archived accounts (raw media, evidence, knowledge) and hide archived rows for good` };
  const a = readArchive(); const deleted = []; const kept = []; let freedBytes = 0; let rows = 0;
  for (const [project, info] of Object.entries(a.accounts)) {
    const r = deleteProject ? deleteProject(project, { confirm: project }) : { ok: false, error: 'no deleter' };
    if (r.ok) { deleted.push(project); freedBytes += r.freedBytes || 0; a.purged.accounts[project] = { ...info, purgedAt: now }; delete a.accounts[project]; delete a.rows[project]; }
    else kept.push({ project, why: r.error || 'could not delete' }); // e.g. a read-only fixture: stays archived
  }
  for (const [project, ids] of Object.entries(a.rows)) { (a.purged.rows[project] ||= {}); for (const [id, info] of Object.entries(ids)) { a.purged.rows[project][id] = { ...info, purgedAt: now }; rows++; } }
  a.rows = {};
  writeArchive(a);
  return { ok: true, purged: { accounts: deleted, rows, freedBytes }, keptArchived: kept };
}

export function archiveSummary(a = readArchive()) {
  const rowCount = (m) => Object.values(m).reduce((s, r) => s + Object.keys(r).length, 0);
  return { archived: { accounts: Object.entries(a.accounts).map(([project, v]) => ({ project, ...v })), rows: rowCount(a.rows) },
    purged: { accounts: Object.keys(a.purged.accounts).length, rows: rowCount(a.purged.rows) },
    rowsByProject: Object.fromEntries(Object.entries(a.rows).map(([p, r]) => [p, Object.entries(r).map(([knowledge_id, v]) => ({ knowledge_id, ...v }))])) };
}
