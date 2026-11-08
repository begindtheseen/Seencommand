import pytest
from pydantic import ValidationError

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


def reference() -> EvidenceReference:
    return EvidenceReference(
        evidence_id="e1",
        video_id="v1",
        timestamp_start=1,
        timestamp_end=2,
        excerpt="Use the threshold",
    )


def test_evidence_rejects_reversed_timestamps() -> None:
    with pytest.raises(ValidationError):
        EvidenceStatement(
            evidence_id="e1",
            video_id="v1",
            timestamp_start=2,
            timestamp_end=1,
            evidence_type=EvidenceType.SPOKEN,
            content="Example",
            confidence=0.9,
        )


def test_creator_attribution_requires_evidence() -> None:
    with pytest.raises(ValidationError):
        KnowledgeRecord(
            knowledge_id="k1",
            type="rule",
            title="Rule",
            description="A claimed rule",
            confidence=0.7,
            attribution=Attribution.CREATOR_EXPLICIT,
            status="probable",
        )


def test_inference_can_be_explicitly_unsupported() -> None:
    record = KnowledgeRecord(
        knowledge_id="k1",
        type="rule",
        title="Inference",
        description="An openly labeled inference",
        confidence=0.3,
        attribution=Attribution.SYSTEM_INFERRED,
        status="ambiguous",
    )
    assert record.evidence == []


def test_rule_versioning_and_evidence_link() -> None:
    rule = ExecutableRule(
        rule_id="r1",
        name="Threshold",
        version=2,
        source=Attribution.CREATOR_EXPLICIT,
        conditions=[RuleCondition(left="score", operator="greater_than", right=5)],
        action=RuleAction(type="emit", value="signal"),
        confidence=0.8,
        evidence_ids=["e1"],
        supersedes="r1@1",
    )
    assert rule.version == 2
    assert rule.evidence_ids == ["e1"]


def test_source_requirement_requires_traceability() -> None:
    with pytest.raises(ValidationError):
        RequirementTrace(requirement_id="req1", title="Feature", origin="source_derived")


def test_malformed_model_output_is_rejected() -> None:
    with pytest.raises(ValidationError):
        KnowledgeRecord.model_validate_json('{"knowledge_id": 42, "invented": true}')


def test_supported_attribution_labels_are_distinct() -> None:
    assert Attribution.CREATOR_DEMONSTRATED != Attribution.INDEPENDENT_IMPROVEMENT
    assert reference().evidence_id == "e1"
