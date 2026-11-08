from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, cast

from video_software_compiler.models import EvidenceStatement, EvidenceType, TranscriptSegment
from video_software_compiler.project import Project
from video_software_compiler.transcripts import render_srt


def resolve_local(root: Path, local_path: str) -> Path:
    """Resolve a source's local_path to a filesystem path.

    New ingestion stores project-RELATIVE paths; legacy data may be absolute. Relative paths are
    joined to the project root; absolute paths are used as-is.
    """
    candidate = Path(local_path)
    return candidate if candidate.is_absolute() else (root / candidate)


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def probe(path: Path) -> dict[str, Any]:
    result = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ]
    )
    return cast(dict[str, Any], json.loads(result.stdout))


def duration_seconds(metadata: dict[str, Any]) -> float:
    raw = metadata.get("format", {}).get("duration", 0)
    try:
        return max(float(raw), 0)
    except (TypeError, ValueError):
        return 0


def frame_timestamps(duration: float) -> list[float]:
    fixed = [0.0, 0.5, 1.0, 3.0]
    if duration > 0:
        fixed.append(max(duration - min(0.5, duration / 2), 0))
    return sorted({round(value, 3) for value in fixed if value <= duration or duration == 0})


def select_scene_timestamps(
    candidates: list[float], *, minimum_gap: float = 0.75, maximum: int = 60
) -> list[float]:
    selected: list[float] = []
    for timestamp in sorted({round(value, 3) for value in candidates if value >= 0}):
        if not selected or timestamp - selected[-1] >= minimum_gap:
            selected.append(timestamp)
        if len(selected) >= maximum:
            break
    return selected


def detect_scene_timestamps(video: Path, threshold: float = 0.2) -> list[float]:
    result = _run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "info",
            "-i",
            str(video),
            "-filter:v",
            f"select=gt(scene\\,{threshold}),showinfo",
            "-an",
            "-f",
            "null",
            "-",
        ]
    )
    candidates = [float(value) for value in re.findall(r"pts_time:([0-9.]+)", result.stderr)]
    return select_scene_timestamps(candidates)


def extract_audio(video: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-i",
            str(video),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ]
    )


def extract_frames(
    video: Path,
    frames_dir: Path,
    timestamps: list[float],
    scene_timestamps: set[float] | None = None,
) -> list[dict[str, Any]]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    frames = []
    for timestamp in timestamps:
        filename = f"frame_{timestamp:010.3f}.jpg"
        destination = frames_dir / filename
        _run(
            [
                "ffmpeg",
                "-nostdin",
                "-y",
                "-v",
                "error",
                "-ss",
                str(timestamp),
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                "-strict",
                "unofficial",
                str(destination),
            ]
        )
        frames.append(
            {
                "frame_id": hashlib.sha256(f"{video}:{timestamp}".encode()).hexdigest()[:24],
                "timestamp": timestamp,
                "path": str(destination),
                "reason": (
                    "scene_change"
                    if scene_timestamps and timestamp in scene_timestamps
                    else "required_baseline"
                ),
            }
        )
    return frames


def parse_tesseract_tsv(
    output: str, *, minimum_word_confidence: float = 35.0
) -> tuple[str, float] | None:
    """Build readable OCR lines from Tesseract TSV and return measured confidence."""
    groups: dict[tuple[str, str, str, str], list[tuple[int, str, float]]] = {}
    try:
        rows = csv.DictReader(io.StringIO(output), delimiter="\t")
        for row in rows:
            word = (row.get("text") or "").strip()
            if not word or not re.search(r"[A-Za-z0-9]", word):
                continue
            try:
                confidence = float(row.get("conf") or -1)
            except ValueError:
                continue
            if confidence < minimum_word_confidence:
                continue
            key = (
                str(row.get("page_num") or "0"),
                str(row.get("block_num") or "0"),
                str(row.get("par_num") or "0"),
                str(row.get("line_num") or "0"),
            )
            try:
                order = int(row.get("word_num") or 0)
            except ValueError:
                order = 0
            groups.setdefault(key, []).append((order, word, confidence))
    except (csv.Error, TypeError):
        return None

    lines: list[str] = []
    confidences: list[float] = []
    for words in groups.values():
        words.sort(key=lambda item: item[0])
        line = " ".join(item[1] for item in words).strip()
        if len(re.sub(r"[^A-Za-z0-9]", "", line)) < 3:
            continue
        lines.append(line)
        confidences.extend(item[2] for item in words)
    text = "\n".join(lines).strip()
    if len(re.sub(r"[^A-Za-z0-9]", "", text)) < 10 or len(text.split()) < 3:
        return None
    return text, round(sum(confidences) / len(confidences) / 100, 4)


