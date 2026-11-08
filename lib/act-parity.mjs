// Chat ↔ button PARITY: every HTTP route Seen Command serves, what its button does, and the
// `node scripts/act.mjs` verb that does the same thing from the Board Room chat.
//
// This list is the source of docs/ACT_PARITY.md (`node scripts/act-parity-doc.mjs`), and
// scripts/act-parity.test.mjs holds it to the truth both ways:
//   • every write call the UI makes (scripts/build-dashboard.mjs, lib/ui/*.js, the aggregation client)
//     must match a route here — a new button cannot appear without an entry;
//   • every write route a button uses must name a verb that exists in scripts/act.mjs, or sit in the
//     ALLOWED-ONLY-IN-THE-UI list below with the reason (credential secrets, the chat itself, the
//     browser-rendered image upload).
// Paths use :name for a variable segment. ui = what the button does ('' = no button: an API the chat,
// the board meeting or a local integration uses).

export const ROUTES = [
  // ---- Home, notifications, state ----
  { m: 'GET', path: '/api/home', ui: 'Home tab (and its Refresh)', verbs: ['home'] },
  { m: 'GET', path: '/api/notifications', ui: 'Notifications tab + unread badge', verbs: ['notifications'] },
  { m: 'POST', path: '/api/notifications/read', ui: 'Mark all read / open one', verbs: ['notifications-read'] },
  { m: 'POST', path: '/api/notifications/clear', ui: 'Clear notifications', verbs: ['notifications-clear'] },
  { m: 'GET', path: '/api/state', ui: 'dashboard reload (the whole board state)', verbs: ['brief'] },
  { m: 'GET', path: '/api/signals', ui: '', verbs: [], note: 'board-meeting input; the chat reads live connectors with ops.mjs state' },
  // ---- Board Room ----
  { m: 'POST', path: '/api/board-meeting', ui: 'Run a board meeting', verbs: ['meeting'] },
  { m: 'POST', path: '/api/approve', ui: 'Approve / Deny on an approval card', verbs: ['approve', 'deny'] },
  { m: 'POST', path: '/api/chat', ui: 'Board Room send (non-streaming) + the Creator Library question box', verbs: [], allow: 'it IS the chat — the chat calling itself would recurse' },
  { m: 'POST', path: '/api/chat/stream', ui: 'Board Room send', verbs: [], allow: 'it IS the chat — the chat calling itself would recurse' },
  { m: 'GET', path: '/api/chat-history', ui: 'Board Room history', verbs: [], note: 'the chat already has its conversation' },
  { m: 'POST', path: '/api/simulate', ui: 'Simulate (Home approval card, Money)', verbs: ['simulate'] },
  { m: 'GET', path: '/api/simulate', ui: '', verbs: ['simulations'] },
  { m: 'GET', path: '/api/simulate/:id', ui: '', verbs: ['simulation'] },
  { m: 'GET', path: '/api/assistant/brief', ui: '', verbs: ['brief'] },
  { m: 'GET', path: '/api/assistant/recall', ui: '', verbs: ['recall'] },
  { m: 'POST', path: '/api/assistant/note', ui: '', verbs: ['note', 'fact'] },
  { m: 'GET', path: '/api/assistant/skills', ui: '', verbs: ['skills'] },
  { m: 'POST', path: '/api/terminal/claude', ui: 'Home → Open Claude Code', verbs: ['terminal'] },
  // ---- Knowledge vault ----
  { m: 'POST', path: '/api/ask', ui: 'Knowledge Vault → Ask', verbs: ['ask'] },
  { m: 'GET', path: '/api/vault', ui: 'Knowledge Vault tab', verbs: ['vault'] },
  { m: 'GET', path: '/api/brain-review', ui: '', verbs: ['vault'] },
  { m: 'POST', path: '/api/brain/record', ui: '', verbs: ['note', 'fact'], note: 'local integrations; the chat writes through /api/assistant/note' },
  // ---- Tasks + builds ----
  { m: 'GET', path: '/api/tasks', ui: 'Tasks tab', verbs: ['tasks'] },
  { m: 'POST', path: '/api/tasks/build', ui: 'Tasks → ▶ Build', verbs: ['task-build'] },
  { m: 'POST', path: '/api/tasks/delete', ui: 'Tasks → Delete', verbs: ['task-delete'] },
  { m: 'POST', path: '/api/tasks/new', ui: '', verbs: ['build'], note: 'NEW: file a task + start the builder (was only the chat\'s "build … in Seen Command" command)' },
  { m: 'GET', path: '/api/builds', ui: 'build progress (polled while a build runs)', verbs: ['builds', 'build-status'] },
  // ---- Tickets + PRs ----
  { m: 'GET', path: '/api/tickets', ui: 'Tickets tab', verbs: ['tickets'] },
  { m: 'GET', path: '/api/tickets/summary', ui: 'Tickets badge', verbs: ['tickets'] },
  { m: 'POST', path: '/api/tickets', ui: '', verbs: ['ticket-new'] },
  { m: 'GET', path: '/api/tickets/:id', ui: 'ticket drawer', verbs: ['ticket'] },
  { m: 'POST', path: '/api/tickets/:id/fix', ui: 'Fix it (builder or ready-for-AI)', verbs: ['ticket-fix'] },
  { m: 'POST', path: '/api/tickets/:id/wont-fix', ui: "Won't fix", verbs: ['ticket-wontfix'] },
  { m: 'POST', path: '/api/tickets/:id/duplicate', ui: 'Duplicate of…', verbs: ['ticket-dup'] },
  { m: 'POST', path: '/api/tickets/:id/note', ui: 'Add a note', verbs: ['ticket-note'] },
  { m: 'POST', path: '/api/tickets/:id/open', ui: 'Reopen / Release claim', verbs: ['ticket-reopen'] },
  { m: 'GET', path: '/api/prs', ui: 'open PRs list', verbs: ['prs'] },
  { m: 'GET', path: '/api/prs/:owner/:repo/:n', ui: 'PR panel: checks + mergeability', verbs: ['merge-pr'] },
  { m: 'POST', path: '/api/prs/:owner/:repo/:n/merge', ui: 'Merge', verbs: ['merge-pr'], note: "only with Brandon's exact confirm phrase" },
  // ---- Search + listings ----
  { m: 'POST', path: '/api/search', ui: 'Search box Start / a preset button', verbs: ['search', 'search-run', 'preset'] },
  { m: 'GET', path: '/api/search', ui: 'search history', verbs: ['searches'] },
  { m: 'GET', path: '/api/search/presets', ui: 'preset buttons', verbs: ['presets'] },
  { m: 'GET', path: '/api/search/plan', ui: 'live plan preview under the box', verbs: ['search-plan'] },
  { m: 'GET', path: '/api/search/:id', ui: '', verbs: ['search-status'] },
  { m: 'GET', path: '/api/jobs', ui: 'Jobs tab list / Home recent jobs', verbs: ['jobs'] },
  { m: 'GET', path: '/api/jobs/:id', ui: 'job drawer', verbs: ['job'] },
  { m: 'POST', path: '/api/jobs/:id', ui: 'job drawer → Save', verbs: ['job-edit'] },
  { m: 'POST', path: '/api/jobs/:id/remove', ui: 'Take off the site', verbs: ['job-remove'] },
  { m: 'POST', path: '/api/jobs/:id/restore', ui: 'Put back', verbs: ['job-restore'] },
  // ---- Collection pipelines (Search → Advanced) ----
  { m: 'GET', path: '/api/aggregation/status', ui: 'pipeline cards', verbs: ['pipelines'] },
  { m: 'GET', path: '/api/aggregation/health', ui: 'Health tab / Re-check', verbs: ['pipeline-health'] },
  { m: 'GET', path: '/api/aggregation/collectors', ui: '', verbs: ['pipeline-health'] },
  { m: 'GET', path: '/api/aggregation/config', ui: 'each tool tab\'s saved setup', verbs: ['pipeline-config'] },
  { m: 'PUT', path: '/api/aggregation/config', ui: 'Save setup / Seen repo folder', verbs: ['pipeline-config'] },
  { m: 'GET', path: '/api/aggregation/runs', ui: 'History tab', verbs: ['pipeline-runs'] },
  { m: 'POST', path: '/api/aggregation/runs', ui: 'Start (a pipeline run)', verbs: ['pipeline-start'] },
  { m: 'GET', path: '/api/aggregation/runs/:id', ui: 'run detail', verbs: ['pipeline-run'] },
  { m: 'POST', path: '/api/aggregation/runs/:id/cancel', ui: 'Cancel run', verbs: ['pipeline-cancel'] },
  { m: 'GET', path: '/api/aggregation/schedules', ui: 'Schedules tab', verbs: ['pipeline-schedules'] },
  { m: 'PUT', path: '/api/aggregation/schedules/:pipeline', ui: 'Save schedule', verbs: ['pipeline-schedule'] },
  { m: 'POST', path: '/api/aggregation/schedules/tick', ui: '', verbs: [], note: 'the scheduler\'s own tick (runs due schedules); no button' },
  { m: 'GET', path: '/api/aggregation/company-intel/catalog', ui: 'company picker', verbs: ['pipeline-health'], note: 'the picker\'s list; pipeline-start takes the names' },
  { m: 'GET', path: '/api/aggregation/indeed/presets', ui: 'Indeed maintenance presets', verbs: ['presets'] },
  { m: 'GET', path: '/api/aggregation/boards', ui: 'employer-board status', verbs: ['pipelines'] },
  { m: 'POST', path: '/api/aggregation/boards/pull', ui: 'Pull employer boards', verbs: ['boards-pull'] },
  { m: 'GET', path: '/api/aggregation/company-jobs', ui: 'company-jobs status', verbs: ['pipelines'] },
  { m: 'POST', path: '/api/aggregation/company-jobs', ui: 'Company jobs → Pull', verbs: ['company-jobs'] },
  { m: 'POST', path: '/api/aggregation/company-intel/targets', ui: '', verbs: ['pipeline-start'], note: 'a preview of the targets a run would pick' },
  // ---- Data health ----
  { m: 'GET', path: '/api/data-health', ui: 'Data health panel (+ Re-scan)', verbs: ['data-health'] },
  { m: 'GET', path: '/api/data-health/run', ui: 'cleanup progress', verbs: ['clean'] },
  { m: 'GET', path: '/api/data-health/history', ui: 'past cleanups', verbs: ['data-health-history'] },
  { m: 'POST', path: '/api/data-health/clean', ui: 'Clean (each kind / all)', verbs: ['clean'] },
  { m: 'POST', path: '/api/data-health/settings', ui: 'daily automatic cleanup switch', verbs: ['data-health-auto'] },
  { m: 'POST', path: '/api/data-health/review', ui: 'look-alike group → Fine as is', verbs: ['lookalike-ok'] },
  // ---- Money ----
  { m: 'GET', path: '/api/money', ui: 'Money tab', verbs: ['money'] },
  { m: 'GET', path: '/api/money/scale', ui: 'Scale section', verbs: ['scale'] },
  { m: 'GET', path: '/api/money/allocate', ui: 'Allocation section', verbs: ['allocate'] },
  { m: 'GET', path: '/api/money/units', ui: 'Unit economics', verbs: ['units'] },
  { m: 'GET', path: '/api/money/costs', ui: 'Costs section', verbs: ['costs'] },
  { m: 'GET', path: '/api/money/simulation-inputs', ui: '', verbs: [], note: 'what simulations read for numbers; used inside simulate' },
  { m: 'POST', path: '/api/money/costs', ui: 'cost Save / Add / remove', verbs: ['cost-set', 'cost-remove'] },
  { m: 'POST', path: '/api/money/cash', ui: 'cash on hand Save', verbs: ['cash'] },
  { m: 'POST', path: '/api/money/allocate', ui: 'allocation Save / Reset', verbs: ['allocate-set', 'allocate-reset'] },
  { m: 'POST', path: '/api/money/channels', ui: 'channel Save', verbs: ['channel-set'] },
  { m: 'POST', path: '/api/money/readiness', ui: 'readiness checkbox', verbs: ['readiness'] },
  { m: 'POST', path: '/api/money/plan', ui: 'Supabase plan buttons', verbs: ['money-plan'] },
  { m: 'POST', path: '/api/money/scenario', ui: 'scenario levers → Project', verbs: ['scenario'] },
  // ---- Growth Studio ----
  { m: 'GET', path: '/api/growth/overview', ui: 'Growth tab', verbs: ['growth'] },
  { m: 'GET', path: '/api/growth/daily', ui: "today's 1% item", verbs: ['daily'] },
  { m: 'POST', path: '/api/growth/daily', ui: 'Done / Skip', verbs: ['daily'] },
  { m: 'GET', path: '/api/growth/plan', ui: 'Plan view', verbs: ['growth-plan'] },
  { m: 'POST', path: '/api/growth/plan', ui: 'Re-plan', verbs: ['growth-replan'] },
  { m: 'GET', path: '/api/growth/calendar', ui: 'Calendar view', verbs: ['calendar'] },
  { m: 'POST', path: '/api/growth/calendar/generate', ui: 'Generate calendar', verbs: ['calendar'] },
  { m: 'POST', path: '/api/growth/calendar/:id/status', ui: 'item → next status / reset', verbs: ['calendar-status'] },
  { m: 'POST', path: '/api/growth/calendar/:id/results', ui: 'item → Save results', verbs: ['calendar-results'] },
  { m: 'GET', path: '/api/growth/copy/:id', ui: 'calendar item drawer', verbs: ['calendar-item'] },
  { m: 'POST', path: '/api/growth/copy/:id/draft', ui: 'Draft copy', verbs: ['draft', 'ad'] },
  { m: 'POST', path: '/api/growth/copy/:id/approve', ui: 'Approve a variant', verbs: ['approve-copy'] },
  { m: 'GET', path: '/api/growth/brand', ui: 'Brand kit', verbs: ['brand'] },
  { m: 'POST', path: '/api/growth/brand', ui: 'Brand kit → Save', verbs: ['brand-set'] },
  { m: 'GET', path: '/api/growth/positioning', ui: 'Positioning', verbs: ['positioning'] },
  { m: 'GET', path: '/api/growth/rules', ui: '', verbs: ['positioning'], note: 'the trust rules; draft applies them' },
  { m: 'GET', path: '/api/growth/assets', ui: 'Creators view: assets + angles', verbs: ['growth-assets'] },
  { m: 'GET', path: '/api/growth/data', ui: 'designer data', verbs: ['growth-data'] },
  { m: 'GET', path: '/api/growth/ads', ui: 'Paid view', verbs: ['ad'] },
  { m: 'GET', path: '/api/growth/templates', ui: 'Ad designer templates', verbs: ['ad'] },
  { m: 'GET', path: '/api/growth/templates/:id', ui: 'one template spec', verbs: ['ad'] },
  { m: 'GET', path: '/api/growth/library', ui: 'saved ad images', verbs: ['growth-library'] },
  { m: 'POST', path: '/api/growth/library', ui: 'Ad designer → Save to library', verbs: [], allow: 'uploads the PNG the browser just rendered — the chat has no rendered image to send' },
  { m: 'GET', path: '/api/growth/library/:file', ui: 'an image', verbs: [], note: 'static file' },
  { m: 'GET', path: '/api/growth/fonts/:file', ui: 'designer fonts', verbs: [], note: 'static file' },
  { m: 'GET', path: '/api/growth/meeting', ui: '', verbs: ['growth'], note: "the board meeting's growth block" },
  // ---- Creator Library (Instagram) ----
  { m: 'GET', path: '/api/instagram/doctor', ui: 'toolchain check', verbs: ['creator-doctor'] },
  { m: 'GET', path: '/api/instagram/library', ui: 'Creator Library list', verbs: ['creators'] },
  { m: 'GET', path: '/api/instagram/creators', ui: '', verbs: ['creators'] },
  { m: 'GET', path: '/api/instagram/creators/:user', ui: 'creator overview', verbs: ['creator'] },
  { m: 'GET', path: '/api/instagram/insights', ui: '✦ Insights', verbs: ['creator-insights'] },
  { m: 'GET', path: '/api/instagram/prune', ui: 'Prune plan', verbs: ['prune'] },
  { m: 'POST', path: '/api/instagram/prune', ui: 'Prune', verbs: ['prune'] },
  { m: 'POST', path: '/api/instagram/prune/restore', ui: 'Restore (one / all)', verbs: ['restore-creators'] },
  { m: 'POST', path: '/api/instagram/purge-archived', ui: 'Purge archived (typed phrase)', verbs: ['purge-archived'], note: 'only on Brandon\'s words' },
  { m: 'GET', path: '/api/instagram/discover', ui: 'discoveries', verbs: ['discovery'] },
  { m: 'POST', path: '/api/instagram/discover', ui: 'Discover', verbs: ['discover'] },
  { m: 'GET', path: '/api/instagram/discover/:id', ui: 'a discovery', verbs: ['discovery'] },
  { m: 'POST', path: '/api/instagram/discover/:id/queue', ui: 'Research the chosen', verbs: ['queue-research'] },
  { m: 'POST', path: '/api/instagram/research', ui: '', verbs: ['research'] },
  { m: 'GET', path: '/api/instagram/queue', ui: '', verbs: ['creator-status'] },
  { m: 'GET', path: '/api/instagram/jobs', ui: 'research jobs', verbs: ['creator-status'] },
  { m: 'POST', path: '/api/instagram/jobs', ui: '', verbs: ['research'], note: 'raw job start; research is the queued, safe path' },
  { m: 'GET', path: '/api/instagram/jobs/:id', ui: 'a job', verbs: ['creator-status'] },
  { m: 'POST', path: '/api/instagram/jobs/:id/cancel', ui: '', verbs: [], note: 'no button; a stuck job is resumed or cleaned' },
  { m: 'POST', path: '/api/instagram/jobs/:id/resume', ui: 'Resume research job', verbs: ['creator-resume'] },
  { m: 'POST', path: '/api/instagram/jobs/:id/cleanup-preview', ui: 'Clean raw media (preview)', verbs: ['creator-cleanup'] },
  { m: 'POST', path: '/api/instagram/jobs/:id/cleanup-confirm', ui: 'Yes — delete raw media', verbs: ['creator-cleanup'] },
  { m: 'GET', path: '/api/instagram/projects/:p', ui: 'creator header', verbs: ['creator'] },
  { m: 'GET', path: '/api/instagram/projects/:p/videos', ui: 'Videos tab', verbs: [], note: 'browsing; creator / creator-search answer questions about them' },
  { m: 'GET', path: '/api/instagram/projects/:p/videos/:v', ui: 'a video', verbs: [], note: 'browsing' },
  { m: 'GET', path: '/api/instagram/projects/:p/knowledge', ui: 'Knowledge tab', verbs: ['creator'] },
  { m: 'GET', path: '/api/instagram/projects/:p/knowledge/:k', ui: '', verbs: ['creator'] },
  { m: 'GET', path: '/api/instagram/projects/:p/evidence/:e', ui: '', verbs: ['creator-search'] },
  { m: 'POST', path: '/api/instagram/projects/:p/search', ui: 'creator search box', verbs: ['creator-search'] },
  { m: 'GET', path: '/api/instagram/projects/:p/unresolved', ui: 'Unresolved tab', verbs: ['creator-unresolved'] },
  { m: 'POST', path: '/api/instagram/projects/:p/unresolved/:k', ui: 'decide an unresolved item', verbs: ['creator-resolve'] },
  { m: 'GET', path: '/api/instagram/projects/:p/tree', ui: 'Files tab', verbs: [], note: 'browsing' },
  { m: 'GET', path: '/api/instagram/projects/:p/files', ui: 'open a file', verbs: [], note: 'browsing' },
  { m: 'GET', path: '/api/instagram/projects/:p/media/:v', ui: 'video player', verbs: [], note: 'streaming' },
  { m: 'GET', path: '/api/instagram/projects/:p/media-retention', ui: '', verbs: [] },
  { m: 'POST', path: '/api/instagram/projects/:p/media-retention', ui: '', verbs: [], note: 'pins; no button' },
  { m: 'POST', path: '/api/instagram/projects/:p/delete', ui: 'Delete entire folder (typed name)', verbs: ['creator-delete'], note: "only on Brandon's words" },
  { m: 'GET', path: '/api/instagram/projects/:p/guidance', ui: 'Guidance tab', verbs: ['creator'] },
  { m: 'POST', path: '/api/instagram/projects/:p/guidance', ui: '', verbs: [], note: 'no button' },
  { m: 'GET', path: '/api/instagram/projects/:p/guidance/:g', ui: 'a guidance brief', verbs: ['creator'] },
  { m: 'POST', path: '/api/instagram/projects/:p/guidance/:g/approve', ui: '', verbs: [], note: 'no button' },
  { m: 'POST', path: '/api/instagram/projects/:p/ask', ui: '', verbs: ['creator-search'] },
  // ---- Settings: diagnostics, credentials, Cline, usage, intelligence ----
  { m: 'GET', path: '/api/diagnostics', ui: 'Settings → System diagnostics', verbs: ['diagnostics'] },
  { m: 'POST', path: '/api/diagnostics/base-health', ui: 'base-branch card → Check now', verbs: ['base-health'] },
  { m: 'GET', path: '/api/credentials', ui: 'Settings → credentials (configured / not)', verbs: ['credentials'] },
  { m: 'POST', path: '/api/credentials', ui: 'Settings → Save credentials', verbs: ['secret-set', 'secret-clear'], note: 'takes a value from Brandon; answers configured / not only' },
  { m: 'POST', path: '/api/credentials/cline', ui: 'Cline → Authenticate (provider key)', verbs: ['cline-setup'] },
  { m: 'POST', path: '/api/credentials/cline-signin', ui: 'Cline → Sign in', verbs: ['cline-signin'] },
  { m: 'POST', path: '/api/credentials/cline-test', ui: 'Cline → Test connection', verbs: ['cline-test'] },
  { m: 'POST', path: '/api/agents/setup', ui: '', verbs: ['fix-agents'], note: 'NEW: npm run agent:setup (reinstall + re-sign Cline) without Terminal' },
  { m: 'GET', path: '/api/ai-usage', ui: 'Settings → AI usage', verbs: ['ai-usage'] },
  { m: 'GET', path: '/api/intelligence', ui: 'Intelligence runtime', verbs: ['workflows'] },
  { m: 'GET', path: '/api/intelligence/workflows', ui: 'workflow list', verbs: ['workflows'] },
  { m: 'POST', path: '/api/intelligence/workflows/:id/cancel', ui: 'workflow → Cancel', verbs: ['workflow-cancel'] },
  { m: 'POST', path: '/api/intelligence/workflows/:id/approve', ui: '', verbs: [], note: 'no button; a workflow gate is approved by Brandon in the workflow tooling' },
  // ---- In-app updates ----
  { m: 'GET', path: '/api/update/status', ui: 'update badge / card', verbs: ['update-status'] },
  { m: 'POST', path: '/api/update/check', ui: 'Check for updates', verbs: ['update-check'] },
  { m: 'POST', path: '/api/update/apply', ui: 'Update & restart (full test gate first)', verbs: ['update'] },
  // ---- The Brain tab ----
  { m: 'GET', path: '/api/brain/status', ui: 'Brain overview', verbs: ['brain-status'] },
  { m: 'GET', path: '/api/brain/graph', ui: 'Graph', verbs: [], note: 'the drawn graph (megabytes); recall / ask / the brain MCP answer questions' },
  { m: 'GET', path: '/api/brain/activity', ui: 'Activity', verbs: ['brain-activity'] },
  { m: 'GET', path: '/api/brain/overnight', ui: 'Overnight', verbs: ['brain-overnight'] },
  { m: 'GET', path: '/api/brain/health', ui: 'Health', verbs: ['brain-health'] },
  { m: 'GET', path: '/api/brain/sources', ui: 'Where the brain lives', verbs: ['brain-sources'] },
  { m: 'POST', path: '/api/brain/sources', ui: 'set the vault folder', verbs: ['brain-sources'] },
  { m: 'POST', path: '/api/brain/refresh', ui: 'Refresh now (pull the cloud brain)', verbs: ['brain-refresh'] },
  { m: 'GET', path: '/api/brain/access', ui: 'Access list', verbs: ['brain-access'] },
  { m: 'POST', path: '/api/brain/access/renew', ui: 'Renew', verbs: ['brain-renew'] },
  { m: 'POST', path: '/api/brain/access/revoke', ui: 'Revoke', verbs: ['brain-revoke'] },
  { m: 'POST', path: '/api/brain/access/issue', ui: 'Issue a credential', verbs: [], allow: 'the answer carries a brand-new secret (shown once) — credential values never pass through the chat' },
  { m: 'POST', path: '/api/brain/access/rotate', ui: 'Rotate', verbs: [], allow: 'the answer carries a replacement secret — credential values never pass through the chat' },
  { m: 'POST', path: '/api/brain/access/copy-once', ui: 'Copy (once)', verbs: [], allow: 'puts a secret on the clipboard — credential values never pass through the chat' },
];

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isWrite = (m) => WRITE.has(m);

