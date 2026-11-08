// Chronos client credential authority. A claimed name is NEVER trusted: a random credential resolves
// to exactly one registry record, and that record supplies the audited identity + scopes.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { withSyncDirectoryLock } from './file-lock.mjs';

export const registryPath = (vault) => join(String(vault || ''), '.access', 'clients.json');
const registryLockPath = (vault) => join(String(vault || ''), '.access', 'clients.lock');
const now = () => new Date().toISOString();
const safeName = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const allowedScopes = new Set(['read', 'write', 'artifact:read', 'artifact:write', 'github:write', 'admin']);
const hash = (secret, salt) => scryptSync(secret, salt, 32).toString('hex');
const lookup = (secret) => createHash('sha256').update(secret).digest('hex');
const validScopes = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => allowedScopes.has(x)))];

// Provider-level/session-generated Claude labels are historical attribution, never security
// principals. Keeping this at the credential authority prevents an operator, stale import, or future
// UI regression from minting a credential that would make forbidden traffic look authenticated.
export function isForbiddenLegacySource(name) {
  const n = safeName(name);
  return n === 'claude' || n.startsWith('claude-session') || n.startsWith('claude:');
}

export function readRegistry(vault) {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(vault), 'utf8'));
    return { version: 1, clients: Array.isArray(parsed.clients) ? parsed.clients : [] };
  } catch { return { version: 1, clients: [] }; }
}

