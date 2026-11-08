# Seen Command — capabilities and limitations

*Last updated 2026-07-19. This file is grounded in the current repo (`engine/`, `org/`, `lib/`) and is
meant to be honest about what the system can and cannot do today — no marketing. When you change the
machinery, change this file with it.*

## What it is

Seen Command is Brandon's **agentic exec OS** for Seen (seenjobs.io). A CEO/Orchestrator plus a set of
department agents (growth, product/engineering, reliability/cost, revenue, data) hold a live **board
meeting** over the company's real data, produce a morning debrief, and surface the decisions that need
Brandon's **yes/no**. Everything the run learns and decides is written back to one shared brain — the
Chronos vault (a sibling `seen` repo's `memory/`, reached through `lib/brain.mjs` and the `brain` MCP).

Two properties shape everything below:

- **Pure Node, zero runtime npm dependencies.** The tool repo (this checkout) uses only `node:` builtins;
  Electron is a `devDependency` used solely to package the desktop app. The test gate is therefore just
  `node --check` + `node --test` — no install step, fast, and identical in CI and in the builder.
- **Nothing is claimed done that didn't happen.** Agents speak in *proposals*. Approving one either files
  a real tracked GitHub issue, drafts a real deliverable (e.g. the Ghost Report written live from
  `company_scores`), or — for engineering work — kicks the **test-gated builder** to actually write the
  code and open a PR. The ground truth of what the system can do lives in `org/capabilities.mjs`.

Seen Command builds **two repos**, chosen per task:

- **tool** — Seen Command's own repo (this one). Pure-Node gate. Safe fixes *may* auto-merge.
- **product** — the Seen product (`../seen`, a Next.js 15 / React 19 / TypeScript app). Gate is
  `npm test` (plus `tsc --noEmit` when types are touched). **Always PR-only** — merging there deploys
  production, so that click stays human.

Which repo a filed task targets is inferred by `buildTargetForTask` (`engine/policy.mjs`). It reads the
issue's gate line first, then falls back to codebase keywords, defaulting to `tool` (a manual task-build
is always PR-only, so a wrong guess costs at most one draft PR). A **subject-aware override** runs before
the gate line: a task about Seen Command *itself* (its docs, tests, or engine code — signalled by a
tool-repo path like `docs/…`/`engine/…`, or a tool-work word paired with "Seen Command") routes to the
tool repo even when a mislabeled `bugfix`-PR gate line or a `[product]` tag points at product. It is
precision-first: a strong product signal (seenjobs, the site, employers, the jobs data) **vetoes** the
override, so a genuine product task that merely name-drops Seen Command still routes to product. This
override exists because issues #115/#117 ("Update Seen Command documentation" / "Create a test suite for
Seen Command") carried a product gate line, routed to the product repo, and could only ever produce a
stub there — which the reviewer correctly rejected.

## The build pipeline