// Does a UI call pattern (literal segments + ':p' wildcards) name this route?
export function matches(route, method, pattern) {
  if (route.m !== method) return false;
  const a = route.path.split('/'); const b = pattern.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => b[i] === ':p' || seg.startsWith(':') || seg === b[i]);
}

// ---- reading the UI's write calls out of its source ----------------------------------------------
// The UI's helpers: fetch(u, {method:'POST'}) · req('POST'|'PUT', u, …) · postJSON(u, …) · igPost(u, …) ·
// the aggregation client's api('/x', { method: 'POST'|'PUT' }) (relative to /api/aggregation).
// An argument like '/api/tickets/' + encodeURIComponent(t.id) + '/' + verb becomes /api/tickets/:p/:p.
const ALIASES = { 'igP()': '/api/instagram/projects/:p', base: '/api/prs/:p/:p/:p' };

function argAt(src, i) { // the first call argument starting at i (depth-aware), and where it ended
  let depth = 0; let q = null; let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return { text: src.slice(i, j).trim(), end: j };
}
export function pathPattern(expr) {
  const parts = []; let depth = 0; let q = null; let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) { cur += c; if (c === '\\') { cur += expr[++i]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (c === '+' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  let out = '';
  for (const p of parts) {
    if (/^(['"]).*\1$/s.test(p)) out += p.slice(1, -1);
    else if (ALIASES[p]) out += ALIASES[p];
    else out += ':p';
  }
  out = out.split('?')[0];
  // a variable glued to the end of a literal segment (…/' + id) is a whole segment
  return out.replace(/:p(:p)+/g, ':p').replace(/\/$/, '');
}
export function uiWriteCalls(files) { // files: { name: source }
  const calls = [];
  const push = (file, method, expr) => {
    const pattern = pathPattern(expr);
    if (pattern.startsWith('/api/')) calls.push({ file, method, pattern, expr: expr.slice(0, 120) });
    else calls.push({ file, method, pattern: null, expr: expr.slice(0, 120) }); // unresolved: the test reports it
  };
  for (const [file, src] of Object.entries(files)) {
    const agg = /aggregation/.test(file);
    let m;
    const re = /\b(fetch|req|postJSON|igPost|api)\(/g;
    while ((m = re.exec(src))) {
      const fn = m[1]; const start = m.index + m[0].length;
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue; // a helper's definition
      if (fn === 'req') {
        const meth = argAt(src, start);
        const mm = /^'(GET|POST|PUT|PATCH|DELETE)'$/.exec(meth.text); if (!mm || mm[1] === 'GET') continue;
        push(file, mm[1], argAt(src, meth.end + 1).text); continue;
      }
      const a = argAt(src, start);
      if (fn === 'postJSON' || fn === 'igPost') { if (a.text !== 'u') push(file, 'POST', a.text); continue; }
      const opts = src.slice(a.end, a.end + 120);
      const om = /^\s*,\s*\{\s*method\s*:\s*'(POST|PUT|PATCH|DELETE)'/.exec(opts);
      if (!om) continue;
      if (fn === 'fetch' && a.text !== 'u') push(file, om[1], a.text);
      if (fn === 'api' && agg) push(file, om[1], `'/api/aggregation' + ${a.text}`);
    }
  }
  return calls;
}

/** docs/ACT_PARITY.md, generated from ROUTES (scripts/act-parity-doc.mjs writes it; the test compares). */
export function parityDoc() {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const rows = ROUTES.map((r) => `| \`${r.m}\` | \`${esc(r.path)}\` | ${esc(r.ui || '—')} | ${r.verbs.length ? r.verbs.map((v) => `\`${v}\``).join(', ') : r.allow ? '🔒 UI only' : '—'} | ${esc(r.allow || r.note || '')} |`);
  const writes = ROUTES.filter((r) => isWrite(r.m));
  const uiWrites = writes.filter((r) => r.ui);
  const allowed = ROUTES.filter((r) => r.allow);
  return `# Chat ↔ button parity

Anything Brandon can do with a button in Seen Command, the Board Room chat can do with one
\`node scripts/act.mjs <verb>\` — the same route, the same body. This table is generated from
\`lib/act-parity.mjs\` (\`node scripts/act-parity-doc.mjs\`); \`scripts/act-parity.test.mjs\` fails when a UI
write call has no route here, a UI write route has no verb, a verb does not exist, or this file is stale.

**${ROUTES.length} routes** · ${writes.length} writes (${uiWrites.length} behind a button) · ${allowed.length} kept UI-only, each for the reason in its row.

UI-only (never chat-callable): ${allowed.map((r) => `\`${r.m} ${r.path}\``).join(', ')}.
Owner rules that ride on top of the verbs: \`approve\` / \`deny\` only when Brandon says so; merging only through
\`merge-pr\` with his exact confirm phrase; \`purge-archived\` / \`creator-delete\` only on his words; no verb
returns a credential value.

| Method | Route | What the button does | Act verb | Note |
|---|---|---|---|---|
${rows.join('\n')}
`;
}
