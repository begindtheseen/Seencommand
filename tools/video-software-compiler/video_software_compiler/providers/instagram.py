from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from video_software_compiler.project import Project
from video_software_compiler.providers.gallery_dl import GalleryDlProvider


def _access_error(username: str, session_user: str | None, error: Exception) -> str:
    """Clean, login-aware message for an Instagram access failure.

    The wording deliberately includes login/anonymous/authenticate keywords so the Node orchestrator
    maps it to ``needs_login`` instead of surfacing a raw traceback.
    """
    text = str(error).lower()
    auth_tokens = (
        "401", "403", "login", "checkpoint", "challenge", "forbidden", "not logged", "two-factor",
    )
    auth_like = any(token in text for token in auth_tokens)
    if auth_like and session_user:
        hint = "the saved session may be expired or challenged — re-run instaloader --login"
    elif auth_like:
        hint = (
            "anonymous/logged-out access is often blocked — authenticate with your own account "
            "(instaloader --login <user>) and set INSTAGRAM_SESSION_USER"
        )
    else:
        hint = (
            "likely an Instagram/instaloader API incompatibility for this profile "
            "(often business/professional accounts) — try a different creator or update instaloader"
        )
    return f"Instagram access failed for @{username}: {error} ({hint})."


class InstaloaderProvider:
    """Zero-metered-cost Instagram provider using the user's local authenticated session."""

    def __init__(self, project: Project) -> None:
        self.project = project

    def ingest(
        self,
        username: str,
        session_user: str | None = None,
        limit: int | None = 50,
    ) -> dict[str, int]:
        try:
            import instaloader
        except ImportError as error:
            raise RuntimeError(
                "Instaloader is optional. Install with: pip install -e '.[instagram]'"
            ) from error

        loader = instaloader.Instaloader(
            dirname_pattern=str(self.project.root / "videos" / "{shortcode}"),
            filename_pattern="{shortcode}_{date_utc}",
            download_pictures=False,
            download_videos=True,
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=True,
            compress_json=False,
            post_metadata_txt_pattern="{caption}",
        )
        if session_user:
            try:
                loader.load_session_from_file(session_user)
            except FileNotFoundError as error:
                raise RuntimeError(
                    f"No Instaloader session found for @{session_user}. Authenticate a "
                    f"session in Terminal: instaloader --login {session_user}."
                ) from error
        # Anonymous/logged-out access + the profile fetch are the usual failure points; Instagram
        # frequently blocks them. Convert instaloader's exceptions into a clean login-aware error so
        # the orchestrator reports needs_login instead of a raw Python traceback.
        try:
            profile = instaloader.Profile.from_username(loader.context, username)
        except instaloader.InstaloaderException as error:
            # Instagram's web_profile_info endpoint periodically breaks for business/professional
            # profiles. gallery-dl has an independent search+web resolver, so use it before giving
            # up.
            try:
                return GalleryDlProvider(self.project).ingest(
                    username, loader.context._session, limit
                )
            except RuntimeError as fallback_error:
                primary = _access_error(username, session_user, error)
                raise RuntimeError(
                    f"{primary} gallery-dl fallback also failed: {fallback_error}"
                ) from fallback_error
        discovered = added = updated = failed = 0
        try:
            for post in profile.get_posts():
                if not post.is_video and post.typename != "GraphSidecar":
                    continue
                if limit is not None and discovered >= limit:
                    break
                discovered += 1
                try:
                    loader.download_post(post, target=post.shortcode)
                    matching_videos = [
                        path
                        for path in sorted((self.project.root / "videos").rglob("*.mp4"))
                        if post.shortcode in path.name or post.shortcode in str(path.parent)
                    ]
                    records = self._records(post, username, matching_videos, self.project.root)
                    for record in records:
                        if self.project.database.upsert_source(record):
                            added += 1
                        else:
                            updated += 1
                        manifest = self.project.root / "sources" / f"{record['source_id']}.json"
                        manifest.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
                except (OSError, instaloader.InstaloaderException):
                    failed += 1
                    continue
        except instaloader.InstaloaderException as error:
            # A failure while paginating (rate-limit / login wall). If nothing came through, stop
            # honestly; otherwise keep what was already ingested.
            if discovered == 0:
                raise RuntimeError(_access_error(username, session_user, error)) from error
        scope = self.project.database.set_latest_instagram_scope(limit)
        return {
            "discovered": discovered,
            "added": added,
            "updated": updated,
            "failed": failed,
            **scope,
        }

    @staticmethod
    def _record(post: Any, username: str) -> dict[str, Any]:
        source_id = f"instagram-{post.shortcode}"
        url = f"https://www.instagram.com/p/{post.shortcode}/"
        return {
            "source_id": source_id,
            "provider": "instaloader",
            "external_id": post.shortcode,
            "source_url": url,
            "media_type": "carousel_video" if post.typename == "GraphSidecar" else "video",
            "caption": post.caption or "",
            "published_at": post.date_utc.replace(tzinfo=UTC).isoformat(),
            "retrieved_at": datetime.now(UTC).isoformat(),
            "metadata": {
                "username": username,
                "typename": post.typename,
                "likes": post.likes,
                "comments": post.comments,
                "is_video": post.is_video,
            },
            "content_hash": hashlib.sha256(url.encode()).hexdigest(),
            "local_path": None,
        }

    @classmethod
    def _records(
        cls, post: Any, username: str, videos: list[Path], root: Path
    ) -> list[dict[str, Any]]:
        # Store PROJECT-RELATIVE local_path so the Library (which rejects absolute paths) can serve
        # media directly and the project stays relocatable. Fallback to the raw path only if a video
        # somehow lands outside the project root (should never happen).
        def rel(video: Path) -> str:
            try:
                return str(video.resolve().relative_to(root.resolve()))
            except ValueError:
                return str(video)

        base = cls._record(post, username)
        if post.typename != "GraphSidecar" or len(videos) <= 1:
            base["local_path"] = rel(videos[0]) if videos else None
            return [base]
        base["media_type"] = "carousel_container"
        records = [base]
        for index, video in enumerate(videos, start=1):
            child = dict(base)
            child["source_id"] = f"instagram-{post.shortcode}-v{index:02d}"
            child["external_id"] = f"{post.shortcode}-v{index:02d}"
            child["media_type"] = "carousel_video"
            child["local_path"] = rel(video)
            child["metadata"] = {
                **base["metadata"],
                "parent_shortcode": post.shortcode,
                "carousel_video_index": index,
                "carousel_video_count": len(videos),
            }
            records.append(child)
        return records
