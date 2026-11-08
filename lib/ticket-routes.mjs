// Ticket + PR routes for the Tickets view (lib/ui/tickets-client.js). Wired into engine/server.mjs by one
// dispatch line. Reads are loopback-only; every change also needs the local app's own Origin (the same
// gate as credentials and task deletion), so a web page in the browser cannot press these buttons.
//
//   GET  /api/tickets?status=&repo=&kind=&limit=   list (+ summary)
//   GET  /api/tickets/summary                      counts + the ones that need the owner
//   POST /api/tickets  { title, error, helped, kind?, repo?, thing?, blocked? }
//                                                  open one by hand — the Board Room assistant's "I could not do
//                                                  this; here is what would have helped" (act.mjs ticket-new)
//   GET  /api/tickets/:id                          one ticket, in full, + what "Ask Claude to fix" would do
//   POST /api/tickets/:id/fix                      queue it to the builder, or mark it ready for an AI
//   POST /api/tickets/:id/wont-fix   { reason }
//   POST /api/tickets/:id/duplicate  { of }
//   POST /api/tickets/:id/note       { text }
//   POST /api/tickets/:id/open       { reason }   reopen a closed one / release a claim
//   GET  /api/prs                                  open PRs on both repos
//   GET  /api/prs/:owner/:repo/:n                  checks + mergeability (+ the deploy, once merged)
//   POST /api/prs/:owner/:repo/:n/merge  { expectedHeadSha, confirm: true, confirmText? }   squash, only when safe.
//        confirmText (the assistant's path) must be exactly mergePhrase(repo, n, head) — the words the
//        owner typed back in the chat — so a merge from chat names the commit he agreed to.
//
// The owner acts as principal `seen-command:owner` with owner authority (may override a claim). The
// builder acts as `seen-command-builder`. Neither name can be claimed through the brain MCP, where the
// identity is always the caller's authenticated credential.

import {
  listTickets, getTicket, claimTicket, updateTicket, ticketsSummary, isTicketId, reportFailure, KINDS,
} from '../brain/lib/tickets.mjs';
import { BUILDER, builderRepoFor, composeFixTask } from './ticket-sources.mjs';
import { redact as redactText } from './aggregation/store.mjs';
import { createGitHub, prStatus, mergePR, openPRs, parsePrUrl, allowedRepo } from './pr-merge.mjs';
import { config as appConfig } from './config.mjs';
import { brainVault, currentFacts as brainFacts, recordDevLog as brainDevLog } from './brain.mjs';
import { readBuild as readBuildFile } from './builds.mjs';
import { logActivity as ledger } from './activity.mjs';
import { deploymentForRef as vercelDeployment } from './connectors/vercel.mjs';

export const OWNER = 'seen-command:owner';
export const ASSISTANT = 'seen-command:assistant';

// The phrase the owner types back to merge from the chat: repo, number and the head commit he saw.
export const mergePhrase = (repo, number, headSha) => `merge ${repo}#${number} ${String(headSha || '').slice(0, 7)}`;

// Keep PR-backed tickets honest without anyone opening them: a ticket whose PR GitHub now calls ready is
// marked ready (so Home shows "ready to merge"), and one merged on GitHub directly is closed as merged.
// Read-only toward GitHub; at most `limit` PRs per call; errors leave the ticket as it was.
export async function refreshTicketPRs({ vault, gh, config, limit = 6, now = () => new Date() } = {}) {
  if (!vault || !gh) return { checked: 0 };
  const rows = listTickets(vault, { status: 'pr_open', limit: 50 }).filter((t) => parsePrUrl(t.prUrl)).slice(0, limit);
  let checked = 0;
  for (const row of rows) {
    const pr = parsePrUrl(row.prUrl);
    if (!allowedRepo(pr.repo, config)) continue;
    try {
      const st = await prStatus(gh, { repo: pr.repo, number: pr.number, config });
      checked += 1;
      const t = getTicket(vault, row.id, { now: now() });
      if (!t || t.status !== 'pr_open') continue;
      if (st.pr.merged) {
        updateTicket(vault, { id: t.id, by: 'seen-command', status: 'merged', prState: 'merged',
          merge: { repo: pr.repo, number: pr.number, url: st.pr.url, sha: st.pr.mergeSha, at: st.pr.mergedAt, by: 'github', method: 'outside Seen Command' },
          note: `Merged on GitHub (${String(st.pr.mergeSha || '').slice(0, 8)}).` }, { asOwner: true });
      } else if (st.pr.state !== 'open') {
        updateTicket(vault, { id: t.id, by: 'seen-command', prState: 'closed', note: 'Its PR was closed without merging — reopen the ticket or open a new PR.' }, { asOwner: true });
      } else {
        const want = st.canMerge ? 'ready' : st.checks === 'failing' ? 'checks_failing' : st.reasons.some((r) => /conflict/.test(r)) ? 'conflicting' : 'waiting';
        if (t.prState !== want) updateTicket(vault, { id: t.id, by: 'seen-command', prState: want }, { asOwner: true });
      }
    } catch { /* GitHub unreachable: keep what we knew */ }
  }
  return { checked };
}

