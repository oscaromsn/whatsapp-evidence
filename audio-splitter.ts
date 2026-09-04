// =============================================================================
// Audio Splitter
// Wraps system ffmpeg/ffprobe to slice long audio files into contiguous chunks.
// Required because the ElevenLabs JS SDK times out on uploads taking longer
// than ~5 minutes; chunks under ~50 minutes process comfortably within that.
// =============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { $ } from "bun";

export interface AudioChunk {
	path: string;
	startSeconds: number;
	durationSeconds: number;
}

export interface SplitResult {
	tmpDir: string;
	chunks: AudioChunk[];
}

let ffmpegChecked = false;

/**
 * Throws a clear, actionable error if ffmpeg or ffprobe is not on PATH.
 * Cached after the first successful check.
 */
export async function ensureFfmpegAvailable(): Promise<void> {
	if (ffmpegChecked) return;
	try {
		await $`ffmpeg -version`.quiet();
		await $`ffprobe -version`.quiet();
		ffmpegChecked = true;
	} catch {
		throw new Error(
			"ffmpeg/ffprobe não encontrados no PATH. " +
				"Instale com: `brew install ffmpeg` (macOS) ou " +
				"`apt install ffmpeg` (Linux). Necessário para dividir áudios longos.",
		);
	}
}

/**
 * Returns audio duration in seconds via ffprobe.
 */
export async function getAudioDuration(audioPath: string): Promise<number> {
	const result =
		await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${audioPath}`
			.quiet()
			.text();
	const seconds = Number.parseFloat(result.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(
			`Não foi possível obter a duração do arquivo: ${audioPath} (ffprobe retornou: "${result.trim()}")`,
		);
	}
	return seconds;
}

/**
 * Splits an audio file into contiguous chunks using ffmpeg's stream copy
 * (`-c copy`) — no re-encoding, fast, no quality loss. Each chunk is at most
 * `chunkSeconds` long; the final chunk holds the remainder.
 */
export async function splitAudio(
	audioPath: string,
	chunkSeconds: number,
): Promise<SplitResult> {
	if (chunkSeconds <= 0) {
		throw new Error(
			`splitAudio: chunkSeconds must be > 0 (got ${chunkSeconds})`,
		);
	}

	const duration = await getAudioDuration(audioPath);
	const ext = extname(audioPath).slice(1).toLowerCase() || "mp3";
	const tmpDir = await mkdtemp(join(tmpdir(), "wae-audio-chunks-"));

	const numChunks = Math.ceil(duration / chunkSeconds);
	const chunks: AudioChunk[] = [];

	for (let i = 0; i < numChunks; i++) {
		const startSeconds = i * chunkSeconds;
		const remaining = duration - startSeconds;
		const thisChunkSeconds = Math.min(chunkSeconds, remaining);
		const chunkPath = join(tmpDir, `chunk_${i + 1}.${ext}`);

		// `-ss` before `-i` for fast seek; `-c copy` skips re-encoding.
		// `-nostdin` prevents ffmpeg from consuming our stdin.
		await $`ffmpeg -nostdin -hide_banner -loglevel error -ss ${startSeconds} -t ${thisChunkSeconds} -i ${audioPath} -c copy ${chunkPath}`.quiet();

		chunks.push({
			path: chunkPath,
			startSeconds,
			durationSeconds: thisChunkSeconds,
		});
	}

	return { tmpDir, chunks };
}

/**
 * Removes the temporary directory and its chunks. Idempotent — never throws.
 */
export async function cleanupChunks(tmpDir: string): Promise<void> {
	try {
		await rm(tmpDir, { recursive: true, force: true });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(
			`  [Aviso] Falha ao limpar diretório temporário ${tmpDir}: ${msg}`,
		);
	}
}
