# Creator Library — research sources (open-source survey, 2026-10-21)

What the Creator Library's research side uses, what was considered, and why. Licence, stars and last
push were read from the GitHub API on 2026-10-21 (stars rounded). "Adopted" means the code or the
published method is in use today; nothing here is installed silently — the worker venv is built only by
`npm run vsc:setup`.

## In use

| Job | Project | Licence | Stars | Last push | How it is used |
|---|---|---|---|---|---|
| Public profile ingest (anonymous) | [instaloader/instaloader](https://github.com/instaloader/instaloader) | MIT | 13.6k | 2026-10-14 | Primary ingester; no login unless the owner opts in with their own local session. |
| Business-profile fallback | [mikf/gallery-dl](https://github.com/mikf/gallery-dl) | GPL-2.0 | 20.2k | 2026-10-17 | Run as a separate program (subprocess), never linked into Seen Command's code. |
| Transcription | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT | 26.0k | 2026-10-16 | Local CPU int8, `beam_size=5`, `vad_filter=True` (Silero VAD, bundled). |
| Voice-activity detection | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | MIT | 10.5k | 2026-09-29 | Through faster-whisper's `vad_filter` — music-only stretches are not transcribed. |
| Hallucination guard | [openai/whisper](https://github.com/openai/whisper) | MIT | 111k | 2026-08-31 | **Adopted this round:** Whisper's own thresholds (`compression_ratio_threshold=2.4`, `logprob_threshold=-1.0`, `no_speech_threshold=0.6`, transcribe.py) now drop the segments faster-whisper keeps after every retry failed — repetition loops and "Thank you for watching" on music reels. Dropped segments are listed in the transcript JSON (`dropped_segments`), never silently removed. `media.py hallucination_reason`, tests in `tests/test_hallucination_filter.py`. |
| On-screen text | [tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract) | Apache-2.0 | 77.1k | 2026-10-20 | `--psm 11` (sparse text, right for overlays); word-level confidence from TSV; low-quality OCR is kept raw but never used as evidence (`lib/instagram/evidence-quality.mjs`). |
| Discovery browser | [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI) | Apache-2.0 | 30.5k | 2026-10-20 | Google result pages in the owner's Chrome via the Browser Bridge — the same tool Seen's collectors use. Never instagram.com, never a login; CAPTCHA → stop. |

## Considered, not adopted (yet) — and why

| Job | Project | Licence | Stars | Last push | Verdict |
|---|---|---|---|---|---|
| Word-level alignment + diarization | [m-bain/whisperX](https://github.com/m-bain/whisperX) | BSD-2-Clause | 24.8k | 2026-10-18 | Better word timestamps and speaker turns, but diarization needs pyannote models gated behind a Hugging Face account and token — breaks "anonymous-first, no accounts". Revisit for word timing only. |
| Speaker diarization | [pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio) | MIT (models gated) | 10.7k | 2026-10-20 | Same gate. Reels are almost always one speaker; low value for the cost. |
| Faster local ASR | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | 54.5k | 2026-10-19 | Faster on Apple silicon (Metal), but a second ASR stack; faster-whisper is fast enough at 50 reels. Candidate if transcription becomes the bottleneck. |
| Word timestamps | [linto-ai/whisper-timestamped](https://github.com/linto-ai/whisper-timestamped) | AGPL-3.0 | 2.9k | 2026-09-28 | AGPL — not taken. faster-whisper's own `word_timestamps=True` covers the need if hook timing ever needs sub-segment precision. |
| Stylized overlay OCR | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 | 91.5k | 2026-09-16 | Clearly better on stylized reel captions than Tesseract, but a heavy framework. |
| — lighter runtime | [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) | Apache-2.0 | 8.3k | 2026-10-21 | PaddleOCR models on ONNX Runtime — the best next step for on-screen text. Not adopted in this change because it could not be measured here against real reels (no real creator media in this environment); measure on the owner's Mac first. |
| OCR | [JaidedAI/EasyOCR](https://github.com/JaidedAI/EasyOCR) | Apache-2.0 | 30.1k | 2025-12-05 | PyTorch-heavy; slower on CPU; last push a year ago. |
| OCR | [mindee/doctr](https://github.com/mindee/doctr) | Apache-2.0 | 6.4k | 2026-10-21 | Document-oriented (pages), not video overlays. |
| Shot / segment detection | [Breakthrough/PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | BSD-3-Clause | 5.3k | 2026-10-21 | The compiler already detects scene changes with ffmpeg's scene score (the same content-difference idea); no gain worth a dependency. |
| Topic clustering | [MaartenGr/BERTopic](https://github.com/MaartenGr/BERTopic) | MIT | 7.9k | 2026-10-21 | Needs embeddings + UMAP/HDBSCAN (torch). The Library's topics, pains and hooks stay rule-based so every line is explainable and testable; reconsider once there are 10+ creators and rules miss real themes. |
| Density clustering | [scikit-learn-contrib/hdbscan](https://github.com/scikit-learn-contrib/hdbscan) | BSD-3-Clause | 3.2k | 2026-10-08 | Only useful with embeddings (above). |
| Claim de-dup at scale | [ekzhu/datasketch](https://github.com/ekzhu/datasketch) | MIT | 3.0k | 2026-10-10 | MinHash-LSH matters at hundreds of thousands of claims; the Library has thousands, where exact token similarity (seed-anchored, `insights.mjs`) is cheaper and deterministic. |
| Fuzzy string match | [rapidfuzz/RapidFuzz](https://github.com/rapidfuzz/RapidFuzz) | MIT | 4.2k | 2026-10-21 | Character-level ratios; the Node side stays dependency-free and token sets already merge reworded claims. |

## Rules that do not change

- Anonymous-first: no Instagram login, no account creation, no CAPTCHA solving, no proxy rotation.
- Evidence first: every insight cites a video and timestamp; weak data is labelled, never promoted.
- Models never grade themselves into "strong": strength is counted from independent creators and videos.