def _ocr_tokens(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9]{3,}", text.lower())}


def _ocr_similarity(left: str, right: str) -> float:
    a, b = _ocr_tokens(left), _ocr_tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def extract_ocr(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not shutil.which("tesseract"):
        return []
    results: list[dict[str, Any]] = []
    for frame in frames:
        try:
            completed = _run(
                ["tesseract", frame["path"], "stdout", "--psm", "11", "tsv"]
            )
        except subprocess.CalledProcessError:
            continue
        parsed = parse_tesseract_tsv(completed.stdout)
        if not parsed:
            continue
        text, confidence = parsed
        item = {
            "frame_id": frame["frame_id"],
            "timestamp_start": frame["timestamp"],
            "timestamp_end": frame["timestamp"],
            "text": text,
            "confidence": confidence,
            "engine": "tesseract",
        }
        duplicate = next(
            (
                index
                for index, prior in enumerate(results)
                if _ocr_similarity(text, prior["text"]) >= 0.82
            ),
            None,
        )
        if duplicate is None:
            results.append(item)
        elif confidence > results[duplicate]["confidence"]:
            results[duplicate] = item
    return results


def load_whisper_model(model_name: str) -> Any:
    try:
        from faster_whisper import WhisperModel  # type: ignore[import-untyped]
    except ImportError:
        return None
    return WhisperModel(model_name, device="cpu", compute_type="int8")


# Whisper's own decoding thresholds (openai/whisper, MIT, transcribe.py:
# compression_ratio_threshold=2.4, logprob_threshold=-1.0, no_speech_threshold=0.6).
# faster-whisper retries at higher temperatures when a segment crosses them, but when every
# retry fails it KEEPS the last result; on music-only reels that is a repetition loop or a
# stock phrase ("Thank you for watching") that then becomes "evidence". Those segments are
# dropped here and counted, never silently.
COMPRESSION_RATIO_MAX = 2.4
NO_SPEECH_PROB_MIN = 0.6
AVG_LOGPROB_MIN = -1.0
SILENCE_PHRASES = {
    "thank you for watching",
    "thanks for watching",
    "thank you for watching!",
    "thank you.",
    "thank you",
    "you",
    "subtitles by the amara.org community",
    "please subscribe",
}


def hallucination_reason(segment: Any) -> str | None:
    """Why a decoded segment is not speech we can cite, or None when it is fine."""
    text = str(getattr(segment, "text", "") or "").strip()
    ratio = getattr(segment, "compression_ratio", None)
    no_speech = getattr(segment, "no_speech_prob", None)
    logprob = getattr(segment, "avg_logprob", None)
    if ratio is not None and float(ratio) > COMPRESSION_RATIO_MAX:
        return f"repetitive decode (compression ratio {float(ratio):.2f} > {COMPRESSION_RATIO_MAX})"
    if (
        no_speech is not None
        and logprob is not None
        and float(no_speech) > NO_SPEECH_PROB_MIN
        and float(logprob) < AVG_LOGPROB_MIN
    ):
        return "probably not speech (high no-speech probability, low confidence)"
    if text.lower().strip(" .!") in {p.strip(" .!") for p in SILENCE_PHRASES} and (
        no_speech is None or float(no_speech) > 0.3
    ):
        return "stock phrase Whisper produces on silence or music"
    return None


def transcribe_audio(audio: Path, model: Any) -> dict[str, Any]:
    if model is None:
        return {
            "status": "pending",
            "language": None,
            "language_probability": None,
            "segments": [],
            "limitation": "faster-whisper is not installed or its model could not be loaded",
        }
    raw_segments, info = model.transcribe(
        str(audio), beam_size=5, vad_filter=True, condition_on_previous_text=True
    )
    segments = []
    dropped: list[dict[str, Any]] = []
    for index, segment in enumerate(raw_segments, start=1):
        text = segment.text.strip()
        if not text:
            continue
        reason = hallucination_reason(segment)
        if reason:
            dropped.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": text[:120],
                    "reason": reason,
                }
            )
            continue
        confidence = min(max(math.exp(float(segment.avg_logprob)), 0.0), 1.0)
        segments.append(
            TranscriptSegment(
                segment_id=str(index),
                start=float(segment.start),
                end=float(segment.end),
                text=text,
                language=info.language,
                confidence=confidence,
            )
        )
    return {
        "status": "complete",
        "language": info.language,
        "language_probability": float(info.language_probability),
        "segments": [segment.model_dump(mode="json") for segment in segments],
        "dropped_segments": dropped,
        "limitation": "Local automated transcription may contain errors and requires review.",
    }


