from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from video_software_compiler.project import Project

VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
TRANSCRIPT_SUFFIXES = {".txt", ".srt", ".vtt"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}
DOCUMENT_SUFFIXES = {".pdf", ".md", ".csv", ".json"}
SUPPORTED_SUFFIXES = VIDEO_SUFFIXES | TRANSCRIPT_SUFFIXES | IMAGE_SUFFIXES | DOCUMENT_SUFFIXES


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def classify(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in VIDEO_SUFFIXES:
        return "video"
    if suffix in TRANSCRIPT_SUFFIXES:
        return "transcript"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    return "document"


@dataclass(frozen=True)
class IngestionResult:
    discovered: int = 0
    added: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0


class LocalIngestionProvider:
    def __init__(self, project: Project) -> None:
        self.project = project

    def ingest(self, input_path: Path, *, copy_files: bool = True) -> IngestionResult:
        input_path = input_path.expanduser().resolve()
        if not input_path.exists():
            raise FileNotFoundError(input_path)
        candidates = [input_path] if input_path.is_file() else sorted(input_path.rglob("*"))
        candidates = [
            candidate
            for candidate in candidates
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_SUFFIXES
        ]
        added = updated = skipped = failed = 0
        for path in candidates:
            try:
                is_added = self._ingest_file(path, copy_files=copy_files)
                added += int(is_added)
                updated += int(not is_added)
            except OSError:
                failed += 1
        return IngestionResult(len(candidates), added, updated, skipped, failed)

    def _ingest_file(self, path: Path, *, copy_files: bool) -> bool:
        digest = hash_file(path)
        kind = classify(path)
        source_id = f"local-{digest[:24]}"
        destination_dir = {
            "video": self.project.root / "videos",
            "transcript": self.project.root / "transcripts",
            "image": self.project.root / "sources" / "images",
            "document": self.project.root / "sources" / "documents",
        }[kind]
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination = destination_dir / f"{source_id}{path.suffix.lower()}"
        if copy_files and not destination.exists():
            shutil.copy2(path, destination)
        local_path = destination if copy_files else path
        stat = path.stat()
        search_text = ""
        if kind in {"transcript", "document"} and stat.st_size <= 2 * 1024 * 1024:
            search_text = path.read_text(errors="replace")
        record: dict[str, Any] = {
            "source_id": source_id,
            "provider": "local",
            "external_id": digest,
            "source_url": path.as_uri(),
            "media_type": kind,
            "caption": search_text,
            "published_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
            "retrieved_at": datetime.now(UTC).isoformat(),
            "metadata": {
                "original_filename": path.name,
                "original_path": str(path),
                "size_bytes": stat.st_size,
            },
            "content_hash": digest,
            "local_path": str(local_path),
        }
        added = self.project.database.upsert_source(record)
        manifest = self.project.root / "sources" / f"{source_id}.json"
        manifest.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        return added
