from pathlib import Path

import pytest

from video_software_compiler.models import ProjectConfig
from video_software_compiler.project import Project
from video_software_compiler.workflow import (
    BLUEPRINT_FILES,
    generate_blueprint,
    generate_build_package,
    validate_blueprint,
)


def make_project(tmp_path: Path) -> Project:
    project = Project("workflow", tmp_path)
    project.create(ProjectConfig(name="workflow", source="local"))
    return project


def test_blueprint_files_and_gate_validation(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    generate_blueprint(project)
    assert all((project.root / "blueprint" / name).exists() for name in BLUEPRINT_FILES)
    result = validate_blueprint(project)
    assert result["valid"] is False
    assert result["gates"]["unknowns_documented"] is True


def test_build_package_refuses_unapproved_blueprint(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    generate_blueprint(project)
    with pytest.raises(RuntimeError, match="gates"):
        generate_build_package(project)
