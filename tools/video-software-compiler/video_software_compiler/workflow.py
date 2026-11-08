from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from video_software_compiler.models import ExecutableRule
from video_software_compiler.project import Project
from video_software_compiler.reconciliation import conflicting_thresholds


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n")


def extract_knowledge(project: Project) -> dict[str, Any]:
    """Prepare conservative extraction queues; never invent records from empty evidence."""
    evidence_packages = sorted((project.root / "evidence").glob("*/evidence.json"))
    ready = 0
    pending = []
    for path in evidence_packages:
        data = json.loads(path.read_text())
        coverage = data.get("evidence_coverage") or {}
        complete = bool(coverage.get("transcript") and coverage.get("ocr"))
        if data.get("statements") and complete:
            ready += 1
        else:
            pending.append(data["video_id"])
    report = {
        "stage": "extract-knowledge",
        "generated_at": datetime.now(UTC).isoformat(),
        "evidence_packages": len(evidence_packages),
        "ready_for_structured_extraction": ready,
        "needs_review": pending,
        "status": "complete" if ready and not pending else "needs_review",
        "confidence": 0.0 if pending else 1.0,
        "evidence_coverage": {"ready": ready, "total": len(evidence_packages)},
        "unresolved_questions": ["Evidence packages require review"] if pending else [],
        "assumptions": [],
        "contradictions": [],
        "limitation": (
            "Spoken transcription and visual-text OCR must both complete before synthesis. "
            "Representative frames still require visual-semantic model or human review."
        ),
    }
    _write(
        project.root / "reports" / "knowledge-extraction-status.json", json.dumps(report, indent=2)
    )
    return report


def reconcile(project: Project) -> dict[str, Any]:
    with project.database.connect() as connection:
        knowledge_count = connection.execute("SELECT COUNT(*) FROM knowledge").fetchone()[0]
        contradiction_count = connection.execute(
            "SELECT COUNT(*) FROM knowledge WHERE status='contradicted'"
        ).fetchone()[0]
        rule_rows = connection.execute("SELECT rule_json FROM rules").fetchall()
    rules = []
    malformed_rules = 0
    for row in rule_rows:
        try:
            rules.append(ExecutableRule.model_validate_json(row["rule_json"]))
        except ValidationError:
            malformed_rules += 1
    threshold_candidates = conflicting_thresholds(rules)
    report = {
        "stage": "reconcile",
        "knowledge_records": knowledge_count,
        "possible_contradictions": contradiction_count + len(threshold_candidates),
        "threshold_candidates": threshold_candidates,
        "malformed_rules": malformed_rules,
        "status": (
            "needs_review"
            if contradiction_count or threshold_candidates or malformed_rules or not knowledge_count
            else "complete"
        ),
        "language": "Possible contradictions require human or Claude review.",
        "confidence": 0.0 if not knowledge_count else 0.5,
        "evidence_coverage": {"knowledge_records": knowledge_count},
        "unresolved_questions": ["Review every contradiction candidate"],
        "assumptions": [],
        "contradictions": threshold_candidates,
        "limitations": [
            "Deterministic reconciliation currently detects numeric threshold conflicts."
        ],
    }
    _write(project.root / "reports" / "reconciliation-status.json", json.dumps(report, indent=2))
    return report


def build_domain_model(project: Project) -> Path:
    specification = project.root / "specification"
    files = {
        "domain-model.md": """# Domain Model

Status: needs review. No domain entities are asserted until reconciled evidence supports them.

Confidence: 0.0. Evidence coverage: no approved records. Contradictions: not yet reviewed.

## Required sections

Entities, relationships, inputs, outputs, actors, actions, events, states, transitions,
calculations, conditions, constraints, exceptions, dependencies, data requirements, and unknowns.
""",
        "domain-model.json": json.dumps(
            {
                "status": "needs_review",
                "confidence": 0.0,
                "entities": [],
                "relationships": [],
                "unknowns": ["No reconciled knowledge records are available."],
                "assumptions": [],
                "contradictions": [],
                "limitations": ["Domain synthesis has not run."],
            },
            indent=2,
        ),
        "terminology.md": "# Terminology\n\nNo evidence-backed terminology yet.",
        "decision-tables.md": "# Decision Tables\n\nNo evidence-backed decision tables yet.",
        "state-machines.md": "# State Machines\n\nNo evidence-backed state machines yet.",
        "formulas.md": "# Formulas\n\nNo evidence-backed formulas yet.",
        "unresolved-assumptions.md": (
            "# Unresolved Assumptions\n\n- Domain model awaits reconciled knowledge."
        ),
    }
    for name, content in files.items():
        _write(specification / name, content)
    return specification


