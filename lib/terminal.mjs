// Open a real Claude Code session in Terminal, in one of the two checkouts (owner, 2026-10-21: "make it so
// seen command can manually open the claude terminal session"). macOS only: Terminal.app runs a login shell
// (so `claude` is on the owner's PATH like when they open Terminal themselves), `cd`s into the repo, and
// starts `claude` — optionally with a first message (e.g. a ticket's brief). The window is the owner's: we
// never type into it again, never read it, and never pass secrets.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

export const REPOS = { seen: () => config.productRepoDir(), command: () => config.commandRepoDir() };

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote
const asQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string

// The exact shell line Terminal will run, and the AppleScript that opens it (pure — unit tested).
export function terminalScript({ dir, prompt = '', bin = 'claude' }) {
  const p = String(prompt || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 4000);
  const line = `cd ${shQuote(dir)} && ${shQuote(bin)}${p ? ` ${shQuote(p)}` : ''}`;
  return { line, osa: `tell application "Terminal"\n  activate\n  do script ${asQuote(line)}\nend tell` };
}

export function openClaudeTerminal({ repo = 'command', prompt = '' } = {}, { platform = process.platform, run = execFile, exists = existsSync } = {}) {
  if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'Opening a Terminal window works on the Mac app only.' });
  const dirOf = REPOS[repo];
  if (!dirOf) return Promise.resolve({ ok: false, error: `repo must be ${Object.keys(REPOS).join(' or ')}` });
  const dir = dirOf();
  if (!dir || !exists(join(dir, '.git'))) return Promise.resolve({ ok: false, error: `No ${repo === 'seen' ? 'Seen' : 'Seen Command'} checkout at ${dir} — set ${repo === 'seen' ? 'SEEN_PRODUCT_REPO_DIR' : 'SEEN_COMMAND_REPO_DIR'} in Settings.` });
  const configured = config.claudeCliPath();
  const bin = configured && configured !== 'claude' && exists(configured) ? configured : 'claude';
  const { osa } = terminalScript({ dir, prompt, bin });
  return new Promise((resolve) => run('osascript', ['-e', osa], { timeout: 15000 }, (err) => {
    resolve(err ? { ok: false, error: /not allowed|1743|-1743/.test(String(err.message)) ? 'macOS blocked Seen Command from controlling Terminal — allow it in System Settings → Privacy & Security → Automation.' : `Terminal did not open: ${String(err.message).slice(0, 160)}` } : { ok: true, repo, dir });
  }));
}
