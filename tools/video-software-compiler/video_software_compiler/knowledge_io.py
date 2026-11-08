from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from video_software_compiler.models import KnowledgeRecord
from video_software_compiler.project import Project

TYPE_FILES = {
    "principle": "principles.jsonl",
    "rule": "rules.jsonl",
    "formula": "rules.jsonl",
    "exception": "rules.jsonl",
    "warning": "rules.jsonl",
    "workflow": "workflows.jsonl",
    "tool": "tools.jsonl",
    "claim": "claims.jsonl",
    "example": "examples.jsonl",
}


def import_knowledge_batch(
    project: Project, input_path: Path, *, skip_invalid: bool = False
) -> dict[str, Any]:
    """Validate and import one knowledge batch.

    Strict (default): any invalid record rejects the whole batch with no partial write.
    ``skip_invalid``: import every valid record, repair evidence references from the
    database (the evidence_id is the citation; timestamps/source_url/video_id are copied
    from the stored row), and report each rejected record with its reason. Fails only when
    no record is valid. This stops one malformed record from discarding a whole batch of
    otherwise-valid, evidence-linked knowledge.
    """
    project.require()
    payload = json.loads(input_path.read_text())
    raw_records = payload.get("records") if isinstance(payload, dict) else payload
    if not isinstance(raw_records, list):
        raise ValueError("Knowledge batch must be a list or an object containing records")
    if not skip_invalid:
        records = [KnowledgeRecord.model_validate(item) for item in raw_records]
        if len({record.knowledge_id for record in records}) != len(records):
            raise ValueError("Knowledge batch contains duplicate knowledge_id values")
        _validate_evidence_links(project, records)
        rejected: list[dict[str, Any]] = []
        repaired = 0
    else:
        records, rejected, repaired = _accept_valid_records(project, raw_records)
        if not records:
            first = rejected[0]["reason"] if rejected else "batch has no records"
            raise ValueError(
                f"No valid knowledge records in batch ({len(rejected)} rejected): {first}"
            )
    for record in records:
        project.database.save_knowledge(record)
    _write_canonical_files(project)
    counts = Counter(record.type for record in records)
    return {
        "batch_id": payload.get("batch_id") if isinstance(payload, dict) else None,
        "imported": len(records),
        "types": dict(sorted(counts.items())),
        "knowledge_ids": [record.knowledge_id for record in records],
        "rejected": rejected,
        "repaired_references": repaired,
    }


def _accept_valid_records(
    project: Project, raw_records: list[Any]
) -> tuple[list[KnowledgeRecord], list[dict[str, Any]], int]:
    accepted: list[KnowledgeRecord] = []
    rejected: list[dict[str, Any]] = []
    repaired = 0
    seen: set[str] = set()
    with project.database.connect() as connection:
        for index, item in enumerate(raw_records):
            knowledge_id = item.get("knowledge_id") if isinstance(item, dict) else None
            try:
                record = KnowledgeRecord.model_validate(item)
                if record.knowledge_id in seen:
                    raise ValueError("duplicate knowledge_id in batch")
                record, fixed = _repair_evidence_links(connection, record)
            except ValueError as error:
                rejected.append(
                    {"index": index, "knowledge_id": knowledge_id, "reason": str(error)[:400]}
                )
                continue
            seen.add(record.knowledge_id)
            repaired += fixed
            accepted.append(record)
    return accepted, rejected, repaired


def _repair_evidence_links(connection: Any, record: KnowledgeRecord) -> tuple[KnowledgeRecord, int]:
    """Rebuild each reference from its stored evidence row; drop ones that cannot be linked."""
    fixed = 0
    references: list[dict[str, Any]] = []
    used: set[str] = set()
    for reference in record.evidence:
        if reference.evidence_id in used:
            fixed += 1
            continue
        row = connection.execute(
            "SELECT video_id, source_url, timestamp_start, timestamp_end FROM evidence "
            "WHERE evidence_id=?",
            (reference.evidence_id,),
        ).fetchone()
        if row is None or row["video_id"] != reference.video_id:
            fixed += 1  # unknown evidence, or cited under the wrong video: not a valid citation
            continue
        stored_url = row["source_url"] or None
        changed = (
            abs(row["timestamp_start"] - reference.timestamp_start) > 0.001
            or abs(row["timestamp_end"] - reference.timestamp_end) > 0.001
            or (reference.source_url is not None and str(reference.source_url) != stored_url)
        )
        fixed += 1 if changed else 0
        used.add(reference.evidence_id)
        references.append(
            {
                "evidence_id": reference.evidence_id,
                "video_id": row["video_id"],
                "source_url": stored_url,
                "timestamp_start": row["timestamp_start"],
                "timestamp_end": row["timestamp_end"],
                "excerpt": reference.excerpt,
            }
        )
    if not references and record.evidence:
        raise ValueError(
            f"{record.knowledge_id}: none of its evidence references exist in this project"
        )
    if not fixed:
        return record, 0
    data = record.model_dump(mode="json")
    data["evidence"] = references
    return KnowledgeRecord.model_validate(data), fixed


