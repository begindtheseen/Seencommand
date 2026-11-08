// CONCURRENCY regression for the shared vault write contract.
//
// The bug this pins, observed in the real vault on 2026-08-15: an audited-successful
// brain_append_timeline for heading `Codex passed the Chronos torch to claude-brain` vanished from
// timeline/2026-08-15.md. The surviving file proved how — its leading bytes were "\n\n## Claude
// session" with no frontmatter, which is what appendTimeline emits when it reads an EMPTY note
// (the absent-note path writes a `---` header instead). writeFileSync truncates before it writes,
// so a second process reading inside that window sees zero bytes and writes its result over the
// first writer's content.
//
// At least three processes write one day note — the Brain MCP server, the SessionEnd capture hook
// running from the installed Seen Command bundle, and the cloud pull. A 20-way reproducer against
// the unfixed writer lost 2 of 20 appends while every call returned success.
//
// The first test below fails on the unfixed writer and passes under the lock + atomic rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noteLockPath, writeNoteAtomic, withNoteWrite } from './vault-write.mjs';

function newVault() { return mkdtempSync(join(tmpdir(), 'chronos-vault-')); }
const writerUrl = new URL('./memory-write.mjs', import.meta.url).href;

// Each child appends one distinctly-headed episode to the SAME day note, all at once.
function raceAppends(vault, count) {
  const script = `
    const { appendTimeline } = await import(${JSON.stringify(writerUrl)});
    appendTimeline(process.argv[2], { date: '2026-08-15', heading: 'Entry ' + process.argv[3], text: 'body ' + process.argv[3] });
  `;
  const runner = join(vault, 'runner.mjs');
  writeFileSync(runner, script);
  return Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, vault, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ${i} failed: ${err}`))));
  })));
}

test('concurrent appendTimeline calls do not lose episodes', async () => {
  const vault = newVault();
  try {
    const N = 20;
    await raceAppends(vault, N);
    const text = readFileSync(join(vault, 'timeline', '2026-08-15.md'), 'utf8');
    const lost = [];
    for (let i = 0; i < N; i++) {
      if (!new RegExp(`^## Entry ${i}\\s*$`, 'm').test(text)) lost.push(i);
    }
    assert.deepEqual(lost, [], `lost ${lost.length}/${N} concurrent appends: ${lost.join(', ')}`);
    // The note must still be a well-formed day note, not a fragment left by a torn write.
    assert.ok(text.startsWith('---\n'), 'day note kept its frontmatter through the race');
    assert.match(text, /^type: daily$/m);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('lock and temp entries are hidden from the vault walker', async () => {
  const vault = newVault();
  try {
    mkdirSync(join(vault, 'timeline'), { recursive: true });
    const abs = join(vault, 'timeline', '2026-08-15.md');
    // Names must begin with '.' — walkVault skips dotted entries, so neither the lock directory nor
    // a temp file can be indexed as a note, pushed to the cloud, or parsed as an episode.
    assert.ok(noteLockPath(abs).split('/').pop().startsWith('.'));
    withNoteWrite(abs, () => ({ content: 'x', value: null }));
    const leftover = readdirSync(join(vault, 'timeline')).filter((n) => n !== '2026-08-15.md');
    assert.deepEqual(leftover, [], 'no lock or temp entry survives a completed write');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('writeNoteAtomic replaces content without leaving a temp file', () => {
  const vault = newVault();
  try {
    const abs = join(vault, 'notes', 'a.md');
    writeNoteAtomic(abs, 'first');
    writeNoteAtomic(abs, 'second');
    assert.equal(readFileSync(abs, 'utf8'), 'second');
    assert.deepEqual(readdirSync(join(vault, 'notes')), ['a.md']);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('withNoteWrite skips the write when the callback returns no content', () => {
  const vault = newVault();
  try {
    const abs = join(vault, 'notes', 'b.md');
    const value = withNoteWrite(abs, (existing) => {
      assert.equal(existing, null, 'a missing note reads as null, not an empty string');
      return { content: null, value: 'decided-not-to-write' };
    });
    assert.equal(value, 'decided-not-to-write');
    assert.equal(existsSync(abs), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