// ticketsSummary() for the live app (Home's "Needs you", the assistant brief): the brain's counts after a
// short-cached PR refresh, so "PR ready to merge" is true when it is shown.
let refreshedAt = 0;
export async function liveTicketsSummary({ vault = brainVault, config = appConfig, gh = null, maxAgeMs = 120_000 } = {}) {
  const v = (() => { try { return typeof vault === 'function' ? vault() : vault; } catch { return null; } })();
  if (!v) return ticketsSummary(null);
  if (Date.now() - refreshedAt > maxAgeMs) {
    refreshedAt = Date.now();
    try {
      const client = gh || (config.githubToken() ? createGitHub({ token: config.githubToken() }) : null);
      if (client) await Promise.race([refreshTicketPRs({ vault: v, gh: client, config }), new Promise((r) => setTimeout(r, 8000).unref?.())]);
    } catch { /* the summary below still answers */ }
  }
  return ticketsSummary(v);
}

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve) => {
    let b = ''; let over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > max) { over = true; resolve({ __tooLarge: true }); req.destroy(); } });
    req.on('end', () => { if (over) return; if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch { resolve({ __invalid: true }); } });
    req.on('error', () => resolve({ __invalid: true }));
  });
}
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
export function loopbackRead(req) {
  if (!LOOPBACK.includes(String(req.socket?.remoteAddress || ''))) return false;
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(req.headers.host || ''));
}
export function loopbackWrite(req) {
  return loopbackRead(req) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(req.headers.origin || ''));
}

// What "Ask Claude to fix" would do for this ticket, decided in one place for the button label and the
// action itself: re-run the build that failed, start a fix build in a repo the builder knows, or — when
// neither fits — mark it ready for any AI on the brain.
export function fixPlan(t, { readBuild = () => null, config, canBuild = true } = {}) {
  if (!t) return { mode: 'none', why: 'no such ticket' };
  if (t.terminal) return { mode: 'none', why: `it is ${t.status}` };
  if (t.blocked) return { mode: 'none', why: 'it is blocked on you — retrying cannot fix it; clear the blocker first' };
  if (t.status === 'pr_open') return { mode: 'none', why: `a PR is already open (${t.prUrl}) — review or merge it` };
  if (t.claimant && t.claimant !== BUILDER && !t.claimExpired) return { mode: 'none', why: `${t.claimant} is already working on it` };
  if (canBuild && t.kind === 'build_failed') {
    const ref = t.evidence && t.evidence.ref ? String(t.evidence.ref).split('@')[0] : null;
    const b = ref ? readBuild(ref) : null;
    if (b && b.task && ['tool', 'product'].includes(b.repo)) return { mode: 'rebuild', buildId: b.id || ref, repo: b.repo, build: b };
  }
  const repo = builderRepoFor(t.repo, config);
  if (canBuild && repo) return { mode: 'builder', buildId: `ticket-${t.id}`, repo };
  return { mode: 'ready_for_ai', why: t.repo ? `the builder does not work on ${t.repo}` : 'it is not tied to a repository the builder works on' };
}

// The server's entry: the real modules behind every dependency. `startBuild` and `local` come from
// engine/server.mjs (its builder kick and its local-app gate).
export function serveTicketRoutes(req, res, path, { startBuild = null, local = loopbackWrite } = {}) {
  return handleTicketRoutes(req, res, path, {
    startBuild, local, vault: brainVault, config: appConfig,
    readBuild: (id) => { try { return readBuildFile(id); } catch { return null; } },
    deploymentForRef: vercelDeployment, currentFacts: brainFacts, recordDevLog: brainDevLog, logActivity: ledger,
  });
}