def _validate_evidence_links(project: Project, records: list[KnowledgeRecord]) -> None:
    with project.database.connect() as connection:
        for record in records:
            evidence_ids = [reference.evidence_id for reference in record.evidence]
            if len(set(evidence_ids)) != len(evidence_ids):
                raise ValueError(
                    f"{record.knowledge_id}: contains duplicate evidence_id values"
                )
            for reference in record.evidence:
                row = connection.execute(
                    """
                    SELECT video_id, source_url, timestamp_start, timestamp_end
                    FROM evidence WHERE evidence_id=?
                    """,
                    (reference.evidence_id,),
                ).fetchone()
                if row is None:
                    raise ValueError(
                        f"{record.knowledge_id}: unknown evidence_id {reference.evidence_id}"
                    )
                if row["video_id"] != reference.video_id:
                    raise ValueError(
                        f"{record.knowledge_id}: evidence video_id does not match database"
                    )
                if (
                    abs(row["timestamp_start"] - reference.timestamp_start) > 0.001
                    or abs(row["timestamp_end"] - reference.timestamp_end) > 0.001
                ):
                    raise ValueError(
                        f"{record.knowledge_id}: evidence timestamps do not match database"
                    )
                if reference.source_url and row["source_url"] != str(reference.source_url):
                    raise ValueError(
                        f"{record.knowledge_id}: evidence source_url does not match database"
                    )


def _write_canonical_files(project: Project) -> None:
    with project.database.connect() as connection:
        rows = connection.execute(
            "SELECT record_json FROM knowledge ORDER BY knowledge_id"
        ).fetchall()
        links = connection.execute(
            """
            SELECT knowledge_id, evidence_id FROM knowledge_evidence
            ORDER BY knowledge_id, evidence_id
            """
        ).fetchall()
    records = [KnowledgeRecord.model_validate_json(row["record_json"]) for row in rows]
    grouped: dict[str, list[KnowledgeRecord]] = {
        filename: [] for filename in set(TYPE_FILES.values())
    }
    for record in records:
        grouped[TYPE_FILES[record.type]].append(record)
    for filename, items in grouped.items():
        content = "".join(
            json.dumps(item.model_dump(mode="json"), sort_keys=True) + "\n" for item in items
        )
        (project.root / "knowledge" / filename).write_text(content)
    _write_records_file(
        project.root / "knowledge" / "unresolved.jsonl",
        [record for record in records if record.status == "ambiguous"],
    )
    _write_records_file(
        project.root / "knowledge" / "contradictions.jsonl",
        [record for record in records if record.status == "contradicted"],
    )
    ledger = "".join(json.dumps(dict(row), sort_keys=True) + "\n" for row in links)
    (project.root / "knowledge" / "evidence-ledger.jsonl").write_text(ledger)

    by_video: dict[str, list[KnowledgeRecord]] = {}
    for record in records:
        for video_id in sorted({reference.video_id for reference in record.evidence}):
            by_video.setdefault(video_id, []).append(record)
    by_video_dir = project.root / "knowledge" / "by-video"
    by_video_dir.mkdir(exist_ok=True)
    for video_id, items in by_video.items():
        stem = re.sub(r"[^A-Za-z0-9._-]", "_", video_id)
        payload = {
            "video_id": video_id,
            "knowledge_count": len(items),
            "records": [item.model_dump(mode="json") for item in items],
        }
        (by_video_dir / f"{stem}.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n"
        )
        video_lines = [f"# Knowledge from {video_id}", ""]
        for item in items:
            video_lines.extend(_record_markdown(item, video_id=video_id))
        (by_video_dir / f"{stem}.md").write_text("\n".join(video_lines) + "\n")

    type_counts = Counter(record.type for record in records)
    attribution_counts = Counter(record.attribution.value for record in records)
    status_counts = Counter(record.status for record in records)
    lines = [
        "# Creator Intelligence Playbook",
        "",
        f"This playbook contains all validated, evidence-linked knowledge records produced "
        f"from {len(by_video)} processed videos.",
        "",
        "## Index",
        "",
        f"- Knowledge records: {len(records)}",
        f"- Videos represented: {len(by_video)}",
        f"- Types: {dict(sorted(type_counts.items()))}",
        f"- Attribution: {dict(sorted(attribution_counts.items()))}",
        f"- Status: {dict(sorted(status_counts.items()))}",
        "",
    ]
    headings = {
        "principle": "Principles",
        "rule": "Rules",
        "workflow": "Workflows",
        "formula": "Formulas",
        "tool": "Tools",
        "warning": "Warnings",
        "exception": "Exceptions",
        "example": "Examples",
        "claim": "Claims",
    }
    for record_type, heading in headings.items():
        items = [record for record in records if record.type == record_type]
        if not items:
            continue
        lines.extend([f"## {heading}", ""])
        for item in items:
            lines.extend(_record_markdown(item))
    lines.extend(
        [
            "## Interpretation limits",
            "",
            "- Creator-explicit and creator-demonstrated items report what the "
            "creator said or showed; they are not independent validation.",
            "- Claims about results, profitability, or outcomes remain claims even "
            "when clearly stated.",
            "- Ambiguous and contradicted records should be reviewed before they "
            "guide implementation or decisions.",
            "",
        ]
    )
    playbook = "\n".join(lines) + "\n"
    (project.root / "knowledge" / "creator-playbook.md").write_text(playbook)
    (project.root / "knowledge" / "knowledge-base.md").write_text(playbook)

    graph_nodes: list[dict[str, Any]] = []
    graph_edges: list[dict[str, str]] = []
    seen_videos: set[str] = set()
    seen_evidence: set[str] = set()
    for record in records:
        graph_nodes.append(
            {
                "id": record.knowledge_id,
                "kind": "knowledge",
                "type": record.type,
                "title": record.title,
                "status": record.status,
            }
        )
        for reference in record.evidence:
            if reference.video_id not in seen_videos:
                graph_nodes.append({"id": reference.video_id, "kind": "video"})
                seen_videos.add(reference.video_id)
            if reference.evidence_id not in seen_evidence:
                graph_nodes.append(
                    {
                        "id": reference.evidence_id,
                        "kind": "evidence",
                        "video_id": reference.video_id,
                        "source_url": str(reference.source_url)
                        if reference.source_url
                        else None,
                        "timestamp_start": reference.timestamp_start,
                        "timestamp_end": reference.timestamp_end,
                        "excerpt": reference.excerpt,
                    }
                )
                seen_evidence.add(reference.evidence_id)
                graph_edges.append(
                    {
                        "from": reference.evidence_id,
                        "to": reference.video_id,
                        "relation": "from_video",
                    }
                )
            graph_edges.append(
                {
                    "from": record.knowledge_id,
                    "to": reference.evidence_id,
                    "relation": "supported_by",
                }
            )
    graph = {"nodes": graph_nodes, "edges": graph_edges}
    (project.root / "knowledge" / "knowledge-graph.json").write_text(
        json.dumps(graph, indent=2, sort_keys=True) + "\n"
    )


