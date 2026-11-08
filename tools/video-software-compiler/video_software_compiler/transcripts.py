from __future__ import annotations

import re
from pathlib import Path

from video_software_compiler.models import TranscriptSegment

TIMECODE = re.compile(
    r"(?P<hours>\d{2}):(?P<minutes>\d{2}):(?P<seconds>\d{2})[,.](?P<millis>\d{3})"
)


def seconds(value: str) -> float:
    match = TIMECODE.fullmatch(value.strip())
    if not match:
        raise ValueError(f"Invalid timecode: {value}")
    parts = {key: int(number) for key, number in match.groupdict().items()}
    return parts["hours"] * 3600 + parts["minutes"] * 60 + parts["seconds"] + parts["millis"] / 1000


def parse_srt_text(content: str) -> list[TranscriptSegment]:
    normalized = content.replace("\r\n", "\n").strip()
    if not normalized:
        return []
    segments: list[TranscriptSegment] = []
    for block in re.split(r"\n\s*\n", normalized):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        identifier = lines.pop(0) if "-->" not in lines[0] else str(len(segments) + 1)
        if not lines or "-->" not in lines[0]:
            continue
        start_raw, end_raw = [part.strip() for part in lines.pop(0).split("-->", maxsplit=1)]
        text = " ".join(lines).strip()
        if not text:
            continue
        segments.append(
            TranscriptSegment(
                segment_id=identifier,
                start=seconds(start_raw),
                end=seconds(end_raw.split()[0]),
                text=text,
            )
        )
    return segments


def parse_srt(path: Path) -> list[TranscriptSegment]:
    return parse_srt_text(path.read_text(errors="replace"))


def srt_timestamp(value: float) -> str:
    milliseconds = max(round(value * 1000), 0)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds_value, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_value:02d},{millis:03d}"


def render_srt(segments: list[TranscriptSegment]) -> str:
    blocks = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(
            f"{index}\n{srt_timestamp(segment.start)} --> {srt_timestamp(segment.end)}\n"
            f"{segment.text}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")
