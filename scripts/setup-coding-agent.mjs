#!/usr/bin/env node
// Install the open-source Cline coding runtime used by Seen Command's advanced builder lane.
// Cline ships a platform binary; on macOS npm's copy can invalidate its ad-hoc signature, so repair
// both the cached and optional-package copies before verifying the executable.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit' });
run('npm', ['install', '-g', '--allow-scripts=cline,protobufjs', 'cline']);

const root = run('npm', ['root', '-g'], { capture: true }).trim();
if (process.platform === 'darwin') {
  const candidates = [
    join(root, 'cline', 'bin', '.cline'),
    join(root, 'cline', 'node_modules', '@cline', `cli-darwin-${process.arch}`, 'bin', 'cline'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) run('codesign', ['--force', '--sign', '-', candidate]);
  }
}

const version = run('cline', ['--version'], { capture: true }).trim();
console.log(`[agent-setup] Cline ${version} installed and executable.`);
console.log('[agent-setup] Next: run `cline auth`, choose your provider/model, then Seen Command will use Cline first in AUTO.');
