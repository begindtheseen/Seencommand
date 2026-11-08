// Scoped large-file exchange for AI clients. Files never enter Brain notes or tool logs: callers
// transfer bounded base64 chunks into a content-addressed store and receive an opaque SHA-256 handle.
// Integrity, expiry, per-file limits, and a total quota are enforced at the Chronos boundary.
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withSyncDirectoryLock } from './file-lock.mjs';

export const MAX_ARTIFACT_BYTES = Number(process.env.CHRONOS_ARTIFACT_MAX_BYTES || 512 * 1024 * 1024);
export const MAX_CHUNK_BYTES = Number(process.env.CHRONOS_ARTIFACT_CHUNK_BYTES || 768 * 1024);
export const MAX_TOTAL_BYTES = Number(process.env.CHRONOS_ARTIFACT_QUOTA_BYTES || 2 * 1024 * 1024 * 1024);
export const MAX_ENCODED_CHUNK_CHARS = 4 * Math.ceil(MAX_CHUNK_BYTES / 3);
const MAX_TTL_HOURS = 24 * 7;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const now = () => new Date().toISOString();
const root = (vault) => join(String(vault || ''), '.access', 'artifacts');
const manifestPath = (vault) => join(root(vault), 'manifest.json');
const manifestLockPath = (vault) => join(root(vault), 'manifest.lock');
const uploadPath = (vault, id) => join(root(vault), 'uploads', `${id}.part`);
const objectPath = (vault, hash) => join(root(vault), 'objects', hash.slice(0, 2), hash);
const cleanName = (v) => String(v || 'artifact.bin').replace(/[\u0000-\u001f/\\]/g, '-').slice(0, 180) || 'artifact.bin';
const validHash = (v) => /^[0-9a-f]{64}$/.test(String(v || '').toLowerCase());

function readManifest(vault) {
  try {
    const m = JSON.parse(readFileSync(manifestPath(vault), 'utf8'));
    return { version: 1, uploads: Array.isArray(m.uploads) ? m.uploads : [], artifacts: Array.isArray(m.artifacts) ? m.artifacts : [] };
  } catch { return { version: 1, uploads: [], artifacts: [] }; }
}

function saveManifest(vault, m) {
  const p = manifestPath(vault); mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, p);
}

function cleanup(vault, m, at = Date.now()) {
  const liveArtifacts = [];
  for (const a of m.artifacts) {
    if (a.expiresAt && Date.parse(a.expiresAt) <= at) continue;
    liveArtifacts.push(a);
  }
  const liveHashes = new Set(liveArtifacts.map((a) => a.sha256));
  for (const a of m.artifacts) {
    if (!liveHashes.has(a.sha256)) { try { unlinkSync(objectPath(vault, a.sha256)); } catch { /* absent is clean */ } }
  }
  const uploads = [];
  for (const u of m.uploads) {
    if (Date.parse(u.createdAt) + UPLOAD_TTL_MS <= at) { try { unlinkSync(uploadPath(vault, u.id)); } catch { /* absent */ } }
    else uploads.push(u);
  }
  m.artifacts = liveArtifacts; m.uploads = uploads;
}

function usedBytes(m) {
  const hashes = new Set(); let total = 0;
  for (const a of m.artifacts) { if (!hashes.has(a.sha256)) { hashes.add(a.sha256); total += Number(a.size || 0); } }
  for (const u of m.uploads) total += Number(u.size || 0);
  return total;
}

export function beginArtifactUpload(vault, { name, mime = 'application/octet-stream', size, sha256, ttlHours = 24, by } = {}) {
  const bytes = Number(size); const expected = String(sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARTIFACT_BYTES) throw new Error(`artifact size must be 0-${MAX_ARTIFACT_BYTES} bytes`);
  if (!validHash(expected)) throw new Error('expected sha256 is required');
  const ttl = Number(ttlHours);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_HOURS) throw new Error(`ttlHours must be 0-${MAX_TTL_HOURS}`);
  return withSyncDirectoryLock(manifestLockPath(vault), () => {
    const m = readManifest(vault); cleanup(vault, m);
    if (usedBytes(m) + bytes > MAX_TOTAL_BYTES) throw new Error('artifact quota exceeded');
    const existing = m.artifacts.find((a) => a.sha256 === expected && Number(a.size) === bytes);
    if (existing && existsSync(objectPath(vault, expected))) {
      const alias = { ...existing, id: `artifact_${randomBytes(10).toString('hex')}`, name: cleanName(name), mime: String(mime).slice(0, 120), by: String(by || 'unknown').slice(0, 80), createdAt: now(), expiresAt: new Date(Date.now() + ttl * 3600000).toISOString() };
      m.artifacts.push(alias); saveManifest(vault, m);
      return { deduplicated: true, artifact: alias };
    }
    const id = `upload_${randomBytes(12).toString('hex')}`;
    const u = { id, name: cleanName(name), mime: String(mime).slice(0, 120), size: bytes, expectedSha256: expected, received: 0, nextIndex: 0, by: String(by || 'unknown').slice(0, 80), createdAt: now(), ttlHours: ttl };
    mkdirSync(dirname(uploadPath(vault, id)), { recursive: true, mode: 0o700 });
    writeFileSync(uploadPath(vault, id), '', { mode: 0o600 });
    m.uploads.push(u); saveManifest(vault, m);
    return { uploadId: id, chunkBytes: MAX_CHUNK_BYTES, expectedSize: bytes, expectedSha256: expected };
  });
}

