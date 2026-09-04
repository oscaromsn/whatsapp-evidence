// =============================================================================
// Audio Transcription Module - ElevenLabs Speech-to-Text
// Sends WhatsApp audio (.opus/.m4a/.ogg/.oga/.mp3) and video (.mp4) files
// directly to ElevenLabs Scribe v2 for transcription to markdown
// =============================================================================

import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import {
	cleanupChunks,
	ensureFfmpegAvailable,
	getAudioDuration,
	splitAudio,
} from "./audio-splitter";
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
import {
	type ChunkBoundary,
	type ChunkTranscription,
	mergeTranscriptions,
} from "./transcript-merger";

// ===== Audio-Specific Configuration =====

export const AUDIO_CONFIG = {
	MODEL_ID: "scribe_v2",
	LANGUAGE_CODE: "pt",
	EXTENSIONS: ["opus", "mp4", "m4a", "mp3", "ogg", "oga"],
	TIMEOUT_SECONDS: 300,
	MAX_RETRIES: 3,
	DEFAULT_CHUNK_MINUTES: 50,
	MAX_CHUNK_MINUTES: 60,
	DEFAULT_CHUNK_CONCURRENCY: 3,
	MAX_CHUNK_CONCURRENCY: 5,
} as const;

/**
 * Process items with bounded concurrency, preserving input order in results.
 * Exported for direct unit testing.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			const item = items[i];
			if (item === undefined) continue;
			results[i] = await fn(item, i);
		}
	}

	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const workers = Array.from({ length: workerCount }, worker);
	await Promise.all(workers);
	return results;
}

function getMimeType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase();
	const mimeTypes: Record<string, string> = {
		m4a: "audio/x-m4a",
		mp3: "audio/mpeg",
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
	boundaries: ChunkBoundary[];
	chunkMinutes: number | null;
}

interface Utterance {
	speaker: string;
	startTime: number | undefined;
	endTime: number | undefined;
	text: string;
}

export interface TranscribeOptions {
	includeDisclaimer?: boolean;
	chunkMinutes?: number;
	chunkConcurrency?: number;
}

// Module-level options (set by transcribeAudio)
let currentOptions: TranscribeOptions = {};

// ===== Audio Processing Functions =====

/**
 * Call ElevenLabs speech-to-text API using the official SDK
 */
export async function callElevenLabsAPI(
	audioPath: string,
): Promise<ElevenLabs.SpeechToTextChunkResponseModel> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) {
		throw new Error("ELEVENLABS_API_KEY not found in environment");
	}

	const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");

	const file = Bun.file(audioPath);
	const fileBlob = await file.arrayBuffer();

	const client = new ElevenLabsClient({ apiKey });

	return client.speechToText.convert(
		{
			file: new Blob([fileBlob], { type: getMimeType(audioPath) }),
			modelId: AUDIO_CONFIG.MODEL_ID,
			languageCode: AUDIO_CONFIG.LANGUAGE_CODE,
			diarize: true,
			timestampsGranularity: "word",
			tagAudioEvents: true,
		},
		{
			timeoutInSeconds: AUDIO_CONFIG.TIMEOUT_SECONDS,
			maxRetries: AUDIO_CONFIG.MAX_RETRIES,
		},
	);
}

/**
 * Format timestamp as MM:SS.ms or H:MM:SS.ms for >= 1 hour.
 */
function formatTimestamp(seconds: number | undefined): string {
	if (seconds == null) return "--:--";
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 100);
	const mm = mins.toString().padStart(2, "0");
	const ss = secs.toString().padStart(2, "0");
	const cc = ms.toString().padStart(2, "0");
	if (hours > 0) {
		return `${hours}:${mm}:${ss}.${cc}`;
	}
	return `${mm}:${ss}.${cc}`;
}

/**
 * Format a chunk-boundary marker block (inserted between utterances).
 */
function formatBoundaryMarker(boundary: ChunkBoundary): string[] {
	return [
		"---",
		"",
		`**Continuação — parte ${boundary.partNumber} de ${boundary.totalParts} (início aos ${formatTimestamp(boundary.startSeconds)})**`,
		"",
		"> Nota: As etiquetas de falante são reiniciadas a cada parte",
		"> e podem não corresponder à mesma pessoa entre partes.",
		"",
		"---",
		"",
	];
}

/**
 * Determine which chunk's part-number is encoded in a speaker label like
 * "speaker_0 (parte 2)". Returns null when no part suffix is present.
 */
function extractPartNumber(speaker: string): number | null {
	const m = speaker.match(/\(parte (\d+)\)\s*$/);
	if (!m?.[1]) return null;
	return Number.parseInt(m[1], 10);
}

/**
 * Format transcription as legal-style markdown document
 */