def write_transcript_files(
    project: Project, package: Path, video_id: str, transcript: dict[str, Any]
) -> None:
    segments = [TranscriptSegment.model_validate(item) for item in transcript.get("segments", [])]
    text_content = "\n".join(segment.text for segment in segments) + ("\n" if segments else "")
    srt_content = render_srt(segments)
    json_content = json.dumps({"video_id": video_id, **transcript}, indent=2, sort_keys=True) + "\n"
    (package / "transcript.json").write_text(json_content)
    (package / "transcript.txt").write_text(text_content)
    (package / "transcript.srt").write_text(srt_content)
    project_transcripts = project.root / "transcripts"
    (project_transcripts / f"{video_id}.json").write_text(json_content)
    (project_transcripts / f"{video_id}.txt").write_text(text_content)
    (project_transcripts / f"{video_id}.srt").write_text(srt_content)


def evidence_package_complete(path: Path) -> bool:
    """Return true only when the evidence needed for useful extraction is present."""
    try:
        evidence = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    coverage = evidence.get("evidence_coverage") or {}
    return bool(coverage.get("transcript") and coverage.get("ocr"))


def preprocess_project(project: Project, whisper_model: str = "base.en") -> dict[str, int]:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg and ffprobe are required for preprocessing")
    with project.database.connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM sources
            WHERE media_type IN ('video', 'carousel_video') AND in_scope=1
            """
        ).fetchall()
    transcription_model: Any = None
    model_load_attempted = False
    complete = failed = skipped = 0
    for row in rows:
        source = dict(row)
        video_id = source["source_id"]
        local_path = source.get("local_path")
        media_file = resolve_local(project.root, local_path) if local_path else None
        if not media_file or not media_file.exists():
            project.database.start_stage("preprocess", video_id)
            project.database.finish_stage(
                "preprocess", video_id, "retryable_failure", "Local video file is unavailable"
            )
            failed += 1
            continue
        package = project.root / "evidence" / video_id
        if evidence_package_complete(package / "evidence.json"):
            skipped += 1
            continue
        project.database.start_stage("preprocess", video_id)
        try:
            metadata = probe(media_file)
            duration = duration_seconds(metadata)
            audio_path = project.root / "audio" / f"{video_id}.wav"
            has_audio = any(
                stream.get("codec_type") == "audio" for stream in metadata.get("streams", [])
            )
            if has_audio:
                extract_audio(media_file, audio_path)
            try:
                scenes = detect_scene_timestamps(media_file)
            except subprocess.CalledProcessError:
                scenes = []
            latest_safe_frame = max(duration - min(0.5, duration / 2), 0)
            scenes = [timestamp for timestamp in scenes if timestamp <= latest_safe_frame]
            timestamps = sorted(set(frame_timestamps(duration)) | set(scenes))
            frames = extract_frames(media_file, package / "frames", timestamps, set(scenes))
            ocr_results = extract_ocr(frames)
            package.mkdir(parents=True, exist_ok=True)
            if has_audio:
                if not model_load_attempted:
                    try:
                        transcription_model = load_whisper_model(whisper_model)
                    except (OSError, RuntimeError, ValueError):
                        transcription_model = None
                    model_load_attempted = True
                transcript = transcribe_audio(audio_path, transcription_model)
            else:
                transcript = {
                    "status": "unavailable_no_audio",
                    "language": None,
                    "language_probability": None,
                    "segments": [],
                    "limitation": "The source contains no audio stream.",
                }
            write_transcript_files(project, package, video_id, transcript)
            source_data = {
                "video_id": video_id,
                "source_url": source["source_url"],
                "published_at": source["published_at"],
                "caption": source["caption"],
                "retrieved_at": source["retrieved_at"],
                "completeness": "Completeness could not be independently verified",
                "media_probe": metadata,
            }
            (package / "source.json").write_text(
                json.dumps(source_data, indent=2, sort_keys=True) + "\n"
            )
            ocr_status = "complete" if shutil.which("tesseract") else "pending"
            (package / "ocr.json").write_text(
                json.dumps({"status": ocr_status, "results": ocr_results}, indent=2) + "\n"
            )
            (package / "visual-events.json").write_text(
                json.dumps(
                    {
                        "scene_detection": {
                            "status": "complete",
                            "threshold": 0.2,
                            "count": len(scenes),
                        },
                        "frames": frames,
                        "events": [
                            {
                                "event_id": f"{video_id}-scene-{timestamp:.3f}",
                                "timestamp": timestamp,
                                "type": "scene_change",
                                "attribution": "automated_signal",
                            }
                            for timestamp in scenes
                        ],
                    },
                    indent=2,
                )
                + "\n"
            )
            statements = []
            if source["caption"].strip():
                caption_statement = EvidenceStatement(
                    evidence_id=f"{video_id}-caption",
                    video_id=video_id,
                    source_url=(
                        source["source_url"]
                        if source["source_url"]
                        and source["source_url"].startswith(("http://", "https://"))
                        else None
                    ),
                    published_at=source["published_at"],
                    timestamp_start=0,
                    timestamp_end=0,
                    evidence_type=EvidenceType.CAPTION,
                    content=source["caption"],
                    confidence=1,
                )
                project.database.save_evidence(caption_statement)
                statements.append(caption_statement.model_dump(mode="json"))
            for item in ocr_results:
                ocr_statement = EvidenceStatement(
                    evidence_id=f"{video_id}-ocr-{item['frame_id']}",
                    video_id=video_id,
                    source_url=(
                        source["source_url"]
                        if source["source_url"]
                        and source["source_url"].startswith(("http://", "https://"))
                        else None
                    ),
                    published_at=source["published_at"],
                    timestamp_start=item["timestamp_start"],
                    timestamp_end=item["timestamp_end"],
                    evidence_type=EvidenceType.OCR,
                    content=item["text"],
                    confidence=item["confidence"],
                )
                project.database.save_evidence(ocr_statement)
                statements.append(ocr_statement.model_dump(mode="json"))
            for item in transcript["segments"]:
                spoken_statement = EvidenceStatement(
                    evidence_id=f"{video_id}-spoken-{item['segment_id']}",
                    video_id=video_id,
                    source_url=(
                        source["source_url"]
                        if source["source_url"]
                        and source["source_url"].startswith(("http://", "https://"))
                        else None
                    ),
                    published_at=source["published_at"],
                    timestamp_start=item["start"],
                    timestamp_end=item["end"],
                    evidence_type=EvidenceType.SPOKEN,
                    content=item["text"],
                    confidence=item["confidence"] or 0.5,
                )
                project.database.save_evidence(spoken_statement)
                statements.append(spoken_statement.model_dump(mode="json"))
            evidence = {
                "video_id": video_id,
                "statements": statements,
                "confidence": max((item["confidence"] for item in statements), default=0.0),
                "evidence_coverage": {
                    "source": True,
                    "audio": has_audio,
                    "baseline_frames": len(frames),
                    "transcript": transcript["status"] in {"complete", "unavailable_no_audio"},
                    "ocr": ocr_status == "complete",
                    "scene_changes": bool(scenes),
                },
                "unresolved_questions": [
                    *(
                        []
                        if transcript["status"] in {"complete", "unavailable_no_audio"}
                        else ["Transcript has not been generated."]
                    ),
                    *([] if has_audio else ["Source video has no audio stream."]),
                    *([] if ocr_status == "complete" else ["OCR has not been generated."]),
                ],
                "assumptions": [],
                "contradictions": [],
                "limitations": ["Baseline preprocessing is not a complete evidence review."],
            }
            (package / "evidence.json").write_text(
                json.dumps(evidence, indent=2, sort_keys=True) + "\n"
            )
            (package / "evidence.md").write_text(
                f"# Evidence: {video_id}\n\n"
                "Status: baseline media, transcript, OCR, and scene signals extracted. "
                "Visual meaning still requires model or human review.\n"
            )
            evidence_ready = bool(
                evidence["evidence_coverage"]["transcript"]
                and evidence["evidence_coverage"]["ocr"]
            )
            if evidence_ready:
                project.database.finish_stage("preprocess", video_id)
                complete += 1
            else:
                project.database.finish_stage(
                    "preprocess",
                    video_id,
                    "retryable_failure",
                    "; ".join(evidence["unresolved_questions"]),
                )
                failed += 1
        except (
            OSError,
            RuntimeError,
            ValueError,
            subprocess.CalledProcessError,
            json.JSONDecodeError,
        ) as error:
            project.database.finish_stage("preprocess", video_id, "retryable_failure", str(error))
            failed += 1
    return {"complete": complete, "skipped": skipped, "failed": failed}


def refresh_visual_evidence(project: Project, threshold: float = 0.2) -> dict[str, int]:
    """Add scene-change frames/OCR without rerunning local transcription."""
    with project.database.connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM sources
            WHERE media_type IN ('video', 'carousel_video') AND in_scope=1
            """
        ).fetchall()
    complete = failed = scenes_found = 0
    for row in rows:
        source = dict(row)
        video_id = source["source_id"]
        local_path = source.get("local_path")
        media_file = resolve_local(project.root, local_path) if local_path else None
        package = project.root / "evidence" / video_id
        if (
            not media_file
            or not media_file.exists()
            or not (package / "evidence.json").exists()
        ):
            failed += 1
            continue
        try:
            metadata = probe(media_file)
            duration = duration_seconds(metadata)
            latest_safe_frame = max(duration - min(0.5, duration / 2), 0)
            scenes = [
                timestamp
                for timestamp in detect_scene_timestamps(media_file, threshold)
                if timestamp <= latest_safe_frame
            ]
            frames = extract_frames(media_file, package / "frames", scenes, set(scenes))
            ocr_results = extract_ocr(frames)

            visual_path = package / "visual-events.json"
            visual = json.loads(visual_path.read_text())
            frame_map = {item["frame_id"]: item for item in visual.get("frames", [])}
            frame_map.update({item["frame_id"]: item for item in frames})
            visual.update(
                {
                    "scene_detection": {
                        "status": "complete",
                        "threshold": threshold,
                        "count": len(scenes),
                    },
                    "frames": list(frame_map.values()),
                    "events": [
                        {
                            "event_id": f"{video_id}-scene-{timestamp:.3f}",
                            "timestamp": timestamp,
                            "type": "scene_change",
                            "attribution": "automated_signal",
                        }
                        for timestamp in scenes
                    ],
                }
            )
            visual_path.write_text(json.dumps(visual, indent=2, sort_keys=True) + "\n")

            ocr_path = package / "ocr.json"
            ocr = json.loads(ocr_path.read_text())
            ocr_map = {item["frame_id"]: item for item in ocr.get("results", [])}
            ocr_map.update({item["frame_id"]: item for item in ocr_results})
            ocr["results"] = list(ocr_map.values())
            ocr_path.write_text(json.dumps(ocr, indent=2, sort_keys=True) + "\n")

            evidence_path = package / "evidence.json"
            evidence = json.loads(evidence_path.read_text())
            statement_map = {item["evidence_id"]: item for item in evidence.get("statements", [])}
            for item in ocr_results:
                statement = EvidenceStatement(
                    evidence_id=f"{video_id}-ocr-{item['frame_id']}",
                    video_id=video_id,
                    source_url=(
                        source["source_url"]
                        if source["source_url"]
                        and source["source_url"].startswith(("http://", "https://"))
                        else None
                    ),
                    published_at=source["published_at"],
                    timestamp_start=item["timestamp_start"],
                    timestamp_end=item["timestamp_end"],
                    evidence_type=EvidenceType.OCR,
                    content=item["text"],
                    confidence=item["confidence"],
                )
                project.database.save_evidence(statement)
                statement_map[statement.evidence_id] = statement.model_dump(mode="json")
            evidence["statements"] = list(statement_map.values())
            evidence["evidence_coverage"]["scene_changes"] = bool(scenes)
            evidence_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
            complete += 1
            scenes_found += len(scenes)
        except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
            project.database.start_stage("refresh_visuals", video_id)
            project.database.finish_stage(
                "refresh_visuals", video_id, "retryable_failure", str(error)
            )
            failed += 1
    return {"complete": complete, "failed": failed, "scenes_found": scenes_found}
