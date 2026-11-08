// What the Board Room assistant reads and writes through `node scripts/act.mjs` (and what the UI can call):
//   GET  /api/assistant/brief      the last board meeting (headline, constraint, proposals), every pending
//                                  approval with its id, running searches/collectors, skills, and a compact
//                                  tickets block (active count + the ones that need Brandon)
//   GET  /api/assistant/recall?q=  brain facts + timeline lines that match, ranked, newest first
//   POST /api/assistant/note       remember something durable. Never a duplicate: the same subject+topic with
//                                  the same words is a no-op; changed words SUPERSEDE (history kept); and the
//                                  answer lists related facts + pending approvals so the reply can point at them
//   GET  /api/assistant/skills     the skill roster (+ errors in skill files)
//   POST /api/terminal/claude      open Claude Code in Terminal in a checkout ({ repo, prompt })
// Local-only: every route refuses a request that did not come from this Mac (the same check the
// credentials and brain-record routes use).
const WORD = /[a-z0-9]{3,}/g;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when', 'into', 'about', 'should', 'would', 'could', 'need', 'want', 'make', 'just', 'like', 'also', 'them', 'they', 'their', 'there', 'then', 'than', 'your', 'you', 'our', 'are', 'was', 'were', 'will', 'can', 'not', 'but', 'all', 'any', 'its', 'seen']);
export const words = (s) => [...new Set((String(s || '').toLowerCase().match(WORD) || []).filter((w) => !STOP.has(w)))];