When an engineering action is approved (or a task's **▶ Build** is clicked), the server spawns
`engine/build-runner.mjs` detached; it drives `engine/builder.mjs` (`runBuild`). The spine:

1. **Screen the task** (`screenBuildTask`) *before* cutting a branch. A **phantom premise** (the task
   names something that doesn't exist) or a **closed tracked issue** is refused up front — a phantom
   forces the coder to fabricate a stub to satisfy the impossible, and a closed task is already done or
   rejected. The issue's state is read with a direct per-issue GET (read-your-writes consistent), and a
   fetch failure fails *open* (an outage never blocks an honest build).
2. **Working-tree check** — only *code* changes block a build; the vault (`memory/`) and runtime dirs
   (`data/`, `public/`) churn every meeting and are ignored (and never touched by the builder).
3. **Baseline gate** — the target branch's suite must already be green, or the build aborts naming what's
   red rather than blaming the new change.
4. **Duplicate-PR refusal** — a task matching an already-open builder PR is refused ("review that PR
   instead"), so two sibling meeting tasks can't build parallel dead implementations of the same feature.
5. **Cut a branch**, generate the change (below), and drive it to a **green gate**.
6. **Reviewer** (`engine/reviewer.mjs`) — a stronger model reviews the diff against the task with
   existence evidence (repo-wide occurrence counts for the identifiers the diff adds). A rejection reverts
   the attempt and re-runs the coder *with the named defects*; **two rejections abort honestly** ("needs a
   human"). The reviewer is fail-open on availability but never silently: an unparseable verdict climbs a
   retry ladder (stricter reprompt → the other lane → only then fail open), and every skip lands a
   `review/skipped` line in the ledger.
7. **Effectiveness check** — a green gate proves the change *breaks* nothing, not that it *does* anything.
   A comment-only diff, or edits that cancel to no net change, are refused ("nothing effective to
   ship — if this wants a document, it belongs to the deliverer").
8. **Commit, push, open the PR** — PRs always open **READY, never draft** (the builder only opens one when
   the gate is green; a draft reads as "work in progress"). The body carries the diffstat and a `Closes
   #N` reference so merging auto-closes the task. Tool-repo safe fixes may `--auto-merge`; product never.
9. **Post-create status + preview verdict.** Right after opening, the runner folds GitHub's own
   mergeability signals into a `pr-status` verdict (`ready` / `conflicting` / `checks_failing`) and, for a
   **product** PR, stamps Vercel's preview verdict (`engine/pr-verify.mjs`): READY → "Deployable, eyeball
   the preview"; ERROR → "DO NOT MERGE" *and the builder closes its own proven-broken PR*. Any non-ready
   result is written to the activity ledger.

### The gate

`toolGate` and `productGate` both, in order: `node --check` every touched `.mjs`/`.js`; reject any source
file whose first line is a markdown code fence (a coder artifact — Seen #194); run the **phantom lint**
(below); for product, `tsc --noEmit` when a `.ts`/`.tsx` is touched (fail-open if no local `tsc`); then
the full suite (`node --test` for tool, `npm test` for product). Only a fully green tree is ever
committed. **There is no deterministic fallback for code** — if no model lane can produce a change that
passes, the builder aborts loudly rather than shipping filler.

### The two coding lanes

Code generation is delegated to one of two lanes, chosen by **task shape** in `generateChange`
(`engine/builder.mjs`). The git/branch/reviewer/gate/PR machinery around them is identical either way.

- **Patch coder** (`engine/coder.mjs`) — **local-first, $0**. It *retrieves* (grep the repo for the task's
  terms, pull only the relevant windows — never whole files) and emits small **SEARCH/REPLACE** blocks
  applied by exact or whitespace-tolerant match, then verifies against the gate and retries with the
  failures fed back. Superb at a **targeted fix that names a concrete anchor**. When the local model
  stalls (off-format twice, can't anchor twice, same red twice), the round escalates to hosted coder
  lanes (groq → cerebras → gemini → frontier); `CODER_ESCALATE=0` forces strict local-only.
- **Advanced agentic coder** (`engine/agentic-coder.mjs`) — **Cline's open-source, model-independent
  coding runtime leads**, for complex feature-scale changes the patch coder cannot do. It supplies
  checkpoints, repository/terminal tools, bounded retries, loop recovery, and agentic context
  compaction. Unattended execution is deliberately single-writer: Cline's `--yolo` mode disables its
  spawn/team tools, avoiding competing edits in one worktree. Seen Command snapshots the tree before
  and after, rejects git movement or off-limits files, then runs its own complete gate and reviewer.

  If Cline is unavailable, the existing dependency-free API loop remains a fallback. That loop follows
  a fixed playbook
  (ground in real schema/auth/precedent → plan the smallest *real* version → implement across as many
  files as it takes → verify against the gate → finish honestly) over a small, fully local tool surface:
  `list_dir`, `read_file`, `grep`, `write_file`, `run_gate`, an **allowlisted** read-only `run_cmd`, and
  `done`. The API models never run a shell — they propose **file contents**, and path safety +
  `assertWritable` (safe paths + PROTECTED intent) + markdown-fence rejection are enforced *at the tool
  layer*. The harness **re-runs the gate itself** to confirm `done`; it never trusts the model's claim.
  Cost is bounded by a hard **token budget (600k) and turn cap (48)** — hitting either throws an honest
  "budget exhausted" — and every run logs one `agentic-coder` line to the ledger.

  The engine chain is provider-agnostic. `AGENTIC_ENGINE` forces one; the default AUTO order is
  **cline → claude-cli → groq → cerebras → gemini → anthropic → ollama**. Cline uses whichever provider
  and model was selected with `cline auth` (optional `CLINE_PROVIDER`/`CLINE_MODEL` overrides). `claude-cli` uses
  the local `claude` binary (a Claude *subscription*, not API credits); groq/cerebras/gemini are free
  hosted tiers; `anthropic` is the last API resort (needs credits); `ollama` is local. A **startup/auth
  failure** (logged out, 401, 400 credit-balance, missing key, connection refused) falls through to the
  next engine with an `engine-fallthrough` ledger line; a mid-task error *after* the first successful turn
  does not switch engines — it throws honestly.

**Routing.** A **feature-shaped** task (no concrete anchor) with an agentic engine available goes to the
agentic lane first; a non-budget error there falls back to the patch coder, while a budget stop is
re-thrown (don't burn the patch coder on a whole feature it already can't do). An **anchored** task (or
when no agentic engine is configured) goes to the patch coder first, with **one agentic rescue** if it
exhausts. `CODER_AGENTIC=0`, or no configured engine at all, means patch-coder-only.

## Guardrails

Each is a permanent, tested answer to a real defect class the builder once shipped:

- **Phantom-reference lint** (`engine/lint.mjs`) — statically checks every *added* line of the touched
  files and reds the gate on code that references things that don't exist: a call to a function defined
  nowhere (#46), a `require()` in an ESM file (#185), a named import of a binding a module doesn't export
  (#78/#79), or a seeded phantom concept. The named error flows back into the coder's retry loop.
  Precision-first (zero false positives — `export *` targets stay quiet). `CODER_LINT=0` disables it.
- **Proposal sanity gate** (`engine/proposal-gate.mjs`) — the same idea one level up, on the *approval
  queue*: it drops proposals with a **phantom premise** (e.g. "integrate the Chronos SDK" — there is no
  Chronos SDK; the real integration is the shared vault + brain MCP), a **resurrection** of a de-noised
  closed task, or an **off-charter** action decoupled from the raising department's gate. Drops are
  logged and demoted to visible-but-inert, never silently swallowed. `PROPOSAL_GATE=0` disables it.
- **Decomposition contract** — an engineering proposal must be **single-PR-sized** and name a concrete
  anchor (a file/route/script — `CONCRETE_ANCHOR`), enforced at agenda normalization. Whole-feature asks
  that ignore this die at coder exhaustion; the contract is what stops them from being filed at all.
- **Refused vs failed** — an honest **refusal** (phantom/closed/duplicate premise, where the fix is an
  owner action, not a retry) is tagged so the UI shows a calm amber "not built — needs your review", not
  a red "build failed". Genuine failures (red gate, coder exhaustion, reviewer double-reject, push/PR
  errors, a proven-broken preview) stay red.
- **Closed/phantom build refusal** — `screenBuildTask` sits at the single choke point every build entrance
  passes through (Tasks-tab build, approve→builder, overnight, CLI), so a closed or phantom task can't
  reach the coder from *any* path.
- **Protected intent** (`PROTECTED_PATHS` in `engine/policy.mjs`) — the builder **cannot write**
  `org/focus.mjs` (the north star), `org/capabilities.mjs` (this ground truth), `engine/policy.mjs` (the
  safety layer), or the package manifests, and self-update never auto-merges a PR that touches them.
  (PR #56 once reworded the north star and self-merged; that class is closed.) The subject-aware routing
  change in this PR is a *deliberate, owner-directed* edit to `policy.mjs` — the sanctioned lane, distinct
  from the autonomous paths the protection blocks.

## The activity ledger — "review seen command updates"

Every board meeting, approval, denial, build outcome, delivery, self-update, deployability verdict,
`pr-status`, and reviewer skip appends **one JSON line** to `<repo>/data/activity/YYYY-MM-DD.jsonl`
(`lib/activity.mjs`). It is anchored on the **repo checkout** (via `config.commandRepoDir()`), not the
app's private support dir, so the packaged `.app` and a plain CLI run write the **same** file — the one
place a Claude session can actually read. Writes are defensive: a ledger failure never breaks a meeting
or a build.

When Brandon says **"review seen command updates"**, that is the trigger to read this ledger — either the
raw day-files or the digest: `node scripts/activity.mjs [days]` (add `--json` for machine-readable
output). It replaces waiting on a pasted screenshot to learn what the app did or why something failed.

## Creator Intelligence (Instagram compiler)

Seen Command can research a **public** Instagram creator and turn their videos into a durable,
evidence-backed knowledge library — then use that (with a human gate) to inform SeenJobs. It wraps a
vendored Python worker (`tools/video-software-compiler/`) behind a dependency-free Node layer
(`lib/instagram/`). Every claim traces back to a specific video and timestamp; nothing is asserted
without evidence.

**Four chat commands** (deterministic, matched before the LLM lane in `POST /api/chat`):

- `research instagram <username> [latest N | all videos]` — starts a **durable, resumable** research
  job (`lib/instagram/jobs.mjs`). Pipeline: ingest → transcribe → OCR/frames → evidence → **validated**
  knowledge → reconcile → coverage audit → cleanup preview. It is **not** "complete" until knowledge is
  imported/validated and coverage is audited; incomplete coverage lands as `needs_review`, never a green
  lie. One job per creator (dedup — never downloads twice); global concurrency is capped.
- `resume instagram <username>` — resumes a failed job. If collection and evidence already finished,
  it restarts at Claude knowledge extraction and does **not** contact Instagram or download videos again.
- `ask instagram <username>: <question>` — bounded, **attributed** retrieval over that creator's
  validated knowledge, with citations (video + timestamp + excerpt) and an explicit caveat that this is
  *research, not verified product truth*.
- `use <username> guidance to <objective>` — drafts a SeenJobs **guidance brief** from the creator's
  knowledge, labeled `source_derived`, carrying the full provenance chain (knowledge + evidence ids).
  It is created as a **DRAFT**; it is owner-approved only and **never auto-builds or ships** anything.

**Anonymous-first, no login required.** Public profiles ingest with `INSTAGRAM_SESSION_USER` unset. A
session is *optional* and only used if Instagram rejects/rate-limits anonymous access — in which case
the job stops honestly at `needs_login` rather than pretending it ran. Any login happens interactively
in Terminal, outside Seen Command; a password is never placed in `.env`, an API request, job state,
logs, or a command-line argument, and the doctor is never marked failed merely because no session exists.

**Cross-creator insights → board meetings + chat** (`lib/instagram/insights.mjs`, deterministic, no
model). Every researched creator's videos, curated evidence and canonical knowledge become ONE typed,
ranked, de-duplicated list: `hook` (what is said/shown in the first 3s), `format`, `topic`,
`audience_pain`, `cadence` (posts/week in the researched window), `tactic` (explicit CTAs) — all
*observed* (counted in the videos) — plus *taught* creator advice merged across videos and creators.
Strength comes only from independent support: **strong** ≥3 creators & ≥6 posts, **moderate** ≥2 creators
& ≥3 posts, **emerging** = one creator or very few posts, else **anecdotal**; the extractor's
self-rated confidence never raises it. Carousel children count once; contradicted/deprecated knowledge,
Seen's own `independent_improvement` records and creators' promotional result `claim`s are excluded;
engagement lift is per-creator-median, needs enough posts on both sides, and is labelled correlation.
Every line carries citations (creator, post link, `m:ss` timestamp, excerpt) and a California date.
- **Board meeting** (`engine/run.mjs`): growth, strategy, revenue and product each get a ≤1.5k-char
  `CREATOR EVIDENCE` block of the moderate+ lines for the types they use (none → no block). A proposal
  that quotes a "N creators / M videos" it was never shown is labelled unverified on the proposal itself.
  What each department received is saved as `state.creatorEvidence`.
- **Board Room chat**: `creatorContext(message)` adds a compact cited block to the live context for
  content/creator/audience questions only (`engine/server.mjs`, one line); the owned `creators` skill
  answers "what hooks work for job-seeker content?" directly from the library and declines when it has
  nothing. `GET /api/instagram/insights[?project=]` serves the list + what the last meeting used.

**Creator Intelligence Library** (dashboard "◎ Creator Library" tab + `/api/instagram/*`): read-only
over the worker's SQLite + artifacts. The tab opens on the ranked **cross-creator insights** (type and
strength filters, "in last meeting" markers), then **⌕ Find creators** (discovery) and **✂ Keep it lean**
(prune). Each account shows its **KEEP / PRUNE verdict with the reason**, open vs resolved "unresolved"
knowledge, and — when it has evidence but 0 knowledge — why, from its research job. Each creator opens
into **Overview · ★ Key Points · Videos · Knowledge · Unresolved · Guidance · Files**. Key Points come
from the deterministic insight engine (the old model-written digest cached an empty answer forever);
each point carries this creator's own video + timestamp and which other creators back it.

**Relevance gate + prune** (`lib/instagram/relevance.mjs`, `prune.mjs`): a knowledge row is kept only for a
specific SeenJobs signal (job search / hiring, content craft, audience growth, brand trust, monetization,
product); editing-software trivia, motivation, other niches and generic business wording are dropped from
every view, meeting and chat — with the reason. An account is KEEP when ≥30% of its knowledge serves Seen
or ≥25% of its videos touch job search. Prune ARCHIVES (`data/instagram-archive.json`, reversible with
restore); purge deletes archived writable folders only with the typed phrase `PURGE ARCHIVED`.
**Unresolved** = records the extractor marked `ambiguous`; the compiler never revisits them, so Seen Command
resolves them (corroborated by another record or stated in ≥2 videos → probable; or the owner decides,
`data/instagram-resolutions/`). **Discovery** (`lib/instagram/discovery.mjs`): Google result pages in the
owner's Chrome via OpenCLI (never instagram.com, never a login or a message; CAPTCHA → stop) plus the
creators the researched ones mention; two ranked lists (learn from / audience fit) with reasons and the
matching seenjobs.io page; chosen handles go through the research queue (`data/instagram-queue.json`,
2 jobs at a time). Board Room verbs: `creators`, `creator <user>`, `research <user> [count]`,
`discover <goal>`, `discovery <id>`, `queue-research`, `creator-insights`, `prune [plan]`,
`restore-creators`, `purge-archived`, `creator-status` (skill `skills/creator-research.md`). Open-source
choices and licences: `docs/creator-research-sources.md`. Videos is a **thumbnailed gallery**
(frame previews); clicking a card opens a modal **video player** showing that video's *Insights*
(evidence + seek timestamps) and *Intel* (knowledge pulled from it) with transcript/source links.
Files is a safe directory browser rooted strictly inside the project. Read-only creator data lives
**outside** the repo; roots are resolved from `VSC_DATA_ROOT`, a registry file
(`data/instagram-readonly-roots.json`), and `VSC_READONLY_ROOTS`. Every `/files`, `/tree`, and
`/media` request passes a single choke point that realpath-resolves inside the project, rejects
`..`/absolute paths and symlink escapes, denies dotfiles / `.env` / `.sqlite`, and serves only an
allow-listed MIME set. New ingestion stores **project-relative** `local_path`, and an absolute path is
served only when it realpath-resolves inside the project (legacy datasets) — so playback works while
foreign paths stay rejected.

**The knowledge pipeline is real and completion is truthful.** Deterministic bounded evidence bundles
are built from the project's own `state.sqlite` (exact video/evidence IDs, source URLs, timestamps,
transcript, canonical knowledge for dedup — `lib/instagram/bundles.mjs`), extracted by the local Claude
CLI, and validated per batch by the worker's `import-knowledge`. A job reaches **complete** only when
the in-scope video set exactly equals the set covered by *validated imported* knowledge (dedup; no
unrelated IDs), reconciliation reports no blocking conflicts, a real final Claude audit actually wrote
+ validated `reports/claude-final-audit.json`, and status + cleanup-preview succeeded — otherwise
`needs_review`, never a green lie. Every external boundary (doctor / compiler / Claude / audit) is
injectable, so the whole pipeline is tested hermetically (no ffmpeg/Claude/Instagram/network) with a
full negative matrix plus a no-preseed fake-executable end-to-end.

**Storage controls** (Overview tab): preview raw-media cleanup (file count + GB, what's deleted vs
kept, pin-aware confirm) and **delete an entire researched folder** with a typed-name confirmation.
Read-only/registered datasets (e.g. a fixture library) are refused — they can never be deleted from the
app. The full-archive research path (`all videos`) requires an explicit `confirm` after a size warning;
the default is the newest 50.

**Runtime + packaging.** The Library reads SQLite via `node:sqlite`, which needs Node ≥22.5; the app
therefore ships **Electron 35** (embedded Node 22.16) and enables `--experimental-sqlite` in the
`ELECTRON_RUN_AS_NODE` server child. The Python worker is packaged as electron-builder `extraResources`
(→ `<app>/Contents/Resources/video-software-compiler`) and `config.vscToolDir` resolves that path in the
packaged app; the doctor verifies the actual packaged payload and reports a required `node:sqlite`
check. Two real smokes gate this: `npm run smoke:electron` (server + Library reads under the packaged
Electron binary) and `npm run app:package && npm run smoke:packaged` (worker present in the bundle).
Dependencies are never installed silently — `npm run vsc:setup` sets up the worker venv explicitly.

**Safety properties, enforced and tested** (`lib/instagram/*.test.mjs`): the worker is spawned with an
argv array only — never a shell; the `research` parser rejects stray text so
`research instagram bad name!` can **never** silently truncate to `@bad` and download it; media
**cleanup** is preview → confirm-only, gated by a job-bound plan-hash token (which folds in pin state),
and blocked entirely while any retention pin exists; deletion removes only raw video/audio — evidence,
knowledge, frames, transcripts, and reports are always preserved; a persisted job PID that this process
does not own is never signalled (cancel/restart safety); an approved guidance brief files a **real**
proposed task (GitHub issue) but never starts a build.

## Current limitations (honest)

- **The patch coder exhausts on feature-scale work.** Proven: it died at 8-round exhaustion or shipped
  stubs on all four whole-feature employer tasks (#93–#96). It is a *fix* tool, not a *feature* tool.
- **The agentic lane is the answer to that — but it is not yet proven live end-to-end.** The acceptance
  test (task #110) ran and the lane behaved correctly, but hit HTTP 400 "credit balance too low" on the
  Anthropic key and fell back to the patch coder honestly. The **$0 engine chain** (claude-cli / free
  groq/cerebras/gemini tiers) is built specifically to remove the credit dependency, but it still needs
  Brandon to enable an engine — run `claude` once in Terminal and `/login`, or supply a free hosted key —
  and it has not yet completed a real feature-scale build in production. Until it does, treat the agentic
  lane as *available and correct in tests, unproven in the wild*.
- **Product features generally still need a Claude implementation agent** (or a proven agentic build). The
  four employer PRs that landed green (Seen #196–#199) were built by Claude implementation agents, not by
  the local patch coder; the pipeline shipped and reviewed them, but did not author them.
- **The reviewer can false-reject.** It is deliberately strict — a false reject costs an honest "needs a
  human", a false accept costs production — so occasionally a good change is turned back. It also
  **fails closed**: no reviewer lane, an unusable reply, or a diff too large to read in full means the
  change is *blocked* (an owner-action status, not a coder retry), never shipped. `CODER_REVIEW=0` turns
  the reviewer off for plumbing dry runs only — an unreviewed change is never pushed.
- **Task→repo routing is heuristic.** `buildTargetForTask` is keyword- and path-based. The subject-aware
  override is precision-first: it may *miss* a tool task that leans heavily on product vocabulary (costing
  one draft PR against the wrong repo), but by design it will not misroute a genuine product task to the
  tool repo.
- **Brain writes are safe no-ops when the vault isn't found.** From a session worktree (or any checkout
  without the sibling `seen` repo at `../seen/memory`), brain-MCP reads return empty and writes do
  nothing — by design, not silently corrupting anything. Point `CHRONOS_VAULT` at the `seen` repo to
  reconnect.
- **Instagram knowledge extraction needs the local Claude CLI, and is only as good as public content.**
  Extraction runs the local `claude` CLI in batches (no hosted key required); if it isn't logged in, a
  research job stops honestly rather than fabricating knowledge. Completeness is never claimed — each
  project carries "Completeness could not be independently verified." Anonymous ingestion is subject to
  Instagram's rate limits; a live rejection ends at `needs_login`, not a partial pretend-complete run.
  Claude receives captions, timestamped faster-whisper speech, and Tesseract OCR—not the continuous video.
  That is strong for narrated advice and on-screen text, but chart meaning, gestures, and silent visual
  demonstrations still need a future representative-frame vision pass or human review. Claude is also the
  throughput bottleneck: exhaustive structured extraction is intentionally slower than downloading.

## Kill switches (environment)

| Variable | Effect |
| --- | --- |
| `CODER_AGENTIC=0` | Disable the agentic lane — patch coder only. |
| `CODER_ESCALATE=0` | Patch coder stays strictly local (no hosted rescue ladder). |
| `CODER_REVIEW=0` | Turn the diff reviewer off. Dry runs only — with no semantic verdict the builder refuses to push. |
| `CODER_LINT=0` | Disable the phantom-reference lint. |
| `PROPOSAL_GATE=0` | Disable the proposal sanity gate. |
| `AGENTIC_ENGINE=<kind>` | Force one agentic engine instead of AUTO (`cline` selects the advanced open-source runtime). |
| `CLINE_CLI_PATH=<path>` | Cline executable (default `cline`; install with `npm run agent:setup`). |
| `CLINE_PROVIDER=<id>` | Optional Cline provider override; empty uses the provider saved by `cline auth`. |
| `CLINE_MODEL=<id>` | Optional Cline model override; the coding runtime is not tied to one model. |
| `CLINE_AGENT=0` | Disable Cline while leaving the older agentic fallback engines available. |
| `OVERNIGHT_AUTOMERGE=1` | Allow the overnight loop to auto-merge safe tool fixes. |
| `VSC_READONLY_ROOTS=<a:b>` | Extra read-only creator-data roots for the Library (colon-separated). |
| `VSC_DATA_ROOT=<dir>` | Where new research projects are written (default: `<seenHome>/data/instagram-projects`). |
| `INSTAGRAM_SESSION_USER=<name>` | Optional. Names an authenticated session used *only* if anonymous ingest is rejected. Never a password. |
| `CLAUDE_CLI_PATH=<path>` | Path to the local `claude` CLI used for knowledge extraction (default: `claude` on PATH). |

### Secure credential setup

The **Settings** tab is the normal setup path for GitHub, Seen admin, Supabase, Vercel, Stripe, and AI-provider credentials. `GET /api/credentials` returns configuration booleans only—never values. Mutations are same-origin and loopback-only, accept only an explicit credential allowlist, reject multiline/NUL input, and atomically write the runtime `.env` with mode `0600`. Clearing a value writes an explicit empty definition so a later app update cannot restore an old bundled value.

Cline supports browser sign-in or one-time BYOK setup from the same screen. A BYOK value is passed directly to `cline auth` and is not copied into Seen Command's `.env`; Cline owns its credential storage. Packaged builds seed configuration names from `.env.example`, never the repository's real `.env`.