BLUEPRINT_FILES = (
    "executive-summary.md",
    "product-requirements-document.md",
    "functional-requirements.md",
    "nonfunctional-requirements.md",
    "user-stories.md",
    "system-architecture.md",
    "data-model.md",
    "api-design.md",
    "interface-plan.md",
    "processing-pipeline.md",
    "rule-engine-design.md",
    "testing-strategy.md",
    "security-review.md",
    "implementation-phases.md",
    "traceability-matrix.md",
    "open-questions.md",
)


def generate_blueprint(project: Project) -> Path:
    blueprint = project.root / "blueprint"
    for name in BLUEPRINT_FILES:
        title = name.removesuffix(".md").replace("-", " ").title()
        body = (
            f"# {title}\n\nStatus: needs review.\n\n"
            "## Confidence\n\n0.0 until this document is evidence-backed and approved.\n\n"
            "## Evidence coverage\n\nNo approved source-derived requirements yet.\n\n"
            "## Unresolved questions\n\nSee open-questions.md.\n\n"
            "## Assumptions\n\nNone hidden; unresolved inputs are listed in open-questions.md.\n\n"
            "## Contradictions\n\nNo contradiction review has been approved.\n\n"
            "## Limitations\n\nThis document is a gate-controlled scaffold, not an approved "
            "blueprint.\n"
        )
        if name == "traceability-matrix.md":
            body += (
                "\n| Evidence | Knowledge | Rule/requirement | Feature | Test | Origin |\n"
                "|---|---|---|---|---|---|\n"
            )
        _write(blueprint / name, body)
    return blueprint


def validate_blueprint(project: Project) -> dict[str, Any]:
    with project.database.connect() as connection:
        counts = {
            "evidence": connection.execute("SELECT COUNT(*) FROM evidence").fetchone()[0],
            "knowledge": connection.execute("SELECT COUNT(*) FROM knowledge").fetchone()[0],
            "rules": connection.execute("SELECT COUNT(*) FROM rules").fetchone()[0],
            "requirements": connection.execute("SELECT COUNT(*) FROM requirements").fetchone()[0],
            "tests": len(list((project.root / "generated-projects").glob("*/tests/**/*"))),
        }
        untraced = connection.execute(
            """
            SELECT COUNT(*) FROM requirements
            WHERE origin='source_derived'
              AND json_array_length(json_extract(trace_json, '$.evidence_ids')) = 0
            """
        ).fetchone()[0]
    gates = {
        "evidence_completeness": counts["evidence"] > 0,
        "knowledge_consistency": counts["knowledge"] > 0,
        "unknowns_documented": (project.root / "blueprint" / "open-questions.md").exists(),
        "formalization": counts["rules"] > 0,
        "testability": counts["requirements"] > 0,
        "traceability": untraced == 0 and counts["requirements"] > 0,
    }
    result = {
        "valid": all(gates.values()),
        "gates": gates,
        "counts": counts,
        "untraced_source_requirements": untraced,
        "status": "approved" if all(gates.values()) else "needs_review",
    }
    _write(project.root / "reports" / "blueprint-validation.json", json.dumps(result, indent=2))
    return result


def export_bundle(project: Project, audience: str) -> Path:
    if audience not in {"claude", "codex"}:
        raise ValueError(audience)
    destination = (
        project.root / f"{audience}-bundles" / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    )
    destination.mkdir(parents=True)
    for directory in ("reports", "specification", "blueprint", "knowledge"):
        source = project.root / directory
        if source.exists():
            shutil.copytree(source, destination / directory, dirs_exist_ok=True)
    _write(
        destination / "README.md",
        f"# {audience.title()} Review Bundle\n\n"
        "Read reports first. Open individual evidence packets only when a cited record needs "
        "review.\n"
        "This bundle does not imply that the model watched source videos.\n",
    )
    return destination


def generate_build_package(project: Project) -> Path:
    validation = validate_blueprint(project)
    if not validation["valid"]:
        raise RuntimeError(
            "Blueprint gates are not approved; see reports/blueprint-validation.json"
        )
    destination = project.root / "codex-bundles" / "approved-build-package"
    destination.mkdir(parents=True, exist_ok=True)
    for directory in ("specification", "blueprint", "knowledge"):
        shutil.copytree(project.root / directory, destination / directory, dirs_exist_ok=True)
    return destination
