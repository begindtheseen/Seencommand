import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  credentialDeliveryResult, installClientCredential, issueClient, listClients, registryPath,
  renewClient, revokeClient, rotateClient, verifyClient,
} from './access-control.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'chronos-access-'));
test('issued secret is shown once; registry stores only a salted verifier with mode 0600', () => {
  const v = scratch(); try {
    const issued = issueClient(v, { name: 'Codex Desktop', scopes: ['read', 'write'] });
    assert.match(issued.secret, /^chr_/); assert.equal(issued.client.name, 'codex-desktop');
    assert.equal('lookup' in issued.client, false, 'lookup never crosses the privileged boundary');
    const disk = readFileSync(registryPath(v), 'utf8'); assert.ok(!disk.includes(issued.secret));
    assert.match(JSON.parse(disk).clients[0].lookup, /^[0-9a-f]{64}$/);
    assert.equal(statSync(registryPath(v)).mode & 0o777, 0o600);
  } finally { rmSync(v, { recursive: true, force: true }); }
});
test('credential, not a claim, resolves the one authoritative identity and scopes', () => {
  const v = scratch(); try {
    const { secret, client } = issueClient(v, { name: 'codex', scopes: ['read'] });
    assert.equal(verifyClient(v, secret, { scope: 'read' }).identity.id, client.id);
    assert.equal(verifyClient(v, secret, { scope: 'write' }).ok, false);
    assert.equal(verifyClient(v, 'chr_wrong', { scope: 'read' }).ok, false);
    assert.throws(() => issueClient(v, { name: 'codex' }), /already exists/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});
test('revocation and rotation immediately kill old credentials', () => {
  const v = scratch(); try {
    const first = issueClient(v, { name: 'role-client', scopes: ['read', 'write'] });
    const next = rotateClient(v, first.client.id);
    assert.equal(verifyClient(v, first.secret).ok, false); assert.equal(verifyClient(v, next.secret).ok, true);
    assert.deepEqual(listClients(v).map((c) => c.id), [next.client.id], 'rotation replaces the old placement');
    revokeClient(v, next.client.id); assert.equal(verifyClient(v, next.secret).ok, false);
    const visible = listClients(v);
    assert.equal(visible.length, 1, 'explicitly revoked current credential remains visible');
    assert.equal(visible[0].revokedAt != null, true);
    assert.equal(visible.some((c) => 'verifier' in c || 'salt' in c || 'lookup' in c), false);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('legacy Claude provider/session labels can never become authenticated principals', () => {
  const v = scratch(); try {
    for (const name of ['claude', 'claude-session', 'claude-session-abc', 'claude:cloud-session-abc']) {
      assert.throws(() => issueClient(v, { name, scopes: ['read'] }), /role-qualified source required/);
    }
    const issued = issueClient(v, { name: 'claude-brain', scopes: ['read'] });
    const registry = JSON.parse(readFileSync(registryPath(v), 'utf8'));
    registry.clients[0].name = 'claude-session-stale-import';
    writeFileSync(registryPath(v), JSON.stringify(registry), { mode: 0o600 });
    assert.deepEqual(verifyClient(v, issued.secret), { ok: false, error: 'legacy Claude session identity forbidden' });
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('rotation can replace an inherited admin credential with least privilege and a bounded expiry', () => {
  const v = scratch(); try {
    const first = issueClient(v, { name: 'codex', scopes: ['read', 'write', 'admin'] });
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    const next = rotateClient(v, first.client.id, { scopes: ['read', 'write'], expiresAt });
    const verified = verifyClient(v, next.secret, { scope: 'write' });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.identity.scopes, ['read', 'write']);
    assert.equal(verified.identity.expiresAt, expiresAt);
    assert.deepEqual(listClients(v).map((c) => c.id), [next.client.id]);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('renewal revives an expired credential in place: same id, same secret, same scopes', () => {
  const v = scratch(); try {
    const issued = issueClient(v, { name: 'claude-brain', scopes: ['read', 'write'], expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const registry = JSON.parse(readFileSync(registryPath(v), 'utf8'));
    registry.clients[0].expiresAt = new Date(Date.now() - 5 * 24 * 3600000).toISOString();
    writeFileSync(registryPath(v), JSON.stringify(registry), { mode: 0o600 });
    assert.deepEqual(verifyClient(v, issued.secret), { ok: false, error: 'credential expired' });
    assert.throws(() => rotateClient(v, issued.client.id), /credential expired: renew it/, 'an expired expiry can never seed a rotation');

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600000).toISOString();
    const renewed = renewClient(v, issued.client.id, { expiresAt });
    assert.equal(renewed.client.id, issued.client.id);
    assert.equal('secret' in renewed, false, 'renewal never mints or returns a secret');
    assert.equal(['verifier', 'salt', 'lookup'].some((k) => k in renewed.client), false);
    const verified = verifyClient(v, issued.secret, { scope: 'write' });
    assert.equal(verified.ok, true, 'the credential already held by running sessions works again');
    assert.equal(verified.identity.expiresAt, expiresAt);
    assert.deepEqual(verified.identity.scopes, ['read', 'write']);
    assert.deepEqual(listClients(v).map((c) => c.id), [issued.client.id], 'no new record, nothing retired');
    assert.equal(statSync(registryPath(v)).mode & 0o777, 0o600);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('renewal cannot resurrect a revoked credential or accept an unbounded expiry', () => {
  const v = scratch(); try {
    const issued = issueClient(v, { name: 'codex', scopes: ['read'] });
    const soon = new Date(Date.now() + 3600000).toISOString();
    assert.throws(() => renewClient(v, issued.client.id, { expiresAt: new Date(Date.now() - 1000).toISOString() }), /expiry must be in the future/);
    assert.throws(() => renewClient(v, issued.client.id, { expiresAt: new Date(Date.now() + 400 * 24 * 3600000).toISOString() }), /no more than 366 days/);
    assert.throws(() => renewClient(v, 'client_missing', { expiresAt: soon }), /active client not found/);
    revokeClient(v, issued.client.id);
    assert.throws(() => renewClient(v, issued.client.id, { expiresAt: soon }), /active client not found/);
    assert.equal(verifyClient(v, issued.secret).ok, false);
    const rotatedAway = issueClient(v, { name: 'role-client', scopes: ['read'] });
    rotateClient(v, rotatedAway.client.id);
    assert.throws(() => renewClient(v, rotatedAway.client.id, { expiresAt: soon }), /active client not found/, 'a rotated-out secret stays dead');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a legacy record learns its indexed lookup after one successful verification', () => {
  const v = scratch(); try {
    const issued = issueClient(v, { name: 'legacy', scopes: ['read'] });
    const registry = JSON.parse(readFileSync(registryPath(v), 'utf8'));
    delete registry.clients[0].lookup;
    writeFileSync(registryPath(v), JSON.stringify(registry), { mode: 0o600 });
    assert.equal(verifyClient(v, issued.secret).ok, true);
    assert.match(JSON.parse(readFileSync(registryPath(v), 'utf8')).clients[0].lookup, /^[0-9a-f]{64}$/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});
test('local installation writes only the credential file with owner-only permissions', () => {
  const v = scratch(); try {
    const issued = issueClient(v, { name: 'codex', scopes: ['read'] });
    const p = installClientCredential({ name: issued.client.name, secret: issued.secret, dir: join(v, 'credentials') });
    assert.equal(readFileSync(p, 'utf8').trim(), issued.secret);
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(statSync(join(v, 'credentials')).mode & 0o777, 0o700);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('installed credentials never cross into the renderer result while manual export remains one-time', () => {
  const issued = { client: { id: 'client_1', name: 'codex' }, secret: `chr_${'a'.repeat(43)}` };
  const installed = credentialDeliveryResult(issued, { credentialFile: '/protected/codex.token' });
  assert.equal('secret' in installed, false);
  assert.equal(installed.secretInstalled, true);
  assert.equal(installed.credentialFile, '/protected/codex.token');
  assert.equal(credentialDeliveryResult(issued).secret, issued.secret, 'manual export preserves the explicit one-time secret');
});

test('a concurrent verification cannot overwrite and resurrect a revocation', async () => {
  const v = scratch(); try {
    const issued = issueClient(v, { name: 'race-client', scopes: ['read'] });
    const modulePath = new URL('./access-control.mjs', import.meta.url).pathname;
    const children = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const code = `import { verifyClient } from ${JSON.stringify(modulePath)}; verifyClient(process.env.TEST_VAULT, process.env.TEST_SECRET, { scope: 'read' });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TEST_VAULT: v, TEST_SECRET: issued.secret }, stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`verification child exited ${status}`)));
    }));
    await new Promise((resolve) => setTimeout(resolve, 35));
    revokeClient(v, issued.client.id);
    await Promise.all(children);
    const current = listClients(v).find((client) => client.id === issued.client.id);
    assert.ok(current.revokedAt, 'the protected revoked state survives stale in-flight verifications');
    assert.equal(verifyClient(v, issued.secret).ok, false);
  } finally { rmSync(v, { recursive: true, force: true }); }
});