function formatAudioAsMarkdown(result: AudioTranscriptionResult): string {
	const { sourceFile, transcription, processedAt, fileMetadata, boundaries } =
		result;
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
	];

	if (boundaries.length > 1 && result.chunkMinutes != null) {
		lines.push(`partes_transcritas: ${boundaries.length}`);
		lines.push(`duracao_por_parte_minutos: ${result.chunkMinutes}`);
	}

	lines.push(
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
	);

	if (boundaries.length > 1 && result.chunkMinutes != null) {
		lines.push(
			`- **Dividido em:** ${boundaries.length} partes de até ${result.chunkMinutes} minutos`,
		);
	}

	lines.push("", "---", "", "## Transcrição Completa", "");

	// Track chunk transitions: emit a boundary marker just before the first
	// utterance of any part > 1. With a single chunk (no splitting), boundaries
	// has length 1 and no marker is ever emitted.
	const boundaryByPart = new Map<number, ChunkBoundary>(
		boundaries.map((b) => [b.partNumber, b]),
	);
	let lastPart: number | null = null;

	for (const utterance of utterances) {
		const part = extractPartNumber(utterance.speaker);
		if (part != null && part !== lastPart) {
			const boundary = boundaryByPart.get(part);
			if (boundary && boundary.partNumber > 1) {
				lines.push(...formatBoundaryMarker(boundary));
			}
			lastPart = part;
		}

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
 * Wrap an ElevenLabs API call with the project's standard error handling.
 */
async function transcribeWithErrorHandling(
	audioPath: string,
): Promise<ElevenLabs.SpeechToTextChunkResponseModel> {
	const startTime = Date.now();
	try {
		return await callElevenLabsAPI(audioPath);
	} catch (error) {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const fileSizeMB = (Bun.file(audioPath).size / 1024 / 1024).toFixed(1);
		const { ElevenLabsTimeoutError, ElevenLabsError } = await import(
			"@elevenlabs/elevenlabs-js"
		);

		if (error instanceof ElevenLabsTimeoutError) {
			throw new Error(
				`Timeout após ${elapsed}s (limite: ${AUDIO_CONFIG.TIMEOUT_SECONDS}s, arquivo: ${fileSizeMB}MB). Tente reduzir --chunk-minutes.`,
			);
		}
		if (error instanceof ElevenLabsError && error.statusCode === 429) {
			throw new Error(
				`Rate limit atingido após ${elapsed}s. Tente novamente em alguns minutos.`,
			);
		}
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Falha após ${elapsed}s (arquivo: ${fileSizeMB}MB): ${msg}`,
		);
	}
}

function formatHms(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) {
		return `${h}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s`;
	}
	return `${m}m${s.toString().padStart(2, "0")}s`;
}

/**
 * Process a single audio/video file end-to-end. Files longer than
 * `chunkMinutes` are split with ffmpeg first, transcribed sequentially, then
 * merged into one markdown.
 */
async function processAudioFile(audioPath: string): Promise<void> {
	const filename = getFilename(audioPath);
	console.log(`\n[Processando] ${filename}`);

	const chunkMinutes =
		currentOptions.chunkMinutes ?? AUDIO_CONFIG.DEFAULT_CHUNK_MINUTES;
	const chunkSeconds = chunkMinutes * 60;

	// Probe duration first to decide whether to split. If ffprobe isn't
	// available, fall through to the legacy single-call path — short files keep
	// working without the new ffmpeg dependency.
	let duration: number | null = null;
	try {
		duration = await getAudioDuration(audioPath);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(
			`  [Aviso] Não foi possível medir a duração (${msg}). Enviando arquivo inteiro.`,
		);
	}

	let transcription: ElevenLabs.SpeechToTextChunkResponseModel;
	let boundaries: ChunkBoundary[] = [];
	let appliedChunkMinutes: number | null = null;

	if (duration == null || duration <= chunkSeconds) {
		console.log("  -> Enviando para transcrição...");
		transcription = await transcribeWithErrorHandling(audioPath);
	} else {
		const numParts = Math.ceil(duration / chunkSeconds);
		const concurrency = Math.min(
			currentOptions.chunkConcurrency ?? AUDIO_CONFIG.DEFAULT_CHUNK_CONCURRENCY,
			numParts,
		);
		console.log(
			`  -> Arquivo longo (${formatHms(duration)}), dividindo em ${numParts} partes de até ${chunkMinutes} min (concorrência: ${concurrency})...`,
		);
		await ensureFfmpegAvailable();
		const { tmpDir, chunks } = await splitAudio(audioPath, chunkSeconds);
		try {
			const chunkResults = await mapWithConcurrency(
				chunks,
				concurrency,
				async (chunk, i) => {
					console.log(`  -> Iniciando parte ${i + 1}/${chunks.length}...`);
					const response = await transcribeWithErrorHandling(chunk.path);
					console.log(`  -> Concluída parte ${i + 1}/${chunks.length}.`);
					return {
						partNumber: i + 1,
						totalParts: chunks.length,
						startSeconds: chunk.startSeconds,
						response,
					} satisfies ChunkTranscription;
				},
			);
			const merged = mergeTranscriptions(chunkResults);
			transcription = merged.merged;
			boundaries = merged.boundaries;
			appliedChunkMinutes = chunkMinutes;
		} finally {
			await cleanupChunks(tmpDir);
		}
	}

	console.log("  -> Salvando transcrição...");
	const fileMetadata = await getFileMetadata(audioPath);
	const result: AudioTranscriptionResult = {
		sourceFile: audioPath,
		transcription,
		processedAt: new Date(),
		fileMetadata,
		boundaries,
		chunkMinutes: appliedChunkMinutes,
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
