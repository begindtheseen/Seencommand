from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


def utc_now() -> datetime:
    return datetime.now(UTC)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class Attribution(StrEnum):
    CREATOR_EXPLICIT = "creator_explicit"
    CREATOR_DEMONSTRATED = "creator_demonstrated"
    SYSTEM_INFERRED = "system_inferred"
    INDEPENDENT_IMPROVEMENT = "independent_improvement"


class EvidenceType(StrEnum):
    SPOKEN = "spoken"
    CAPTION = "caption"
    VISUAL = "visual"
    OCR = "ocr"
    DEMONSTRATION = "demonstration"


class EvidenceStatement(StrictModel):
    evidence_id: str = Field(min_length=1)
    video_id: str = Field(min_length=1)
    source_url: HttpUrl | None = None
    published_at: datetime | None = None
    timestamp_start: float = Field(ge=0)
    timestamp_end: float = Field(ge=0)
    evidence_type: EvidenceType
    content: str = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def timestamps_are_ordered(self) -> EvidenceStatement:
        if self.timestamp_end < self.timestamp_start:
            raise ValueError("timestamp_end must be >= timestamp_start")
        return self


class EvidenceReference(StrictModel):
    evidence_id: str = Field(min_length=1)
    video_id: str = Field(min_length=1)
    source_url: HttpUrl | None = None
    timestamp_start: float = Field(ge=0)
    timestamp_end: float = Field(ge=0)
    excerpt: str = ""


class TranscriptSegment(StrictModel):
    segment_id: str = Field(min_length=1)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str = Field(min_length=1)
    language: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def segment_timestamps_are_ordered(self) -> TranscriptSegment:
        if self.end < self.start:
            raise ValueError("end must be >= start")
        return self


class KnowledgeRecord(StrictModel):
    knowledge_id: str = Field(min_length=1)
    type: Literal[
        "principle",
        "rule",
        "workflow",
        "formula",
        "tool",
        "claim",
        "example",
        "exception",
        "warning",
    ]
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    formal_expression: str | dict[str, Any] | None = None
    inputs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)
    conditions: list[str] = Field(default_factory=list)
    steps: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)
    dependencies: list[str] = Field(default_factory=list)
    evidence: list[EvidenceReference] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    attribution: Attribution
    status: Literal["confirmed", "probable", "ambiguous", "contradicted", "deprecated"]

    @model_validator(mode="after")
    def source_attributions_need_evidence(self) -> KnowledgeRecord:
        source_attributions = {
            Attribution.CREATOR_EXPLICIT,
            Attribution.CREATOR_DEMONSTRATED,
        }
        if self.attribution in source_attributions and not self.evidence:
            raise ValueError("creator-attributed knowledge requires evidence")
        return self


class RuleCondition(StrictModel):
    left: str
    operator: Literal[
        "equals",
        "not_equals",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
        "contains",
        "crosses_above",
        "crosses_below",
    ]
    right: str | int | float | bool


class RuleAction(StrictModel):
    type: str = Field(min_length=1)
    value: Any = None


class ExecutableRule(StrictModel):
    rule_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    version: int = Field(default=1, ge=1)
    source: Attribution
    conditions: list[RuleCondition]
    action: RuleAction
    exceptions: list[RuleCondition] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)
    supersedes: str | None = None

    @model_validator(mode="after")
    def source_rules_need_evidence(self) -> ExecutableRule:
        if (
            self.source
            in {
                Attribution.CREATOR_EXPLICIT,
                Attribution.CREATOR_DEMONSTRATED,
            }
            and not self.evidence_ids
        ):
            raise ValueError("creator-attributed rules require evidence_ids")
        return self


class RequirementTrace(StrictModel):
    requirement_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    origin: Literal[
        "source_derived",
        "system_inferred",
        "independent_improvement",
        "technical_requirement",
        "safety_requirement",
    ]
    evidence_ids: list[str] = Field(default_factory=list)
    knowledge_ids: list[str] = Field(default_factory=list)
    rule_ids: list[str] = Field(default_factory=list)
    feature_ids: list[str] = Field(default_factory=list)
    test_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def source_requirements_are_traceable(self) -> RequirementTrace:
        if self.origin == "source_derived" and not self.evidence_ids:
            raise ValueError("source-derived requirements require evidence_ids")
        return self


class ProjectConfig(StrictModel):
    name: str
    source: Literal["instagram", "local", "mixed"]
    username: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    completeness_statement: str = "Completeness could not be independently verified"
    schema_version: int = 1
