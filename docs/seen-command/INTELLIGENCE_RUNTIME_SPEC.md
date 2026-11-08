# Seen Command Intelligence Runtime specification

This is the authoritative implementation contract for the first production-grade local-first runtime.

> **SUPERSEDED IN PART, 2026-09-18.** The runtime's own coding path — `model-gateway`, `tool-gateway`,
> `context-pack`, `workers`, and the orchestrator's planner / whole-file editor / gate / reviewer — was
> retired. Measured: nine runs at one trivial helper, eight failures, and a first run that planned five
> unrelated tasks and was accepted because the plan was valid JSON. A safeguard added to one engine does
> not protect the others, so there is one engine: `engine/builder.mjs`. What survives here is the
> workflow record (`workflow-store`, `contracts`, `runtime-status`, `runtime-config`, `model-registry`),
> and `runVerticalSlice`, now a thin adapter onto `runBuild`. The invariants below still hold — they are
> enforced by the builder, the task contract (`engine/task-contract.mjs`) and the gate (`engine/gate.mjs`).

Seen Command remains the sole control plane. Engineering state changes are persisted by
`intelligence/workflow-store.mjs`; every coding decision — grounding, write scope, context, gate, proof,
review — belongs to `engine/builder.mjs`. External CLIs and future frameworks are replaceable workers,
never orchestration authorities.

## Required invariants

1. `main`, `master`, `production`, and product `next-migration` are protected.
2. Coding happens on an isolated worktree branch. Shared checkouts are context, never build state.
3. Local verified models are selected first. Remote escalation defaults off and is cost/approval bound.
4. Model requests and responses use validated provider-neutral contracts. Invalid structured output is
   a retryable failure, never success.
5. Daily/monthly/task/model/worker budgets, context size, retries, prompt deduplication, and actual cost
   recording are enforced before/after calls.
6. Every workflow transition survives restart and resumes from its last safe checkpoint.
7. Context packs contain only relevant bounded windows and carry path/line/SHA/hash/timestamp/confidence.
   Changed hashes invalidate stale entries. Chronos supplements fresh code; it cannot override it.
8. Every tool has a permission, worker scope, redacted audit record, and declared side effect. Production
   and destructive tools require a scoped approval record.
9. A failed test, BLOCKER/HIGH independent finding, secret scan, or cancellation blocks PR-ready state.
10. Completion evidence records commands, outputs, diff, files, review, cost, approvals, and deployment
    status without storing chain-of-thought or secret values.

## Workflow states

`RECEIVED → CONTEXT_BUILDING → CONTEXT_READY → PLANNING → [AWAITING_APPROVAL] → QUEUED → EXECUTING → TESTING → REVIEWING → [REPAIRING → EXECUTING] → SECURITY_CHECK → READY_FOR_PR → [AWAITING_DEPLOY_APPROVAL → DEPLOYING → VERIFYING] → COMPLETED`.

Terminal alternatives are `FAILED`, `ROLLED_BACK`, and `CANCELLED`. All transitions are validated and
persisted. Deployment states are defined but never entered by the first local-only slice.

## Acceptance

The implementation is accepted when focused evaluations, the canonical source suite, dashboard
parse/API/UI checks, package/smoke checks, a real local model benchmark, and the real vertical slice are
green. A local branch and PR-ready package are sufficient; push, merge, install replacement, preview,
and production deployment are explicitly out of scope without separate authorization.
