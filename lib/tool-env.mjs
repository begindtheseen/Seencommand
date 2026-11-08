// The environment for launching a local CLI that is itself a Node script (cline, claude, opencli…).
//
// A Finder/launchd-launched Seen Command gets macOS's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a
// CLI whose first line is `#!/usr/bin/env node` dies with exit 127 "env: node: No such file or
// directory" even though it is installed and works in Terminal (Settings → System diagnostics,
// 2026-10-19: "Cline exited 127"). The binary's OWN install says where its node lives:
//   • the directory the binary is in (Homebrew: /opt/homebrew/bin holds both cline and node);
//   • for an npm global install, the link resolves into <prefix>/lib/node_modules/…, and that
//     prefix's bin/ is the node that installed it (nvm: ~/.nvm/versions/node/vX/bin).
// Then the usual Homebrew/system locations, then whatever PATH the process already had.
// Tests: lib/tool-env.test.mjs.

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const COMMON = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export function toolPathFor(bin, basePath = process.env.PATH, { realpath = realpathSync, home = process.env.HOME } = {}) {
  const dirs = [];
  const b = String(bin || '');
  if (b && isAbsolute(b)) {
    dirs.push(dirname(b));
    try {
      const real = realpath(b);
      dirs.push(dirname(real));
      const i = real.indexOf('/lib/node_modules/');
      if (i > 0) dirs.push(join(real.slice(0, i), 'bin'));
    } catch { /* a missing binary is reported by the caller */ }
  }
  dirs.push(...COMMON);
  if (home) dirs.push(join(home, '.local', 'bin'));
  dirs.push(...String(basePath || '').split(':'));
  return [...new Set(dirs.filter(Boolean))].join(':');
}

/** process.env with a PATH that can find `bin`'s node. Never mutates the input. */
export function toolEnv(bin, base = process.env, opts) {
  return { ...base, PATH: toolPathFor(bin, base.PATH, opts) };
}

// The env for the local `claude` CLI. It must authenticate as ITSELF — the owner's claude.ai login (e.g. a
// Max subscription in the macOS Keychain). Seen Command loads an ANTHROPIC_API_KEY for its own model calls;
// if that leaks into the child, Claude Code prefers it over the subscription ("logged in via api_key") and
// every turn bills — or fails on — the key (owner, 2026-10-21: the Board Room fell back to "memory-only"
// while `claude -p` worked in Terminal on Max). Markers of an outer Claude Code session are stripped too.
const CLAUDE_AUTH_OVERRIDES = /^(CLAUDECODE|CLAUDE_CODE_.*|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/;
export function claudeCliEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (CLAUDE_AUTH_OVERRIDES.test(k)) delete env[k];
  return env;
}
/** toolEnv for the claude CLI: a PATH that finds its node, and no Claude auth overrides. */
export function claudeToolEnv(bin, base = process.env, opts) {
  return toolEnv(bin, claudeCliEnv(base), opts);
}
