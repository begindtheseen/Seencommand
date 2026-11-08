from datetime import UTC, datetime, timedelta
from pathlib import Path

from video_software_compiler.database import StateDatabase
from video_software_compiler.models import (
    Attribution,
    EvidenceReference,
    EvidenceStatement,
    EvidenceType,
    ExecutableRule,
    KnowledgeRecord,
    RequirementTrace,
    RuleAction,
    RuleCondition,
)


def source(source_id: str = "local-a", caption: str = "risk management") -> dict[str, object]:
    return {
        "source_id": source_id,
        "provider": "local",
        "external_id": source_id,
        "media_type": "video",
        "caption": caption,
        "retrieved_at": datetime.now(UTC).isoformat(),
        "metadata": {},
    }


def test_video_deduplication_preserves_one_record(tmp_path: Path) -> None:
    database = StateDatabase(tmp_path / "state.sqlite")
    database.initialize()
    assert database.upsert_source(source()) is True
    assert database.upsert_source(source(caption="updated caption")) is False
    assert database.counts()["sources"] == 1


def test_fts_search(tmp_path: Path) -> None:
    database = StateDatabase(tmp_path / "state.sqlite")
    database.initialize()
    database.upsert_source(source())
    results = database.search("risk")
    assert results[0]["document_id"] == "local-a"


def test_interrupted_run_resume(tmp_path: Path) -> None:
    database = StateDatabase(tmp_path / "state.sqlite")
    database.initialize()
    database.start_stage("preprocess", "v1")
    with database.connect() as connection:
        connection.execute(
            "UPDATE stage_runs SET started_at=?",
            ((datetime.now(UTC) - timedelta(days=1)).isoformat(),),
        )
    assert database.recover_stale(timedelta(minutes=1)) == 1
    with database.connect() as connection:
        status = connection.execute("SELECT status FROM stage_runs").fetchone()[0]
    assert status == "retryable_failure"


def test_missing_source_returns_none(tmp_path: Path) -> None:
    database = StateDatabase(tmp_path / "state.sqlite")
    database.initialize()
    assert database.get_source("missing-video") is None


def test_rule_requirement_and_evidence_traceability(tmp_path: Path) -> None:
    database = StateDatabase(tmp_path / "state.sqlite")
    database.initialize()
    database.upsert_source(source(source_id="v1"))
    evidence = EvidenceStatement(
        evidence_id="e1",
        video_id="v1",
        timestamp_start=12,
        timestamp_end=14,
        evidence_type=EvidenceType.SPOKEN,
        content="Keep risk below two",
        confidence=0.9,
    )
    database.save_evidence(evidence)
    database.save_knowledge(
        KnowledgeRecord(
            knowledge_id="k1",
            type="rule",
            title="Risk cap",
            description="Risk remains below two",
            evidence=[
                EvidenceReference(
                    evidence_id="e1",
                    video_id="v1",
                    timestamp_start=12,
                    timestamp_end=14,
                )
            ],
            confidence=0.9,
            attribution=Attribution.CREATOR_EXPLICIT,
            status="confirmed",
        )
    )
    database.save_rule(
        ExecutableRule(
            rule_id="r1",
            name="Risk cap",
            source=Attribution.CREATOR_EXPLICIT,
            conditions=[RuleCondition(left="risk", operator="less_than", right=2)],
            action=RuleAction(type="allow"),
            confidence=0.9,
            evidence_ids=["e1"],
        )
    )
    database.save_requirement(
        RequirementTrace(
            requirement_id="req1",
            title="Enforce cap",
            origin="source_derived",
            evidence_ids=["e1"],
            knowledge_ids=["k1"],
            rule_ids=["r1"],
            feature_ids=["feature1"],
            test_ids=["test1"],
        )
    )
    assert database.counts() == {
        "sources": 1,
        "evidence": 1,
        "knowledge": 1,
        "rules": 1,
        "requirements": 1,
    }
    assert database.search("risk")[0]["kind"] in {"source", "evidence", "knowledge", "rule"}