// Rank facts/lines by shared words (subject counts double), then recency. Pure — unit tested.
export function rankRecall(query, facts = [], lines = [], { limit = 12 } = {}) {
  const q = words(query); if (!q.length) return { facts: [], lines: [] };
  const score = (text, boost = '') => { const w = new Set(words(`${text} ${boost} ${boost}`)); return q.reduce((n, x) => n + (w.has(x) ? 1 : 0), 0); };
  const f = facts.map((x) => ({ x, s: score(`${x.predicate} ${x.object}`, x.subject) })).filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || String(b.x.valid_from || '').localeCompare(String(a.x.valid_from || ''))).slice(0, limit)
    .map((r) => ({ subject: r.x.subject, predicate: r.x.predicate, object: String(r.x.object).slice(0, 400), confidence: r.x.confidence || null, since: r.x.valid_from || null }));
  const l = lines.map((x) => ({ x, s: score(x.text) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s || String(b.x.date).localeCompare(String(a.x.date))).slice(0, Math.ceil(limit / 2))
    .map((r) => ({ date: r.x.date, heading: r.x.heading || null, text: String(r.x.text).slice(0, 400) }));
  return { facts: f, lines: l };
}

// Related pending approvals for a note or a question (so "is a fix already waiting?" is answered).
export function relatedApprovals(text, approvals = []) {
  const q = words(text); if (!q.length) return [];
  return approvals.filter((a) => a.status === 'pending').map((a) => ({ a, s: q.filter((w) => words(`${a.title} ${a.summary} ${a.action}`).includes(w)).length }))
    .filter((r) => r.s >= 2).sort((x, y) => y.s - x.s).slice(0, 4).map(({ a }) => ({ id: a.id, title: a.title, dept: a.dept, risk: a.risk || null }));
}

// A note → the fact it becomes. Vision/preference/decision statements live under one subject per kind so
// they are findable together ("owner:vision", topic = predicate).
export function noteFact({ kind = 'vision', topic = '', text = '', subject = '', predicate = '', object = '' } = {}) {
  if (subject && predicate && object) return { subject: String(subject).slice(0, 120), predicate: String(predicate).slice(0, 120), object: String(object).slice(0, 2000) };
  const t = String(text || '').trim(); const top = String(topic || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (!t || !top) return null;
  const subj = { vision: 'owner:vision', preference: 'owner:preference', decision: 'owner:decision', concern: 'owner:concern' }[kind] || 'owner:vision';
  return { subject: subj, predicate: top, object: t.slice(0, 2000) };
}

// The brief's tickets block: counts and only what needs Brandon (blocked on him, a PR ready to merge).
// deps.ticketsSummary is the seam; the live app reads lib/ticket-routes.mjs liveTicketsSummary().
async function ticketsBlock(fn) {
  try {
    const read = fn || (async () => (await import('../ticket-routes.mjs')).liveTicketsSummary());
    const s = await Promise.race([read(), new Promise((r) => setTimeout(() => r(null), 10_000).unref?.())]);
    if (!s) return null;
    return { active: s.active || 0, unclaimed: s.unclaimed || 0, readyForAI: s.readyForAI || 0, claimed: s.claimed || 0,
      needsYou: (s.needsOwner || []).slice(0, 6).map((t) => ({ id: t.id, title: t.title, why: t.why, pr: t.prUrl || null })) };
  } catch { return null; }
}

export function createAssistantRoutes(deps) {
  const { json, readBody, localOnly, loadState, currentFacts, timelineLines, recordFact, skills, searches, openTerminal, logActivity = () => {} } = deps;
  return async function handle(req, res, path, qs) {
    if (!path.startsWith('/api/assistant/') && path !== '/api/terminal/claude') return false;
    if (!localOnly(req)) { json(res, 403, { error: 'the assistant routes answer this Mac only' }); return true; }
    try {
      if (req.method === 'GET' && path === '/api/assistant/brief') {
        const s = loadState() || {};
        const d = s.debrief || {};
        const simOf = (id) => { try { const r = deps.simulationFor ? deps.simulationFor(id) : null; return r ? { status: r.status, call: r.result?.verdict || null, id: r.id } : null; } catch { return null; } };
        const pending = (s.approvals || []).filter((a) => a.status === 'pending').map((a) => ({ id: a.id, title: a.title, dept: a.dept, risk: a.risk || null, summary: String(a.summary || '').slice(0, 300), simulation: simOf(a.id) }));
        const proposals = (s.proposals || []).slice(0, 15).map((p) => ({ title: p.title, dept: p.dept, impact: p.impact ?? p.score ?? null, summary: String(p.summary || p.why || '').slice(0, 240) }));
        json(res, 200, {
          meeting: s.runId ? { runId: s.runId, at: s.generatedAt || null, focus: d.focus?.title || null, headline: d.headline || null, topConstraint: d.topConstraint || null, steer: d.steer || null, engine: s.reasonEngine || null } : null,
          pending, proposals, decided: (s.approvals || []).filter((a) => a.status !== 'pending').slice(0, 8).map((a) => ({ id: a.id, title: a.title, status: a.status, at: a.decidedAt || null })),
          searches: (searches?.() || []).filter((x) => x.status === 'running').map((x) => ({ id: x.id, label: x.label, kind: x.kind, steps: (x.steps || []).map((st) => `${st.label}: ${st.status}`) })),
          skills: (skills?.list().skills || []).map((x) => ({ name: x.name, description: x.description })),
          tickets: await ticketsBlock(deps.ticketsSummary),
        });
        return true;
      }
      if (req.method === 'GET' && path === '/api/assistant/recall') {
        const q = String(qs.get('q') || '').slice(0, 400);
        const r = rankRecall(q, currentFacts() || [], timelineLines ? timelineLines(30) : []);
        json(res, 200, { query: q, ...r, approvals: relatedApprovals(q, (loadState() || {}).approvals || []) });
        return true;
      }
      if (req.method === 'POST' && path === '/api/assistant/note') {
        const b = await readBody(req);
        const fact = noteFact(b);
        if (!fact) { json(res, 400, { ok: false, error: 'a note needs { kind, topic, text } or { subject, predicate, object }' }); return true; }
        const before = (currentFacts() || []).find((f) => String(f.subject).toLowerCase() === fact.subject.toLowerCase() && String(f.predicate).toLowerCase() === fact.predicate.toLowerCase());
        if (before && String(before.object) === fact.object) { json(res, 200, { ok: true, result: 'already_known', fact, approvals: relatedApprovals(fact.object, (loadState() || {}).approvals || []) }); return true; }
        const out = await recordFact(fact);
        if (!out.ok) { json(res, 422, out); return true; }
        logActivity({ kind: 'brain-write', status: 'written', summary: `assistant noted ${fact.subject} · ${fact.predicate}` });
        const related = rankRecall(`${fact.predicate} ${fact.object}`, (currentFacts() || []).filter((f) => !(f.subject === fact.subject && f.predicate === fact.predicate)), [], { limit: 5 }).facts;
        json(res, 200, { ok: true, result: before ? 'superseded' : 'added', previous: before ? String(before.object).slice(0, 400) : null, fact, related, approvals: relatedApprovals(fact.object, (loadState() || {}).approvals || []) });
        return true;
      }
      if (req.method === 'GET' && path === '/api/assistant/skills') {
        const cur = skills ? skills.check() : { skills: [], errors: [] };
        json(res, 200, { skills: cur.skills.map((x) => ({ name: x.name, description: x.description, when: x.when, origin: x.origin, file: x.file })), errors: cur.errors, folders: deps.skillDirs || [] });
        return true;
      }
      if (req.method === 'POST' && path === '/api/terminal/claude') {
        const b = await readBody(req);
        const r = await openTerminal({ repo: b.repo === 'seen' ? 'seen' : 'command', prompt: b.prompt || '' });
        json(res, r.ok ? 200 : 400, r);
        return true;
      }
      json(res, 404, { error: 'no such assistant route' });
      return true;
    } catch (e) { json(res, 500, { error: e.message }); return true; }
  };
}
