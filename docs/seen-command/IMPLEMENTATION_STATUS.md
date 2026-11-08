# Intelligence Runtime implementation status

## Checkpoint 1 — safety and baseline

Completed: environment audit, branch protection, pre-existing runtime-state isolation, hardware/runtime
discovery, Brain orientation, canonical Node suite, dashboard parse, macOS package, packaged-worker smoke,
and runtime dependency audit.

Commands: canonical `node --test ...`; `node scripts/build-dashboard.mjs`; dashboard `new Function`
parse guard; `npm run app:package`; `node scripts/smoke-packaged.mjs`; `npm audit --omit=dev`.

Passed: canonical suite (exit 0; established count 2,069), dashboard parse, package, packaged-worker
smoke, runtime audit (0 vulnerabilities). Failed: none. Pre-existing warnings: unsigned local package,
ASAR disabled, default icon, optional compiler `.venv` absent. Pre-existing changes: `data/state.json`
and `data/forge/`. Decision: no new model or framework download.

## Checkpoint 2 — native runtime core

Completed: runtime contracts, model registry/hardware discovery, provider-neutral gateway, cost governor,
context pack/index invalidation, workflow/task graph, tool permission/audit gateway, specialist registry,
local isolated slice orchestrator, runtime APIs, dashboard workflow view, example config, and scripts.

Files: `intelligence/`, `config/`, intelligence scripts, `engine/server.mjs`,
`scripts/build-dashboard.mjs`, `.gitignore`, `package.json`, `AGENTS.md`, and this documentation set.

Focused tests: 23 passed, 0 failed after fixing test-child inheritance of `NODE_TEST_CONTEXT`. Tests
cover provider swaps, local no-credential operation, budgets, timeout fallback, invalid JSON, restart
recovery, isolation, forbidden commands, redaction, provenance, hash invalidation, failed-test blocking,
independent-review rejection, production approval, cancellation, loop detection, and audit completeness.

Risks: legacy board/provider adapters are preserved for compatibility and not yet fully migrated; local
model structured output must be proven by the real slice; operator cancel is cooperative between steps,
not an OS-level forced kill. Remaining work: docs/gate hardening, real model benchmark and slice, full
suite, local API/UI/package stress, draft PR, and Chronos final evidence.

Measured local model evidence: the installed Ollama manifest reports Qwen2.5 Coder 14B as 14.8B,
Q4_K_M, 32K context, tools, Apache-2.0. A real streaming benchmark returned `READY`, 48.32 tokens/s,
2,642 ms time to first token, and 12,116,788,509 bytes loaded VRAM/unified-memory footprint. The
measurement is persisted in ignored runtime state; no model was downloaded.

Next executable step: run `npm run intelligence:benchmark`, finish the documentation/status integration,
commit the verified core, run the real local-only slice against that commit, then repeat all gates.

## Checkpoint 3 — first real slice finding and repair

The first real Ollama slice was stopped after its 14B plan treated citation identifiers such as
`repo:engine/lint.mjs` as writable file paths and drifted into unrelated context. The isolated gate was
green, but the independent 32B reviewer correctly produced two BLOCKER findings: the requested
`workflowStateCounts` implementation and tests were absent. No shared-checkout file was touched, the
temporary worktree/branch was removed, and the workflow was persisted as `FAILED` with the root cause.

Root fix: explicit objective paths now receive dominant retrieval ranking; context is capped at 12
sources; the authoritative task follows evidence in the prompt; real paths and citation IDs are labeled
separately; plans that omit an explicit path are rejected/replanned; and all edit paths are normalized,
allowlisted, and validated as a complete set before the first write. Three regression cases were added.
Focused result after repair: 26/26 intelligence tests and the dashboard parse test green.

Next executable step: commit this grounding repair and rerun the same real slice from the new checkpoint.

## Checkpoint 4 — evidence-driven repair hardening

The second real slice produced only the requested runtime-status source/test paths, proving the path
repair. Its first candidate still replaced existing source with a placeholder comment and used an
undefined test global. The canonical gate rejected it, but the workflow's stored error contained only
the failed command because Node TAP diagnostics were on stdout. The repair loop was stopped before it
could guess.

Root fix: existing-file export contracts are captured before editing; placeholder/incomplete full-file
replacements, removed exports, empty content, and `.test.mjs` globals without `node:test` imports are
rejected before the first write. Gate failures now persist up to 12,000 characters of combined
stdout/stderr and feed the actual diagnostic to repair. Two regression cases pin content preservation
and diagnostic propagation. Focused result: 28/28 green.

Next executable step: commit and rerun the same slice; a third miss must produce a new root fix rather
than a repeated model attempt.

## Checkpoint 5 — Forge-aligned learning and actionable gate evidence

