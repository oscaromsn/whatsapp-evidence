// =============================================================================
// Zip Extraction
// Extracts WhatsApp exported .zip files, discovers chat logs, extracts media
// =============================================================================

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseContactFromZipName } from "./contacts";
import type { ExtractedZip } from "./types";

// ===== Constants =====

// Priority-ordered chat log filenames
const CHAT_LOG_NAMES = ["_chat.txt", "_conversa.txt"];

// Patterns for fallback discovery
const CHAT_LOG_PATTERNS = [
	/^WhatsApp Chat.*\.txt$/i,
	/^Conversa do WhatsApp.*\.txt$/i,
];

// ===== Public API =====

/**
 * Find all .zip files in the input directory.
 */
export async function findZipFiles(inputDir: string): Promise<string[]> {
	const glob = new Bun.Glob("*.zip");
	const files: string[] = [];

	for await (const file of glob.scan({ cwd: inputDir, absolute: true })) {
		files.push(file);
	}

	return files.sort();
}

/**
 * Extract a WhatsApp zip file, placing the chat log in the cache directory
 * and media files in the medias directory.
 */
export async function extractZip(
	zipPath: string,
	cacheDir: string,
	mediasDir: string,
): Promise<ExtractedZip> {
	const zipFilename = basename(zipPath);
	const contactName = parseContactFromZipName(zipFilename);

	// Extract everything to a temp directory first
	const extractDir = join(cacheDir, `_extract_${Date.now()}`);
	await Bun.$`mkdir -p ${extractDir}`.quiet();

	try {
		await Bun.$`unzip -o ${zipPath} -d ${extractDir}`.quiet();
	} catch {
		throw new Error(`Falha ao extrair o zip: ${zipFilename}`);
	}

	// List extracted files (flat — WhatsApp zips don't have subdirectories)
	let extractedFiles: string[];
	try {
		extractedFiles = await readdir(extractDir);
	} catch {
		throw new Error(`Falha ao ler os arquivos extraídos de: ${zipFilename}`);
	}

	if (extractedFiles.length === 0) {
		throw new Error(`Arquivo zip vazio: ${zipFilename}`);
	}

	// Find the chat log file
	const chatLogName = findChatLog(extractedFiles);
	if (!chatLogName) {
		throw new Error(`Nenhum log de conversa encontrado em: ${zipFilename}`);
	}

	// Read and decode the chat log
	const rawChatLogPath = join(extractDir, chatLogName);
	const chatContent = await Bun.file(rawChatLogPath).arrayBuffer();
	const { text, encoding } = decodeText(Buffer.from(chatContent));

	// Save chat log to cache
	const contactCacheDir = join(cacheDir, zipFilename.replace(/\.zip$/i, ""));
	await Bun.$`mkdir -p ${contactCacheDir}`.quiet();
	const chatLogPath = join(contactCacheDir, chatLogName);
	await Bun.write(chatLogPath, text);

	// Move media files to medias dir
	const mediaFiles: string[] = [];
	const mediaNames = extractedFiles.filter((f) => f !== chatLogName);

	if (mediaNames.length > 0) {
		await Bun.$`mkdir -p ${mediasDir}`.quiet();

		for (const name of mediaNames) {
			const srcPath = join(extractDir, name);
			const targetPath = join(mediasDir, name);

			const existingFile = Bun.file(targetPath);
			if (await existingFile.exists()) {
				// Collision: check if different size
				const srcFile = Bun.file(srcPath);
				if (srcFile.size !== existingFile.size) {
					const prefix = await getZipPrefix(zipPath);
					const prefixedPath = join(mediasDir, `${prefix}_${name}`);
					await Bun.$`mv ${srcPath} ${prefixedPath}`.quiet();
					mediaFiles.push(prefixedPath);
				} else {
					// Same size — assume same file, skip
					mediaFiles.push(targetPath);
				}
			} else {
				await Bun.$`mv ${srcPath} ${targetPath}`.quiet();
				mediaFiles.push(targetPath);
			}
		}
	}

	// Cleanup temp extraction dir
	await Bun.$`rm -rf ${extractDir}`.quiet();

	return {
		contactName,
		chatLogPath,
		mediaFiles,
		encoding,
		zipFilename,
	};
}

// ===== Internal Functions =====

function findChatLog(filenames: string[]): string | null {
	// Priority 1: exact names
	for (const name of CHAT_LOG_NAMES) {
		const match = filenames.find((f) => f.toLowerCase() === name.toLowerCase());
		if (match) return match;
	}

	// Priority 2: pattern matching
	for (const pattern of CHAT_LOG_PATTERNS) {
		const match = filenames.find((f) => pattern.test(f));
		if (match) return match;
	}

	// Priority 3: any .txt file (if exactly one)
	const txtFiles = filenames.filter((f) => f.toLowerCase().endsWith(".txt"));
	if (txtFiles.length === 1) return txtFiles[0]!;

	return null;
}

function decodeText(buffer: Buffer): {
	text: string;
	encoding: "utf-8" | "latin-1";
} {
	let text: string;

	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		text = decoder.decode(buffer);
	} catch {
		// Fallback to Latin-1
		const decoder = new TextDecoder("windows-1252");
		text = decoder.decode(buffer);
		if (text.charCodeAt(0) === 0xfeff) {
			text = text.slice(1);
		}
		return { text, encoding: "latin-1" };
	}

	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}

	return { text, encoding: "utf-8" };
}

async function getZipPrefix(zipPath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const file = Bun.file(zipPath);
	const buffer = await file.arrayBuffer();
	hasher.update(new Uint8Array(buffer));
	return hasher.digest("hex").slice(0, 4);
}
