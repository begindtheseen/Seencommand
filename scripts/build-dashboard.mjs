#!/usr/bin/env node
// Build the Command Center — a self-contained HTML dashboard from data/state.json. No server, no
// CDN: double-click public/command-center.html and you're greeted with the morning board meeting.
// Three P1 tabs: Command Center (debrief + approvals), Agents (the org network + live status),
// Knowledge Vault (the shared memory graph). Rebuilt by `npm run dashboard` after each run.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { toolsFor } from '../org/tools.mjs';
import { modelFor, isFrontierOptional } from '../org/models.mjs';
import { FOCUSES } from '../org/focus.mjs';
import { departmentById } from '../org/org.mjs';
import { statePath, dashboardPath, REPO_ROOT } from '../lib/paths.mjs';

// The Aggregation Dashboard's browser module lives in a real .js file (unit-tested on its own) and is
// inlined here. `</script` is neutralized so the module can never terminate the page's script block.
const AGG_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'aggregation', 'dashboard-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
// The 2026-10-21 redesign: Home / Search / Notifications client + the theme that restyles every tab.
const APP_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'app-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const JOBS_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'jobs-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const DATA_HEALTH_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'data-health-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const MONEY_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'money-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const TICKETS_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'tickets-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const UPDATE_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'update-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const GROWTH_CLIENT = ['growth-design.js', 'growth-client.js'].map((f) => readFileSync(join(REPO_ROOT, 'lib', 'ui', f), 'utf8')).join('\n').replace(/<\/(script)/gi, '<\\/$1');
const BRAIN_GRAPH = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'brain-graph.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const BRAIN_CLIENT = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'brain-client.js'), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
const THEME_CSS = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'theme.css'), 'utf8').replace(/<\/(style)/gi, '<\\/$1');

const state = JSON.parse(readFileSync(statePath(), 'utf8'));

