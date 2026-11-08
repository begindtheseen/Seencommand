// vault-write — ONE serialization + atomicity contract for every vault note read-modify-write.
//
// Why this exists: a day note is written by at least three independent processes — the Brain MCP
// server (brain_append_timeline), the SessionEnd capture hook running out of the installed
// Seen Command bundle, and the cloud pull that materializes remote timeline rows. Each one used a
// bare read → mutate → writeFileSync. That is a lost update waiting to happen, and it happened:
// an audited-successful append vanished, and the surviving file proved the note had been observed
// EMPTY mid-write (writeFileSync truncates before it writes, so a concurrent reader can see zero
// bytes and then write that back). Both halves have to be fixed together:
//
//   • serialize   — hold a cross-process lock across the whole read→mutate→write section, so two
//                   writers cannot interleave.
//   • make atomic — write a sibling temp file and rename it into place, so a reader in another
//                   process never observes a truncated or half-written note even without the lock.
//
// Lock and temp names both start with '.', which walkVault already skips, so neither can be picked
// up as a note, pushed to the cloud, or indexed as a fact.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withSyncDirectoryLock } from './file-lock.mjs';

// Deterministic per-note lock, shared by every process touching that note.
export function noteLockPath(abs) {
  return join(dirname(abs), `.${basename(abs)}.lock`);
}

// Replace a note in one step. The rename is atomic within the directory, so a concurrent reader
// sees either the old note or the new one — never the empty window writeFileSync opens.
export function writeNoteAtomic(abs, content) {
  const dir = dirname(abs);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(abs)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort: a stray temp must not mask the real error */ }
    throw error;
  }
}

// Run a read-modify-write against one note under its lock.
//
// `mutate` receives the note's current text (null when it does not exist yet) and returns
// { content, value }. A null/undefined `content` means "decided not to write" — the idempotent
// append path uses that to skip the write entirely while still reporting its result.
export function withNoteWrite(abs, mutate) {
  return withSyncDirectoryLock(noteLockPath(abs), () => {
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    const { content, value } = mutate(current) || {};
    if (typeof content === 'string') writeNoteAtomic(abs, content);
    return value;
  });
}
