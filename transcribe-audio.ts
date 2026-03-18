// =============================================================================
// Audio Transcription Module - ElevenLabs Speech-to-Text
// Sends WhatsApp audio (.opus/.m4a/.ogg/.oga) and video (.mp4) files directly
// to ElevenLabs Scribe v2 for transcription to markdown
// =============================================================================

import { type ElevenLabs, ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
	CONFIG,
	type FileMetadata,
	filterPendingFiles,
	findFiles,
	getFileMetadata,
	getFilename,
	getMdPath,
	LEGAL_DISCLAIMER,
	type ProcessingStats,
	processFiles,
} from "./shared";

// ===== Audio-Specific Configuration =====

const AUDIO_CONFIG = {
	MODEL_ID: "scribe_v2",
	LANGUAGE_CODE: "pt",
	EXTENSIONS: ["opus", "mp4", "m4a", "ogg", "oga"],
} as const;

function getMimeType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase();
	const mimeTypes: Record<string, string> = {
		m4a: "audio/x-m4a",
		mp4: "video/mp4",
		opus: "audio/opus",
		ogg: "audio/ogg",
		oga: "audio/ogg",
	};
	return mimeTypes[ext ?? ""] ?? "application/octet-stream";
}

// ===== Type Definitions =====

interface AudioTranscriptionResult {
	sourceFile: string;
	transcription: ElevenLabs.SpeechToTextChunkResponseModel;
	processedAt: Date;
	fileMetadata: FileMetadata;
}

interface Utterance {
	speaker: string;
	startTime: number | undefined;
	endTime: number | undefined;
	text: string;
}

export interface TranscribeOptions {
	includeDisclaimer?: boolean;
}

// Module-level options (set by transcribeAudio)
let currentOptions: TranscribeOptions = {};

// ===== Audio Processing Functions =====

/**
 * Call ElevenLabs speech-to-text API using the official SDK
 */
async function callElevenLabsAPI(
	audioPath: string,
): Promise<ElevenLabs.SpeechToTextChunkResponseModel> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) {
		throw new Error("ELEVENLABS_API_KEY not found in environment");
	}

	const file = Bun.file(audioPath);
	const fileBlob = await file.arrayBuffer();

	const client = new ElevenLabsClient({ apiKey });

	return client.speechToText.convert({
		file: new Blob([fileBlob], { type: getMimeType(audioPath) }),
		modelId: AUDIO_CONFIG.MODEL_ID,
		languageCode: AUDIO_CONFIG.LANGUAGE_CODE,
		diarize: true,
		timestampsGranularity: "word",
		tagAudioEvents: true,
	});
}

/**
 * Format timestamp as MM:SS.ms
 */
function formatTimestamp(seconds: number | undefined): string {
	if (seconds == null) return "--:--";
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 100);
	return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

/**
 * Format transcription as legal-style markdown document
 */
function formatAudioAsMarkdown(result: AudioTranscriptionResult): string {
	const { sourceFile, transcription, processedAt, fileMetadata } = result;
	const filename = getFilename(sourceFile);

	// Group words by speaker for formatted output
	const utterances: Utterance[] = [];
	let currentUtterance: Utterance | null = null;

	for (const word of transcription.words) {
		if (word.type === "spacing") continue;

		const speaker = word.speakerId ?? "Desconhecido";

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
		`data_criacao_arquivo: "${fileMetadata.birthtime.toISOString()}"`,
		`data_modificacao_arquivo: "${fileMetadata.mtime.toISOString()}"`,
		`data_transcricao: "${processedAt.toISOString()}"`,
		`idioma_detectado: "${transcription.languageCode}"`,
		`probabilidade_idioma: ${(transcription.languageProbability * 100).toFixed(1)}%`,
		`modelo: "${AUDIO_CONFIG.MODEL_ID}"`,
		"---",
		"",
		"# Transcrição de Áudio",
		"",
		"## Metadados",
		"",
		`- **Arquivo de origem:** \`${filename}\``,
		`- **Data de criação do arquivo:** ${fileMetadata.birthtime.toLocaleDateString("pt-BR")} às ${fileMetadata.birthtime.toLocaleTimeString("pt-BR")}`,
		`- **Data de modificação do arquivo:** ${fileMetadata.mtime.toLocaleDateString("pt-BR")} às ${fileMetadata.mtime.toLocaleTimeString("pt-BR")}`,
		`- **Data da transcrição:** ${processedAt.toLocaleDateString("pt-BR")} às ${processedAt.toLocaleTimeString("pt-BR")}`,
		`- **Idioma detectado:** ${transcription.languageCode} (${(transcription.languageProbability * 100).toFixed(1)}% de confiança)`,
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
 * Process a single audio/video file end-to-end
 */
async function processAudioFile(audioPath: string): Promise<void> {
	const filename = getFilename(audioPath);
	console.log(`\n[Processando] ${filename}`);
	console.log("  -> Enviando para transcrição...");

	const transcription = await callElevenLabsAPI(audioPath);

	console.log("  -> Salvando transcrição...");
	const fileMetadata = await getFileMetadata(audioPath);
	const result: AudioTranscriptionResult = {
		sourceFile: audioPath,
		transcription,
		processedAt: new Date(),
		fileMetadata,
	};

	const markdown = formatAudioAsMarkdown(result);
	const mdPath = getMdPath(audioPath);
	await Bun.write(mdPath, markdown);

	console.log(`  -> Concluído: ${getFilename(mdPath)}`);
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

	const extList = AUDIO_CONFIG.EXTENSIONS.map((e) => `.${e}`).join(", ");
	console.log(`Buscando arquivos de áudio (${extList})...`);

	// Validate API key
	if (!process.env.ELEVENLABS_API_KEY) {
		console.error("  ELEVENLABS_API_KEY não encontrada no .env");
		return { total: 0, pending: 0, processed: 0, errors: 0, skipped: 0 };
	}

	// Find all audio/video files
	const allFiles: string[] = [];
	for (const ext of AUDIO_CONFIG.EXTENSIONS) {
		const files = await findFiles(sourceDir, ext);
		allFiles.push(...files);
	}
	allFiles.sort();
	console.log(`  Encontrados: ${allFiles.length} arquivos`);

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

	return {
		...stats,
		total: allFiles.length,
		skipped,
	};
}
