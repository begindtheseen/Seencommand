from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal, cast

import typer
from rich.console import Console
from rich.table import Table

from video_software_compiler.cleanup import (
    CONFIRMATION_PHRASE,
    build_cleanup_plan,
    execute_cleanup,
)
from video_software_compiler.knowledge_io import import_knowledge_batch
from video_software_compiler.media import preprocess_project, refresh_visual_evidence
from video_software_compiler.models import ProjectConfig
from video_software_compiler.project import Project
from video_software_compiler.providers.instagram import InstaloaderProvider
from video_software_compiler.providers.local import LocalIngestionProvider
from video_software_compiler.validation import run_setup_checks
from video_software_compiler.workflow import (
    build_domain_model as build_domain_model_files,
)
from video_software_compiler.workflow import (
    export_bundle,
)
from video_software_compiler.workflow import (
    extract_knowledge as extract_knowledge_records,
)
from video_software_compiler.workflow import (
    generate_blueprint as generate_blueprint_files,
)
from video_software_compiler.workflow import (
    generate_build_package as make_build_package,
)
from video_software_compiler.workflow import (
    reconcile as reconcile_records,
)
from video_software_compiler.workflow import (
    validate_blueprint as validate_blueprint_files,
)

app = typer.Typer(
    name="video-software-compiler",
    help="Compile local video evidence into traceable software blueprints.",
    no_args_is_help=True,
)
console = Console()


def _root() -> Path:
    configured = os.environ.get("VSC_DATA_ROOT")
    return Path(configured).expanduser() if configured else Path.cwd() / "data" / "projects"


def _project(name: str) -> Project:
    project = Project(name, _root())
    try:
        project.require()
    except (FileNotFoundError, RuntimeError) as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(1) from error
    return project


def _print_json(value: Any) -> None:
    console.print_json(json.dumps(value, default=str))


@app.command()
def setup() -> None:
    """Validate local, zero-metered-cost dependencies."""
    table = Table("Dependency", "Status", "Detail", "Requirement")
    failed_required = False
    for check in run_setup_checks():
        table.add_row(
            check.name,
            "OK" if check.ok else "MISSING",
            check.detail,
            "required" if check.required else "optional",
        )
        failed_required |= check.required and not check.ok
    console.print(table)
    console.print(
        "No paid API or cloud service is configured. Optional tools enable acquisition, OCR, "
        "and transcription."
    )
    if failed_required:
        raise typer.Exit(1)


@app.command("create-project")
def create_project(
    name: str = typer.Option(..., help="Stable project name."),
    source: str = typer.Option(..., help="instagram, local, or mixed"),
    username: str | None = typer.Option(None, help="Instagram username, without @."),
) -> None:
    """Create the complete durable project directory model."""
    try:
        source_type = cast(Literal["instagram", "local", "mixed"], source)
        config = ProjectConfig(name=name, source=source_type, username=username)
        project = Project(name, _root())
        project.create(config)
    except (ValueError, FileExistsError) as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(1) from error
    console.print(f"Created [green]{project.root}[/green]")


@app.command()
def ingest(
    project: str = typer.Option(..., help="Project name."),
    input_path: Path | None = typer.Option(None, "--input", help="Local file or directory."),
    session_user: str | None = typer.Option(None, help="Instaloader local session username."),
    no_copy: bool = typer.Option(False, help="Reference local imports instead of copying them."),
    limit: int = typer.Option(50, min=1, help="Maximum Instagram video posts (newest first)."),
    all_videos: bool = typer.Option(
        False, "--all-videos", help="Retrieve all accessible Instagram video posts."
    ),
) -> None:
    """Ingest accessible sources without arbitrary item or date limits."""
    target = _project(project)
    config = target.require()
    try:
        if input_path is not None:
            local_result = LocalIngestionProvider(target).ingest(input_path, copy_files=not no_copy)
            _print_json(local_result.__dict__)
        elif config.source in {"instagram", "mixed"} and config.username:
            instagram_result = InstaloaderProvider(target).ingest(
                config.username, session_user, None if all_videos else limit
            )
            _print_json(instagram_result)
        else:
            raise ValueError(
                "Local projects require --input PATH; Instagram projects require --username"
            )
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(1) from error


@app.command()
def preprocess(
    project: str = typer.Option(...),
    whisper_model: str = typer.Option(
        "base.en", help="Local faster-whisper model name or directory."
    ),
) -> None:
    """Extract audio, probe metadata, and baseline timestamped frames."""
    _print_json(preprocess_project(_project(project), whisper_model))


@app.command("refresh-visuals")
def refresh_visuals(
    project: str = typer.Option(...),
    scene_threshold: float = typer.Option(0.2, min=0.01, max=0.99),
) -> None:
    """Refresh scene-change frames and OCR without retranscribing audio."""
    _print_json(refresh_visual_evidence(_project(project), scene_threshold))


@app.command("extract-knowledge")
def extract_knowledge(project: str = typer.Option(...)) -> None:
    """Prepare evidence-backed knowledge extraction queues."""
    _print_json(extract_knowledge_records(_project(project)))


