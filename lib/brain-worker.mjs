// brain-worker — the heavy, synchronous brain reads behind Seen Command's Brain area, run OFF the
// server's event loop. Building the unified graph walks and parses every vault note (~150–250 ms on a
// 250-note vault, plus ~25 ms to serialize and ~60 ms to gzip 4 MB); the Keeper audit and the activity
// feed each re-read the whole vault too. Done inline, every one of those would stall the Board Room
// stream and every other API call for that long — the "frozen window" the owner complained about.
//
// lib/brain-routes.mjs runs these tasks in a worker thread when it can, and calls `runTask` directly
// (same code, same results) when a worker cannot start. Each task returns plain data; nothing here
// writes to the vault.
import { parentPort } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

let U = null, A = null, V = null, K = null;

// Turn a vault read failure into something the owner can ACT on. The case that actually happened (in
// Chronos): macOS asks once for access to Desktop/Documents/Downloads, the prompt was denied, and the
// denial is remembered — so every vault read fails with `EPERM … scandir`. Nothing is broken and no
// memory is lost, but the raw errno says none of that.
export function explainBrainError(e, vaultPath) {
  const msg = String((e && e.message) || e || '');
  const isPerm = /EPERM|EACCES|operation not permitted/i.test(msg);
  const p = String(vaultPath || '');
  const protectedDir = ['Downloads', 'Documents', 'Desktop'].find((d) => p.includes(`/${d}/`));
  if (isPerm && protectedDir) {
    return `macOS is blocking access to your ${protectedDir} folder, so the vault at ${p} cannot be read. `
      + 'Nothing is broken and no memory is lost — the permission was denied (or reset by a rebuild). '
      + `Fix: System Settings → Privacy & Security → Files and Folders → Seen Command → enable "${protectedDir} Folder", `
      + `then Brain → Refresh. Full Disk Access also works. (Original error: ${msg})`;
  }
  if (isPerm) {
    return `Permission denied reading the vault at ${p}. Grant Seen Command access in System Settings → `
      + `Privacy & Security → Files and Folders, then Brain → Refresh. (Original error: ${msg})`;
  }
  return msg;
}

// The graph payload when the build itself failed — the same shape a good build has, so the page renders
// the error as text instead of breaking on a missing field.
export function emptyGraph({ today, statePath, vaultPath, error }) {
  return {
    nodes: [], links: [], dateRange: { from: today, to: today }, generated: today,
    vaultFound: false, stateFound: false, error,
    counts: { command: { nodes: 0, facts: 0, threads: 0 }, chronos: { notes: 0, facts: 0, links: 0 }, bridges: 0, total: { nodes: 0, links: 0 } },
    sources: { statePath: statePath || null, vaultPath: vaultPath || null },
  };
}

export async function runTask(kind, args = {}) {
  if (kind === 'graph') {
    if (!U) U = await import('../brain/lib/unify.mjs');
    let g;
    try { g = U.buildUnifiedGraph({ statePath: args.statePath, vaultPath: args.vaultPath, today: args.today, live: args.live || null }); }
    catch (e) { g = emptyGraph({ ...args, error: explainBrainError(e, args.vaultPath) }); }
    const json = JSON.stringify(g);
    // Both encodings are made here and handed over as transferable bytes, so the server thread never
    // copies or re-encodes the 4 MB string.
    const raw = Buffer.from(json, 'utf8');
    const body = new Uint8Array(raw.byteLength); body.set(raw);
    const z = gzipSync(raw, { level: 6 });
    // A private copy: a small Buffer can be a slice of Node's shared pool, and transferring the pool's
    // ArrayBuffer to the parent would detach every other Buffer cut from it.
    const gz = new Uint8Array(z.byteLength); gz.set(z);
    return {
      body, gz, hash: createHash('sha1').update(raw).digest('hex').slice(0, 20),
      summary: { nodes: g.nodes.length, links: g.links.length, error: g.error || null, vaultFound: !!g.vaultFound, stateFound: !!g.stateFound },
    };
  }
  if (kind === 'activity') {
    if (!A) A = await import('../brain/lib/activity.mjs');
    if (!V) V = await import('../brain/lib/vault.mjs');
    const facts = V.readIndex(args.vaultPath).facts || [];
    return { ...A.buildActivity({ facts, vaultPath: args.vaultPath }), vaultPath: args.vaultPath };
  }
  if (kind === 'health') {
    // review() resolves the vault itself (CHRONOS_VAULT first), so pin it to the vault this view shows.
    if (args.vaultPath) process.env.CHRONOS_VAULT = args.vaultPath;
    if (!K) K = await import('../brain/lib/keeper.mjs');
    return K.review();
  }
  throw new Error(`unknown brain task: ${kind}`);
}

if (parentPort) {
  parentPort.on('message', async ({ id, kind, args }) => {
    try {
      const result = await runTask(kind, args);
      const transfer = result && result.gz ? [result.gz.buffer, result.body.buffer] : [];
      parentPort.postMessage({ id, ok: true, result }, transfer);
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: explainBrainError(e, args && args.vaultPath) });
    }
  });
}
