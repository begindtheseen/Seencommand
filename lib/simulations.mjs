// The simulation queue: one deep simulation at a time (they take minutes and use the strongest lane), each
// kept as data/simulations/<id>.json, its brief posted into the Board Room and attached to its approval.
// After every board meeting the major pending approvals that have no simulation yet are queued.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from './paths.mjs';
import { simulateDecision, simulationBrief, isMajor } from './simulate.mjs';

const dir = () => join(dataDir(), 'simulations');
const safe = (id) => String(id).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
export const simIdFor = ({ approvalId = null, question = '' }) => (approvalId ? `appr-${safe(approvalId)}` : `q-${createHash('sha256').update(String(question)).digest('hex').slice(0, 12)}`);

// numbersFor(job) (optional): live numbers for a decision that brought none (lib/money/live.mjs numbersFor —
// a money decision gets real users, growth, paid share, price and costs; anything else gets null).
export function createSimulations({ reasonFn, loadState, post = async () => {}, contextFor = async () => '', simulate = simulateDecision, numbersFor = null } = {}) {
  const queue = []; let running = null;
  const path = (id) => join(dir(), `${safe(id)}.json`);
  const read = (id) => { try { return JSON.parse(readFileSync(path(id), 'utf8')); } catch { return null; } };
  const write = (rec) => { mkdirSync(dir(), { recursive: true }); const t = `${path(rec.id)}.tmp`; writeFileSync(t, JSON.stringify(rec, null, 2)); renameSync(t, path(rec.id)); return rec; };

  async function pump() {
    if (running || !queue.length) return;
    const job = queue.shift(); running = job.id;
    write({ ...read(job.id), id: job.id, status: 'running', startedAt: new Date().toISOString() });
    try {
      const context = await contextFor(job).catch(() => '');
      const numbers = job.numbers || (numbersFor ? await Promise.resolve().then(() => numbersFor(job)).catch(() => null) : null);
      const result = await simulate({ question: job.question, context, numbers: numbers || null, reasonFn });
      const rec = write({ id: job.id, approvalId: job.approvalId || null, question: job.question, status: result.ok ? 'done' : 'failed', result, brief: simulationBrief(result), endedAt: new Date().toISOString() });
      await post(rec).catch(() => {});
    } catch (e) { write({ id: job.id, approvalId: job.approvalId || null, question: job.question, status: 'failed', error: String(e.message || e).slice(0, 300), endedAt: new Date().toISOString() }); }
    finally { running = null; setTimeout(pump, 0); }
  }

  function enqueue({ approvalId = null, question = '', numbers = null, force = false } = {}) {
    let q = String(question || '').trim();
    if (approvalId && !q) {
      const a = ((loadState() || {}).approvals || []).find((x) => x.id === approvalId || x.key === approvalId);
      if (!a) return { ok: false, error: 'no such approval' };
      q = `${a.title}. ${a.summary || ''} (proposed by ${a.agent || a.dept}; on approve it ${a.onApprove || 'is executed'})`;
      approvalId = a.id;
    }
    if (!q) return { ok: false, error: 'say what to simulate — an approval id or a decision in words' };
    const id = simIdFor({ approvalId, question: q });
    const prev = read(id);
    if (!force && prev && (prev.status === 'done' || prev.status === 'running' || prev.status === 'queued')) return { ok: true, id, status: prev.status, existing: true };
    if (!queue.some((j) => j.id === id) && running !== id) { queue.push({ id, approvalId, question: q, numbers }); write({ id, approvalId, question: q, status: 'queued', queuedAt: new Date().toISOString() }); }
    setTimeout(pump, 0);
    return { ok: true, id, status: 'queued', position: queue.findIndex((j) => j.id === id) + 1 };
  }

  // After a meeting: queue every MAJOR pending approval that has no simulation.
  function afterMeeting() {
    const pending = ((loadState() || {}).approvals || []).filter((a) => a.status === 'pending' && isMajor(a));
    return pending.map((a) => enqueue({ approvalId: a.id })).filter((r) => r.ok && !r.existing).length;
  }

  function list() {
    if (!existsSync(dir())) return [];
    return readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(dir(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => String(b.endedAt || b.startedAt || b.queuedAt || '').localeCompare(String(a.endedAt || a.startedAt || a.queuedAt || '')));
  }
  return { enqueue, afterMeeting, get: read, list, forApproval: (id) => read(simIdFor({ approvalId: id })), running: () => running, queued: () => queue.length };
}