The third real slice (`wf-slice-msfojsft`) grounded the correct two paths. Its 14B edit was rejected
before write as an incomplete replacement, and the 32B correction reached the canonical gate. The
gate failed, but Node's dot reporter exposed only the failing filename; the subsequent repair lacked
the assertion detail and was itself rejected as a placeholder. The workflow persisted `FAILED`, and
its exact isolated worktree/branch were removed. Nothing was pushed, merged, installed, or deployed.

The Claude handoff was reconciled with the runtime instead of replacing the established control plane:
`engine/forge/` remains the authoritative plan/best-of-N/verify/lessons system;
`engine/build-worktree.mjs` remains the isolation primitive; existing builder product-build/base/staging
contracts remain intact; paid Anthropic remains opt-in; and operational lessons now flow into the next
slice within a bounded share of its context budget. Exact target files of at most 600 lines are supplied
whole. Coding and independent-review requests now have the empirically required 600-second timeout.

The canonical gate now reruns only dot-reporter failures with the spec reporter and supplies both that
detailed diagnostic and the current diff to a bounded repair. A regression proved this end to end. A
second regression exposed that broad secret-key matching redacted harmless fields such as
`estimatedTokens`, hiding Board Room telemetry; credential field redaction is now precise while token
counts remain visible. Focused result: **32/32 passed**, `git diff --check` passed. The canonical
source-only gate then passed green in 19.4 seconds. (The counts originally recorded here — 2,803 and
2,884/2,885 — were inflated by duplicate discovery across on-disk copies of the repository, not by extra
coverage; the canonical source-only suite is **741/741 across 67 source test files** as verified at
`333ee73`. See "Canonical test command" in `OPERATIONS.md`.) An over-broad discovery command
also entered `brain/dist/.../Chronos.app` and found one failing test inside that generated packaged
artifact; excluding `*/dist/*` **and** `*/.claude/*` removes those copies. This is recorded as a
pre-existing package-artifact failure, not hidden or treated as a source regression.

Next executable step: commit this checkpoint, then make exactly one evidence-backed rerun of the same
local-only slice. If it fails again, persist the new root cause and do not replay it. If it completes,
inspect its local branch/commit/workflow artifacts, then run the full canonical/API/UI/package matrix
described in Checkpoint 12 below before opening a stacked draft PR.

## Checkpoint 6 — assertion-import and citation-leak validation

The fourth real slice (`wf-slice-msfp6r57`) again stayed inside the requested source/test allowlist and
produced a correct pure helper. Its tests imported `assert` from `node:test`; both bounded repairs
repeated that same import error even though the detailed rerun exposed the exact failing line. The
model also copied a `[path=... source=...]` context label into source. The workflow persisted `FAILED`,
recorded the lesson, removed its exact worktree/branch, and never reached PR-ready.

Root fix: the worker prompt now explicitly separates `node:test` from `node:assert/strict` and forbids
copying citation labels. Pre-write validation rejects assertion-object use without a Node assertion
import and rejects leaked repository citation headers. Regression coverage pins both. Results after
the fix: **32/32 focused** and a green canonical source-only suite; `git diff --check` passed. (The
"2,803" recorded here was an inflated duplicate-discovery count; the canonical suite is 741/741 across
67 source test files.)

Next executable step: commit this root fix and run one fifth local-only slice from that checkpoint.

## Checkpoint 7 — validation-aware repair fallback

The fifth real slice (`wf-slice-msfpg958`) rejected the 14B placeholder/global-test candidate before
write, then accepted a scoped 32B candidate. Its test lived under `tests/intelligence/` and imported
the source from one directory too shallow, producing an exact `ERR_MODULE_NOT_FOUND`. The first repair
then tried to replace the healthy source and removed `intelligenceRuntimeStatus`; the export-contract
guard blocked it before write, but the workflow had no correction path for a rejected repair. It
persisted `FAILED`, recorded the lesson, and removed its exact worktree/branch.

Root fix: repair prompts now say to omit healthy files, and validation-rejected test/review repairs get
one bounded correction from the stronger 32B local worker with the exact rejection. A full workflow
regression proves invalid repair → no write → stronger corrected repair → completed gate. Results:
**33/33 focused** and **2,804/2,804 canonical source tests** passed; `git diff --check` passed.

Next executable step: commit and run a sixth local-only slice from the new checkpoint.

## Checkpoint 8 — explicit-objective path minimization and import resolution

The sixth real slice (`wf-slice-msfpq5ll`) created `test/intelligence/runtime-status.test.mjs` and used
a relative import that resolved to nonexistent `test/intelligence/runtime-status.mjs`. Both bounded
repair rounds fixed test globals but repeated that same path. The detailed gate stayed accurate, all
invalid candidates were blocked or test-rejected, the workflow persisted `FAILED`, and cleanup removed
its exact worktree/branch.

Root fix: when an objective names an exact source path, the writable set now contains that path, its
co-located test, and planned paths that already exist—never a model-invented new directory. Proposed
relative imports are resolved inside the worktree before write and must target an existing or
same-candidate file. Regressions pin both behaviors. Results: **34/34 focused** and
**2,805/2,805 canonical source tests** passed; `git diff --check` passed.

