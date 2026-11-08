from __future__ import annotations

from collections import defaultdict
from typing import Any

from video_software_compiler.models import ExecutableRule


def conflicting_thresholds(rules: list[ExecutableRule]) -> list[dict[str, Any]]:
    """Return conservative candidates; differing contexts may explain every candidate."""
    groups: dict[tuple[str, str, str], list[tuple[ExecutableRule, Any]]] = defaultdict(list)
    for rule in rules:
        for condition in rule.conditions:
            if condition.operator in {
                "greater_than",
                "greater_than_or_equal",
                "less_than",
                "less_than_or_equal",
                "equals",
            } and isinstance(condition.right, int | float):
                key = (rule.name.casefold().strip(), condition.left, condition.operator)
                groups[key].append((rule, condition.right))
    candidates = []
    for (name, left, operator), items in sorted(groups.items()):
        values = {value for _, value in items}
        if len(values) < 2:
            continue
        candidates.append(
            {
                "type": "possible_contradiction",
                "name": name,
                "field": left,
                "operator": operator,
                "values": sorted(values),
                "rule_versions": [f"{rule.rule_id}@{rule.version}" for rule, _ in items],
                "language": (
                    "Different contexts may explain this difference. Human review recommended."
                ),
            }
        )
    return candidates
