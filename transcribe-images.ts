// =============================================================================
// Image Transcription Module - BAML Vision
// Converts WhatsApp screenshot images (.jpg) to structured markdown
// For legal documentation - accuracy is paramount
// =============================================================================

import { Image } from "@boundaryml/baml";
import {
	b,
	type MediaType,
	type MessageStatus,
	type WhatsAppMessage,
	type WhatsAppScreenshot,
} from "./baml_client";
import {
	CONFIG,
	filterPendingFiles,
	findFiles,
	getFilename,
	getMdPath,
	LEGAL_DISCLAIMER,
	type ProcessingStats,
	processFiles,
} from "./shared";

// ===== Image-Specific Configuration =====

const IMAGE_CONFIG = {
	EXTENSION: "jpg",
} as const;

// ===== Type Definitions =====

interface ImageTranscriptionResult {
	sourceFile: string;
	extraction: WhatsAppScreenshot;
	processedAt: Date;
}

export interface TranscribeOptions {
	includeDisclaimer?: boolean;
}

// Module-level options (set by transcribeImages)
let currentOptions: TranscribeOptions = {};

// ===== Image Processing Functions =====

/**
 * Transcribe image using BAML vision function
 */
async function callBAMLVision(jpgPath: string): Promise<WhatsAppScreenshot> {
	// Read image file and convert to base64
	const file = Bun.file(jpgPath);
	const arrayBuffer = await file.arrayBuffer();
	const base64 = Buffer.from(arrayBuffer).toString("base64");

	// Extract filename for date inference
	const filename = getFilename(jpgPath);

	// Create BAML Image from base64
	const image = Image.fromBase64("image/jpeg", base64);
	const result = await b.ExtractWhatsAppMessages(image, filename);
	return result;
}

/**
 * Format media type for display
 */
function formatMediaType(mediaType: MediaType): string {
	const labels: Record<MediaType, string> = {
		Text: "Texto",
		Image: "Imagem",
		Video: "Vídeo",
		VoiceMessage: "Áudio",
		Document: "Documento",
		Sticker: "Figurinha",
		Gif: "GIF",
		Contact: "Contato",
		Location: "Localização",
		LinkPreview: "Link",
		Deleted: "Apagada",
		Poll: "Enquete",
	};
	return labels[mediaType] || mediaType;
}

/**
 * Format message status for display
 */
function formatMessageStatus(status: MessageStatus | null | undefined): string {
	if (!status) return "";
	const labels: Record<MessageStatus, string> = {
		Pending: "⏱️",
		Sent: "✓",
		Delivered: "✓✓",
		Read: "✓✓ (lida)",
		Unknown: "",
	};
	return labels[status] || "";
}

/**
 * Format a single message as markdown
 */
function formatMessage(message: WhatsAppMessage): string[] {
	const lines: string[] = [];

	// Header with date, time, sender
	const dateIndicator = message.date_inferred ? " ⚠️" : "";
	const statusIndicator = formatMessageStatus(message.message_status);
	const forwardedIndicator = message.is_forwarded ? " ↩️ Encaminhada" : "";
	const editedIndicator = message.is_edited ? " ✏️" : "";

	lines.push(
		`### ${message.date}${dateIndicator} ${message.time} - ${message.sender}${forwardedIndicator}${editedIndicator}`,
	);

	// Reply context if present
	if (message.is_reply && message.reply_preview) {
		lines.push(`> _Em resposta a:_ "${message.reply_preview}"`);
		lines.push("");
	}

	// Media indicator if not text
	if (message.media_type !== "Text") {
		const mediaLabel = formatMediaType(message.media_type);
		if (message.media_description) {
			lines.push(`> 📎 **[${mediaLabel}]** ${message.media_description}`);
		} else {
			lines.push(`> 📎 **[${mediaLabel}]**`);
		}
	}

	// Message content
	if (message.content) {
		const contentLines = message.content.split("\n");
		for (const contentLine of contentLines) {
			lines.push(`> ${contentLine}`);
		}
	}

	// Status for sent messages
	if (statusIndicator) {
		lines.push(`> _${statusIndicator}_`);
	}

	lines.push("");
	return lines;
}

/**
 * Format extraction result as legal-style markdown document
 */
