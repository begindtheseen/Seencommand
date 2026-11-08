from pathlib import Path

PROJECT_DIRECTORIES = (
    "sources",
    "videos",
    "audio",
    "transcripts",
    "frames",
    "ocr",
    "evidence",
    "knowledge",
    "specification",
    "blueprint",
    "claude-bundles",
    "codex-bundles",
    "generated-projects",
    "experiments",
    "reports",
    "logs",
)

KNOWLEDGE_FILES = (
    "principles.jsonl",
    "rules.jsonl",
    "workflows.jsonl",
    "tools.jsonl",
    "claims.jsonl",
    "examples.jsonl",
    "unresolved.jsonl",
    "contradictions.jsonl",
    "evidence-ledger.jsonl",
)

EXPERIMENT_FILES = (
    "hypotheses.jsonl",
    "experiment-results.jsonl",
    "accepted-improvements.jsonl",
    "rejected-ideas.jsonl",
)

STATUSES = (
    "pending",
    "in_progress",
    "complete",
    "needs_review",
    "ambiguous",
    "retryable_failure",
    "permanent_failure",
    "unavailable",
)


def default_data_root() -> Path:
    return Path.cwd() / "data" / "projects"