// Build/version stamp — so you can SEE at a glance that an update actually landed.
let gitSha = '';
try { gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }).toString().trim(); } catch { /* not a repo */ }
let pkgVersion = '?';
try { pkgVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
const VERSION = `v${pkgVersion}${gitSha ? ` · ${gitSha}` : ''}`;
// Times are shown in Brandon's zone (Pacific), not UTC. PT covers PST/PDT automatically.
const PT_TZ = 'America/Los_Angeles';
function ptStamp(d) {
  const dt = d ? new Date(d) : new Date();
  if (Number.isNaN(dt.getTime())) return String(d || '');
  const date = dt.toLocaleDateString('en-CA', { timeZone: PT_TZ });
  const time = dt.toLocaleTimeString('en-GB', { timeZone: PT_TZ, hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}
function ptTime(d) {
  const dt = d ? new Date(d) : new Date();
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('en-GB', { timeZone: PT_TZ, hour: '2-digit', minute: '2-digit' });
}
const BUILT_AT = ptStamp(new Date());
const DEPT_TITLES = Object.fromEntries(state.departments.map((d) => [d.id, d.title]));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DEPT_COLOR = { growth: '#5b8cff', product: '#c792ea', reliability: '#3b82f6', revenue: '#ffb454', data: '#ff6b8b', strategy: '#e879f9', platform: '#4ade80', command: '#e9edf6' };
const DEPT_ROLE = { growth: 'Market Reach', product: 'Build System', reliability: 'Ops & Uptime', revenue: 'Revenue Ops', data: 'Signal Layer', strategy: 'War Room', platform: 'Self-Repair' };
// Department icons: the same stroke set as the sidebar (currentColor takes the department's colour).
const DEPT_ICON_PATHS = {
  growth: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  product: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  reliability: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/>',
  revenue: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  data: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  strategy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  platform: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  command: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
};
const deptIcon = (id, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DEPT_ICON_PATHS[id] || '<circle cx="12" cy="12" r="4"/>'}</svg>`;
const statusPill = (s) => `<span class="pill ${s}">${s}</span>`;
const shortModel = (id) => modelFor(id).name.replace(/\s*\(local\)/, '');
const deptStatus = (dep) => { const s = dep.workers.map((w) => (state.agents[w.id] || {}).status); return s.includes('waiting') ? 'waiting' : s.includes('working') ? 'working' : 'idle'; };
const tagline = (dep) => String(dep.charter || '').split(/\.\s/)[0].replace(/\.$/, '');
const ROUTES = state.proposals.length;
const READS = state.memoryGraph.nodes.length;

// ---- Live connector signals strip ------------------------------------------
// A chip per connector + reasoning lane: green = live & healthy, amber = configured but degraded,
// grey = not connected. Reads state.signals (baked in by engine/run.mjs from the live gather).
const sig = state.signals || {};
function chip(label, level, detail) {
  const cls = level === 'on' ? 'on' : level === 'warn' ? 'warn' : 'off';
  return `<span class="sig ${cls}" title="${esc(detail || '')}"><span class="sig-dot"></span>${esc(label)}${detail ? ` <span class="sig-d">${esc(detail)}</span>` : ''}</span>`;
}
function connState(configured, payload, okDetail) {
  if (!configured) return ['off', 'not connected'];
  if (!payload || payload.notConfigured) return ['off', 'not connected'];
  if (payload.error) return ['warn', 'error'];
  return ['on', okDetail(payload)];
}
const st = sig.status || {};
const sigChips = (() => {
  if (!sig.status) return '';
  const chips = [];
  { const [l, dt] = connState(st.admin_stats, sig.admin, (p) => `${(p.users?.total ?? 0).toLocaleString()} users · ${p.revenue?.month == null ? 'revenue —' : `$${p.revenue.month} / 30d`}`); chips.push(chip('Admin-stats', l, dt)); }
  { const [l, dt] = connState(st.github, sig.github, (p) => `${p.openPRs?.length ?? 0} PRs · CI ${p.ci?.state ?? '?'}`); chips.push(chip('GitHub', l, dt)); }
  { const [l, dt] = connState(st.supabase, sig.supabase, (p) => p.health?.up ? 'up' : 'down'); chips.push(chip('Supabase', l, dt)); }
  { const [l, dt] = connState(st.vercel, sig.vercel, (p) => p.deployment?.state || (p.deployment?.none ? 'none' : '?')); chips.push(chip('Vercel', l, dt)); }
  { const [l, dt] = connState(st.stripe, sig.stripe, (p) => `${p.subscriptions?.activeCount ?? 0} subs`); chips.push(chip('Stripe', l, dt)); }
  // NOTE (audit of PR #73): a "real-time monitoring" pair of chips was added here reading
  // st.chronos / st.seen_command — signals that do not exist, so both chips rendered permanently
  // dead. Removed. A real monitoring chip needs a real signals source first (lib/connectors).
  // reasoning lanes
  const lanes = (sig.llm && sig.llm.lanes) || {};
  const laneOrder = [['groq', 'Groq'], ['gemini', 'Gemini'], ['cerebras', 'Cerebras'], ['anthropic', 'Anthropic']];
  for (const [k, name] of laneOrder) if (lanes[k]) chips.push(chip(name, k === state.reasonEngine ? 'on' : 'warn', k === state.reasonEngine ? 'reasoning' : 'ready'));
  return `<div class="sigstrip">${chips.join('')}<span class="sig-at">live ${esc(ptTime(sig.at))} PT</span></div>`;
})();

// ---- Tasks (REAL open GitHub issues Brandon can track) ---------------------
const tasks = state.tasks || [];
// Each task card carries a ▶ Build button (manually kick the test-gated builder on that issue) and a
// .build-status panel the /api/builds poll paints — same renderer as the approval cards, matched by
// issue number. Keep this markup in sync with taskCardHTML in the client script (the live refresh).
const taskCards = tasks.length
  ? tasks.map((t) => `<div class="task" data-n="${t.number}">
      <div class="task-row">
        <span class="task-n">#${t.number}</span>
        <span class="task-t">${esc(t.title)}</span>
        ${(t.labels || []).map((l) => `<span class="tlabel">${esc(l)}</span>`).join('')}
        <a class="task-go" href="${esc(t.url)}" target="_blank" rel="noopener">open ↗</a>
        <button class="task-build" onclick="startTaskBuild(${t.number})">▶ Build</button>
        <button class="task-del" onclick="deleteTask(${t.number})" title="Close this task and record the deletion in the brain">✕</button>
      </div>
      <div class="build-status" hidden></div>
    </div>`).join('')
  : '<p class="muted">No open tasks yet. Approve a proposal on Home or in the Board report and it becomes a tracked task here.</p>';

// ---- Command Center tab (debrief + approvals) ------------------------------
const d = state.debrief;
// The tiles are baked by the last board meeting. If a newer brain fact exists for the same quantity,
// it wins; if nothing is fresher, the tile is at least dated. Without this the Command Center showed
// a "Total users" figure from a weeks-old snapshot while the brain correctly held a newer value — a
// stale number with nothing on screen saying so. A missing vault leaves the tiles exactly as they were.
let kpiTiles = d.kpis;
try {
  const { currentFacts } = await import('../lib/brain.mjs');
  const { reconcileKpis } = await import('../lib/kpi-reconcile.mjs');
  kpiTiles = reconcileKpis(d.kpis, currentFacts(), {
    snapshotISO: state.generatedAt, today: new Date().toISOString(),
  });
} catch { /* no vault / no brain → render the baked tiles unchanged */ }
const kpiRow = kpiTiles.map((k) => `<div class="kpi"><div class="kpi-v">${esc(k.value)}</div><div class="kpi-l">${esc(k.label)}</div>${k.delta ? `<div class="kpi-d">${esc(k.delta)}</div>` : ''}</div>`).join('');
const routingStrip = (d.routing && d.routing.length)
  ? `<div class="routing"><b>⇄ Cross-team routing:</b> ${d.routing.map((r) => `<span class="route">${esc(r)}</span>`).join('')}</div>` : '';
const debriefSections = d.sections.map((s) => `
  <div class="brief-sec">
    <h4 style="color:${DEPT_COLOR[state.departments.find((x) => x.title === s.title)?.id] || '#e9edf6'}">${esc(s.title)}</h4>
    <ul>${s.bullets.map((b) => `<li>${esc(String(b).replace(/^🧠 \[([^\]]+)\] /, 'Department read ($1): '))}</li>`).join('')}</ul>
  </div>`).join('');
const pendingCount = state.approvals.filter((a) => a.status === 'pending').length;
const approvalCards = state.approvals.map((a) => {
  const decided = a.status && a.status !== 'pending';
  const vcolor = a.status === 'approved' ? '#34d399' : '#f87171';
  const actions = decided
    ? `<span class="verdict" style="color:${vcolor}">${a.status === 'approved' ? '✓ approved' : '✕ denied'}${a.decidedAt ? ' · earlier' : ''}</span>`
    : `<button class="approve" onclick="decide('${a.id}','approved')">✓ Approve</button>
      <button class="deny" onclick="decide('${a.id}','denied')">✕ Deny</button>
      <span class="verdict"></span>`;
  const buildBadge = a.build ? `<span class="build-tag" title="Approving builds real code and opens a PR">🔨 auto-build → ${a.build === 'tool' ? 'Seen Command' : 'Seen product'}</span>` : '';
  return `
  <div class="appr${decided ? ' decided' : ''}" data-id="${a.id}" data-key="${esc(a.key || '')}"${a.build ? ` data-build="${esc(a.build)}"` : ''}>
    <div class="appr-top"><span class="dot" style="background:${DEPT_COLOR[a.dept]}"></span>
      <b>${esc(a.title)}</b><span class="risk ${a.risk}">${a.risk} risk</span></div>
    <p>${esc(a.summary)}</p>
    ${buildBadge}
    ${a.onApprove ? `<div class="appr-mode">On approve → ${esc(a.onApprove)}</div>` : ''}
    <div class="appr-actions">${actions}</div>
    <div class="build-status" hidden></div>
  </div>`;
}).join('');

// ---- Overnight briefing (what the co-CEO loop did overnight) ---------------
const ov = d.overnight;
const overnightPanel = ov ? `
  <div class="overnight">
    <div class="ov-h">🌙 Overnight briefing <span class="ov-when">ran ${esc(ptStamp(ov.ranAt))} PT</span></div>
    <div class="ov-headline">${esc(ov.headline)}</div>
    ${(ov.shipped && ov.shipped.length) ? `<div class="ov-sec"><span class="ov-lbl">Shipped (test-gated)</span>${ov.shipped.map((s) => `<a class="ov-pr" href="${esc(s.pr || s.issueUrl || '#')}" target="_blank" rel="noopener">#${esc(s.issue)} ${esc(s.title)} <b>${s.merged ? '· merged' : (s.pr ? '· PR ready ↗' : (s.dryRun ? '· green (dry)' : '· built'))}</b></a>`).join('')}</div>` : ''}
    ${(ov.failed && ov.failed.length) ? `<div class="ov-sec ov-fail"><span class="ov-lbl">Gate stayed red — nothing merged</span>${ov.failed.map((f) => `<span class="ov-item">#${esc(f.issue)} ${esc(f.title)}</span>`).join('')}</div>` : ''}
    ${(ov.parked && ov.parked.length) ? `<div class="ov-sec"><span class="ov-lbl">${esc(ov.parked.length)} parked for your yes/no</span><span class="ov-item">↓ in the approvals queue below</span></div>` : ''}
    ${ov.stopped ? `<div class="ov-sec ov-fail"><span class="ov-item">⚠ ${esc(ov.stopped)}</span></div>` : ''}
  </div>` : '';

// ---- Board Room directives that steered this meeting (correlation with the chat) ----
const directives = (d.directives && d.directives.length) ? d.directives : null;
const directivesPanel = directives ? `
  <div class="directives">
    <div class="dir-h">🗣️ Steered by your Board Room</div>
    ${directives.slice(-4).map((t) => `<div class="dir-l">"${esc(t)}"</div>`).join('')}
  </div>` : '';

// ---- Sidebar icons: one consistent stroke set (16px, currentColor) ---------------------------------
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  boardroom: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  tickets: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  notifications: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  vault: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5m0 0-5.6 5.6M12 12l5.6 5.6"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  cc: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  growth: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  money: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  instagram: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  usage: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  intelligence: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
};
const icon = (k) => `<span class="ni"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[k] || ''}</svg></span>`;
// Labs: side projects that stay fully working but are hidden from the sidebar until Settings → "Show
// Labs tabs" is on (html.labs-on, remembered per Mac in localStorage). Keeps the everyday app focused.
const navBtn = (tab, label, extra = '', labs = false) => `<button class="nav${tab === 'home' ? ' on' : ''}${labs ? ' labs' : ''}" data-tab="${tab}">${icon(tab)}<span class="nl">${label}</span>${extra}</button>`;
// Tools that belong to a Labs feature: their chips on the Team cards hide with the Labs tabs.
const LABS_TOOLS = new Set(['instagram_compiler']);

// ---- Agents tab (the Agent Network tree) -----------------------------------
const deptCols = state.departments.map((baked) => {
  // Titles, charters and workers come from the CURRENT org (org/org.mjs); a meeting's saved copy can be months
  // old (a saved Revenue charter can lag behind the current business model). Statuses stay live.
  const dep = { ...baked, ...(departmentById(baked.id) || {}) };
  const col = DEPT_COLOR[dep.id] || '#8b94a7';
  const workers = dep.workers.map((w) => {
    const st = state.agents[w.id] || { status: 'idle', task: '' };
    return `<div class="wk"><div class="wn"><span class="sdot ${st.status}"></span><b>${esc(w.title)}</b></div>
      <div class="wt">${esc(st.task)}</div></div>`;
  }).join('');
  const tools = toolsFor(dep.id);
  const toolChips = tools.map((t) => `<span class="tchip${LABS_TOOLS.has(t.id) ? ' labs' : ''}">${esc(t.name)}</span>`).join('');
  return `<div class="dept-card">
    <div class="dc-top">
      <div class="icon-tile" style="background:${col}22;color:${col}">${deptIcon(dep.id)}</div>
      ${statusPill(deptStatus(dep))}
    </div>
    <div class="dc-title">${esc(dep.title)}</div>
    <div class="role-label" style="color:${col}">${esc(DEPT_ROLE[dep.id] || '')}</div>
    <div class="dc-tag">${esc(tagline(dep))}.</div>
    <div class="dc-model">⚙ ${esc(shortModel(dep.id))}${isFrontierOptional(dep.id) ? ' <span class="frontier">⬆</span>' : ''}</div>
    <div class="dc-tools">${toolChips}</div>
    <button class="dc-expand" onclick="toggleDept('${dep.id}')" id="x-${dep.id}">${dep.workers.length} agents ▸</button>
    <div class="dc-workers" id="w-${dep.id}" hidden>${workers}</div>
  </div>`;
}).join('');
const ceo = state.agents.ceo || { status: 'working', task: '' };

const MARKUP = `
<div class="app">
  <aside class="rail">
    <div class="brand"><div class="logo">◆</div><div><b>Seen Command</b><small>Your company, running</small></div></div>
    <button class="newchat" id="new-chat"><span>＋</span> New chat</button>
    <nav>
      ${navBtn('home', 'Home')}
      ${navBtn('boardroom', 'Board Room')}
      ${navBtn('search', 'Search')}
      ${navBtn('jobs', 'Jobs')}
      ${navBtn('tasks', 'Tasks', tasks.length ? `<span class="nav-badge">${tasks.length}</span>` : '')}
      ${navBtn('tickets', 'Tickets', '<span class="u-badge" id="nav-tickets-badge" hidden></span>')}
      ${navBtn('notifications', 'Notifications', '<span class="u-badge" id="nav-notes-badge" hidden></span>')}
      <div class="nav-group">Company</div>
      ${navBtn('vault', 'Brain')}
      ${navBtn('agents', 'Team')}
      ${navBtn('cc', 'Board report')}
      <div class="nav-group labs">Labs</div>
      ${navBtn('growth', 'Growth', '', true)}
      ${navBtn('money', 'Money &amp; Scale', '', true)}
      ${navBtn('instagram', 'Creator Library', '', true)}
      ${navBtn('usage', 'AI usage', '', true)}
      ${navBtn('intelligence', 'Runtime', '', true)}
      <div class="nav-spacer"></div>
      ${navBtn('settings', 'Settings')}
    </nav>
    <div class="rail-foot"><span>${esc(VERSION)}</span><span>built ${esc(BUILT_AT)} PT</span></div>
  </aside>

  <main>
    <header class="topbar">
      <div></div>
      <div class="tb-right">
        <span class="clock-pill" id="clock">${esc(state.today)}</span>
      </div>
    </header>

    <section class="tab" id="tab-home"><div id="home-view"></div></section>
    <section class="tab hidden" id="tab-notifications"><div id="notes-view"></div></section>
    <section class="tab hidden" id="tab-jobs"><div id="jobs-view"></div></section>
    <section class="tab hidden" id="tab-money"><div id="money-view" class="u-money"></div></section>
    <section class="tab hidden" id="tab-tickets"><div id="tickets-view"></div></section>
    <section class="tab hidden" id="tab-growth"><div id="growth-view"></div></section>

    <section class="tab hidden" id="tab-cc">
      <div class="greet"><b class="greet-hello" data-greet>Hello</b>, Brandon. <span>Your exec team met at the board table.</span></div>
      <div class="stale-banner" data-generated-at="${esc(state.generatedAt || '')}" hidden><div><b>This is from the <span data-stale-day></span> board meeting, <span data-stale-age></span>.</b> The numbers, statuses and proposals here are from then. Meetings run only when you ask, so run one for today\u2019s read.</div><button class="u-btn primary sm" data-stale-run>Run a fresh meeting</button></div>
      ${overnightPanel}
      ${directivesPanel}
      ${(d.briefing && d.briefing.lines && d.briefing.lines.length) ? `<div class="briefing"><div class="briefing-h">Since your last check${d.briefing.since ? ` (${esc(ptStamp(d.briefing.since))} PT)` : ''}</div>${d.briefing.lines.map((l) => `<div class="briefing-l">${esc(l)}</div>`).join('')}</div>` : ''}
      ${sigChips}
      ${d.focus ? `<div class="focus-tag">Focus: <b>${esc(d.focus.title)}</b> — ${esc(d.focus.northStar)} <a onclick="showTab('boardroom')">change in the Board Room →</a></div>` : ''}
      <div class="headline">${esc(d.headline)}</div>
      <div class="kpis">${kpiRow}</div>
      ${routingStrip}
      ${d.steer && String(d.steer).trim() !== String(d.topConstraint || '').trim() ? `<div class="steer"><b>▸ Where to steer this week (War Room):</b> ${esc(d.steer)}</div>` : ''}
      ${d.topConstraint ? `<div class="constraint"><b>Diagnosis — biggest constraint:</b> ${esc(d.topConstraint)}</div>` : ''}
      <div class="cc-grid">
        <div class="brief">${debriefSections}</div>
        <div class="approvals">
          <h3>Awaiting your yes / no <span id="appr-count">${pendingCount}</span></h3>
          ${approvalCards || '<p class="muted">Nothing needs approval today.</p>'}
        </div>
      </div>
    </section>

    <section class="tab hidden" id="tab-tasks">
      <div class="greet">Tasks <span>Real open issues in ${esc(state.tasksRepo || 'your repo')} — approving an action files one here.</span></div>
      <div class="tasks-head">
        <span class="tasks-count">${tasks.length} open</span>
        <button id="run-meeting" class="run-btn">↻ Run board meeting</button>
      </div>
      <div class="tasklist">${taskCards}</div>
    </section>

    <section class="tab chatpane hidden" id="tab-boardroom">
      <div class="chat-scroll" id="chat-scroll">
        <div class="chat-col">
          <div class="chat-hero" id="chat-hero">
            <div class="hero-logo">◆</div>
            <h1 id="hero-greet">What can I help with?</h1>
            <p class="hero-sub">I read your machine, GitHub, Vercel &amp; the brain — then answer. Ask about a PR, a deploy, a file, or the business.</p>
            <div class="hero-cards" id="hero-cards"></div>
          </div>
          <div class="convo" id="convo"></div>
        </div>
      </div>
      <div class="chat-dock">
        <div class="chat-col">
          <div class="composer2">
            <textarea id="directive" rows="1" placeholder="Ask anything…"></textarea>
            <button id="send-directive" class="send-btn" title="Send" aria-label="Send">↑</button>
          </div>
          <div class="composer-hint">Reads your machine (read-only) · proposes changes for your approval — never pushes or deploys on its own.<span id="focus-mini"></span></div>
        </div>
      </div>
    </section>

    <section class="tab hidden" id="tab-agents">
      <div class="agent-net">
        <div class="net-head">Agent Network</div>
        <div class="net-sub">One command brain coordinating ${state.departments.length} specialist departments.</div>
        <div class="stale-banner" data-generated-at="${esc(state.generatedAt || '')}" hidden><div><b>This is from the <span data-stale-day></span> board meeting, <span data-stale-age></span>.</b> The numbers, statuses and proposals here are from then. Meetings run only when you ask, so run one for today\u2019s read.</div><button class="u-btn primary sm" data-stale-run>Run a fresh meeting</button></div>
        <div class="ceo-card">
          <div class="ceo-left">
            <div class="icon-tile ceo-tile">${deptIcon('command', 22)}</div>
            <div>
              <span class="pill working">${esc(ceo.status)}</span>
              <div class="ceo-name">CEO / Orchestrator</div>
              <div class="command-label">Command Layer</div>
              <div class="ceo-desc">Reviews yesterday, allocates today across the departments, runs the approval gate, and returns your morning debrief.</div>
            </div>
          </div>
          <div class="stats">
            <div class="stat"><div class="sv">${ROUTES}</div><div class="sl">Routes</div></div>
            <div class="stat"><div class="sv">${READS}</div><div class="sl">Reads</div></div>
            <div class="stat stat-model"><div class="sv">${esc(shortModel('command'))}</div><div class="sl">Model</div></div>
          </div>
        </div>
        <div class="spine"></div>
        <div class="depts">${deptCols}</div>
      </div>
    </section>

    <section class="tab hidden" id="tab-vault">
      <div class="ask-bar">
        <input id="ask-q" placeholder="Ask your brain anything… e.g. “what did we decide about pricing?” or “what shipped this week?”" />
        <button id="ask-go">Ask the brain</button>
      </div>
      <div id="ask-out" class="ask-out" hidden></div>
      <div class="vault-grid">
        <div class="v-col">
          <div class="v-panel"><div class="v-h">This week</div><div id="v-week" class="v-body"><p class="muted">Open in the app for the live feed.</p></div></div>
          <div class="v-panel"><div class="v-h">Decisions ledger <span class="v-hint">locked calls — don't relitigate</span></div><div id="v-decisions" class="v-body"><p class="muted">Open in the app for the ledger.</p></div></div>
        </div>
        <div class="v-col">
          <div class="v-panel">
            <div class="v-h">Facts <span id="v-count" class="v-count"></span></div>
            <input id="v-search" class="v-search" placeholder="filter facts… (or pick a node in Graph → Show its facts)" />
            <div id="v-facts" class="v-body v-facts"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="tab hidden" id="tab-instagram">
      <div class="greet">Creator Intelligence Library <span>what works for job-seeker content, counted across public creators — every line traces to a video and timestamp, and feeds the board meeting.</span></div>
      <div id="ig-doctor" class="ig-doctor"><p class="muted">Loading toolchain status…</p></div>
      <div class="ask-bar">
        <input id="ig-q" placeholder="research instagram creator_handle   ·   ask instagram creator_handle: how do they hook viewers?   ·   instagram status creator_handle" />
        <button id="ig-go">Run</button>
      </div>
      <div id="ig-out" class="ask-out" hidden></div>
      <div id="ig-insights" class="v-panel ci-panel"><div class="v-h">✦ Cross-creator insights <span class="v-hint">ranked by independent support · what the board reasons over</span></div><div class="v-body"><p class="muted">Loading…</p></div></div>
      <div class="ig-tools">
        <div id="ig-disc" class="v-panel"><div class="v-h">⌕ Find creators <span class="v-hint">Google in your Chrome via OpenCLI · prepares only — never a login, DM or post</span></div><div class="v-body">
          <div class="ig-disc-bar"><input id="ig-disc-goal" class="v-search" placeholder="e.g. career coaches whose audience gets ghosted by staffing agencies"/><button class="ig-btn" id="ig-disc-go">Discover</button></div>
          <div id="ig-disc-out"><p class="muted">Two ranked lists come back: creators to <b>learn from</b>, and creators whose <b>audience</b> Seen serves — each with its reasons and the Seen page that fits.</p></div>
        </div></div>
        <div id="ig-prune" class="v-panel"><div class="v-h">✂ Keep it lean <span class="v-hint">archive what doesn't serve SeenJobs · reversible</span></div><div class="v-body" id="ig-prune-body"><p class="muted">Loading…</p></div></div>
      </div>
      <div class="ig-grid">
        <div class="ig-col-accounts">
          <div class="v-panel"><div class="v-h">◎ Accounts <span id="ig-acct-count" class="v-count"></span></div><div id="ig-accounts" class="v-body"><p class="muted">Loading…</p></div></div>
        </div>
        <div class="ig-col-detail">
          <div id="ig-detail" class="v-panel"><div class="v-h">Select an account</div><div class="v-body"><p class="muted">Pick a creator on the left to see videos, evidence, knowledge, and guidance history.</p></div></div>
        </div>
      </div>
    </section>

    <section class="tab hidden" id="tab-settings">
      <div class="greet">Settings <span>Connect Seen Command without editing files or exposing stored secrets.</span></div>
      <div class="v-panel labs-panel"><label class="labs-toggle"><input type="checkbox" id="labs-toggle"><span><b>Show Labs tabs</b><small>Growth, Money &amp; Scale, Creator Library, AI usage and Runtime. They keep working while hidden; this only changes the sidebar.</small></span></label></div>
      <div class="v-panel"><div class="v-h">Software updates <button class="cred-btn" onclick="window.openUpdater&&openUpdater(true)">Check for updates…</button></div><div class="muted">Seen Command checks every hour and tells you when a new version is ready. Updating tests the new version first, then rebuilds and reopens the app.</div></div>
      <div class="v-panel diag-panel">
        <div class="v-h">System diagnostics <span id="diag-summary" class="v-count">probing live…</span><button class="cred-btn diag-refresh" id="diag-refresh">Refresh</button></div>
        <div class="cred-help">The same live, secret-free health map the Board Room sees: APIs, model lanes, Brain, local repositories, task tracker, builder, and activity ledger.</div>
        <div id="diag-checks" class="diag-checks"><p class="muted">Running connection and runtime probes…</p></div>
      </div>
      <div class="cred-notice">Stored values are never sent back to this screen. New credentials are written only to the local runtime <code>.env</code> with owner-only permissions. Leave a field blank to keep its current value.</div>
      <div class="cred-cline v-panel">
        <div class="v-h">Advanced coding agent — Cline <span id="cline-status" class="v-count">checking…</span></div>
        <div class="cred-cline-grid">
          <div>
            <b>Browser sign-in</b>
            <p class="muted">Simplest setup. Cline opens its own sign-in flow and keeps the resulting token in its credential store.</p>
            <button class="cred-btn" id="cline-signin">Sign in with Cline</button>
            <button class="cred-btn" id="cline-test">Test connection</button>
          </div>
          <div>
            <b>Bring your own provider key</b>
            <p class="muted">The key is passed once to <code>cline auth</code>; Seen Command does not save a second copy.</p>
            <div class="cline-auth-row">
              <select id="cline-provider" aria-label="Cline provider"><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option><option value="openai-native">OpenAI</option><option value="gemini">Gemini</option><option value="groq">Groq</option><option value="cerebras">Cerebras</option></select>
              <input id="cline-key" type="password" autocomplete="new-password" placeholder="Provider API key" />
              <input id="cline-model" autocomplete="off" placeholder="Model ID (optional)" />
              <button class="cred-btn" id="cline-configure">Authenticate</button>
            </div>
          </div>
        </div>
        <div id="cline-out" class="cred-out" aria-live="polite"></div>
      </div>
      <div id="cred-groups" class="cred-groups"><p class="muted">Loading credential status…</p></div>
      <div class="cred-actions"><button class="cred-save" id="cred-save">Save entered credentials</button><span id="cred-out" class="cred-out" aria-live="polite"></span></div>
    </section>

    <section class="tab hidden" id="tab-search">
      <div id="search-view"></div>
      <details class="adv" id="agg-adv"><summary>Advanced — each collector, its settings, schedules, full history and health</summary>
        <div class="adv-body" id="tab-aggregation-body">
      <div class="agg-tabs">
        <button class="agg-tab on" data-agg-tab="overview">Overview</button>
        <button class="agg-tab agg-ci" data-agg-tab="company_intel">◆ Company Intelligence</button>
        <button class="agg-tab agg-in" data-agg-tab="indeed">▣ Indeed Jobs</button>
        <button class="agg-tab agg-cs" data-agg-tab="company_jobs">⌕ Company jobs</button>
        <button class="agg-tab agg-ar" data-agg-tab="applicant_reports">✦ Applicant Reports</button>
        <button class="agg-tab" data-agg-tab="history">History</button>
        <button class="agg-tab" data-agg-tab="health">System Health</button>
        <button class="agg-tab" data-agg-tab="schedules">Scheduling</button>
      </div>
      <div id="agg-view"><p class="muted">Loading the collection pipelines…</p></div>
        </div>
      </details>
    </section>

    <section class="tab hidden" id="tab-intelligence">
      <div class="greet">Intelligence Runtime <span>local-first engineering workflows, evidence, cost, review, and approval boundaries.</span></div>
      <div id="intel-summary" class="usage-note">Loading local runtime status…</div>
      <div id="intel-workflows" class="intel-workflows"><p class="muted">Loading durable workflows…</p></div>
    </section>

    <section class="tab hidden" id="tab-usage">
      <div class="greet">AI Usage &amp; Credits <span>observed spend and activity by provider/model—unknown balances stay unknown.</span></div>
      <div class="usage-note" id="usage-note">Loading local usage ledger…</div>
      <div class="usage-cards" id="usage-cards"></div>
      <div class="v-panel usage-panel"><div class="v-h">30-day observed activity <button class="cred-btn" id="usage-refresh">Refresh</button></div><div id="usage-trend" class="usage-trend"></div></div>
      <div class="v-panel usage-panel"><div class="v-h">Models used</div><div id="usage-models" class="usage-table"></div></div>
      <div class="v-panel usage-panel"><div class="v-h">Provider connections &amp; remaining credits</div><div id="usage-providers" class="usage-table"></div></div>
    </section>
  </main>
</div>`;

const STYLE = `<style>
:root{--bg:#02040a;--bg2:#06080f;--panel:rgba(255,255,255,.03);--ink:#e9edf6;--muted:#8891a6;--line:rgba(255,255,255,.08);--glow:#3b82f6;--blue:#3b82f6;--indigo:#6366f1;--violet:#7c3aed;--green:#34d399;--amber:#fbbf24;--red:#f87171;--grey:#64748b;--body:'Instrument Sans',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--display:'Syne','Instrument Sans',system-ui,sans-serif;--mono:'DM Mono',ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(680px 460px at 12% 16%,rgba(59,130,246,.15),transparent 60%),radial-gradient(680px 460px at 88% 20%,rgba(124,58,237,.12),transparent 60%),radial-gradient(820px 560px at 50% 110%,rgba(99,102,241,.12),transparent 60%),radial-gradient(1000px 520px at 50% -10%,rgba(59,130,246,.06),transparent 60%),var(--bg);background-attachment:fixed;color:var(--ink);font-family:var(--body);font-size:14px;letter-spacing:-.005em}
.mono,.clock,.rail-foot,.dept-kpi,.kpi-v{font-family:var(--mono)}
.greet,.brand b,.section-h,.op-pill{font-family:var(--display);letter-spacing:-.01em}
.agg-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}.agg-tab{background:var(--panel);border:1px solid var(--line);color:var(--muted);padding:7px 12px;border-radius:9px;font:500 12.5px var(--body);cursor:pointer}.agg-tab.on{color:var(--ink);border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.06)}.agg-tab.agg-ci.on{border-color:rgba(124,58,237,.6)}.agg-tab.agg-in.on{border-color:rgba(59,130,246,.6)}.agg-tab.agg-cs.on{border-color:rgba(52,211,153,.6)}.agg-tab.agg-ar.on{border-color:rgba(251,191,36,.6)}
.agg-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.agg-card,.agg-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0}.agg-panel{margin-bottom:12px}.agg-ci{border-left:3px solid var(--violet)}.agg-in{border-left:3px solid var(--blue)}.agg-cs{border-left:3px solid var(--green)}.agg-cs .agg-icon{color:var(--green)}.agg-cs .agg-step-n{border-color:rgba(52,211,153,.55)}.agg-ar{border-left:3px solid var(--amber)}.agg-ar .agg-icon{color:var(--amber)}.agg-ar .agg-step-n{border-color:rgba(251,191,36,.55)}.agg-ar .agg-seg-b.on{border-color:var(--amber);background:rgba(251,191,36,.1)}
.agg-cov{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin:10px 0}.agg-cov .agg-stats{flex:1 1 320px;min-width:0}.agg-cov-big{flex:0 0 auto;display:flex;gap:10px;align-items:center;background:#101622;border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:0}.agg-cov-big b{font:700 28px var(--mono)}.agg-cov-big.ok b{color:var(--green)}.agg-cov-big.warn b{color:var(--amber)}.agg-cov-big span{color:var(--muted);font-size:12px;line-height:1.35}
.agg-tr.ar{grid-template-columns:2fr .6fr .6fr .8fr 1.2fr}.agg-hist .agg-tr.agg-ar{border-left-width:3px}
.agg-cj-text{width:100%;box-sizing:border-box;background:#0c1119;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);font:12.5px var(--mono);resize:vertical}.agg-cj-src{display:flex;flex-direction:column;gap:7px;margin:6px 0}.agg-cj-src .agg-chk{white-space:normal;flex-wrap:wrap}.agg-cj-src input{width:15px;height:15px}.agg-cj-out{margin-top:16px}.agg-cj{border:1px solid var(--line);border-radius:10px;overflow-x:auto;margin:8px 0}.agg-cj-r{display:grid;grid-template-columns:minmax(0,1.1fr) repeat(3,minmax(0,1.5fr)) minmax(0,.5fr);gap:10px;padding:8px 10px;border-top:1px solid var(--line);font-size:12.5px;align-items:start}.agg-cj-r:first-child{border-top:0}.agg-cj-r>span{min-width:0;overflow-wrap:anywhere}.agg-cj-r small{color:var(--muted)}.agg-cj-r.head{color:var(--muted);font-size:11px}.agg-bad{color:var(--red)}
.agg-card-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.agg-card-h b{font-size:15px}.agg-icon{font-size:14px}.agg-ci .agg-icon{color:var(--violet)}.agg-in .agg-icon{color:var(--blue)}.agg-env{margin-left:auto;color:var(--muted);font:10.5px var(--mono)}
.agg-pill{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:20px;border:1px solid var(--line)}.agg-pill.ok{color:var(--green);border-color:rgba(52,211,153,.35)}.agg-pill.run{color:var(--blue);border-color:rgba(59,130,246,.45);animation:aggpulse 1.6s ease-in-out infinite}.agg-pill.warn{color:var(--amber);border-color:rgba(251,191,36,.4)}.agg-pill.bad{color:var(--red);border-color:rgba(248,113,113,.45)}.agg-pill.mute{color:var(--grey)}@keyframes aggpulse{50%{opacity:.55}}@media(prefers-reduced-motion:reduce){.agg-pill.run{animation:none}}
.agg-sub{color:var(--muted);font-size:12px;line-height:1.5;margin:6px 0}.agg-note{color:var(--muted);font-size:12px;line-height:1.55;margin:10px 0;padding:9px 12px;border:1px dashed var(--line);border-radius:9px}.agg-reason{font-size:12.5px;margin:8px 0;color:var(--ink)}
.agg-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 14px;font-size:12.5px;margin:10px 0}.agg-kv>span:nth-child(odd){color:var(--muted)}.agg-kv small{color:var(--muted)}
.agg-lbl{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--glow);margin:14px 0 7px}.agg-probs{margin-top:8px}.agg-prob{font-size:12px;line-height:1.45;padding:7px 10px;border-radius:8px;margin:4px 0;background:rgba(255,255,255,.025);border:1px solid var(--line)}.agg-prob.bad{border-color:rgba(248,113,113,.35)}.agg-prob.warn{border-color:rgba(251,191,36,.3)}.agg-act{font-size:12px;color:var(--amber);margin:3px 0}
.agg-card-f{margin-top:12px}.agg-btn{background:#131a27;border:1px solid var(--line);color:var(--ink);padding:7px 12px;border-radius:8px;font:500 12.5px var(--body);cursor:pointer}.agg-btn:hover{border-color:rgba(255,255,255,.25)}.agg-btn.primary{background:linear-gradient(180deg,#2c5fd6,#2448a8);border-color:#3b6fe6}.agg-btn.danger{border-color:rgba(248,113,113,.5);color:var(--red)}.agg-btn[disabled]{opacity:.45;cursor:not-allowed}
.agg-ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}.agg-out{font-size:12px}.agg-out.ok{color:var(--green)}.agg-out.bad{color:var(--red)}
.agg-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;margin:10px 0}.agg-stat{border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:rgba(255,255,255,.02);min-width:0}.agg-stat b{display:block;font:600 18px var(--mono)}.agg-stat span{color:var(--muted);font-size:11px}.agg-stat i{font-style:normal;cursor:help}.agg-na{color:var(--grey);cursor:help}
.agg-table{display:flex;flex-direction:column;overflow-x:auto}.agg-tr{display:grid;grid-template-columns:1.2fr .5fr 2fr 2fr;gap:10px;padding:8px 4px;border-top:1px solid var(--line);font-size:12px;align-items:center;min-width:0}.agg-tr>span{min-width:0;overflow-wrap:anywhere}.agg-tr.head{color:var(--muted);border-top:0;font-size:11px}.agg-tr.two{grid-template-columns:2fr 1fr}.agg-tr.three{grid-template-columns:2fr 1fr 1fr}.agg-hist .agg-tr{grid-template-columns:1.1fr 1fr .9fr .7fr 2.4fr .6fr;cursor:pointer}.agg-hist .agg-tr.head{cursor:default}.agg-hist .agg-tr:not(.head):hover{background:rgba(255,255,255,.03)}.agg-hist .agg-tr.agg-ci,.agg-hist .agg-tr.agg-in,.agg-hist .agg-tr.agg-cs{border-left-width:3px}
.agg-b{font:600 9.5px var(--mono);font-style:normal;color:var(--red);text-transform:uppercase}.agg-b.warn{color:var(--amber)}.agg-mono{font-family:var(--mono);font-size:11px;color:var(--muted)}
.agg-pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a0e16;border:1px solid var(--line);border-radius:8px;padding:9px 10px;font:11px/1.5 var(--mono);color:#c8d0e0;max-height:260px;overflow:auto}
.agg-checks{display:grid;grid-template-columns:1fr;gap:6px;margin-top:8px}.agg-check{border:1px solid var(--line);border-radius:9px;padding:9px 11px;background:rgba(255,255,255,.02)}.agg-check b{font-size:12.5px}.agg-check p{font-size:11.5px;color:var(--muted);line-height:1.45;margin-top:3px}.agg-check .agg-fix{color:var(--amber)}.agg-check-s{float:right;font:9.5px var(--mono);text-transform:uppercase}.agg-check.ok .agg-check-s{color:var(--green)}.agg-check.bad .agg-check-s{color:var(--red)}.agg-check.warn .agg-check-s{color:var(--amber)}.agg-check.mute .agg-check-s{color:var(--grey)}
.agg-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin:10px 0}.agg-form label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}.agg-form small{font-size:10.5px}.agg-form input,.agg-form select,.agg-srch input,.agg-presets input,.agg-presets select,.agg-filters input,.agg-filters select{min-width:0;background:#0c1119;border:1px solid var(--line);border-radius:8px;padding:7px 9px;color:var(--ink);font:12px var(--body)}.agg-form input[type=checkbox]{width:18px;height:18px}
.agg-tool .agg-card-h{margin-bottom:4px}.agg-banner{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:12.5px;line-height:1.5}.agg-banner.bad{border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.06)}.agg-banner.warn{border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.05)}.agg-banner>b{display:block;margin-bottom:4px}.agg-fixl{color:var(--amber)}.agg-link{background:none;border:0;color:var(--blue);cursor:pointer;font:500 12.5px var(--body);padding:4px 0}
.agg-step{display:flex;gap:11px;align-items:flex-start;margin:20px 0 10px}.agg-step-n{flex:0 0 24px;height:24px;border-radius:50%;display:grid;place-items:center;font:700 12px var(--mono);background:rgba(255,255,255,.07);border:1px solid var(--line);color:var(--ink)}.agg-ci .agg-step-n{border-color:rgba(124,58,237,.55)}.agg-in .agg-step-n{border-color:rgba(59,130,246,.55)}.agg-step b{font-size:14px}.agg-step p{color:var(--muted);font-size:12px;margin-top:2px}
.agg-sets{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin:8px 0}.agg-sets.small{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}.agg-set{text-align:left;background:#101622;border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--ink);cursor:pointer;display:flex;flex-direction:column;gap:3px;transition:border-color .15s,background .15s}.agg-set:hover:not([disabled]){border-color:rgba(255,255,255,.28)}.agg-set.on{border-color:var(--blue);background:rgba(59,130,246,.12)}.agg-ci .agg-set.on{border-color:var(--violet);background:rgba(124,58,237,.13)}.agg-set.star{border-color:rgba(251,191,36,.35)}.agg-set.star.on{border-color:var(--amber);background:rgba(251,191,36,.1)}.agg-set[disabled]{opacity:.45;cursor:not-allowed}.agg-set-t{font:600 13px var(--body)}.agg-set-s{font-size:11.5px;color:var(--muted);line-height:1.4}
.agg-rows{border:1px solid var(--line);border-radius:10px;max-height:300px;overflow:auto}.agg-row{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:center;padding:6px 10px;border-top:1px solid var(--line);font-size:12.5px}.agg-row:first-child{border-top:0}.agg-row-l{color:var(--muted)}.agg-row-f{color:var(--grey);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agg-row .agg-x{padding:2px 8px}
.agg-add{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.agg-add input,.agg-cat-tools input,.agg-cat-tools select{background:#0c1119;border:1px solid var(--line);border-radius:8px;padding:7px 9px;color:var(--ink);font:12.5px var(--body);min-width:0;flex:1 1 180px}
.agg-seg{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.agg-seg-b{text-align:left;background:#101622;border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--ink);cursor:pointer;display:flex;flex-direction:column;gap:2px}.agg-seg-b small{color:var(--muted);font-size:11.5px}.agg-seg-b.on{border-color:var(--blue);background:rgba(59,130,246,.12)}.agg-ci .agg-seg-b.on{border-color:var(--violet);background:rgba(124,58,237,.13)}
.agg-adv{margin:10px 0}.agg-adv summary{cursor:pointer;font-size:12px;color:var(--muted)}.agg-go{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:22px 0 6px;padding-top:14px;border-top:1px solid var(--line)}.agg-go .agg-sub{flex-basis:100%;margin:2px 0 0}.agg-btn.big{padding:11px 18px;font:600 14px var(--body);border-radius:10px}.agg-sum{font-size:13.5px;margin:4px 0 8px}
.agg-cat-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 6px}.agg-cat-tools select{flex:0 1 160px}.agg-chk{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);white-space:nowrap}.agg-cat-tools .agg-chk input{flex:0 0 auto;width:15px;height:15px;padding:0}.agg-cat-r input{width:15px;height:15px}.agg-cat{border:1px solid var(--line);border-radius:10px;max-height:420px;overflow:auto}.agg-cat-r{display:grid;grid-template-columns:22px minmax(0,2.2fr) repeat(3,minmax(0,.9fr)) minmax(0,1fr);gap:10px;align-items:center;padding:7px 10px;border-top:1px solid var(--line);font-size:12.5px;cursor:pointer}.agg-cat-r:first-child{border-top:0}.agg-cat-r.head{position:sticky;top:0;background:var(--panel);color:var(--muted);font-size:11px;cursor:default;z-index:1}.agg-cat-r:not(.head):hover{background:rgba(255,255,255,.03)}.agg-cat-r.on{background:rgba(124,58,237,.1)}.agg-cat-n{overflow-wrap:anywhere}.agg-g{font-size:11px;color:var(--muted)}.agg-g.ok{color:var(--green)}
.agg-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;font-size:12.5px}.agg-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(124,58,237,.45);background:rgba(124,58,237,.1);border-radius:20px;padding:3px 4px 3px 10px;font-size:12px}.agg-chip button{background:none;border:0;color:var(--muted);cursor:pointer;padding:0 5px}.agg-quick{margin-bottom:14px}
@media (max-width:760px){.agg-cat-r{grid-template-columns:22px minmax(0,1.6fr) repeat(2,minmax(0,.8fr))}.agg-cat-r>span:nth-child(5),.agg-cat-r>span:nth-child(6){display:none}.agg-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}.agg-row-f{display:none}}
.agg-srch{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.3fr) auto;gap:6px;margin:5px 0}.agg-x{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:8px;cursor:pointer;padding:0 10px}.agg-presets,.agg-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:10px 0}.agg-wide{flex:1;min-width:220px}.agg-pre-d summary{cursor:pointer;font-size:12px;color:var(--muted);margin:8px 0}.agg-live{border:1px solid rgba(59,130,246,.35);border-radius:10px;padding:10px 12px;margin:10px 0}.agg-runh{font-size:12.5px}
@media(max-width:900px){.agg-grid2{grid-template-columns:1fr}.agg-cj-r{grid-template-columns:1fr 1fr}.agg-cj-r.head{display:none}.agg-tr,.agg-hist .agg-tr{grid-template-columns:1fr 1fr}.agg-tr.head{display:none}.agg-srch{grid-template-columns:1fr auto}.agg-srch .agg-in-l{grid-column:1}}
.usage-note{color:var(--muted);margin:0 0 14px}.usage-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}.usage-card{padding:18px;border:1px solid var(--line);background:var(--panel);border-radius:14px}.usage-card b{display:block;font:600 24px var(--mono);margin-bottom:5px}.usage-card span{color:var(--muted)}.usage-panel{margin-top:14px}.usage-panel .v-h{display:flex;align-items:center;justify-content:space-between}.usage-table{overflow:auto}.usage-row{display:grid;grid-template-columns:1.2fr 2fr .8fr .8fr 1.4fr;gap:12px;padding:11px 4px;border-top:1px solid var(--line);align-items:center}.usage-row.head{color:var(--muted);font-size:12px;border-top:0}.usage-ok{color:var(--green)}.usage-unknown{color:var(--amber)}.usage-trend{height:130px;display:flex;align-items:flex-end;gap:3px;padding-top:15px}.usage-bar{flex:1;min-width:3px;background:linear-gradient(180deg,var(--blue),var(--violet));border-radius:3px 3px 0 0;opacity:.85}.usage-empty{color:var(--muted);padding:18px 4px}@media(max-width:900px){.usage-cards{grid-template-columns:1fr}.usage-row{grid-template-columns:1fr 1fr}.usage-row.head{display:none}}
.app{display:grid;grid-template-columns:248px 1fr;height:100vh;overflow:hidden}
.rail{background:linear-gradient(180deg,var(--bg2),var(--bg));border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:6px;overflow-y:auto}
.newchat{display:flex;align-items:center;gap:8px;width:100%;background:var(--panel);border:1px solid var(--line2);color:var(--ink);padding:10px 12px;border-radius:10px;font-size:13px;font-weight:500;font-family:var(--body);cursor:pointer;margin:2px 0 12px;transition:border-color .15s,background .15s,color .15s}
.newchat:hover{border-color:var(--glow);color:var(--glow);background:rgba(59,130,246,.07)}
.newchat span{font-size:15px;line-height:1}
.brand{display:flex;gap:10px;align-items:center;margin-bottom:18px}
.logo{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,var(--glow),#5b8cff);color:#04121a;font-weight:800}
.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:.12em;text-transform:uppercase}
nav{display:flex;flex-direction:column;gap:3px;margin-top:6px}
.nav{text-align:left;background:transparent;border:0;color:var(--muted);padding:9px 11px;border-radius:8px;font-size:13px;cursor:pointer}
.nav:hover{color:var(--ink);background:rgba(255,255,255,.03)}
.nav.on{background:rgba(59,130,246,.12);color:var(--glow);font-weight:600}
.nav.dim{opacity:.4;cursor:default}
.nav-sep{color:var(--muted);font-size:9px;letter-spacing:.16em;text-transform:uppercase;margin:12px 11px 4px}
.rail-foot{margin-top:auto;color:var(--muted);font-size:10px;line-height:1.5}
main{display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 26px;border-bottom:1px solid var(--line)}
.tb-right{display:flex;gap:10px;align-items:center}
.op-pill{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);color:var(--green);border-radius:20px;padding:5px 13px;font-size:12px}
.clock-pill{background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--muted);border-radius:20px;padding:5px 13px;font-size:12px;font-family:ui-monospace,Menlo,monospace}
.ver-pill{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:var(--glow);border-radius:20px;padding:5px 13px;font-size:12px;font-family:ui-monospace,Menlo,monospace;font-weight:600}
.rail-agents{display:flex;flex-direction:column;gap:1px;margin-top:2px}
.ra{display:flex;gap:8px;align-items:center;font-size:11.5px;color:var(--muted);padding:4px 11px;border-radius:7px}
.ra:hover{background:rgba(255,255,255,.03);color:var(--ink)}
.sdot{width:7px;height:7px;border-radius:50%;flex:none}
.sdot.working{background:var(--green);box-shadow:0 0 6px rgba(52,211,153,.6)}.sdot.waiting{background:var(--amber)}.sdot.idle{background:var(--grey)}
.tab{flex:1;min-height:0;padding:26px;overflow-y:auto}
.tab.hidden{display:none!important}
/* Local credential manager — no stored value is ever rendered into the DOM. */
.cred-notice{border:1px solid rgba(52,211,153,.25);background:rgba(52,211,153,.06);border-radius:11px;padding:11px 13px;color:var(--muted);line-height:1.5;margin-bottom:14px}
.diag-panel{margin-bottom:14px}.diag-refresh{margin-left:auto;padding:5px 10px}.diag-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}.diag-item{border:1px solid var(--line);border-radius:9px;padding:10px 11px;background:rgba(255,255,255,.025)}.diag-item b{font-size:12.5px}.diag-item p{font-size:11.5px;color:var(--muted);line-height:1.4;margin-top:3px}.diag-item .diag-fix{color:var(--amber)}.diag-act{margin-top:8px;padding:5px 10px}.diag-state{float:right;font:9.5px var(--mono);text-transform:uppercase}.diag-item.healthy .diag-state{color:var(--green)}.diag-item.broken .diag-state{color:var(--red)}.diag-item.degraded .diag-state{color:var(--amber)}.diag-item.missing .diag-state{color:var(--grey)}
.cred-notice code,.cred-cline code{font-family:var(--mono);color:var(--ink)}
.cred-cline{margin-bottom:14px}.cred-cline-grid{display:grid;grid-template-columns:1fr 1.35fr;gap:18px;padding-top:10px}.cred-cline-grid b{font-size:13px}.cred-cline-grid p{margin:4px 0 9px;line-height:1.45}
.cline-auth-row{display:grid;grid-template-columns:130px 1fr 1fr auto;gap:7px}.cline-auth-row input,.cline-auth-row select,.cred-input{min-width:0;background:#0c1119;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);font:12px var(--body)}
.cline-auth-row input:focus,.cline-auth-row select:focus,.cred-input:focus{outline:none;border-color:var(--glow)}
.cred-btn,.cred-save{border:1px solid var(--glow);background:rgba(59,130,246,.14);color:var(--glow);border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer}.cred-btn:disabled,.cred-save:disabled{opacity:.5;cursor:wait}
.cred-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.cred-card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px}.cred-card-h{display:flex;justify-content:space-between;gap:8px;align-items:center}.cred-card-h b{font-size:14px}.cred-help{font-size:11.5px;color:var(--muted);margin:3px 0 10px}
.cred-row{display:grid;grid-template-columns:145px minmax(0,1fr) auto 72px;align-items:center;gap:8px;margin-top:7px}.cred-label{font-size:12px;color:var(--muted)}.cred-state{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.05em}.cred-state.on{color:var(--green)}.cred-state.off{color:var(--grey)}.cred-clear{font-size:10px;color:var(--muted);white-space:nowrap;display:flex;gap:4px;align-items:center}.cred-actions{display:flex;gap:12px;align-items:center;margin:15px 0 30px}.cred-out{font-size:12px;color:var(--muted);margin-top:8px}.cred-out.ok{color:var(--green)}.cred-out.bad{color:var(--red)}
@media (max-width:1100px){.cred-cline-grid,.cred-groups,.diag-checks{grid-template-columns:1fr}.cline-auth-row{grid-template-columns:1fr}.cred-row{grid-template-columns:125px minmax(0,1fr) auto}}
/* Chat pane — a full-height ChatGPT-style surface: scroll area + docked composer */
.tab.chatpane{padding:0;overflow:hidden;display:flex;flex-direction:column}
.chat-scroll{flex:1;min-height:0;overflow-y:auto}
.chat-col{max-width:768px;margin:0 auto;width:100%;padding:0 24px}
.chat-hero{min-height:56vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:15px;padding:24px 0}
.hero-logo{width:54px;height:54px;border-radius:15px;display:grid;place-items:center;background:linear-gradient(135deg,var(--glow),var(--violet));color:#04121a;font-size:25px;font-weight:800;box-shadow:0 8px 30px rgba(59,130,246,.25)}
#hero-greet{font-family:var(--display);font-size:31px;font-weight:750;letter-spacing:-.02em;color:var(--white,#f9fafb)}
.hero-sub{color:var(--muted);font-size:14px;max-width:460px;line-height:1.55}
.hero-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:580px;width:100%;margin-top:10px}
.hero-card{text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:13px 15px;cursor:pointer;transition:border-color .15s,background .15s,transform .1s;font-family:var(--body)}
.hero-card:hover{border-color:var(--glow);background:rgba(59,130,246,.06);transform:translateY(-1px)}
.hero-card b{display:block;font-size:13px;color:var(--ink);margin-bottom:2px;font-weight:600}
.hero-card span{color:var(--muted);font-size:11.5px;line-height:1.4}
.chat-scroll .convo{padding:22px 0 12px}
.chat-dock{border-top:1px solid var(--line);padding:14px 0 16px;background:rgba(2,4,10,.55);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.composer2{display:flex;align-items:flex-end;gap:8px;background:var(--panel);border:1px solid var(--line2);border-radius:22px;padding:7px 7px 7px 16px;transition:border-color .15s,box-shadow .15s}
.composer2:focus-within{border-color:var(--glow);box-shadow:0 0 0 3px rgba(59,130,246,.12)}
.composer2 textarea{flex:1;background:transparent;border:0;resize:none;color:var(--ink);font-family:var(--body);font-size:14.5px;line-height:1.5;max-height:184px;padding:7px 0;outline:none}
.composer2 textarea::placeholder{color:var(--muted)}
.send-btn{flex:none;width:34px;height:34px;border-radius:50%;border:0;background:var(--glow);color:#04121a;font-size:16px;font-weight:800;cursor:pointer;display:grid;place-items:center;transition:opacity .15s,transform .1s}
.send-btn:hover{transform:translateY(-1px)}
.send-btn:disabled{opacity:.35;cursor:default;transform:none}
.composer-hint{color:var(--muted);font-size:11px;text-align:center;margin-top:9px;line-height:1.5}
#focus-mini{color:var(--glow)}
.greet{font-size:22px;font-weight:650}
.greet span{color:var(--muted);font-weight:400}
.headline{margin:6px 0 18px;color:var(--glow);font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi-v{font-size:26px;font-weight:700}
.kpi-l{color:var(--muted);font-size:11px;margin-top:2px}
.kpi-d{color:var(--glow);font-size:10px;margin-top:3px;font-family:ui-monospace,Menlo,monospace}
.briefing{background:linear-gradient(180deg,rgba(59,130,246,.1),rgba(255,255,255,.02));border:1px solid rgba(59,130,246,.28);border-radius:12px;padding:12px 16px;margin:10px 0 14px}
.briefing-h{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--glow);margin-bottom:7px}
.briefing-l{font-size:13.5px;color:#dbe6f0;font-family:ui-monospace,Menlo,monospace;padding:2px 0}
.sigstrip{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 14px}
.sig{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--muted)}
.sig-dot{width:7px;height:7px;border-radius:50%;background:var(--grey);flex:none}
.sig.on{color:#d6f5ec;border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
.sig.on .sig-dot{background:var(--green);box-shadow:0 0 7px rgba(52,211,153,.7)}
.sig.warn{color:#f4e4b8;border-color:rgba(251,191,36,.32);background:rgba(251,191,36,.07)}
.sig.warn .sig-dot{background:var(--amber)}
.sig.off{opacity:.6}
.sig-d{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:10px}
.sig-at{color:var(--muted);font-size:10px;font-family:ui-monospace,Menlo,monospace;margin-left:auto}
.routing{background:rgba(91,140,255,.08);border:1px solid rgba(91,140,255,.25);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:12.5px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.routing b{color:#8fb0ff}
.route{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:8px;padding:2px 9px;font-size:11.5px}
.constraint{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:10px;padding:11px 14px;margin-bottom:18px;font-size:13px}
.cc-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:18px;align-items:start}
.brief-sec{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.brief-sec h4{font-size:13px;margin-bottom:8px}
.brief-sec ul{list-style:none;display:flex;flex-direction:column;gap:6px}
.brief-sec li{color:#c7cede;font-size:12.5px;line-height:1.45;padding-left:14px;position:relative}
.brief-sec li:before{content:"›";position:absolute;left:0;color:var(--muted)}
.approvals h3{font-size:14px;margin-bottom:12px;display:flex;gap:8px;align-items:center}
.approvals h3 span{background:var(--glow);color:#04121a;border-radius:20px;padding:1px 9px;font-size:12px;font-weight:700}
.appr{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:11px}
.appr.decided{opacity:.55}
.appr.settled-ok{border-color:var(--green);background:rgba(52,211,153,.14)}
.appr.settled-no{border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08);opacity:.7}
.settled-msg{font-size:13px;font-weight:700;color:#0f1720;background:var(--green);border-radius:8px;padding:8px 12px}
.appr.settled-no .settled-msg{background:transparent;color:var(--red)}
.appr-top{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.risk{margin-left:auto;font-size:10px;padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.05em}
.risk.high{background:rgba(248,113,113,.15);color:var(--red)}
.risk.medium{background:rgba(251,191,36,.15);color:var(--amber)}
.appr p{color:#b9c1d4;font-size:12.5px;line-height:1.45;margin-bottom:8px}
.appr-mode{font-size:10.5px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;margin-bottom:10px;opacity:.85}
.appr-actions{display:flex;gap:8px;align-items:center}
.approve,.deny{border:1px solid var(--line);background:#131a27;color:var(--ink);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600}
.approve:hover{border-color:var(--green);color:var(--green)}
.deny:hover{border-color:var(--red);color:var(--red)}
.verdict{font-size:12px;font-weight:700}
.muted{color:var(--muted)}
.nav-badge{background:var(--glow);color:#04121a;border-radius:20px;padding:0 7px;font-size:10px;font-weight:700;margin-left:4px}
.tasks-head{display:flex;align-items:center;gap:12px;margin:8px 0 16px}
.tasks-count{color:var(--muted);font-size:12px;font-family:ui-monospace,Menlo,monospace}
.run-btn{margin-left:auto;border:1px solid var(--glow);background:rgba(59,130,246,.12);color:var(--glow);border-radius:9px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer}
.run-btn:hover{background:rgba(59,130,246,.2)}
.run-btn:disabled{opacity:.5;cursor:default}
.tasklist{display:flex;flex-direction:column;gap:8px;max-width:900px}
.task{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 14px;color:var(--ink);transition:.12s}
.task:hover{border-color:rgba(59,130,246,.3);background:rgba(59,130,246,.05)}
.task-row{display:flex;align-items:center;gap:10px}
.task-n{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:12px;flex:none}
.task-t{font-size:13px;flex:1}
.tlabel{font-size:9.5px;color:var(--glow);background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:1px 7px}
.task-go{color:var(--muted);font-size:11px;flex:none;text-decoration:none}
.task-go:hover{color:var(--glow)}
.task-build{flex:none;border:1px solid rgba(199,146,234,.4);background:rgba(199,146,234,.1);color:#c792ea;border-radius:8px;padding:5px 12px;font-size:11.5px;font-weight:600;cursor:pointer}
.task-build:hover{background:rgba(199,146,234,.2)}
.task-build:disabled{opacity:.5;cursor:default}
.task-del{flex:none;border:1px solid rgba(248,113,113,.35);background:transparent;color:#f87171;border-radius:8px;padding:5px 9px;font-size:11.5px;font-weight:600;cursor:pointer;margin-left:4px}
.task-del:hover{background:rgba(248,113,113,.15)}
.task-del:disabled{opacity:.5;cursor:default}
.task-deleted{flex:none;color:#f87171;font-size:11px;margin-left:6px}
.pill{font-size:10px;padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.pill.working{background:rgba(52,211,153,.15);color:var(--green)}
.pill.waiting{background:rgba(251,191,36,.15);color:var(--amber)}
.pill.idle{background:rgba(100,116,139,.18);color:var(--grey)}
.agent-net{max-width:1200px;margin:0 auto}
.net-head{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.net-sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.ceo-card{background:linear-gradient(180deg,rgba(59,130,246,.09),rgba(255,255,255,.015));border:1px solid rgba(59,130,246,.22);border-radius:18px;box-shadow:0 14px 44px rgba(0,0,0,.35);padding:20px 24px;max-width:760px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:24px}
.ceo-left{display:flex;gap:15px;align-items:flex-start}
.icon-tile{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-size:17px;flex:none}
.ceo-tile{width:46px;height:46px;font-size:22px;background:rgba(59,130,246,.14);color:var(--glow);box-shadow:0 0 22px rgba(59,130,246,.25)}
.ceo-name{font-size:18px;font-weight:700;margin-top:8px}
.command-label{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--glow);margin:3px 0 7px}
.ceo-desc{color:var(--muted);font-size:12px;max-width:340px;line-height:1.5}
.stats{display:flex;gap:10px;flex:none}
.stat{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:12px;padding:9px 13px;text-align:center;min-width:70px}
.stat .sv{font-size:19px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.stat .sl{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-top:3px}
.stat-model .sv{font-size:12px;padding-top:5px}
.spine{width:2px;height:30px;background:linear-gradient(rgba(59,130,246,.55),rgba(255,255,255,.1));margin:16px auto 0}
.depts{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:18px;width:100%;border-top:1px solid var(--line);padding-top:28px;margin-top:8px}
.dept-card{background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.008));border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:7px;transition:.15s}
.dept-card:hover{border-color:rgba(255,255,255,.16);transform:translateY(-2px)}
.dc-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
.dc-title{font-size:14px;font-weight:650}
.role-label{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
.dc-tag{color:#aab2c4;font-size:12px;line-height:1.45;margin-top:2px}
.dc-model{color:#9aa4b8;font-size:9.5px;font-family:ui-monospace,Menlo,monospace;margin-top:3px}
.dc-tools{display:flex;flex-wrap:wrap;gap:5px;margin-top:3px}
.tchip{font-size:9px;color:var(--glow);background:rgba(59,130,246,.07);border:1px solid rgba(59,130,246,.17);border-radius:6px;padding:2px 6px;font-family:ui-monospace,Menlo,monospace}
.dc-expand{margin-top:7px;align-self:flex-start;background:transparent;border:0;color:var(--muted);font-size:11px;cursor:pointer;padding:0}
.dc-expand:hover{color:var(--ink)}
.dc-workers{display:flex;flex-direction:column;gap:8px;margin-top:8px;border-top:1px solid var(--line);padding-top:10px}
.dc-workers[hidden]{display:none}
.frontier{color:var(--amber)}
.steer{background:rgba(59,130,246,.09);border:1px solid rgba(59,130,246,.3);border-radius:10px;padding:11px 14px;margin-bottom:10px;font-size:13px}
.steer b{color:var(--glow)}
.wk .wn{display:flex;gap:7px;align-items:center;font-size:12px}
.wk .wn b{font-weight:600}
.wk .wt{color:var(--muted);font-size:10.5px;margin:3px 0 0 14px;line-height:1.35}
.ask-bar{display:flex;gap:8px;margin:12px 0 10px;max-width:980px}
.ask-bar input{flex:1;background:#0c1119;border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--ink);font-size:13.5px}
.ask-bar input:focus{outline:none;border-color:var(--glow)}
.ask-bar button{border:1px solid var(--glow);background:rgba(59,130,246,.14);color:var(--glow);border-radius:10px;padding:0 18px;font-weight:600;cursor:pointer}
.ask-out{max-width:980px;background:linear-gradient(180deg,rgba(59,130,246,.09),rgba(255,255,255,.02));border:1px solid rgba(59,130,246,.3);border-radius:12px;padding:13px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.55}
.ask-out .cites{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.ask-cite{font-size:10.5px;font-family:ui-monospace,Menlo,monospace;color:#9fe8d9;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.22);border-radius:6px;padding:2px 8px;cursor:pointer}
.ask-cite:hover{background:rgba(59,130,246,.16)}
.vault-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.v-col{display:flex;flex-direction:column;gap:14px;min-width:0}
.v-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.v-h{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--glow);margin-bottom:9px;display:flex;gap:10px;align-items:baseline}
.v-hint{color:var(--muted);letter-spacing:.02em;text-transform:none;font-size:10.5px;margin-left:auto}
.v-count{color:var(--muted);letter-spacing:.02em;text-transform:none;font-family:ui-monospace,Menlo,monospace}
.v-body{max-height:300px;overflow-y:auto;font-size:12.5px}
.v-week-day{font-family:ui-monospace,Menlo,monospace;color:#c792ea;font-size:11px;margin:8px 0 4px}
.v-week-e{padding:5px 0 5px 12px;border-left:2px solid rgba(199,146,234,.3);margin-bottom:4px}
.v-week-e b{display:block;font-size:12.5px;color:#e6e9f2}
.v-week-e span{color:var(--muted);font-size:11.5px;line-height:1.4}
.v-dec{padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.v-dec .d-date{font-family:ui-monospace,Menlo,monospace;color:#ffb454;font-size:10.5px;margin-right:8px}
.v-dec b{color:#f4e4c8;font-size:12.5px}
.v-dec .d-detail{color:var(--muted);font-size:11.5px;margin-top:2px;line-height:1.4}
.v-dec .d-sec{font-size:9.5px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-left:6px}
.v-search{width:100%;background:#0c1119;border:1px solid var(--line);border-radius:8px;padding:8px 11px;color:var(--ink);font-size:12.5px;margin-bottom:9px}
.v-search:focus{outline:none;border-color:var(--glow)}
.v-facts{max-height:340px}
.v-subj{margin-bottom:10px}
.v-subj-h{font-weight:700;color:#7ee0c0;font-size:12.5px;padding:3px 0;cursor:pointer}
.v-subj-h:hover{color:var(--glow)}
.v-fact{display:flex;gap:8px;padding:2px 0 2px 12px;border-left:2px solid rgba(126,224,192,.25)}
.v-fact .fp{color:#8fb0ff;font-family:ui-monospace,Menlo,monospace;font-size:11px;flex:none}
.v-fact .fo{color:#c7cede;font-size:12px;line-height:1.4;word-break:break-word}
.v-map{margin-bottom:8px}
#vault{width:100%;height:46vh;display:block;background:var(--bg2);border:1px solid var(--line);border-radius:12px;cursor:grab}
#vault.dragging{cursor:grabbing}
@media (max-width:1000px){.vault-grid{grid-template-columns:1fr}}
.focus-tag{background:rgba(52,211,153,.09);border:1px solid rgba(52,211,153,.28);border-radius:10px;padding:9px 13px;margin:-6px 0 16px;font-size:12.5px;color:#c7cede}
.focus-tag b{color:var(--green)}
.focus-tag a{color:var(--glow);cursor:pointer;margin-left:6px}
.focus-now{color:var(--muted);margin:8px 0 14px;font-size:13px}.focus-now b{color:var(--green)}
.presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.preset{border:1px solid var(--line);background:#131a27;color:var(--ink);padding:8px 13px;border-radius:20px;cursor:pointer;font-size:12.5px}
.preset:hover{border-color:var(--glow);color:var(--glow)}
.preset.active{background:rgba(59,130,246,.14);border-color:var(--glow);color:var(--glow);font-weight:600}
.convo{display:flex;flex-direction:column;gap:24px}
.msg{display:flex;flex-direction:column;animation:brin .2s ease}
.msg.you{align-items:flex-end}
.ubub{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.22);border-radius:16px 16px 5px 16px;padding:10px 15px;font-size:14.5px;line-height:1.55;max-width:82%;white-space:pre-wrap;word-break:break-word}
.m-role{font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.02em;margin-bottom:8px;display:flex;align-items:center;gap:7px}
.m-role .rdot{color:var(--glow);font-size:12px}
.m-body{font-size:14.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.bubble{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 13px;font-size:13px;line-height:1.5;flex:1}
.rolebadge{font-size:9.5px;padding:1px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-right:8px}
.rolebadge.lead{background:rgba(52,211,153,.16);color:var(--green)}
.rolebadge.support{background:rgba(91,140,255,.16);color:#5b8cff}
.rolebadge.hold{background:rgba(251,191,36,.16);color:var(--amber)}
.composer{display:flex;gap:8px;max-width:840px;margin-top:18px}
.composer input{flex:1;background:#0c1119;border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--ink);font-size:13px}
.composer input:focus{outline:none;border-color:var(--glow)}
.composer button{border:1px solid var(--glow);background:rgba(59,130,246,.14);color:var(--glow);border-radius:10px;padding:0 18px;font-weight:600;cursor:pointer}
.composer-note{color:var(--muted);font-size:11px;margin-top:8px;max-width:840px;line-height:1.5}
.engbadge{display:inline-block;margin-left:8px;font-size:9.5px;font-family:ui-monospace,Menlo,monospace;color:var(--glow);background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);border-radius:6px;padding:1px 6px;vertical-align:middle}
.build-tag{display:inline-block;margin-bottom:8px;font-size:10px;font-family:ui-monospace,Menlo,monospace;color:#c792ea;background:rgba(199,146,234,.1);border:1px solid rgba(199,146,234,.3);border-radius:6px;padding:2px 8px}
.build-status{margin-top:9px;font-size:12px;border-radius:9px;padding:9px 12px;line-height:1.45}
.build-status[hidden]{display:none}
.build-status .bs-h{font-weight:700;display:flex;align-items:center;gap:7px}
.build-status .bs-log{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted);margin-top:6px;white-space:pre-wrap;max-height:96px;overflow:auto}
.build-status.bs-building{background:rgba(199,146,234,.1);border:1px solid rgba(199,146,234,.32);color:#e6d3f5}
.build-status.bs-ready{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.4);color:#c9f5e4}
.build-status.bs-failed{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.4);color:#f7d0d0}
.build-status.bs-refused{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.4);color:#f7e3b8}
.build-status.bs-closed{background:rgba(100,116,139,.12);border:1px solid rgba(100,116,139,.4);color:#cbd3e0}
.build-status a{color:inherit;text-decoration:underline}
.bs-spin{width:11px;height:11px;border:2px solid rgba(199,146,234,.35);border-top-color:#c792ea;border-radius:50%;display:inline-block;animation:bs-rot .7s linear infinite}
@keyframes bs-rot{to{transform:rotate(360deg)}}
.overnight{background:linear-gradient(180deg,rgba(91,140,255,.12),rgba(255,255,255,.02));border:1px solid rgba(91,140,255,.32);border-radius:12px;padding:13px 16px;margin:10px 0 14px}
.ov-h{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8fb0ff;margin-bottom:7px;display:flex;gap:10px;align-items:center}
.ov-when{color:var(--muted);letter-spacing:.04em;font-family:ui-monospace,Menlo,monospace;text-transform:none}
.ov-headline{font-size:13.5px;color:#dbe6f0;margin-bottom:8px}
.ov-sec{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.ov-lbl{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-right:2px}
.ov-pr{font-size:12px;color:#c9f5e4;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.32);border-radius:7px;padding:3px 9px;text-decoration:none}
.ov-pr:hover{background:rgba(52,211,153,.18)}
.ov-pr b{color:var(--green)}
.ov-item{font-size:12px;color:#c7cede;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:7px;padding:3px 9px}
.ov-fail .ov-item{color:#f7d0d0;background:rgba(248,113,113,.09);border-color:rgba(248,113,113,.3)}
.directives{background:linear-gradient(180deg,rgba(199,146,234,.12),rgba(255,255,255,.02));border:1px solid rgba(199,146,234,.3);border-radius:12px;padding:11px 15px;margin:10px 0 14px}
.dir-h{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#c792ea;margin-bottom:6px}
.dir-l{font-size:12.5px;color:#e6d3f5;font-style:italic;padding:2px 0}
/* --- glassmorphism pass: frost + light edges --- */
.dept-card,.ceo-card,.kpi,.appr,.brief-sec,.bubble,.stat,.steer,.constraint,.focus-tag{
  backdrop-filter:blur(18px) saturate(1.5);-webkit-backdrop-filter:blur(18px) saturate(1.5)}
.dept-card,.kpi,.appr,.brief-sec,.stat{
  background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.13);
  box-shadow:0 12px 36px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.12),inset 0 0 24px rgba(255,255,255,.015)}
.bubble{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}
.dept-card:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.22)}
.ceo-card{background:linear-gradient(155deg,rgba(59,130,246,.14),rgba(255,255,255,.05));border:1px solid rgba(59,130,246,.32);
  box-shadow:0 20px 60px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18),0 0 52px rgba(59,130,246,.12)}
.rail{background:rgba(10,15,26,.5);backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3)}
.topbar{backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);background:rgba(7,11,20,.35)}
.op-pill,.clock-pill,.preset,.tchip,.icon-tile{backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.kpi,.dept-card,.ceo-card{position:relative;overflow:hidden}
.kpi::after,.dept-card::after,.ceo-card::after{content:"";position:absolute;top:0;left:0;right:0;height:40%;
  background:linear-gradient(180deg,rgba(255,255,255,.06),transparent);pointer-events:none}
@media (max-width:900px){.app{grid-template-columns:1fr}.rail{display:none}.kpis,.depts{grid-template-columns:repeat(2,1fr)}.cc-grid{grid-template-columns:1fr}.msg .who{width:90px}}
/* Streaming Board Room agent — the live thought process + tool calls (Claude-style), then the answer */
.msg .agent{flex:1;display:flex;flex-direction:column;gap:8px;min-width:0}
.trace{display:flex;flex-direction:column;gap:6px}
.trace:empty{display:none}
.tstatus{font-family:var(--mono);font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:8px}
.tstatus::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--glow);box-shadow:0 0 10px var(--glow);animation:brpulse 1.4s infinite}
.tchip{background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.16);border-radius:10px;padding:7px 11px;font-size:12px;color:var(--ink);display:flex;flex-wrap:wrap;align-items:center;gap:8px;animation:brin .25s ease}
.tchip .ti{font-size:12px;line-height:1}
.tchip .tn{font-family:var(--mono);font-size:11px;color:var(--glow);font-weight:500}
.tchip .ts{font-family:var(--mono);font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.tres{width:100%;font-family:var(--mono);font-size:10.5px;color:var(--muted);opacity:.85;padding-left:20px;margin-top:2px;white-space:pre-wrap;word-break:break-word}
.tres.bad{color:var(--red)}
.answer{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 14px;font-size:13.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.answer:empty{display:none}
.aerr{color:var(--red);font-size:12.5px;margin-top:6px}
.degnote{font-size:11.5px;color:var(--amber);background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.22);border-radius:8px;padding:7px 10px;line-height:1.5}
.convo-empty{color:var(--muted);font-size:13px;line-height:1.7;padding:6px 0;display:flex;flex-direction:column;align-items:flex-start;gap:9px}
.convo-empty .ex{background:rgba(59,130,246,.07);border:1px solid rgba(59,130,246,.18);color:var(--ink);border-radius:20px;padding:7px 14px;font-size:12.5px;cursor:pointer;text-align:left;font-family:var(--body)}
.convo-empty .ex:hover{border-color:var(--glow);color:var(--glow)}
@keyframes brpulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes brin{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
/* Markdown rendering in answers */
.answer p{margin:0 0 9px}.answer p:last-child{margin-bottom:0}
.answer ul,.answer ol{margin:4px 0 10px;padding-left:22px}.answer li{margin:3px 0;line-height:1.55}
.answer h3,.answer h4,.answer h5{font-family:var(--display);margin:13px 0 6px;font-weight:700;line-height:1.25;color:var(--white,#f9fafb)}
.answer h3{font-size:17px}.answer h4{font-size:15px}.answer h5{font-size:13.5px}
.answer h3:first-child,.answer h4:first-child,.answer p:first-child{margin-top:0}
.answer a{color:var(--glow);text-decoration:none;border-bottom:1px solid rgba(59,130,246,.4)}.answer a:hover{border-bottom-color:var(--glow)}
.answer code{font-family:var(--mono);font-size:12.5px;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.answer pre{background:rgba(0,0,0,.32);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-x:auto;margin:8px 0}
.answer pre code{background:none;border:0;padding:0;font-size:12.5px;line-height:1.5;display:block;white-space:pre}
.answer strong{color:var(--white,#f9fafb);font-weight:650}
/* Message actions (copy / retry / engine badge) */
.m-actions{display:flex;align-items:center;gap:8px;margin-top:11px;flex-wrap:wrap}
.m-act{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:var(--body);transition:border-color .15s,color .15s}
.m-act:hover{border-color:var(--glow);color:var(--glow)}
.engbadge.owned{color:var(--green);background:rgba(52,211,153,.1);border-color:rgba(52,211,153,.28)}
.send-btn.stopping{background:var(--red);color:#1a0606}
/* ✦ Creator Library — ranked, cited insights (cross-creator panel + per-creator tab) */
.ci-panel{margin:0 0 14px}
.ci-head{font-size:12.5px;color:var(--muted);margin-bottom:8px;line-height:1.5}.ci-head b{color:var(--ink)}
.ci-meet{font-size:12px;color:var(--muted);background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.25);border-radius:9px;padding:7px 10px;margin-bottom:10px;line-height:1.5}.ci-meet b{color:var(--ink)}
.ci-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;align-items:center}
.ci-f{font-size:11.5px;padding:3px 9px;border-radius:20px;border:1px solid var(--line);background:var(--panel);color:var(--muted);cursor:pointer}
.ci-f.on{color:var(--ink);border-color:var(--glow)}
.ci-sel{font-size:11.5px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:3px 6px;margin-left:auto}
.ci-list{display:flex;flex-direction:column;gap:8px;max-height:62vh;overflow:auto}
.ci-card{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--grey);border-radius:10px;padding:10px 12px;min-width:0}
.ci-card.strong{border-left-color:var(--green)}.ci-card.moderate{border-left-color:var(--glow)}.ci-card.emerging{border-left-color:var(--amber)}
.ci-top{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.ci-claim{font-size:13.5px;font-weight:600;line-height:1.45;color:var(--ink);flex:1 1 260px;min-width:0}
.ci-badge{flex:none;font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.04em;border-radius:5px;padding:2px 7px;border:1px solid var(--line);color:var(--muted)}
.ci-badge.strong{color:var(--green);border-color:rgba(52,211,153,.35)}.ci-badge.moderate{color:var(--glow);border-color:rgba(59,130,246,.4)}.ci-badge.emerging{color:var(--amber);border-color:rgba(251,191,36,.35)}
.ci-used{flex:none;font:600 9.5px var(--mono);color:var(--indigo);border:1px solid rgba(99,102,241,.35);border-radius:5px;padding:2px 7px}
.ci-sup{margin-top:5px;font-size:12px;color:var(--muted);line-height:1.5}.ci-sup b{color:var(--ink);font-weight:600}
.ci-detail{margin-top:4px;font-size:12px;color:var(--muted);line-height:1.45}
.ci-cites{margin-top:6px;display:flex;flex-direction:column;gap:3px}
.ci-cite{font-size:11.5px;color:var(--muted);padding-left:9px;border-left:2px solid var(--line);overflow-wrap:anywhere}.ci-cite a{color:var(--glow)}
.ci-caveat{margin-top:10px;font-size:11px}
/* --- Creator Library v2: verdicts, discovery, prune, key points --- */
.ig-tools{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px;margin:0 0 14px}
@media (max-width:1000px){.ig-tools{grid-template-columns:minmax(0,1fr)}}
.ig-disc-bar{display:flex;gap:8px;margin-bottom:8px}.ig-disc-bar input{flex:1;min-width:0}
.ig-vd{display:inline-block;font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.04em;border-radius:5px;padding:1px 6px;border:1px solid var(--line);color:var(--muted);margin-left:4px;vertical-align:1px}
.ig-vd.keep{color:var(--green);border-color:rgba(52,211,153,.4)}.ig-vd.prune{color:var(--red);border-color:rgba(248,113,113,.45)}.ig-vd.pending{color:var(--amber);border-color:rgba(251,191,36,.4)}.ig-vd.archived{color:var(--grey)}
.ig-acct-why{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.35}
.ig-acct-note{font-size:11px;color:var(--amber);margin-top:3px;line-height:1.35}
.ig-dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}@media (max-width:760px){.ig-dl{grid-template-columns:minmax(0,1fr)}}
.ig-dh{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:4px 0 6px}
.ig-dc{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:7px 9px;margin-bottom:6px;font-size:12.5px;min-width:0;overflow-wrap:anywhere}
.ig-dc label{display:flex;gap:7px;align-items:flex-start;cursor:pointer}.ig-dc b{color:var(--ink)}
.ig-dc .ig-dr{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.4}.ig-dc .ig-da{font-size:11.5px;margin-top:3px;color:var(--indigo)}.ig-dc a{color:var(--glow)}
.ig-dstep{font-size:11.5px;color:var(--muted);margin:2px 0}
.ig-prune-row{font-size:12px;margin:3px 0;line-height:1.4;overflow-wrap:anywhere}.ig-prune-row b{color:var(--ink)}
.ig-un{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin-bottom:7px;font-size:12.5px}
.ig-un .ig-un-r{font-size:11.5px;color:var(--muted);margin-top:3px}.ig-un .ig-un-b{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
.kp-verdict{font-size:12.5px;border:1px solid var(--line);border-radius:9px;padding:7px 10px;margin-bottom:10px;line-height:1.5}
.kp-verdict.prune{border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.05)}.kp-verdict.keep{border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.04)}
/* --- Creator Intelligence Library (Instagram) --- */
.ig-doctor{margin:6px 0 12px}
.ig-doc-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.ig-chips{display:flex;gap:6px;flex-wrap:wrap}
.ig-chip{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--line);background:var(--panel);color:var(--muted)}
.ig-chip.ok{color:var(--green);border-color:rgba(52,211,153,.35)}
.ig-chip.bad{color:var(--red);border-color:rgba(248,113,113,.35)}
.ig-chip.warn{color:var(--amber);border-color:rgba(251,191,36,.3)}
.ig-grid{display:grid;grid-template-columns:280px 1fr;gap:14px;align-items:start}
.ig-col-accounts .v-body{max-height:70vh;overflow:auto;display:flex;flex-direction:column;gap:6px}
.ig-acct{text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px;color:var(--ink);cursor:pointer}
.ig-acct:hover{border-color:var(--glow)}
.ig-acct.on{border-color:var(--glow);box-shadow:0 0 0 1px var(--glow) inset}
.ig-acct-u{font-weight:600}
.ig-acct-m{font-size:11px;color:var(--muted);margin-top:2px}
.ig-acct-w{font-size:11px;color:var(--amber);margin-top:2px}
.ig-ro{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:0 5px}
.ig-stats{font-size:12px;color:var(--muted);margin-bottom:10px}
.ig-search-row{margin-bottom:10px}
.ig-search-out{margin-top:6px;display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.ig-sr,.ig-brief,.ig-kn{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:13px}
.ig-kgroup{margin:14px 0 7px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.ig-kmeta{margin-top:3px;font-size:11px;color:var(--muted)}.ig-kcite{margin-top:6px;padding-left:10px;border-left:2px solid var(--line);font-size:11px;color:var(--muted)}
.ig-sub{font-weight:600;margin:14px 0 6px;font-size:13px}
.ig-sub2{font-weight:600;margin:8px 0 4px;font-size:12px}
.ig-briefs,.ig-reports{display:flex;flex-direction:column;gap:6px}
.ig-reports{flex-direction:row;flex-wrap:wrap}
.ig-report{font-size:12px;color:var(--glow);border:1px solid var(--line);border-radius:8px;padding:3px 8px;text-decoration:none}
.ig-badge{font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid var(--line);color:var(--muted)}
.ig-badge.ok{color:var(--green);border-color:rgba(52,211,153,.35)}
.ig-badge.warn{color:var(--amber);border-color:rgba(251,191,36,.3)}
.ig-videos{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.ig-vid{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px}
.ig-vid-top{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--muted)}
.ig-vid-cap{font-size:12px;margin:6px 0;line-height:1.35}
.ig-vid-m{font-size:11px;color:var(--muted)}
.ig-vid-m a,.ig-art a{color:var(--glow)}
.ig-vid-open{margin-top:6px;font-size:11px;background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:3px 8px;cursor:pointer}
.ig-vid-detail{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
.ig-player{width:100%;border-radius:8px;background:#000;max-height:320px}
.ig-ev{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.ig-ev-row{font-size:12px;display:flex;gap:8px}
.ig-ev-ts{color:var(--glow);flex:0 0 auto;font-variant-numeric:tabular-nums}
.ig-ev-c{color:var(--ink)}
.ig-art{margin-top:8px;font-size:12px}
@media (max-width:900px){.ig-grid{grid-template-columns:1fr}}
/* explorer tabs + gallery + modal + cleanup/delete */
.ig-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:10px}
.ig-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:6px 10px;cursor:pointer;font-size:13px}
.ig-tab:hover{color:var(--ink)}
.ig-tab.on{color:var(--ink);border-bottom-color:var(--glow)}
.ig-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.ig-gcard{text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0;overflow:hidden;color:var(--ink);cursor:pointer}
.ig-gcard:hover{border-color:var(--glow)}
.ig-gthumb{position:relative;aspect-ratio:9/16;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.ig-gthumb img{width:100%;height:100%;object-fit:cover}
.ig-gnothumb{font-size:28px;opacity:.5}
.ig-play{position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:11px}
.ig-gcap{font-size:12px;padding:6px 8px 2px;line-height:1.3}
.ig-gm{font-size:11px;color:var(--muted);padding:0 8px 8px}
.ig-modal{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
.ig-modal-box{background:var(--bg2);border:1px solid var(--line);border-radius:14px;max-width:760px;width:100%;max-height:90vh;overflow:auto;position:relative;padding:16px}
.ig-modal-x{position:absolute;top:8px;right:12px;background:transparent;border:0;color:var(--muted);font-size:24px;cursor:pointer;line-height:1}
.ig-modal-x:hover{color:var(--ink)}
.ig-noplayer{background:var(--panel);border:1px dashed var(--line);border-radius:8px;padding:16px;text-align:center;color:var(--muted)}
.ig-mcap{font-size:13px;margin:8px 0;line-height:1.4;white-space:pre-wrap}
.ig-panelbox{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.ig-btn{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px}
.ig-btn:hover{border-color:var(--glow)}
.ig-btn-danger{border-color:rgba(248,113,113,.5);color:var(--red)}
.ig-btn-danger:hover{border-color:var(--red);background:rgba(248,113,113,.08)}
.ig-danger{margin-top:10px}
.ig-confirm{margin-top:8px;font-size:13px;background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:8px 10px}
.ig-confirm code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px}
.ig-cleanup-plan{margin-top:8px;font-size:13px}
.ig-files{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.ig-fentry{display:block;text-align:left;background:transparent;border:0;color:var(--ink);padding:4px 6px;border-radius:6px;font-size:13px;text-decoration:none;cursor:default}
.ig-fdir,.ig-ffile{cursor:pointer}
.ig-fdir:hover,.ig-ffile:hover{background:var(--panel)}
.ig-ffile{color:var(--glow)}
.ig-fother{color:var(--muted)}
.ig-crumb{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.ig-crumb-up{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px}
.refresh-chip{position:fixed;right:18px;bottom:86px;z-index:60;background:var(--panel);border:1px solid var(--glow);color:var(--ink);border-radius:999px;padding:8px 14px;cursor:pointer;font-size:12px;box-shadow:0 4px 24px rgba(59,130,246,.35)}
.refresh-chip:hover{background:var(--glow);color:#02040a}
.intel-workflows{display:grid;gap:12px;padding:0 28px 32px}.intel-card{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:14px}.intel-card h3{font-size:14px;margin:5px 0}.intel-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px}.intel-state{font-family:var(--mono);color:var(--glow)}.intel-card details{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}.intel-card pre{white-space:pre-wrap;word-break:break-word;color:var(--muted);font:11px/1.5 var(--mono);max-height:240px;overflow:auto}.intel-actions{margin-top:10px}.intel-actions button{background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:7px;padding:5px 9px;cursor:pointer}.intel-actions button:hover{border-color:var(--glow)}
</style>`;

const SCRIPT = `<script>
const GRAPH=${JSON.stringify(state.memoryGraph).replace(/</g, '\\u003c')};
const FOCUSES=${JSON.stringify(state.customFocus ? { ...FOCUSES, custom: state.customFocus } : FOCUSES).replace(/</g, '\\u003c')};
const DEPT_TITLES=${JSON.stringify(DEPT_TITLES).replace(/</g, '\\u003c')};
const FDEPT_COLOR=${JSON.stringify(DEPT_COLOR).replace(/</g, '\\u003c')};
let CUR_FOCUS=${JSON.stringify(state.focusId || 'users')};
window.showTab=function(name){
  if(name==='aggregation'){name='search';var adv=document.getElementById('agg-adv');if(adv)adv.open=true;}
  document.querySelectorAll('.nav').forEach(function(n){n.classList.remove('on');});
  var nb=document.querySelector('.nav[data-tab="'+name+'"]');if(nb)nb.classList.add('on');
  document.querySelectorAll('.tab').forEach(function(t){t.classList.add('hidden');});
  var tab=document.getElementById('tab-'+name);if(tab)tab.classList.remove('hidden');
  // Fresh data exactly when it's wanted: the Command Center is the only baked-stale tab, so a pending
  // refresh applies on navigation TO it (never mid-stream, never over a draft) — tab/draft survive.
  if(name==='cc'&&typeof PENDING_REFRESH!=='undefined'&&PENDING_REFRESH
    &&!(typeof ACTIVE_ABORT!=='undefined'&&ACTIVE_ABORT)
    &&((document.getElementById('directive')||{}).value||'').trim()===''){softReload();return;}
  if(name==='vault')loadVault();
  if(name==='boardroom'){renderFocus(CUR_FOCUS,null);if(window.loadConversation)window.loadConversation();}
  if(name==='tasks'&&window.loadTasks)window.loadTasks();
  if(name==='instagram'&&window.loadInstagram)window.loadInstagram();
  if(name==='usage'&&window.loadAIUsage)window.loadAIUsage();
  if(name==='intelligence'&&window.loadIntelligence)window.loadIntelligence();
  if(name==='home'&&window.loadHome)window.loadHome();
  if(name==='search'){if(window.loadSearch)window.loadSearch();var adv2=document.getElementById('agg-adv');if(adv2&&adv2.open&&window.loadAggregation)window.loadAggregation();}
  if(name==='notifications'&&window.loadNotifications)window.loadNotifications();
  if(name==='jobs'&&window.loadJobs)window.loadJobs();
  if(window.brainTab)window.brainTab(name);
  if(name==='money'&&window.loadMoney)window.loadMoney();
  if(name==='tickets'&&window.loadTickets)window.loadTickets();
  if(name==='growth'&&window.loadGrowth)window.loadGrowth();
  if(name==='settings'){if(window.loadCredentials)window.loadCredentials();if(window.loadDiagnostics)window.loadDiagnostics();}
};
document.querySelectorAll('.nav[data-tab]').forEach(function(b){b.onclick=function(){window.showTab(b.dataset.tab);};});
function brEsc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function focusFromText(t){t=(t||'').toLowerCase();
  if(/pa(y|id)|revenue|mrr|money|convert|sales/.test(t))return 'revenue';
  if(/reten|activat|churn|keep|onboard|engage/.test(t))return 'retention';
  if(/reliab|uptime|cost|scal|infra|stable|stability/.test(t))return 'reliability';
  if(/user|signup|sign up|grow|traffic|acquisition|audience/.test(t))return 'users';
  return null;}
var BR_ROLE={lead:0,support:1,hold:2};
// ChatGPT-style empty state: a greeting + a few suggestion cards. Clicking one sends it.
var HERO_CARDS=[
  ['Is the latest PR safe to merge?','deterministic merge check — instant'],
  ['Review seen command updates','the activity ledger, digested'],
  ["What's failing or broken right now?",'GitHub CI + deploys'],
  ['What PRs and tasks are open?','both repos, live'],
  ['What do we know about ghost rate?','searches the shared brain'],
  ['Forge status','is the owned coding engine ready?']
];
function renderHeroCards(){var h=document.getElementById('hero-cards');if(!h)return;h.innerHTML='';
  HERO_CARDS.forEach(function(c){var b=document.createElement('button');b.className='hero-card';b.innerHTML='<b></b><span></span>';b.querySelector('b').textContent=c[0];b.querySelector('span').textContent=c[1];b.onclick=function(){if(window.askBoardRoom)window.askBoardRoom(c[0]);};h.appendChild(b);});}
function showHero(on){var hero=document.getElementById('chat-hero');if(hero)hero.style.display=on?'':'none';}
// Focus is a quiet indicator in the composer hint now — change it by typing "set focus to <x>".
function renderFocus(id){var f=FOCUSES[id];var fm=document.getElementById('focus-mini');if(fm)fm.textContent=f?('\\u2002·\\u2002Focus: '+f.title):'';}
function brSet(id){CUR_FOCUS=id;renderFocus(id);var ft=document.querySelector('.focus-tag b');if(ft&&FOCUSES[id])ft.textContent=FOCUSES[id].title;}
window.__brSet=brSet;
var CHAT_FRESH=false, FORCE_EMPTY=false;
function autogrow(t){if(!t)return;t.style.height='auto';t.style.height=Math.min(t.scrollHeight,184)+'px';}
(function(){var send=document.getElementById('send-directive');var inp=document.getElementById('directive');
  function fire(){if(ACTIVE_ABORT){try{ACTIVE_ABORT.abort();}catch(_){}return;}var t=(inp.value||'').trim();if(t&&window.askBoardRoom)window.askBoardRoom(t);inp.value='';autogrow(inp);inp.focus();}
  if(send)send.onclick=fire;
  if(inp){inp.addEventListener('input',function(){autogrow(inp);});
    inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();fire();}});}
  var nc=document.getElementById('new-chat');
  if(nc)nc.onclick=function(){FORCE_EMPTY=true;CHAT_FRESH=true;if(window.showTab)window.showTab('boardroom');var i=document.getElementById('directive');if(i){i.value='';autogrow(i);i.focus();}};
})();
// Board Room is the landing tab — initialize it on load (showTab only fires on a click). Deferred so the
// later-defined window.loadConversation is ready.
// Home is the landing tab now; the Board Room loads its history the first time it is opened.
setTimeout(function(){try{renderHeroCards();renderFocus(CUR_FOCUS);if(location.protocol.indexOf('http')===0&&window.loadHome)window.loadHome();
  var adv=document.getElementById('agg-adv');if(adv)adv.addEventListener('toggle',function(){if(adv.open&&window.loadAggregation)window.loadAggregation();});
  if(/Electron/.test(navigator.userAgent))document.documentElement.classList.add('electron');}catch(_){}},0);
var LIVE=location.protocol.indexOf('http')===0; // served by the local server → API is live
// --- AI Usage & Credits ---------------------------------------------------------------
function usageMoney(n){return '$'+Number(n||0).toFixed(Number(n||0)<1?4:2)}
window.loadAIUsage=function(){var note=document.getElementById('usage-note');if(!LIVE){if(note)note.textContent='Launch the Seen Command app for live usage.';return;}if(note)note.textContent='Refreshing observed usage…';fetch('/api/ai-usage').then(function(r){return r.json();}).then(function(d){
  note.textContent=d.disclaimer||'';var t=d.total||{};document.getElementById('usage-cards').innerHTML='<div class="usage-card"><b>'+Number(t.requests||0).toLocaleString()+'</b><span>requests observed · 30 days</span></div><div class="usage-card"><b>'+Number(t.tokens||0).toLocaleString()+'</b><span>tokens reported</span></div><div class="usage-card"><b>'+usageMoney(t.costUsd)+'</b><span>observed model cost</span></div>';
  var daily=d.daily||[],mx=Math.max.apply(null,daily.map(function(x){return x.costUsd||x.requests||0}).concat([1]));document.getElementById('usage-trend').innerHTML=daily.map(function(x){var v=x.costUsd||x.requests||0,h=v?Math.max(5,Math.round(v/mx*110)):1;return '<div class="usage-bar" style="height:'+h+'px" title="'+credEsc(x.date)+' · '+x.requests+' requests · '+usageMoney(x.costUsd)+'"></div>';}).join('');
  var models=d.models||[];document.getElementById('usage-models').innerHTML=models.length?'<div class="usage-row head"><span>Provider</span><span>Model</span><span>Requests</span><span>Tokens</span><span>Observed cost</span></div>'+models.map(function(x){return '<div class="usage-row"><span>'+credEsc(x.provider)+'</span><span>'+credEsc(x.model)+'</span><span>'+x.requests+'</span><span>'+Number((x.inputTokens||0)+(x.outputTokens||0)).toLocaleString()+'</span><span>'+usageMoney(x.costUsd)+'</span></div>';}).join(''):'<div class="usage-empty">No model requests have been observed since tracking was enabled.</div>';
  var providers=[{name:'Cline Pass',configured:!!(d.cline&&d.cline.installed),balanceStatus:'Cline does not expose subscription remaining credits to the CLI'}].concat(d.providers||[]);document.getElementById('usage-providers').innerHTML='<div class="usage-row head"><span>Provider</span><span>Connection</span><span></span><span></span><span>Remaining</span></div>'+providers.map(function(x){return '<div class="usage-row"><span>'+credEsc(x.name)+'</span><span class="'+(x.configured?'usage-ok':'muted')+'">'+(x.configured?'configured':'not configured')+'</span><span></span><span></span><span class="usage-unknown">Unknown · '+credEsc(x.balanceStatus||'not exposed')+'</span></div>';}).join('');
}).catch(function(e){if(note)note.textContent='Usage unavailable: '+e.message;});};
(function(){var b=document.getElementById('usage-refresh');if(b)b.onclick=function(){window.loadAIUsage();};})();
// --- Intelligence Runtime ---------------------------------------------------------------
function intelEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function intelActive(state){return ['COMPLETED','FAILED','ROLLED_BACK','CANCELLED'].indexOf(state)<0;}
function intelCard(w){var a=w.artifacts||{},impl=a.implementation||{},ctx=a.context||{},tests=a.tests||{},review=a.review||{},pkg=a.prPackage||{};var model=impl.model||(a.plan&&a.plan.modelId)||'not assigned';var runtime=impl.runtime||(a.plan&&a.plan.runtime)||'—';var cost=Number(impl.costUsd||(a.plan&&a.plan.estimatedCostUsd)||0);var task=(w.tasks||[]).find(function(t){return !['COMPLETED','CANCELLED'].includes(t.status);})||(w.tasks||[])[0]||null;var details={currentTask:task,worker:task?'implementation-worker':null,model:model,runtime:runtime,costUsd:cost,contextSources:ctx.sourceCount||0,contextHead:ctx.headSha||null,filesChanged:impl.touched||pkg.touched||[],commands:tests.command?[tests.command]:[],tests:tests,reviewFindings:review.findings||[],approvals:w.approvals||[],failure:w.error||null,finalDiff:pkg.diffStat||null,deployment:{pushed:!!pkg.pushed,deployed:!!pkg.deployed,productionMutation:!!pkg.productionMutation}};return '<div class="intel-card" data-wf="'+intelEsc(w.id)+'"><div class="intel-meta"><span class="intel-state">'+intelEsc(w.state)+'</span><span>'+intelEsc(w.id)+'</span><span>'+intelEsc(runtime)+' · '+intelEsc(model)+'</span><span>$'+cost.toFixed(4)+'</span></div><h3>'+intelEsc(w.objective)+'</h3><div class="intel-meta"><span>context '+Number(ctx.sourceCount||0)+' sources</span><span>'+(tests.green===true?'tests green':tests.green===false?'tests failed':'tests pending')+'</span><span>'+(review.accepted===true?'review accepted':review.accepted===false?'review rejected':'review pending')+'</span><span>deploy '+(pkg.deployed?'done':'not attempted')+'</span></div>'+(intelActive(w.state)?'<div class="intel-actions"><button class="intel-cancel" data-id="'+intelEsc(w.id)+'">Cancel safely</button></div>':'')+'<details><summary>Evidence and controls</summary><pre>'+intelEsc(JSON.stringify(details,null,2))+'</pre></details></div>';}
window.loadIntelligence=function(){var sum=document.getElementById('intel-summary'),root=document.getElementById('intel-workflows');if(!LIVE){sum.textContent='Launch a local Seen Command server for live workflow state.';return;}Promise.all([fetch('/api/intelligence').then(function(r){return r.json();}),fetch('/api/intelligence/workflows').then(function(r){return r.json();})]).then(function(values){var s=values[0],list=(values[1]&&values[1].workflows)||[];sum.textContent=(s.localFirst?'Local-first':'Remote-first')+' · remote escalation '+(s.remoteEscalationEnabled?'enabled':'disabled')+' · '+Number(s.workflows&&s.workflows.active||0)+' active · production/destructive actions require approval';root.innerHTML=list.length?list.map(intelCard).join(''):'<p class="muted">No intelligence workflows have run yet. The first verified vertical slice will appear here with its full evidence.</p>';root.querySelectorAll('.intel-cancel').forEach(function(button){button.onclick=function(){window.cancelIntel(button.dataset.id);};});}).catch(function(e){sum.textContent='Runtime unavailable: '+e.message;root.innerHTML='';});};
window.cancelIntel=function(id){fetch('/api/intelligence/workflows/'+encodeURIComponent(id)+'/cancel',{method:'POST',headers:{'content-type':'application/json'}}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'cancel failed');return j;});}).then(function(){window.loadIntelligence();}).catch(function(e){alert('Cancel failed: '+e.message);});};
// --- secure Settings / credentials --------------------------------------------------------------
function credEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function credMessage(id,text,ok){var el=document.getElementById(id);if(!el)return;el.textContent=text||'';el.className='cred-out '+(ok?'ok':'bad');}
window.loadDiagnostics=function(quiet){
  var root=document.getElementById('diag-checks'),sum=document.getElementById('diag-summary');if(!root||!LIVE)return;
  if(quiet!==true){root.innerHTML='<p class="muted">Running connection and runtime probes…</p>';if(sum)sum.textContent='probing live…';}
  fetch('/api/diagnostics').then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'diagnostics failed');return j;});}).then(function(data){
    var h=data.health||{},counts=h.counts||{};if(sum){sum.textContent=(h.overall||'unknown')+' · '+Number(counts.broken||0)+' broken · '+Number(counts.degraded||0)+' degraded · '+Number(counts.missing||0)+' missing';}
    // Base-branch cards carry a "Check now" button (POST /api/diagnostics/base-health); while that
    // background check runs, the cards say so and the panel re-polls until it finishes.
    var job=(data.jobs||{}).baseHealth||{};
    var bhAction=function(c){if(c.source!=='base-health')return '';if(job.running)return '<p class="diag-fix">Checking now — started '+credEsc(new Date(job.startedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))+'. This card updates when it finishes.</p>';return '<button class="cred-btn diag-act" data-diag-act="base-health">Check now</button>'+(job.error?'<p class="cred-out bad">'+credEsc(job.error)+'</p>':'');};
    root.innerHTML=(h.checks||[]).map(function(c){return '<div class="diag-item '+credEsc(c.status)+'"><span class="diag-state">'+credEsc(c.status)+'</span><b>'+credEsc(c.label)+'</b><p>'+credEsc(c.detail)+'</p>'+(c.fix&&!(c.source==='base-health'&&job.running)?'<p class="diag-fix"><b>Fix:</b> '+credEsc(c.fix)+'</p>':'')+bhAction(c)+'</div>';}).join('')||'<p class="muted">No diagnostic checks returned.</p>';
    root.querySelectorAll('[data-diag-act="base-health"]').forEach(function(b){b.onclick=function(){b.disabled=true;b.textContent='Starting…';fetch('/api/diagnostics/base-health',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json();}).then(function(){window.loadDiagnostics(true);}).catch(function(){b.disabled=false;b.textContent='Check now';});};});
    clearTimeout(window.__diagPoll);if(job.running)window.__diagPoll=setTimeout(function(){window.loadDiagnostics(true);},15000);
  }).catch(function(e){if(sum)sum.textContent='unavailable';root.innerHTML='<p class="cred-out bad">Diagnostics unavailable: '+credEsc(e.message)+'</p>';});
};
window.loadCredentials=function(){
  var root=document.getElementById('cred-groups');if(!root||!LIVE)return;
  fetch('/api/credentials').then(function(r){return r.json();}).then(function(data){
    var cs=document.getElementById('cline-status'),cl=data.cline||{};if(cs){var last=cl.lastTest;cs.textContent=cl.installed?('installed · '+(cl.provider||'?')+' · '+(cl.model||'provider default')+(last&&last.ok?' · verified '+new Date(last.at).toLocaleString():' · not verified')):'not installed';}
    root.innerHTML=(data.groups||[]).map(function(g){return '<div class="cred-card"><div class="cred-card-h"><b>'+credEsc(g.label)+'</b></div><div class="cred-help">'+credEsc(g.help)+'</div>'+(g.fields||[]).map(function(f){return '<div class="cred-row" data-key="'+credEsc(f.key)+'"><label class="cred-label" for="cred-'+credEsc(f.key)+'">'+credEsc(f.label)+'</label><input class="cred-input" id="cred-'+credEsc(f.key)+'" type="password" autocomplete="new-password" placeholder="'+(f.configured?'Configured — enter replacement':'Not configured')+'"/><label class="cred-clear"><input type="checkbox" class="cred-clear-box"/> clear</label><span class="cred-state '+(f.configured?'on':'off')+'">'+(f.configured?'configured':'missing')+'</span></div>';}).join('')+'</div>';}).join('');
  }).catch(function(){root.innerHTML='<p class="muted">Credential status unavailable.</p>';});
};
(function(){
  var refresh=document.getElementById('diag-refresh');if(refresh)refresh.onclick=function(){window.loadDiagnostics();};
  var save=document.getElementById('cred-save');if(save)save.onclick=function(){var values={},clear=[];document.querySelectorAll('.cred-row').forEach(function(row){var key=row.dataset.key,input=row.querySelector('.cred-input'),box=row.querySelector('.cred-clear-box');if(box&&box.checked)clear.push(key);else if(input&&input.value)values[key]=input.value;});save.disabled=true;credMessage('cred-out','Saving locally…',true);fetch('/api/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({values:values,clear:clear})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'save failed');return j;});}).then(function(){credMessage('cred-out','Saved. New workers use these credentials immediately.',true);window.loadCredentials();window.loadDiagnostics();}).catch(function(e){credMessage('cred-out',e.message,false);}).finally(function(){save.disabled=false;});};
  var signin=document.getElementById('cline-signin');if(signin)signin.onclick=function(){signin.disabled=true;credMessage('cline-out','Opening Cline sign-in…',true);fetch('/api/credentials/cline-signin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'cline'})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'sign-in failed');return j;});}).then(function(){credMessage('cline-out','Sign-in started. Finish in the browser window Cline opens.',true);}).catch(function(e){credMessage('cline-out',e.message,false);}).finally(function(){signin.disabled=false;});};
  var test=document.getElementById('cline-test');if(test)test.onclick=function(){test.disabled=true;credMessage('cline-out','Running a small real model request…',true);fetch('/api/credentials/cline-test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'connection test failed');return j;});}).then(function(j){var cost=Number(j.costUsd||0);credMessage('cline-out','Working ✓ '+j.provider+' / '+j.model+' · '+(j.latencyMs/1000).toFixed(1)+'s · $'+cost.toFixed(4),true);window.loadCredentials();}).catch(function(e){credMessage('cline-out',e.message,false);}).finally(function(){test.disabled=false;});};
  var auth=document.getElementById('cline-configure');if(auth)auth.onclick=function(){var provider=document.getElementById('cline-provider').value,key=document.getElementById('cline-key').value,model=document.getElementById('cline-model').value;if(!key){credMessage('cline-out','Enter the provider API key.',false);return;}auth.disabled=true;credMessage('cline-out','Authenticating with Cline…',true);fetch('/api/credentials/cline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:provider,apiKey:key,model:model})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'authentication failed');return j;});}).then(function(){document.getElementById('cline-key').value='';credMessage('cline-out','Cline authenticated. The key is stored by Cline, not Seen Command.',true);window.loadCredentials();}).catch(function(e){credMessage('cline-out',e.message,false);}).finally(function(){auth.disabled=false;});};
})();
// Live-feel WITHOUT the kick-out: a new board meeting (chat command, another window, the 6 AM run)
// must never hard-reload the page out from under Brandon — a reload aborts a streaming answer, eats a
// half-typed message, and dumps him back on the landing tab. softReload() preserves the active tab +
// composer draft across any reload; the 60s poll reloads only when the UI is IDLE (no stream, empty
// composer, >2 min since the last key/click) — otherwise it shows a quiet refresh chip and waits.
var BAKED_RUN=${JSON.stringify(state.runId)};
var PENDING_REFRESH=false,LAST_INTERACT=0;
document.addEventListener('keydown',function(){LAST_INTERACT=Date.now();},true);
document.addEventListener('pointerdown',function(){LAST_INTERACT=Date.now();},true);
function uiBusy(){var d=document.getElementById('directive');
  return !!(typeof ACTIVE_ABORT!=='undefined'&&ACTIVE_ABORT)||((d&&d.value)||'').trim()!==''||(Date.now()-LAST_INTERACT)<120000;}
function softReload(){try{var on=document.querySelector('.nav.on');var d=document.getElementById('directive');
  sessionStorage.setItem('sc-ui',JSON.stringify({tab:on?on.dataset.tab:null,draft:(d&&d.value)||''}));}catch(_){}
  location.reload();}
window.__softReload=softReload;
function showRefreshChip(){PENDING_REFRESH=true;if(document.getElementById('refresh-chip'))return;
  var c=document.createElement('button');c.id='refresh-chip';c.className='refresh-chip';c.textContent='↻ New board-meeting data — refresh';
  c.onclick=softReload;document.body.appendChild(c);}
// Restore what softReload saved, then clear it so a plain manual reload starts clean.
(function(){try{var raw=sessionStorage.getItem('sc-ui');if(!raw)return;sessionStorage.removeItem('sc-ui');
  var ui=JSON.parse(raw);
  if(ui.tab&&ui.tab!=='home'&&window.showTab)setTimeout(function(){window.showTab(ui.tab);},0);
  if(ui.draft){var d=document.getElementById('directive');if(d){d.value=ui.draft;autogrow(d);}}}catch(_){}})();
// Act AT MOST ONCE per run id. A reload only helps if the page comes back newer — and when the served
// page is baked from an older state than the API reports, it comes back IDENTICAL. That turned this
// poll into an infinite 60-second refresh loop: the bundled state.json was dated 2026-07-09 while the
// live runId was from today, so "is live !== baked" answered yes forever, and every reload re-served
// the same stale bake. Remembering which run we already acted on makes a stale bake cost one refresh
// instead of one every minute, which is the difference between "picks up new data" and "unusable".
if(LIVE){setInterval(function(){fetch('/api/state').then(function(r){return r.json();}).then(function(s){
  if(!s||!s.runId||s.runId===BAKED_RUN)return;
  var acted='';try{acted=sessionStorage.getItem('sc-run-acted')||'';}catch(_){}
  if(acted===s.runId)return; // already refreshed for this run; the bake is stale, reloading cannot fix it
  try{sessionStorage.setItem('sc-run-acted',s.runId);}catch(_){}
  if(uiBusy())showRefreshChip();else softReload();}).catch(function(){});},60000);}
(function(){var rb=document.getElementById('run-meeting');if(!rb)return;
  if(LIVE){rb.onclick=function(){rb.disabled=true;rb.textContent='↻ running the board meeting…';
    fetch('/api/board-meeting',{method:'POST'}).then(function(r){return r.json();}).then(function(){softReload();}).catch(function(){rb.disabled=false;rb.textContent='↻ Run board meeting';});};}
  else{rb.disabled=true;rb.title='Launch via Seen Command.command for live runs';}})();
// --- autonomous build status: poll /api/builds and reflect building → PR ready / failed ----------
// The runner's post-create PR-status verdict (build.prStatus), rendered next to the PR link: green when
// the fresh PR reflects READY, an amber caution when GitHub says it won't merge as-is (conflicts / a
// failing check). Nothing for older records (no prStatus) or in-between states — the activity ledger
// carries those; the card stays glanceable.
function prStatusChip(s){
  if(s==='ready')return ' <span style="color:#34d399">✅ ready to merge</span>';
  if(s==='conflicting')return ' <span style="color:#fbbf24">⚠ conflicts with main</span>';
  if(s==='checks_failing')return ' <span style="color:#fbbf24">⚠ checks failing</span>';
  return '';
}
// The PROOF LEDGER (engine/completion.mjs): a PR that opened — even one that merged — is not work that is
// DONE until its completion conditions were observed where the code runs. Shown under the headline so
// "Merged" can never again be read as "working": it says what was seen, and what has not been yet.
function proofLine(b){
  var p=b.proof;if(!p||!p.conditions||!p.conditions.length)return '';
  var seen=p.conditions.filter(function(c){return c.status==='observed';}).length;
  var open=p.conditions.filter(function(c){return c.status!=='observed';}).map(function(c){return brEsc(c.id+': '+(c.evidence||c.status));});
  var color=p.state==='proven'?'#34d399':(p.state==='failed'?'#f87171':'#fbbf24');
  var word=p.state==='proven'?'✓ PROVEN — observed working':(p.state==='failed'?'✗ PROOF FAILED':(p.state==='needs-human'?'◐ needs your eyes':'… awaiting proof'));
  return '<div style="margin-top:4px;color:'+color+'">'+word+' ('+seen+'/'+p.conditions.length+')'+(open.length?'<span style="color:#9ca3af"> — '+open.join(' · ')+'</span>':'')+'</div>';
}
function renderBuild(card,b){
  var el=card.querySelector('.build-status');if(!el)return;
  el.hidden=false;el.classList.remove('bs-building','bs-ready','bs-failed','bs-refused','bs-closed');
  var repoName=b.repo==='product'?'Seen product':'Seen Command';
  var logHtml=(b.log&&b.log.length)?'<div class="bs-log">'+b.log.slice(-6).map(brEsc).join('\\n')+'</div>':'';
  if(b.status==='pr_ready'||b.status==='merged'){
    el.classList.add('bs-ready');
    var pr=b.pr?('<a href="'+b.pr+'" target="_blank">open PR'+(b.prNumber?(' #'+b.prNumber):'')+' ↗</a>'):'';
    var chip=b.status==='pr_ready'?prStatusChip(b.prStatus):''; // the mergeability verdict is only for an open PR
    el.innerHTML='<div class="bs-h">✅ '+(b.status==='merged'?'Merged':'PR ready')+' — '+brEsc(repoName)+' '+pr+chip+'</div>'+proofLine(b)+(b.summary?'<div style="margin-top:4px">'+brEsc(b.summary)+'</div>':'')+logHtml;
  }else if(b.status==='green_dry'){
    el.classList.add('bs-ready');el.innerHTML='<div class="bs-h">✅ Gate GREEN (dry run) — '+brEsc(repoName)+'</div>'+logHtml;
  }else if(b.status==='failed'){
    el.classList.add('bs-failed');el.innerHTML='<div class="bs-h">⚠ Build failed</div><div style="margin-top:4px">'+brEsc(b.error||'see log')+'</div>'+logHtml;
  }else if(b.status==='preview_failed'){
    // The preview build ERRORED and the builder withdrew its own PR — red, never a happy "PR ready".
    // The PR link stays for the audit trail (it's now closed); the task stays open.
    el.classList.add('bs-failed');
    var xpr=b.pr?(' <a href="'+b.pr+'" target="_blank">closed PR'+(b.prNumber?(' #'+b.prNumber):'')+' ↗</a>'):'';
    el.innerHTML='<div class="bs-h">⚠ Preview build failed — PR withdrawn'+xpr+'</div><div style="margin-top:4px">'+brEsc(b.error||'the Vercel preview build FAILED')+'</div>'+logHtml;
  }else if(b.status==='refused'){
    // An honest REFUSAL — the builder declined this task BY DESIGN (a phantom/closed premise, or a
    // duplicate of an already-open PR). NOT breakage: it's the system asking the owner for an action,
    // so it renders calm amber, never red — the owner kept reading these healthy refusals as build
    // failures (yesterday's #88 duplicate-of-open-PR refusal). The refusal text carries the guidance.
    el.classList.add('bs-refused');
    el.innerHTML='<div class="bs-h">⏸ Not built — needs your review</div><div style="margin-top:4px">'+brEsc(b.error||'see log')+'</div>'+logHtml;
  }else if(b.status==='pr_closed'){
    // The PR was CLOSED without merging (reconcile's stale-green sweep, the #194 case). A NEUTRAL/grey
    // terminal state — NOT a happy "PR ready" and NOT a red failure; the change simply didn't land. The
    // closed PR is linked for the audit trail; the task stays open for a fresh attempt.
    el.classList.add('bs-closed');
    var clpr=b.pr?(' <a href="'+b.pr+'" target="_blank">closed PR'+(b.prNumber?(' #'+b.prNumber):'')+' ↗</a>'):'';
    el.innerHTML='<div class="bs-h">⊘ PR closed unmerged'+clpr+'</div><div style="margin-top:4px">'+brEsc(b.prClosedReason||'PR closed unmerged — see the PR thread')+'</div>'+logHtml;
  }else{
    el.classList.add('bs-building');
    el.innerHTML='<div class="bs-h"><span class="bs-spin"></span>Building on '+brEsc(repoName)+'… writing code + running the test gate</div>'+logHtml;
  }
}
var BUILD_POLL=null;
function pollBuildsOnce(){
  return fetch('/api/builds').then(function(r){return r.json();}).then(function(j){
    var builds=(j&&j.builds)||[];var anyLive=false;
    var painted={}; // a task can have several records (old approval build + new manual build); the list is newest-first, so paint each card once — the NEWEST record wins, stale failures never overwrite a live build
    builds.forEach(function(b){
      var live=(b.status==='building'||b.status==='queued');
      if(live)anyLive=true;
      var card=document.querySelector('.appr[data-id="'+b.id+'"]');
      if(card)renderBuild(card,b);
      // Task cards match by issue number (or the stable task-<n> id from a manual start).
      var m=/^task-(\\d+)$/.exec(b.id||'');
      var tn=(b.issue&&b.issue.number)||(m&&m[1]);
      if(tn&&!painted[tn]){painted[tn]=1;
        var tc=document.querySelector('.task[data-n="'+tn+'"]');
        if(tc){renderBuild(tc,b);
          var btn=tc.querySelector('.task-build');
          if(btn){btn.disabled=live;btn.textContent=live?'building…':'↻ Rebuild';}}}
    });
    return anyLive;
  }).catch(function(){return false;});
}
function startBuildPolling(){
  if(BUILD_POLL)return;
  BUILD_POLL=setInterval(function(){pollBuildsOnce().then(function(live){if(!live){clearInterval(BUILD_POLL);BUILD_POLL=null;}});},2500);
}
if(LIVE){pollBuildsOnce().then(function(live){if(live)startBuildPolling();});}
// --- Tasks tab: live list + manual build start ---------------------------------------------------
// Keep this markup in sync with the baked taskCards in build-dashboard.mjs.
function taskCardHTML(t){
  var labels=(t.labels||[]).map(function(l){return '<span class="tlabel">'+brEsc(l)+'</span>';}).join('');
  return '<div class="task" data-n="'+t.number+'"><div class="task-row">'
    +'<span class="task-n">#'+t.number+'</span><span class="task-t">'+brEsc(t.title)+'</span>'+labels
    +'<a class="task-go" href="'+brEsc(t.url)+'" target="_blank" rel="noopener">open ↗</a>'
    +'<button class="task-build" onclick="startTaskBuild('+t.number+')">▶ Build</button>'
    +'<button class="task-del" onclick="deleteTask('+t.number+')" title="Close this task and record the deletion in the brain">✕</button>'
    +'</div><div class="build-status" hidden></div></div>';
}
window.loadTasks=function(){
  if(!LIVE)return;
  fetch('/api/tasks').then(function(r){return r.json();}).then(function(j){
    var tasks=(j&&j.tasks)||[];var tl=document.querySelector('.tasklist');if(!tl)return;
    tl.innerHTML=tasks.length?tasks.map(taskCardHTML).join(''):'<p class="muted">No open tasks right now. Approve a proposal on Home or in the Board report and it becomes a tracked task here.</p>';
    var tc=document.querySelector('.tasks-count');if(tc)tc.textContent=tasks.length+' open';
    var tb=document.querySelector('.nav[data-tab="tasks"]');
    if(tb){var bd=tb.querySelector('.nav-badge');
      if(tasks.length){if(bd)bd.textContent=tasks.length;else{var sp=document.createElement('span');sp.className='nav-badge';sp.textContent=tasks.length;tb.appendChild(sp);}}
      else if(bd)bd.remove();}
    pollBuildsOnce().then(function(live){if(live)startBuildPolling();}); // paint existing build progress onto the fresh cards
  }).catch(function(){});
};
// Delete a task — asks for a REASON first, because the reason is the whole point: it goes to the
// brain so a future board meeting knows this work was dropped deliberately and doesn't re-propose it.
// The issue is closed on GitHub, never erased, so the audit trail survives.
window.deleteTask=function(n){
  var card=document.querySelector('.task[data-n="'+n+'"]');if(!card)return;
  var title=(card.querySelector('.task-t')||{}).textContent||('#'+n);
  var reason=prompt('Delete task #'+n+' — "'+title+'"?\\n\\nWhy are you dropping it? (recorded in the brain so it is not re-proposed)');
  if(reason===null)return; // cancelled
  var btn=card.querySelector('.task-del');if(btn){btn.disabled=true;btn.textContent='…';}
  fetch('/api/tasks/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({number:n,reason:reason})})
    .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||'delete failed');return j;});})
    .then(function(j){
      card.style.opacity='.45';
      var row=card.querySelector('.task-row');
      if(row){var note=document.createElement('span');note.className='task-deleted';
        note.textContent='✕ deleted'+(j.recordedToBrain?' · recorded in brain':' · BRAIN WRITE FAILED')+(j.cancelledBuild?' · build cancelled':'');
        row.appendChild(note);}
      if(btn)btn.remove();
      if(window.loadTasks)setTimeout(window.loadTasks,900);
    })
    .catch(function(e){if(btn){btn.disabled=false;btn.textContent='✕';}alert('Could not delete task #'+n+': '+e.message);});
};
window.startTaskBuild=function(n){
  var card=document.querySelector('.task[data-n="'+n+'"]');if(!card)return;
  var btn=card.querySelector('.task-build');if(btn){btn.disabled=true;btn.textContent='starting…';}
  fetch('/api/tasks/build',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({number:n})})
    .then(function(r){return r.json();})
    .then(function(j){
      if(j&&j.ok){renderBuild(card,j.build||{status:'queued',log:[]});if(btn)btn.textContent=j.already?'already building…':'building…';startBuildPolling();}
      else{if(btn){btn.disabled=false;btn.textContent='▶ Build';}
        var el=card.querySelector('.build-status');
        if(el){el.hidden=false;el.classList.remove('bs-building','bs-ready');el.classList.add('bs-failed');el.innerHTML='<div class="bs-h">⚠ '+brEsc((j&&j.error)||'could not start the build')+'</div>';}}
    })
    .catch(function(){if(btn){btn.disabled=false;btn.textContent='▶ Build';}});
};
if(!LIVE)document.querySelectorAll('.task-build').forEach(function(b){b.disabled=true;b.title='Launch via Seen Command.command to start builds';});
if(LIVE&&document.querySelector('.tasklist'))window.loadTasks();
window.decide=function(id,verdict){
  var card=document.querySelector('.appr[data-id="'+id+'"]');if(!card)return;
  var akey=card.getAttribute('data-key')||'';
  var v=card.querySelector('.verdict');var approved=verdict==='approved';
  function settle(txt,color){v.textContent=txt;v.style.color=color;card.style.opacity=.55;card.querySelectorAll('button').forEach(function(x){x.disabled=true});var c=document.getElementById('appr-count');if(c)c.textContent=Math.max(0,(+c.textContent)-1);}
  if(LIVE){
    v.textContent='saving…';v.style.color='#8b94a7';
    fetch('/api/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,key:akey,decision:approved?'approve':'deny'})})
      .then(function(r){return r.json();})
      .then(function(j){if(j&&j.ok){
          card.querySelectorAll('button').forEach(function(x){x.disabled=true});
          var c=document.getElementById('appr-count');if(c&&approved)c.textContent=Math.max(0,(+c.textContent)-1);
          var link=j.result&&j.result.url?(' <a href="'+j.result.url+'" target="_blank" style="color:#04121a;text-decoration:underline">open task #'+(j.result.number||'')+' ↗</a>'):'';
          var isBuild=approved&&j.building;
          var msg=approved?('✓ APPROVED — '+(isBuild?'task filed — builder is writing the code…':(j.delivered?'drafted the deliverable + filed it — review & post.':(j.result&&j.result.url?'filed as a tracked task.':(j.executed?'executed.':'recorded.'))))):'✕ DENIED — dropped, won\\'t be re-proposed.';
          card.classList.add(approved?'settled-ok':'settled-no');
          card.querySelector('.appr-actions').innerHTML='<div class="settled-msg">'+msg+link+'</div>';
          if(approved&&j.result&&j.result.url){
            var tl=document.querySelector('.tasklist');
            if(tl){ if(tl.querySelector('.muted'))tl.innerHTML='';
              var ta=document.createElement('a');ta.className='task';ta.href=j.result.url;ta.target='_blank';
              var ttl=(card.querySelector('.appr-top b')||{}).textContent||'task';
              ta.innerHTML='<span class="task-n">#'+(j.result.number||'')+'</span><span class="task-t">'+ttl+'</span><span class="task-go">just started ↗</span>';
              tl.insertBefore(ta,tl.firstChild); }
            var tb=document.querySelector('.nav[data-tab="tasks"]');
            if(tb){var bd=tb.querySelector('.nav-badge');if(bd)bd.textContent=(+bd.textContent||0)+1;else{var sp=document.createElement('span');sp.className='nav-badge';sp.textContent='1';tb.appendChild(sp);}}
          }
          if(isBuild){renderBuild(card,{status:'building',repo:j.building.repo,log:[]});startBuildPolling();}
        }else{v.textContent='⚠ '+((j&&j.error)||'failed — nothing saved');v.style.color='#fbbf24';}})
      .catch(function(){v.textContent='⚠ server offline — nothing saved';v.style.color='#fbbf24';});
  } else { settle(approved?'✓ approved':'✕ denied',approved?'#34d399':'#f87171'); }
};
// ChatGPT-style message builders (stacked column: user bubble on the right, assistant text on the left).
function youMsg(text){var d=document.createElement('div');d.className='msg you';var b=document.createElement('div');b.className='ubub';b.textContent=text;d.appendChild(b);return d;}
function ceoMsg(text){var d=document.createElement('div');d.className='msg ceo';d.innerHTML='<div class="m-role"><span class="rdot">◆</span> Command</div><div class="m-body answer"></div>';d.querySelector('.m-body').innerHTML=mdToHtml(text);return d;}
// Render the DURABLE conversation from the brain (survives tabs/restart). Server is the truth. New chat
// (FORCE_EMPTY) shows the empty-state hero instead of re-loading history.
// Opening the Board Room must never freeze (owner, 2026-10-21): the history is drawn ONCE, re-drawn only when
// it changed, and only the latest 30 messages are drawn at first — older ones on request, in one fragment.
var CONVO_SIG=null,CONVO_OLDER=[];
function convoSig(msgs){var l=msgs[msgs.length-1];return msgs.length+':'+(l?String(l.role)+String(l.text||'').length:'');}
function boardMsg(text){var d=ceoMsg(text);d.classList.add('board');d.querySelector('.m-role').innerHTML='<span class="rdot">▦</span> Board meeting';return d;}
function drawMsgs(list){var f=document.createDocumentFragment();list.forEach(function(m){f.appendChild(m.role==='you'?youMsg(m.text):m.role==='board'?boardMsg(m.text):ceoMsg(m.text));});return f;}
function olderButton(convo){var old=document.getElementById('convo-older');if(old)old.remove();if(!CONVO_OLDER.length)return;
  var b=document.createElement('button');b.id='convo-older';b.className='convo-older';b.textContent='Show '+CONVO_OLDER.length+' earlier message'+(CONVO_OLDER.length===1?'':'s');
  b.onclick=function(){var sc=document.getElementById('chat-scroll');var h=sc?sc.scrollHeight:0;var take=CONVO_OLDER.splice(Math.max(0,CONVO_OLDER.length-40));b.remove();convo.insertBefore(drawMsgs(take),convo.firstChild);olderButton(convo);if(sc)sc.scrollTop=sc.scrollHeight-h;};
  convo.insertBefore(b,convo.firstChild);}
window.loadConversation=function(){
  if(!LIVE)return;var convo=document.getElementById('convo');if(!convo)return;
  if(FORCE_EMPTY){FORCE_EMPTY=false;CONVO_SIG='empty';CONVO_OLDER=[];convo.innerHTML='';showHero(true);renderHeroCards();return;}
  fetch('/api/chat-history').then(function(r){return r.json();}).then(function(j){
    var msgs=(j&&j.messages)||[];
    var sig=convoSig(msgs);
    if(sig===CONVO_SIG&&convo.children.length)return; // nothing new — keep what is on screen
    if(ACTIVE_ABORT)return;                            // never redraw under a streaming answer
    CONVO_SIG=sig;
    if(!msgs.length){convo.innerHTML='';showHero(true);renderHeroCards();return;}
    showHero(false);
    CONVO_OLDER=msgs.slice(0,-30);
    var recent=msgs.slice(-30);
    requestAnimationFrame(function(){convo.innerHTML='';convo.appendChild(drawMsgs(recent));olderButton(convo);
      var sc=document.getElementById('chat-scroll');if(sc)sc.scrollTop=sc.scrollHeight;});
  }).catch(function(){});
};
// ---- Markdown → HTML (safe, dependency-free): real AI-platform formatting for answers ----
function mdEsc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function mdInline(s){
  s=s.replace(/\`([^\`]+)\`/g,function(_,c){return '<code>'+c+'</code>';});
  s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  s=s.replace(/(^|[^\\w])_([^_\\n]+)_(?![\\w])/g,'$1<em>$2</em>');
  s=s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');
  s=s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function mdToHtml(src){
  var lines=mdEsc(src).split('\\n');var out=[];var inCode=false;var code=[];var list=null;
  function closeList(){if(list){out.push(list==='ul'?'</ul>':'</ol>');list=null;}}
  for(var i=0;i<lines.length;i++){var ln=lines[i];
    if(/^\\s*\`\`\`/.test(ln)){if(inCode){out.push('<pre><code>'+code.join('\\n')+'</code></pre>');code=[];inCode=false;}else{closeList();inCode=true;}continue;}
    if(inCode){code.push(ln);continue;}
    var h=ln.match(/^(#{1,3})\\s+(.*)$/);
    if(h){closeList();var lv=h[1].length+2;out.push('<h'+lv+'>'+mdInline(h[2])+'</h'+lv+'>');continue;}
    var ul=ln.match(/^\\s*[-*]\\s+(.*)$/);var ol=ln.match(/^\\s*\\d+\\.\\s+(.*)$/);
    if(ul){if(list!=='ul'){closeList();out.push('<ul>');list='ul';}out.push('<li>'+mdInline(ul[1])+'</li>');continue;}
    if(ol){if(list!=='ol'){closeList();out.push('<ol>');list='ol';}out.push('<li>'+mdInline(ol[1])+'</li>');continue;}
    if(!ln.trim()){closeList();continue;}
    closeList();out.push('<p>'+mdInline(ln)+'</p>');
  }
  if(inCode)out.push('<pre><code>'+code.join('\\n')+'</code></pre>');closeList();
  return out.join('');
}
// Smart autoscroll — stick to the bottom only when the user is already near it.
var CHAT_STICK=true;
setTimeout(function(){var sc=document.getElementById('chat-scroll');if(sc)sc.addEventListener('scroll',function(){CHAT_STICK=(sc.scrollHeight-sc.scrollTop-sc.clientHeight)<130;});},0);
var ACTIVE_ABORT=null;
function setStreaming(on){var b=document.getElementById('send-directive');if(b){b.textContent=on?'■':'↑';b.classList.toggle('stopping',!!on);b.title=on?'Stop':'Send';}}
// The STREAMING Board Room agent — owned engine or Claude, rendering reasoning + tool calls live then a
// markdown answer with copy/retry. SSE off POST /api/chat/stream. One-shot /api/chat is the last resort.
function brToolIcon(name){name=name||'';if(name.indexOf('Bash')===0)return'⌘';if(name==='Read'||name==='LS')return'📄';if(name==='Grep'||name==='Glob')return'🔎';if(name==='WebFetch'||name==='WebSearch')return'🌐';if(name.indexOf('brain')>=0)return'🧠';return'🔧';}
// Why the full agent could not answer, in plain words — the REAL reason (it used to always say "log in the
// claude CLI", even when it was logged in and the failure was something else).
function degradeNote(why){
  if(!why)return'The full agent could not answer, so this came from memory only.';
  var fix='';
  if(/not logged in|[/]login/i.test(why))fix=' Fix: run claude in Terminal, then /login.';
  else if(/credit|usage limit|quota/i.test(why))fix=' Fix: the Claude account behind the CLI is out of credits — add credits, or log the CLI in with your Claude subscription (claude, then /login).';
  else if(/SIGKILL|code signature|agent:setup/i.test(why))fix=' Fix: run npm run agent:setup in the command-os folder.';
  return'Answered from memory only — the full agent failed: '+why+'.'+fix;
}
window.askBoardRoom=function(message){
  if(!LIVE)return;var convo=document.getElementById('convo');if(!convo)return;
  if(ACTIVE_ABORT){try{ACTIVE_ABORT.abort();}catch(_){}}
  showHero(false);
  convo.appendChild(youMsg(message));
  var m=document.createElement('div');m.className='msg ceo';
  m.innerHTML='<div class="m-role"><span class="rdot">◆</span> Command</div><div class="agent"><div class="trace"><div class="tstatus">…thinking</div></div><div class="answer"></div></div>';
  convo.appendChild(m);
  var trace=m.querySelector('.trace');var status=m.querySelector('.tstatus');var answer=m.querySelector('.answer');var agent=m.querySelector('.agent');
  var lastTool=null;var didText=false;var answerRaw='';var finished=false;
  var scEl=document.getElementById('chat-scroll');
  function scroll(){if(scEl&&CHAT_STICK)scEl.scrollTop=scEl.scrollHeight;}
  var wasFresh=CHAT_FRESH;CHAT_FRESH=false;
  var ctrl=(typeof AbortController!=='undefined')?new AbortController():null;ACTIVE_ABORT=ctrl;setStreaming(true);
  scroll();
  function finishUI(engine,degraded){
    if(finished)return;finished=true;setStreaming(false);if(ACTIVE_ABORT===ctrl)ACTIVE_ABORT=null;
    if(status){status.remove();status=null;}
    if(!didText&&(!trace||!trace.querySelector('.tchip')))answer.textContent='(no answer)';
    var act=document.createElement('div');act.className='m-actions';
    var eng=document.createElement('span');eng.className='engbadge'+(String(engine||'').indexOf('owned')===0?' owned':'');eng.textContent=(degraded?'memory-only · ':'')+(engine||'done');
    var cp=document.createElement('button');cp.className='m-act';cp.textContent='⧉ Copy';cp.onclick=function(){try{navigator.clipboard.writeText(answerRaw||answer.textContent||'');cp.textContent='✓ Copied';setTimeout(function(){cp.textContent='⧉ Copy';},1200);}catch(_){}};
    var rg=document.createElement('button');rg.className='m-act';rg.textContent='↻ Retry';rg.onclick=function(){window.askBoardRoom(message);};
    act.appendChild(eng);act.appendChild(cp);act.appendChild(rg);agent.appendChild(act);scroll();
  }
  function ev(e){
    if(e.type==='status'){if(status)status.textContent=(e.degraded?'⚠ ':'')+e.text;}
    else if(e.type==='owned'){if(status){status.remove();status=null;}}
    else if(e.type==='tool'){if(status){status.remove();status=null;}var c=document.createElement('div');c.className='tchip';c.innerHTML='<span class="ti">'+brToolIcon(e.name)+'</span><span class="tn">'+brEsc(e.name||'tool')+'</span>'+(e.summary?'<span class="ts">'+brEsc(e.summary)+'</span>':'');trace.appendChild(c);lastTool=c;scroll();}
    else if(e.type==='tool_result'){if(lastTool&&e.preview){var r=document.createElement('div');r.className='tres'+(e.ok?'':' bad');r.textContent='→ '+e.preview;lastTool.appendChild(r);}scroll();}
    else if(e.type==='text'){if(status){status.remove();status=null;}didText=true;answerRaw+=(answerRaw?'\\n':'')+e.text;answer.innerHTML=mdToHtml(answerRaw);scroll();}
    else if(e.type==='error'){answer.innerHTML+='<div class="aerr">⚠ '+brEsc(e.text||'error')+'</div>';scroll();}
    else if(e.type==='action'){handleAction(e.action);}
    else if(e.type==='done'){if(e.degraded){var n=document.createElement('div');n.className='degnote';var why=String(e.reason||'');n.textContent=degradeNote(why);agent.appendChild(n);}finishUI(e.engine,e.degraded);}
  }
  function handleAction(a){if(!a)return;
    // A wired action (meeting/approve/edit) used to hard-reload the page 1.2s later — killing the very
    // conversation the command came from. Now the live sections refresh in place and the baked Command
    // Center waits behind the refresh chip until Brandon wants it.
    if(a.type==='reload'){showRefreshChip();if(window.loadTasks)window.loadTasks();}
    else if(a.type==='focus'){var ft=document.querySelector('.focus-tag b');if(ft&&a.title)ft.textContent=a.title;if(!a.custom&&window.__brSet){window.__brSet(a.focusId,null);}}
  }
  fetch('/api/chat/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:message,fresh:wasFresh}),signal:ctrl?ctrl.signal:undefined})
    .then(function(res){
      if(!res.body||!res.body.getReader){
        return fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:message})}).then(function(r){return r.json();}).then(function(j){ev({type:'text',text:(j&&j.reply)||'no reply'});ev({type:'done',engine:(j&&j.engine)||''});if(j&&j.action)handleAction(j.action);});
      }
      var reader=res.body.getReader();var dec=new TextDecoder();var buf='';
      function pump(){return reader.read().then(function(r){
        if(r.done){if(buf.trim())buf.split('\\n\\n').forEach(frame);if(!finished)finishUI('done');return;}
        buf+=dec.decode(r.value,{stream:true});
        var parts=buf.split('\\n\\n');buf=parts.pop();
        parts.forEach(frame);
        return pump();
      });}
      function frame(p){var line=p.replace(/^data: /,'').trim();if(!line)return;try{ev(JSON.parse(line));}catch(_){}}
      return pump();
    })
    .catch(function(err){if(err&&err.name==='AbortError'){answer.innerHTML+='<div class="degnote">■ stopped</div>';finishUI('stopped');return;}if(status){status.textContent='⚠ board room offline';}else{answer.textContent='⚠ board room offline';}finishUI('offline');});
};
window.toggleDept=function(id){var w=document.getElementById('w-'+id),x=document.getElementById('x-'+id);if(!w||!x)return;
  if(w.hasAttribute('hidden')){w.removeAttribute('hidden');x.textContent=x.textContent.replace('▸','▾');}
  else{w.setAttribute('hidden','');x.textContent=x.textContent.replace('▾','▸');}};
// ================= Knowledge Vault — the brain workspace ==========var GC={entity:'#5b8cff',value:'#6b7689',thread:'#ffb454',dept:'#3b82f6'};
var VAULT=null, vaultLoaded=false;
function vEsc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
// Static fallback: reconstruct fact triples from the baked graph so the browser works even off-app.
function factsFromGraph(){
  var by={};GRAPH.nodes.forEach(function(n){by[n.id]=n;});
  var out=[];
  GRAPH.links.forEach(function(l){ if(l.kind!=='fact')return; var s=by[l.source],t=by[l.target]; if(!s||!t)return;
    var lb=String(t.label||'');var ci=lb.indexOf(':');
    out.push({subject:s.label,predicate:ci>=0?lb.slice(0,ci).trim():'fact',object:ci>=0?lb.slice(ci+1).trim():lb});});
  return out;
}
function loadVault(){
  if(vaultLoaded)return; vaultLoaded=true;
  if(!LIVE){ VAULT={facts:factsFromGraph(),decisions:[],timeline:[],health:null}; renderVault(); return; }
  fetch('/api/vault').then(function(r){return r.json();}).then(function(j){ VAULT=j&&j.facts?j:{facts:factsFromGraph(),decisions:[],timeline:[]}; renderVault(); })
    .catch(function(){ VAULT={facts:factsFromGraph(),decisions:[],timeline:[]}; renderVault(); });
}
function renderVault(){
  // This week
  var wk=document.getElementById('v-week');
  if(wk){ if(VAULT.timeline&&VAULT.timeline.length){ wk.innerHTML=VAULT.timeline.map(function(d){
      return '<div class="v-week-day">'+vEsc(d.date)+'</div>'+d.entries.map(function(e){return '<div class="v-week-e"><b>'+vEsc(e.heading)+'</b><span>'+vEsc(e.text)+'</span></div>';}).join('');
    }).join(''); } else if(LIVE){ wk.innerHTML='<p class="muted">No timeline entries yet — they appear as the team works.</p>'; } }
  // Decisions
  var dc=document.getElementById('v-decisions');
  if(dc){ if(VAULT.decisions&&VAULT.decisions.length){ dc.innerHTML=VAULT.decisions.map(function(d){
      return '<div class="v-dec"><span class="d-date">'+vEsc(d.date)+'</span><b>'+vEsc(d.title)+'</b>'+(d.section?'<span class="d-sec">'+vEsc(d.section.slice(0,26))+'</span>':'')+(d.detail?'<div class="d-detail">'+vEsc(d.detail)+'</div>':'')+'</div>';
    }).join(''); } else if(LIVE){ dc.innerHTML='<p class="muted">No decisions recorded yet.</p>'; } }
  renderFacts('');
}
function renderFacts(q){
  var el=document.getElementById('v-facts'); if(!el)return;
  q=String(q||'').toLowerCase();
  var facts=(VAULT&&VAULT.facts)||[];
  var hit=facts.filter(function(f){ if(!q)return true; return (f.subject+' '+f.predicate+' '+f.object).toLowerCase().indexOf(q)>=0; });
  var cnt=document.getElementById('v-count'); if(cnt)cnt.textContent=hit.length+(q?(' / '+facts.length):' facts');
  var by={}; hit.forEach(function(f){ (by[f.subject]=by[f.subject]||[]).push(f); });
  // Render at most 400 facts at a time (thousands of DOM rows per keystroke froze the tab).
  var subs=Object.keys(by).sort(),shown=0,cap=400,keep=[];
  for(var si=0;si<subs.length&&shown<cap;si++){var rows=by[subs[si]].slice(0,cap-shown);shown+=rows.length;keep.push([subs[si],rows]);}
  by={};keep.forEach(function(k){by[k[0]]=k[1];});
  var more=hit.length>shown?'<p class="muted">Showing '+shown+' of '+hit.length+' — search to narrow it down.</p>':'';
  el.innerHTML=more+Object.keys(by).sort().map(function(s){
    return '<div class="v-subj"><div class="v-subj-h" data-s="'+encodeURIComponent(s)+'">'+vEsc(s)+'</div>'
      +by[s].map(function(f){return '<div class="v-fact"><span class="fp">'+vEsc(f.predicate)+'</span><span class="fo">'+vEsc(f.object)+'</span></div>';}).join('')+'</div>';
  }).join('')||'<p class="muted">No facts match.</p>';
}
window.vaultFilter=function(s){ var i=document.getElementById('v-search'); if(i){i.value=s;} renderFacts(s); };
(function(){ var i=document.getElementById('v-search'),dt=null; if(i)i.addEventListener('input',function(){clearTimeout(dt);dt=setTimeout(function(){renderFacts(i.value);},150);});
  var fl=document.getElementById('v-facts');
  if(fl)fl.addEventListener('click',function(e){var h=e.target.closest('.v-subj-h');if(h)window.vaultFilter(decodeURIComponent(h.getAttribute('data-s')||''));});
})();
// Ask the brain — the real Q&A over the vault's facts, with citation chips.
(function(){
  var q=document.getElementById('ask-q'), go=document.getElementById('ask-go'), out=document.getElementById('ask-out');
  if(!q||!go)return;
  function ask(){
    var text=(q.value||'').trim(); if(!text)return;
    out.hidden=false; out.innerHTML='<span class="muted">thinking over the brain…</span>';
    if(!LIVE){ out.innerHTML='Open via the Seen Command app to ask the live brain.'; return; }
    fetch('/api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:text})})
      .then(function(r){return r.json();})
      .then(function(j){ if(j&&j.answer){ var cites=(j.facts||[]).map(function(f){return '<span class="ask-cite" data-s="'+encodeURIComponent(f.subject)+'">'+vEsc(f.subject)+' · '+vEsc(f.predicate)+'</span>';}).join('');
          out.innerHTML=vEsc(j.answer)+(j.engine?' <span class="engbadge">'+vEsc(j.engine)+'</span>':'')+(cites?'<div class="cites">'+cites+'</div>':'');
        } else { out.innerHTML='⚠ '+vEsc((j&&j.error)||'no answer'); } })
      .catch(function(){ out.innerHTML='⚠ brain unreachable'; });
  }
  go.onclick=ask; q.addEventListener('keydown',function(e){if(e.key==='Enter')ask();});
  out.addEventListener('click',function(e){var c=e.target.closest('.ask-cite');if(c)window.vaultFilter(decodeURIComponent(c.getAttribute('data-s')||''));});
})();
// ---- Creator Intelligence Library (Instagram compiler) --------------------------------------------
// Read-only over the local worker's SQLite + artifacts. Every claim shown here traces to a video +
// timestamp; nothing here downloads, deletes, or runs an executable — actions go through the run bar,
// which the deterministic /api/chat handler validates before anything spawns.
var IG_CUR=null;
function igEsc(s){return brEsc(s==null?'':String(s));}
function igGet(u){return fetch(u).then(function(r){return r.json();});}
function igPost(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();});}
window.loadInstagram=function(){
  var d=document.getElementById('ig-doctor');
  if(!LIVE){if(d)d.innerHTML='<p class="muted">Launch via Seen Command.command for the live Creator Library.</p>';return;}
  igGet('/api/instagram/doctor').then(renderIgDoctor).catch(function(){if(d)d.innerHTML='<p class="muted">Toolchain status unavailable.</p>';});
  igGet('/api/instagram/library').then(function(j){renderIgAccounts((j&&j.projects)||[]);}).catch(function(){
    var a=document.getElementById('ig-accounts');if(a)a.innerHTML='<p class="muted">Library unavailable.</p>';});
  var ip=document.querySelector('#ig-insights .v-body');
  igGet('/api/instagram/insights').then(function(j){if(ip)renderCreatorInsights(ip,j||{},true);}).catch(function(){if(ip)ip.innerHTML='<p class="muted">Insights unavailable.</p>';});
  igLoadPrune();igLoadLastDiscovery();
};
function renderIgDoctor(d){
  var el=document.getElementById('ig-doctor');if(!el)return;var checks=d.checks||{};var chips='';
  Object.keys(checks).forEach(function(k){var c=checks[k];var cls=c.ok?'ok':(c.required?'bad':'warn');
    chips+='<span class="ig-chip '+cls+'" title="'+igEsc(c.detail||'')+'">'+(c.ok?'✓':(c.required?'✕':'○'))+' '+igEsc(k)+'</span>';});
  var ing=d.ingestion||{};var sess=ing.authenticatedSession||{};
  var sline='Anonymous-first · '+(sess.available?igEsc(sess.detail||'local session present'):'no login (public profiles only)');
  el.innerHTML='<div class="ig-doc-h">'+(d.ok?'<span class="ig-chip ok">✓ toolchain ready</span>':'<span class="ig-chip bad">✕ missing: '+igEsc((d.missingRequired||[]).join(', ')||'?')+'</span>')+' <span class="muted">'+igEsc(sline)+'</span></div><div class="ig-chips">'+chips+'</div>';
}
function renderIgAccounts(ps){
  var a=document.getElementById('ig-accounts');var c=document.getElementById('ig-acct-count');
  if(c)c.textContent=ps.length?ps.length:'';if(!a)return;
  if(!ps.length){a.innerHTML='<p class="muted">No researched creators yet. Type <b>research instagram &lt;username&gt;</b> above to start one.</p>';return;}
  // Each account: counts, the keep / prune verdict and WHY, open (not total) unresolved knowledge, and —
  // when it has evidence but no knowledge — the reason from its research job.
  a.innerHTML=ps.map(function(p){var cn=p.counts||{};var v=p.verdict||{};var vd=v.verdict||'pending';var un=p.unresolved||{};
    return '<button class="ig-acct" data-name="'+igEsc(p.name)+'" data-user="'+igEsc(p.username||'')+'">'
      +'<div class="ig-acct-u">@'+igEsc(p.username||p.name)+' <span class="ig-vd '+igEsc(vd)+'">'+igEsc(vd)+'</span>'+(p.readOnly?' <span class="ig-ro">read-only</span>':'')+'</div>'
      +'<div class="ig-acct-m">'+(cn.videos||0)+' vid · '+(cn.evidence||0)+' ev · '+(cn.knowledge||0)+' kn'+(p.storageBytes?' · '+fmtBytes(p.storageBytes):'')+'</div>'
      +(v.why?'<div class="ig-acct-why">'+igEsc(v.why)+'</div>':'')
      +(un.open?'<div class="ig-acct-w">'+un.open+' unresolved open'+(un.resolved?' · '+un.resolved+' resolved':'')+'</div>':(un.resolved?'<div class="ig-acct-why">'+un.resolved+' unresolved — all resolved</div>':''))
      +(p.knowledgeNote?'<div class="ig-acct-note">0 knowledge: '+igEsc(p.knowledgeNote.text)+'</div>':'')+'</button>';}).join('');
  a.querySelectorAll('.ig-acct').forEach(function(b){b.onclick=function(){
    a.querySelectorAll('.ig-acct').forEach(function(x){x.classList.remove('on');});b.classList.add('on');
    openIgAccount(b.dataset.name,b.dataset.user);};});
}
var IG_PROJ=null,IG_USER=null,IG_NAME=null,IG_TAB='overview';
var IG_TABS=[['overview','Overview'],['keypoints','★ Key Points'],['videos','Videos'],['knowledge','Knowledge'],['unresolved','Unresolved'],['guidance','Guidance'],['files','Files']];
function igP(){return '/api/instagram/projects/'+encodeURIComponent(IG_NAME);}
function openIgAccount(name,user){
  IG_CUR=name;IG_NAME=name;IG_USER=user;var d=document.getElementById('ig-detail');if(!d)return;
  d.innerHTML='<div class="v-h">@'+igEsc(user||name)+'</div><div class="v-body"><p class="muted">Loading…</p></div>';
  igGet(igP()).then(function(proj){IG_PROJ=proj||{};renderIgShell();igTab('overview');})
    .catch(function(){d.innerHTML='<div class="v-h">@'+igEsc(user||name)+'</div><div class="v-body"><p class="muted">Could not load this creator.</p></div>';});
}
function renderIgShell(){
  var d=document.getElementById('ig-detail');if(!d)return;var cfg=IG_PROJ.config||{};
  var h='<div class="v-h">@'+igEsc(IG_USER||IG_NAME)+' <span class="v-hint">'+igEsc(cfg.source||'instagram')+(IG_PROJ.readOnly?' · read-only':'')+'</span></div>';
  h+='<div class="ig-tabs">'+IG_TABS.map(function(t){return '<button class="ig-tab" data-t="'+t[0]+'">'+t[1]+'</button>';}).join('')+'</div>';
  h+='<div id="ig-tabc" class="v-body"></div>';d.innerHTML=h;
  d.querySelectorAll('.ig-tab').forEach(function(b){b.onclick=function(){igTab(b.dataset.t);};});
}
function igFail(c){return function(){c.innerHTML='<p class="muted">Could not load.</p>';};}
function igTab(tab){
  IG_TAB=tab;var d=document.getElementById('ig-detail');if(!d)return;
  d.querySelectorAll('.ig-tab').forEach(function(b){b.classList.toggle('on',b.dataset.t===tab);});
  var c=document.getElementById('ig-tabc');if(!c)return;c.innerHTML='<p class="muted">Loading…</p>';
  if(tab==='overview'){c.innerHTML=igOverviewHtml();wireOverview();return;}
  if(tab==='keypoints'){igGet('/api/instagram/creators/'+encodeURIComponent(IG_USER||IG_NAME)).then(function(j){renderKeyPoints(c,j||{});}).catch(igFail(c));return;}
  if(tab==='unresolved'){igGet(igP()+'/unresolved').then(function(j){renderUnresolved(c,j||{});}).catch(igFail(c));return;}
  if(tab==='videos'){igGet(igP()+'/videos').then(function(j){renderGallery(c,(j&&j.videos)||[]);}).catch(igFail(c));return;}
  if(tab==='knowledge'){igGet(igP()+'/knowledge').then(function(j){renderKnowledge(c,(j&&j.knowledge)||[]);}).catch(igFail(c));return;}
  if(tab==='guidance'){igGet(igP()+'/guidance').then(function(j){renderGuidance(c,(j&&j.briefs)||[]);}).catch(igFail(c));return;}
  if(tab==='files'){igLoadTree(c,'');return;}
}
function igOverviewHtml(){
  var cn=IG_PROJ.counts||{},cfg=IG_PROJ.config||{};
  var h='<div class="ig-stats">'+(cn.videos||0)+' videos · '+(cn.evidence||0)+' evidence · '+(cn.knowledge||0)+' knowledge · '+(cn.rules||0)+' rules · '+(cn.requirements||0)+' requirements</div>';
  if(cfg.completeness_statement)h+='<p class="muted">'+igEsc(cfg.completeness_statement)+'</p>';
  h+='<div class="ig-search-row"><input id="ig-search" class="v-search" placeholder="search transcripts, evidence, knowledge…"/><div id="ig-search-out" class="ig-search-out"></div></div>';
  h+='<div class="ig-panelbox"><div class="ig-sub">Storage &amp; cleanup</div>';
  h+='<div><button class="ig-btn" id="ig-cleanup-preview">Preview raw-media cleanup</button> <span class="muted">deletes only downloaded raw video/audio — keeps transcripts, frames, OCR, evidence, knowledge, reports, and source links.</span><div id="ig-cleanup-out"></div></div>';
  if(IG_PROJ.readOnly){h+='<div class="ig-danger muted">This dataset is read-only (a registered fixture / external root) — it cannot be deleted from here.</div>';}
  else{h+='<div class="ig-danger"><button class="ig-btn ig-btn-danger" id="ig-del">Delete this entire folder…</button><div id="ig-del-out"></div></div>';}
  h+='</div>';return h;
}
function wireOverview(){
  var si=document.getElementById('ig-search');if(si)si.addEventListener('keydown',function(e){if(e.key==='Enter')igSearch(IG_NAME,si.value);});
  var pv=document.getElementById('ig-cleanup-preview'),out=document.getElementById('ig-cleanup-out');
  if(pv)pv.onclick=function(){out.innerHTML='<p class="muted">Finding research job…</p>';
    igGet('/api/instagram/jobs').then(function(j){var job=(j.jobs||[]).find(function(x){return x.project===IG_NAME||String(x.username||'').toLowerCase()===String(IG_USER||'').toLowerCase();});
      if(!job){out.innerHTML='<p class="muted">Raw-media cleanup runs after a research job for this creator. This dataset has no job (imported/fixture) — use "Delete entire folder" to remove everything, or keep it.</p>';return;}
      igPost('/api/instagram/jobs/'+encodeURIComponent(job.id)+'/cleanup-preview',{}).then(function(r){
        if(!r.ok){out.innerHTML='<p class="muted">'+igEsc(r.error||'cleanup unavailable')+'</p>';return;}
        var p=r.preview||{},gb=((p.bytes_to_delete||0)/1e9).toFixed(2);
        var html='<div class="ig-cleanup-plan"><b>'+(p.file_count||0)+'</b> raw file(s) (~'+gb+' GB) would be deleted. <b>Kept:</b> transcripts, frames, OCR, evidence, knowledge, reports, and source links.';
        if(p.pinnedCount)html+='<div class="ig-danger">'+p.pinnedCount+' pinned — deletion is blocked while pins exist.</div>';
        if(p.ready&&!p.pinnedCount)html+='<div><button class="ig-btn ig-btn-danger" id="ig-cleanup-confirm">Yes — delete raw media (confirm)</button></div>';
        else if(!p.ready)html+='<div class="muted">Not ready to clean yet.</div>';
        html+='</div>';out.innerHTML=html;
        var cf=document.getElementById('ig-cleanup-confirm');if(cf)cf.onclick=function(){cf.disabled=true;cf.textContent='deleting…';
          igPost('/api/instagram/jobs/'+encodeURIComponent(job.id)+'/cleanup-confirm',{token:p.token}).then(function(rr){
            out.innerHTML=rr.deleted?'<p class="muted">✓ raw media deleted; evidence / knowledge / transcripts preserved.</p>':'<p class="muted">'+igEsc(rr.error||'not deleted')+'</p>';});};
      });}).catch(function(){out.innerHTML='<p class="muted">cleanup failed.</p>';});
  };
  var del=document.getElementById('ig-del'),dout=document.getElementById('ig-del-out');
  if(del)del.onclick=function(){dout.innerHTML='<div class="ig-confirm">Type <code>'+igEsc(IG_NAME)+'</code> to permanently delete this folder (videos, evidence, knowledge — everything). This cannot be undone.<br><input id="ig-del-in" class="v-search" placeholder="'+igEsc(IG_NAME)+'"/> <button class="ig-btn ig-btn-danger" id="ig-del-go">Delete forever</button></div>';
    document.getElementById('ig-del-go').onclick=function(){var v=(document.getElementById('ig-del-in').value||'').trim();
      igPost(igP()+'/delete',{confirm:v}).then(function(r){
        if(r.ok){var det=document.getElementById('ig-detail');if(det)det.innerHTML='<div class="v-h">Deleted</div><div class="v-body"><p class="muted">Removed @'+igEsc(IG_USER||IG_NAME)+' — '+((r.freedBytes/1e9).toFixed(2))+' GB freed.</p></div>';window.loadInstagram();}
        else dout.innerHTML='<p class="muted">'+igEsc(r.error||'could not delete')+'</p>';});};};
}
// ✦ Insights — the ranked, cited output of lib/instagram/insights.mjs (GET /api/instagram/insights):
// the SAME lines the board meeting and Board Room chat receive. Strength is computed server-side from
// independent creators/videos; nothing here re-scores or invents. Dates are California dates.
var CI_TYPES={hook:'Hooks',format:'Formats',topic:'Topics',audience_pain:'Audience pains',cadence:'Cadence',tactic:'Tactics',advice:'Job-seeker advice',brand:'Brand trust',monetization:'Monetization',product:'Product'};
var CI_RANK=['anecdotal','emerging','moderate','strong'];
var CI_STATE={cross:{type:'',min:'moderate'},one:{type:'',min:'emerging'}};
function ciDate(iso){if(!iso)return '';var d=new Date(iso);if(isNaN(d.getTime()))return '';return d.toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric'});}
function ciUrl(u){return /^https?:/i.test(String(u||''))?String(u):null;}
function ciUsedMap(m){var out={};if(!m||!m.byDept)return out;Object.keys(m.byDept).forEach(function(d){(m.byDept[d]||[]).forEach(function(i){(out[i.id]||(out[i.id]=[])).push(d);});});return out;}
function ciCard(i,used){
  var s=i.support||{},bits=['<b>'+s.creators+' creator'+(s.creators===1?'':'s')+' / '+s.videos+' video'+(s.videos===1?'':'s')+'</b>'];
  if(s.of)bits.push(Math.round((s.share||0)*100)+'% of '+s.of+' videos');
  if(s.handles&&s.handles.length)bits.push(s.handles.slice(0,5).map(igEsc).join(', '));
  var last=ciDate(i.recency&&i.recency.last);if(last)bits.push('latest '+last);
  if(i.engagement)bits.push(igEsc(i.engagement.metric)+' '+i.engagement.ratio+'× creator median (n='+i.engagement.n+', '+i.engagement.creators+' creator'+(i.engagement.creators===1?'':'s')+'; correlation)');
  var same=(i.overlaps||[]).filter(function(o){return o.type===i.type;});
  var cites=(i.citations||[]).map(function(c){var u=ciUrl(c.url);var head=igEsc(c.handle||'')+(c.at?' · '+igEsc(c.at):'');
    return '<div class="ci-cite">'+(u?'<a href="'+igEsc(u)+'" target="_blank" rel="noopener">'+head+'</a>':head)+(c.excerpt?' — “'+igEsc(c.excerpt)+'”':'')+'</div>';}).join('');
  return '<div class="ci-card '+igEsc(i.strength)+'"><div class="ci-top"><span class="ci-badge '+igEsc(i.strength)+'">'+igEsc(i.strength)+'</span><span class="ci-badge">'+igEsc(CI_TYPES[i.type]||i.type)+' · '+igEsc(i.basis)+'</span>'
    +(used?'<span class="ci-used" title="sent to these departments in the last board meeting">in last meeting · '+igEsc(used.join(', '))+'</span>':'')
    +'<div class="ci-claim">'+igEsc(i.claim)+'</div></div>'
    +'<div class="ci-sup">'+bits.join(' · ')+'</div>'
    +(i.detail?'<div class="ci-detail">'+igEsc(i.detail)+'</div>':'')
    +(same.length?'<div class="ci-detail">Usually combined with: '+same.map(function(o){return igEsc(o.claim);}).join('; ')+'</div>':'')
    +(i.merged>1?'<div class="ci-detail">Merged from '+i.merged+' matching knowledge records.</div>':'')
    +(cites?'<div class="ci-cites">'+cites+'</div>':'')+'</div>';
}
function renderCreatorInsights(c,j,cross){
  var st=cross?CI_STATE.cross:CI_STATE.one;var all=j.insights||[];var t=j.totals||{};
  if(!t.creators){c.innerHTML='<p class="muted">No researched creators yet. Type <b>research instagram &lt;username&gt;</b> above — once two or more creators in the job-search niche are researched, the patterns they share show up here and in every board meeting.</p>';return;}
  var bs=t.byStrength||{};
  var h='<div class="ci-head"><b>'+t.creators+'</b> creator'+(t.creators===1?'':'s')+' · <b>'+t.posts+'</b> videos · '+(bs.strong||0)+' strong · '+(bs.moderate||0)+' moderate · '+(bs.emerging||0)+' emerging · '+(bs.anecdotal||0)+' anecdotal'
    +' <span class="muted">— strong = ≥3 creators &amp; ≥6 videos; moderate = ≥2 creators &amp; ≥3 videos; one creator alone never rates above emerging.</span></div>';
  var usedMap={};
  if(cross){var m=j.lastMeeting;usedMap=ciUsedMap(m);
    if(m){var depts=Object.keys(m.byDept||{});var cited=m.cited||[];
      h+='<div class="ci-meet"><b>Last board meeting</b> ('+igEsc(ciDate(m.at))+', '+igEsc(m.runId||'')+') received '+depts.map(function(d){return igEsc(d)+' '+(m.byDept[d]||[]).length;}).join(' · ')+' line(s)'
        +(cited.length?'; <b>'+cited.length+'</b> proposal'+(cited.length===1?'':'s')+' cited it: '+cited.slice(0,4).map(function(x){return '“'+igEsc(x.title)+'” ('+igEsc(x.dept)+')';}).join(', '):'; no proposal cited it')+'.</div>';}
    else h+='<div class="ci-meet">No board meeting has used creator evidence yet. The next one sends every <b>moderate</b> or <b>strong</b> line to growth, strategy, revenue and product (only the types each needs).</div>';}
  else h+='<div class="ci-meet">This creator alone: patterns are capped at <b>emerging</b> until another creator shows them too — see the cross-creator panel above.</div>';
  var types=[];all.forEach(function(i){if(types.indexOf(i.type)<0)types.push(i.type);});
  h+='<div class="ci-filters"><button class="ci-f'+(st.type===''?' on':'')+'" data-t="">All</button>'+types.map(function(ty){return '<button class="ci-f'+(st.type===ty?' on':'')+'" data-t="'+igEsc(ty)+'">'+igEsc(CI_TYPES[ty]||ty)+'</button>';}).join('')
    +'<select class="ci-sel" title="minimum strength">'+['strong','moderate','emerging','anecdotal'].map(function(s){return '<option value="'+s+'"'+(st.min===s?' selected':'')+'>'+s+' and up</option>';}).join('')+'</select></div>';
  var shown=all.filter(function(i){return (!st.type||i.type===st.type)&&CI_RANK.indexOf(i.strength)>=CI_RANK.indexOf(st.min);});
  h+=shown.length?'<div class="ci-list">'+shown.map(function(i){return ciCard(i,usedMap[i.id]);}).join('')+'</div>'
    :'<p class="muted">Nothing at this strength'+(st.type?' for '+igEsc(CI_TYPES[st.type]||st.type):'')+' yet. Lower the strength filter to see weaker (labelled) patterns'+(cross?', or research more creators in the same niche':'')+'.</p>';
  var ps=j.prunedSummary;if(cross&&ps&&ps.total)h+='<p class="muted ci-caveat">Dropped as off-purpose for SeenJobs: '+ps.total+' knowledge row'+(ps.total===1?'':'s')+' ('+Object.keys(ps.byFamily||{}).map(function(f){return ps.byFamily[f]+' '+igEsc(f);}).join(', ')+'). They never reach a meeting or the chat — "Keep it lean" archives them.</p>';
  if(j.caveat)h+='<p class="muted ci-caveat">'+igEsc(j.caveat)+'</p>';
  c.innerHTML=h;
  c.querySelectorAll('.ci-f').forEach(function(b){b.onclick=function(){st.type=b.dataset.t||'';renderCreatorInsights(c,j,cross);};});
  var sel=c.querySelector('.ci-sel');if(sel)sel.onchange=function(){st.min=sel.value;renderCreatorInsights(c,j,cross);};
}
// ★ Key Points — ONE creator's points from the CROSS-creator engine (GET /api/instagram/creators/:user):
// strongest first, each with this creator's own video + timestamp and the other creators who back it.
// Weak points stay listed, labelled. Off-purpose rows are counted with their reasons, never hidden silently.
function renderKeyPoints(c,j){
  if(j.archived){c.innerHTML='<div class="kp-verdict prune"><b>Archived by prune.</b> '+igEsc((j.archive&&j.archive.why)||'')+' <button class="ig-btn" id="kp-restore">Restore this creator</button></div>';
    var rb=document.getElementById('kp-restore');if(rb)rb.onclick=function(){igPost('/api/instagram/prune/restore',{project:IG_NAME}).then(function(){window.loadInstagram();igTab('keypoints');});};return;}
  var v=j.verdict||{},pts=j.keyPoints||[],pr=j.pruned||{},bs=j.byStrength||{};
  var h='<div class="kp-verdict '+igEsc(v.verdict||'')+'"><b>'+igEsc(String(v.verdict||'pending').toUpperCase())+'</b> — '+igEsc(v.why||'not judged yet')+'</div>';
  h+='<div class="ci-head"><b>'+pts.length+'</b> key point'+(pts.length===1?'':'s')+' for SeenJobs · '+(bs.strong||0)+' strong · '+(bs.moderate||0)+' moderate · '+(bs.emerging||0)+' emerging · '+(bs.anecdotal||0)+' anecdotal <span class="muted">— strength counts independent creators and videos; a point only this creator makes stays weak.</span></div>';
  if(pts.length)h+='<div class="ci-list">'+pts.map(function(i){var own=i.own;var x=Object.assign({},i,{citations:own?[own].concat((i.citations||[]).filter(function(c2){return c2.handle!==own.handle;}).slice(0,1)):i.citations});
    var card=ciCard(x,null);var also=(i.alsoBy&&i.alsoBy.length)?'also '+i.alsoBy.slice(0,4).map(igEsc).join(', '):'only this creator so far';
    return card.replace('<div class="ci-sup">','<div class="ci-sup"><b>'+also+'</b> · ');}).join('')+'</div>';
  else h+='<p class="muted">No key points that serve SeenJobs'+(pr.total?' — everything this creator taught was off-purpose (below)':' yet')+'.</p>';
  if(pr.total){h+='<div class="ig-panelbox"><b>Dropped as off-purpose: '+pr.total+'</b> <span class="muted">'+Object.keys(pr.byFamily||{}).map(function(f){return pr.byFamily[f]+' '+igEsc(f);}).join(' · ')+'</span>'
    +(pr.examples||[]).slice(0,6).map(function(r){return '<div class="ig-prune-row">“'+igEsc(r.title)+'” — <span class="muted">'+igEsc(r.why)+'</span></div>';}).join('')+'</div>';}
  if(j.caveat)h+='<p class="muted ci-caveat">'+igEsc(j.caveat)+'</p>';
  c.innerHTML=h;
}
// Unresolved — what it means, and each record with how it resolved or why it is still open.
function renderUnresolved(c,j){
  var items=j.items||[];var h='<div class="ig-panelbox"><b>'+(j.open||0)+' open · '+(j.resolved||0)+' resolved</b><div class="muted">'+igEsc(j.meaning||'')+'</div></div>';
  if(!items.length){c.innerHTML=h+'<p class="muted">Nothing ambiguous in this creator’s knowledge.</p>';return;}
  h+=items.map(function(i){var r=i.resolution||{};var st=r.status||'ambiguous';
    return '<div class="ig-un"><b>'+igEsc(i.title||i.knowledge_id)+'</b> <span class="ig-badge '+(st==='ambiguous'?'warn':'ok')+'">'+igEsc(st)+(r.how?' · '+igEsc(r.how):'')+'</span>'
      +'<div class="ig-un-r">'+igEsc(r.reason||'')+'</div>'
      +((i.evidence||[]).slice(0,1).map(function(e){return '<div class="ig-kcite">'+igEsc(igEvidenceHead(e,true))+' — '+igEsc(e.excerpt||'')+'</div>';}).join(''))
      +'<div class="ig-un-b"><button class="ig-btn" data-k="'+igEsc(i.knowledge_id)+'" data-s="confirmed">Confirm</button><button class="ig-btn" data-k="'+igEsc(i.knowledge_id)+'" data-s="deprecated">Retire</button>'+(r.how==='owner'?'<button class="ig-btn" data-k="'+igEsc(i.knowledge_id)+'" data-s="ambiguous">Undo my decision</button>':'')+'</div></div>';}).join('');
  c.innerHTML=h;
  c.querySelectorAll('.ig-un-b .ig-btn').forEach(function(b){b.onclick=function(){b.disabled=true;igPost(igP()+'/unresolved/'+encodeURIComponent(b.dataset.k),{status:b.dataset.s}).then(function(){igTab('unresolved');window.loadInstagram();});};});
}
// ✂ Keep it lean — the prune plan (what would be archived and why), archive / restore, and purge.
function igLoadPrune(){
  var el=document.getElementById('ig-prune-body');if(!el)return;
  igGet('/api/instagram/prune').then(function(j){
    var pl=j.plan||{},cn=pl.counts||{},ar=(j.archive&&j.archive.archived)||{accounts:[],rows:0},h='';
    var fam={};(pl.rows||[]).forEach(function(r){var f=r.family||'no link to Seen';fam[f]=(fam[f]||0)+1;});
    if(!cn.accounts&&!cn.rows)h+='<p class="muted">Nothing off-purpose left to archive — every remaining account and row serves SeenJobs.</p>';
    else{h+='<div class="ig-prune-row"><b>Would archive '+cn.accounts+' account'+(cn.accounts===1?'':'s')+' and '+cn.rows+' row'+(cn.rows===1?'':'s')+'</b>'+(cn.bytes?' <span class="muted">('+fmtBytes(cn.bytes)+' on disk)</span>':'')+'</div>';
      h+=(pl.accounts||[]).map(function(a){return '<div class="ig-prune-row">'+igEsc(a.handle||a.project)+' — <span class="muted">'+igEsc(a.why||'')+'</span></div>';}).join('');
      if(cn.rows)h+='<div class="ig-prune-row muted">Rows: '+Object.keys(fam).map(function(f){return fam[f]+' '+igEsc(f);}).join(' · ')+'</div>';
      h+='<div style="margin-top:6px"><button class="ig-btn" id="ig-prune-go">Archive them now (reversible)</button></div>';}
    if(ar.accounts.length||ar.rows){h+='<div class="ig-sub2">Archived</div>'+ar.accounts.map(function(a){return '<div class="ig-prune-row">'+igEsc(a.handle||a.project)+' <span class="muted">'+igEsc(ciDate(a.at))+' — '+igEsc(a.why||'')+'</span> <button class="ig-btn" data-restore="'+igEsc(a.project)+'">Restore</button></div>';}).join('')
      +(ar.rows?'<div class="ig-prune-row muted">'+ar.rows+' archived row(s)</div>':'')+'<div style="margin-top:6px"><button class="ig-btn" id="ig-restore-all">Restore everything</button></div>'
      +'<div class="ig-confirm">Purge frees the disk: every archived account’s folder (videos, audio, frames, evidence, knowledge) is deleted for good. Type <code>'+igEsc(j.purgePhrase||'PURGE ARCHIVED')+'</code><br><input id="ig-purge-in" class="v-search" placeholder="'+igEsc(j.purgePhrase||'PURGE ARCHIVED')+'"/> <button class="ig-btn ig-btn-danger" id="ig-purge-go">Purge archived</button><div id="ig-purge-out" class="muted"></div></div>';}
    el.innerHTML=h;
    var go=document.getElementById('ig-prune-go');if(go)go.onclick=function(){go.disabled=true;go.textContent='archiving…';igPost('/api/instagram/prune',{}).then(function(){window.loadInstagram();});};
    el.querySelectorAll('[data-restore]').forEach(function(b){b.onclick=function(){igPost('/api/instagram/prune/restore',{project:b.dataset.restore}).then(function(){window.loadInstagram();});};});
    var ra=document.getElementById('ig-restore-all');if(ra)ra.onclick=function(){igPost('/api/instagram/prune/restore',{all:true}).then(function(){window.loadInstagram();});};
    var pg=document.getElementById('ig-purge-go');if(pg)pg.onclick=function(){var v=(document.getElementById('ig-purge-in').value||'').trim();var o=document.getElementById('ig-purge-out');
      igPost('/api/instagram/purge-archived',{confirm:v}).then(function(r){if(!r.ok){o.textContent=r.error||'not purged';return;}o.textContent='Purged '+r.purged.accounts.length+' folder(s), '+fmtBytes(r.purged.freedBytes)+' freed'+(r.keptArchived&&r.keptArchived.length?'; kept archived: '+r.keptArchived.map(function(k){return k.project;}).join(', '):'')+'.';setTimeout(window.loadInstagram,1200);});};
  }).catch(function(){el.innerHTML='<p class="muted">Prune plan unavailable.</p>';});
}
// ⌕ Find creators — start a discovery, poll it, render the two lists, queue the chosen ones.
var IG_DISC=null;
function igLoadLastDiscovery(){if(IG_DISC)return;igGet('/api/instagram/discover').then(function(j){var d=(j.discoveries||[])[0];if(d)igPollDiscovery(d.id);}).catch(function(){});}
function igPollDiscovery(id){IG_DISC=id;igGet('/api/instagram/discover/'+encodeURIComponent(id)).then(function(d){renderDiscovery(d||{});if(d&&d.status==='running')setTimeout(function(){if(IG_DISC===id)igPollDiscovery(id);},3000);}).catch(function(){});}
function igDiscCard(c,list){
  var f=c.followers?' · '+Number(c.followers).toLocaleString('en-US')+' followers':'';
  return '<div class="ig-dc"><label><input type="checkbox" class="ig-dsel" value="'+igEsc(c.handle)+'"/><span><a href="'+igEsc(c.url)+'" target="_blank" rel="noopener"><b>@'+igEsc(c.handle)+'</b></a>'+(c.name?' <span class="muted">'+igEsc(c.name)+'</span>':'')+'<span class="muted">'+f+'</span>'
    +'<div class="ig-dr">'+(c.reasons||[]).map(igEsc).join(' · ')+'</div>'
    +(c.angle?'<div class="ig-da">Seen angle: <a href="'+igEsc(c.angle.url)+'" target="_blank" rel="noopener">'+igEsc(c.angle.asset)+'</a> — '+igEsc(c.angle.story)+'</div>':(list==='audience'?'':'<div class="ig-dr">no clear Seen angle yet</div>'))+'</span></label></div>';
}
function renderDiscovery(d){
  var o=document.getElementById('ig-disc-out');if(!o)return;
  var stop=d.stoppedBy==='google_blocked'?'Google asked for a CAPTCHA — stopped (never solved). Try again later.':d.stoppedBy==='opencli_unavailable'?'OpenCLI unavailable: '+((d.opencli&&d.opencli.detail)||'')+(d.opencli&&d.opencli.fix?' — '+d.opencli.fix:''):d.stoppedBy==='bridge_down'?'The Chrome Browser Bridge stopped answering.':'';
  var h='<div class="ig-dstep"><b>'+igEsc(d.goal||'')+'</b> · '+igEsc(d.status||'')+' · '+igEsc(ciDate(d.startedAt))+(stop?' · <span style="color:var(--amber)">'+igEsc(stop)+'</span>':'')+'</div>';
  if(d.status==='running'){h+=(d.steps||[]).map(function(s){return '<div class="ig-dstep">'+igEsc(s.query||s.step||'')+' — '+igEsc(s.status)+(s.instagram!=null?' ('+s.instagram+' Instagram result'+(s.instagram===1?'':'s')+')':'')+'</div>';}).join('')+'<p class="muted">Searching in your Chrome…</p>';o.innerHTML=h;return;}
  h+='<div class="ig-dl"><div><div class="ig-dh">Learn from · '+(d.learn||[]).length+'</div>'+((d.learn||[]).map(function(c){return igDiscCard(c,'learn');}).join('')||'<p class="muted">none found</p>')+'</div>'
    +'<div><div class="ig-dh">Audience fit — would cite Seen · '+(d.audience||[]).length+'</div>'+((d.audience||[]).map(function(c){return igDiscCard(c,'audience');}).join('')||'<p class="muted">none found</p>')+'</div></div>';
  if(d.stoppedBy==='opencli_unavailable')h+='<div class="ig-dstep">Run by hand: '+(d.queries||[]).map(igEsc).join(' · ')+'</div>';
  h+='<div style="margin-top:6px"><button class="ig-btn" id="ig-dq">Research selected</button> <span class="muted" id="ig-dq-out">Queued when the worker is busy (2 at a time). Nobody is contacted.</span></div>';
  if((d.queued||[]).length)h+='<div class="ig-dstep">Requested: '+d.queued.map(function(q){return '@'+igEsc(q.handle)+' '+(q.ok?(q.queued?'queued #'+q.position:'started'):'— '+igEsc(q.error||''));}).join(' · ')+'</div>';
  o.innerHTML=h;
  var b=document.getElementById('ig-dq');if(b)b.onclick=function(){var hs=[].slice.call(o.querySelectorAll('.ig-dsel:checked')).map(function(x){return x.value;});var out=document.getElementById('ig-dq-out');
    if(!hs.length){out.textContent='Tick the creators to research first.';return;}b.disabled=true;
    igPost('/api/instagram/discover/'+encodeURIComponent(d.id)+'/queue',{handles:hs}).then(function(r){out.textContent=r.ok?r.results.map(function(x){return '@'+x.handle+': '+(x.ok?(x.queued?'queued #'+x.position:'started'):x.error);}).join(' · '):(r.error||'failed');b.disabled=false;setTimeout(window.loadInstagram,800);});};
}
(function(){var go=document.getElementById('ig-disc-go'),inp=document.getElementById('ig-disc-goal');if(!go||!inp)return;
  function run(){var g=(inp.value||'').trim();var o=document.getElementById('ig-disc-out');if(!g){if(o)o.innerHTML='<p class="muted">Say what to look for first.</p>';return;}
    if(!LIVE){if(o)o.innerHTML='<p class="muted">Launch via Seen Command for live discovery.</p>';return;}
    go.disabled=true;igPost('/api/instagram/discover',{goal:g}).then(function(r){go.disabled=false;if(!r.ok){o.innerHTML='<p class="muted">'+igEsc(r.error||'could not start')+'</p>';return;}igPollDiscovery(r.discovery.id);}).catch(function(){go.disabled=false;});}
  go.onclick=run;inp.addEventListener('keydown',function(e){if(e.key==='Enter')run();});})();
function renderGallery(c,vids){
  if(!vids.length){c.innerHTML='<p class="muted">No in-scope videos.</p>';return;}
  c.innerHTML='<div class="ig-gallery">'+vids.map(function(v){var cap=v.caption?(v.caption.length>80?v.caption.slice(0,80)+'…':v.caption):'(no caption)';
    var thumb=v.thumb?igP()+'/files?path='+encodeURIComponent(v.thumb):null;var cn=v.counts||{};
    return '<button class="ig-gcard" data-id="'+igEsc(v.source_id)+'">'
      +'<div class="ig-gthumb">'+(thumb?'<img loading="lazy" src="'+thumb+'"/>':'<div class="ig-gnothumb">🎬</div>')+(v.localMedia?'<span class="ig-play">▶</span>':'')+'</div>'
      +'<div class="ig-gcap">'+igEsc(cap)+'</div>'
      +'<div class="ig-gm">'+(cn.evidence||0)+' raw evidence · '+(cn.knowledge||0)+' knowledge</div></button>';}).join('')+'</div>';
  c.querySelectorAll('.ig-gcard').forEach(function(b){b.onclick=function(){openVideoModal(b.dataset.id);};});
}
function openVideoModal(id){
  var ov=document.createElement('div');ov.className='ig-modal';ov.innerHTML='<div class="ig-modal-box"><button class="ig-modal-x" aria-label="close">×</button><div class="ig-modal-body"><p class="muted">Loading…</p></div></div>';
  document.body.appendChild(ov);function close(){ov.remove();}
  ov.addEventListener('click',function(e){if(e.target===ov)close();});ov.querySelector('.ig-modal-x').onclick=close;
  igGet(igP()+'/videos/'+encodeURIComponent(id)).then(function(j){var b=ov.querySelector('.ig-modal-body'),v=j.video||{},html='';
    if(v.localMedia)html+='<video class="ig-player" controls autoplay preload="metadata" src="'+igP()+'/media/'+encodeURIComponent(id)+'"></video>';
    else html+='<div class="ig-noplayer">No local video (raw media not retained). '+(v.source_url?'<a href="'+igEsc(v.source_url)+'" target="_blank" rel="noopener">View on Instagram</a>':'')+'</div>';
    if(v.caption)html+='<div class="ig-mcap">'+igEsc(v.caption)+'</div>';
    var kn=j.knowledge||[];html+='<div class="ig-sub2">Extracted knowledge <span class="muted">(advice linked to this video)</span></div>';
    html+=kn.length?kn.map(function(k){return '<div class="ig-kn"><b>'+igEsc(k.title)+'</b> <span class="ig-badge">'+igEsc(k.type||'')+'</span>'+(k.description?'<div class="muted">'+igEsc(k.description)+'</div>':'')+'</div>';}).join(''):'<p class="muted">No knowledge linked to this video yet. Compilation may still be running.</p>';
    var ev=j.evidence||[];html+='<div class="ig-sub2">Clean evidence excerpts <span class="muted">(raw archive remains available in Files)</span></div>';
    html+=ev.length?'<div class="ig-ev">'+ev.slice(0,40).map(function(e){return '<div class="ig-ev-row"><span class="ig-ev-ts">'+igEsc(igEvidenceHead(e,false))+'</span> <span class="ig-ev-c">'+igEsc((e.content||'').slice(0,320))+'</span></div>';}).join('')+'</div>':'<p class="muted">none</p>';
    var art=j.artifacts||{},links=[];if(art.transcript)links.push('<a href="'+igP()+'/files?path='+encodeURIComponent(art.transcript)+'" target="_blank" rel="noopener">transcript</a>');if(v.source_url)links.push('<a href="'+igEsc(v.source_url)+'" target="_blank" rel="noopener">source</a>');
    if(links.length)html+='<div class="ig-art">'+links.join(' · ')+'</div>';
    b.innerHTML=html;
  }).catch(function(){ov.querySelector('.ig-modal-body').innerHTML='<p class="muted">Could not load this video.</p>';});
}
function renderKnowledge(c,ks){
  if(!ks.length){c.innerHTML='<p class="muted">No knowledge was saved yet.</p><button class="ig-btn" id="ig-resume-knowledge">Resume research job</button><div id="ig-resume-out" class="muted"></div>';var rb=document.getElementById('ig-resume-knowledge'),ro=document.getElementById('ig-resume-out');if(rb)rb.onclick=function(){rb.disabled=true;ro.textContent='Finding the research job…';igGet('/api/instagram/jobs').then(function(j){var job=(j.jobs||[]).find(function(x){return x.project===IG_NAME;});if(!job){ro.textContent='No research job was found for this folder.';return;}var reuse=['knowledge','reconcile','audit','cleanup_preview'].indexOf(job.stage)>=0;igPost('/api/instagram/jobs/'+encodeURIComponent(job.id)+'/resume',{}).then(function(r){ro.textContent=r.ok?(reuse?'Resumed using existing videos and evidence; no Instagram download.':'Resumed from '+job.stage+'.'):(r.error||'Could not resume.');});}).catch(function(){ro.textContent='Could not resume.';});};return;}
  var groups={};ks.forEach(function(k){(groups[k.type||'other']||(groups[k.type||'other']=[])).push(k);});
  var order=['principle','rule','workflow','formula','tool','warning','exception','example','claim','other'];
  var h='<div class="ig-panelbox"><b>Creator Intelligence Playbook</b><div class="muted">'+ks.length+' evidence-linked knowledge records. <a href="'+igP()+'/files?path='+encodeURIComponent('knowledge/creator-playbook.md')+'" target="_blank" rel="noopener">Open all advice at once</a></div></div>';
  order.forEach(function(type){var items=groups[type]||[];if(!items.length)return;h+='<div class="ig-kgroup">'+igEsc(type)+'s · '+items.length+'</div>';
    h+=items.map(function(k){var r=k.record||{},details=[];
      if(Array.isArray(r.conditions)&&r.conditions.length)details.push('<b>When:</b> '+igEsc(r.conditions.join('; ')));
      if(Array.isArray(r.steps)&&r.steps.length)details.push('<b>Steps:</b> '+igEsc(r.steps.map(function(s,i){return (i+1)+'. '+s;}).join(' ')));
      if(Array.isArray(r.exceptions)&&r.exceptions.length)details.push('<b>Exceptions:</b> '+igEsc(r.exceptions.join('; ')));
      var ev=(k.evidence||[]).map(function(e){var url=/^https?:\\/\\//i.test(e.source_url||'')?'<a href="'+igEsc(e.source_url)+'" target="_blank" rel="noopener">source</a>':'source unavailable';return '<div class="ig-kcite">'+url+' · '+igEsc(igEvidenceHead(e,true))+' — '+igEsc((e.content||'').slice(0,260))+'</div>';}).join('');
      return '<div class="ig-kn"><b>'+igEsc(k.title)+'</b> <span class="ig-badge">'+igEsc(k.type||'')+'</span>'+(k.description?'<div>'+igEsc(k.description)+'</div>':'')+(details.length?'<div class="ig-kmeta">'+details.join('<br>')+'</div>':'')+'<div class="ig-kmeta">'+igEsc(k.attribution||'')+' · '+igEsc(k.status||'')+' · '+Math.round((Number(k.confidence)||0)*100)+'% confidence · '+(k.evidence_count||0)+' citation(s)</div>'+ev+'</div>';}).join('');
  });c.innerHTML=h;
}
function renderGuidance(c,bs){if(!bs.length){c.innerHTML='<p class="muted">No guidance briefs. Use the run bar: <b>use '+igEsc(IG_USER||IG_NAME)+' guidance to &lt;objective&gt;</b>.</p>';return;}c.innerHTML=bs.map(function(b){var t=b.downstream&&b.downstream.task;return '<div class="ig-brief"><b>'+igEsc(b.seenObjective||b.briefId)+'</b> <span class="ig-badge '+(b.status==='approved'?'ok':'warn')+'">'+igEsc(b.status||'draft')+'</span><div class="muted">'+(b.knowledge||0)+' knowledge · '+(b.evidence||0)+' evidence · source_derived'+(t&&t.url?' · <a href="'+igEsc(t.url)+'" target="_blank" rel="noopener">task #'+igEsc(t.number)+'</a>':'')+'</div></div>';}).join('');}
function fmtBytes(n){n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(0)+' KB';if(n<1073741824)return (n/1048576).toFixed(1)+' MB';return (n/1073741824).toFixed(2)+' GB';}
function igLoadTree(c,path){
  igGet(igP()+'/tree?path='+encodeURIComponent(path||'')).then(function(t){if(t.error){c.innerHTML='<p class="muted">'+igEsc(t.error)+'</p>';return;}
    var h='<div class="ig-crumb">'+(path?'<button class="ig-crumb-up" data-p="'+igEsc(t.parent||'')+'">⬆ up</button> ':'')+'<span class="muted">/'+igEsc(path||'')+'</span></div><div class="ig-files">';
    h+=t.dirs.map(function(d){return '<button class="ig-fentry ig-fdir" data-p="'+igEsc(d.path)+'">📁 '+igEsc(d.name)+'</button>';}).join('');
    h+=t.files.map(function(f){if(f.servable)return '<a class="ig-fentry ig-ffile" href="'+igP()+'/files?path='+encodeURIComponent(f.path)+'" target="_blank" rel="noopener">📄 '+igEsc(f.name)+' <span class="muted">'+fmtBytes(f.bytes)+'</span></a>';return '<span class="ig-fentry ig-fother">'+(f.media?'🎬 ':'• ')+igEsc(f.name)+' <span class="muted">'+fmtBytes(f.bytes)+(f.media?' — open via Videos':'')+'</span></span>';}).join('');
    h+='</div>';c.innerHTML=h;
    c.querySelectorAll('.ig-fdir').forEach(function(b){b.onclick=function(){igLoadTree(c,b.dataset.p);};});
    var up=c.querySelector('.ig-crumb-up');if(up)up.onclick=function(){igLoadTree(c,up.dataset.p);};
  }).catch(function(){c.innerHTML='<p class="muted">Could not list files.</p>';});
}
function igFmtTs(s){s=Math.max(0,Math.floor(Number(s)||0));var m=Math.floor(s/60),ss=s%60;return m+':'+(ss<10?'0':'')+ss;}
function igEvidenceType(e){var t=String((e&&e.evidence_type)||'evidence').toLowerCase();return t==='spoken'?'Spoken':t==='ocr'?'Screen text':t==='caption'?'Caption':t;}
function igEvidenceTime(e){if(!e||String(e.evidence_type||'').toLowerCase()==='caption')return '';if(e.timestamp_start==null)return '';var start=Number(e.timestamp_start),end=Number(e.timestamp_end);if(!Number.isFinite(start))return '';var out=igFmtTs(start);if(Number.isFinite(end)&&end>start+0.5)out+='–'+igFmtTs(end);return out;}
function igEvidenceHead(e,withVideo){var parts=[];if(withVideo&&e&&e.video_id)parts.push(e.video_id);parts.push(igEvidenceType(e));var time=igEvidenceTime(e);if(time)parts.push(time);return parts.join(' · ');}
function igSearch(name,q){
  var out=document.getElementById('ig-search-out');if(!out)return;q=(q||'').trim();if(!q){out.innerHTML='';return;}
  out.innerHTML='<p class="muted">Searching…</p>';
  igPost('/api/instagram/projects/'+encodeURIComponent(name)+'/search',{query:q,limit:25}).then(function(j){
    if(j&&j.results&&j.results.error){out.innerHTML='<p class="muted">'+igEsc(j.results.error)+'</p>';return;}
    var rs=(j&&j.results)||[];
    out.innerHTML=rs.length?rs.map(function(r){return '<div class="ig-sr"><span class="ig-badge">'+igEsc(r.kind||'')+'</span> <b>'+igEsc(r.title||'')+'</b><div class="muted">'+igEsc(r.snippet||'')+'</div></div>';}).join(''):'<p class="muted">No matches.</p>';
  }).catch(function(){out.innerHTML='<p class="muted">Search failed.</p>';});
}
(function(){var go=document.getElementById('ig-go');var inp=document.getElementById('ig-q');if(!go||!inp)return;
  function run(){var t=(inp.value||'').trim();if(!t)return;var out=document.getElementById('ig-out');
    if(!LIVE){if(out){out.hidden=false;out.textContent='Launch via Seen Command.command for live research.';}return;}
    if(out){out.hidden=false;out.textContent='Working…';}go.disabled=true;
    igPost('/api/chat',{message:t}).then(function(j){
      if(out){out.hidden=false;out.textContent=(j&&j.reply)||'Done.';}go.disabled=false;setTimeout(window.loadInstagram,800);
    }).catch(function(){if(out){out.hidden=false;out.textContent='Request failed.';}go.disabled=false;});}
  go.onclick=run;inp.addEventListener('keydown',function(e){if(e.key==='Enter')run();});})();
${AGG_CLIENT}
${APP_CLIENT}
${JOBS_CLIENT}
${DATA_HEALTH_CLIENT}
${MONEY_CLIENT}
${TICKETS_CLIENT}
${GROWTH_CLIENT}
${UPDATE_CLIENT}
${BRAIN_GRAPH}
${BRAIN_CLIENT}
(function(){
  function ptHour(){return +new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',hour12:false})%24;}
  function tick(){var d=new Date();var s=d.toLocaleString('en-US',{timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});var c=document.getElementById('clock');if(c)c.textContent=s+' PT';
    var h=ptHour(),g=h<5?'Good evening':h<12?'Good morning':h<18?'Good afternoon':'Good evening';document.querySelectorAll('[data-greet]').forEach(function(e){e.textContent=g;});}
  tick();setInterval(tick,30000);
  // Board-meeting output is baked into this page; say how old it is when it is, with a one-click refresh.
  document.querySelectorAll('.stale-banner').forEach(function(bn){var at=new Date(bn.dataset.generatedAt);if(isNaN(at))return;var hrs=(Date.now()-at)/36e5;if(hrs<=36)return;
    var days=Math.round(hrs/24);bn.querySelector('[data-stale-day]').textContent=at.toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric'});bn.querySelector('[data-stale-age]').textContent=days+' day'+(days===1?'':'s')+' ago';bn.hidden=false;
    var btn=bn.querySelector('[data-stale-run]');btn.onclick=function(){document.querySelectorAll('[data-stale-run]').forEach(function(x){x.disabled=true;x.textContent='Meeting in progress\u2026 (a few minutes)';});
      fetch('/api/board-meeting',{method:'POST'}).then(function(r){return r.json();}).then(function(j){if(j&&j.ok===false)throw new Error(j.error||'failed');softReload();}).catch(function(e){btn.disabled=false;btn.textContent='Meeting failed: '+e.message;});};});
  var t=document.getElementById('labs-toggle');
  if(t){t.checked=document.documentElement.classList.contains('labs-on');t.onchange=function(){document.documentElement.classList.toggle('labs-on',t.checked);try{localStorage.setItem('sc_labs',t.checked?'1':'0');}catch(e){}};}
})();
</script>`;

const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Seen Command</title>'
  + '<script id="labs-early">try{if(localStorage.getItem(\'sc_labs\')===\'1\')document.documentElement.classList.add(\'labs-on\');}catch(e){}</script>'
  + STYLE + '<style>' + THEME_CSS + 'html.electron .rail{padding-top:38px!important}</style></head><body>' + MARKUP + SCRIPT + '</body></html>';

const out = dashboardPath();
writeFileSync(out, html);
console.log(`Wrote ${out}`);
