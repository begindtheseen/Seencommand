# Seen Command current state

Audit date: 2026-08-05. Starting implementation base: `fe8bcc7` on
`codex/app-launch-no-auto-meeting` (draft PR #153). Working implementation branch:
`codex/seen-command-intelligence-runtime`. Pre-existing runtime changes are `data/state.json` and
`data/forge/`; neither is implementation source or commit material.

## Architecture and execution flow

Seen Command is a dependency-free Node control plane packaged by Electron. `app/main.js` starts the
local `engine/server.mjs` API/UI. `engine/run.mjs` runs explicit/scheduled board meetings. Live state
is persisted through `lib/memory.mjs`, `lib/builds.mjs`, and `lib/activity.mjs`; the generated cockpit
comes from `scripts/build-dashboard.mjs`. The board creates approval-gated GitHub tasks. The builder in
`engine/builder.mjs` creates an isolated worktree through `engine/build-worktree.mjs`, delegates to the
existing agentic/Forge workers, runs syntax/tests/product build gates, asks `engine/reviewer.mjs` for an
independent semantic review, commits only touched paths, and creates a PR.

The AI stack before this change was `lib/llm.mjs` plus `lib/router.mjs` and `org/models.mjs` for board
reasoning, with provider-native loops in `engine/agentic-coder.mjs`. Local Ollama discovery already
worked. Passive usage observation existed in `lib/ai-usage.mjs`, but it did not authorize or block a
request. Forge already provided lexical retrieval, a symbol/import repository map, HEAD cache
invalidation, step planning, repair candidates, verification, and lessons (`engine/forge/`).

Chronos is the permanent structured memory layer: `lib/brain.mjs` and
`brain/lib/memory-write.mjs` use the product repository's bi-temporal writer. Facts carry provenance,
confidence, valid time, and transaction time. It remains the sole durable memory system.

GitHub, Supabase, Vercel, Stripe, Seen admin, and Creator Intelligence connectors live under
`lib/connectors/` and `lib/instagram/`. Credentials are local, allowlisted, mode 0600, and never
returned by the API (`lib/credentials.mjs`). The local server binds only `127.0.0.1`; sensitive
mutations enforce same-origin/loopback.

## Hardware and local inference

- Apple M5 Pro, arm64, 18 cores, 48 GB unified memory.
- Approximately 1.4 TB available storage at audit time.
- Node 26.4.0, npm 11.17.0, Python 3.14.6, Git 2.55.0.
- Ollama 0.31.1 is installed.
- `qwen2.5-coder:14b` (9 GB) and `qwen2.5-coder:32b` (19 GB) are installed.
- No additional model was downloaded. The installed models are realistic on this Mac and cover the
  first local-only slice; worker concurrency remains one because model inference and the test gate are
  resource-intensive.

## Cost causes found

1. `lib/ai-usage.mjs` recorded spend after the fact but had no preflight enforcement.
2. Existing provider fallthrough can repeat semantically identical prompts without a shared dollar
   ledger or deduplication cache.
3. Context limits were caller-specific; there was no uniform request cap.
4. App launch used to run a meeting automatically. #153 fixes that separate pre-existing issue and is
   the foundation under this stacked branch.
5. Reviewer/coder repair loops were bounded locally, but not governed by a common cross-worker policy.

## Reuse, repair, and untouched boundaries

Reuse: isolated worktrees, Forge retrieval/maps, existing gate, independent reviewer, Chronos writer,
activity/build stores, approval controls, connectors, competence router, and dashboard shell.

Repair/extension: normalized model contracts, enforced budgets, durable general workflows/task graph,
cited context packs, centralized tool permissions/audit, measured model registry, specialist contracts,
and workflow operator UI.

Remain untouched: production branches, product checkout/runtime state, production Supabase/Vercel,
existing connectors, Creator compiler, and stable installed application. No deployment or production
mutation is part of this implementation.

## Security risks and existing failures

The live Settings diagnostic currently reports a Supabase Management advisor 401 while product DB
PostgREST is healthy. The token/project authorization needs owner repair; no credential value was read.
Packaging baseline warnings are ASAR disabled, default Electron icon, and no Developer ID signing
identity. Runtime npm audit is zero vulnerabilities. The optional Python compiler has no local `.venv`
in this checkout, so its pytest/ruff/mypy gate is not available until its documented environment is
created. These are pre-existing and separate from the intelligence slice.

The main migration risk is having legacy model adapters coexist while callers move behind the new
gateway. The control plane remains one system; new engineering workflows use the new boundary now,
and legacy callers are tracked in `KNOWN_LIMITATIONS.md` rather than hidden.

## First vertical slice

Add and test a small pure workflow-status summarizer in `intelligence/runtime-status.mjs`. A real
installed Ollama model must plan and generate it, inside an `exec/intelligence-*` worktree branch.
The canonical suite must pass, a separate local model must review the clean diff, deterministic secret
and dangerous-action checks must pass, a local PR package must be persisted, and Chronos must receive
a concise cited task episode. Nothing is pushed, merged, installed over the stable app, or deployed.
