// =============================================================================
// Audio Transcription Module - ElevenLabs Speech-to-Text
// Converts WhatsApp .opus audio files to markdown transcriptions
// =============================================================================

import {
	CONFIG,
	filterPendingFiles,
	findFiles,
	getFilename,
	getMdPath,
	LEGAL_DISCLAIMER,
	type ProcessingStats,
	processFiles,
} from "./shared";

// ===== Audio-Specific Configuration =====

const AUDIO_CONFIG = {
	API_URL: "https://api.elevenlabs.io/v1/speech-to-text",
	MODEL_ID: "scribe_v1",
	LANGUAGE_CODE: "pt",
	EXTENSION: "opus",
} as const;

// ===== Type Definitions =====

interface ElevenLabsWord {
	text: string;
	start: number | null;
	end: number | null;
	type: "word" | "spacing" | "audio_event";
	speaker_id: string | null;
	logprob: number;
}

interface ElevenLabsTranscription {
	language_code: string;
	language_probability: number;
	text: string;
	words: ElevenLabsWord[];
	transcription_id: string | null;
}

interface AudioTranscriptionResult {
	sourceFile: string;
	transcription: ElevenLabsTranscription;
	processedAt: Date;
}

interface Utterance {
	speaker: string;
	startTime: number | null;
	endTime: number | null;
	text: string;
}

export interface TranscribeOptions {
	includeDisclaimer?: boolean;
}

// Module-level options (set by transcribeAudio)
let currentOptions: TranscribeOptions = {};

// ===== Audio Processing Functions =====

/**
 * Convert OPUS to MP3 using ffmpeg
 */
async function convertOpusToMp3(opusPath: string): Promise<string> {
	const filename = getFilename(opusPath).replace(".opus", ".mp3");
	const tempDir = CONFIG.TEMP_DIR;
	const mp3Path = `${tempDir}/${filename}`;

	// Ensure temp directory exists
	await Bun.$`mkdir -p ${tempDir}`.quiet();

	// Convert with ffmpeg
	const result =
		await Bun.$`ffmpeg -y -i ${opusPath} -codec:a libmp3lame -qscale:a 2 ${mp3Path}`.quiet();

	if (result.exitCode !== 0) {
		throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
	}

	return mp3Path;
}

/**
 * Call ElevenLabs speech-to-text API
 */
