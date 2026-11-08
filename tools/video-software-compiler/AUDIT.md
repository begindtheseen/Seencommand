# Repository Audit

Audit date: 2026-07-31  
Starting point: `bradautomates/head-of-content` at the fetched `origin/main` revision  
Target branch: `video-to-software-compiler`

## Executive finding

The starting repository is a collection of six packaged Claude skills, not a general video
knowledge compiler. Its useful contribution is its convention for focused skills, timestamped
research outputs, staged raw-to-report processing, and human-readable reports. Its acquisition and
analysis implementations cannot meet this project's zero-metered-cost, whole-archive,
evidence-provenance, or software-generation requirements.

The original `.skill` archives remain intact as historical scaffold material. The new compiler is
implemented separately in `video_software_compiler/` and the new Claude workflow in
`.claude/skills/video-to-software-compiler/`.

## Starting repository inventory

| Item | Original purpose | Audit disposition |
|---|---|---|
| `instagram-research.skill` | Apify ingestion, outlier scoring, five-video analysis | Isolated; paid/metered and limited |
| `tiktok-research.skill` | Apify ingestion and outlier analysis | Isolated; paid/metered and content-marketing-specific |
| `x-research.skill` | Apify tweet collection and outlier analysis | Isolated; outside immediate video scope |
| `youtube-research.skill` | TubeLab search/transcripts and outliers | Isolated; hosted API and outlier-only assumptions |
| `video-content-analyzer.skill` | Gemini hook/CTA analysis | Isolated; cloud model API and shallow content schema |
| `content-planner.skill` | Cross-platform marketing plan orchestration | Isolated; wrong product objective |
| `CLAUDE.md` | Instructions for the original marketing skills | Historical; does not govern the new compiler skill |
| `README.md` | Original Head of Content setup | Replaced with compiler setup and truthful phase status |

## Paid, hosted, or metered dependencies found

- Apify (`APIFY_TOKEN`) for Instagram, TikTok, and X acquisition.
- TubeLab (`TUBELAB_API_KEY`) for YouTube outliers and transcripts.
- Google Gemini (`GEMINI_API_KEY`, `google-genai`) for video analysis.
- The original README explicitly describes paid subscriptions and per-run costs.
- The original analyzer sends remote video URLs/content to a cloud model.

None are dependencies of the new package. No cloud API credential is read by the new package.

## Fixed limits and selection bias found

- Instagram defaults to 30 days and 50 posts per account.
- Instagram and TikTok analyze only five selected videos.
- YouTube analyzes only three selected relevant videos.
- Analysis is performed primarily on statistical outliers rather than the whole accessible archive.
- The output schema targets hooks, retention, calls to action, and content ideas rather than rules,
  formulas, workflows, contradictions, or software requirements.

These assumptions are incompatible with complete-source discovery. New ingestion has no arbitrary
date or item limit. It also never claims independent completeness.

## Provenance and durability gaps found

- No durable SQLite stage state, stale-run recovery, or item-level retry status.
- No evidence IDs tied to exact timestamps.
- No distinction among explicit teaching, demonstrations, claims, observed results, inference, and
  independent improvement.
- No contradiction history, rule versioning, traceability matrix, approval gates, or build bundles.
- Timestamped run folders help organization but do not make processing resumable or idempotent.
- No local transcription/OCR pipeline and no offline mode.

## Reusable conventions preserved

- A narrowly scoped `SKILL.md` with prerequisites, routing, workflow, and output expectations.
- Organized intermediate and human-readable outputs rather than a single opaque report.
- Batch-oriented processing and explicit error reporting.
- Platform acquisition separated conceptually from analysis.
- Reports that surface source links.

## Security, licensing, and access notes

- Instaloader is used only through normal public access or a user's existing local authenticated
  session. The compiler does not solve CAPTCHAs or bypass private-account controls.
- Downloaded material remains local. Users are responsible for having lawful access and respecting
  platform terms and applicable copyright.
- Code, credentials, and proprietary assets shown in videos are evidence only and must not be
  executed or copied without review and authorization.
- Source-derived behavior must remain distinguishable from original implementation choices.

## Phase-one boundary

Operational in this milestone: project creation, SQLite/FTS state, source deduplication, local file
and transcript import, optional Instaloader acquisition, FFmpeg probing/audio, bounded scene-change
and baseline frames, optional Tesseract OCR, evidence package scaffolds, conservative workflow
gates, search/trace command surfaces, bundle exports, setup diagnostics, and model validation.

Not yet implemented: gallery-dl provider, richer interface change selection, deterministic
extraction of reviewed evidence into knowledge, semantic
reconciliation, domain-model synthesis, and blueprint synthesis. Their command surfaces produce
explicit `needs_review` artifacts or refuse unsafe progression; they do not claim completion.
