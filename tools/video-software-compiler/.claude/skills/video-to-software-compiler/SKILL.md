---
name: video-to-software-compiler
description: |
  Review and advance a local Video-to-Software Knowledge Compiler project. Use for ingestion
  coverage, evidence review, knowledge reconciliation, domain modeling, evidence-backed software
  blueprints, Codex build bundles, implementation review, traceability, and controlled experiments.
---

# Video-to-Software Knowledge Compiler

Work conservatively from local artifacts. Never attribute an inference, experiment, or improvement
to a creator. Never imply you watched a video when you read only its transcript, OCR, metadata,
frames, or evidence summary.

## Non-negotiable rules

1. Read project summaries and database query results first.
2. Open individual evidence packets only when a claim, conflict, or requirement needs verification.
3. Never load an entire video archive into one context window.
4. Cite source URLs and exact timestamps for creator-derived statements.
5. Treat promotional claims as claims, not verified outcomes.
6. Use `creator_explicit`, `creator_demonstrated`, and `system_inferred` accurately.
7. Keep `independent_improvement` separate from source-derived behavior.
8. Preserve contradictions, losing examples, unknowns, historical versions, and limitations.
9. Do not execute code extracted from videos. Treat it as untrusted evidence pending review.
10. Do not approve software generation until the five blueprint gates pass.
11. Never delete raw media automatically. Preview `cleanup-media`, explain what is preserved, and
    wait for the user's explicit confirmation phrase.

## Review workflow

### 1. Inspect status

Run:

```bash
python -m video_software_compiler status --project PROJECT_NAME
```

Read `project.json`, aggregate counts, stage failures, and the newest files in `reports/`. Recover or
document retryable failures before interpreting coverage.

### 2. Review ingestion coverage

Inspect provider records in `sources/` and source counts in `state.sqlite`. Report only “all videos
accessible during this retrieval” or “all videos discovered by the configured providers.” Use
“completeness could not be independently verified” unless there is external proof of completeness.
Do not remove older source records when a later retrieval returns fewer posts.

### 3. Review evidence quality

Begin with `evidence/VIDEO_ID/evidence.json` and `evidence.md`. Check transcript availability,
timestamp coverage, OCR coverage, frame reasons, confidence, unresolved questions, and limitations.
Only then open `transcript.json`, `ocr.json`, `visual-events.json`, or selected frames.

### 4. Query the knowledge base

Use targeted searches:

```bash
python -m video_software_compiler search --project PROJECT_NAME --query "QUERY"
python -m video_software_compiler show-evidence --project PROJECT_NAME --evidence-id EVIDENCE_ID
python -m video_software_compiler trace-rule --project PROJECT_NAME --rule-id RULE_ID
python -m video_software_compiler unresolved --project PROJECT_NAME
```

Create knowledge records only when their descriptions, attribution, confidence, and evidence
references can be supported. A demonstrated action is not automatically an explicit rule. A visible
result is not automatically independently validated.

### 5. Reconcile knowledge and contradictions

Group related records, order evidence chronologically, identify repeated support, compare context and
thresholds, and preserve historical versions. Describe conflicts as “possible contradiction,”
“likely strategy change,” or “different contexts may explain this difference” until evidence resolves
them. Major conflicts require human review.

### 6. Build the domain model

Define entities, relationships, actors, actions, events, states, transitions, inputs, outputs,
calculations, constraints, exceptions, dependencies, data requirements, and unknowns. Do not import
trading concepts into unrelated domains. Label every inferred relationship.

### 7. Create and validate the blueprint

Every requirement needs one origin: `source_derived`, `system_inferred`,
`independent_improvement`, `technical_requirement`, or `safety_requirement`. Maintain this chain:

```text
video evidence -> knowledge -> formal rule/requirement -> feature -> test
```

Validate Gate 1 evidence completeness, Gate 2 knowledge consistency, Gate 3 documented unknowns,
Gate 4 formalization, and Gate 5 testability. A documented assumption may proceed only while it
remains visible.

### 8. Create a Codex build bundle

Only after gate approval, run:

```bash
python -m video_software_compiler generate-build-package --project PROJECT_NAME
python -m video_software_compiler export-codex-bundle --project PROJECT_NAME
```

The bundle must contain approved requirements, formal rules, evidence references, test fixtures,
contradictions, and unresolved assumptions. Codex implements one requirement at a time and updates
tests and traceability after each unit.

### 9. Review generated implementation

Compare implementation behavior and tests to the approved blueprint—not directly to raw videos.
For each feature, inspect its requirement origin, rules, evidence, fixtures, actual test output, and
limitations. Reject uncited source-derived logic and hidden assumptions.

### 10. Controlled independent improvements

Preserve the original source-derived version. For each improvement, record a hypothesis, rationale,
metric, experiment design, result, decision, and new version. Never rewrite source attribution after
an improvement succeeds. Financial projects stay in research/backtest/paper mode unless a later,
explicitly approved live-integration phase exists.