async function callElevenLabsAPI(
	mp3Path: string,
): Promise<ElevenLabsTranscription> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) {
		throw new Error("ELEVENLABS_API_KEY not found in environment");
	}

	const file = Bun.file(mp3Path);
	const fileBlob = await file.arrayBuffer();
	const filename = getFilename(mp3Path);

	// Build multipart/form-data
	const formData = new FormData();
	formData.append(
		"file",
		new Blob([fileBlob], { type: "audio/mpeg" }),
		filename,
	);
	formData.append("model_id", AUDIO_CONFIG.MODEL_ID);
	formData.append("language_code", AUDIO_CONFIG.LANGUAGE_CODE);
	formData.append("diarize", "true");
	formData.append("timestamps_granularity", "word");
	formData.append("tag_audio_events", "true");

	const response = await fetch(AUDIO_CONFIG.API_URL, {
		method: "POST",
		headers: {
			"xi-api-key": apiKey,
		},
		body: formData,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<ElevenLabsTranscription>;
}

/**
 * Format timestamp as MM:SS.ms
 */
function formatTimestamp(seconds: number | null): string {
	if (seconds === null) return "--:--";
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 100);
	return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

/**
 * Format transcription as legal-style markdown document
 */
function formatAudioAsMarkdown(result: AudioTranscriptionResult): string {
	const { sourceFile, transcription, processedAt } = result;
	const filename = getFilename(sourceFile);

	// Group words by speaker for formatted output
	const utterances: Utterance[] = [];
	let currentUtterance: Utterance | null = null;

	for (const word of transcription.words) {
		if (word.type === "spacing") continue;

		const speaker = word.speaker_id ?? "Desconhecido";

		if (!currentUtterance || currentUtterance.speaker !== speaker) {
			if (currentUtterance) {
				utterances.push(currentUtterance);
			}
			currentUtterance = {
				speaker,
				startTime: word.start,
				endTime: word.end,
				text: word.text,
			};
		} else {
			currentUtterance.text += ` ${word.text}`;
			currentUtterance.endTime = word.end;
		}
	}
	if (currentUtterance) {
		utterances.push(currentUtterance);
	}

	// Build markdown document
	const lines: string[] = [
		"---",
		`arquivo_origem: "${filename}"`,
		`data_transcricao: "${processedAt.toISOString()}"`,
		`idioma_detectado: "${transcription.language_code}"`,
		`probabilidade_idioma: ${(transcription.language_probability * 100).toFixed(1)}%`,
		`modelo: "${AUDIO_CONFIG.MODEL_ID}"`,
		"---",
		"",
		"# Transcrição de Áudio",
		"",
		"## Metadados",
		"",
		`- **Arquivo de origem:** \`${filename}\``,
		`- **Data da transcrição:** ${processedAt.toLocaleDateString("pt-BR")} às ${processedAt.toLocaleTimeString("pt-BR")}`,
		`- **Idioma detectado:** ${transcription.language_code} (${(transcription.language_probability * 100).toFixed(1)}% de confiança)`,
		"",
		"---",
		"",
		"## Transcrição Completa",
		"",
	];

	// Add utterances with speaker labels and timestamps
	for (const utterance of utterances) {
		const startTs = formatTimestamp(utterance.startTime);
		const endTs = formatTimestamp(utterance.endTime);
		lines.push(`**[${startTs} - ${endTs}] ${utterance.speaker}:**`);
		lines.push(`> ${utterance.text.trim()}`);
		lines.push("");
	}

	// Add legal disclaimer if enabled
	if (currentOptions.includeDisclaimer) {
		lines.push("---");
		lines.push("");
		lines.push(LEGAL_DISCLAIMER);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Process a single opus file end-to-end
 */
async function processAudioFile(opusPath: string): Promise<void> {
	const filename = getFilename(opusPath);
	console.log(`\n[Processando] ${filename}`);

	let mp3Path: string | null = null;

	try {
		// Step 1: Convert OPUS to MP3
		console.log("  -> Convertendo para MP3...");
		mp3Path = await convertOpusToMp3(opusPath);

		// Step 2: Transcribe with ElevenLabs
		console.log("  -> Enviando para transcrição...");
		const transcription = await callElevenLabsAPI(mp3Path);

		// Step 3: Format and save markdown
		console.log("  -> Salvando transcrição...");
		const result: AudioTranscriptionResult = {
			sourceFile: opusPath,
			transcription,
			processedAt: new Date(),
		};

		const markdown = formatAudioAsMarkdown(result);
		const mdPath = getMdPath(opusPath);
		await Bun.write(mdPath, markdown);

		console.log(`  -> Concluído: ${getFilename(mdPath)}`);
	} finally {
		// Cleanup: Always remove temp MP3
		if (mp3Path) {
			try {
				await Bun.$`rm -f ${mp3Path}`.quiet();
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

// ===== Public API =====

/**
 * Transcribe all pending audio files in the source directory
 * @returns Processing statistics
 */
export async function transcribeAudio(
	sourceDir: string = CONFIG.SOURCE_DIR,
	options: TranscribeOptions = {},
): Promise<ProcessingStats> {
	// Set module-level options for use in formatting
	currentOptions = options;

	console.log("Buscando arquivos de áudio (.opus)...");

	// Validate API key
	if (!process.env.ELEVENLABS_API_KEY) {
		console.error("  ELEVENLABS_API_KEY não encontrada no .env");
		return { total: 0, pending: 0, processed: 0, errors: 0, skipped: 0 };
	}

	// Ensure temp directory exists
	await Bun.$`mkdir -p ${CONFIG.TEMP_DIR}`.quiet();

	// Find all opus files
	const allFiles = await findFiles(sourceDir, AUDIO_CONFIG.EXTENSION);
	console.log(`  Encontrados: ${allFiles.length} arquivos .opus`);

	if (allFiles.length === 0) {
		return { total: 0, pending: 0, processed: 0, errors: 0, skipped: 0 };
	}

	// Filter pending files
	const { pending, skipped } = await filterPendingFiles(allFiles);
	console.log(`  Pendentes: ${pending.length}`);
	console.log(`  Já transcritos: ${skipped}`);

	if (pending.length === 0) {
		return {
			total: allFiles.length,
			pending: 0,
			processed: 0,
			errors: 0,
			skipped,
		};
	}

	// Process files
	const stats = await processFiles(pending, processAudioFile);

	// Cleanup temp directory
	await Bun.$`rm -rf ${CONFIG.TEMP_DIR}`.quiet();

	return {
		...stats,
		total: allFiles.length,
		skipped,
	};
}