function formatImageAsMarkdown(result: ImageTranscriptionResult): string {
	const { sourceFile, extraction, processedAt } = result;
	const filename = getFilename(sourceFile);

	// Count inferred dates
	const inferredDatesCount = extraction.messages.filter(
		(m) => m.date_inferred,
	).length;

	const lines: string[] = [
		"---",
		`arquivo_origem: "${filename}"`,
		`data_extracao: "${processedAt.toISOString()}"`,
		`chat: "${extraction.chat_name}"`,
		`tipo_chat: "${extraction.chat_type}"`,
		`total_mensagens: ${extraction.messages.length}`,
		`datas_inferidas: ${inferredDatesCount}`,
		"---",
		"",
		"# Transcrição de Captura WhatsApp",
		"",
		"## Metadados",
		"",
		`- **Arquivo de origem:** \`${filename}\``,
		`- **Data da extração:** ${processedAt.toLocaleDateString("pt-BR")} às ${processedAt.toLocaleTimeString("pt-BR")}`,
		`- **Chat:** ${extraction.chat_name}`,
		`- **Tipo:** ${extraction.chat_type === "group" ? "Grupo" : "Conversa individual"}`,
		`- **Total de mensagens:** ${extraction.messages.length}`,
	];

	// Participant count for groups
	if (extraction.participant_count) {
		lines.push(`- **Participantes:** ${extraction.participant_count}`);
	}

	// Date separators found
	if (
		extraction.visible_date_separators &&
		extraction.visible_date_separators.length > 0
	) {
		lines.push(
			`- **Separadores de data visíveis:** ${extraction.visible_date_separators.join(", ")}`,
		);
	}

	// Note about inferred dates
	if (inferredDatesCount > 0) {
		lines.push("");
		lines.push(
			`> ⚠️ **Nota:** ${inferredDatesCount} mensagem(ns) com data inferida a partir de "HOJE"/"ONTEM" e data do arquivo.`,
		);
	}

	lines.push("");

	// Screenshot context if available
	if (extraction.screenshot_context) {
		lines.push("## Contexto do Sistema");
		lines.push("");
		lines.push(`> ${extraction.screenshot_context}`);
		lines.push("");
	}

	lines.push("---");
	lines.push("");
	lines.push("## Mensagens");
	lines.push("");

	// Add each message
	for (const message of extraction.messages) {
		lines.push(...formatMessage(message));
	}

	lines.push("---");
	lines.push("");
	lines.push("## Legenda");
	lines.push("");
	lines.push("- ⚠️ Data inferida (não explícita na captura)");
	lines.push("- ↩️ Mensagem encaminhada");
	lines.push("- ✏️ Mensagem editada");
	lines.push("- 📎 Anexo de mídia");
	lines.push("- ✓ Enviada | ✓✓ Entregue | ✓✓ (lida) Visualizada");
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push("*Transcrito automaticamente de captura de tela do WhatsApp*");
	lines.push("");

	// Add legal disclaimer if enabled
	if (currentOptions.includeDisclaimer) {
		lines.push(LEGAL_DISCLAIMER);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Process a single image file end-to-end
 */
async function processImageFile(jpgPath: string): Promise<void> {
	const filename = getFilename(jpgPath);
	console.log(`\n[Processando] ${filename}`);

	try {
		// Step 1: Extract messages using BAML vision
		console.log("  -> Extraindo mensagens...");
		const extraction = await callBAMLVision(jpgPath);

		// Step 2: Format and save markdown
		console.log("  -> Salvando transcrição...");
		const result: ImageTranscriptionResult = {
			sourceFile: jpgPath,
			extraction,
			processedAt: new Date(),
		};

		const markdown = formatImageAsMarkdown(result);
		const mdPath = getMdPath(jpgPath);
		await Bun.write(mdPath, markdown);

		const inferredCount = extraction.messages.filter(
			(m) => m.date_inferred,
		).length;
		const inferredNote =
			inferredCount > 0 ? `, ${inferredCount} data(s) inferida(s)` : "";

		console.log(
			`  -> Concluído: ${getFilename(mdPath)} (${extraction.messages.length} mensagens${inferredNote})`,
		);
	} catch (error) {
		throw new Error(
			`Falha ao processar ${filename}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

// ===== Public API =====

/**
 * Transcribe all pending image files in the source directory
 * @returns Processing statistics
 */
export async function transcribeImages(
	sourceDir: string = CONFIG.SOURCE_DIR,
	options: TranscribeOptions = {},
): Promise<ProcessingStats> {
	// Set module-level options for use in formatting
	currentOptions = options;

	console.log("Buscando capturas de tela (.jpg)...");

	// Find all jpg files
	const allFiles = await findFiles(sourceDir, IMAGE_CONFIG.EXTENSION);
	console.log(`  Encontrados: ${allFiles.length} arquivos .jpg`);

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
	const stats = await processFiles(pending, processImageFile);

	return {
		...stats,
		total: allFiles.length,
		skipped,
	};
}
