from __future__ import annotations

import json
from contextlib import suppress
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from video_software_compiler.project import Project

CONFIRMATION_PHRASE = "DELETE-RAW-MEDIA"


@dataclass(frozen=True)
class CleanupPlan:
    ready: bool
    file_count: int
    bytes_to_delete: int
    paths: list[str]
    blockers: list[str]
    preserved: list[str]


def build_cleanup_plan(project: Project) -> CleanupPlan:
    """Plan removal of reproducible raw media while preserving derived evidence."""
    project.require()
    blockers: list[str] = []
    with project.database.connect() as connection:
        sources = [
            dict(row)
            for row in connection.execute(
                """
                SELECT source_id, media_type, local_path FROM sources
                WHERE media_type IN ('video', 'carousel_video')
                  AND availability='available'
                  AND in_scope=1
                ORDER BY source_id
                """
            ).fetchall()
        ]
    if not sources:
        blockers.append("No downloaded video source records exist.")
    for source in sources:
        video_id = source["source_id"]
        package = project.root / "evidence" / video_id
        evidence_path = package / "evidence.json"
        transcript_path = package / "transcript.json"
        ocr_path = package / "ocr.json"
        visual_path = package / "visual-events.json"
        if not evidence_path.exists():
            blockers.append(f"{video_id}: evidence package is missing")
            continue
        try:
            evidence = json.loads(evidence_path.read_text())
            transcript = json.loads(transcript_path.read_text())
            ocr = json.loads(ocr_path.read_text())
            visual = json.loads(visual_path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            blockers.append(f"{video_id}: evidence package is unreadable ({error})")
            continue
        coverage = evidence.get("evidence_coverage", {})
        if transcript.get("status") not in {"complete", "unavailable_no_audio"} or not coverage.get(
            "transcript"
        ):
            blockers.append(f"{video_id}: transcription is not complete")
        if ocr.get("status") != "complete" or not coverage.get("ocr"):
            blockers.append(f"{video_id}: OCR pass is not complete")
        if not coverage.get("baseline_frames"):
            blockers.append(f"{video_id}: required timestamped frames are missing")
        if visual.get("scene_detection", {}).get("status") != "complete":
            blockers.append(f"{video_id}: scene-change detection is not complete")

    roots = (project.root / "videos", project.root / "audio")
    candidates = sorted(
        path
        for root in roots
        if root.exists()
        for path in root.rglob("*")
        if path.is_file() or path.is_symlink()
    )
    total_bytes = sum(path.stat().st_size for path in candidates if path.is_file())
    return CleanupPlan(
        ready=not blockers and bool(candidates),
        file_count=len(candidates),
        bytes_to_delete=total_bytes,
        paths=[str(path) for path in candidates],
        blockers=blockers,
        preserved=[
            "project.json and state.sqlite",
            "source manifests and links",
            "transcripts and timestamped segments",
            "selected frames and visual event records",
            "OCR and evidence packets",
            "knowledge, specifications, blueprints, reports, and bundles",
        ],
    )


def execute_cleanup(project: Project, confirmation: str) -> CleanupPlan:
    plan = build_cleanup_plan(project)
    if not plan.ready:
        raise RuntimeError("Cleanup refused because extraction is incomplete or no media exists")
    if confirmation != CONFIRMATION_PHRASE:
        raise ValueError(f"Confirmation must exactly equal {CONFIRMATION_PHRASE}")
    report_path = project.root / "reports" / "raw-media-cleanup.json"
    report = {
        "planned_at": datetime.now(UTC).isoformat(),
        "confirmation_phrase_received": True,
        "plan": asdict(plan),
        "status": "in_progress",
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    for raw_path in plan.paths:
        path = Path(raw_path)
        if not path.is_relative_to(project.root):
            raise RuntimeError(f"Refusing to delete path outside project: {path}")
        path.unlink(missing_ok=True)
    for root in (project.root / "videos", project.root / "audio"):
        for directory in sorted((path for path in root.rglob("*") if path.is_dir()), reverse=True):
            with suppress(OSError):
                directory.rmdir()
    with project.database.connect() as connection:
        connection.execute(
            """
            UPDATE sources SET local_path=NULL, availability='evidence_only'
            WHERE media_type IN ('video', 'carousel_video')
            """
        )
    report["status"] = "complete"
    report["completed_at"] = datetime.now(UTC).isoformat()
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return plan
