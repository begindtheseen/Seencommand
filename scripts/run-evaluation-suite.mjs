#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = join(import.meta.dirname, '..'); const files = [];
const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.test.mjs')) files.push(relative(root, p)); } };
walk(join(root, 'intelligence'));
execFileSync(process.execPath, ['--test', ...files.sort()], { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
