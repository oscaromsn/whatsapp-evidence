#!/usr/bin/env bun
// =============================================================================
// whatsapp-evidence
// Converts WhatsApp audio (.opus) and screenshot (.jpg) files to legal markdown
// =============================================================================

import {
	CONFIG,
	logHeader,
	logStats,
	type ProcessingStats,
	validateSourceDir,
} from "./shared";

// ===== CLI Configuration =====

const HELP_TEXT = `
whatsapp-evidence - Conversor de WhatsApp para documentos legais

Uso:
  bun index.ts [opcoes] [diretorio]

Opções:
  -a, --audio                    Transcrever apenas arquivos de áudio (.opus, .m4a, .mp3, .ogg, .oga)
  -i, --images                   Transcrever apenas capturas de tela (.jpg)
  -d, --disclaimer               Incluir aviso legal no final dos arquivos
  -c, --chunk-minutes <n>        Duração máxima por parte ao dividir áudios longos
                                 (padrão: 50, máx: 60). Requer ffmpeg/ffprobe.
  -j, --chunk-concurrency <n>    Partes transcritas em paralelo por arquivo
                                 (padrão: 3, máx: 5). Reduza se atingir rate limit.
  -h, --help                     Exibir esta mensagem de ajuda

Argumentos:
  diretório                      Diretório a processar (padrão: ${CONFIG.SOURCE_DIR})

Exemplos:
  bun index.ts                       # Processa áudio e imagens
  bun index.ts --disclaimer          # Processa com aviso legal
  bun index.ts -a -d                 # Apenas áudios com aviso legal
  bun index.ts -c 30 ./meus-arquivos # Divide áudios longos em partes de 30 min
`;

interface CLIOptions {
	audio: boolean;
	images: boolean;
	disclaimer: boolean;
	sourceDir: string;
	showHelp: boolean;
	chunkMinutes: number | undefined;
	chunkConcurrency: number | undefined;
}

// ===== CLI Argument Parser =====

const MAX_CHUNK_MINUTES = 60;
const MAX_CHUNK_CONCURRENCY = 5;

function parseIntArg(
	flag: string,
	value: string | undefined,
	min: number,
	max: number,
): number {
	if (value == null) {
		console.error(`Erro: ${flag} requer um valor.`);
		process.exit(1);
	}
	const parsed = Number.parseInt(value, 10);
	if (
		!Number.isFinite(parsed) ||
		parsed < min ||
		parsed > max ||
		String(parsed) !== value.trim()
	) {
		console.error(
			`Erro: ${flag} deve ser um inteiro entre ${min} e ${max} (recebido: "${value}").`,
		);
		process.exit(1);
	}
	return parsed;
}

function parseArgs(args: string[]): CLIOptions {
	const options: CLIOptions = {
		audio: false,
		images: false,
		disclaimer: false,
		sourceDir: CONFIG.SOURCE_DIR,
		showHelp: false,
		chunkMinutes: undefined,
		chunkConcurrency: undefined,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-h" || arg === "--help") {
			options.showHelp = true;
		} else if (arg === "-a" || arg === "--audio") {
			options.audio = true;
		} else if (arg === "-i" || arg === "--images") {
			options.images = true;
		} else if (arg === "-d" || arg === "--disclaimer") {
			options.disclaimer = true;
		} else if (arg === "-c" || arg === "--chunk-minutes") {
			options.chunkMinutes = parseIntArg(
				arg,
				args[i + 1],
				1,
				MAX_CHUNK_MINUTES,
			);
			i++;
		} else if (arg === "-j" || arg === "--chunk-concurrency") {
			options.chunkConcurrency = parseIntArg(
				arg,
				args[i + 1],
				1,
				MAX_CHUNK_CONCURRENCY,
			);
			i++;
		} else if (arg != null && !arg.startsWith("-")) {
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

	// Subcommand routing
	if (args[0] === "ingest") {
		const { parseIngestArgs, INGEST_HELP_TEXT } = await import("./ingest/cli");
		const subArgs = args.slice(1);

		if (subArgs.includes("-h") || subArgs.includes("--help")) {
			console.log(INGEST_HELP_TEXT);
			return;
		}

		const ingestOptions = parseIngestArgs(subArgs);
		const { runIngest } = await import("./ingest/orchestrator");
		await runIngest(ingestOptions);
		return;
	}

	// Default: transcribe subcommand (backward-compatible)
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

	await validateSourceDir(options.sourceDir);

	let audioStats: ProcessingStats | null = null;
	let imageStats: ProcessingStats | null = null;

	// Process audio files
	if (options.audio) {
		logHeader("Transcrição de Áudio");
		console.log("Carregando módulo de áudio...");
		const { transcribeAudio } = await import("./transcribe-audio");
		audioStats = await transcribeAudio(options.sourceDir, {
			includeDisclaimer: options.disclaimer,
			chunkMinutes: options.chunkMinutes,
			chunkConcurrency: options.chunkConcurrency,
		});
		if (audioStats.total > 0) {
			logStats("Áudio", audioStats);
		}
	}

	// Process image files
	if (options.images) {
		logHeader("Transcrição de Imagens");
		console.log("Carregando módulo de imagens...");
		const { transcribeImages } = await import("./transcribe-images");
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
