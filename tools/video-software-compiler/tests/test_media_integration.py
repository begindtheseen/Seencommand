import json
import shutil
import subprocess
from pathlib import Path

import pytest

from video_software_compiler.media import preprocess_project
from video_software_compiler.models import ProjectConfig
from video_software_compiler.project import Project
from video_software_compiler.providers.local import LocalIngestionProvider


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="FFmpeg is not installed",
)
def test_preprocess_video_without_audio_records_limitation(tmp_path: Path) -> None:
    video = tmp_path / "silent.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x240:d=1.2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(video),
        ],
        check=True,
    )
    project = Project("media", tmp_path / "projects")
    project.create(ProjectConfig(name="media", source="local"))
    result = LocalIngestionProvider(project).ingest(video)
    assert result.added == 1

    preprocessing = preprocess_project(project)
    assert preprocessing == {"complete": 1, "skipped": 0, "failed": 0}
    evidence_files = list((project.root / "evidence").glob("*/evidence.json"))
    evidence = json.loads(evidence_files[0].read_text())
    assert evidence["evidence_coverage"]["audio"] is False
    assert "Source video has no audio stream." in evidence["unresolved_questions"]
    assert len(list(evidence_files[0].parent.glob("frames/*.jpg"))) >= 3
    visual = json.loads((evidence_files[0].parent / "visual-events.json").read_text())
    assert visual["scene_detection"]["status"] == "complete"
