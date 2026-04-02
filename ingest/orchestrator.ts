// =============================================================================
// Ingest Orchestrator
// Main pipeline: extract zips → parse → dedup → split → render → save
// =============================================================================

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { logHeader } from "../shared";
import { detectSelf } from "./contacts";
import { deduplicateMessages } from "./dedup";
import { processMediaFiles } from "./media";
import { parseChatLog } from "./parser";
import { renderPeriodMarkdown } from "./renderer";
import { assignPeriod } from "./splitter";
import {
	createEmptyIndex,
	detectOverlappingContact,
	getContactPeriods,
	getMessagesForPeriod,
	loadIndex,
	mergeMessages,
	saveIndex,
	updateContactMeta,
} from "./store";
import type {
	EvidenceIndex,
	IngestOptions,
	MessageEntry,
	RenderedMessage,
} from "./types";
import { extractZip, findZipFiles } from "./zip";

// ===== Public API =====

export async function runIngest(options: IngestOptions): Promise<void> {
	const log = makeLogger(options);

	log.header("whatsapp-evidence ingest");
	log.info(`Entrada: ${options.input}`);
	log.info(`Saída: ${options.output}`);
	log.info(`Divisão: ${options.split}`);
	log.info(`Layout: ${options.layout}`);
	log.info(`Mídia: ${options.media}`);
	if (options.dryRun) log.info("MODO SIMULAÇÃO (dry-run)");

	// Ensure output dirs exist
	if (!options.dryRun) {
		await mkdir(options.output, { recursive: true });
	}

	// Load or create index
	let index = await loadIndex(options.output);
	const isNewIndex = !index;

	if (!index) {
		index = createEmptyIndex({
			split: options.split,
			layout: options.layout,
			timezone: options.timezone,
			self: options.self,
			aliases: Object.fromEntries(options.aliases),
		});
	}

	// Check for config conflicts
	if (!isNewIndex) {
		if (index.config.split !== options.split) {
			if (!options.force) {
				console.error(
					`Estrutura atual usa '--split ${index.config.split}'. Você solicitou '--split ${options.split}'. Use --force para reorganizar.`,
				);
				process.exit(1);
			}
			log.info(`Reorganizando de ${index.config.split} para ${options.split}`);
			index.config.split = options.split;
			// Reassign all message periods
			for (const entry of Object.values(index.messages)) {
				entry.period = assignPeriod(
					entry.timestamp,
					options.split,
					options.timezone,
				);
			}
		}

		if (index.config.layout !== options.layout) {
			if (!options.force) {
				console.error(
					`Layout atual é '${index.config.layout}'. Você solicitou '${options.layout}'. Use --force para reorganizar.`,
				);
				process.exit(1);
			}
			index.config.layout = options.layout;
		}

		// Update aliases
		if (options.aliases.size > 0) {
			for (const [src, dst] of options.aliases) {
				index.config.aliases[src] = dst;
			}
		}

		if (options.self) {
			index.config.self = options.self;
		}
	}

	// Handle --regenerate: skip zip parsing, go straight to rendering
	if (options.regenerate) {
		log.header("Regenerando markdown");
		await regenerateMarkdown(index, options, log);
		if (!options.dryRun) {
			await saveIndex(options.output, index);
		}
		return;
	}

	// Find and process zips
	const zipFiles = await findZipFiles(options.input);
	if (zipFiles.length === 0) {
		console.error(`Nenhum arquivo .zip encontrado em: ${options.input}`);
		process.exit(1);
	}

	log.info(`Encontrados: ${zipFiles.length} arquivo(s) .zip`);

	const cacheDir = join(options.output, ".cache");
	const allAffectedContacts = new Set<string>();

	// Track senders per contact for self-detection
	const contactSenders = new Map<string, Set<string>>();

	// Process each zip
	let totalAdded = 0;
	let totalSkipped = 0;

	for (const zipPath of zipFiles) {
		const zipFilename = basename(zipPath);
		log.header(`Processando: ${zipFilename}`);

		// Determine which medias dir to use (depends on layout, but for now
		// we place medias in the period dir during rendering)
		// During extraction, place in a temp medias area
		const globalMediasDir = join(options.output, "_medias_staging");

		let extracted: Awaited<ReturnType<typeof extractZip>>;
		try {
			extracted = await extractZip(zipPath, cacheDir, globalMediasDir);
		} catch (err) {
			log.error(`${zipFilename}: ${err instanceof Error ? err.message : err}`);
			continue;
		}

		log.info(`Contato: ${extracted.contactName}`);
		log.info(`Codificação: ${extracted.encoding}`);
		log.info(`Mídias: ${extracted.mediaFiles.length} arquivo(s)`);

		// Parse the chat log
		const chatText = await Bun.file(extracted.chatLogPath).text();
		const parseResult = parseChatLog(chatText, {
			dateFormat: options.dateFormat ?? undefined,
		});

		log.info(`Mensagens: ${parseResult.messages.length}`);
		log.info(`Formato data: ${parseResult.detectedFormat}`);

		for (const w of parseResult.warnings) {
			log.verbose(w);
		}

		// Track senders (done after contact name resolution below)
		const senders = new Set<string>();
		for (const msg of parseResult.messages) {
			if (msg.sender) senders.add(msg.sender);
		}

		// Deduplicate
		const deduped = deduplicateMessages(parseResult.messages);
		const dedupDiff = parseResult.messages.length - deduped.length;
		if (dedupDiff > 0) {
			log.info(`Duplicatas removidas: ${dedupDiff}`);
		}

		// Detect if this zip's messages belong to an existing contact
		let contactName = extracted.contactName;
		const overlapping = detectOverlappingContact(index, deduped, contactName);
		if (overlapping) {
			log.info(
				`Mesma conversa detectada: "${contactName}" → "${overlapping}"`,
			);
			contactName = overlapping;
		}

		// Detect group type
		const isGroup = detectGroupType(deduped, chatText);

		// Merge into index
		const { added, skipped, upgraded } = mergeMessages(
			index,
			contactName,
			deduped,
			zipFilename,
			options.split,
			options.timezone,
		);

		// Update contact metadata
		updateContactMeta(index, contactName, {
			type: isGroup ? "group" : "individual",
			dateFormat: parseResult.detectedFormat,
			encoding: extracted.encoding,
		});

		totalAdded += added;
		totalSkipped += skipped;

		log.info(`Novas: ${added} | Já existentes: ${skipped}${upgraded > 0 ? ` | Mídias recuperadas: ${upgraded}` : ""}`);
		allAffectedContacts.add(contactName);
		contactSenders.set(contactName, senders);

		// Register media entries in the index
		for (const mediaPath of extracted.mediaFiles) {
			const mediaFilename = basename(mediaPath);
			const key = `${contactName}/${mediaFilename}`;

			if (!index.mediaProcessing[key]) {
				index.mediaProcessing[key] = {
					status: "pending",
					type: classifyMediaType(mediaFilename),
					sourceZip: zipFilename,
					originalFilename: mediaFilename,
					transcription: null,
				};
			}
		}
	}

	// Self-sender detection
	if (!index.config.self && !options.self) {
		const detected = detectSelf(contactSenders);
		if (detected) {
			index.config.self = detected;
			log.info(`Auto-detectado remetente: ${detected}`);
		}
	}

	// Dry-run summary
	if (options.dryRun) {
		log.header("Resumo (dry-run)");
		log.info(`Mensagens novas: ${totalAdded}`);
		log.info(`Mensagens duplicadas: ${totalSkipped}`);
		log.info(`Contatos afetados: ${allAffectedContacts.size}`);

		for (const contact of allAffectedContacts) {
			const periods = getContactPeriods(index, contact);
			log.info(`  ${contact}: ${periods.length} período(s)`);
		}

		const pendingMedia = Object.values(index.mediaProcessing).filter(
			(m) => m.status === "pending",
		);
		log.info(`Mídias pendentes: ${pendingMedia.length}`);
		return;
	}

	// Process media if requested
	if (options.media !== "none") {
		log.header("Processando mídias");
		const pendingMedia = Object.entries(index.mediaProcessing)
			.filter(([, m]) => m.status === "pending" || m.status === "failed")
			.map(([key, entry]) => ({
				key,
				entry,
				filePath: join(
					options.output,
					"_medias_staging",
					entry.originalFilename,
				),
			}));

		if (pendingMedia.length > 0) {
			log.info(`${pendingMedia.length} mídia(s) para processar`);
			await processMediaFiles(
				pendingMedia,
				options.media === "all" ? "all" : (options.media as "audio" | "images"),
				options.concurrency,
				(key, status, error) => {
					if (status === "processed") {
						log.info(`  ✓ ${key}`);
					} else {
						log.error(`  ✗ ${key}: ${error}`);
					}
				},
			);
		} else {
			log.info("Nenhuma mídia pendente");
		}
	}

	// Render markdown for affected contacts
	log.header("Gerando markdown");

	const contacts = options.contact
		? new Set([options.contact])
		: allAffectedContacts;

	for (const contactName of contacts) {
		await renderContactMarkdown(index, contactName, options, log);
	}

	// Save index
	await saveIndex(options.output, index);

	// Summary
	log.header("Resumo");
	log.info(`Mensagens novas: ${totalAdded}`);
	log.info(`Mensagens duplicadas: ${totalSkipped}`);
	log.info(`Contatos processados: ${contacts.size}`);
	log.info(
		`Índice salvo em: ${join(options.output, ".whatsapp-evidence.json")}`,
	);
}

