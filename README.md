# whatsapp-evidence

A command-line tool for converting WhatsApp audio messages and screenshots into structured markdown documents suitable for legal proceedings in Brazil.

## Problem

WhatsApp conversations are increasingly used as evidence in legal cases. However, presenting this evidence poses challenges:

- Audio messages require manual transcription, which is time-consuming and error-prone
- Screenshots contain unstructured visual data that is difficult to reference in legal documents
- Both formats lack proper metadata for forensic documentation
- Manual transcription introduces human error and inconsistency

## Solution

This tool automates the conversion of WhatsApp media into professionally formatted markdown documents:

**Audio Transcription**
- Converts `.opus` voice messages to text using ElevenLabs speech-to-text
- Includes speaker diarization (identifies different speakers)
- Preserves timestamps for each utterance
- Outputs structured markdown with full metadata

**Screenshot Extraction**
- Extracts message content from `.jpg` screenshots using vision AI
- Preserves sender names, timestamps, message status, and media types
- Handles replies, forwarded messages, edited messages, and deleted message placeholders
- Infers dates from relative indicators ("HOJE", "ONTEM") using screenshot filename

**Legal Compliance**
- Optional disclaimer for compliance with OAB Recommendation 0001/2024 and CNJ Resolution 615/2025
- Structured output format suitable for court submissions
- Complete metadata preservation for forensic integrity

## Requirements

- [Bun](https://bun.sh) runtime
- [ffmpeg](https://ffmpeg.org) (for audio conversion)
- ElevenLabs API key (for audio transcription)
- OpenAI API key (for screenshot extraction)

## Installation

```bash
bun install
cp .env.example .env
```

Edit `.env` and add your API keys:

```
ELEVENLABS_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
```

## Usage

Place WhatsApp files in the `./to-transcript/` directory, then run:

```bash
# Transcribe both audio and images
bun run transcribe

# Transcribe only audio files
bun run transcribe:audio

# Transcribe only screenshots
bun run transcribe:images

# Include legal disclaimer in output
bun index.ts --disclaimer

# Process a specific directory
bun index.ts ./path/to/files
```

The tool creates a `.md` file alongside each processed file. Already-transcribed files are skipped on subsequent runs.

## Output Format

### Audio Transcription

```markdown
---
arquivo_origem: "PTT-20241219-WA0001.opus"
data_transcricao: "2024-12-19T10:30:00.000Z"
idioma_detectado: "pt"
modelo: "scribe_v1"
---

# Transcricao de Audio

## Metadados
- **Arquivo de origem:** `PTT-20241219-WA0001.opus`
- **Data da transcricao:** 19/12/2024 as 10:30:00

## Transcricao Completa

**[00:00.00 - 00:05.23] speaker_1:**
> Bom dia, estou ligando sobre o contrato...
```

### Screenshot Extraction

```markdown
---
arquivo_origem: "IMG-20241219-WA0042.jpg"
chat: "Joao Silva"
tipo_chat: "individual"
total_mensagens: 5
---

# Transcricao de Captura WhatsApp

## Metadados
- **Arquivo de origem:** `IMG-20241219-WA0042.jpg`
- **Chat:** Joao Silva
- **Tipo:** Conversa individual

## Mensagens

### 19/12/2024 14:30 - Joao Silva
> Segue o documento assinado

### 19/12/2024 14:32 - Eu
> Recebi, obrigado
```

## File Naming Convention

WhatsApp exports files with predictable naming:
- Audio: `PTT-YYYYMMDD-WA####.opus`
- Images: `IMG-YYYYMMDD-WA####.jpg`

The date in the filename is used to resolve relative date references ("HOJE", "ONTEM") in screenshots.

## Limitations

- Audio transcription quality depends on recording clarity and background noise
- Screenshot extraction accuracy depends on image quality and WhatsApp UI version
- Relative dates in screenshots are inferred from filename; verify against original if critical
- The tool processes Portuguese (Brazilian) content by default

## Disclaimer

**⚠️ Always review AI-generated content before use.**

This tool uses artificial intelligence to transcribe audio and extract text from images. AI systems can make errors, misinterpret content, or produce inaccurate transcriptions. Before using any output from this tool in legal proceedings or other contexts:

- **Verify all transcriptions** against the original audio and images
- **Check for accuracy** in speaker attribution, timestamps, and message content
- **Review extracted text** for potential misreadings or omissions

The authors and contributors of this project accept **no responsibility** for:

- Errors or inaccuracies in AI-generated transcriptions
- Misuse of this tool or its output
- Legal consequences arising from reliance on unverified transcriptions
- Any damages resulting from the use of this software

**Use at your own risk.** This tool is provided "as is" without warranty of any kind. Users are solely responsible for verifying the accuracy of all output and ensuring compliance with applicable laws and regulations.

## License

Individual Use License - see [LICENSE](LICENSE).

Free for solo practitioners (individual lawyers, developers). Not permitted for organizations, law firms, or commercial software products.