export function writeArtifactChunk(vault, { uploadId, index, data } = {}) {
  const encoded = String(data || '');
  if (encoded.length > MAX_ENCODED_CHUNK_CHARS) throw new Error(`encoded chunk exceeds ${MAX_ENCODED_CHUNK_CHARS} characters`);
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('chunk data must be base64');
  const buf = Buffer.from(encoded, 'base64');
  if (!buf.length || buf.length > MAX_CHUNK_BYTES) throw new Error(`chunk must be 1-${MAX_CHUNK_BYTES} bytes`);
  return withSyncDirectoryLock(manifestLockPath(vault), () => {
    const m = readManifest(vault); cleanup(vault, m);
    const u = m.uploads.find((x) => x.id === String(uploadId || ''));
    if (!u) throw new Error('upload not found or expired');
    if (Number(index) !== u.nextIndex) throw new Error(`chunk out of order: expected index ${u.nextIndex}`);
    if (u.received + buf.length > u.size) throw new Error('chunk exceeds declared artifact size');
    appendFileSync(uploadPath(vault, u.id), buf, { mode: 0o600 });
    u.received += buf.length; u.nextIndex += 1; saveManifest(vault, m);
    return { uploadId: u.id, received: u.received, expectedSize: u.size, nextIndex: u.nextIndex };
  });
}

function hashFile(p) {
  const h = createHash('sha256'); const fd = openSync(p, 'r'); const buf = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { closeSync(fd); }
  return h.digest('hex');
}

export function finishArtifactUpload(vault, { uploadId } = {}) {
  return withSyncDirectoryLock(manifestLockPath(vault), () => {
    const m = readManifest(vault); cleanup(vault, m);
    const i = m.uploads.findIndex((x) => x.id === String(uploadId || ''));
    if (i < 0) throw new Error('upload not found or expired');
    const u = m.uploads[i]; const src = uploadPath(vault, u.id);
    if (u.received !== u.size || statSync(src).size !== u.size) throw new Error(`incomplete upload: ${u.received}/${u.size} bytes`);
    const actual = hashFile(src);
    if (actual !== u.expectedSha256) {
      try { unlinkSync(src); } catch { /* temporary upload only */ }
      m.uploads.splice(i, 1); saveManifest(vault, m);
      throw new Error(`sha256 mismatch: expected ${u.expectedSha256}, received ${actual}`);
    }
    const dst = objectPath(vault, actual); mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    if (existsSync(dst)) unlinkSync(src); else { renameSync(src, dst); chmodSync(dst, 0o600); }
    const artifact = { id: `artifact_${randomBytes(10).toString('hex')}`, sha256: actual, name: u.name, mime: u.mime, size: u.size, by: u.by, createdAt: now(), expiresAt: new Date(Date.now() + u.ttlHours * 3600000).toISOString() };
    m.uploads.splice(i, 1); m.artifacts.push(artifact); saveManifest(vault, m);
    return artifact;
  });
}

export function readArtifactChunk(vault, { sha256, offset = 0, length = MAX_CHUNK_BYTES } = {}) {
  const hash = String(sha256 || '').toLowerCase(); const start = Number(offset); const wanted = Number(length);
  if (!validHash(hash)) throw new Error('valid sha256 required');
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > MAX_CHUNK_BYTES) throw new Error(`length must be 1-${MAX_CHUNK_BYTES}`);
  return withSyncDirectoryLock(manifestLockPath(vault), () => {
    const m = readManifest(vault); cleanup(vault, m); saveManifest(vault, m);
    const meta = m.artifacts.find((a) => a.sha256 === hash);
    if (!meta) throw new Error('artifact not found or expired');
    const p = objectPath(vault, hash); const size = statSync(p).size;
    if (start > size) throw new Error('offset exceeds artifact size');
    const n = Math.min(wanted, size - start); const buf = Buffer.allocUnsafe(n); const fd = openSync(p, 'r');
    try { if (n) readSync(fd, buf, 0, n, start); } finally { closeSync(fd); }
    return { sha256: hash, offset: start, length: n, size, data: buf.toString('base64'), nextOffset: start + n, eof: start + n >= size, name: meta.name, mime: meta.mime };
  });
}

export function listArtifacts(vault) {
  return withSyncDirectoryLock(manifestLockPath(vault), () => {
    const m = readManifest(vault); cleanup(vault, m); saveManifest(vault, m);
    return m.artifacts.map(({ id, sha256, name, mime, size, by, createdAt, expiresAt }) => ({ id, sha256, name, mime, size, by, createdAt, expiresAt }));
  });
}
