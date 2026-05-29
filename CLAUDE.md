# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**whatsapp-evidence** is a CLI tool for legal documentation in Brazil. It turns WhatsApp data into structured markdown documents suitable for use as legal evidence. All output is in Portuguese (Brazilian). The CLI has two entry paths:

- **`ingest` subcommand** — consumes full WhatsApp-exported `.zip` files directly (chat log + bundled media), parses the conversation, deduplicates, splits by time period, and renders organized markdown evidence. This is the primary, higher-level workflow.
- **`transcribe` (default) subcommand** — operates on *already-extracted*, loose media files: audio (.opus, .ogg, .oga, .m4a), video (.mp4), and screenshot images (.jpg, .jpeg) → transcribed/extracted markdown.

## System Requirements

- **Bun** runtime
- **unzip** on `PATH` — used by the `ingest` subcommand to extract WhatsApp `.zip`
  exports. Preinstalled on macOS; on Linux install with `apt install unzip`.
- **ffmpeg** + **ffprobe** on `PATH` — used to split audio files longer than the
  per-chunk limit (default 50 min) before sending to ElevenLabs, which times out on
  uploads taking >5 min. Install with `brew install ffmpeg` (macOS) or
  `apt install ffmpeg` (Linux). If ffprobe is unavailable the CLI falls back to
  sending each file whole (legacy behavior — long files will time out).

## Commands

```bash
# Install dependencies
bun install

# --- Ingest: full WhatsApp .zip exports → organized evidence (primary workflow) ---

# Ingest all .zip files from ./to-ingest/ → markdown in ./evidence/
bun run ingest                       # alias for: bun index.ts ingest

# Preview without writing anything to disk
bun run ingest:dry-run               # alias for: bun index.ts ingest --dry-run

# Common options (see `bun index.ts ingest --help` for the full list)
bun index.ts ingest --input ./exports --output ./evidence
bun index.ts ingest --split 1mo                 # period: 1w, 2w, 1mo, 3mo, 1y (default 1w)
bun index.ts ingest --layout by-contact         # by-period (default) or by-contact
bun index.ts ingest --media all                 # transcribe bundled media: none (default), audio, images, all
bun index.ts ingest --self "Seu Nome"           # identify yourself in the exports
bun index.ts ingest --alias "Joao S=João Silva" # unify display names (repeatable)
bun index.ts ingest --disclaimer                # append OAB/CNJ legal disclaimer
bun index.ts ingest --regenerate --contact "João Silva"  # re-render markdown from the saved index

# --- Transcribe: loose, already-extracted media files (legacy/default subcommand) ---

# Transcribe both audio and images (default)
bun run transcribe

# Override the per-chunk size limit for splitting long audio (default 50, max 60 min)
bun index.ts --chunk-minutes 30

# Override how many parts of one file transcribe in parallel (default 3, max 5)
bun index.ts --chunk-concurrency 1   # serialize if hitting ElevenLabs rate limits

# Transcribe only audio files
bun run transcribe:audio

# Transcribe only screenshot images
bun run transcribe:images

# Include legal disclaimer in output
bun index.ts --disclaimer

# Process specific directory
bun index.ts ./my-files

# Regenerate BAML client after modifying .baml files
bun run baml:generate

# Cleanup script (removes old "Texto Integral" sections)
bun run cleanup

# Type check the project
bun run typecheck

# Lint and format with Biome (auto-fix)
bun run check
```

## Architecture

```
index.ts              # CLI entry point. Routes `ingest` subcommand (args[0] === "ingest")
│                      #   to ingest/; everything else falls through to transcribe (default)
├── transcribe-audio.ts   # ElevenLabs API for .opus/.ogg/.oga/.m4a/.mp4 → markdown
├── transcribe-images.ts  # BAML vision (OpenAI) for .jpg/.jpeg → markdown
└── shared.ts             # Common utilities, types, file discovery

ingest/               # `ingest` subcommand — full WhatsApp .zip export pipeline
├── cli.ts            # Arg parser + help text for `ingest` (IngestOptions)
├── orchestrator.ts   # runIngest(): extract zips → parse → dedup → split → render → save
├── zip.ts            # Find/extract .zip exports (shells out to `unzip`), locate chat log, move media
├── parser.ts         # Parse WhatsApp chat-log text → structured messages
├── contacts.ts       # Contact-name parsing, self-detection, alias unification
├── dedup.ts          # Deduplicate messages across overlapping exports
├── splitter.ts       # Assign messages to time periods (1w/2w/1mo/3mo/1y)
├── renderer.ts       # Render period/contact markdown
├── media.ts          # Optional media transcription (--media) via transcribe-audio/images
├── store.ts          # Persistent evidence index (incremental re-ingest, regeneration)
└── types.ts          # IngestOptions, MessageEntry, EvidenceIndex, etc.

baml_src/             # BAML schema definitions
├── whatsapp.baml     # Message extraction schema and prompt
├── clients.baml      # LLM provider configurations
└── generators.baml   # TypeScript client generation config

baml_client/          # Auto-generated TypeScript client (from BAML)
```

### Processing Flow

**Ingest (`bun index.ts ingest`)** — full `.zip` exports:

1. Discover `*.zip` in `--input` (default `./to-ingest/`) and extract each with `unzip`
2. Locate the chat log (`_chat.txt`, `_conversa.txt`, or `WhatsApp Chat*.txt`), decode (UTF-8 with Latin-1/windows-1252 fallback), cache it, and move bundled media to a shared `medias/` dir
3. Parse the chat log → structured messages; detect/unify contacts and self
4. Deduplicate against previously-ingested messages (overlapping exports are common)
5. Assign messages to time periods (`--split`) and render markdown (`--layout`)
6. Optionally transcribe bundled media (`--media`), reusing the transcribe pipeline below
7. Persist an evidence index in `--output` (default `./evidence/`) for incremental re-ingest and `--regenerate`

**Transcribe (default subcommand)** — loose media files:

1. **Audio/Video (.opus, .ogg, .oga, .m4a, .mp4)**: Sent directly to ElevenLabs Scribe v2 → speech-to-text → markdown with speaker diarization
2. **Images (.jpg, .jpeg)**: Base64 encode → BAML vision (OpenAI GPT) → structured extraction → markdown

### Key Design Decisions

- `ingest` reads `.zip` exports from `./to-ingest/` and writes to `./evidence/`; `transcribe` processes loose files from `./to-transcript/`
- `ingest` keeps a persistent evidence index so re-running is incremental and idempotent (deduplicates across overlapping exports); `--regenerate` rebuilds markdown from the index without re-parsing zips
- `transcribe` skips existing transcriptions (.md files) to allow incremental processing
- Legal disclaimer can be appended for compliance with OAB Recommendation 0001/2024 and CNJ Resolution 615/2025

## Environment Variables

Required in `.env`:
- `ELEVENLABS_API_KEY` - For audio transcription
- `OPENAI_API_KEY` - For image extraction via BAML

## BAML

Uses [@boundaryml/baml](https://docs.boundaryml.com) for structured LLM outputs. After modifying files in `baml_src/`:

```bash
bun run baml:generate
```

The generated client in `baml_client/` provides type-safe access to the `ExtractWhatsAppMessages` function.

## Runtime

Use Bun exclusively:
- `bun <file>` instead of node/ts-node
- `bun test` instead of jest/vitest
- `Bun.file()` instead of fs.readFile
- `Bun.$\`cmd\`` instead of execa
- Bun auto-loads `.env`
