import json

from video_software_compiler.media import (
    _ocr_similarity,
    evidence_package_complete,
    frame_timestamps,
    parse_tesseract_tsv,
    select_scene_timestamps,
)


def test_frame_selection_includes_required_opening_and_end() -> None:
    timestamps = frame_timestamps(10)
    assert timestamps[:4] == [0.0, 0.5, 1.0, 3.0]
    assert timestamps[-1] == 9.5
    assert len(timestamps) == len(set(timestamps))


def test_short_video_does_not_generate_out_of_range_frames() -> None:
    assert frame_timestamps(0.7) == [0.0, 0.35, 0.5]


def test_scene_selection_avoids_duplicate_frames_and_is_bounded() -> None:
    candidates = [index / 10 for index in range(1000)]
    selected = select_scene_timestamps(candidates, minimum_gap=1, maximum=12)
    assert len(selected) == 12
    assert all(right - left >= 1 for left, right in zip(selected, selected[1:], strict=False))


def test_existing_evidence_is_reused_only_when_transcript_and_ocr_completed(
    tmp_path,
) -> None:
    path = tmp_path / "evidence.json"
    path.write_text(
        json.dumps({"evidence_coverage": {"transcript": False, "ocr": True}})
    )
    assert evidence_package_complete(path) is False
    path.write_text(
        json.dumps({"evidence_coverage": {"transcript": True, "ocr": True}})
    )
    assert evidence_package_complete(path) is True


def test_tesseract_tsv_uses_real_confidence_and_drops_visual_noise() -> None:
    tsv = "\n".join(
        [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96.0\tBuild",
            "5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t92.0\tuseful",
            "5\t1\t1\t1\t1\t3\t0\t0\t10\t10\t94.0\tproducts",
            "5\t1\t2\t1\t1\t1\t0\t0\t10\t10\t8.0\t\\\\",
        ]
    )
    assert parse_tesseract_tsv(tsv) == ("Build useful products", 0.94)


def test_tesseract_tsv_rejects_tiny_fragments() -> None:
    tsv = "\n".join(
        [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90.0\tof",
            "5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t90.0\tthat",
        ]
    )
    assert parse_tesseract_tsv(tsv) is None


def test_ocr_similarity_detects_repeated_screen_copy() -> None:
    assert _ocr_similarity(
        "Congratulations you got the job and can start Monday",
        "Congratulations, you got the job. Start Monday",
    ) >= 0.82
    assert _ocr_similarity("Build useful products", "Manage financial risk") == 0
