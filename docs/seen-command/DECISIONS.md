# Intelligence Runtime architecture decisions

## ADR-001 — Existing Node control plane is the orchestrator

Selected: native persisted state machine in `intelligence/workflow-store.mjs`, called by Seen Command.
Rejected: LangGraph/LangGraph.js. The existing builder, approval, worktree, activity, and Chronos systems
already provide the execution substrate; another graph framework would create a competing control plane
and a new runtime dependency without solving an uncovered need.

## ADR-002 — Native model gateway

**Superseded 2026-09-18:** the gateway had exactly one caller — the intelligence slice's own coding path — and was retired with it (one coding pipeline; model calls go through `lib/llm.mjs`). Original decision, kept for history:

Selected: `intelligence/model-gateway.mjs` with normalized contracts and provider adapters.
Rejected for now: LiteLLM. Node-native adapters already exist, only two local models are needed for the
first slice, and adding a Python proxy/service would increase failure and secret surfaces. Provider
changes are registry/config changes.

## ADR-003 — Ollama on Apple Silicon

Selected: installed Ollama 0.31.1, `qwen2.5-coder:14b` fast/default and
`qwen2.5-coder:32b` strong/reviewer. Rejected: automatic MLX migration or more model downloads. Ollama
is live and compatible; no benchmark evidence justifies another runtime. MLX remains a future adapter.

## ADR-004 — Native coding worker plus existing worktree/gate

Selected: reuse `engine/build-worktree.mjs`, canonical Node tests, and independent review. Cline,
Claude CLI, Forge, OpenHands, Aider, and OpenCode remain replaceable candidates/adapters. Rejected:
installing another coding framework before the native slice exposes a specific capability gap.

## ADR-005 — Chronos plus lexical/symbol context index

Selected: Chronos stays permanent memory. A small SHA-256/HEAD-bound repository index provides lexical
and symbol-aware retrieval with line citations. Rejected: vector database in the first slice. There is
no measured retrieval failure that warrants another store; the context API leaves room for embeddings.

## ADR-006 — Capability permissions and redacted audit

Selected: one ordered permission lattice and explicit tool registry. Production/destructive actions
require scoped approval records. Every call logs redacted inputs, result/error, timestamps, and side
effects. This extends, rather than bypasses, existing approval and path controls.

## ADR-007 — Remote spend disabled by default

Selected: local-first routing with remote escalation off. When enabled, daily/monthly/task/model/worker
limits and per-call approval thresholds all apply. Exact normalized prompt caching and diff-only context
prevent repeated spend. Budget exhaustion reports the limitation and preserves local operation.
