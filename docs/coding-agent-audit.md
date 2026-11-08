# Coding-agent source audit — 2026-08-04

Scope: source-level review of Cline, OpenHands Software Agent SDK, Goose, OpenCode, Aider, and
mini-SWE-agent against Seen Command's autonomous builder. The comparison is about mechanisms useful
for unattended production code, not stars or model leaderboards.

## What the upstream code proves

| Project | Mechanism worth adopting | Seen Command disposition |
| --- | --- | --- |
| [Cline](https://github.com/cline/cline) | Headless NDJSON CLI and Node SDK; checkpoints; terminal/editor/search tools; agentic compaction; repeated-tool loop detection; retries; lifecycle hooks; model/provider routing | **Primary coding worker.** Headless `--yolo --json`, agentic compaction, five bounded retries, high thinking. Single writer: Cline intentionally disables spawn/team tools in unattended yolo mode. |
| [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk) | Local or ephemeral Docker/Kubernetes workspaces; Python + REST APIs; composable tools and multi-agent workflows | Keep as an optional future remote/container worker when builds move off the Mac. Do not add a second heavy runtime today. |
| [Goose](https://github.com/aaif-goose/goose) | Scoped MCP extensions; recipes/sub-recipes; context-isolated parallel subagents; permission inspection; stop hooks; structured compaction | Borrow recipe/scoped-specialist patterns for business departments. Do not allow parallel coding writers. |
| [OpenCode](https://github.com/anomalyco/opencode) | Plan/build/explore/scout roles; LSP; compaction; session permissions; worktree-aware project state | Borrow read-only explorer/researcher roles. Keep outer enforcement because its history includes subagent permission-inheritance bypasses. |
| [Aider](https://github.com/Aider-AI/aider) | Tree-sitter repository map; architect/editor model split; automatic lint/test repair; Git-native checkpoints | Seen's reviewer/coder split and outer Git gate already cover much of this. A deterministic symbol/repo map remains a useful future enhancement. |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | Very small action/observation loop; step, cost, wall-time, and consecutive-format-error limits; saved trajectories; process-group kill on timeout | Preserve Seen's simple fallback loop and hard budgets. Add durable external-agent trajectories if Cline's NDJSON needs deeper debugging. |

## Seen Command strengths retained

- Task premise and duplicate-PR screening before coding.
- Product/tool routing and product no-auto-merge policy.
- Protected intent paths and repo-specific write allowlists.
- Mandatory syntax, phantom-reference, test, effectiveness, and independent model-review gates.
- Exact touched-file staging, truthful diffstat, preview verification, and failed-preview PR closure.
- Activity/build ledgers, one build slot, overnight caps, and honest failure states.

These are outer orchestration responsibilities. An embedded agent must not replace them.

## Changes made from this audit

1. Cline is first in the agentic AUTO chain; the Qwen-specific adapter and configuration were removed.
2. Headless Cline runs with structured output, agentic compaction, bounded retries, a hard timeout, and
   a single writer. Provider/model selection belongs to Cline, not Seen Command.
3. Seen snapshots Git state before and after Cline, rejects any HEAD movement, checks every changed path
   against the existing allowlist/protected-path policy, rejects fenced source artifacts, and re-runs
   its complete gate. Cline's success claim is never trusted.
4. `npm run agent:setup` installs Cline and repairs the copied macOS binary's ad-hoc signature before
   verifying it. `cline auth` remains the explicit owner authentication boundary.
5. `CLINE_AGENT=0` is a dedicated kill switch; older guarded agentic engines remain fallbacks.

## Next hardening after a real authenticated build

1. Move the entire builder branch lifecycle into an isolated temporary Git worktree. The current one
   build slot and clean-base fix prevent races/pollution, but a worktree removes branch switching from
   the long-lived checkout entirely.
2. Persist a bounded copy of Cline NDJSON events in each build record for replayable trajectories.
3. Add read-only planning/research specialists only after permission inheritance is enforced by Seen,
   and never let multiple agents write the same worktree.
4. Evaluate a deterministic tree-sitter/LSP repo map if live builds show repeated file-discovery waste.
5. Add an optional OpenHands Agent Server adapter only if remote/container execution becomes necessary.

Acceptance for the new primary worker is one real feature-shaped task reaching: Cline edits → Seen gate
green → independent reviewer accepts → exact commit → PR → preview verdict. Installation alone is not
that proof.
