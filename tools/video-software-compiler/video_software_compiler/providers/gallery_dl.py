from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any

from video_software_compiler.project import Project


class GalleryDlProvider:
    """Instagram fallback that avoids Instaloader's profile-info query.

    gallery-dl resolves a username with its independent ``search,web`` strategy and emits direct
    video URLs plus metadata. Downloads still use the already-loaded local Instaloader requests
    session when one exists; credentials are never copied into argv, logs, project data, or .env.
    """

    def __init__(
        self,
        project: Project,
        *,
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.project = project
        self.runner = runner

    def ingest(
        self,
        username: str,
        session: Any | None = None,
        limit: int | None = 50,
    ) -> dict[str, Any]:
        try:
            import gallery_dl  # type: ignore[import-untyped]  # noqa: F401
            import requests
        except ImportError as error:
            raise RuntimeError(
                "gallery-dl fallback is unavailable. Install with: "
                "pip install -e '.[instagram]'"
            ) from error

        http = session or requests.Session()
        entries = self._discover(username, http, limit)
        added = updated = failed = 0

        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for entry in entries:
            grouped[entry["post_shortcode"]].append(entry)

        for shortcode, items in grouped.items():
            items.sort(key=lambda item: (int(item.get("num") or 0), item.get("media_id") or ""))
            multi = len(items) > 1
            for video_index, item in enumerate(items, 1):
                suffix = f"-v{video_index:02d}" if multi else ""
                source_id = f"instagram-{shortcode}{suffix}"
                external_id = f"{shortcode}{suffix}"
                destination = self._destination(shortcode, item, video_index)
                saved_destination: Path | None = destination
                availability = "available"
                try:
                    if not destination.exists():
                        self._download(http, item["url"], destination)
                except (OSError, RuntimeError) as error:
                    failed += 1
                    availability = "unavailable"
                    saved_destination = None
                    item = {**item, "download_error": str(error)[:500]}

                record = self._record(
                    username,
                    source_id,
                    external_id,
                    shortcode,
                    item,
                    saved_destination,
                    multi,
                    video_index,
                    availability,
                )
                if self.project.database.upsert_source(record):
                    added += 1
                else:
                    updated += 1
                manifest = self.project.root / "sources" / f"{source_id}.json"
                manifest.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")

        scope = self.project.database.set_latest_instagram_scope(limit)
        return {
            "discovered": len(entries),
            "added": added,
            "updated": updated,
            "failed": failed,
            "acquisition_provider": "gallery-dl",
            **scope,
        }

    def _discover(
        self,
        username: str,
        session: Any,
        limit: int | None,
    ) -> list[dict[str, Any]]:
        # Ask for more posts than the video limit because image-only posts are filtered below. If
        # that window is full but contains too few videos, expand it until we have the requested
        # number or the account is exhausted. The final slice is over actual video files.
        scan_limit = None if limit is None else max(limit * 5, limit)
        with self._cookies_file(session) as cookies:
            while True:
                payload = self._discovery_payload(username, cookies, scan_limit)
                videos = self._video_entries(payload)
                if limit is None or len(videos) >= limit:
                    break
                post_ids = self._post_ids(payload)
                if scan_limit is None or len(post_ids) < scan_limit or scan_limit >= 5000:
                    break
                scan_limit = min(scan_limit * 2, 5000)
        return videos if limit is None else videos[:limit]

    def _discovery_payload(
        self, username: str, cookies: Path | None, scan_limit: int | None
    ) -> list[Any]:
        args = [
            sys.executable,
            "-m",
            "gallery_dl",
            "--config-ignore",
            "--no-input",
            "--no-colors",
            "--dump-json",
            "-o",
            "user-strategy=search,web",
            "-o",
            "videos=merged",
        ]
        if scan_limit is not None:
            args.extend(("-o", f"max-posts={scan_limit}"))
        if cookies is not None:
            args.extend(("--cookies", str(cookies)))
        args.append(f"https://www.instagram.com/{username}/posts/")
        result = self.runner(
            args,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if result.returncode:
            detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
            raise RuntimeError(f"gallery-dl discovery failed: {detail[:1000]}")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("gallery-dl returned invalid discovery JSON") from error
        if not isinstance(payload, list):
            raise RuntimeError("gallery-dl returned invalid discovery JSON")
        return payload

    @staticmethod
    def _post_ids(payload: list[Any]) -> set[str]:
        post_ids: set[str] = set()
        for message in payload:
            if not isinstance(message, list) or not message:
                continue
            metadata: Any = None
            if message[0] == 2 and len(message) >= 2:
                metadata = message[1]
            elif message[0] == 3 and len(message) >= 3:
                metadata = message[2]
            if not isinstance(metadata, dict):
                continue
            post_id = metadata.get("post_shortcode") or metadata.get("shortcode")
            if post_id:
                post_ids.add(str(post_id))
        return post_ids

    @staticmethod
    def _video_entries(payload: list[Any]) -> list[dict[str, Any]]:
        failures = [
            str(item[1].get("message") or item[1].get("error"))
            for item in payload
            if isinstance(item, list)
            and len(item) == 2
            and item[0] == -1
            and isinstance(item[1], dict)
        ]
        if failures:
            raise RuntimeError(f"gallery-dl discovery failed: {failures[0][:1000]}")

        videos: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, list) or len(item) < 3 or item[0] != 3:
                continue
            url, metadata = item[1], item[2]
            if not isinstance(url, str) or not isinstance(metadata, dict):
                continue
            extension = str(metadata.get("extension") or "").lower()
            if not metadata.get("video_url") and extension not in {"mp4", "mov", "m4v", "webm"}:
                continue
            shortcode = str(metadata.get("post_shortcode") or metadata.get("shortcode") or "")
            if not shortcode:
                continue
            videos.append({**metadata, "url": url, "post_shortcode": shortcode})

        videos.sort(
            key=lambda item: str(item.get("post_date") or item.get("date") or ""),
            reverse=True,
        )
        return videos

    @contextmanager
    def _cookies_file(self, session: Any) -> Iterator[Path | None]:
        cookies = getattr(session, "cookies", None)
        if cookies is None or not list(cookies):
            yield None
            return
        fd, raw_path = tempfile.mkstemp(prefix="seen-ig-cookies-", suffix=".txt")
        os.close(fd)
        path = Path(raw_path)
        try:
            path.chmod(0o600)
            jar = MozillaCookieJar(str(path))
            for cookie in cookies:
                jar.set_cookie(cookie)
            jar.save(ignore_discard=True, ignore_expires=True)
            yield path
        finally:
            path.unlink(missing_ok=True)

    def _destination(
        self,
        shortcode: str,
        item: dict[str, Any],
        video_index: int,
    ) -> Path:
        date = self._date(item.get("post_date") or item.get("date"))
        extension = str(item.get("extension") or "mp4").lower()
        if extension not in {"mp4", "mov", "m4v", "webm"}:
            extension = "mp4"
        directory = self.project.root / "videos" / shortcode
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{shortcode}_{date}_{video_index:02d}.{extension}"

    @staticmethod
    def _date(value: Any) -> str:
        if isinstance(value, (int, float)):
            dt = datetime.fromtimestamp(value, UTC)
            return dt.strftime("%Y-%m-%d_%H-%M-%S")
        text = str(value or "unknown").replace("T", "_").replace(":", "-")
        return text[:19].replace(" ", "_")

    @staticmethod
    def _download(session: Any, url: str, destination: Path) -> None:
        part = destination.with_suffix(destination.suffix + ".part")
        try:
            with session.get(
                url,
                headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.instagram.com/"},
                stream=True,
                timeout=120,
            ) as response:
                response.raise_for_status()
                with part.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            output.write(chunk)
            if not part.exists() or part.stat().st_size == 0:
                raise RuntimeError("empty video download")
            part.replace(destination)
        finally:
            part.unlink(missing_ok=True)

    def _record(
        self,
        username: str,
        source_id: str,
        external_id: str,
        shortcode: str,
        item: dict[str, Any],
        destination: Path | None,
        multi: bool,
        video_index: int,
        availability: str,
    ) -> dict[str, Any]:
        source_url = str(item.get("post_url") or f"https://www.instagram.com/p/{shortcode}/")
        local_path = None
        if destination is not None:
            local_path = str(destination.resolve().relative_to(self.project.root.resolve()))
        return {
            "source_id": source_id,
            # Keep the canonical provider key compatible with prior Instaloader records. The actual
            # acquisition implementation is explicit in metadata.
            "provider": "instaloader",
            "external_id": external_id,
            "source_url": source_url,
            "media_type": "carousel_video" if multi else "video",
            "caption": str(item.get("description") or ""),
            "published_at": str(item.get("post_date") or item.get("date") or "") or None,
            "retrieved_at": datetime.now(UTC).isoformat(),
            "metadata": {
                "username": username,
                "acquisition_provider": "gallery-dl",
                "typename": item.get("typename"),
                "likes": item.get("likes"),
                "media_id": item.get("media_id"),
                "carousel_video_index": video_index if multi else None,
                "gallery_metadata": {
                    key: value
                    for key, value in item.items()
                    if key
                    in {
                        "count",
                        "height",
                        "width",
                        "num",
                        "pinned",
                        "shortcode",
                    }
                },
            },
            "content_hash": hashlib.sha256(source_url.encode()).hexdigest(),
            "local_path": local_path,
            "availability": availability,
        }
