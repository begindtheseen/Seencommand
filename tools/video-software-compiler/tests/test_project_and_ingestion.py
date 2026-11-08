from pathlib import Path

from video_software_compiler.constants import EXPERIMENT_FILES, PROJECT_DIRECTORIES
from video_software_compiler.models import ProjectConfig
from video_software_compiler.project import Project
from video_software_compiler.providers.local import LocalIngestionProvider


def make_project(tmp_path: Path) -> Project:
    project = Project("demo", tmp_path)
    project.create(ProjectConfig(name="demo", source="local"))
    return project


def test_project_directory_model(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    assert all((project.root / directory).is_dir() for directory in PROJECT_DIRECTORIES)
    assert (project.root / "state.sqlite").exists()
    assert all((project.root / "experiments" / filename).exists() for filename in EXPERIMENT_FILES)


def test_local_ingestion_is_content_deduplicated(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    imports = tmp_path / "imports"
    imports.mkdir()
    (imports / "one.mp4").write_bytes(b"same")
    (imports / "two.mp4").write_bytes(b"same")
    result = LocalIngestionProvider(project).ingest(imports)
    assert result.discovered == 2
    assert result.added == 1
    assert result.updated == 1
    assert project.database.counts()["sources"] == 1


def test_manual_transcript_ingestion(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    transcript = tmp_path / "manual.srt"
    transcript.write_text("1\n00:00:00,000 --> 00:00:01,000\nHello\n")
    result = LocalIngestionProvider(project).ingest(transcript)
    assert result.added == 1
    assert len(list((project.root / "transcripts").glob("*.srt"))) == 1
    assert project.database.search("Hello")[0]["kind"] == "source"


def test_unsupported_files_are_ignored(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    path = tmp_path / "ignored.exe"
    path.write_bytes(b"no")
    result = LocalIngestionProvider(project).ingest(path)
    assert result.discovered == 0
