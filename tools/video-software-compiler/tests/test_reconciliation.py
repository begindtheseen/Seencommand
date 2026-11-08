from video_software_compiler.models import (
    Attribution,
    ExecutableRule,
    RuleAction,
    RuleCondition,
)
from video_software_compiler.reconciliation import conflicting_thresholds


def rule(version: int, threshold: int) -> ExecutableRule:
    return ExecutableRule(
        rule_id="risk-rule",
        name="Risk threshold",
        version=version,
        source=Attribution.CREATOR_EXPLICIT,
        conditions=[RuleCondition(left="risk", operator="less_than_or_equal", right=threshold)],
        action=RuleAction(type="allow"),
        confidence=0.8,
        evidence_ids=[f"e{version}"],
    )


def test_conflicting_thresholds_preserve_historical_versions() -> None:
    candidates = conflicting_thresholds([rule(1, 2), rule(2, 1)])
    assert candidates[0]["type"] == "possible_contradiction"
    assert candidates[0]["values"] == [1, 2]
    assert candidates[0]["rule_versions"] == ["risk-rule@1", "risk-rule@2"]


def test_equal_thresholds_are_not_contradictions() -> None:
    assert conflicting_thresholds([rule(1, 2), rule(2, 2)]) == []
