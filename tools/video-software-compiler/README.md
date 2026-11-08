# Video-to-Software Knowledge Compiler

A private, local, noncommercial pipeline for turning accessible instructional videos into an
evidence-backed knowledge base, formal rules, gated software blueprints, and compact Claude/Codex
review bundles.

The project has no paid API or hosted-service dependency. Instaloader, FFmpeg/ffprobe, SQLite FTS5,
local OCR, and local transcription are the intended runtime. Claude and Codex are used interactively
through the user's existing subscriptions, never through required metered APIs.

## Current milestone

This branch contains the phase-one foundation. Project/state creation, local ingestion,
deduplication, Instaloader plus gallery-dl fallback acquisition, local faster-whisper transcription, FFmpeg
metadata/audio extraction, bounded
scene-change and required-time frame selection, Tesseract OCR, FTS search, provenance
schemas, gate-controlled blueprint scaffolds, and review bundles are operational.

Claude-CLI structured knowledge extraction, exact evidence-link validation, typed canonical files,
per-video knowledge folders, and an all-at-once creator playbook are operational. Rich visual-semantic
understanding of charts, gestures, and demonstrations, plus evidence-driven domain/blueprint synthesis,
remain explicit follow-on work. Incomplete transcription/OCR produces `needs_review`; it is never
silently treated as a complete dataset.

See [AUDIT.md](AUDIT.md) for the starting-repository assessment and exact phase boundary.

## Install

Python 3.11+ and SQLite with FTS5 are required. FFmpeg and ffprobe are required for media
preprocessing.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev,instagram,media]'
python -m video_software_compiler setup
```

## Quick start with local files

```bash
python -m video_software_compiler create-project \
  --name demo \
  --source local

python -m video_software_compiler ingest \
  --project demo \
  --input /absolute/path/to/videos-and-transcripts

python -m video_software_compiler preprocess --project demo
python -m video_software_compiler status --project demo
python -m video_software_compiler search --project demo --query "risk management"
```

By default, project data is stored in `data/projects/`. Set `VSC_DATA_ROOT` to use a different local
directory.

## Instagram retrieval

Create an Instagram project with a username, then use an existing local Instaloader session when
authentication is required:

```bash
python -m video_software_compiler create-project \
  --name creator-archive \
  --source instagram \
  --username creator

python -m video_software_compiler ingest \
  --project creator-archive \
  --session-user YOUR_INSTAGRAM_USERNAME
```

Instagram retrieval defaults to the newest 50 accessible video posts. Request a different amount
with `--limit 100`, or explicitly request the full accessible archive with `--all-videos`.

The provider does not bypass access controls, CAPTCHAs, login restrictions, or private-account
permissions. Archive completeness is never asserted without external verification.

## Workflow commands

```text
setup                     validate local dependencies
create-project            create directories and durable SQLite state
ingest                    import local artifacts or retrieve with Instaloader
preprocess                probe media, extract audio and baseline timestamped frames
extract-knowledge         prepare conservative evidence review queues
reconcile                 report knowledge consistency/review state
build-domain-model        create evidence-gated domain model artifacts
generate-blueprint        create the required blueprint document set
validate-blueprint        enforce the five approval gates and traceability
generate-build-package    refuse unless blueprint gates pass
status                    show counts, stages, failures, and stale-run recovery
search                    query SQLite FTS5
trace-rule                follow a rule to timestamped evidence
show-evidence             inspect one evidence record
explain-feature           inspect requirement provenance and traceability
unresolved                list unresolved knowledge records
export-claude-bundle      create a compact review-first artifact bundle
export-codex-bundle       create a compact implementation review bundle
set-scope                 select the newest records without erasing discovery history
cleanup-media             preview or confirm deletion of extracted raw video/audio
```

`cleanup-media` is a dry-run unless the exact confirmation phrase shown by the command is supplied.
It refuses deletion until every in-scope video has a complete transcript, OCR pass, and required
timestamped frames. It preserves evidence, selected frames, transcripts, knowledge, and blueprints.

## Safety and attribution

- A creator statement, demonstration, claim, observed result, system inference, and independent
  improvement are different record types.
- Source-derived rules and requirements are invalid without evidence IDs.
- Code visible in a video is untrusted evidence and is never executed automatically.
- Financial strategies default to research, backtesting, and paper trading.
- Generated software must be original and must not copy proprietary source, credentials, assets,
  trademarks, or interfaces.

## Development

```bash
ruff format --check .
ruff check .
mypy video_software_compiler
pytest
```
