// =============================================================================
// Media Processing Bridge
// Bridges to existing audio/image transcription APIs with concurrency control
// =============================================================================

import type { MediaEntry } from "./types";

const AUDIO_EXTENSIONS = new Set(["opus", "ogg", "oga", "m4a", "mp4"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg"]);

// ===== Public API =====

/**
 * Process pending media files using existing transcription APIs.
 * Uses a semaphore-based concurrency pool.
 */
export async function processMediaFiles(
	entries: Array<{ key: string; entry: MediaEntry; filePath: string }>,
	mode: "audio" | "images" | "all",
	concurrency: number,
	onProgress?: (
		key: string,
		status: "processed" | "failed",
		error?: string,
	) => void,
): Promise<void> {
	// Filter entries by mode
	const filtered = entries.filter((e) => {
		if (mode === "all") return true;
		if (mode === "audio") return isAudioFile(e.entry.originalFilename);
		if (mode === "images") return isImageFile(e.entry.originalFilename);
		return false;
	});

	if (filtered.length === 0) return;

	// Process with concurrency control
	let running = 0;
	let idx = 0;

	await new Promise<void>((resolve) => {
		function next() {
			while (running < concurrency && idx < filtered.length) {
				const item = filtered[idx++]!;
				running++;
				processOne(item)
					.then(() => {
						item.entry.status = "processed";
						onProgress?.(item.key, "processed");
					})
					.catch((err) => {
						item.entry.status = "failed";
						const msg = err instanceof Error ? err.message : String(err);
						onProgress?.(item.key, "failed", msg);
					})
					.finally(() => {
						running--;
						if (idx >= filtered.length && running === 0) {
							resolve();
						} else {
							next();
						}
					});
			}
			// Edge case: nothing to process
			if (filtered.length === 0 || (idx >= filtered.length && running === 0)) {
				resolve();
			}
		}
		next();
	});
}

// ===== Internal Functions =====

async function processOne(item: {
	key: string;
	entry: MediaEntry;
	filePath: string;
}): Promise<void> {
	const filename = item.entry.originalFilename;

	if (isAudioFile(filename)) {
		const { callElevenLabsAPI } = await import("../transcribe-audio");
		const result = await callElevenLabsAPI(item.filePath);
		item.entry.transcription = result.text ?? "";
	} else if (isImageFile(filename)) {
		const { callBAMLVision } = await import("../transcribe-images");
		const result = await callBAMLVision(item.filePath);
		// Concatenate message contents as description
		item.entry.transcription = result.messages
			.map((m) => `${m.sender}: ${m.content}`)
			.join("\n");
	}
}

function isAudioFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return AUDIO_EXTENSIONS.has(ext);
}

function isImageFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EXTENSIONS.has(ext);
}
