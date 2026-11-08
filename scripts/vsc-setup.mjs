// Explicit, user-run setup for the Instagram compiler's Python worker venv. NEVER run automatically —
// dependencies are installed only when Brandon runs `npm run vsc:setup`, and the requirements are shown
// honestly. Creates a venv under the writable data dir and installs the vendored tool + its deps.
//
// Usage: npm run vsc:setup   (needs python3 + network for pip; ffmpeg/tesseract are system installs)

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../lib/config.mjs';

const toolDir = config.vscToolDir();
const venvPy = config.vscPython();               // <dataDir>/vsc-venv/bin/python (discovery target)
const venvDir = dirname(dirname(venvPy));         // .../vsc-venv

console.log('Instagram compiler worker setup');
console.log('  tool dir :', toolDir);
console.log('  venv     :', venvDir);
if (!existsSync(join(toolDir, 'pyproject.toml'))) { console.error(`\n✗ worker not found at ${toolDir} — is the app packaged / repo intact?`); process.exit(1); }

const py3 = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (py3.status !== 0) { console.error('\n✗ python3 is required and was not found. Install Python 3, then re-run. Nothing was installed.'); process.exit(1); }
console.log('  python3  :', (py3.stdout || py3.stderr || '').trim());

console.log('\nThese system tools are also required (install them yourself if the doctor flags them):');
console.log('  • ffmpeg + ffprobe (brew install ffmpeg)   • tesseract (brew install tesseract)   • the Claude CLI (claude → /login)\n');

if (!existsSync(venvPy)) {
  mkdirSync(dirname(venvDir), { recursive: true });
  console.log('Creating venv…');
  const mk = spawnSync('python3', ['-m', 'venv', venvDir], { stdio: 'inherit' });
  if (mk.status !== 0) { console.error('✗ venv creation failed. Nothing installed.'); process.exit(1); }
}
console.log('Installing the vendored worker + dependencies (pip)…');
const pip = spawnSync(venvPy, ['-m', 'pip', 'install', '--upgrade', '-e', `${toolDir}[instagram,media]`], { stdio: 'inherit' });
if (pip.status !== 0) { console.error('\n✗ pip install failed — see output above. The venv exists but is incomplete.'); process.exit(1); }

console.log('\n✓ Worker venv ready:', venvPy);
console.log('  Run the app and open the Creator Library; the doctor strip shows remaining requirements honestly.');
