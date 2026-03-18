# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**whatsapp-evidence** is a CLI tool for legal documentation in Brazil. Converts WhatsApp audio files (.opus, .ogg, .oga, .m4a), video files (.mp4), and screenshot images (.jpg, .jpeg) into structured markdown documents suitable for use as legal evidence. All output is in Portuguese (Brazilian).

## Commands

```bash
# Install dependencies
bun install

# Transcribe both audio and images (default)
bun run transcribe

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
index.ts              # CLI entry point, argument parsing, orchestration
├── transcribe-audio.ts   # ElevenLabs API for .opus/.ogg/.oga/.m4a/.mp4 → markdown
├── transcribe-images.ts  # BAML vision (OpenAI) for .jpg/.jpeg → markdown
└── shared.ts             # Common utilities, types, file discovery

baml_src/             # BAML schema definitions
├── whatsapp.baml     # Message extraction schema and prompt
├── clients.baml      # LLM provider configurations
└── generators.baml   # TypeScript client generation config

baml_client/          # Auto-generated TypeScript client (from BAML)
```

### Processing Flow

1. **Audio/Video (.opus, .ogg, .oga, .m4a, .mp4)**: Sent directly to ElevenLabs Scribe v2 → speech-to-text → markdown with speaker diarization
2. **Images (.jpg, .jpeg)**: Base64 encode → BAML vision (OpenAI GPT) → structured extraction → markdown

### Key Design Decisions

- Files are processed from `./to-transcript/` by default
- Existing transcriptions (.md files) are skipped to allow incremental processing
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