def _write_records_file(path: Path, records: list[KnowledgeRecord]) -> None:
    content = "".join(
        json.dumps(record.model_dump(mode="json"), sort_keys=True) + "\n"
        for record in records
    )
    path.write_text(content)


def _record_markdown(
    record: KnowledgeRecord, video_id: str | None = None
) -> list[str]:
    lines = [f"### {record.title}", "", record.description, ""]
    lines.append(
        f"- Type: `{record.type}` · Attribution: `{record.attribution}` · "
        f"Status: `{record.status}` · Confidence: {record.confidence:.0%}"
    )
    if record.conditions:
        lines.append(f"- Conditions: {'; '.join(record.conditions)}")
    if record.inputs:
        lines.append(f"- Inputs: {'; '.join(record.inputs)}")
    if record.outputs:
        lines.append(f"- Outputs: {'; '.join(record.outputs)}")
    if record.steps:
        lines.extend(["- Steps:", *[f"  {i}. {step}" for i, step in enumerate(record.steps, 1)]])
    if record.exceptions:
        lines.append(f"- Exceptions: {'; '.join(record.exceptions)}")
    if record.dependencies:
        lines.append(f"- Dependencies: {'; '.join(record.dependencies)}")
    if record.formal_expression is not None:
        expression = (
            record.formal_expression
            if isinstance(record.formal_expression, str)
            else json.dumps(record.formal_expression, sort_keys=True)
        )
        lines.append(f"- Formal expression: `{expression}`")
    references = [
        reference
        for reference in record.evidence
        if video_id is None or reference.video_id == video_id
    ]
    lines.append("- Evidence:")
    for reference in references:
        source = (
            f"[source]({reference.source_url})"
            if reference.source_url
            else "source unavailable"
        )
        lines.append(
            f"  - {source} · `{reference.video_id}` · "
            f"{reference.timestamp_start:.1f}–{reference.timestamp_end:.1f}s — "
            f"{reference.excerpt}"
        )
    lines.extend([f"- Knowledge ID: `{record.knowledge_id}`", ""])
    return lines
