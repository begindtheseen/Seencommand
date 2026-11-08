#!/usr/bin/env node
// The Board Room assistant's hands: one command per thing Seen Command can do, run against the live app
// (the same routes the buttons use, so a chat action and a click are the same action). The assistant runs
// these in its chat turn; you can too, from Terminal in this folder.
//
// PARITY: every button in Seen Command has a verb here (docs/ACT_PARITY.md is the route → verb table;
// scripts/act-parity.test.mjs fails when a UI write route has none). `node scripts/act.mjs help` prints every
// verb with its arguments — that list lives in lib/act-catalog.mjs, which the chat prompt is built from too.
//
//   Orient + remember   brief · recall · note · fact · ask · vault · home · notifications · notifications-read ·
//                       notifications-clear · skills · help
//   Decisions           meeting · approve · deny (only when Brandon says) · simulate · simulation · simulations
//   Code changes        build <seen|command> <what…> (files a task + starts the test-gated builder → draft PR) ·
//                       tasks · task-build · task-delete · builds · build-status · prs · merge-pr (Brandon's
//                       exact phrase only) · terminal
//   Tickets             tickets · ticket · ticket-new · ticket-fix · ticket-note · ticket-wontfix · ticket-dup ·
//                       ticket-reopen
//   Searches + listings search · search-run · search-plan · preset · presets · searches · search-status · jobs ·
//                       job · job-edit · job-remove · job-restore
//   Pipelines           pipelines · pipeline-health · pipeline-runs · pipeline-run · pipeline-start ·
//                       pipeline-cancel · pipeline-config · pipeline-schedules · pipeline-schedule · boards-pull ·
//                       company-jobs
//   Data health         data-health · clean · data-health-history · data-health-auto · lookalike-ok
//   Money               money · scale · costs · cost-set · cost-remove · cash · allocate · allocate-set ·
//                       allocate-reset · channel-set · readiness · money-plan · scenario · units
//   Growth Studio       growth · growth-plan · growth-replan · daily · calendar · calendar-item · calendar-status ·
//                       calendar-results · draft · approve-copy · ad · brand · brand-set · positioning ·
//                       growth-assets · growth-data · growth-library
//   Creator Library     creators · creator · creator-insights · creator-search · creator-unresolved ·
//                       creator-resolve · research · creator-status · creator-resume · creator-doctor · discover ·
//                       discovery · queue-research · prune · restore-creators · creator-cleanup · purge-archived ·
//                       creator-delete (typed confirmations — only on Brandon's words)
//   Seen Command        diagnostics · base-health · credentials · secret-set · secret-clear · cline-setup ·
//                       cline-signin · cline-test · fix-agents · ai-usage · workflows · workflow-cancel ·
//                       update-status · update-check · update · brain-status · brain-health · brain-activity ·
//                       brain-overnight · brain-refresh · brain-sources · brain-access · brain-renew · brain-revoke
//
// Never a credential VALUE: no verb prints a token or key (secret-set takes one from Brandon and answers with
// configured / not configured only), and every answer passes through noSecrets() as a last line of defence.
//
import { ACT_GROUPS } from '../lib/act-catalog.mjs';

// Output: one JSON object (trimmed). Exit 1 with { error } when the app refused or is not running.
const BASE = (process.env.SEEN_COMMAND_URL || `http://127.0.0.1:${process.env.SEEN_COMMAND_PORT || 4173}`).replace(/\/+$/, '');
const [verb, ...rest] = process.argv.slice(2);
const text = rest.join(' ').trim();

async function call(method, path, body, { timeoutMs } = {}) {
  let r;
  try { r = await fetch(`${BASE}${path}`, { method, headers: { origin: BASE, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs || (method === 'POST' && path === '/api/board-meeting' ? 15 * 60_000 : 120_000)) }); }
  catch (e) { throw new Error(`Seen Command is not answering at ${BASE} (${e.cause?.code || e.message}) — is the app running?`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const kv = (list) => Object.fromEntries(list.map((x) => { const i = x.indexOf('='); return i > 0 ? [x.slice(0, i), x.slice(i + 1)] : null; }).filter(Boolean));
const parseVal = (v) => (v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : v);
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const CLEAN_KINDS = ['job_dupes', 'stale', 'report_dupes', 'company_suffix_dupes', 'all'];
const POLL_MS = Number(process.env.ACT_POLL_MS || 3000);
const PIPELINES = ['company_intel', 'indeed', 'career_site', 'applicant_reports', 'web_reports'];
// "true" → true, "12" → 12, "[1,2]" → [1, 2]; anything else stays the text it was.
const jsonish = (v) => { if (v === '') return ''; try { return JSON.parse(v); } catch { return v; } };
// { 'colors.primary': '#111' } → { colors: { primary: '#111' } }
const nested = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) { const p = k.split('.'); let c = out; p.slice(0, -1).forEach((x) => { c = c[x] = c[x] && typeof c[x] === 'object' ? c[x] : {}; }); c[p.at(-1)] = v; } return out; };
// "Home Depot; Acme | acme.example" → ['Home Depot', 'Acme | acme.example'] (names have spaces, so ; separates)
const items = (t) => String(t || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
const buildRow = (b) => ({ id: b.id, title: b.title, repo: b.repo, status: b.status, started: b.startedAt, ended: b.endedAt, summary: b.summary, pr: b.pr, error: b.error || undefined, issue: b.issue || undefined });
const configuredOf = (status, key) => !!(status.groups || []).flatMap((g) => g.fields || []).find((f) => f.key === key)?.configured;
// A Creator Library account → its project folder name (accepts @user, user, or the project name itself).
async function projectOf(arg) {
  const a = String(arg || '').replace(/^@/, '').toLowerCase();
  const { creators = [] } = await call('GET', '/api/instagram/creators');
  const hit = creators.find((c) => String(c.project).toLowerCase() === a || String(c.handle).replace(/^@/, '').toLowerCase() === a);
  need(hit, `@${a} is not in the Creator Library (creators lists them)`);
  return hit.project;
}
async function igJobOf(arg) {
  if (/^instagram-.+-\d{14}$/.test(arg)) return arg;
  const u = String(arg).replace(/^@/, '').toLowerCase(); const { jobs = [] } = await call('GET', '/api/instagram/jobs');
  const j = jobs.find((x) => String(x.username || '').toLowerCase() === u || String(x.project || '').toLowerCase() === u);
  need(j, `no research job for @${u}`);
  return j.id;
}
// Last line of defence: no answer carries a credential. Secret-shaped keys are dropped wherever they are,
// and any value Brandon handed a verb in this run (secret-set, cline-setup) is masked if it came back.
const secretsGiven = [];
const SECRET_KEY = /^(secret|secrets|token|access_?token|refresh_?token|api_?key|apikey|password|passphrase|private_?key|client_?secret|copy_?id)$/i;
function noSecrets(v) {
  if (Array.isArray(v)) return v.map(noSecrets);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, noSecrets(x)]));
  return v;
}
// The scan, trimmed to what a reply needs: one line per check (+ a few examples).
const dhBrief = (d) => (d.sections ? { headline: d.headline, checked: d.when, toClean: d.toClean,
  checks: Object.fromEntries(Object.entries(d.sections).map(([k, v]) => [k, { count: v.ok ? v.count : null, line: v.line,
    ...(k === 'company_dupes' && v.ok ? { lookalikesWaiting: v.lookalikesWaiting, lookalikes: (v.lookalikeList || []).slice(0, 8).map((g) => g.companies.map((c) => c.name).join(' · ')) } : {}),
    ...(k === 'job_dupes' && v.ok ? { examples: (v.sample || []).slice(0, 3).map((g) => `${g.keep?.title} · ${g.keep?.company} — ${(g.remove || []).length + 1} copies`) } : {}) }])),
  lastCleanup: d.run ? { status: d.run.running ? 'running' : d.run.status, when: d.run.when, summary: d.run.summary } : null,
  automatic: d.auto } : d);