export async function handleTicketRoutes(req, res, path, deps = {}) {
  const {
    startBuild = null, local = loopbackWrite, vault, config, readBuild = () => null,
    github = () => createGitHub({ token: config.githubToken() }), deploymentForRef = async () => ({ configured: false }),
    currentFacts = () => [], recordDevLog = () => null, logActivity = () => null, now = () => new Date(),
  } = deps;
  const qs = new URL(req.url || '/', 'http://x').searchParams;
  if (!loopbackRead(req)) return send(res, 403, { error: 'Seen Command answers only on this Mac' });
  const write = () => { if (local(req)) return true; send(res, 403, { error: 'ticket and merge actions are allowed only from the local Seen Command app' }); return false; };
  const v = (() => { try { return vault(); } catch { return null; } })();
  const noVault = () => send(res, 503, { error: 'No brain vault is connected, so there are no tickets. Point CHRONOS_VAULT at the seen repo’s memory folder.' });

  try {
    // ---- tickets ----
    if (req.method === 'GET' && path === '/api/tickets') {
      if (!v) return send(res, 200, { vault: false, tickets: [], summary: ticketsSummary(null) });
      const tickets = listTickets(v, { status: qs.get('status') || 'active', repo: qs.get('repo'), kind: qs.get('kind'), limit: Number(qs.get('limit') || 200) });
      return send(res, 200, { vault: true, tickets, summary: ticketsSummary(v) });
    }
    if (req.method === 'GET' && path === '/api/tickets/summary') return send(res, 200, ticketsSummary(v));
    if (req.method === 'POST' && path === '/api/tickets') {
      if (!write()) return;
      if (!v) return noVault();
      const b = await readBody(req);
      if (b.__invalid || b.__tooLarge) return send(res, 400, { error: 'invalid request body' });
      const title = String(b.title || '').trim(); const error = String(b.error || '').trim();
      if (!title || !error) return send(res, 400, { error: 'a ticket needs a title and what went wrong' });
      const kind = KINDS[b.kind] ? b.kind : 'assistant_failed';
      const repo = b.repo ? String(b.repo) : (kind === 'assistant_failed' ? config.commandRepo() : null);
      if (repo && !allowedRepo(repo, config)) return send(res, 400, { error: `${repo} is not a repository Seen Command manages` });
      const tool = kind === 'assistant_failed' || (!!repo && repo.toLowerCase() === String(config.commandRepo()).toLowerCase());
      if (tool && !String(b.helped || '').trim()) return send(res, 400, { error: 'say what would have helped — the concrete ability or fix Seen Command lacked' });
      const thing = String(b.thing || `assistant: ${title}`).toLowerCase().replace(/[^a-z0-9 :#/._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      try {
        const r = reportFailure(v, { kind, repo, thing, tool, title: redactText(title), error: redactText(error), helped: b.helped ? redactText(b.helped) : null,
          blocked: !!b.blocked, ref: b.ref ? String(b.ref).slice(0, 120) : null, source: 'Board Room (act.mjs ticket-new)', by: ASSISTANT });
        try { logActivity({ kind: 'ticket', id: r.ticket.id, status: r.action, summary: `ticket ${r.action}: ${r.ticket.title}`.slice(0, 200) }); } catch { /* best-effort */ }
        return send(res, r.action === 'created' || r.action === 'regression' ? 201 : 200, { ok: true, action: r.action, ticket: r.ticket });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    const tm = /^\/api\/tickets\/(tkt-[0-9a-f]{10}(?:-r\d{1,3})?)(?:\/(fix|wont-fix|duplicate|note|open))?$/.exec(path);
    if (path.startsWith('/api/tickets/') && !tm) return send(res, 404, { error: 'no such ticket route' });
    if (tm) {
      if (!v) return noVault();
      const [, id, verb] = tm;
      const t = getTicket(v, id, { now: now() });
      if (!t) return send(res, 404, { error: `no ticket ${id}` });
      if (req.method === 'GET' && !verb) {
        const plan = fixPlan(t, { readBuild, config, canBuild: !!startBuild });
        return send(res, 200, { ticket: t, fix: { mode: plan.mode, why: plan.why || null, buildId: plan.buildId || null, repo: plan.repo || null }, pr: parsePrUrl(t.prUrl) });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!write()) return;
      const b = await readBody(req);
      if (b.__invalid || b.__tooLarge) return send(res, 400, { error: 'invalid request body' });
      const done = (r) => send(res, r.ok ? 200 : (r.code || 409), r.ok ? { ok: true, ticket: r.ticket, ...(r.extra || {}) } : { error: r.error });
      if (verb === 'note') {
        if (!String(b.text || '').trim()) return send(res, 400, { error: 'write the note first' });
        return done(updateTicket(v, { id, by: OWNER, note: b.text }, { asOwner: true }));
      }
      if (verb === 'wont-fix') return done(updateTicket(v, { id, by: OWNER, status: 'wont_fix', note: b.reason ? `Won't fix: ${b.reason}` : "Won't fix (owner)" }, { asOwner: true }));
      if (verb === 'duplicate') return done(updateTicket(v, { id, by: OWNER, status: 'duplicate', duplicateOf: b.of, note: b.reason || null }, { asOwner: true }));
      if (verb === 'open') return done(updateTicket(v, { id, by: OWNER, status: 'open', requested: null, note: b.reason || (t.terminal ? 'Reopened by the owner' : 'Claim released by the owner') }, { asOwner: true }));
      if (verb === 'fix') {
        const plan = fixPlan(t, { readBuild, config, canBuild: !!startBuild });
        if (plan.mode === 'none') return send(res, 409, { error: `Not now: ${plan.why}` });
        if (plan.mode === 'ready_for_ai') {
          const r = updateTicket(v, { id, by: OWNER, requested: 'ai', note: `The owner asked an AI to fix this (${plan.why}). Claim it with brain_claim_ticket.` }, { asOwner: true });
          return done({ ...r, extra: { mode: 'ready_for_ai', why: plan.why } });
        }
        const existing = readBuild(plan.buildId);
        if (existing && ['queued', 'building'].includes(existing.status)) return send(res, 200, { ok: true, mode: plan.mode, already: true, buildId: plan.buildId, ticket: t });
        const c = claimTicket(v, { id, by: BUILDER, now: now() });
        if (!c.ok) return send(res, c.code || 409, { error: c.error });
        const r = updateTicket(v, { id, by: BUILDER, status: 'in_progress', requested: 'builder', buildId: plan.buildId,
          note: `The owner asked Claude to fix it — ${plan.mode === 'rebuild' ? `re-running the build that failed (${plan.buildId})` : `fix build ${plan.buildId} on the ${plan.repo === 'tool' ? 'Seen Command' : 'Seen'} repo`}.` }, { asOwner: true });
        if (!r.ok) return send(res, r.code || 409, { error: r.error });
        try {
          if (plan.mode === 'rebuild') {
            const ob = plan.build;
            startBuild({ id: plan.buildId, key: ob.key || null, repo: ob.repo, task: ob.task, title: ob.title || ob.task, issueRepo: ob.issue && ob.issue.repo, issueNumber: ob.issue && ob.issue.number });
          } else {
            startBuild({ id: plan.buildId, key: plan.buildId, repo: plan.repo, task: composeFixTask(getTicket(v, id)), title: `Fix ${t.id}: ${t.title}`.slice(0, 120) });
          }
        } catch (e) {
          updateTicket(v, { id, by: BUILDER, status: 'open', requested: null, note: `Could not start the builder: ${e.message}` }, { asOwner: true });
          return send(res, 502, { error: `Could not start the builder: ${e.message}` });
        }
        try { logActivity({ kind: 'ticket', id, status: 'building', summary: `ticket ${id} sent to the builder (${plan.buildId}) — ${t.title}`.slice(0, 200) }); } catch { /* ledger is best-effort */ }
        return send(res, 200, { ok: true, mode: plan.mode, buildId: plan.buildId, ticket: getTicket(v, id) });
      }
      return send(res, 404, { error: 'no such ticket action' });
    }

    // ---- pull requests ----
    if (req.method === 'GET' && path === '/api/prs') return send(res, 200, { prs: await openPRs(github(), { config }) });
    const pm = /^\/api\/prs\/([\w.-]+)\/([\w.-]+)\/(\d+)(\/merge)?$/.exec(path);
    if (path.startsWith('/api/prs/') && !pm) return send(res, 404, { error: 'no such PR route' });
    if (pm) {
      const repo = `${pm[1]}/${pm[2]}`; const number = Number(pm[3]);
      if (!allowedRepo(repo, config)) return send(res, 403, { error: `${repo} is not a repository Seen Command manages` });
      const linked = v ? listTickets(v, { status: 'all', limit: 500 }).filter((t) => t.prUrl && parsePrUrl(t.prUrl)
        && parsePrUrl(t.prUrl).repo.toLowerCase() === repo.toLowerCase() && parsePrUrl(t.prUrl).number === number).map((t) => t.id) : [];
      if (req.method === 'GET' && !pm[4]) {
        const st = await prStatus(github(), { repo, number, config });
        let deploy = null;
        if (st.pr.merged && repo.toLowerCase() === String(config.githubRepo()).toLowerCase()) deploy = await deployInfo({ deploymentForRef, currentFacts, base: st.pr.base, sha: st.pr.mergeSha });
        if (v && st.canMerge) for (const id of linked) { const t = getTicket(v, id); if (t && t.status === 'pr_open' && t.prState !== 'ready') updateTicket(v, { id, by: OWNER, prState: 'ready' }, { asOwner: true }); }
        return send(res, 200, { ...st, deploy, tickets: linked });
      }
      if (req.method === 'POST' && pm[4]) {
        if (!write()) return;
        const b = await readBody(req);
        if (b.__invalid || b.__tooLarge) return send(res, 400, { error: 'invalid request body' });
        if (b.confirm !== true) return send(res, 400, { error: 'confirm the merge first' });
        if (b.confirmText !== undefined && String(b.confirmText).trim() !== mergePhrase(repo, number, b.expectedHeadSha)) {
          return send(res, 400, { error: `the confirmation must be exactly "${mergePhrase(repo, number, b.expectedHeadSha)}"` });
        }
        const r = await mergePR(github(), { repo, number, expectedHeadSha: b.expectedHeadSha, config });
        const ids = [...new Set([...linked, ...(isTicketId(b.ticketId) ? [b.ticketId] : [])])];
        if (!r.ok) {
          if (v) for (const id of ids) updateTicket(v, { id, by: OWNER, note: `Merge refused: ${r.error.replace(/^Not merging: /, '')}` }, { asOwner: true });
          return send(res, r.code || 409, { error: r.error, status: r.status || null });
        }
        const at = now().toISOString();
        const result = { repo, number, url: r.status.pr.url, sha: r.sha, at, by: OWNER, method: 'squash' };
        if (v) {
          for (const id of ids) {
            const t = getTicket(v, id);
            if (!t || t.terminal) continue;
            if (t.status !== 'pr_open') updateTicket(v, { id, by: OWNER, status: 'pr_open', prUrl: r.status.pr.url }, { asOwner: true });
            updateTicket(v, { id, by: OWNER, status: 'merged', merge: result, prState: 'merged', note: `Squash-merged from Seen Command as ${String(r.sha || '').slice(0, 8)}.` }, { asOwner: true });
          }
        }
        try {
          recordDevLog({ heading: 'Merged from Seen Command', key: `merge:${repo}#${number}:${r.sha}`,
            text: `${repo}#${number} "${r.status.pr.title}" squash-merged by the owner from Seen Command → ${String(r.sha || '').slice(0, 8)}${ids.length ? ` · tickets ${ids.join(', ')}` : ''} (merge:${repo}#${number}:${r.sha})` });
        } catch { /* the ticket and GitHub already hold it */ }
        try { logActivity({ kind: 'merge', id: `${repo}#${number}`, status: 'merged', summary: `merged ${repo}#${number} from Seen Command — ${r.status.pr.title}`.slice(0, 200) }); } catch { /* ignore */ }
        const deploy = repo.toLowerCase() === String(config.githubRepo()).toLowerCase()
          ? { pending: true, note: `Seen deploys ${r.status.pr.base} on Vercel. Open this PR again in a few minutes to see the production deploy for ${String(r.sha || '').slice(0, 7)}; if none appears, the merge did not deploy.` } : null;
        return send(res, 200, { ok: true, merged: true, sha: r.sha, result, tickets: ids, deploy });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
  }
}

// After a product merge: is the merged commit what production serves? Uses the existing Vercel connector
// and the deploy-drift monitor's brain fact; never a new deploy system.
async function deployInfo({ deploymentForRef, currentFacts, base, sha }) {
  let deployment = null;
  try { deployment = await deploymentForRef({ ref: base, sha }); } catch (e) { deployment = { error: e.message }; }
  let drift = null;
  try { const f = (currentFacts() || []).find((x) => x.subject === 'Seen production deploy' && x.predicate === 'merge_vs_deploy'); drift = f ? String(f.object) : null; } catch { /* optional */ }
  return { deployment, drift, sha: sha ? String(sha).slice(0, 7) : null };
}

