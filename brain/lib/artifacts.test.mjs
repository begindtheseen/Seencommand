import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  beginArtifactUpload, finishArtifactUpload, listArtifacts, MAX_CHUNK_BYTES,
  MAX_ENCODED_CHUNK_CHARS, readArtifactChunk, writeArtifactChunk,
} from './artifacts.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'chronos-artifacts-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('large-file exchange is chunked, content-addressed, integrity-checked, and readable by range', () => {
  const v = scratch(); try {
    const body = Buffer.from('Chronos artifact payload '.repeat(100000));
    const start = beginArtifactUpload(v, { name: '../safe.bin', size: body.length, sha256: sha(body), by: 'codex' });
    let index = 0;
    for (let off = 0; off < body.length; off += start.chunkBytes) {
      writeArtifactChunk(v, { uploadId: start.uploadId, index: index++, data: body.subarray(off, off + start.chunkBytes).toString('base64') });
    }
    const artifact = finishArtifactUpload(v, { uploadId: start.uploadId });
    assert.equal(artifact.sha256, sha(body)); assert.equal(artifact.name, '..-safe.bin');
    const first = readArtifactChunk(v, { sha256: artifact.sha256, offset: 0, length: 1000 });
    assert.deepEqual(Buffer.from(first.data, 'base64'), body.subarray(0, 1000)); assert.equal(first.eof, false);
    assert.equal(listArtifacts(v).length, 1);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('out-of-order chunks and a wrong digest are denied without publishing an artifact', () => {
  const v = scratch(); try {
    const body = Buffer.from('hello');
    const start = beginArtifactUpload(v, { name: 'x.txt', size: body.length, sha256: '0'.repeat(64) });
    assert.throws(() => writeArtifactChunk(v, { uploadId: start.uploadId, index: 1, data: body.toString('base64') }), /out of order/);
    writeArtifactChunk(v, { uploadId: start.uploadId, index: 0, data: body.toString('base64') });
    assert.throws(() => finishArtifactUpload(v, { uploadId: start.uploadId }), /sha256 mismatch/);
    assert.deepEqual(listArtifacts(v), []);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('oversized base64 is rejected before Buffer allocation while the maximum legal chunk works', () => {
  const v = scratch(); try {
    const expected = '0'.repeat(64);
    const start = beginArtifactUpload(v, { name: 'bounded.bin', size: MAX_CHUNK_BYTES, sha256: expected });
    const oversized = 'A'.repeat(MAX_ENCODED_CHUNK_CHARS + 4);
    const original = Buffer.from; let decodedOversized = false;
    Buffer.from = function(value, ...args) {
      if (value === oversized) decodedOversized = true;
      return original.call(Buffer, value, ...args);
    };
    try {
      assert.throws(() => writeArtifactChunk(v, { uploadId: start.uploadId, index: 0, data: oversized }), /encoded chunk exceeds/);
    } finally { Buffer.from = original; }
    assert.equal(decodedOversized, false, 'over-limit input must not reach Buffer.from');
    const legal = Buffer.alloc(MAX_CHUNK_BYTES).toString('base64');
    assert.equal(legal.length, MAX_ENCODED_CHUNK_CHARS);
    assert.equal(writeArtifactChunk(v, { uploadId: start.uploadId, index: 0, data: legal }).received, MAX_CHUNK_BYTES);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('concurrent upload begins retain every quota-accounted manifest record', async () => {
  const v = scratch(); try {
    const modulePath = new URL('./artifacts.mjs', import.meta.url).pathname;
    const count = 16;
    const children = Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
      const code = `import { beginArtifactUpload } from ${JSON.stringify(modulePath)}; beginArtifactUpload(process.env.TEST_VAULT, { name: 'x', size: 1, sha256: process.env.TEST_HASH, by: 'race-test' });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TEST_VAULT: v, TEST_HASH: index.toString(16).padStart(64, '0') },
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`upload child exited ${status}`)));
    }));
    await Promise.all(children);
    const store = join(v, '.access', 'artifacts');
    const manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8'));
    assert.equal(manifest.uploads.length, count);
    assert.equal(readdirSync(join(store, 'uploads')).length, count);
  } finally { rmSync(v, { recursive: true, force: true }); }
});