const VERBS = {
  brief: () => call('GET', '/api/assistant/brief'),
  recall: () => { need(text, 'recall what? e.g. recall pricing'); return call('GET', `/api/assistant/recall?q=${encodeURIComponent(text)}`); },
  note: () => { const [kind, topic, ...t] = rest; need(kind && topic && t.length, 'note <vision|preference|decision|concern> <topic> <text…>'); return call('POST', '/api/assistant/note', { kind, topic, text: t.join(' ') }); },
  fact: () => { const [subject, predicate, object] = text.split('|').map((s) => s.trim()); need(subject && predicate && object, 'fact <subject> | <predicate> | <object>'); return call('POST', '/api/assistant/note', { subject, predicate, object }); },
  meeting: () => call('POST', '/api/board-meeting'),
  approve: () => { need(rest[0], 'approve <id>'); return call('POST', '/api/approve', { id: rest[0], decision: 'approve' }); },
  deny: () => { need(rest[0], 'deny <id>'); return call('POST', '/api/approve', { id: rest[0], decision: 'deny' }); },
  search: () => { need(text, 'search what? e.g. search acme technicians'); return call('POST', '/api/search', { plan: true, message: text }); },
  preset: () => { need(rest[0], 'preset <key>'); return call('POST', '/api/search', { preset: rest[0] }); },
  searches: async () => { const j = await call('GET', '/api/search?limit=10'); return { searches: (j.searches || []).map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: s.status, at: s.at, steps: (s.steps || []).map((x) => `${x.label}: ${x.status}${x.error ? ` (${x.error})` : ''}`) })) }; },
  jobs: async () => { const q = new URLSearchParams({ limit: '20', ...kv(rest) }); const j = await call('GET', `/api/jobs?${q}`); return { total: j.total, jobs: (j.jobs || []).map((x) => ({ id: x.id, title: x.title, company: x.company, location: x.location, source: x.source, added: x.created_at, on_site: x.expires_at ? new Date(x.expires_at) > new Date() : false })), more: !!j.next }; },
  job: async () => { need(rest[0], 'job <id>'); const j = await call('GET', `/api/jobs/${encodeURIComponent(rest[0])}`); if (j.job?.description) j.job.description = String(j.job.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500); return j; },
  'job-edit': () => { need(rest[0] && rest.length > 1, 'job-edit <id> field=value…'); const patch = Object.fromEntries(Object.entries(kv(rest.slice(1))).map(([k, v]) => [k, parseVal(v)])); return call('POST', `/api/jobs/${encodeURIComponent(rest[0])}`, { patch }); },
  'job-remove': () => { need(rest[0], 'job-remove <id>'); return call('POST', `/api/jobs/${encodeURIComponent(rest[0])}/remove`); },
  'job-restore': () => { need(rest[0], 'job-restore <id>'); return call('POST', `/api/jobs/${encodeURIComponent(rest[0])}/restore`); },
  terminal: () => { const [repo, ...p] = rest; need(repo === 'seen' || repo === 'command', 'terminal <seen|command> [first message…]'); return call('POST', '/api/terminal/claude', { repo, prompt: p.join(' ') }); },
  skills: () => call('GET', '/api/assistant/skills'),
  simulate: () => { need(text, 'simulate <approval id | the decision in words>'); const looksId = /^[\w.:-]+-a\d+$/.test(rest[0] || '') && rest.length === 1; return call('POST', '/api/simulate', looksId ? { approvalId: rest[0] } : { question: text }); },
  simulation: () => { need(rest[0], 'simulation <id>'); return call('GET', `/api/simulate/${encodeURIComponent(rest[0])}`); },
  'data-health': async () => dhBrief(await call('GET', `/api/data-health${rest[0] === 'refresh' ? '?refresh=1' : ''}`)),
  clean: async () => {
    need(CLEAN_KINDS.includes(rest[0]), `clean <${CLEAN_KINDS.join('|')}>`);
    let { run } = await call('POST', '/api/data-health/clean', { kind: rest[0] });
    const until = Date.now() + 25 * 60_000; // "all" is four kinds of at most ~4 minutes each
    while (run && run.running && Date.now() < until) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      ({ run } = await call('GET', '/api/data-health/run'));
    }
    return { status: run?.running ? 'still running (check later with data-health)' : run?.status, summary: run?.summary,
      steps: (run?.steps || []).map((x) => ({ what: x.label, done: x.done, left: x.left, status: x.status, error: x.error || undefined })) };
  },
  creators: () => call('GET', '/api/instagram/creators'),
  creator: async () => {
    need(rest[0], 'creator <user>');
    const j = await call('GET', `/api/instagram/creators/${encodeURIComponent(rest[0].replace(/^@/, ''))}`);
    const cite = (c) => (c ? `${c.handle}${c.at ? ` ${c.at}` : ''}${c.url ? ` ${c.url}` : ''}${c.excerpt ? ` "${String(c.excerpt).slice(0, 100)}"` : ''}` : null);
    return { ...j, keyPoints: (j.keyPoints || []).slice(0, 15).map((i) => ({ type: i.type, basis: i.basis, strength: i.strength, claim: i.claim, videos: i.support?.videos, creators: i.support?.creators, alsoBy: i.alsoBy, latest: i.recency?.lastPT, cite: cite(i.own || i.citations?.[0]) })) };
  },
  research: () => { need(rest[0], 'research <user> [count]'); return call('POST', '/api/instagram/research', { username: rest[0].replace(/^@/, ''), limit: rest[1] ? Number(rest[1]) : undefined, source: 'board room' }); },
  discover: () => { need(text, 'discover <goal>, e.g. discover career coaches whose audience gets ghosted by staffing agencies'); return call('POST', '/api/instagram/discover', { goal: text, waitMs: 100000 }); },
  discovery: () => (rest[0] ? call('GET', `/api/instagram/discover/${encodeURIComponent(rest[0])}`) : call('GET', '/api/instagram/discover')),
  'queue-research': () => { need(rest[0] && rest[1], 'queue-research <discovery id> <user…>'); return call('POST', `/api/instagram/discover/${encodeURIComponent(rest[0])}/queue`, { handles: rest.slice(1) }); },
  'creator-insights': async () => {
    const o = kv(rest); const rank = ['anecdotal', 'emerging', 'moderate', 'strong']; const min = rank.indexOf(o.min || 'moderate');
    const j = await call('GET', '/api/instagram/insights');
    const keep = (j.insights || []).filter((i) => (!o.type || i.type === o.type) && rank.indexOf(i.strength) >= min).slice(0, 25);
    return { totals: j.totals, lastMeeting: j.lastMeeting, pruned: j.prunedSummary ? { total: j.prunedSummary.total, byFamily: j.prunedSummary.byFamily } : null, caveat: j.caveat,
      insights: keep.map((i) => ({ id: i.id, type: i.type, basis: i.basis, strength: i.strength, claim: i.claim, support: `${i.support.creators} creators / ${i.support.videos} videos`, handles: i.support.handles, latest: i.recency?.lastPT, engagement: i.engagement, citations: (i.citations || []).map((c) => `${c.handle}${c.at ? ` ${c.at}` : ''}${c.url ? ` ${c.url}` : ''}${c.excerpt ? ` "${String(c.excerpt).slice(0, 100)}"` : ''}`) })) };
  },
  prune: () => (rest[0] === 'plan' ? call('GET', '/api/instagram/prune') : call('POST', '/api/instagram/prune')),
  'restore-creators': () => call('POST', '/api/instagram/prune/restore', rest[0] && rest[0] !== 'all' ? { project: rest[0].startsWith('instagram-') ? rest[0] : `instagram-${rest[0].replace(/^@/, '').toLowerCase()}` } : { all: true }),
  'purge-archived': () => { need(text, 'purge-archived PURGE ARCHIVED — only when Brandon said so'); return call('POST', '/api/instagram/purge-archived', { confirm: text }); },
  'creator-status': async () => {
    need(rest[0], 'creator-status <job id | user>');
    if (/^instagram-.+-\d{14}$/.test(rest[0])) return call('GET', `/api/instagram/jobs/${encodeURIComponent(rest[0])}`);
    const u = rest[0].replace(/^@/, '').toLowerCase(); const { jobs = [] } = await call('GET', '/api/instagram/jobs');
    const j = jobs.find((x) => String(x.username || '').toLowerCase() === u);
    if (!j) { const { queue = [] } = await call('GET', '/api/instagram/queue'); const q = queue.find((x) => x.username.toLowerCase() === u); return q ? { queued: true, position: queue.indexOf(q) + 1, entry: q } : { error: `no research job for @${u}` }; }
    const full = await call('GET', `/api/instagram/jobs/${encodeURIComponent(j.id)}`);
    return { ...full, log: (full.log || []).slice(-12) };
  },
  money: async () => { const p = await call('GET', '/api/money'); const l = p.ledger; return { at: p.atPT, model: l.model, users: l.users, paying: l.paying, buyerShare: l.buyerShare, revenue: l.revenue, purchases: l.purchases, takeRate: l.funnel?.takeRate || null, implied: l.funnel?.implied || null, legacy: l.legacy, costs: { total: l.costs.total, recurring: l.costs.recurring, aiOps: l.costs.aiOps, fees: l.costs.fees, missing: l.costs.missing }, grossMargin: l.grossMargin, net: l.net, burn: l.burn, runway: l.runway, trace: l.trace, notes: l.notes, unavailable: l.unavailable, allocation: p.allocation.headline, rule: p.rule }; },
  scale: async () => { const s = await call('GET', '/api/money/scale'); return { at: s.atPT, plan: s.plan, counts: s.counts, items: s.items.map((i) => ({ status: i.status, title: i.title, reading: i.reading, limit: i.limit, eta: i.etaText, fixCost: i.fixCost, action: i.action })), readiness: s.readiness.map((r) => ({ users: r.milestone, title: r.title, state: r.state, due: r.due, evidence: r.evidence })) }; },
  costs: () => call('GET', '/api/money/costs'),
  'cost-set': () => { const [name, monthly, ...n] = rest; need(name && monthly != null, 'cost-set <name> <monthly $> [note…]  (quote a name with spaces)'); return call('POST', '/api/money/costs', { name, monthly, ...(n.length ? { note: n.join(' ') } : {}) }); },
  allocate: () => call('GET', '/api/money/allocate'),
  units: () => call('GET', '/api/money/units'),
  tickets: async () => {
    const j = await call('GET', `/api/tickets?${new URLSearchParams({ limit: '25', ...kv(rest) })}`);
    return { summary: j.summary, tickets: (j.tickets || []).map((t) => ({ id: t.id, title: t.title, status: t.status, kind: t.kind, repo: t.repo, seenCommand: !!t.tool, count: t.count, last: t.lastSeen, blocked: t.blocked, claimant: t.claimant, pr: t.prUrl, prState: t.prState, error: t.lastError, helped: t.helped })) };
  },
  ticket: async () => {
    need(rest[0], 'ticket <id>');
    const j = await call('GET', `/api/tickets/${encodeURIComponent(rest[0])}`);
    const t = j.ticket || {};
    return { ticket: { ...t, occurrences: (t.occurrences || []).slice(-5), history: (t.history || []).slice(-12) }, fix: j.fix };
  },
  'ticket-new': () => {
    // Pipe-separated, or exactly three quoted arguments.
    const [title, error, helped] = (text.includes('|') ? text.split('|') : rest.length === 3 ? rest : []).map((x) => String(x).trim());
    need(title && error && helped, 'ticket-new <title> | <what went wrong> | <what would have helped>');
    return call('POST', '/api/tickets', { title, error, helped, kind: 'assistant_failed' });
  },
  'merge-pr': async () => {
    const [repo, number] = rest;
    need(/^[\w.-]+\/[\w.-]+$/.test(repo || '') && /^\d+$/.test(number || ''), 'merge-pr <owner/repo> <number> [confirm="<phrase>"]');
    const [owner, name] = repo.split('/');
    const path = `/api/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`;
    const st = await call('GET', path);
    const pr = st.pr || {};
    const phrase = `merge ${repo}#${number} ${String(pr.headSha || '').slice(0, 7)}`;
    const brief = { pr: { title: pr.title, url: pr.url, base: pr.base, head: pr.head, headSha: pr.headSha, state: pr.state, merged: pr.merged }, canMerge: !!st.canMerge, reasons: st.reasons || [], checks: st.checks, tickets: st.tickets || [], deploy: st.deploy || null };
    const cm = /^confirm=([\s\S]*)$/.exec(rest.slice(2).join(' ').trim()); // the phrase has spaces: take the rest of the line
    const confirm = cm ? cm[1].trim().replace(/^["']|["']$/g, '') : undefined;
    if (confirm === undefined) return { ...brief, merged: false, confirmPhrase: st.canMerge ? phrase : null, next: st.canMerge ? `Ask Brandon to reply with exactly: ${phrase}` : 'Not mergeable — tell Brandon why (reasons).' };
    need(st.canMerge, `not mergeable: ${(st.reasons || []).join('; ')}`);
    need(String(confirm).trim() === phrase, `the confirmation must be exactly "${phrase}" — the PR may have changed since it was shown`);
    const r = await call('POST', `${path}/merge`, { confirm: true, confirmText: phrase, expectedHeadSha: pr.headSha });
    return { ...brief, merged: !!r.merged, sha: r.sha, tickets: r.tickets, deploy: r.deploy };
  },
  growth: async () => { const j = await call('GET', '/api/growth/overview'); const c = j.check || {}; return { today: j.today, week: c.week, phase: c.phase?.name, target: c.target, actuals: c.actuals, status: c.status, overall: c.overall, changes: c.changes, nextGates: (c.gates || []).filter((g) => g.state !== 'hit').slice(0, 4).map((g) => ({ id: g.id, name: g.name, date: g.date, state: g.state, number: g.number })), daily: { title: j.daily?.item?.title, lane: j.daily?.item?.laneName, status: j.daily?.item?.status, streak: j.daily?.streak }, calendar: (j.calendar?.days || []).flatMap((d) => d.items.map((i) => ({ id: i.id, date: i.date, time: i.time, channel: i.channel, format: i.format, status: i.status, owner: i.owner, hook: i.hook }))), statsError: j.statsError }; },
  daily: () => { if (rest[0] === 'done' || rest[0] === 'skip') return call('POST', '/api/growth/daily', { status: rest[0] === 'skip' ? 'skipped' : 'done', note: rest.slice(1).join(' ') }); return call('GET', '/api/growth/daily'); },
  calendar: async () => { if (rest[0] === 'generate') return call('POST', '/api/growth/calendar/generate', { weeks: Number(rest[1]) || 6 }); const j = await call('GET', `/api/growth/calendar${rest[0] ? `?week=${encodeURIComponent(rest[0])}` : ''}`); return { weekStart: j.weekStart, week: j.week, violations: j.violations, days: j.days.map((d) => ({ date: d.date, daily: d.daily, items: d.items.map((i) => ({ id: i.id, time: i.time, channel: i.channel, format: i.format, pillar: i.pillar, status: i.status, owner: i.owner, hook: i.hook, goal: i.goal, rule: i.rule })) })) }; },
  draft: async () => { need(rest[0], 'draft <calendar item id> (ids: node scripts/act.mjs calendar)'); const j = await call('POST', `/api/growth/copy/${encodeURIComponent(rest[0])}/draft`); return { item: rest[0], engine: j.engine, variants: (j.variants || []).map((v, i) => ({ variant: i, style: v.style, title: v.title, body: v.body, parts: v.parts, why: v.why, trustOk: v.trust?.ok, flags: (v.trust?.flags || []).map((f) => `${f.id}: ${f.text}`), formatProblems: v.formatProblems })) }; },
  'approve-copy': () => { need(rest[0] && rest[1] != null, 'approve-copy <item id> <variant 0-2>'); return call('POST', `/api/growth/copy/${encodeURIComponent(rest[0])}/approve`, { variant: Number(rest[1]) }); },
  brand: async () => { const j = await call('GET', '/api/growth/brand'); return { version: j.version, savedAt: j.savedAt, kit: j.kit, liveProof: j.liveProof, versions: (j.history || []).length }; },
  positioning: () => call('GET', '/api/growth/positioning'),
  ad: async () => { if (!rest[0]) { const j = await call('GET', '/api/growth/ads'); return { note: j.note, readiness: j.readiness, tranches: j.tranches, targetCpa: j.targetCpa, killScale: j.killScale, simulate: j.simulate, channels: j.channels.map((c) => ({ id: c.id, name: c.name, when: c.when })) }; } const t = await call('GET', `/api/growth/templates/${encodeURIComponent(rest[0])}`).catch(() => null); if (t && t.template) return t; const j = await call('POST', `/api/growth/copy/${encodeURIComponent(rest[0])}/draft`, { format: 'ad' }); return { item: rest[0], variants: (j.variants || []).map((v, i) => ({ variant: i, style: v.style, ...v.parts, trustOk: v.trust?.ok, formatProblems: v.formatProblems })), next: 'render it: Growth tab → Ad designer, pick the item' }; },

  // ---- orient + remember ------------------------------------------------------------------------
  help: () => ({ groups: ACT_GROUPS.map((g) => ({ group: g.title, verbs: g.verbs.map(([n, a, w]) => `${n}${a ? ` ${a}` : ''} — ${w}`) })) }),
  ask: () => { need(text, 'ask <question>'); return call('POST', '/api/ask', { question: text }); },
  vault: async () => { const j = await call('GET', '/api/vault'); return { facts: (j.facts || []).length, vaultFound: j.vaultFound, decisions: (j.decisions || []).slice(0, 15), timeline: (j.timeline || []).slice(0, 7).map((d) => ({ date: d.date, entries: (d.entries || []).slice(0, 8).map((e) => `${e.heading ? `${e.heading}: ` : ''}${String(e.text || '').slice(0, 240)}`) })), health: j.health }; },
  home: () => call('GET', `/api/home${rest[0] === 'refresh' ? '?refresh=1' : ''}`),
  notifications: async () => { const o = kv(rest); const q = new URLSearchParams({ limit: o.limit || '30', ...(rest.includes('unread') ? { unread: '1' } : {}) }); const j = await call('GET', `/api/notifications?${q}`); return { unread: j.unread, items: (j.items || j.notifications || []).map((n) => ({ id: n.id, at: n.at, level: n.level, kind: n.kind, title: n.title, body: n.body, read: n.read, tab: n.tab })) }; },
  'notifications-read': () => call('POST', '/api/notifications/read', { ids: !rest.length || rest[0] === 'all' ? 'all' : rest.map(Number).filter(Number.isFinite) }),
  'notifications-clear': () => call('POST', '/api/notifications/clear'),
  simulations: async () => { const j = await call('GET', '/api/simulate'); return { running: j.running, queued: j.queued, simulations: (j.simulations || []).slice(0, 15).map((s) => ({ id: s.id, status: s.status, question: s.question, approvalId: s.approvalId, call: s.result?.verdict || null, at: s.endedAt || s.startedAt || s.queuedAt })) }; },

  // ---- code changes: tasks → the test-gated builder → a draft PR -----------------------------------
  build: () => {
    const [repo, ...w] = rest; const task = w.join(' ').trim();
    need(['seen', 'command', 'product', 'tool'].includes(repo) && task, 'build <seen|command> <what to change, in plain words>  (seen = seenjobs.io, command = Seen Command)');
    return call('POST', '/api/tasks/new', { repo, task });
  },
  tasks: async () => { const j = await call('GET', '/api/tasks'); return { repo: j.repo, tasks: (j.tasks || []).map((t) => ({ number: t.number, title: t.title, url: t.url, labels: t.labels, created: t.createdAt || t.created_at })) }; },
  'task-build': () => { need(/^\d+$/.test(rest[0] || ''), 'task-build <task number> [repo=product|tool]'); const o = kv(rest.slice(1)); return call('POST', '/api/tasks/build', { number: Number(rest[0]), ...(o.repo ? { repo: o.repo } : {}) }); },
  'task-delete': () => { need(/^\d+$/.test(rest[0] || '') && rest.length > 1, 'task-delete <task number> <reason…>'); return call('POST', '/api/tasks/delete', { number: Number(rest[0]), reason: rest.slice(1).join(' ') }); },
  builds: async () => { const o = kv(rest); const j = await call('GET', '/api/builds'); return { builds: (j.builds || []).slice(0, Number(o.limit) || 15).map(buildRow) }; },
  'build-status': async () => {
    need(rest[0], 'build-status <build id | task number>');
    const id = /^\d+$/.test(rest[0]) ? `task-${rest[0]}` : rest[0];
    const b = ((await call('GET', '/api/builds')).builds || []).find((x) => x.id === id);
    need(b, `no build ${id} (builds lists them)`);
    return { ...buildRow(b), task: String(b.task || '').slice(0, 600), log: (b.log || []).slice(-25) };
  },
  prs: async () => { const j = await call('GET', '/api/prs'); return { prs: (j.prs || []).map((p) => ({ repo: p.repo, number: p.number, title: p.title, url: p.url, draft: p.draft, base: p.base, head: p.head, author: p.author, updated: p.updatedAt, error: p.error || undefined })) }; },

  // ---- tickets (the drawer's buttons) -------------------------------------------------------------
  'ticket-fix': () => { need(rest[0], 'ticket-fix <id>'); return call('POST', `/api/tickets/${encodeURIComponent(rest[0])}/fix`, {}); },
  'ticket-note': () => { need(rest[0] && rest.length > 1, 'ticket-note <id> <text…>'); return call('POST', `/api/tickets/${encodeURIComponent(rest[0])}/note`, { text: rest.slice(1).join(' ') }); },
  'ticket-wontfix': () => { need(rest[0] && rest.length > 1, "ticket-wontfix <id> <reason…>"); return call('POST', `/api/tickets/${encodeURIComponent(rest[0])}/wont-fix`, { reason: rest.slice(1).join(' ') }); },
  'ticket-dup': () => { need(rest[0] && rest[1], 'ticket-dup <id> <of id>'); return call('POST', `/api/tickets/${encodeURIComponent(rest[0])}/duplicate`, { of: rest[1], ...(rest.length > 2 ? { reason: rest.slice(2).join(' ') } : {}) }); },
  'ticket-reopen': () => { need(rest[0], 'ticket-reopen <id> [reason…]'); return call('POST', `/api/tickets/${encodeURIComponent(rest[0])}/open`, rest.length > 1 ? { reason: rest.slice(1).join(' ') } : {}); },

  // ---- the search box, exactly as the buttons send it ----------------------------------------------
  'search-run': () => { const o = kv(rest); need(o.text || o.keywords || o.url, 'search-run text=… [keywords=…] [url=…] [methods=a,b]  (or: search <request in plain words>)'); return call('POST', '/api/search', { text: o.text, keywords: o.keywords, url: o.url, ...(o.methods ? { methods: o.methods.split(',').map((s) => s.trim()).filter(Boolean) } : {}) }); },
  'search-plan': () => { need(text, 'search-plan <text>'); return call('GET', `/api/search/plan?text=${encodeURIComponent(text)}`); },
  presets: () => call('GET', '/api/search/presets'),
  'search-status': () => { need(rest[0], 'search-status <id>'); return call('GET', `/api/search/${encodeURIComponent(rest[0])}`); },

  // ---- collection pipelines (Search → Advanced) ----------------------------------------------------
  pipelines: () => call('GET', '/api/aggregation/status'),
  'pipeline-health': () => call('GET', `/api/aggregation/health${rest[0] === 'refresh' ? '?refresh=1' : ''}`),
  'pipeline-runs': async () => { const q = new URLSearchParams(kv(rest)); const j = await call('GET', `/api/aggregation/runs${String(q) ? `?${q}` : ''}`); return { runs: (j.runs || []).slice(0, 25).map((r) => ({ id: r.id, pipeline: r.pipeline, status: r.status, trigger: r.trigger, started: r.startedAt, ended: r.endedAt, metrics: r.metrics, error: r.error })) }; },
  'pipeline-run': () => { need(rest[0], 'pipeline-run <run id>'); return call('GET', `/api/aggregation/runs/${encodeURIComponent(rest[0])}`); },
  'pipeline-start': () => {
    need(PIPELINES.includes(rest[0]), `pipeline-start <${PIPELINES.join('|')}> [confirm-large] [key=value…]`);
    const overrides = Object.fromEntries(Object.entries(kv(rest.slice(1))).map(([k, v]) => [k, jsonish(v)]));
    return call('POST', '/api/aggregation/runs', { pipeline: rest[0], confirmLarge: rest.includes('confirm-large'), ...(Object.keys(overrides).length ? { overrides } : {}) });
  },
  'pipeline-cancel': () => { need(rest[0], 'pipeline-cancel <run id>'); return call('POST', `/api/aggregation/runs/${encodeURIComponent(rest[0])}/cancel`, {}); },
  'pipeline-config': async () => {
    const o = kv(rest);
    if (!rest.length) return call('GET', '/api/aggregation/config');
    if (o.repo !== undefined && rest.length === 1) return call('PUT', '/api/aggregation/config', { seenRepoDir: o.repo || null });
    need(PIPELINES.includes(rest[0]) && rest.length > 1, `pipeline-config <${PIPELINES.join('|')}> key=value…  |  pipeline-config repo=<absolute path>`);
    const cur = ((await call('GET', '/api/aggregation/config')).pipelines || {})[rest[0]] || {};
    const patch = Object.fromEntries(Object.entries(kv(rest.slice(1))).map(([k, v]) => [k, jsonish(v)]));
    return call('PUT', '/api/aggregation/config', { pipelines: { [rest[0]]: { ...cur, ...patch } } });
  },
  'pipeline-schedules': () => call('GET', '/api/aggregation/schedules'),
  'pipeline-schedule': async () => {
    need(PIPELINES.includes(rest[0]) && rest.length > 1, `pipeline-schedule <${PIPELINES.join('|')}> enabled=true|false [frequency=… time=HH:MM weekday=0-6]`);
    const cur = ((await call('GET', '/api/aggregation/schedules')).schedules || {})[rest[0]] || {};
    const o = Object.fromEntries(Object.entries(kv(rest.slice(1))).map(([k, v]) => [k, jsonish(v)]));
    return call('PUT', `/api/aggregation/schedules/${encodeURIComponent(rest[0])}`, { enabled: cur.enabled, frequency: cur.frequency, time: cur.time, weekday: cur.weekday, ...o });
  },
  'boards-pull': () => { const names = items(text); return call('POST', '/api/aggregation/boards/pull', names.length ? { companies: names.slice(0, 50) } : { limit: 200 }, { timeoutMs: 15 * 60_000 }); },
  'company-jobs': () => {
    const rows = items(text).map((x) => x.split('|').map((s) => s.trim()));
    need(rows.length, 'company-jobs <company[ | website]>; <company>…  (1–10 companies, separated by ;)');
    const websites = Object.fromEntries(rows.filter((r) => r[1]).map((r) => [r[0], r[1]]));
    return call('POST', '/api/aggregation/company-jobs', { companies: rows.map((r) => r[0]), websites, siteLimit: 40, indeed: true, browser: true });
  },

  // ---- data health ---------------------------------------------------------------------------------
  'data-health-history': () => call('GET', `/api/data-health/history?limit=${Number(kv(rest).limit) || 15}`),
  'data-health-auto': () => { need(['on', 'off'].includes(rest[0]), 'data-health-auto <on|off>'); return call('POST', '/api/data-health/settings', { auto: rest[0] === 'on' }); },
  'lookalike-ok': () => { need(rest[0], 'lookalike-ok <group key>  (keys: data-health)'); return call('POST', '/api/data-health/review', { key: text }); },

  // ---- money ---------------------------------------------------------------------------------------
  'cost-remove': () => { need(text, 'cost-remove <name>'); return call('POST', '/api/money/costs', { name: text, remove: true }); },
  cash: () => { need(rest[0], 'cash <amount | none>'); return call('POST', '/api/money/cash', { amount: rest[0] === 'none' ? null : rest[0] }); },
  'allocate-set': () => { need(rest[0] && rest.length > 1, 'allocate-set <stage> <bucket>=<pct>…  (stages + buckets: allocate)'); return call('POST', '/api/money/allocate', { stage: rest[0], pcts: Object.fromEntries(Object.entries(kv(rest.slice(1))).map(([k, v]) => [k, Number(v)])) }); },
  'allocate-reset': () => { need(rest[0], 'allocate-reset <stage>'); return call('POST', '/api/money/allocate', { stage: rest[0], reset: true }); },
  'channel-set': () => { const o = kv(rest); const name = rest.filter((x) => !x.includes('=')).join(' '); need(name, 'channel-set <name> spend=… signups=… paid=…  (last 30 days)'); return call('POST', '/api/money/channels', { name, spend30d: o.spend, signups30d: o.signups, paid30d: o.paid }); },
  readiness: () => { need(rest[0] && ['done', 'undone'].includes(rest[1]), 'readiness <id> <done|undone>  (ids: scale)'); return call('POST', '/api/money/readiness', { id: rest[0], done: rest[1] === 'done' }); },
  'money-plan': () => { need(rest[0] && rest[1], 'money-plan <service> <plan>  e.g. money-plan supabase pro'); return call('POST', '/api/money/plan', { service: rest[0], plan: rest[1] }); },
  scenario: () => { const levers = Object.fromEntries(Object.entries(kv(rest)).map(([k, v]) => [k, Number(v)])); need(Object.keys(levers).length, 'scenario <lever>=<value>…  (levers: units → scenarios)'); return call('POST', '/api/money/scenario', { levers }); },

  // ---- growth studio -------------------------------------------------------------------------------
  'growth-plan': () => call('GET', '/api/growth/plan'),
  'growth-replan': () => { const o = kv(rest); return call('POST', '/api/growth/plan', { ...(o.start ? { start: o.start } : {}), ...(o.weeks ? { weeks: Number(o.weeks) } : {}) }); },
  'calendar-item': () => { need(rest[0], 'calendar-item <item id>'); return call('GET', `/api/growth/copy/${encodeURIComponent(rest[0])}`); },
  'calendar-status': () => { need(rest[0] && rest[1], 'calendar-status <item id> <idea|drafted|approved|scheduled|posted|measured>'); return call('POST', `/api/growth/calendar/${encodeURIComponent(rest[0])}/status`, { status: rest[1] }); },
  'calendar-results': () => { need(rest[0] && rest.length > 1, 'calendar-results <item id> impressions=… views=… sessions=… upvotes=… comments=… shares=… signups=… reports=… [notes=…]'); return call('POST', `/api/growth/calendar/${encodeURIComponent(rest[0])}/results`, kv(rest.slice(1))); },
  'brand-set': () => { const o = kv(rest); const { note, ...fields } = o; need(Object.keys(fields).length, 'brand-set field=value… [note=…]  (dotted fields for nested ones, e.g. colors.primary=#111)'); return call('POST', '/api/growth/brand', { patch: nested(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, jsonish(v)]))), note: note || '' }); },
  'growth-assets': () => call('GET', `/api/growth/assets${rest[0] ? `?week=${encodeURIComponent(rest[0])}` : ''}`),
  'growth-data': () => call('GET', `/api/growth/data${rest[0] === 'refresh' ? '?refresh=1' : ''}`),
  'growth-library': () => call('GET', '/api/growth/library'),

  // ---- creator library -----------------------------------------------------------------------------
  'creator-doctor': () => call('GET', '/api/instagram/doctor'),
  'creator-search': async () => { need(rest[0] && rest.length > 1, 'creator-search <user> <query…>'); return call('POST', `/api/instagram/projects/${encodeURIComponent(await projectOf(rest[0]))}/search`, { query: rest.slice(1).join(' '), limit: 25 }); },
  'creator-unresolved': async () => { need(rest[0], 'creator-unresolved <user>'); return call('GET', `/api/instagram/projects/${encodeURIComponent(await projectOf(rest[0]))}/unresolved`); },
  'creator-resolve': async () => { need(rest[0] && rest[1] && rest[2], 'creator-resolve <user> <key> <status> [note…]  (keys + statuses: creator-unresolved)'); return call('POST', `/api/instagram/projects/${encodeURIComponent(await projectOf(rest[0]))}/unresolved/${encodeURIComponent(rest[1])}`, { status: rest[2], ...(rest.length > 3 ? { note: rest.slice(3).join(' ') } : {}) }); },
  'creator-resume': async () => { need(rest[0], 'creator-resume <job id | user>'); return call('POST', `/api/instagram/jobs/${encodeURIComponent(await igJobOf(rest[0]))}/resume`, {}); },
  'creator-cleanup': async () => {
    need(rest[0], 'creator-cleanup <job id | user> [confirm]');
    const id = await igJobOf(rest[0]);
    const p = await call('POST', `/api/instagram/jobs/${encodeURIComponent(id)}/cleanup-preview`, {});
    if (rest[1] !== 'confirm') return { ...p, next: p.ok && p.preview?.ready ? `to delete the raw media: creator-cleanup ${rest[0]} confirm` : null };
    need(p.ok && p.preview?.ready && p.preview?.token, `not ready to clean: ${p.error || 'preview not ready'}`);
    return call('POST', `/api/instagram/jobs/${encodeURIComponent(id)}/cleanup-confirm`, { token: p.preview.token });
  },
  'creator-delete': async () => { need(rest[0] && rest[1], 'creator-delete <user> <exact project name> — ONLY when Brandon said to delete it'); return call('POST', `/api/instagram/projects/${encodeURIComponent(await projectOf(rest[0]))}/delete`, { confirm: rest[1] }); },

  // ---- Seen Command itself: settings, health, updates, the brain tab ---------------------------------
  diagnostics: async () => { const j = await call('GET', '/api/diagnostics'); const h = j.health || {}; return { overall: h.overall, counts: h.counts, checks: (h.checks || []).map((c) => ({ status: c.status, label: c.label, detail: c.detail, fix: c.fix || undefined })), baseHealthJob: j.jobs?.baseHealth }; },
  'base-health': () => call('POST', '/api/diagnostics/base-health', {}),
  credentials: async () => { const j = await call('GET', '/api/credentials'); return { cline: j.cline, groups: (j.groups || []).map((g) => ({ group: g.label, keys: (g.fields || []).map((f) => `${f.key}: ${f.configured ? 'configured' : 'not set'}`) })) }; },
  'secret-set': async () => {
    const [key, ...v] = rest; const value = v.join(' ');
    need(/^[A-Z][A-Z0-9_]*$/.test(key || '') && value, 'secret-set <KEY> <value>  (keys: credentials)');
    secretsGiven.push(value);
    const j = await call('POST', '/api/credentials', { values: { [key]: value } });
    return { ok: true, key, configured: configuredOf(j, key) };
  },
  'secret-clear': async () => { need(/^[A-Z][A-Z0-9_]*$/.test(rest[0] || ''), 'secret-clear <KEY>'); const j = await call('POST', '/api/credentials', { clear: [rest[0]] }); return { ok: true, key: rest[0], configured: configuredOf(j, rest[0]) }; },
  'cline-setup': () => { const [provider, apiKey, model] = rest; need(provider && apiKey, 'cline-setup <provider> <api key> [model]'); secretsGiven.push(apiKey); return call('POST', '/api/credentials/cline', { provider, apiKey, ...(model ? { model } : {}) }, { timeoutMs: 150_000 }); },
  'cline-signin': () => call('POST', '/api/credentials/cline-signin', { provider: rest[0] || 'cline' }),
  'cline-test': () => call('POST', '/api/credentials/cline-test', {}),
  'fix-agents': () => call('POST', '/api/agents/setup', {}, { timeoutMs: 6 * 60_000 }),
  'ai-usage': async () => { const j = await call('GET', '/api/ai-usage'); return { total: j.total, models: j.models, daily: (j.daily || []).slice(-7), cline: j.cline, providers: j.providers, disclaimer: j.disclaimer }; },
  workflows: async () => { const [s, w] = await Promise.all([call('GET', '/api/intelligence'), call('GET', '/api/intelligence/workflows')]); return { runtime: { localFirst: s.localFirst, remoteEscalationEnabled: s.remoteEscalationEnabled,  }, workflows: (w.workflows || []).slice(0, 15).map((x) => ({ id: x.id, state: x.state, objective: String(x.objective || '').slice(0, 200), risk: x.riskLevel, updated: x.updatedAt })) }; },
  'workflow-cancel': () => { need(rest[0], 'workflow-cancel <id>'); return call('POST', `/api/intelligence/workflows/${encodeURIComponent(rest[0])}/cancel`, {}); },
  'update-status': () => call('GET', '/api/update/status'),
  'update-check': () => call('POST', '/api/update/check', {}, { timeoutMs: 90_000 }),
  update: () => call('POST', '/api/update/apply', {}),
  'brain-status': () => call('GET', '/api/brain/status'),
  'brain-health': () => call('GET', '/api/brain/health'),
  'brain-activity': () => call('GET', '/api/brain/activity'),
  'brain-overnight': () => call('GET', '/api/brain/overnight'),
  'brain-refresh': () => call('POST', '/api/brain/refresh', {}),
  'brain-sources': () => (text ? call('POST', '/api/brain/sources', { vaultPath: text }) : call('GET', '/api/brain/sources')),
  'brain-access': () => call('GET', '/api/brain/access'),
  'brain-renew': () => { need(rest[0], 'brain-renew <client id> [hours]'); const h = Number(rest[1]); return call('POST', '/api/brain/access/renew', { id: rest[0], expiresAt: h > 0 ? new Date(Date.now() + h * 3600_000).toISOString() : null }); },
  'brain-revoke': () => { need(rest[0], 'brain-revoke <client id>'); return call('POST', '/api/brain/access/revoke', { id: rest[0] }); },
};

if (!VERBS[verb]) {
  process.stdout.write(JSON.stringify({ error: `unknown verb "${verb || ''}" — node scripts/act.mjs help lists every verb`, verbs: Object.keys(VERBS) }) + '\n');
  process.exit(1);
}
try {
  const out = noSecrets(await VERBS[verb]());
  let s = JSON.stringify(out);
  for (const given of secretsGiven) if (given && given.length >= 6) s = s.split(JSON.stringify(given).slice(1, -1)).join('[hidden]');
  process.stdout.write((s.length > 24000 ? `${s.slice(0, 24000)}…(trimmed)` : s) + '\n');
} catch (e) {
  let m = String(e.message);
  for (const given of secretsGiven) if (given && given.length >= 6) m = m.split(given).join('[hidden]');
  process.stdout.write(JSON.stringify({ error: m }) + '\n');
  process.exit(1);
}
