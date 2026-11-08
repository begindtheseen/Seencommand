// The Growth Studio's durable files: one JSON document per thing (brand, plan, calendar, copy, daily,
// actuals, library) under <runtime data>/growth/. Writes are atomic (tmp + rename). Tests point the
// store at a scratch folder with setGrowthDir(). Every read is defensive — a missing or broken file is
// the empty document, never a crash. The brain gets a POINTER fact for each durable change (who/what/
// when, the version) so the next session and the board know it exists; the content lives here.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from '../paths.mjs';

let override = null;
export function setGrowthDir(dir) { override = dir || null; }
export function growthDir() { const d = override || join(dataDir(), 'growth'); mkdirSync(d, { recursive: true }); return d; }
const file = (name) => join(growthDir(), `${String(name).replace(/[^a-z0-9_-]/gi, '_')}.json`);

export function readDoc(name, empty = {}) {
  const f = file(name);
  if (!existsSync(f)) return structuredClone(empty);
  try { const v = JSON.parse(readFileSync(f, 'utf8')); return v && typeof v === 'object' ? v : structuredClone(empty); } catch { return structuredClone(empty); }
}
export function writeDoc(name, value) {
  const f = file(name); const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, f);
  return value;
}
export function updateDoc(name, empty, fn) { const cur = readDoc(name, empty); const next = fn(cur) ?? cur; return writeDoc(name, next); }
