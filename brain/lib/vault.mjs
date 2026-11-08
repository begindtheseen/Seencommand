// vault — shared read helpers over the Chronos markdown vault. One place that knows how to walk the
// vault and turn it into the bi-temporal index (via the vendored engine), so the writer, the MCP
// server, and the Seen Command connector all read it the same way.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildIndex } from './chronos/memoryGraph.mjs';

export function walkVault(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.graph' || name === '.obsidian' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkVault(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

// [{ path, text }] for every note, path relative to the vault root (its stable id).
export function readNotes(vaultPath) {
  if (!vaultPath || !existsSync(vaultPath)) return [];
  return walkVault(vaultPath).map((f) => ({
    path: relative(vaultPath, f).replace(/\\/g, '/'),
    text: readFileSync(f, 'utf8'),
  }));
}

// The bi-temporal index (facts, episodes, edges, entities) for a vault.
export function readIndex(vaultPath) {
  return buildIndex(readNotes(vaultPath));
}
