#!/usr/bin/env bun
// =============================================================================
// Cleanup Script - Remove "Texto Integral" section from existing .md files
// One-time migration script
// =============================================================================

import { CONFIG, findFiles, getFilename } from "./shared";

async function cleanupFile(mdPath: string): Promise<boolean> {
	const file = Bun.file(mdPath);
	const content = await file.text();

	// Check if the section exists
	if (!content.includes("## Texto Integral (sem formatação)")) {
		return false;
	}

	// Find the section and remove everything from "---\n\n## Texto Integral" to the end or next major section
	const sectionStart = content.indexOf(
		"---\n\n## Texto Integral (sem formatação)",
	);

	if (sectionStart === -1) {
		return false;
	}

	// Get content before the section
	let cleaned = content.substring(0, sectionStart);

	// Find if there's content after this section (look for next "---" that starts a new section)
	const afterSection = content.substring(sectionStart + 4); // skip the first "---"
	const nextSectionMatch = afterSection.match(/\n---\n\n(?!## Texto Integral)/);

	if (nextSectionMatch && nextSectionMatch.index !== undefined) {
		// There's more content after, preserve it
		cleaned += afterSection.substring(nextSectionMatch.index);
	} else {
		// Section is at the end - check if there's a legal disclaimer we need to keep
		const legalMatch = content.match(/> \*\*Aviso Legal:\*\*.+$/s);
		if (legalMatch) {
			cleaned += `---\n\n${legalMatch[0]}\n`;
		}
	}

	// Ensure file ends with newline
	if (!cleaned.endsWith("\n")) {
		cleaned += "\n";
	}

	// Write back
	await Bun.write(mdPath, cleaned);
	return true;
}

async function main(): Promise<void> {
	console.log("=== Limpeza de arquivos .md ===\n");
	console.log("Removendo seção 'Texto Integral (sem formatação)'...\n");

	const sourceDir = process.argv[2] || CONFIG.SOURCE_DIR;
	const mdFiles = await findFiles(sourceDir, "md");

	console.log(`Encontrados: ${mdFiles.length} arquivos .md\n`);

	let cleaned = 0;
	let skipped = 0;

	for (const mdPath of mdFiles) {
		const filename = getFilename(mdPath);
		const wasModified = await cleanupFile(mdPath);

		if (wasModified) {
			console.log(`  [LIMPO] ${filename}`);
			cleaned++;
		} else {
			skipped++;
		}
	}

	console.log("\n=== Resumo ===");
	console.log(`Arquivos modificados: ${cleaned}`);
	console.log(`Arquivos sem alteração: ${skipped}`);
}

main().catch((error) => {
	console.error("Erro:", error);
	process.exit(1);
});
