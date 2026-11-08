// The Board Room's "answered from memory only" note must name the REAL reason (it used to always say
// "log in the claude CLI", even when it was logged in). The function lives inside the generated page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./build-dashboard.mjs', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('function degradeNote(why){'), src.indexOf('window.askBoardRoom=function'));
const degradeNote = new Function(`${body}; return degradeNote;`)();
test('the note names the reason and only suggests login when login is the problem', () => {
  assert.match(degradeNote('the Claude lane has no credits remaining'), /no credits remaining.*out of credits/);
  assert.doesNotMatch(degradeNote('the Claude lane has no credits remaining'), /run claude in Terminal, then \/login\.$/);
  assert.match(degradeNote('the claude CLI is not logged in — run `claude` then /login in Terminal'), /Fix: run claude in Terminal, then \/login/);
  assert.match(degradeNote('the Cline lane was killed by macOS (SIGKILL, no output)'), /npm run agent:setup/);
  assert.match(degradeNote(''), /memory only/);
});
