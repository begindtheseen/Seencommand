from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from video_software_compiler.media import hallucination_reason, transcribe_audio


def seg(text: str, start: float = 0.0, end: float = 2.0, **kw: float) -> SimpleNamespace:
    base = {"avg_logprob": -0.2, "compression_ratio": 1.4, "no_speech_prob": 0.05}
    base.update(kw)
    return SimpleNamespace(text=text, start=start, end=end, **base)


def test_real_speech_is_kept() -> None:
    assert hallucination_reason(seg("If you got ghosted after the interview, do this.")) is None
    # A creator saying "thank you" over clear speech is kept (low no-speech probability).
    assert hallucination_reason(seg("Thank you.", no_speech_prob=0.02)) is None


def test_repetition_loops_and_silence_phrases_are_dropped() -> None:
    loop = seg("apply apply apply apply apply apply apply apply", compression_ratio=3.1)
    assert "compression ratio 3.10" in (hallucination_reason(loop) or "")
    music = seg("I'm going to go to the store", no_speech_prob=0.85, avg_logprob=-1.4)
    assert "not speech" in (hallucination_reason(music) or "")
    stock = seg("Thank you for watching!", no_speech_prob=0.5)
    assert "stock phrase" in (hallucination_reason(stock) or "")


def test_transcribe_counts_what_it_dropped(tmp_path: Path) -> None:
    class FakeModel:
        def transcribe(
            self, *_a: object, **_k: object
        ) -> tuple[list[SimpleNamespace], SimpleNamespace]:
            return (
                [
                    seg("Stop applying on Easy Apply.", 0.0, 2.0),
                    seg("Thank you for watching", 2.0, 4.0, no_speech_prob=0.7),
                    seg("Recruiters read the first line.", 4.0, 6.0),
                ],
                SimpleNamespace(language="en", language_probability=0.99),
            )

    out = transcribe_audio(tmp_path / "a.wav", FakeModel())
    assert [s["text"] for s in out["segments"]] == [
        "Stop applying on Easy Apply.",
        "Recruiters read the first line.",
    ]
    assert len(out["dropped_segments"]) == 1
    assert out["dropped_segments"][0]["start"] == 2.0
