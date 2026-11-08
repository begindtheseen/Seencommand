import inspect
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from video_software_compiler.providers.instagram import InstaloaderProvider


def test_instagram_provider_defaults_to_fifty_posts() -> None:
    signature = inspect.signature(InstaloaderProvider.ingest)
    assert signature.parameters["limit"].default == 50


def test_carousel_videos_receive_distinct_source_records(tmp_path: Path) -> None:
    post = SimpleNamespace(
        shortcode="abc",
        typename="GraphSidecar",
        caption="A carousel",
        date_utc=datetime(2025, 1, 1),
        likes=10,
        comments=2,
        is_video=False,
    )
    videos_dir = tmp_path / "videos"
    videos_dir.mkdir()
    videos = [videos_dir / "abc_1.mp4", videos_dir / "abc_2.mp4"]
    for video in videos:
        video.write_bytes(b"x")
    records = InstaloaderProvider._records(post, "creator", videos, tmp_path)
    assert records[0]["media_type"] == "carousel_container"
    assert [record["source_id"] for record in records[1:]] == [
        "instagram-abc-v01",
        "instagram-abc-v02",
    ]
    # local_path is now PROJECT-RELATIVE (not absolute) so the Library can serve it.
    relative_paths = [record["local_path"] for record in records[1:]]
    assert relative_paths == ["videos/abc_1.mp4", "videos/abc_2.mp4"]
    for path in records[1:]:
        assert not Path(path["local_path"]).is_absolute()


def test_ingest_maps_instaloader_failure_to_clean_login_error(tmp_path, monkeypatch):
    """A blocked/anonymous fetch must raise a clean, login-aware RuntimeError (not a raw traceback),
    so the orchestrator maps it to needs_login. No network: Profile.from_username is stubbed.
    """
    from types import SimpleNamespace

    import instaloader
    import pytest

    from video_software_compiler.providers.instagram import InstaloaderProvider

    (tmp_path / "videos").mkdir()

    def boom(*args, **kwargs):
        raise instaloader.exceptions.ConnectionException("401 Unauthorized: login required")

    monkeypatch.setattr(instaloader.Profile, "from_username", boom)
    monkeypatch.setattr(
        "video_software_compiler.providers.instagram.GalleryDlProvider.ingest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("login required")),
    )
    provider = InstaloaderProvider(SimpleNamespace(root=tmp_path))
    with pytest.raises(RuntimeError) as excinfo:
        provider.ingest("someuser", None, 5)
    message = str(excinfo.value).lower()
    assert "instagram access failed" in message
    assert any(word in message for word in ("login", "anonymous", "authenticate"))


def test_ingest_maps_api_incompat_to_a_non_login_error(tmp_path, monkeypatch):
    """A non-auth Instagram/instaloader failure (e.g. the 400 business-profile schema bug) must not
    be dressed up as a login problem — it should read as an API incompatibility.
    """
    from types import SimpleNamespace

    import instaloader
    import pytest

    from video_software_compiler.providers.instagram import InstaloaderProvider

    (tmp_path / "videos").mkdir()

    def boom(*args, **kwargs):
        raise instaloader.exceptions.QueryReturnedBadRequestException(
            '400 Bad Request - schema ig_business_category_subvertical has been deleted'
        )

    monkeypatch.setattr(instaloader.Profile, "from_username", boom)
    monkeypatch.setattr(
        "video_software_compiler.providers.instagram.GalleryDlProvider.ingest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("fallback unavailable")),
    )
    provider = InstaloaderProvider(SimpleNamespace(root=tmp_path))
    with pytest.raises(RuntimeError) as excinfo:
        provider.ingest("somebiz", None, 5)
    message = str(excinfo.value).lower()
    assert "incompatibility" in message
    assert "instaloader --login" not in message  # not misclassified as an auth problem


def test_ingest_uses_gallery_fallback_for_business_profile_schema_bug(tmp_path, monkeypatch):
    """The business-profile schema failure seen in the wild must take the fallback, not stop at exit 1."""
    import instaloader

    (tmp_path / "videos").mkdir()

    def boom(*_args, **_kwargs):
        raise instaloader.exceptions.QueryReturnedBadRequestException(
            "400 Bad Request - schema ig_business_category_subvertical has been deleted"
        )

    expected = {
        "discovered": 3,
        "added": 3,
        "updated": 0,
        "failed": 0,
        "in_scope": 3,
        "out_of_scope": 0,
        "acquisition_provider": "gallery-dl",
    }
    seen = {}

    def fallback(_self, username, session, limit):
        seen.update(username=username, session=session, limit=limit)
        return expected

    monkeypatch.setattr(instaloader.Profile, "from_username", boom)
    monkeypatch.setattr(
        "video_software_compiler.providers.instagram.GalleryDlProvider.ingest", fallback
    )
    result = InstaloaderProvider(SimpleNamespace(root=tmp_path)).ingest("somebiz", None, 3)
    assert result == expected
    assert seen["username"] == "somebiz"
    assert seen["limit"] == 3
    assert seen["session"] is not None