// ===== Internal Functions =====

async function regenerateMarkdown(
	index: EvidenceIndex,
	options: IngestOptions,
	log: Logger,
): Promise<void> {
	const contactNames = options.contact
		? [options.contact]
		: Object.keys(index.contacts);

	for (const contactName of contactNames) {
		if (!index.contacts[contactName]) {
			log.error(`Contato não encontrado no índice: ${contactName}`);
			continue;
		}
		await renderContactMarkdown(index, contactName, options, log);
	}
}

async function renderContactMarkdown(
	index: EvidenceIndex,
	contactName: string,
	options: IngestOptions,
	log: Logger,
): Promise<void> {
	const contact = index.contacts[contactName];
	if (!contact) return;

	const periods = getContactPeriods(index, contactName);
	log.info(`${contactName}: ${periods.length} período(s)`);

	const cacheDir = join(options.output, ".cache");

	// Load ALL cached chat logs for this contact, keyed by source zip
	const chatLinesByZip = await loadAllCachedChatLogs(contact, cacheDir);

	for (const period of periods) {
		const messageEntries = getMessagesForPeriod(index, contactName, period);
		if (messageEntries.length === 0) continue;

		// Build RenderedMessage array from index entries + cached content
		const renderedMessages: RenderedMessage[] = messageEntries.map((entry) => {
			const chatLines = chatLinesByZip.get(entry.sourceZip) ?? [];
			return toRenderedMessage(entry, chatLines, index);
		});

		const md = renderPeriodMarkdown(renderedMessages, contact, period, {
			disclaimer: options.disclaimer,
			selfName: index.config.self,
			aliases: new Map(Object.entries(index.config.aliases)),
			isGroup: contact.type === "group",
		});

		// Determine output path
		const outputPath = getOutputPath(
			options.output,
			options.layout,
			contactName,
			contact.sanitizedName,
			period,
		);

		if (!options.dryRun) {
			const dir = outputPath.replace(/\/[^/]+$/, "");
			await mkdir(dir, { recursive: true });

			// Move media files into the period/contact medias dir
			await ensureMediasDir(options.output, dir, index, contactName, period);

			await Bun.write(outputPath, md);
			log.verbose(`  Escrito: ${outputPath}`);
		}
	}
}

