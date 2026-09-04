// =============================================================================
// Transcript Merger
// Stitches per-chunk ElevenLabs responses into one global transcription.
// Pure functions, no I/O — independently unit-testable.
// =============================================================================

import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";

export interface ChunkTranscription {
	partNumber: number;
	totalParts: number;
	startSeconds: number;
	response: ElevenLabs.SpeechToTextChunkResponseModel;
}

export interface ChunkBoundary {
	partNumber: number;
	totalParts: number;
	startSeconds: number;
}

export interface MergeResult {
	merged: ElevenLabs.SpeechToTextChunkResponseModel;
	boundaries: ChunkBoundary[];
}

const UNKNOWN_SPEAKER = "Desconhecido";

function suffixSpeaker(
	speakerId: string | undefined,
	partNumber: number,
): string {
	const base = speakerId ?? UNKNOWN_SPEAKER;
	return `${base} (parte ${partNumber})`;
}

function shiftWords(
	words: ElevenLabs.SpeechToTextWordResponseModel[],
	offsetSeconds: number,
	partNumber: number,
): ElevenLabs.SpeechToTextWordResponseModel[] {
	return words.map((word) => ({
		...word,
		start: word.start == null ? word.start : word.start + offsetSeconds,
		end: word.end == null ? word.end : word.end + offsetSeconds,
		speakerId: suffixSpeaker(word.speakerId, partNumber),
	}));
}

/**
 * Merge ordered chunk transcriptions into a single response with global
 * timestamps and chunk-suffixed speaker IDs.
 */
export function mergeTranscriptions(chunks: ChunkTranscription[]): MergeResult {
	if (chunks.length === 0) {
		throw new Error("mergeTranscriptions: at least one chunk is required");
	}

	const ordered = [...chunks].sort((a, b) => a.partNumber - b.partNumber);
	const first = ordered[0];
	if (!first) {
		throw new Error("mergeTranscriptions: at least one chunk is required");
	}

	const allWords: ElevenLabs.SpeechToTextWordResponseModel[] = [];
	const textParts: string[] = [];

	for (const chunk of ordered) {
		allWords.push(
			...shiftWords(chunk.response.words, chunk.startSeconds, chunk.partNumber),
		);
		textParts.push(chunk.response.text);
	}

	const merged: ElevenLabs.SpeechToTextChunkResponseModel = {
		languageCode: first.response.languageCode,
		languageProbability: first.response.languageProbability,
		text: textParts.join(" ").trim(),
		words: allWords,
	};

	const boundaries: ChunkBoundary[] = ordered.map((chunk) => ({
		partNumber: chunk.partNumber,
		totalParts: chunk.totalParts,
		startSeconds: chunk.startSeconds,
	}));

	return { merged, boundaries };
}