function saveRegistry(vault, registry) {
  const p = registryPath(vault); mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

export function listClients(vault) {
  return readRegistry(vault).clients
    // Rotation replaces the current placement in Access. The retired row stays in the registry for
    // audit/history, but only an explicit revoke belongs in the separate revoked list in the UI.
    .filter((client) => !client.rotatedAt)
    .map(({ verifier, salt, lookup: _lookup, ...safe }) => ({
    ...safe, installedOnThisMac: existsSync(credentialPath(safe.name)),
    }));
}

// Internal sync shape for Chronos → cloud. Salted verifiers are not credentials and cannot be used
// to authenticate, but they are intentionally never exposed to the renderer or audit logs.
export function getClientRecord(vault, id) {
  const row = readRegistry(vault).clients.find((c) => c.id === id);
  return row ? { ...row } : null;
}

export const credentialPath = (name, dir = join(homedir(), '.chronos', 'credentials')) => join(dir, `${safeName(name)}.token`);

export function installClientCredential({ name, secret, dir } = {}) {
  if (!safeName(name) || !/^chr_[A-Za-z0-9_-]{40,}$/.test(String(secret || ''))) throw new Error('valid client name and credential required');
  const p = credentialPath(name, dir); mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(p), 0o700); } catch { /* best effort */ }
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${secret}\n`, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
  return p;
}

// Shape the one-time issuance result for the renderer. When main has already installed the
// credential, the renderer needs only confirmation and the path — never the plaintext secret.
// Manual, non-installed export intentionally retains the one-time secret.
export function credentialDeliveryResult(issued, { credentialFile = null } = {}) {
  if (!credentialFile) return issued;
  const { secret: _secret, ...safe } = issued || {};
  return { ...safe, credentialFile, secretInstalled: true };
}

export function removeInstalledCredential(name, dir) {
  const p = credentialPath(name, dir);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* revocation still wins in registry */ }
  return p;
}

function normalizeIssue({ name, scopes = ['read'], expiresAt = null } = {}) {
  const clientName = safeName(name);
  if (!clientName) throw new Error('client name required');
  if (isForbiddenLegacySource(clientName)) throw new Error('role-qualified source required; legacy Claude session identities are forbidden');
  let expiry = null;
  if (expiresAt) {
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + 366 * 24 * 3600000) throw new Error('expiry must be in the future and no more than 366 days away');
    expiry = new Date(ms).toISOString();
  }
  const normalizedScopes = validScopes(scopes);
  if (!normalizedScopes.length) throw new Error('at least one valid scope required');
  return { clientName, scopes: normalizedScopes, expiry };
}

function issueInto(registry, { clientName, scopes, expiry }) {
  if (registry.clients.some((c) => c.name === clientName && !c.revokedAt)) throw new Error(`active client name already exists: ${clientName}`);
  const secret = `chr_${randomBytes(32).toString('base64url')}`;
  const salt = randomBytes(16).toString('hex');
  const client = {
    id: `client_${randomBytes(12).toString('hex')}`, name: clientName, scopes,
    salt, verifier: hash(secret, salt), lookup: lookup(secret), createdAt: now(), expiresAt: expiry,
    revokedAt: null, rotatedAt: null, lastUsedAt: null,
  };
  registry.clients.push(client);
  return { client: (({ verifier, salt: _salt, lookup: _lookup, ...safe }) => safe)(client), secret };
}

export function issueClient(vault, input = {}) {
  const policy = normalizeIssue(input);
  return withSyncDirectoryLock(registryLockPath(vault), () => {
    const registry = readRegistry(vault);
    const issued = issueInto(registry, policy);
    saveRegistry(vault, registry);
    return issued;
  });
}

export function verifyClient(vault, secret, { scope = 'read', at = now() } = {}) {
  if (typeof secret !== 'string' || !secret.startsWith('chr_')) return { ok: false, error: 'invalid credential' };
  return withSyncDirectoryLock(registryLockPath(vault), () => {
    const registry = readRegistry(vault);
    const secretLookup = lookup(secret);
    for (const client of registry.clients) {
      if (client.lookup && client.lookup !== secretLookup) continue;
      let match = false;
      try { match = timingSafeEqual(Buffer.from(hash(secret, client.salt), 'hex'), Buffer.from(client.verifier, 'hex')); } catch { /* malformed row */ }
      if (!match) continue;
      // Transparently upgrade credentials issued before the indexed lookup field existed. This keeps
      // the active secret stable while ensuring future checks avoid a registry-wide scrypt scan.
      if (!client.lookup) client.lookup = secretLookup;
      if (isForbiddenLegacySource(client.name)) return { ok: false, error: 'legacy Claude session identity forbidden' };
      if (client.revokedAt) return { ok: false, error: 'credential revoked' };
      if (client.expiresAt && Date.parse(client.expiresAt) <= Date.parse(at)) return { ok: false, error: 'credential expired' };
      if (scope && !client.scopes.includes(scope) && !client.scopes.includes('admin')) return { ok: false, error: 'scope denied' };
      client.lastUsedAt = at; saveRegistry(vault, registry);
      const { verifier, salt, lookup: _lookup, ...identity } = client;
      return { ok: true, identity };
    }
    return { ok: false, error: 'invalid credential' };
  });
}

export function revokeClient(vault, id) {
  return withSyncDirectoryLock(registryLockPath(vault), () => {
    const registry = readRegistry(vault); const client = registry.clients.find((c) => c.id === id);
    if (!client) throw new Error('client not found');
    client.revokedAt = now(); saveRegistry(vault, registry); return true;
  });
}

// Renewal moves ONLY the expiry of the same record: same id, same secret, same scopes. Every holder
// of the credential — a long-lived local MCP subprocess, a cloud environment secret — recovers on its
// next request with no re-provisioning, which rotation (a new secret) can never offer. It is the one
// way out of an expired credential; a revoked one stays dead, and scopes cannot change here.
export function renewClient(vault, id, { expiresAt = null } = {}) {
  return withSyncDirectoryLock(registryLockPath(vault), () => {
    const registry = readRegistry(vault); const client = registry.clients.find((c) => c.id === id);
    if (!client || client.revokedAt) throw new Error('active client not found');
    const { expiry } = normalizeIssue({ name: client.name, scopes: client.scopes, expiresAt });
    client.expiresAt = expiry; client.renewedAt = now();
    saveRegistry(vault, registry);
    const { verifier, salt, lookup: _lookup, ...safe } = client;
    return { client: safe };
  });
}

export function rotateClient(vault, id, policy = {}) {
  return withSyncDirectoryLock(registryLockPath(vault), () => {
    const registry = readRegistry(vault); const old = registry.clients.find((c) => c.id === id);
    if (!old || old.revokedAt) throw new Error('active client not found');
    // An expired credential's inherited expiry is in the past, so it can never seed the replacement.
    if (policy.expiresAt === undefined && old.expiresAt && Date.parse(old.expiresAt) <= Date.now()) {
      throw new Error('credential expired: renew it, or rotate with a new expiry');
    }
    const nextPolicy = normalizeIssue({
      name: old.name,
      scopes: policy.scopes === undefined ? old.scopes : policy.scopes,
      expiresAt: policy.expiresAt === undefined ? old.expiresAt : policy.expiresAt,
    });
    old.revokedAt = now(); old.rotatedAt = old.revokedAt;
    const issued = issueInto(registry, nextPolicy);
    saveRegistry(vault, registry);
    return issued;
  });
}
