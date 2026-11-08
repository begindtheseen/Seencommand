// Real ELECTRON_RUN_AS_NODE runtime smoke (item 4). Boots engine/server.mjs under the PACKAGED
// Electron binary's embedded Node — exactly how app/main.js runs it — with --experimental-sqlite, and
// exercises Library reads (which use node:sqlite). Proves node:sqlite works in the shipped runtime.
//
// Usage: node scripts/smoke-electron.mjs
// Requires: electron installed (npm i) and a read-only creator fixture root via VSC_READONLY_ROOTS (default: ~/vsc-fixtures/projects).

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const PORT = process.env.SMOKE_PORT || '4211';
const fixture = process.env.VSC_READONLY_ROOTS || join(homedir(), 'vsc-fixtures', 'projects');

function electronBin() {
  // The electron package exports the binary path as its main export (a string).
  try { const p = require('electron'); if (typeof p === 'string' && existsSync(p)) return p; } catch { /* fall through */ }
  const txt = join(ROOT, 'node_modules', 'electron', 'path.txt');
  if (existsSync(txt)) { const rel = readFileSync(txt, 'utf8').trim(); const p = join(ROOT, 'node_modules', 'electron', 'dist', rel); if (existsSync(p)) return p; }
  return null;
}

const bin = electronBin();
if (!bin) { console.error('✗ electron is not installed — run `npm install` first. (This smoke needs the real Electron binary.)'); process.exit(2); }
console.log('electron binary:', bin);
console.log('embedded runtime: booting engine/server.mjs as ELECTRON_RUN_AS_NODE with --experimental-sqlite\n');

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-sqlite'].filter(Boolean).join(' ').trim(),
  PORT, SEEN_NO_OPEN: '1', VSC_READONLY_ROOTS: fixture,
};
const child = spawn(bin, [join(ROOT, 'engine', 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (c) => { log += c; });
child.stderr.on('data', (c) => { log += c; });

const base = `http://localhost:${PORT}`;
async function waitUp(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base + '/api/instagram/doctor'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let code = 1;
try {
  if (!(await waitUp())) throw new Error('server did not come up under electron-as-node\n' + log);
  const doctor = await (await fetch(base + '/api/instagram/doctor')).json();
  const sqlite = doctor.checks && doctor.checks.sqlite;
  if (!sqlite || !sqlite.ok) throw new Error('node:sqlite unavailable in the Electron runtime: ' + (sqlite && sqlite.error));
  const lib = await (await fetch(base + '/api/instagram/library')).json();
  const projects = (lib.projects || []).length;
  if (projects < 1) throw new Error('Library returned no projects — the SQLite read path is not working (fixture root: ' + fixture + ')');
  const first = lib.projects[0];
  const vids = await (await fetch(base + `/api/instagram/projects/${encodeURIComponent(first.name)}/videos`)).json();
  const nVids = (vids.videos || []).length;
  console.log(`✓ ELECTRON RUNTIME SMOKE PASSED`);
  console.log(`  node:sqlite: ok`);
  console.log(`  library projects: ${projects} (first: ${first.name}, ${first.counts.videos} videos)`);
  console.log(`  videos read via node:sqlite: ${nVids}`);
  code = 0;
} catch (e) {
  console.error('✗ ELECTRON RUNTIME SMOKE FAILED:', e.message);
} finally {
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  process.exit(code);
}
