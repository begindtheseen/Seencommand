// Instagram Knowledge Compiler — HTTP route handler for /api/instagram/*.
//
// Self-contained (own json/body/range helpers) so engine/server.mjs just forwards. Every read is
// deterministic and validated; media streams with byte ranges; no endpoint accepts an arbitrary
// executable, path, or command. Phase 2 (doctor + Creator Intelligence Library) lives here; the
// job/guidance/cleanup actions are layered on in later phases.

import { doctor } from './adapter.mjs';
import * as lib from './library.mjs';
import * as jobs from './jobs.mjs';
import * as guidance from './guidance.mjs';
import { libraryInsights, libraryCorpora, insightLine, creatorKeyPoints, keyPointsText, CAVEAT as INSIGHT_CAVEAT } from './insights.mjs';
import * as prune from './prune.mjs';
import * as resolutions from './resolutions.mjs';
import * as discovery from './discovery.mjs';
import { accountRows } from './accounts.mjs';
import { config } from '../config.mjs';
import { loadState } from '../memory.mjs';

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
function body(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
// Decode ONE path segment (a project name or id). Reject anything with a slash/backslash/null.
const seg = (s) => { try { const d = decodeURIComponent(s); return /[\\/\0]/.test(d) ? null : d; } catch { return null; } };

export async function handleInstagram(req, res, rawPath) {
  const url = new URL(req.url, 'http://local');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','instagram',...]
  const rest = parts.slice(2);
  const m = req.method;

  // Research waiting for a free worker slot starts on any Creator Library request (cheap no-op when empty).
  jobs.drainQueue().catch(() => {});

  // GET /api/instagram/doctor
  if (m === 'GET' && rest.length === 1 && rest[0] === 'doctor') return send(res, 200, doctor());

  // GET /api/instagram/library — every account with counts, its keep / prune verdict + reason, open vs
  // resolved "unresolved" knowledge, archive state, and why an account with evidence has 0 knowledge.
  if (m === 'GET' && rest.length === 1 && rest[0] === 'library') return send(res, 200, { projects: await accounts(), archive: prune.archiveSummary(), queue: jobs.readQueue() });

  // GET /api/instagram/creators — the compact account list the Board Room reads (act.mjs creators).
  if (m === 'GET' && rest.length === 1 && rest[0] === 'creators') {
    const rows = await accounts();
    return send(res, 200, { creators: rows.map(compactAccount), archive: prune.archiveSummary().archived.accounts.map((a) => a.project), queue: jobs.readQueue() });
  }

  // GET /api/instagram/creators/:user — ONE creator's key points (ranked, cited, strength-labelled).
  if (m === 'GET' && rest.length === 2 && rest[0] === 'creators') {
    const user = seg(rest[1]); const name = user && lib.projectForUsername(user);
    if (!name) return send(res, 404, { error: `@${String(user || '').replace(/^@/, '')} is not researched yet — research ${String(user || '').replace(/^@/, '')} to build it` });
    if (prune.isArchivedAccount(name)) return send(res, 200, { project: name, archived: true, note: 'archived by prune — restore it to see its key points again', archive: prune.archiveSummary().archived.accounts.find((a) => a.project === name) || null });
    const kp = creatorKeyPoints(await libraryInsights(), name);
    if (!kp) return send(res, 200, { project: name, keyPoints: [], note: 'no in-scope videos yet' });
    const acct = (await accounts()).find((x) => x.name === name);
    return send(res, 200, { ...kp, account: acct ? compactAccount(acct) : null, text: keyPointsText(kp, { max: 12 }) + (acct?.knowledgeNote ? `\n0 knowledge because ${acct.knowledgeNote.text}` : '') });
  }

  // --- prune (archive, reversible) + purge (frees disk; typed confirmation) ---
  if (rest[0] === 'prune' && rest.length === 1 && m === 'GET') return send(res, 200, { plan: await prunePlan(), archive: prune.archiveSummary(), purgePhrase: prune.PURGE_PHRASE });
  if (rest[0] === 'prune' && rest.length === 1 && m === 'POST') {
    const plan = await prunePlan();
    const r = prune.applyPrune(plan);
    return send(res, 200, { ...r, what: { accounts: plan.accounts, rows: plan.rows.slice(0, 50), moreRows: Math.max(0, plan.rows.length - 50) }, counts: plan.counts, undo: 'POST /api/instagram/prune/restore {"all":true} (or {"project":"…"})' });
  }
  if (rest[0] === 'prune' && rest.length === 2 && rest[1] === 'restore' && m === 'POST') { const b = await body(req); const r = prune.restore(b); return send(res, r.ok ? 200 : (r.code || 400), r); }
  if (rest[0] === 'purge-archived' && rest.length === 1 && m === 'POST') {
    const b = await body(req); const r = prune.purgeArchived({ confirm: b.confirm, deleteProject: jobs.deleteProject });
    return send(res, r.ok ? 200 : (r.code || 400), r);
  }

  // --- discovery (OpenCLI → the owner's Chrome; prepares only) ---
  if (rest[0] === 'discover') {
    if (m === 'GET' && rest.length === 1) return send(res, 200, { discoveries: discovery.listDiscoveries() });
    if (m === 'POST' && rest.length === 1) {
      const b = await body(req);
      const c = discovery.createDiscovery({ goal: b.goal, maxQueries: Number(b.maxQueries) || 6 });
      if (!c.ok) return send(res, c.code || 400, c);
      const run = discovery.executeDiscovery(c.discovery, {}, await discoveryDeps());
      const waitMs = Math.min(110000, Math.max(0, Number(b.waitMs) || 0));
      const done = waitMs ? await Promise.race([run, new Promise((r) => setTimeout(() => r(null), waitMs))]) : null;
      const d = (done && done.discovery) || discovery.getDiscovery(c.discovery.id);
      return send(res, 200, { ok: true, discovery: d, running: !done, next: done ? null : `GET /api/instagram/discover/${c.discovery.id}` });
    }
    const id = seg(rest[1]); if (!id) return send(res, 400, { error: 'bad discovery id' });
    if (m === 'GET' && rest.length === 2) { const d = discovery.getDiscovery(id); return d ? send(res, 200, d) : send(res, 404, { error: 'no such discovery' }); }
    if (m === 'POST' && rest.length === 3 && rest[2] === 'queue') {
      const b = await body(req); const r = await discovery.queueFromDiscovery(id, b.handles, { enqueue: (x) => jobs.enqueueResearch(x) });
      return send(res, r.ok ? 200 : (r.code || 400), r);
    }
    return send(res, 404, { error: 'unknown discovery route' });
  }

  // POST /api/instagram/research {username, limit?, reason?} — start now, or wait in the queue when busy.
  if (m === 'POST' && rest.length === 1 && rest[0] === 'research') {
    const b = await body(req); const r = await jobs.enqueueResearch({ username: b.username, limit: Number.isInteger(b.limit) ? b.limit : (Number(b.limit) || undefined), reason: b.reason, source: b.source || 'owner' });
    return send(res, r.ok ? 200 : (r.code || 400), r);
  }
  if (m === 'GET' && rest.length === 1 && rest[0] === 'queue') return send(res, 200, { queue: jobs.readQueue() });

  // GET /api/instagram/insights[?project=NAME] — the ranked, cited, cross-creator insights (the same
  // engine the board meeting + Board Room chat read) + what the LAST board meeting actually used.
  if (m === 'GET' && rest.length === 1 && rest[0] === 'insights') {
    const project = url.searchParams.get('project');
    if (project && !lib.resolveProject(project)) return send(res, 404, { error: 'unknown project' });
    const out = await libraryInsights({ project: project || null });
    let lastMeeting = null; try { lastMeeting = loadState()?.creatorEvidence || null; } catch { /* no state yet */ }
    return send(res, 200, { ...out, lastMeeting });
  }

  // --- jobs (Phase 3) ---
  if (rest[0] === 'jobs') {
    if (m === 'GET' && rest.length === 1) return send(res, 200, { jobs: jobs.listJobs() });
    if (m === 'POST' && rest.length === 1) {
      const b = await body(req);
      const r = await jobs.startJob(b);
      return send(res, r.ok ? 200 : (r.code || 400), r);
    }
    const id = seg(rest[1]);
    if (!id) return send(res, 400, { error: 'bad job id' });
    if (m === 'GET' && rest.length === 2) { const j = jobs.getJob(id); return j ? send(res, 200, j) : send(res, 404, { error: 'no such job' }); }
    if (m === 'POST' && rest.length === 3 && rest[2] === 'cancel') return send(res, 200, jobs.cancelJob(id));
    if (m === 'POST' && rest.length === 3 && rest[2] === 'resume') return send(res, 200, await jobs.resumeJob(id));
    if (m === 'POST' && rest.length === 3 && rest[2] === 'cleanup-preview') return send(res, 200, await jobs.cleanupPreview(id));
    if (m === 'POST' && rest.length === 3 && rest[2] === 'cleanup-confirm') { const b = await body(req); return send(res, 200, await jobs.cleanupConfirm(id, b)); }
    return send(res, 404, { error: 'unknown job route' });
  }

  // --- projects / library (Phase 2) ---
  if (rest[0] === 'projects') {
    const project = seg(rest[1]);
    if (!project) return send(res, 400, { error: 'bad project name' });

    if (m === 'GET' && rest.length === 2) { const p = lib.getProject(project); return p ? send(res, 200, p) : send(res, 404, { error: 'unknown project' }); }

    if (m === 'GET' && rest.length === 3 && rest[2] === 'videos') { const v = lib.listVideos(project); return v ? send(res, 200, { videos: v }) : send(res, 404, { error: 'unknown project' }); }

    if (m === 'GET' && rest.length === 4 && rest[2] === 'videos') {
      const v = lib.getVideo(project, seg(rest[3])); return v ? send(res, 200, v) : send(res, 404, { error: 'unknown video' });
    }

    if (m === 'POST' && rest.length === 3 && rest[2] === 'search') {
      const b = await body(req); const r = lib.search(project, b.query, b.limit);
      return r == null ? send(res, 404, { error: 'unknown project or empty query' }) : send(res, 200, { results: r });
    }

    if (m === 'GET' && rest.length === 4 && rest[2] === 'evidence') {
      const e = lib.getEvidence(project, seg(rest[3])); return e ? send(res, 200, e) : send(res, 404, { error: 'unknown evidence' });
    }

    if (m === 'GET' && rest.length === 4 && rest[2] === 'knowledge') {
      const k = lib.getKnowledge(project, seg(rest[3])); return k ? send(res, 200, k) : send(res, 404, { error: 'unknown knowledge record' });
    }

    // Project-wide bounded knowledge list for the Knowledge tab.
    if (m === 'GET' && rest.length === 3 && rest[2] === 'knowledge') { const k = lib.listKnowledge(project); return k == null ? send(res, 404, { error: 'unknown project' }) : send(res, 200, { knowledge: k }); }

    // Safe project file explorer: GET /api/instagram/projects/:project/tree?path=PROJECT_RELATIVE
    if (m === 'GET' && rest.length === 3 && rest[2] === 'tree') { const t = lib.listDir(project, url.searchParams.get('path') || ''); return send(res, t.ok ? 200 : (t.code || 400), t); }

    // "Unresolved" = knowledge the extractor marked `ambiguous`; each with how it resolves (corroborated,
    // ≥2 videos, owner decision) or why it is still open. POST …/unresolved/:kid {status, note} decides one.
    if (m === 'GET' && rest.length === 3 && rest[2] === 'unresolved') {
      const corpus = lib.creatorCorpus(project); if (!corpus) return send(res, 404, { error: 'unknown project' });
      const { corpora } = await libraryCorpora();
      const others = corpora.filter((c) => c.project !== project).flatMap((c) => c.knowledge || []);
      return send(res, 200, { ...resolutions.unresolvedReport(project, corpus.knowledge || [], others), meaning: UNRESOLVED_MEANING });
    }
    if (m === 'POST' && rest.length === 4 && rest[2] === 'unresolved') {
      if (!lib.resolveProject(project)) return send(res, 404, { error: 'unknown project' });
      const b = await body(req); const r = resolutions.setOverride(project, seg(rest[3]), { status: b.status, note: b.note });
      return send(res, r.ok ? 200 : (r.code || 400), r);
    }

    // GET /api/instagram/projects/:project/files?path=PROJECT_RELATIVE
    if (m === 'GET' && rest.length === 3 && rest[2] === 'files') {
      const rel = url.searchParams.get('path') || '';
      const f = lib.readProjectFile(project, rel);
      if (f.error) return send(res, f.code || 400, { error: f.error });
      res.writeHead(200, { 'content-type': f.type, 'content-length': f.bytes, 'x-content-type-options': 'nosniff' });
      return res.end(f.content);
    }

    // GET /api/instagram/projects/:project/media/:video  — byte-range video/audio streaming
    if (m === 'GET' && rest.length === 4 && rest[2] === 'media') {
      const media = lib.openMedia(project, seg(rest[3]));
      if (media.error) return send(res, media.code || 404, { error: media.error });
      return streamRange(req, res, media);
    }

    // --- media retention pins (Phase 5) ---
    if (m === 'GET' && rest.length === 3 && rest[2] === 'media-retention') return send(res, 200, { pinned: jobs.getPins(project) });
    if (m === 'POST' && rest.length === 3 && rest[2] === 'media-retention') { const b = await body(req); return send(res, 200, jobs.setPins(project, b)); }

    // --- delete the whole researched folder (owner action; typed confirmation; refuses read-only) ---
    if (m === 'POST' && rest.length === 3 && rest[2] === 'delete') { const b = await body(req); const r = jobs.deleteProject(project, b); return send(res, r.ok ? 200 : (r.code || 400), r); }

    // --- guidance / ask (Phase 4) ---
    if (m === 'POST' && rest.length === 3 && rest[2] === 'ask') { const b = await body(req); return send(res, 200, await guidance.ask(project, b.question, b.limit)); }
    if (m === 'GET' && rest.length === 3 && rest[2] === 'guidance') return send(res, 200, { briefs: guidance.listBriefs(project) });
    if (m === 'POST' && rest.length === 3 && rest[2] === 'guidance') { const b = await body(req); return send(res, 200, await guidance.createBrief(project, b)); }
    if (m === 'GET' && rest.length === 4 && rest[2] === 'guidance') { const g = guidance.getBrief(project, seg(rest[3])); return g ? send(res, 200, g) : send(res, 404, { error: 'unknown brief' }); }
    if (m === 'POST' && rest.length === 5 && rest[2] === 'guidance' && rest[4] === 'approve') { const b = await body(req); const r = await guidance.approveBrief(project, seg(rest[3]), b); return send(res, r.ok ? 200 : (r.code || 400), r); }

    return send(res, 404, { error: 'unknown project route' });
  }

  return send(res, 404, { error: 'unknown instagram route' });
}

export const UNRESOLVED_MEANING = 'Unresolved = knowledge the extractor marked "ambiguous" (stated once, unclear, or uncorroborated). '
  + 'The compiler never revisits them (its reconcile step only compares numeric rule thresholds), so they used to stay unresolved forever. '
  + 'Seen Command now resolves them: corroborated by another record (this or another creator) or stated in ≥2 videos → probable; '
  + 'or the owner confirms / retires it. Open = one video and no second source yet.';

async function accounts() {
  const { corpora } = await libraryCorpora();
  return accountRows({ projects: lib.listProjects(), corpora, jobs: jobs.listJobs(), archive: prune.readArchive() });
}
function compactAccount(a) {
  const c = a.counts || {};
  return { handle: `@${a.username || a.name}`, project: a.name, readOnly: !!a.readOnly, videos: c.videos || 0, evidence: c.evidence || 0, knowledge: c.knowledge || 0,
    verdict: a.verdict?.verdict || 'pending', why: a.verdict?.why || null, unresolved: a.unresolved, knowledgeNote: a.knowledgeNote?.text || null,
    job: a.job ? `${a.job.status} · ${a.job.stage}${a.job.error ? ` · ${String(a.job.error).slice(0, 160)}` : ''}` : null, storageBytes: a.storageBytes || 0 };
}
async function prunePlan() {
  const sizes = new Map(lib.listProjects().map((p) => [p.name, p.storageBytes || 0]));
  return prune.planPrune(await libraryInsights(), { bytesFor: (p) => sizes.get(p) ?? null });
}
async function discoveryDeps() {
  const { corpora } = await libraryCorpora();
  const a = prune.readArchive();
  const handles = new Set([...lib.projectNames().map((n) => n.replace(/^instagram-/, '').toLowerCase()),
    ...lib.listProjects().map((p) => String(p.username || '').toLowerCase()).filter(Boolean),
    ...Object.values(a.accounts).map((x) => String(x.handle || '').replace(/^@/, '').toLowerCase()).filter(Boolean),
    ...jobs.readQueue().map((q) => q.username.toLowerCase())]);
  return { corpora, exclude: handles };
}

// Deterministic Board Room commands for the Instagram compiler — matched BEFORE the general LLM lane.
// Returns { reply, action? } for a recognized command, or null so normal chat proceeds. No network
// beyond the local worker; retrieval is bounded + attributed; nothing destructive runs from chat.
export async function handleInstagramChat(message) {
  const t = String(message || '').trim();
  let m;

  // research instagram <user> [latest N | all videos [confirm]]
  if ((m = /^research\s+instagram\s+@?([a-z0-9._]{1,30})\s*(.*)$/i.exec(t))) {
    const user = m[1], tail = (m[2] || '').trim();
    // Only an empty tail or a recognized scope modifier is allowed. Reject stray text so
    // "research instagram bad name!" never silently truncates to @bad and downloads it.
    if (tail && !/^(all\s+videos(\s+confirm)?|(?:latest|newest|top)\s+\d{1,4})$/i.test(tail)) {
      return { reply: `I didn't recognize "research instagram ${user} ${tail}". Use: research instagram <username> [latest N | all videos]. A username is letters, digits, dots, and underscores only.` };
    }
    const all = /\ball\s+videos\b/i.test(tail);
    // Full-archive download can be large (many GB) and slow — require an explicit confirmation.
    if (all && !/\bconfirm\b/i.test(tail)) {
      return { reply: `Researching ALL of @${user}'s accessible videos can download many gigabytes and take a long time (every reel transcribed + OCR'd). The default is the newest ${config.vscDefaultLimit()}. To proceed with the full archive, say: research instagram ${user} all videos confirm — or just "research instagram ${user}" for the newest ${config.vscDefaultLimit()}.` };
    }
    const lim = (/(?:latest|newest|top)\s+(\d{1,4})/i.exec(tail) || [])[1];
    // Busy worker → the request waits in the research queue (a full-archive run is never queued: it
    // needs the owner watching, so it is started directly or refused).
    const r = all ? await jobs.startJob({ username: user, allVideos: true }) : await jobs.enqueueResearch({ username: user, limit: lim ? Number(lim) : undefined, source: 'board room' });
    if (!r.ok) return { reply: `Couldn't start Instagram research for @${user}: ${r.error}` };
    if (r.queued) return { reply: `The research worker is busy (2 creators at a time), so @${user} is queued at position ${r.position} — it starts by itself when a running job ends. "instagram status" shows the queue.` };
    const j = r.job;
    if (r.deduped) return { reply: `Already researching @${user} (job ${j.id}, ${j.status}) — I won't download twice. Say "instagram status ${user}" to watch it.`, action: { type: 'instagram_job', id: j.id } };
    return { reply: `Started Instagram research for @${user} — ${all ? 'ALL accessible videos' : `newest ${j.requestedLimit}`}, anonymously (no login). Job ${j.id}. Pipeline: ingest → transcribe → OCR/frames → evidence → validated knowledge → reconcile → audit → cleanup preview. "instagram status ${user}" to watch. It is NOT complete until knowledge is validated and coverage is audited.`, action: { type: 'instagram_job', id: j.id } };
  }

  // resume instagram <user> — a knowledge-stage failure reuses existing evidence and never
  // re-downloads Instagram media. Earlier-stage failures resume the normal guarded pipeline.
  if ((m = /^resume\s+instagram\s+@?([a-z0-9._]{1,30})\s*$/i.exec(t))) {
    const user = m[1];
    const j = jobs.listJobs().find((x) => x.username.toLowerCase() === user.toLowerCase());
    if (!j) return { reply: `No research job for @${user} yet — "research instagram ${user}" to start.` };
    if (j.status === 'running' || j.status === 'queued') return { reply: `@${user} is already ${j.status} at stage ${j.stage}.` };
    const r = await jobs.resumeJob(j.id);
    if (!r.ok) return { reply: `Couldn't resume @${user}: ${r.error}` };
    const reusing = ['knowledge', 'reconcile', 'audit', 'cleanup_preview'].includes(j.stage);
    return { reply: `Resumed @${user} from ${j.stage}.${reusing ? ' Existing videos, transcripts, OCR, and evidence will be reused; Instagram download is skipped.' : ''} Say "instagram status ${user}" to watch it.`, action: { type: 'instagram_job', id: j.id } };
  }

  // instagram status [user]
  if ((m = /^instagram\s+status(?:\s+@?([a-z0-9._]{1,30}))?\s*$/i.exec(t))) {
    const user = m[1];
    if (user) {
      const j = jobs.listJobs().find((x) => x.username.toLowerCase() === user.toLowerCase());
      return { reply: j ? `@${user}: ${j.status} · stage ${j.stage} · ${j.stageProgress?.done ?? 0}/${j.stageProgress?.total ?? '?'} · ${j.knowledgeCount || 0} knowledge${j.coverage?.selected != null ? ` · coverage ${j.coverage.processed}/${j.coverage.selected}` : ''}${j.error ? ` · ${j.error}` : ''}` : `No research job for @${user} yet — "research instagram ${user}" to start.` };
    }
    const list = jobs.listJobs().slice(0, 8); const q = jobs.readQueue();
    const queued = q.length ? `\nWaiting for a free slot: ${q.map((x, i) => `${i + 1}. @${x.username}${x.reason ? ` (${x.reason.slice(0, 80)})` : ''}`).join(' · ')}` : '';
    return { reply: list.length || q.length ? 'Instagram research jobs:\n' + list.map((j) => `• @${j.username}: ${j.status} (${j.stage}) — ${j.knowledgeCount || 0} knowledge${j.error ? ` — ${String(j.error).slice(0, 140)}` : ''}`).join('\n') + queued : 'No Instagram research jobs yet — "research instagram <username>" to start.' };
  }

  // ask instagram <user>: <question>
  if ((m = /^ask\s+instagram\s+@?([a-z0-9._]{1,30})\s*:\s*([\s\S]+)$/i.exec(t))) {
    const name = lib.projectForUsername(m[1]);
    if (!name) return { reply: `No researched project for @${m[1]} yet — "research instagram ${m[1]}" first.` };
    const r = await guidance.ask(name, m[2].trim(), 6);
    if (!r.ok) return { reply: `Couldn't answer: ${r.error}` };
    if (!r.knowledge.length) return { reply: `No matching knowledge from ${r.attribution[0]} on that.\n${r.caveat}` };
    const lines = r.knowledge.slice(0, 5).map((k) => `• ${k.title}${k.description ? ` — ${k.description}` : ''}`);
    const cites = r.citations.slice(0, 3).map((c) => `   ↳ ${c.source_url || c.video_id} @ ${c.at}: "${c.excerpt}"`);
    return { reply: `From ${r.attribution[0]}'s content (research, not verified product truth):\n${lines.join('\n')}\n\nEvidence:\n${cites.join('\n')}\n\n${r.caveat}` };
  }

  // use <user> guidance to <objective>  |  create a SeenJobs guidance brief from <user> about <topic>
  if ((m = /^use\s+@?([a-z0-9._]{1,30})\s+guidance\s+to\s+([\s\S]+)$/i.exec(t))
    || (m = /^create\s+(?:a\s+)?seenjobs\s+guidance\s+brief\s+from\s+@?([a-z0-9._]{1,30})\s+(?:about|on|to|for)\s+([\s\S]+)$/i.exec(t))) {
    const name = lib.projectForUsername(m[1]);
    if (!name) return { reply: `No researched project for @${m[1]} yet — "research instagram ${m[1]}" first.` };
    const objective = m[2].trim();
    const r = await guidance.createBrief(name, { seenObjective: objective, question: objective });
    if (!r.ok) return { reply: `Couldn't draft a brief: ${r.error}` };
    const b = r.brief;
    return { reply: `Drafted a guidance brief (${b.briefId}) from ${b.creatorAttribution[0]} for: "${b.seenObjective}".\n${b.knowledgeIds.length} creator knowledge record(s), ${b.evidenceIds.length} evidence link(s), labeled source_derived. Status: DRAFT — review + approve before anything is built. Nothing ships to SeenJobs automatically.`, action: { type: 'instagram_brief', id: b.briefId, project: name } };
  }

  // preview instagram cleanup <user>  (preview only — never deletes)
  if ((m = /^preview\s+instagram\s+cleanup\s+@?([a-z0-9._]{1,30})\s*$/i.exec(t))) {
    const j = jobs.listJobs().find((x) => x.username.toLowerCase() === m[1].toLowerCase());
    if (!j) return { reply: `No research job for @${m[1]} to preview cleanup for.` };
    const r = await jobs.cleanupPreview(j.id);
    if (!r.ok) return { reply: `Cleanup preview unavailable: ${r.error}` };
    const p = r.preview || {};
    const gb = p.gigabytes_to_delete ?? ((p.bytes_to_delete || 0) / 1e9).toFixed(2);
    return { reply: `Cleanup preview for @${m[1]}: ${p.file_count || 0} raw video/audio files (~${gb} GB) would be deleted; evidence, knowledge, frames, transcripts, and reports are preserved. ${p.ready ? 'Nothing is deleted without an explicit, job-bound confirmation.' : `Not ready: ${(p.blockers || []).join('; ') || 'artifacts incomplete'}.`}` };
  }

  // creators — every account with its keep / prune verdict and the reason.
  if (/^(?:show |list )?(?:the |my )?(?:researched )?(?:creators?|creator library)(?: accounts| verdicts)?\??$/i.test(t)) {
    const rows = (await accounts()).map(compactAccount);
    if (!rows.length) return { reply: 'No researched creators yet — "research instagram <username>" or "discover creators for <goal>" to find some.' };
    return { reply: `Creator Library — ${rows.length} account${rows.length === 1 ? '' : 's'}:\n${rows.map((r) => `• ${r.handle}: ${r.videos} videos · ${r.evidence} evidence · ${r.knowledge} knowledge — ${r.verdict.toUpperCase()}: ${r.why || 'no verdict yet'}${r.unresolved?.open ? ` · ${r.unresolved.open} unresolved open` : ''}${r.knowledgeNote ? ` · 0 knowledge because ${r.knowledgeNote}` : ''}`).join('\n')}\n\n"prune creator library" archives every PRUNE account and off-purpose row (reversible: "restore creator library").` };
  }

  // discover creators for <goal> — web search in the owner's Chrome (OpenCLI); prepares only.
  if ((m = /^(?:discover|find)\s+(?:new\s+)?(?:instagram\s+)?(?:creators?|influencers?|accounts?)\s+(?:for|who|that|to|about|in|on|with)?\s*([\s\S]{3,200})$/i.exec(t))
    || (m = /^discover\s+([\s\S]{3,200})$/i.exec(t))) {
    const c = discovery.createDiscovery({ goal: m[1].trim() });
    if (!c.ok) return { reply: c.error };
    discovery.executeDiscovery(c.discovery, {}, await discoveryDeps()).catch(() => {});
    return { reply: `Discovering creators for "${c.discovery.goal}" (${c.discovery.id}) — ${c.discovery.queries.length} Google searches in your Chrome via OpenCLI, never instagram.com, never a login or a message; a CAPTCHA stops it. Takes about a minute. Say "discovery ${c.discovery.id}" for the two ranked lists (learn from / audience fit, each with its Seen angle).`, action: { type: 'instagram_discovery', id: c.discovery.id } };
  }
  if ((m = /^discovery\s+(disc-[a-z0-9-]{6,60})\s*$/i.exec(t))) {
    const d = discovery.getDiscovery(m[1].toLowerCase());
    if (!d) return { reply: `No discovery ${m[1]}.` };
    return { reply: discoveryText(d) };
  }

  // prune / restore / purge — archive is reversible; purge needs the exact phrase.
  if (/^prune(?:\s+the)?\s+(?:creator\s+library|creators?(?:\s+tab)?)\s*$/i.test(t)) {
    const plan = await prunePlan(); const r = prune.applyPrune(plan);
    const fam = Object.entries(plan.rows.reduce((o, x) => { const f = x.family || 'no link to Seen'; o[f] = (o[f] || 0) + 1; return o; }, {})).map(([f, n]) => `${n} ${f}`).join(', ');
    return { reply: `Archived ${r.archived.accounts} account(s) and ${r.archived.rows} off-purpose knowledge row(s) — gone from the Creator Library, board meetings and this chat.${plan.accounts.length ? `\nAccounts: ${plan.accounts.map((a) => `${a.handle || a.project} (${a.why})`).join('; ')}` : ''}${fam ? `\nRows by reason: ${fam}` : ''}\nNothing is deleted — "restore creator library" brings it all back. "purge archived creators confirm ${prune.PURGE_PHRASE}" frees the disk space for good.` };
  }
  if ((m = /^restore\s+(?:the\s+)?(?:creator\s+library|creators|@?([a-z0-9._]{1,30}))\s*$/i.exec(t))) {
    const name = m[1] ? lib.projectForUsername(m[1]) : null;
    if (m[1] && !name) return { reply: `@${m[1]} is not in the library.` };
    const r = prune.restore(name ? { project: name } : { all: true });
    return { reply: r.ok ? `Restored ${r.restored.accounts} account(s) and ${r.restored.rows} row(s).` : r.error };
  }
  if ((m = /^purge\s+archived(?:\s+creators?)?(?:\s+confirm\s+(.+))?$/i.exec(t))) {
    const r = prune.purgeArchived({ confirm: (m[1] || '').trim(), deleteProject: jobs.deleteProject });
    if (!r.ok) return { reply: `Purge permanently deletes every ARCHIVED account's folder (videos, audio, frames, evidence, knowledge) and hides archived rows for good. To do it, say exactly: purge archived creators confirm ${prune.PURGE_PHRASE}` };
    return { reply: `Purged ${r.purged.accounts.length} account folder(s) (${(r.purged.freedBytes / 1e9).toFixed(2)} GB freed) and ${r.purged.rows} archived row(s).${r.keptArchived.length ? ` Kept archived (could not delete): ${r.keptArchived.map((k) => `${k.project} — ${k.why}`).join('; ')}.` : ''}` };
  }

  // ── Natural-language creator digest — the fix for "@x isn't in the library" when it IS ─────────
  // The rigid commands above miss natural phrasings ("find key points for @user", "summary of @user",
  // or just "@user"), so they used to fall through to the general LLM — which has NO library access and
  // falsely answers "@user isn't in the library". Resolve the handle against the ACTUAL library and
  // answer deterministically (evidence-backed) so a researched creator is never denied by the chat.
  {
    const wantsDigest = /\b(key\s*points?|takeaways?|highlights?|summar(?:y|ize|ise)|insights?|playbook|cheat\s*sheet|breakdowns?|break\s*downs?|learnings?|what\s+do\s+we\s+know|what'?s\s+in\s+the\s+library|tell\s+me\s+about|show\s+me)\b/i.test(t);
    const bareHandle = /^(?:i\s+(?:meant|mean)\s+)?@[a-z0-9._]{2,30}\??$/i.test(t);
    if (wantsDigest || bareHandle) {
      const hit = findResearchedCreator(t);
      if (hit) return await creatorDigest(hit.user, hit.name);
      const explicit = (/@([a-z0-9._]{2,30})/.exec(t) || [])[1];
      if (explicit && !lib.projectForUsername(explicit)) {
        return { reply: `@${explicit} isn't researched yet — say "research instagram ${explicit}" to build its evidence-backed library, then ask for its key points.` };
      }
      // A digest intent with no resolvable creator falls through to the normal chat lane.
    }
  }

  return null;
}

// Find a RESEARCHED creator referenced anywhere in the text — @handles first, then non-stopword tokens —
// returning the first that resolves to a library project. Deterministic; no network.
const CREATOR_STOP = new Set(['instagram', 'ig', 'insta', 'the', 'for', 'key', 'keys', 'point', 'points', 'summary', 'takeaways', 'highlights', 'insights', 'playbook', 'about', 'what', 'whats', 'who', 'how', 'why', 'when', 'tell', 'show', 'give', 'find', 'get', 'know', 'our', 'their', 'they', 'account', 'creator', 'creators', 'profile', 'library', 'video', 'videos', 'evidence', 'knowledge', 'please', 'can', 'you', 'and', 'from', 'with', 'this', 'that', 'quarter', 'revenue', 'meant', 'mean']);
function findResearchedCreator(t) {
  const ats = [...String(t).matchAll(/@([a-z0-9._]{2,30})/gi)].map((x) => x[1]);
  const words = (String(t).toLowerCase().match(/[a-z0-9._]{2,30}/g) || []).filter((w) => !CREATOR_STOP.has(w));
  for (const cand of [...ats, ...words].slice(0, 8)) {
    const name = lib.projectForUsername(cand);
    if (name) return { user: String(cand).replace(/^@/, ''), name };
  }
  return null;
}

// Evidence-backed "key points" for a researched creator — the SAME deterministic insight engine the
// board meeting reads, scoped to this creator (ranked, strength-labelled, cited; no model call). Falls
// back to raw knowledge, then to research status, so a creator that IS in the library is NEVER denied.
async function creatorDigest(user, name) {
  if (prune.isArchivedAccount(name)) return { reply: `@${user} was archived by prune (${prune.archiveSummary().archived.accounts.find((a) => a.project === name)?.why || 'off-purpose for SeenJobs'}). "restore @${user}" brings it back.` };
  const kp = creatorKeyPoints(await libraryInsights().catch(() => null), name);
  if (kp && (kp.keyPoints.length || kp.pruned.total)) {
    const note = (await accounts()).find((x) => x.name === name)?.knowledgeNote;
    return { reply: `What @${user}'s videos show — key points for SeenJobs, strongest first (strength counts independent creators and videos; a point only @${user} makes stays weak):\n\n${keyPointsText(kp, { max: 8 })}${note ? `\n0 knowledge because ${note.text}` : ''}\n\n${INSIGHT_CAVEAT}\nOpen the Creator Library for every point with its citations, or "ask instagram ${user}: <question>" to go deeper.` };
  }
  // In the library, but nothing validated yet → point at status / research.
  const j = jobs.listJobs().find((x) => String(x.username || '').toLowerCase() === String(user).toLowerCase());
  return { reply: j && (j.status === 'running' || j.status === 'queued')
    ? `@${user} is in the library and still being researched (${j.status} · stage ${j.stage} · ${j.knowledgeCount || 0} knowledge so far). Say "instagram status ${user}" to watch it.`
    : `@${user} is in the library but has no validated knowledge yet. Say "instagram status ${user}", or "research instagram ${user}" to (re)build it.` };
}

function discoveryText(d) {
  const row = (c) => `• @${c.handle}${c.followers ? ` (${c.followers.toLocaleString('en-US')} followers)` : ''} — ${c.reasons.slice(0, 3).join('; ')}${c.angle ? `. Seen angle: ${c.angle.asset} ${c.angle.url}` : ''}`;
  const why = d.stoppedBy === 'google_blocked' ? 'Google asked for a CAPTCHA — stopped, never solved' : d.stoppedBy === 'opencli_unavailable' ? `OpenCLI unavailable: ${d.opencli?.detail || ''}` : d.stoppedBy;
  const head = `Discovery ${d.id} for "${d.goal}" — ${d.status}${d.stoppedBy ? ` (${why})` : ''}.`;
  if (d.status === 'running') return `${head} Still searching — ask again in a moment.`;
  const parts = [head,
    d.learn?.length ? `LEARN FROM:\n${d.learn.slice(0, 8).map(row).join('\n')}` : 'LEARN FROM: none found.',
    d.audience?.length ? `AUDIENCE FIT (would want to cite Seen's data):\n${d.audience.slice(0, 8).map(row).join('\n')}` : 'AUDIENCE FIT: none found.'];
  if (d.stoppedBy === 'opencli_unavailable') parts.push(`Run these by hand: ${d.queries.join(' | ')}`);
  parts.push('Nothing was contacted. To research any of them: "research instagram <handle>" (queued when the worker is busy).');
  return parts.join('\n\n');
}

// HTTP byte-range streaming. Never buffers the whole file; honors a single Range, else sends 200.
function streamRange(req, res, media) {
  const range = req.headers.range;
  const total = media.size;
  const common = { 'content-type': media.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=0' };
  if (!range) {
    res.writeHead(200, { ...common, 'content-length': total });
    return media.stream({}).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'content-range': `bytes */${total}` }); return res.end(); }
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null) { start = Math.max(0, total - (end || 0)); end = total - 1; } // suffix range
  else if (end === null || end >= total) { end = total - 1; }
  if (!Number.isFinite(start) || start > end || start >= total || start < 0) { res.writeHead(416, { 'content-range': `bytes */${total}` }); return res.end(); }
  res.writeHead(206, { ...common, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
  return media.stream({ start, end }).pipe(res);
}
