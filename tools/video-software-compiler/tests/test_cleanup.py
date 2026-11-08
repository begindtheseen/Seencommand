import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from video_software_compiler.cleanup import (
    CONFIRMATION_PHRASE,
    build_cleanup_plan,
    execute_cleanup,
)
from video_software_compiler.models import ProjectConfig
from video_software_compiler.project import Project


def project_with_source(tmp_path: Path) -> tuple[Project, Path]:
    project = Project("cleanup", tmp_path)
    project.create(ProjectConfig(name="cleanup", source="instagram", username="creator"))
    raw = project.root / "videos" / "post" / "video.mp4"
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"raw-video")
    project.database.upsert_source(
        {
            "source_id": "instagram-post",
            "provider": "instaloader",
            "external_id": "post",
            "media_type": "video",
            "caption": "example",
            "published_at": datetime.now(UTC).isoformat(),
            "retrieved_at": datetime.now(UTC).isoformat(),
            "metadata": {},
            "local_path": str(raw),
        }
    )
    return project, raw


def complete_evidence(project: Project) -> Path:
    package = project.root / "evidence" / "instagram-post"
    package.mkdir(parents=True)
    (package / "evidence.json").write_text(
        json.dumps(
            {
                "evidence_coverage": {
                    "transcript": True,
                    "ocr": True,
                    "baseline_frames": 5,
                }
            }
        )
    )
    (package / "transcript.json").write_text(json.dumps({"status": "complete"}))
    (package / "ocr.json").write_text(json.dumps({"status": "complete"}))
    (package / "visual-events.json").write_text(
        json.dumps({"scene_detection": {"status": "complete", "count": 0}})
    )
    (package / "frames").mkdir()
    (package / "frames" / "selected.jpg").write_bytes(b"preserve")
    return package


def test_cleanup_refuses_incomplete_extraction(tmp_path: Path) -> None:
    project, raw = project_with_source(tmp_path)
    plan = build_cleanup_plan(project)
    assert plan.ready is False
    assert any("evidence package is missing" in blocker for blocker in plan.blockers)
    with pytest.raises(RuntimeError):
        execute_cleanup(project, CONFIRMATION_PHRASE)
    assert raw.exists()


def test_cleanup_requires_exact_confirmation_and_preserves_evidence(tmp_path: Path) -> None:
    project, raw = project_with_source(tmp_path)
    package = complete_evidence(project)
    plan = build_cleanup_plan(project)
    assert plan.ready is True
    with pytest.raises(ValueError):
        execute_cleanup(project, "yes")
    assert raw.exists()

    execute_cleanup(project, CONFIRMATION_PHRASE)
    assert not raw.exists()
    assert (package / "frames" / "selected.jpg").exists()
    source = project.database.get_source("instagram-post")
    assert source is not None
    assert source["availability"] == "evidence_only"
    assert (project.root / "reports" / "raw-media-cleanup.json").exists()


def test_latest_scope_preserves_but_excludes_older_records(tmp_path: Path) -> None:
    project, _ = project_with_source(tmp_path)
    for index in range(1, 4):
        project.database.upsert_source(
            {
                "source_id": f"instagram-old-{index}",
                "provider": "instaloader",
                "external_id": f"old-{index}",
                "media_type": "video",
                "caption": "",
                "published_at": (datetime.now(UTC) - timedelta(days=index)).isoformat(),
                "retrieved_at": datetime.now(UTC).isoformat(),
                "metadata": {},
            }
        )
    scope = project.database.set_latest_source_scope("instaloader", 2)
    assert scope == {"in_scope": 2, "out_of_scope": 2}
    assert project.database.counts()["sources"] == 4
