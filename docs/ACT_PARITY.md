# Chat ↔ button parity

Anything Brandon can do with a button in Seen Command, the Board Room chat can do with one
`node scripts/act.mjs <verb>` — the same route, the same body. This table is generated from
`lib/act-parity.mjs` (`node scripts/act-parity-doc.mjs`); `scripts/act-parity.test.mjs` fails when a UI
write call has no route here, a UI write route has no verb, a verb does not exist, or this file is stale.

**186 routes** · 87 writes (72 behind a button) · 6 kept UI-only, each for the reason in its row.

UI-only (never chat-callable): `POST /api/chat`, `POST /api/chat/stream`, `POST /api/growth/library`, `POST /api/brain/access/issue`, `POST /api/brain/access/rotate`, `POST /api/brain/access/copy-once`.
Owner rules that ride on top of the verbs: `approve` / `deny` only when Brandon says so; merging only through
`merge-pr` with his exact confirm phrase; `purge-archived` / `creator-delete` only on his words; no verb
returns a credential value.

| Method | Route | What the button does | Act verb | Note |
|---|---|---|---|---|
| `GET` | `/api/home` | Home tab (and its Refresh) | `home` |  |
| `GET` | `/api/notifications` | Notifications tab + unread badge | `notifications` |  |
| `POST` | `/api/notifications/read` | Mark all read / open one | `notifications-read` |  |
| `POST` | `/api/notifications/clear` | Clear notifications | `notifications-clear` |  |
| `GET` | `/api/state` | dashboard reload (the whole board state) | `brief` |  |
| `GET` | `/api/signals` | — | — | board-meeting input; the chat reads live connectors with ops.mjs state |
| `POST` | `/api/board-meeting` | Run a board meeting | `meeting` |  |
| `POST` | `/api/approve` | Approve / Deny on an approval card | `approve`, `deny` |  |
| `POST` | `/api/chat` | Board Room send (non-streaming) + the Creator Library question box | 🔒 UI only | it IS the chat — the chat calling itself would recurse |
| `POST` | `/api/chat/stream` | Board Room send | 🔒 UI only | it IS the chat — the chat calling itself would recurse |
| `GET` | `/api/chat-history` | Board Room history | — | the chat already has its conversation |
| `POST` | `/api/simulate` | Simulate (Home approval card, Money) | `simulate` |  |
| `GET` | `/api/simulate` | — | `simulations` |  |
| `GET` | `/api/simulate/:id` | — | `simulation` |  |
| `GET` | `/api/assistant/brief` | — | `brief` |  |
| `GET` | `/api/assistant/recall` | — | `recall` |  |
| `POST` | `/api/assistant/note` | — | `note`, `fact` |  |
| `GET` | `/api/assistant/skills` | — | `skills` |  |
| `POST` | `/api/terminal/claude` | Home → Open Claude Code | `terminal` |  |
| `POST` | `/api/ask` | Knowledge Vault → Ask | `ask` |  |
| `GET` | `/api/vault` | Knowledge Vault tab | `vault` |  |
| `GET` | `/api/brain-review` | — | `vault` |  |
| `POST` | `/api/brain/record` | — | `note`, `fact` | local integrations; the chat writes through /api/assistant/note |
| `GET` | `/api/tasks` | Tasks tab | `tasks` |  |
| `POST` | `/api/tasks/build` | Tasks → ▶ Build | `task-build` |  |
| `POST` | `/api/tasks/delete` | Tasks → Delete | `task-delete` |  |
| `POST` | `/api/tasks/new` | — | `build` | NEW: file a task + start the builder (was only the chat's "build … in Seen Command" command) |
| `GET` | `/api/builds` | build progress (polled while a build runs) | `builds`, `build-status` |  |
| `GET` | `/api/tickets` | Tickets tab | `tickets` |  |
| `GET` | `/api/tickets/summary` | Tickets badge | `tickets` |  |
| `POST` | `/api/tickets` | — | `ticket-new` |  |
| `GET` | `/api/tickets/:id` | ticket drawer | `ticket` |  |
| `POST` | `/api/tickets/:id/fix` | Fix it (builder or ready-for-AI) | `ticket-fix` |  |
| `POST` | `/api/tickets/:id/wont-fix` | Won't fix | `ticket-wontfix` |  |
| `POST` | `/api/tickets/:id/duplicate` | Duplicate of… | `ticket-dup` |  |
| `POST` | `/api/tickets/:id/note` | Add a note | `ticket-note` |  |
| `POST` | `/api/tickets/:id/open` | Reopen / Release claim | `ticket-reopen` |  |
| `GET` | `/api/prs` | open PRs list | `prs` |  |
| `GET` | `/api/prs/:owner/:repo/:n` | PR panel: checks + mergeability | `merge-pr` |  |
| `POST` | `/api/prs/:owner/:repo/:n/merge` | Merge | `merge-pr` | only with Brandon's exact confirm phrase |
| `POST` | `/api/search` | Search box Start / a preset button | `search`, `search-run`, `preset` |  |
| `GET` | `/api/search` | search history | `searches` |  |
| `GET` | `/api/search/presets` | preset buttons | `presets` |  |
| `GET` | `/api/search/plan` | live plan preview under the box | `search-plan` |  |
| `GET` | `/api/search/:id` | — | `search-status` |  |
| `GET` | `/api/jobs` | Jobs tab list / Home recent jobs | `jobs` |  |
| `GET` | `/api/jobs/:id` | job drawer | `job` |  |
| `POST` | `/api/jobs/:id` | job drawer → Save | `job-edit` |  |
| `POST` | `/api/jobs/:id/remove` | Take off the site | `job-remove` |  |
| `POST` | `/api/jobs/:id/restore` | Put back | `job-restore` |  |
| `GET` | `/api/aggregation/status` | pipeline cards | `pipelines` |  |
| `GET` | `/api/aggregation/health` | Health tab / Re-check | `pipeline-health` |  |
| `GET` | `/api/aggregation/collectors` | — | `pipeline-health` |  |
| `GET` | `/api/aggregation/config` | each tool tab's saved setup | `pipeline-config` |  |
| `PUT` | `/api/aggregation/config` | Save setup / Seen repo folder | `pipeline-config` |  |
| `GET` | `/api/aggregation/runs` | History tab | `pipeline-runs` |  |
| `POST` | `/api/aggregation/runs` | Start (a pipeline run) | `pipeline-start` |  |
| `GET` | `/api/aggregation/runs/:id` | run detail | `pipeline-run` |  |
| `POST` | `/api/aggregation/runs/:id/cancel` | Cancel run | `pipeline-cancel` |  |
| `GET` | `/api/aggregation/schedules` | Schedules tab | `pipeline-schedules` |  |
| `PUT` | `/api/aggregation/schedules/:pipeline` | Save schedule | `pipeline-schedule` |  |
| `POST` | `/api/aggregation/schedules/tick` | — | — | the scheduler's own tick (runs due schedules); no button |
| `GET` | `/api/aggregation/company-intel/catalog` | company picker | `pipeline-health` | the picker's list; pipeline-start takes the names |
| `GET` | `/api/aggregation/indeed/presets` | Indeed maintenance presets | `presets` |  |
| `GET` | `/api/aggregation/boards` | employer-board status | `pipelines` |  |
| `POST` | `/api/aggregation/boards/pull` | Pull employer boards | `boards-pull` |  |
| `GET` | `/api/aggregation/company-jobs` | company-jobs status | `pipelines` |  |
| `POST` | `/api/aggregation/company-jobs` | Company jobs → Pull | `company-jobs` |  |
| `POST` | `/api/aggregation/company-intel/targets` | — | `pipeline-start` | a preview of the targets a run would pick |
| `GET` | `/api/data-health` | Data health panel (+ Re-scan) | `data-health` |  |
| `GET` | `/api/data-health/run` | cleanup progress | `clean` |  |
| `GET` | `/api/data-health/history` | past cleanups | `data-health-history` |  |
| `POST` | `/api/data-health/clean` | Clean (each kind / all) | `clean` |  |
| `POST` | `/api/data-health/settings` | daily automatic cleanup switch | `data-health-auto` |  |
| `POST` | `/api/data-health/review` | look-alike group → Fine as is | `lookalike-ok` |  |
| `GET` | `/api/money` | Money tab | `money` |  |
| `GET` | `/api/money/scale` | Scale section | `scale` |  |
| `GET` | `/api/money/allocate` | Allocation section | `allocate` |  |
| `GET` | `/api/money/units` | Unit economics | `units` |  |
| `GET` | `/api/money/costs` | Costs section | `costs` |  |
| `GET` | `/api/money/simulation-inputs` | — | — | what simulations read for numbers; used inside simulate |
| `POST` | `/api/money/costs` | cost Save / Add / remove | `cost-set`, `cost-remove` |  |
| `POST` | `/api/money/cash` | cash on hand Save | `cash` |  |
| `POST` | `/api/money/allocate` | allocation Save / Reset | `allocate-set`, `allocate-reset` |  |
| `POST` | `/api/money/channels` | channel Save | `channel-set` |  |
| `POST` | `/api/money/readiness` | readiness checkbox | `readiness` |  |
| `POST` | `/api/money/plan` | Supabase plan buttons | `money-plan` |  |
| `POST` | `/api/money/scenario` | scenario levers → Project | `scenario` |  |
| `GET` | `/api/growth/overview` | Growth tab | `growth` |  |
| `GET` | `/api/growth/daily` | today's 1% item | `daily` |  |
| `POST` | `/api/growth/daily` | Done / Skip | `daily` |  |
| `GET` | `/api/growth/plan` | Plan view | `growth-plan` |  |
| `POST` | `/api/growth/plan` | Re-plan | `growth-replan` |  |
| `GET` | `/api/growth/calendar` | Calendar view | `calendar` |  |
| `POST` | `/api/growth/calendar/generate` | Generate calendar | `calendar` |  |
| `POST` | `/api/growth/calendar/:id/status` | item → next status / reset | `calendar-status` |  |
| `POST` | `/api/growth/calendar/:id/results` | item → Save results | `calendar-results` |  |
| `GET` | `/api/growth/copy/:id` | calendar item drawer | `calendar-item` |  |
| `POST` | `/api/growth/copy/:id/draft` | Draft copy | `draft`, `ad` |  |
| `POST` | `/api/growth/copy/:id/approve` | Approve a variant | `approve-copy` |  |
| `GET` | `/api/growth/brand` | Brand kit | `brand` |  |
| `POST` | `/api/growth/brand` | Brand kit → Save | `brand-set` |  |
| `GET` | `/api/growth/positioning` | Positioning | `positioning` |  |
| `GET` | `/api/growth/rules` | — | `positioning` | the trust rules; draft applies them |
| `GET` | `/api/growth/assets` | Creators view: assets + angles | `growth-assets` |  |
| `GET` | `/api/growth/data` | designer data | `growth-data` |  |
| `GET` | `/api/growth/ads` | Paid view | `ad` |  |
| `GET` | `/api/growth/templates` | Ad designer templates | `ad` |  |
| `GET` | `/api/growth/templates/:id` | one template spec | `ad` |  |
| `GET` | `/api/growth/library` | saved ad images | `growth-library` |  |
| `POST` | `/api/growth/library` | Ad designer → Save to library | 🔒 UI only | uploads the PNG the browser just rendered — the chat has no rendered image to send |
| `GET` | `/api/growth/library/:file` | an image | — | static file |
| `GET` | `/api/growth/fonts/:file` | designer fonts | — | static file |
| `GET` | `/api/growth/meeting` | — | `growth` | the board meeting's growth block |
| `GET` | `/api/instagram/doctor` | toolchain check | `creator-doctor` |  |
| `GET` | `/api/instagram/library` | Creator Library list | `creators` |  |
| `GET` | `/api/instagram/creators` | — | `creators` |  |
| `GET` | `/api/instagram/creators/:user` | creator overview | `creator` |  |
| `GET` | `/api/instagram/insights` | ✦ Insights | `creator-insights` |  |
| `GET` | `/api/instagram/prune` | Prune plan | `prune` |  |
| `POST` | `/api/instagram/prune` | Prune | `prune` |  |
| `POST` | `/api/instagram/prune/restore` | Restore (one / all) | `restore-creators` |  |
| `POST` | `/api/instagram/purge-archived` | Purge archived (typed phrase) | `purge-archived` | only on Brandon's words |
| `GET` | `/api/instagram/discover` | discoveries | `discovery` |  |
| `POST` | `/api/instagram/discover` | Discover | `discover` |  |
| `GET` | `/api/instagram/discover/:id` | a discovery | `discovery` |  |
| `POST` | `/api/instagram/discover/:id/queue` | Research the chosen | `queue-research` |  |
| `POST` | `/api/instagram/research` | — | `research` |  |
| `GET` | `/api/instagram/queue` | — | `creator-status` |  |
| `GET` | `/api/instagram/jobs` | research jobs | `creator-status` |  |
| `POST` | `/api/instagram/jobs` | — | `research` | raw job start; research is the queued, safe path |
| `GET` | `/api/instagram/jobs/:id` | a job | `creator-status` |  |
| `POST` | `/api/instagram/jobs/:id/cancel` | — | — | no button; a stuck job is resumed or cleaned |
| `POST` | `/api/instagram/jobs/:id/resume` | Resume research job | `creator-resume` |  |
| `POST` | `/api/instagram/jobs/:id/cleanup-preview` | Clean raw media (preview) | `creator-cleanup` |  |
| `POST` | `/api/instagram/jobs/:id/cleanup-confirm` | Yes — delete raw media | `creator-cleanup` |  |
| `GET` | `/api/instagram/projects/:p` | creator header | `creator` |  |
| `GET` | `/api/instagram/projects/:p/videos` | Videos tab | — | browsing; creator / creator-search answer questions about them |
| `GET` | `/api/instagram/projects/:p/videos/:v` | a video | — | browsing |
| `GET` | `/api/instagram/projects/:p/knowledge` | Knowledge tab | `creator` |  |
| `GET` | `/api/instagram/projects/:p/knowledge/:k` | — | `creator` |  |
| `GET` | `/api/instagram/projects/:p/evidence/:e` | — | `creator-search` |  |
| `POST` | `/api/instagram/projects/:p/search` | creator search box | `creator-search` |  |
| `GET` | `/api/instagram/projects/:p/unresolved` | Unresolved tab | `creator-unresolved` |  |
| `POST` | `/api/instagram/projects/:p/unresolved/:k` | decide an unresolved item | `creator-resolve` |  |
| `GET` | `/api/instagram/projects/:p/tree` | Files tab | — | browsing |
| `GET` | `/api/instagram/projects/:p/files` | open a file | — | browsing |
| `GET` | `/api/instagram/projects/:p/media/:v` | video player | — | streaming |
| `GET` | `/api/instagram/projects/:p/media-retention` | — | — |  |
| `POST` | `/api/instagram/projects/:p/media-retention` | — | — | pins; no button |
| `POST` | `/api/instagram/projects/:p/delete` | Delete entire folder (typed name) | `creator-delete` | only on Brandon's words |
| `GET` | `/api/instagram/projects/:p/guidance` | Guidance tab | `creator` |  |
| `POST` | `/api/instagram/projects/:p/guidance` | — | — | no button |
| `GET` | `/api/instagram/projects/:p/guidance/:g` | a guidance brief | `creator` |  |
| `POST` | `/api/instagram/projects/:p/guidance/:g/approve` | — | — | no button |
| `POST` | `/api/instagram/projects/:p/ask` | — | `creator-search` |  |
| `GET` | `/api/diagnostics` | Settings → System diagnostics | `diagnostics` |  |
| `POST` | `/api/diagnostics/base-health` | base-branch card → Check now | `base-health` |  |
| `GET` | `/api/credentials` | Settings → credentials (configured / not) | `credentials` |  |
| `POST` | `/api/credentials` | Settings → Save credentials | `secret-set`, `secret-clear` | takes a value from Brandon; answers configured / not only |
| `POST` | `/api/credentials/cline` | Cline → Authenticate (provider key) | `cline-setup` |  |
| `POST` | `/api/credentials/cline-signin` | Cline → Sign in | `cline-signin` |  |
| `POST` | `/api/credentials/cline-test` | Cline → Test connection | `cline-test` |  |
| `POST` | `/api/agents/setup` | — | `fix-agents` | NEW: npm run agent:setup (reinstall + re-sign Cline) without Terminal |
| `GET` | `/api/ai-usage` | Settings → AI usage | `ai-usage` |  |
| `GET` | `/api/intelligence` | Intelligence runtime | `workflows` |  |
| `GET` | `/api/intelligence/workflows` | workflow list | `workflows` |  |
| `POST` | `/api/intelligence/workflows/:id/cancel` | workflow → Cancel | `workflow-cancel` |  |
| `POST` | `/api/intelligence/workflows/:id/approve` | — | — | no button; a workflow gate is approved by Brandon in the workflow tooling |
| `GET` | `/api/update/status` | update badge / card | `update-status` |  |
| `POST` | `/api/update/check` | Check for updates | `update-check` |  |
| `POST` | `/api/update/apply` | Update & restart (full test gate first) | `update` |  |
| `GET` | `/api/brain/status` | Brain overview | `brain-status` |  |
| `GET` | `/api/brain/graph` | Graph | — | the drawn graph (megabytes); recall / ask / the brain MCP answer questions |
| `GET` | `/api/brain/activity` | Activity | `brain-activity` |  |
| `GET` | `/api/brain/overnight` | Overnight | `brain-overnight` |  |
| `GET` | `/api/brain/health` | Health | `brain-health` |  |
| `GET` | `/api/brain/sources` | Where the brain lives | `brain-sources` |  |
| `POST` | `/api/brain/sources` | set the vault folder | `brain-sources` |  |
| `POST` | `/api/brain/refresh` | Refresh now (pull the cloud brain) | `brain-refresh` |  |
| `GET` | `/api/brain/access` | Access list | `brain-access` |  |
| `POST` | `/api/brain/access/renew` | Renew | `brain-renew` |  |
| `POST` | `/api/brain/access/revoke` | Revoke | `brain-revoke` |  |
| `POST` | `/api/brain/access/issue` | Issue a credential | 🔒 UI only | the answer carries a brand-new secret (shown once) — credential values never pass through the chat |
| `POST` | `/api/brain/access/rotate` | Rotate | 🔒 UI only | the answer carries a replacement secret — credential values never pass through the chat |
| `POST` | `/api/brain/access/copy-once` | Copy (once) | 🔒 UI only | puts a secret on the clipboard — credential values never pass through the chat |
