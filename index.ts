#!/usr/bin/env bun
// =============================================================================
// whatsapp-evidence
// Converts WhatsApp audio (.opus) and screenshot (.jpg) files to legal markdown
// =============================================================================

import { CONFIG, logHeader, logStats, type ProcessingStats } from "./shared";
import { transcribeAudio } from "./transcribe-audio";
import { transcribeImages } from "./transcribe-images";

// ===== CLI Configuration =====

const HELP_TEXT = `
whatsapp-evidence - Conversor de WhatsApp para documentos legais

Uso:
  bun index.ts [opcoes] [diretorio]

Opções:
  -a, --audio        Transcrever apenas arquivos de áudio (.opus, .ogg, .m4a, .mp3, .mov)
  -i, --images       Transcrever apenas capturas de tela (.jpg)
  -d, --disclaimer   Incluir aviso legal no final dos arquivos
  -h, --help         Exibir esta mensagem de ajuda

Argumentos:
  diretório          Diretório a processar (padrão: ${CONFIG.SOURCE_DIR})

Exemplos:
  bun index.ts                    # Processa áudio e imagens
  bun index.ts --disclaimer       # Processa com aviso legal
  bun index.ts -a -d              # Apenas áudios com aviso legal
  bun index.ts ./meus-arquivos    # Processa em diretório específico
`;

interface CLIOptions {
	audio: boolean;
	images: boolean;
	disclaimer: boolean;
	sourceDir: string;
	showHelp: boolean;
}

// ===== CLI Argument Parser =====

function parseArgs(args: string[]): CLIOptions {
	const options: CLIOptions = {
		audio: false,
		images: false,
		disclaimer: false,
		sourceDir: CONFIG.SOURCE_DIR,
		showHelp: false,
	};

	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			options.showHelp = true;
		} else if (arg === "-a" || arg === "--audio") {
			options.audio = true;
		} else if (arg === "-i" || arg === "--images") {
			options.images = true;
		} else if (arg === "-d" || arg === "--disclaimer") {
			options.disclaimer = true;
		} else if (!arg.startsWith("-")) {
			options.sourceDir = arg;
		}
	}

	// If neither flag is set, enable both
	if (!options.audio && !options.images) {
		options.audio = true;
		options.images = true;
	}

	return options;
}

// ===== Stats Aggregation =====

function combineStats(
	audioStats: ProcessingStats | null,
	imageStats: ProcessingStats | null,
): ProcessingStats {
	const combined: ProcessingStats = {
		total: 0,
		pending: 0,
		processed: 0,
		errors: 0,
		skipped: 0,
	};

	if (audioStats) {
		combined.total += audioStats.total;
		combined.pending += audioStats.pending;
		combined.processed += audioStats.processed;
		combined.errors += audioStats.errors;
		combined.skipped += audioStats.skipped;
	}

	if (imageStats) {
		combined.total += imageStats.total;
		combined.pending += imageStats.pending;
		combined.processed += imageStats.processed;
		combined.errors += imageStats.errors;
		combined.skipped += imageStats.skipped;
	}

	return combined;
}

// ===== Main Entry Point =====

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const options = parseArgs(args);

	if (options.showHelp) {
		console.log(HELP_TEXT);
		return;
	}

	logHeader("whatsapp-evidence");
	console.log(`Diretório: ${options.sourceDir}`);
	console.log(
		`Modo: ${options.audio && options.images ? "Áudio + Imagens" : options.audio ? "Apenas Áudio" : "Apenas Imagens"}`,
	);
	console.log(`Aviso legal: ${options.disclaimer ? "Sim" : "Não"}`);

	let audioStats: ProcessingStats | null = null;
	let imageStats: ProcessingStats | null = null;

	// Process audio files
	if (options.audio) {
		logHeader("Transcrição de Áudio");
		audioStats = await transcribeAudio(options.sourceDir, {
			includeDisclaimer: options.disclaimer,
		});
		if (audioStats.total > 0) {
			logStats("Áudio", audioStats);
		}
	}

	// Process image files
	if (options.images) {
		logHeader("Transcrição de Imagens");
		imageStats = await transcribeImages(options.sourceDir, {
			includeDisclaimer: options.disclaimer,
		});
		if (imageStats.total > 0) {
			logStats("Imagens", imageStats);
		}
	}

	// Combined summary
	if (options.audio && options.images) {
		const combined = combineStats(audioStats, imageStats);
		logHeader("Resumo Geral");
		console.log(`Total de arquivos: ${combined.total}`);
		console.log(`Já transcritos: ${combined.skipped}`);
		console.log(`Processados agora: ${combined.processed}`);
		if (combined.errors > 0) {
			console.log(`Erros: ${combined.errors}`);
		}
	}

	// Final message
	const total = (audioStats?.processed ?? 0) + (imageStats?.processed ?? 0);
	const errors = (audioStats?.errors ?? 0) + (imageStats?.errors ?? 0);

	if (total === 0 && errors === 0) {
		console.log("\nTodos os arquivos já foram transcritos!");
	} else if (errors === 0) {
		console.log("\nTranscrição concluída com sucesso!");
	} else {
		console.log(`\nTranscrição concluída com ${errors} erro(s).`);
		process.exit(1);
	}
}

// Run
main().catch((error) => {
	console.error("Erro fatal:", error);
	process.exit(1);
});
