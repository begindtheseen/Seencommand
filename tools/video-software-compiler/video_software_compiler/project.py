from __future__ import annotations

import json
import re
from pathlib import Path

from video_software_compiler.constants import (
    EXPERIMENT_FILES,
    KNOWLEDGE_FILES,
    PROJECT_DIRECTORIES,
    default_data_root,
)
from video_software_compiler.database import StateDatabase
from video_software_compiler.models import ProjectConfig

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def validate_project_name(name: str) -> str:
    if not SAFE_NAME.fullmatch(name):
        raise ValueError(
            "Project name must use 1-128 letters, numbers, dots, dashes, or underscores"
        )
    return name


class Project:
    def __init__(self, name: str, data_root: Path | None = None) -> None:
        self.name = validate_project_name(name)
        self.data_root = (data_root or default_data_root()).resolve()
        self.root = self.data_root / self.name
        self.config_path = self.root / "project.json"
        self.database = StateDatabase(self.root / "state.sqlite")

    def create(self, config: ProjectConfig) -> None:
        if self.config_path.exists():
            raise FileExistsError(f"Project already exists: {self.name}")
        self.root.mkdir(parents=True, exist_ok=False)
        for directory in PROJECT_DIRECTORIES:
            (self.root / directory).mkdir()
        for filename in KNOWLEDGE_FILES:
            (self.root / "knowledge" / filename).touch()
        for filename in EXPERIMENT_FILES:
            (self.root / "experiments" / filename).touch()
        (self.root / "knowledge" / "knowledge-graph.json").write_text("{}\n")
        (self.root / "knowledge" / "knowledge-base.md").write_text(
            "# Knowledge Base\n\nNo reconciled knowledge yet.\n"
        )
        self.config_path.write_text(
            json.dumps(config.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
        )
        self.database.initialize()

    def require(self) -> ProjectConfig:
        if not self.config_path.exists():
            raise FileNotFoundError(f"Project does not exist: {self.name}")
        self.database.initialize()
        return ProjectConfig.model_validate_json(self.config_path.read_text())