function toRenderedMessage(
	entry: MessageEntry,
	chatLines: string[],
	index: EvidenceIndex,
): RenderedMessage {
	// Retrieve content from cached chat lines
	const [startLine, endLine] = entry.sourceLineRange;
	const contentLines = chatLines.slice(startLine - 1, endLine);
	const rawContent = contentLines.join("\n");

	// Detect media omitted BEFORE content extraction strips the markers
	const isMediaOmitted =
		rawContent.includes("<Media omitted>") ||
		rawContent.includes("<Mídia oculta>");

	let content = extractMessageContent(rawContent);

	if (!content) {
		content = "";
	}

	// For media messages, strip the filename from content
	if (entry.mediaFile && content) {
		content = content
			.split("\n")
			.filter((line) => line.trim() !== entry.mediaFile)
			.join("\n")
			.trim();
	}

	// Check if media file was processed
	let transcription: string | null = null;
	if (entry.mediaFile) {
		const mediaKey = `${entry.contact}/${entry.mediaFile}`;
		const mediaEntry = index.mediaProcessing[mediaKey];
		if (mediaEntry?.status === "processed" && mediaEntry.transcription) {
			transcription = mediaEntry.transcription;
		}
	}

	return {
		timestamp: entry.timestamp,
		sender: entry.sender,
		content,
		type: entry.type,
		subtype: entry.subtype,
		mediaFile: entry.mediaFile,
		isMediaOmitted,
		edited: entry.edited,
		replyTo: entry.replyTo,
		transcription,
		mediaExists: true,
	};
}

