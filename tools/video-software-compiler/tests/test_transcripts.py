import pytest
from pydantic import ValidationError

from video_software_compiler.models import TranscriptSegment
from video_software_compiler.transcripts import parse_srt_text, render_srt


def test_transcript_segmentation_preserves_timestamps() -> None:
    segments = parse_srt_text(
        "1\n00:00:00,500 --> 00:00:02,250\nFirst line\n\n"
        "2\n00:00:03.000 --> 00:00:04.000\nSecond\nline\n"
    )
    assert [(item.start, item.end, item.text) for item in segments] == [
        (0.5, 2.25, "First line"),
        (3.0, 4.0, "Second line"),
    ]


def test_transcript_segment_rejects_reversed_time() -> None:
    with pytest.raises(ValidationError):
        TranscriptSegment(segment_id="bad", start=2, end=1, text="invalid")


def test_render_srt_round_trips_segments() -> None:
    original = [TranscriptSegment(segment_id="1", start=1.25, end=2.5, text="Evidence")]
    rendered = render_srt(original)
    assert "00:00:01,250 --> 00:00:02,500" in rendered
    parsed = parse_srt_text(rendered)
    assert parsed[0].text == "Evidence"
