import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from video_software_compiler.models import ProjectConfig
from video_software_compiler.project import Project
from video_software_compiler.providers.gallery_dl import GalleryDlProvider


class FakeResponse:
    def __init__(self, content: bytes = b"fake-mp4") -> None:
        self.content = content

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, _size: int):
        yield self.content


class FakeSession:
    cookies: list[Any] = []

    def __init__(self) -> None:
        self.downloads: list[str] = []

    def get(self, url: str, **_kwargs: Any) -> FakeResponse:
        self.downloads.append(url)
        return FakeResponse()


def make_project(tmp_path: Path) -> Project:
    project = Project("instagram-creator", tmp_path)
    project.create(
        ProjectConfig(name=project.name, source="instagram", username="creator")
    )
    return project


def discovery_payload() -> list[list[Any]]:
    newer = datetime(2026, 7, 31, 12, tzinfo=UTC).isoformat()
    older = datetime(2026, 7, 30, 12, tzinfo=UTC).isoformat()
    return [
        [
            3,
            "https://cdn.example/new.mp4",
            {
                "extension": "mp4",
                "video_url": "https://cdn.example/new.mp4",
                "post_shortcode": "NEW123",
                "post_url": "https://www.instagram.com/p/NEW123/",
                "post_date": newer,
                "description": "new caption",
                "media_id": "1",
                "num": 1,
            },
        ],
        [
            3,
            "https://cdn.example/image.jpg",
            {
                "extension": "jpg",
                "post_shortcode": "IMAGE",
                "post_date": newer,
            },
        ],
        [
            3,
            "https://cdn.example/old.mp4",
            {
                "extension": "mp4",
                "video_url": "https://cdn.example/old.mp4",
                "post_shortcode": "OLD123",
                "post_url": "https://www.instagram.com/p/OLD123/",
                "post_date": older,
                "description": "old caption",
                "media_id": "2",
                "num": 1,
            },
        ],
    ]


def test_gallery_fallback_discovers_downloads_and_deduplicates(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    calls: list[list[str]] = []

    def runner(args: list[str], **_kwargs: Any) -> SimpleNamespace:
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=json.dumps(discovery_payload()), stderr="")

    session = FakeSession()
    provider = GalleryDlProvider(project, runner=runner)
    result = provider.ingest("creator", session, 2)

    assert result == {
        "discovered": 2,
        "added": 2,
        "updated": 0,
        "failed": 0,
        "acquisition_provider": "gallery-dl",
        "in_scope": 2,
        "out_of_scope": 0,
    }
    assert len(session.downloads) == 2
    assert "user-strategy=search,web" in calls[0]
    assert "max-posts=10" in calls[0]
    assert calls[0][-1] == "https://www.instagram.com/creator/posts/"
    assert not any("password" in arg.lower() for arg in calls[0])

    sources = [
        project.database.get_source("instagram-NEW123"),
        project.database.get_source("instagram-OLD123"),
    ]
    assert all(source is not None for source in sources)
    for source in sources:
        assert source is not None
        assert source["provider"] == "instaloader"
        assert not Path(source["local_path"]).is_absolute()
        metadata = json.loads(source["metadata_json"])
        assert metadata["acquisition_provider"] == "gallery-dl"
        assert (project.root / source["local_path"]).read_bytes() == b"fake-mp4"

    # A repeat refreshes metadata/scope but does not redownload retained media.
    again = provider.ingest("creator", session, 2)
    assert again["added"] == 0
    assert again["updated"] == 2
    assert len(session.downloads) == 2


def test_gallery_fallback_obeys_newest_video_limit(tmp_path: Path) -> None:
    project = make_project(tmp_path)

    def runner(_args: list[str], **_kwargs: Any) -> SimpleNamespace:
        return SimpleNamespace(returncode=0, stdout=json.dumps(discovery_payload()), stderr="")

    session = FakeSession()
    result = GalleryDlProvider(project, runner=runner).ingest("creator", session, 1)
    assert result["discovered"] == 1
    assert project.database.get_source("instagram-NEW123") is not None
    assert project.database.get_source("instagram-OLD123") is None


def test_gallery_fallback_expands_image_heavy_window(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    calls: list[list[str]] = []

    def runner(args: list[str], **_kwargs: Any) -> SimpleNamespace:
        calls.append(args)
        if len(calls) == 1:
            payload = [
                [
                    3,
                    f"https://cdn.example/image-{index}.jpg",
                    {
                        "extension": "jpg",
                        "post_shortcode": f"IMAGE{index}",
                    },
                ]
                for index in range(10)
            ]
        else:
            payload = discovery_payload()
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

    result = GalleryDlProvider(project, runner=runner).ingest(
        "creator", FakeSession(), 2
    )
    assert result["discovered"] == 2
    assert "max-posts=10" in calls[0]
    assert "max-posts=20" in calls[1]


def test_gallery_discovery_error_is_honest_and_downloads_nothing(tmp_path: Path) -> None:
    project = make_project(tmp_path)

    def runner(_args: list[str], **_kwargs: Any) -> SimpleNamespace:
        payload = [[-1, {"error": "AuthRequired", "message": "authenticated cookies"}]]
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

    import pytest

    session = FakeSession()
    with pytest.raises(RuntimeError, match="authenticated cookies"):
        GalleryDlProvider(project, runner=runner).ingest("creator", session, 50)
    assert session.downloads == []
