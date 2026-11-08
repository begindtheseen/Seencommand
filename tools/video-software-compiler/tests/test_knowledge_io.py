import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from video_software_compiler.knowledge_io import import_knowledge_batch
from video_software_compiler.models import (
    EvidenceStatement,
    EvidenceType,
    ProjectConfig,
)
from video_software_compiler.project import Project


def prepared_project(tmp_path: Path) -> Project:
    project = Project("knowledge", tmp_path)
    project.create(ProjectConfig(name="knowledge", source="local"))
    project.database.upsert_source(
        {
            "source_id": "v1",
            "provider": "local",
            "external_id": "v1",
            "media_type": "video",
            "caption": "",
            "retrieved_at": datetime.now(UTC).isoformat(),
            "metadata": {},
        }
    )
    project.database.save_evidence(
        EvidenceStatement(
            evidence_id="e1",
            video_id="v1",
            timestamp_start=1,
            timestamp_end=2,
            evidence_type=EvidenceType.SPOKEN,
            content="Use context",
            confidence=0.9,
        )
    )
    return project


def record(evidence_id: str = "e1") -> dict[str, object]:
    return {
        "knowledge_id": "k1",
        "type": "principle",
        "title": "Context",
        "description": "Use context before acting",
        "inputs": [],
        "outputs": [],
        "conditions": [],
        "steps": [],
        "exceptions": [],
        "dependencies": [],
        "evidence": [
            {
                "evidence_id": evidence_id,
                "video_id": "v1",
                "timestamp_start": 1,
                "timestamp_end": 2,
                "excerpt": "Use context",
            }
        ],
        "confidence": 0.8,
        "attribution": "creator_explicit",
        "status": "probable",
    }


def test_import_knowledge_validates_and_writes_canonical_files(tmp_path: Path) -> None:
    project = prepared_project(tmp_path)
    batch = tmp_path / "batch.json"
    batch.write_text(json.dumps({"batch_id": "b1", "records": [record()]}))
    result = import_knowledge_batch(project, batch)
    assert result["imported"] == 1
    assert project.database.counts()["knowledge"] == 1
    assert '"knowledge_id": "k1"' in (project.root / "knowledge/principles.jsonl").read_text()
    assert '"evidence_id": "e1"' in (project.root / "knowledge/evidence-ledger.jsonl").read_text()
    playbook = (project.root / "knowledge/creator-playbook.md").read_text()
    assert "Use context before acting" in playbook
    assert "1.0–2.0s" in playbook
    assert "`v1`" in playbook
    assert (project.root / "knowledge/by-video/v1.json").exists()
    assert "Context" in (project.root / "knowledge/by-video/v1.md").read_text()
    graph = json.loads((project.root / "knowledge/knowledge-graph.json").read_text())
    assert {node["id"] for node in graph["nodes"]} >= {"k1", "e1", "v1"}


def test_import_rejects_unknown_evidence_without_partial_write(tmp_path: Path) -> None:
    project = prepared_project(tmp_path)
    batch = tmp_path / "bad.json"
    batch.write_text(json.dumps({"records": [record("missing")]}))
    with pytest.raises(ValueError, match="unknown evidence_id"):
        import_knowledge_batch(project, batch)
    assert project.database.counts()["knowledge"] == 0


def test_import_rejects_duplicate_evidence_without_partial_write(tmp_path: Path) -> None:
    project = prepared_project(tmp_path)
    duplicate = record()
    duplicate["evidence"] = duplicate["evidence"] * 2
    batch = tmp_path / "duplicate.json"
    batch.write_text(json.dumps({"records": [duplicate]}))
    with pytest.raises(ValueError, match="duplicate evidence_id"):
        import_knowledge_batch(project, batch)
    assert project.database.counts()["knowledge"] == 0


def test_skip_invalid_imports_the_valid_records_and_reports_rejects(tmp_path: Path) -> None:
    # The 0-knowledge bug: one bad record used to discard the whole batch
    # (and the job stopped there).
    project = prepared_project(tmp_path)
    good = record()
    bad = record("missing")
    bad["knowledge_id"] = "k2"
    not_a_record = {"knowledge_id": "k3", "type": "vibe"}
    batch = tmp_path / "mixed.json"
    batch.write_text(json.dumps({"records": [good, bad, not_a_record]}))
    result = import_knowledge_batch(project, batch, skip_invalid=True)
    assert result["imported"] == 1
    assert result["knowledge_ids"] == ["k1"]
    assert [r["knowledge_id"] for r in result["rejected"]] == ["k2", "k3"]
    assert "none of its evidence references exist" in result["rejected"][0]["reason"]
    assert project.database.counts()["knowledge"] == 1


def test_skip_invalid_repairs_copied_timestamps_from_the_database(tmp_path: Path) -> None:
    project = prepared_project(tmp_path)
    drifted = record()
    # A model's copy error; the evidence_id is the truth.
    drifted["evidence"][0]["timestamp_start"] = 1.04
    drifted["evidence"][0]["timestamp_end"] = 2.5
    batch = tmp_path / "drift.json"
    batch.write_text(json.dumps({"records": [drifted]}))
    with pytest.raises(ValueError, match="timestamps do not match"):
        import_knowledge_batch(project, batch)  # strict mode is unchanged
    result = import_knowledge_batch(project, batch, skip_invalid=True)
    assert result["imported"] == 1 and result["repaired_references"] == 1
    stored = (project.root / "knowledge/principles.jsonl").read_text()
    assert '"timestamp_start": 1.0' in stored and '"timestamp_end": 2.0' in stored


def test_skip_invalid_still_fails_when_nothing_is_valid(tmp_path: Path) -> None:
    project = prepared_project(tmp_path)
    batch = tmp_path / "allbad.json"
    batch.write_text(json.dumps({"records": [record("missing")]}))
    with pytest.raises(ValueError, match="No valid knowledge records"):
        import_knowledge_batch(project, batch, skip_invalid=True)
    assert project.database.counts()["knowledge"] == 0
