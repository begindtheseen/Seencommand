from __future__ import annotations

import importlib.util
import shutil
import sqlite3
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str
    required: bool


def run_setup_checks() -> list[Check]:
    checks = [
        Check("Python", sys.version_info >= (3, 11), sys.version.split()[0], True),
        Check("SQLite FTS5", _has_fts5(), sqlite3.sqlite_version, True),
        _binary("ffmpeg", required=True),
        _binary("ffprobe", required=True),
        _binary("tesseract", required=True),
        _binary("gallery-dl", required=False),
        _module("faster_whisper", required=True),
        _module("instaloader", required=False),
    ]
    return checks


def _has_fts5() -> bool:
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("CREATE VIRTUAL TABLE test_fts USING fts5(content)")
    except sqlite3.OperationalError:
        return False
    finally:
        connection.close()
    return True


def _binary(name: str, *, required: bool) -> Check:
    path = shutil.which(name)
    return Check(name, path is not None, path or "not installed", required)


def _module(name: str, *, required: bool) -> Check:
    found = importlib.util.find_spec(name) is not None
    return Check(name, found, "installed" if found else "not installed", required)
