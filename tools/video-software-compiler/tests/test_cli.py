from pathlib import Path

from pytest import MonkeyPatch
from typer.testing import CliRunner

from video_software_compiler.cli import app

runner = CliRunner()


def test_cli_exposes_required_commands() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in (
        "setup",
        "create-project",
        "ingest",
        "preprocess",
        "refresh-visuals",
        "extract-knowledge",
        "import-knowledge",
        "reconcile",
        "build-domain-model",
        "generate-blueprint",
        "validate-blueprint",
        "generate-build-package",
        "status",
        "search",
        "export-claude-bundle",
        "export-codex-bundle",
        "cleanup-media",
        "set-scope",
    ):
        assert command in result.stdout


def test_create_project_and_status_commands(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("VSC_DATA_ROOT", str(tmp_path))
    created = runner.invoke(app, ["create-project", "--name", "cli-demo", "--source", "local"])
    assert created.exit_code == 0
    status = runner.invoke(app, ["status", "--project", "cli-demo"])
    assert status.exit_code == 0
    assert '"sources": 0' in status.stdout
