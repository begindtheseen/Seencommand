// ONE ROOM (owner, 2026-10-21: "remember board room meetings agents share the same room as the chatbot.
// they all work together. this is important."). The Board Room conversation is the room:
//   • every finished board meeting posts its digest INTO the conversation (role 'board') — whatever
//     started it (chat, button, menu, schedule) — so the assistant and Brandon see the same results, and
//     the next chat turn's context carries them;
//   • a department speaks in the room when addressed ("@growth …", "growth, what do you think…", "ask
//     product: …"), and "ask the board …" gathers every department's view and the CEO lands it;
//   • the meeting reads the room back: recent conversation + Brandon's noted vision go into the meeting's
//     inputs (roomBrief), so departments plan against what he said in chat.
import { DEPARTMENTS } from '../org/org.mjs';

const NAMES = {
  growth: ['growth', 'cmo', 'marketing'], product: ['product', 'cto', 'engineering', 'eng'], reliability: ['reliability', 'sre', 'ops'],
  revenue: ['revenue', 'cro', 'sales', 'monetization'], data: ['data', 'cdo', 'intelligence'], strategy: ['strategy', 'cso', 'war room'], platform: ['platform', 'coo', 'self-improvement'],
};

// "@growth what…", "growth: …", "growth, what do you think", "ask product: …", "ask the board …" → { dept | board, question }.
export function parseRoomAddress(message) {
  const m = String(message || '').trim();
  const board = /^(?:ask|poll|get)\s+(?:the\s+)?(?:whole\s+)?(?:board|team|departments|everyone)\b[\s,:–-]*(.+)$/is.exec(m) || /^@(?:board|all|team)\b[\s,:–-]*(.+)$/is.exec(m);
  if (board && board[1].trim().length >= 3) return { board: true, question: board[1].trim() };
  for (const [id, words] of Object.entries(NAMES)) {
    const alt = words.map((w) => w.replace(/[-\s]/g, '[-\\s]?')).join('|');
    const re = new RegExp(`^(?:@(?:${alt})\\b|(?:ask\\s+(?:the\\s+)?(?:${alt})(?:\\s+(?:team|department|dept))?)\\b|(?:hey\\s+)?(?:${alt})(?:\\s+(?:team|department|dept))?\\s*[,:])[\\s,:–-]*(.+)$`, 'is');
    const hit = re.exec(m);
    if (hit && hit[1].trim().length >= 3) return { dept: id, question: hit[1].trim() };
  }
  return null;
}

// The digest a meeting posts into the room. Pure — unit tested.
export function meetingDigest(state) {
  if (!state?.runId) return null;
  const d = state.debrief || {};
  const lines = [`**Board meeting ${state.runId}** — focus: ${d.focus?.title || 'not set'}${state.reasonEngine ? ` · reasoned via ${state.reasonEngine}` : ''}`];
  if (d.headline) lines.push(d.headline);
  if (d.topConstraint) lines.push(`**Biggest constraint:** ${d.topConstraint}`);
  const byDept = new Map();
  for (const p of state.proposals || []) if (p.dept && !byDept.has(p.dept)) byDept.set(p.dept, p);
  if (byDept.size) {
    lines.push('', '**Each department’s top move:**');
    for (const dep of DEPARTMENTS) { const p = byDept.get(dep.id); if (p) lines.push(`- ${dep.title}: ${p.title}`); }
  }
  const pending = (state.approvals || []).filter((a) => a.status === 'pending');
  if (pending.length) {
    lines.push('', `**Waiting on you (${pending.length}):**`);
    for (const a of pending.slice(0, 8)) lines.push(`- ${a.title} — \`${a.id}\``);
    lines.push('', 'Say “approve …” or “deny …” here, or ask any department about its move (e.g. “@growth why this?”).');
  }
  return lines.join('\n');
}

// Watches for a NEW meeting (state.runId changes) and posts its digest once. `post(text)` writes the room.
export function createMeetingRelay({ loadState, post, seen = null }) {
  let last = seen;
  return {
    async tick() {
      let s; try { s = loadState(); } catch { return null; }
      if (!s?.runId) return null;
      if (last === null) { last = s.runId; return null; } // first look after start: not a new meeting
      if (s.runId === last) return null;
      last = s.runId;
      const text = meetingDigest(s);
      if (text) await post(text);
      return text;
    },
    markSeen(runId) { last = runId; },
  };
}

// What the meeting reads back from the room: the last few turns + Brandon's noted vision/decisions.
export function roomBrief({ conversation = [], facts = [], limit = 12 } = {}) {
  const turns = conversation.filter((t) => t && t.text && (t.role === 'you' || t.role === 'ceo' || t.role === 'board')).slice(-limit)
    .map((t) => `${t.role === 'you' ? 'Brandon' : t.role === 'board' ? 'Board' : 'Command'}: ${String(t.text).replace(/\s+/g, ' ').slice(0, 360)}`);
  const vision = facts.filter((f) => /^owner:(vision|preference|decision|concern)$/.test(String(f.subject)) && f.valid_to == null)
    .map((f) => `- ${String(f.subject).slice(6)} · ${f.predicate}: ${String(f.object).slice(0, 300)}`).slice(0, 25);
  if (!turns.length && !vision.length) return '';
  return [`THE ROOM — what Brandon has said to the Board Room (plan against it; never contradict a noted decision without saying so):`,
    vision.length ? `Brandon's noted vision / preferences / decisions:\n${vision.join('\n')}` : '', turns.length ? `Recent conversation:\n${turns.join('\n')}` : ''].filter(Boolean).join('\n');
}