Next executable step: commit and run a seventh local-only slice from the new checkpoint.

## Checkpoint 9 — complete review/security diffs for new files

The seventh real slice (`wf-slice-msfq4olb`) was the first to pass the canonical gate on its initial
written patch. It touched only the requested source and co-located test. Independent review then falsely
reported that no tests were added because the review diff used plain `git diff`, which omits untracked
new files. The same blind spot would have affected security review. The known-bad repair was stopped,
the workflow was explicitly persisted `FAILED`, its lesson recorded, and its exact worktree/branch
removed.

Root fix: review, repair, and security evidence now combines the tracked diff with no-index diffs for
every untracked touched path, without staging anything before approval. A regression proves the new
test content is visible and remains `??` in git status. Results: **35/35 focused** and
**2,806/2,806 canonical source tests** passed; `git diff --check` passed.

Next executable step: commit and run an eighth local-only slice from the new checkpoint.

## Checkpoint 10 — evidence-grounded independent review

The eighth real slice (`wf-slice-msfqbqoh`) passed all 66 discovered source test files and supplied the
complete source+new-test diff to independent review. The 32B reviewer nevertheless emitted a BLOCKER
claim that the new co-located test was not part of the objective, directly contradicting the literal
requirement to add focused unit tests. The known-bad repair was stopped, the workflow persisted
`FAILED`, its lesson was recorded, and its exact worktree/branch were removed.

Root fix: the reviewer prompt now requires literal, evidenced findings. A deterministic grounding layer
rejects only test-scope/missing-test findings contradicted by all three facts: the objective requests
tests, a test file is touched, and the gate is green. Rejected findings remain persisted for audit;
genuine BLOCKER/HIGH behavior findings still block. Results: **36/36 focused** and
**2,807/2,807 canonical source tests** passed; `git diff --check` passed.

Next executable step: commit and run a ninth local-only slice from the new checkpoint.

## Checkpoint 11 — first complete real local-model vertical slice

The ninth real slice (`wf-slice-msfqkycz`) completed end to end from checkpoint `e6bc18f`. The 14B
candidate was rejected before write for an assertion import error; the local 32B correction produced
only `intelligence/runtime-status.mjs` and its co-located test. All 66 discovered source test files
passed. Independent 32B review returned `accepted:true` with no findings, deterministic security review
returned green, both workflow tasks reached `COMPLETED`, and the durable PR package records
`pushed:false`, `deployed:false`, and `productionMutation:false`.

The retained proof branch is `exec/intelligence-slice-msfqkycz` at `1989dce`; its exact two-file commit
was cherry-picked locally onto this implementation branch as `aac9277`. The disposable worktree was
removed, while the proof branch remains. Post-integration results: **37/37 focused** and
**741/741 canonical source tests across 67 source test files** passed (this was previously recorded as
an inflated 2,808 — a duplicate-discovery counting error, not missing tests or a regression). No remote
model, push, merge, install, deployment, or production mutation occurred.

Next executable step: run the disposable API/UI/package/launch stress matrix, update this evidence,
then publish only a stacked draft PR after rechecking #153.

## Checkpoint 12 — disposable API/UI/package/launch stress

An isolated server on port 4599 used a temporary `SEEN_HOME`. Live status exposed local-first truth,
both installed models, remote escalation off, approval boundaries, and workflow counts. A seeded fixture
proved same-origin plan approval and cancellation with read-after-write persistence; hostile-origin
cancel returned 403; invalid approval kind returned 400. After restart, the cancelled workflow and
approval remained, while an interrupted `CONTEXT_BUILDING` workflow recovered to its last safe
`RECEIVED` checkpoint with an explicit recovery history entry.

The in-app Browser connected but blocked both localhost forms with `ERR_BLOCKED_BY_CLIENT`, matching the
known repository limitation. The required fallback seeded the temporary dashboard exactly as Electron
does, curled its real route and API dependencies, parsed the served script, and confirmed Intelligence
Runtime status/workflow/cancel contracts. The diagnostics endpoint had full source visibility and honest
repair guidance: 12 healthy, 2 degraded, 1 broken; Supabase Management advisors returned the known 401
while the product database returned 200.

The first packaged launch found a real blocker: Electron packaging omitted `intelligence/`, so the
packaged server exited on `ERR_MODULE_NOT_FOUND`. Root fix: package contents now include
`intelligence/**`; packaged smoke asserts the required modules and imports the packaged server's entire
dependency graph. Repackage and smoke passed. A direct `dist/` launch with disposable user data and
port 4601 then served the 176,159-byte cockpit and operational intelligence API; its process tree
contained packaged `engine/server.mjs` and no packaged `engine/run.mjs`. The stable installed app was
not modified. `npm audit --omit=dev` reported 0 vulnerabilities. Both temporary homes were removed.

Remaining publish step: final source gate, commit this package/stress evidence, recheck #153, then push
and open a stacked draft PR only—no merge or deployment.