function extractMessageContent(rawLine: string): string {
	// Extract content after "timestamp - sender: content"
	const match = rawLine.match(
		/^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s\d{1,2}:\d{2}(?::\d{2})?(?:\s[AP]M)?\]?\s[-–]\s(?:[^:]+:\s?)?(.*)/s,
	);
	let content = match ? (match[1] ?? "") : "";

	if (!content) {
		// Bracketed format
		const bracketMatch = rawLine.match(
			/^\[\d{1,2}\/\d{1,2}\/\d{2,4},?\s\d{1,2}:\d{2}(?::\d{2})?\]\s(?:[^:]+:\s?)?(.*)/s,
		);
		content = bracketMatch ? (bracketMatch[1] ?? "") : rawLine;
	}

	// Strip media patterns from content
	// Remove "(file attached)" / "(arquivo anexado)" lines and filename echo
	content = content
		.replace(/^.+\s\(file attached\)\n?/m, "")
		.replace(/^.+\s\(arquivo anexado\)\n?/m, "");

	// Remove standalone filename echo lines (lines that are just a filename)
	const lines = content.split("\n");
	const cleaned = lines.filter((line) => {
		const trimmed = line.trim();
		// Skip lines that look like a standalone filename echo
		if (/^[\w\s()_\-–,.]+\.\w{2,5}$/.test(trimmed) && trimmed.length < 200) {
			return false;
		}
		return true;
	});

	// Remove <Media omitted> / <Mídia oculta>
	content = cleaned
		.join("\n")
		.replace(/<Media omitted>/g, "")
		.replace(/<Mídia oculta>/g, "")
		.trim();

	return content;
}

/**
 * Load all cached chat logs for a contact, keyed by source zip name.
 * Each zip has its own chat log with independent line numbers.
 */
async function loadAllCachedChatLogs(
	contact: { sourceZips: string[] },
	cacheDir: string,
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();

	for (const zipName of contact.sourceZips) {
		const cachePath = join(cacheDir, zipName.replace(/\.zip$/i, ""));

		const glob = new Bun.Glob("*.txt");
		for await (const file of glob.scan({ cwd: cachePath, absolute: true })) {
			const text = await Bun.file(file).text();
			result.set(zipName, text.split("\n"));
			break; // one chat log per zip
		}
	}

	return result;
}

function getOutputPath(
	outputDir: string,
	layout: "by-period" | "by-contact",
	contactName: string,
	sanitizedName: string,
	period: string,
): string {
	if (layout === "by-period") {
		return join(outputDir, period, `${sanitizedName}.md`);
	}
	return join(outputDir, sanitizedName, `${period}.md`);
}

async function ensureMediasDir(
	outputRoot: string,
	mdDir: string,
	index: EvidenceIndex,
	contactName: string,
	period: string,
): Promise<void> {
	// Find media files for this contact+period
	const entries = Object.entries(index.messages).filter(
		([, m]) => m.contact === contactName && m.period === period && m.mediaFile,
	);

	if (entries.length === 0) return;

	const mediasDir = join(mdDir, "medias");
	await mkdir(mediasDir, { recursive: true });

	const stagingDir = join(outputRoot, "_medias_staging");

	for (const [, entry] of entries) {
		if (!entry.mediaFile) continue;
		const srcPath = join(stagingDir, entry.mediaFile);
		const dstPath = join(mediasDir, entry.mediaFile);

		const srcFile = Bun.file(srcPath);
		const dstFile = Bun.file(dstPath);

		if ((await srcFile.exists()) && !(await dstFile.exists())) {
			const content = await srcFile.arrayBuffer();
			await Bun.write(dstPath, content);
		}
	}
}

function detectGroupType(
	messages: Array<{ type: string; content: string; sender: string }>,
	_chatText: string,
): boolean {
	// Check for group-specific system messages
	for (const msg of messages) {
		if (msg.type !== "system") continue;
		const lower = msg.content.toLowerCase();
		if (
			lower.includes("created group") ||
			lower.includes("criou o grupo") ||
			lower.includes("added you") ||
			lower.includes("adicionou você")
		) {
			return true;
		}
	}

	// Check unique non-system senders
	const senders = new Set<string>();
	for (const msg of messages) {
		if (msg.type !== "system" && msg.sender) {
			senders.add(msg.sender);
		}
	}

	return senders.size > 2;
}

function classifyMediaType(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	if (["opus", "ogg", "oga", "m4a"].includes(ext)) return "audio";
	if (["jpg", "jpeg", "png"].includes(ext)) return "image";
	if (["mp4", "3gp"].includes(ext)) return "video";
	if (["webp"].includes(ext)) return "sticker";
	if (["vcf"].includes(ext)) return "contact";
	return "document";
}

// ===== Logging =====

interface Logger {
	header: (title: string) => void;
	info: (msg: string) => void;
	error: (msg: string) => void;
	verbose: (msg: string) => void;
}

function makeLogger(options: IngestOptions): Logger {
	return {
		header: (title: string) => {
			if (!options.quiet) logHeader(title);
		},
		info: (msg: string) => {
			if (!options.quiet) console.error(msg);
		},
		error: (msg: string) => {
			console.error(`[ERRO] ${msg}`);
		},
		verbose: (msg: string) => {
			if (options.verbose) console.error(`[DEBUG] ${msg}`);
		},
	};
}
