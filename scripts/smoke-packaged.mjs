// Packaged-worker smoke (item 5). After `npm run app:package` (electron-builder --mac dir), verify the
// built .app actually carries the Python worker at Contents/Resources/video-software-compiler, and that
// doctor — pointed at that packaged path — verifies the real payload (not a source checkout).
//
// Usage: node scripts/smoke-packaged.mjs   (run after electron-builder produces dist/**/Seen Command.app)

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const dist = join(ROOT, 'dist');
if (!existsSync(dist)) { console.error('✗ dist/ not found — run `npm run app:package` first.'); process.exit(2); }

// Find the packaged .app (mac / mac-arm64 / etc.).
function findApp(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.endsWith('.app')) return join(dir, e.name);
      const nested = findApp(join(dir, e.name)); if (nested) return nested;
    }
  }
  return null;
}
const app = findApp(dist);
if (!app) { console.error('✗ no .app bundle under dist/ — did electron-builder finish?'); process.exit(2); }
console.log('packaged app:', app);

const resources = join(app, 'Contents', 'Resources');
const packagedApp = join(resources, 'app');
const worker = join(resources, 'video-software-compiler');
const required = {
  'intelligence workflow store': join(packagedApp, 'intelligence', 'workflow-store.mjs'),
  'intelligence runtime status': join(packagedApp, 'intelligence', 'runtime-status.mjs'),
  'intelligence model registry': join(packagedApp, 'intelligence', 'model-registry.mjs'),
  'intelligence runtime config': join(packagedApp, 'intelligence', 'runtime-config.mjs'),
  'worker dir': worker,
  'pyproject.toml': join(worker, 'pyproject.toml'),
  'package': join(worker, 'video_software_compiler'),
  'cleanup.py': join(worker, 'video_software_compiler', 'cleanup.py'),
  'skill/instructions': join(worker, '.claude', 'skills', 'video-to-software-compiler', 'SKILL.md'),
};
let ok = true;
for (const [label, p] of Object.entries(required)) {
  const present = existsSync(p);
  console.log(`  ${present ? '✓' : '✗'} ${label}: ${p.replace(app, '<app>')}`);
  if (!present) ok = false;
}
// __pycache__/venv must NOT be bundled.
const leaked = existsSync(join(worker, 'video_software_compiler', '__pycache__'));
if (leaked) { console.log('  ✗ __pycache__ leaked into the bundle'); ok = false; }

// doctor, pointed at the packaged worker, must verify the real payload.
process.env.VSC_TOOL_DIR = worker;
const { doctor } = await import('../lib/instagram/adapter.mjs');
const d = doctor();
const toolCheck = d.checks && d.checks.compiler_tool;
console.log(`  ${toolCheck && toolCheck.ok ? '✓' : '✗'} doctor verifies packaged worker payload: ${toolCheck && toolCheck.detail}`);
if (!toolCheck || !toolCheck.ok) ok = false;

// Import the packaged server from the bundle itself. This catches missing newly-added runtime
// directories before a desktop launch loops forever on connection refused.
const smokeHome = mkdtempSync(join(tmpdir(), 'seen-packaged-import-'));
const previousSeenHome = process.env.SEEN_HOME;
try {
  process.env.SEEN_HOME = smokeHome;
  await import(`${pathToFileURL(join(packagedApp, 'engine', 'server.mjs')).href}?smoke=${Date.now()}`);
  console.log('  ✓ packaged server imports its complete runtime dependency graph');
} catch (error) {
  console.log(`  ✗ packaged server import failed: ${error.message}`); ok = false;
} finally {
  if (previousSeenHome == null) delete process.env.SEEN_HOME; else process.env.SEEN_HOME = previousSeenHome;
  rmSync(smokeHome, { recursive: true, force: true });
}

if (ok) { console.log('\n✓ PACKAGED APP SMOKE PASSED — server runtime and Python worker ship with the app.'); process.exit(0); }
console.error('\n✗ PACKAGED APP SMOKE FAILED.'); process.exit(1);