@app.command("import-knowledge")
def import_knowledge(
    project: str = typer.Option(...),
    input_path: Path = typer.Option(..., "--input", help="Claude knowledge batch JSON."),
    skip_invalid: bool = typer.Option(
        False,
        "--skip-invalid",
        help="Import every valid record, repair references from the database, report rejects.",
    ),
) -> None:
    """Validate evidence links and import a reviewed knowledge batch."""
    try:
        _print_json(
            import_knowledge_batch(_project(project), input_path, skip_invalid=skip_invalid)
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(2) from error


@app.command()
def reconcile(project: str = typer.Option(...)) -> None:
    """Report repeated, conflicting, historical, and unresolved knowledge."""
    _print_json(reconcile_records(_project(project)))


@app.command("build-domain-model")
def build_domain_model(project: str = typer.Option(...)) -> None:
    console.print(build_domain_model_files(_project(project)))


@app.command("generate-blueprint")
def generate_blueprint(project: str = typer.Option(...)) -> None:
    console.print(generate_blueprint_files(_project(project)))


@app.command("validate-blueprint")
def validate_blueprint(project: str = typer.Option(...)) -> None:
    result = validate_blueprint_files(_project(project))
    _print_json(result)
    if not result["valid"]:
        raise typer.Exit(2)


@app.command("generate-build-package")
def generate_build_package(project: str = typer.Option(...)) -> None:
    try:
        console.print(make_build_package(_project(project)))
    except RuntimeError as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(2) from error


@app.command()
def status(project: str = typer.Option(...)) -> None:
    target = _project(project)
    recovered = target.database.recover_stale()
    with target.database.connect() as connection:
        stages = [
            dict(row)
            for row in connection.execute(
                "SELECT stage, status, COUNT(*) count FROM stage_runs GROUP BY stage, status"
            ).fetchall()
        ]
        scope = {
            "in_scope": connection.execute(
                "SELECT COUNT(*) FROM sources WHERE in_scope=1"
            ).fetchone()[0],
            "out_of_scope": connection.execute(
                "SELECT COUNT(*) FROM sources WHERE in_scope=0"
            ).fetchone()[0],
        }
    _print_json(
        {
            "project": target.require().model_dump(mode="json"),
            "counts": target.database.counts(),
            "stages": stages,
            "scope": scope,
            "stale_runs_recovered": recovered,
        }
    )


@app.command()
def search(
    project: str = typer.Option(...),
    query: str = typer.Option(...),
    limit: int = typer.Option(25, min=1, max=250),
) -> None:
    _print_json(_project(project).database.search(query, limit))


@app.command("trace-rule")
def trace_rule(project: str = typer.Option(...), rule_id: str = typer.Option(...)) -> None:
    target = _project(project)
    with target.database.connect() as connection:
        rows = connection.execute(
            """
            SELECT r.rule_json, re.evidence_id, e.source_url, e.timestamp_start, e.timestamp_end
            FROM rules r LEFT JOIN rule_evidence re
              ON r.rule_id=re.rule_id AND r.version=re.rule_version
            LEFT JOIN evidence e ON e.evidence_id=re.evidence_id
            WHERE r.rule_id=? ORDER BY r.version DESC
            """,
            (rule_id,),
        ).fetchall()
    _print_json([dict(row) for row in rows])


@app.command("show-evidence")
def show_evidence(project: str = typer.Option(...), evidence_id: str = typer.Option(...)) -> None:
    target = _project(project)
    with target.database.connect() as connection:
        row = connection.execute(
            "SELECT * FROM evidence WHERE evidence_id=?", (evidence_id,)
        ).fetchone()
    if row is None:
        raise typer.BadParameter(f"Unknown evidence: {evidence_id}")
    _print_json(dict(row))


@app.command("explain-feature")
def explain_feature(
    project: str = typer.Option(...), requirement_id: str = typer.Option(...)
) -> None:
    target = _project(project)
    with target.database.connect() as connection:
        row = connection.execute(
            "SELECT trace_json FROM requirements WHERE requirement_id=?", (requirement_id,)
        ).fetchone()
    if row is None:
        raise typer.BadParameter(f"Unknown requirement: {requirement_id}")
    _print_json(json.loads(row["trace_json"]))


@app.command()
def unresolved(project: str = typer.Option(...)) -> None:
    target = _project(project)
    path = target.root / "knowledge" / "unresolved.jsonl"
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    _print_json(records)


@app.command("export-claude-bundle")
def export_claude_bundle(project: str = typer.Option(...)) -> None:
    console.print(export_bundle(_project(project), "claude"))


@app.command("export-codex-bundle")
def export_codex_bundle(project: str = typer.Option(...)) -> None:
    console.print(export_bundle(_project(project), "codex"))


@app.command("cleanup-media")
def cleanup_media(
    project: str = typer.Option(...),
    confirm: str | None = typer.Option(
        None, help=f"Exact confirmation phrase: {CONFIRMATION_PHRASE}"
    ),
) -> None:
    """Preview or explicitly delete raw video/audio after complete evidence extraction."""
    target = _project(project)
    plan = build_cleanup_plan(target)
    _print_json(
        {
            "ready": plan.ready,
            "file_count": plan.file_count,
            "bytes_to_delete": plan.bytes_to_delete,
            "gigabytes_to_delete": round(plan.bytes_to_delete / 1_000_000_000, 3),
            "blockers": plan.blockers,
            "preserved": plan.preserved,
            "next_step": (
                f"Rerun with --confirm {CONFIRMATION_PHRASE}"
                if plan.ready and confirm is None
                else None
            ),
        }
    )
    if confirm is None:
        return
    try:
        execute_cleanup(target, confirm)
    except (RuntimeError, ValueError) as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(2) from error
    console.print(
        "[green]Raw downloaded videos and derived audio were deleted. Evidence artifacts were "
        "preserved.[/green]"
    )


@app.command("set-scope")
def set_scope(
    project: str = typer.Option(...),
    latest: int = typer.Option(50, min=1, help="Newest Instagram source records to process."),
) -> None:
    """Select recent Instagram records without deleting older discovery history."""
    target = _project(project)
    _print_json(target.database.set_latest_source_scope("instaloader", latest))
