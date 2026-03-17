// =============================================================================
// Shared Utilities for WhatsApp Transcription Scripts
// Common types, constants, and helper functions
// =============================================================================

// ===== Constants =====

export const CONFIG = {
	SOURCE_DIR: "./to-transcript",
	TEMP_DIR: "/tmp/audio-transcript",
} as const;

export const LEGAL_DISCLAIMER = `> **Aviso Legal:** Esta transcrição foi produzida por inteligência artificial e revisada por um humano. Não substitui seu original, tendo como objetivo contribuir para a eficiência do judiciário e a democratização da Justiça, em conformidade com a Recomendação 0001/2024 do Conselho Federal da OAB e a Resolução 615/2025 do Conselho Nacional de Justiça.`;

// ===== Types =====

export interface FileMetadata {
	birthtime: Date;
	mtime: Date;
}

export interface ProcessingStats {
	total: number;
	pending: number;
	processed: number;
	errors: number;
	skipped: number;
}

export interface ProcessorResult {
	success: boolean;
	message?: string;
}

// ===== File Discovery Functions =====

/**
 * Find all files with given extension recursively in the source directory
 */
export async function findFiles(
	baseDir: string,
	extension: string,
): Promise<string[]> {
	// Match both lowercase and uppercase extensions (e.g., .mov and .MOV)
	const lowerPattern = `**/*.${extension.toLowerCase()}`;
	const upperPattern = `**/*.${extension.toUpperCase()}`;
	const lowerGlob = new Bun.Glob(lowerPattern);
	const upperGlob = new Bun.Glob(upperPattern);
	const files: string[] = [];
	const seen = new Set<string>();

	for await (const file of lowerGlob.scan({ cwd: baseDir, absolute: true })) {
		if (!seen.has(file)) {
			seen.add(file);
			files.push(file);
		}
	}

	for await (const file of upperGlob.scan({ cwd: baseDir, absolute: true })) {
		if (!seen.has(file)) {
			seen.add(file);
			files.push(file);
		}
	}

	return files.sort();
}

/**
 * Check if a corresponding .md file exists for the given file
 */
export async function hasExistingTranscript(
	filePath: string,
): Promise<boolean> {
	// Replace the extension with .md
	const mdPath = filePath.replace(/\.[^.]+$/, ".md");
	const file = Bun.file(mdPath);
	return file.exists();
}

/**
 * Get filename from full path
 */
export function getFilename(filePath: string): string {
	return filePath.split("/").pop() ?? filePath;
}

/**
 * Get markdown path from source file path
 */
export function getMdPath(filePath: string): string {
	return filePath.replace(/\.[^.]+$/, ".md");
}

/**
 * Get file metadata (creation and modification dates)
 */
export async function getFileMetadata(filePath: string): Promise<FileMetadata> {
	const file = Bun.file(filePath);
	const stat = await file.stat();
	return {
		birthtime: stat.birthtime,
		mtime: stat.mtime,
	};
}

// ===== Processing Orchestrator =====

export type FileProcessor = (filePath: string) => Promise<void>;

/**
 * Process files with progress tracking and error handling
 */
export async function processFiles(
	files: string[],
	processor: FileProcessor,
	options: { delayMs?: number } = {},
): Promise<ProcessingStats> {
	const { delayMs = 500 } = options;

	let processed = 0;
	let errors = 0;

	for (const [i, file] of files.entries()) {
		try {
			await processor(file);
			processed++;
		} catch (error) {
			errors++;
			console.error(
				`  [ERRO] ${getFilename(file)}: ${error instanceof Error ? error.message : error}`,
			);
		}

		// Delay between requests to respect rate limits
		if (i < files.length - 1) {
			await Bun.sleep(delayMs);
		}
	}

	return {
		total: files.length,
		pending: files.length,
		processed,
		errors,
		skipped: 0,
	};
}

/**
 * Filter files that don't have existing transcripts
 */
export async function filterPendingFiles(files: string[]): Promise<{
	pending: string[];
	skipped: number;
}> {
	const pending: string[] = [];

	for (const file of files) {
		if (!(await hasExistingTranscript(file))) {
			pending.push(file);
		}
	}

	return {
		pending,
		skipped: files.length - pending.length,
	};
}

// ===== Console Output Helpers =====

export function logHeader(title: string): void {
	console.log(`\n=== ${title} ===\n`);
}

export function logStats(label: string, stats: ProcessingStats): void {
	console.log(`\n--- ${label} ---`);
	console.log(`  Total encontrados: ${stats.total}`);
	console.log(`  Já transcritos: ${stats.skipped}`);
	console.log(`  Processados: ${stats.processed}`);
	if (stats.errors > 0) {
		console.log(`  Erros: ${stats.errors}`);
	}
}
