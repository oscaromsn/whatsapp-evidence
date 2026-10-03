// =============================================================================
// Chat Log Parser
// Parses WhatsApp exported chat log files into structured messages
// Supports EN and PT-BR formats, Android and iOS
// =============================================================================

import type {
	MediaSubtype,
	ParsedMessage,
	ParseResult,
	SystemSubtype,
	ZipLanguage,
} from "./types";

// ===== Constants =====

// Regex to match the start of a message line across formats:
// EN Android:  1/16/26, 10:09 - Sender: text
// PT-BR Android: [01/03/2026, 14:30:45] Sender: text
// iOS no-brackets: 01/03/2026, 14:30:45 - Sender: text
const MESSAGE_START_RE =
	/^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s(\d{1,2}:\d{2}(?::\d{2})?)(?:\s([AP]M))?\]?\s[-–]\s(.*)$/;

// Bracketed PT-BR format: [DD/MM/YYYY, HH:MM:SS] Sender: text
const BRACKETED_START_RE =
	/^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s(\d{1,2}:\d{2}(?::\d{2})?)\]\s(.*)$/;

// Leading Unicode bidirectional/zero-width marks that WhatsApp (especially iOS)
// prepends to many lines — notably media-attachment and edited/system lines.
// They must be stripped before matching message-start patterns, otherwise a line
// like "<U+200E>[15/04/26, 16:04:50] ..." fails the ^\[ anchor and is mis-merged
// as a continuation of the previous message.
export const LEADING_MARKS_RE =
	/^[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u200b]+/;

// WhatsApp (iOS) injects U+200E/U+200F (LRM/RLM) directional marks throughout an
// automated line -- around timestamps, page counts, and media markers. They are
// invisible formatting, never semantic in chat text, so we strip them globally
// from message content before pattern-matching. (Mention isolates U+2066-U+2069
// are deliberately NOT stripped here -- they wrap @mentions in the body.)
export const INLINE_BIDI_MARKS_RE = /[\u200e\u200f]/g;

const DELETED_PATTERNS = [
	"Esta mensagem foi apagada",
	"Você apagou esta mensagem",
	"This message was deleted",
	"You deleted this message",
];

const EDITED_PATTERNS = ["<This message was edited>", "(editada)", "(edited)"];

const MEDIA_OMITTED_PATTERNS = ["<Media omitted>", "<Mídia oculta>"];

const FILE_ATTACHED_RE = /^(.+)\s\(file attached\)$/;
const ARQUIVO_ANEXADO_RE = /^(.+)\s\(arquivo anexado\)$/;

// iOS media attachment marker: "<attached: FILENAME>", optionally preceded by a
// caption and/or a bullet-separated "N pages" doc preview. Anchored at end with
// filename capture so a caption before it is preserved. Assumes inline bidi marks
// were already stripped (see INLINE_BIDI_MARKS_RE). Capture group 1 is the
// VERBATIM filename — it must match the extracted on-disk media file exactly.
export const IOS_ATTACHED_RE = /\s*<attached:\s*(.+?)>\s*$/;

// iOS document-preview tail to strip from a caption: a bullet + "N pages" /
// "1 page" / PT "N páginas". Requires the U+2022 bullet and is anchored at end,
// cannot match ordinary prose like "see page 5".
export const IOS_DOC_PREVIEW_RE =
	/\s*\u2022\s*[\d.,]+\s*(?:pages?|páginas?|página)\s*$/i;

// iOS "X omitted" markers, used when a chat is exported WITHOUT media. Maps each
// keyword to a MediaSubtype. Anchored at end (the marker is always the tail of the
// line, e.g. "Doc.pdf (bullet) 3 pages document omitted").
export const IOS_OMITTED_PATTERNS: Array<[RegExp, MediaSubtype]> = [
	[/(?:^|\s)image omitted$/i, "image"],
	[/(?:^|\s)video omitted$/i, "video"],
	[/(?:^|\s)audio omitted$/i, "audio"],
	[/(?:^|\s)sticker omitted$/i, "sticker"],
	[/(?:^|\s)GIF omitted$/i, "video"],
	[/(?:^|\s)Contact card omitted$/i, "contact"],
	[/(?:^|\s)document omitted$/i, "document"],
];

// iOS prefixes every attached file with a per-chat sequence number
// ("00000012-Proposta.pdf"); documents repeat their title (without it) as caption.
const IOS_SEQ_PREFIX_RE = /^\d+-/;

const ENCRYPTION_PATTERNS = [
	"end-to-end encrypted",
	"criptografia de ponta a ponta",
	"protegidas com a criptografia",
];

const CALL_PATTERNS = [
	"Chamada de voz",
	"Chamada de vídeo",
	"Missed voice call",
	"Missed video call",
	"Voice call",
	"Video call",
];

const MEMBERSHIP_PATTERNS = [
	"added you",
	"added",
	"removed",
	"left",
	"adicionou você",
	"adicionou",
	"removeu",
	"saiu",
];

const ADMIN_PATTERNS = [
	"created group",
	"criou o grupo",
	"changed the subject",
	"alterou o assunto",
	"changed the group description",
	"changed this group's icon",
	"changed the group's",
];

const AUDIO_EXTENSIONS = new Set(["opus", "ogg", "oga", "m4a"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "3gp"]);
const STICKER_EXTENSIONS = new Set(["webp"]);
const CONTACT_EXTENSIONS = new Set(["vcf"]);

// ===== Public API =====

// iOS media markers. Bidi marks are stripped only on a probe copy, so the content
// (and therefore the message ID) of ordinary text messages is never altered.
export function extractIosAttachment(
	content: string,
): { filename: string; caption: string } | null {
	const probe = content.replace(INLINE_BIDI_MARKS_RE, "");
	const match = probe.match(IOS_ATTACHED_RE);
	if (!match || match.index === undefined) return null;

	// Verbatim (no Unicode normalization): must equal the extracted file name
	const filename = match[1]!.trim();
	const caption = probe
		.slice(0, match.index)
		.replace(IOS_DOC_PREVIEW_RE, "")
		.trim();
	const isTitleEcho = caption === filename.replace(IOS_SEQ_PREFIX_RE, "");
	return { filename, caption: isTitleEcho ? "" : caption };
}

export function matchIosOmitted(
	content: string,
): { subtype: MediaSubtype; rest: string } | null {
	const probe = content.replace(INLINE_BIDI_MARKS_RE, "").trimEnd();
	for (const [pattern, subtype] of IOS_OMITTED_PATTERNS) {
		if (pattern.test(probe)) {
			const rest = probe
				.replace(pattern, "")
				.replace(IOS_DOC_PREVIEW_RE, "")
				.trim();
			return { subtype, rest };
		}
	}
	return null;
}

export function detectZipLanguage(zipFilename: string): ZipLanguage {
	if (/Conversa do WhatsApp/i.test(zipFilename)) return "pt-br";
	return "en";
}

export function detectDateFormat(
	lines: string[],
	zipLanguage: ZipLanguage,
): "DD/MM" | "MM/DD" | null {
	// Scan all message-start lines and return as soon as a value disambiguates the
	// order. We do NOT cap the sample (a previous 20-line cap misfired on chats that
	// open with several days of day<=12 dates, e.g. "10/02"), and we tolerate the
	// leading bidi/zero-width marks WhatsApp prepends to many lines.
	const dateRe = new RegExp(
		`${LEADING_MARKS_RE.source.replace(/\+$/, "*")}\\[?(\\d{1,2})\\/(\\d{1,2})\\/\\d{2,4}`,
	);

	for (const line of lines) {
		const match = line.match(dateRe);
		if (!match) continue;

		const first = Number.parseInt(match[1]!, 10);
		const second = Number.parseInt(match[2]!, 10);

		// If first field > 12, it must be the day → DD/MM
		if (first > 12) return "DD/MM";
		// If second field > 12, it must be the day → MM/DD
		if (second > 12) return "MM/DD";
	}

	// Fully ambiguous (no field ever exceeds 12): fall back to language hint
	return zipLanguage === "pt-br" ? "DD/MM" : "MM/DD";
}

export function parseChatLog(
	text: string,
	options: { dateFormat?: "DD/MM" | "MM/DD" } = {},
): ParseResult {
	// Split on CRLF, lone CR, or LF. WhatsApp exports are commonly CRLF; a
	// leftover trailing "\r" breaks the message-start regexes (the `.` in `(.*)$`
	// does not match "\r", and `$` does not anchor before a lone "\r").
	// The export's final line break is dropped first: otherwise it becomes part of
	// the last message, which then differs from the same message in a later export.
	const lines = text.replace(/(?:\r\n|\r|\n)+$/, "").split(/\r\n|\r|\n/);
	const warnings: string[] = [];

	// Detect date format if not provided
	const zipLanguage: ZipLanguage = detectLanguageFromContent(lines);
	const dateFormat =
		options.dateFormat ?? detectDateFormat(lines, zipLanguage) ?? "MM/DD";

	// First pass: group lines into raw message blocks
	const blocks: Array<{
		datePart: string;
		timePart: string;
		ampm: string | null;
		body: string;
		startLine: number;
		endLine: number;
	}> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const lineNum = i + 1; // 1-based

		const parsed = parseMessageStartLine(line);
		if (parsed) {
			blocks.push({
				datePart: parsed.datePart,
				timePart: parsed.timePart,
				ampm: parsed.ampm,
				body: parsed.body,
				startLine: lineNum,
				endLine: lineNum,
			});
		} else if (blocks.length > 0) {
			// Continuation line
			const last = blocks[blocks.length - 1]!;
			last.body += `\n${line}`;
			last.endLine = lineNum;
		} else {
			warnings.push(`Line ${lineNum}: unparseable: ${line}`);
		}
	}

	// Second pass: parse each block into a ParsedMessage
	const messages: ParsedMessage[] = [];

	for (const block of blocks) {
		const timestamp = resolveTimestamp(
			block.datePart,
			block.timePart,
			block.ampm,
			dateFormat,
		);

		const msg = parseMessageBody(block.body, timestamp, [
			block.startLine,
			block.endLine,
		]);

		// Handle file attachment echo lines:
		// After "(file attached)" the next continuation line may just echo the filename
		if (msg.mediaFile && block.body.includes("\n")) {
			const bodyLines = block.body.split("\n");
			const cleanedLines: string[] = [];
			let skipNext = false;

			for (let j = 0; j < bodyLines.length; j++) {
				const bodyLine = bodyLines[j]!;
				if (skipNext) {
					// Check if this line is just the filename echo
					if (bodyLine.trim() === msg.mediaFile) {
						skipNext = false;
						continue;
					}
					skipNext = false;
				}

				if (
					bodyLine.match(FILE_ATTACHED_RE) ||
					bodyLine.match(ARQUIVO_ANEXADO_RE)
				) {
					cleanedLines.push(bodyLine);
					skipNext = true;
				} else {
					cleanedLines.push(bodyLine);
				}
			}

			// Reconstruct the content without the sender prefix and without filename echo
			const senderMatch = block.body.match(/^([^:]+):\s*/);
			if (senderMatch) {
				const afterSender = cleanedLines
					.join("\n")
					.slice(senderMatch[0].length);
				msg.content = processContent(afterSender, msg);
			}
		}

		messages.push(msg);
	}

	return { messages, detectedFormat: dateFormat, warnings };
}

// ===== Internal Functions =====

function detectLanguageFromContent(lines: string[]): ZipLanguage {
	for (const line of lines.slice(0, 5)) {
		if (/criptografia de ponta a ponta/i.test(line)) return "pt-br";
		if (/end-to-end encrypted/i.test(line)) return "en";
		if (/Conversa do WhatsApp/i.test(line)) return "pt-br";
	}
	return "en";
}

interface LineParseResult {
	datePart: string;
	timePart: string;
	ampm: string | null;
	body: string;
}

function parseMessageStartLine(line: string): LineParseResult | null {
	// Strip leading bidi/zero-width marks so iOS lines such as
	// "<U+200E>[15/04/26, ...]" are recognized as message starts, not continuations.
	const stripped = line.replace(LEADING_MARKS_RE, "");

	// Try bracketed format first: [DD/MM/YYYY, HH:MM:SS] Body
	const bracketMatch = stripped.match(BRACKETED_START_RE);
	if (bracketMatch) {
		return {
			datePart: bracketMatch[1]!,
			timePart: bracketMatch[2]!,
			ampm: null,
			body: bracketMatch[3]!,
		};
	}

	// Try standard format: D/M/YY, HH:MM - Body
	const match = stripped.match(MESSAGE_START_RE);
	if (match) {
		return {
			datePart: match[1]!,
			timePart: match[2]!,
			ampm: match[3] ?? null,
			body: match[4]!,
		};
	}

	return null;
}

function resolveTimestamp(
	datePart: string,
	timePart: string,
	ampm: string | null,
	dateFormat: "DD/MM" | "MM/DD",
): string {
	const [p1, p2, yearStr] = datePart.split("/") as [string, string, string];
	let day: number;
	let month: number;

	if (dateFormat === "DD/MM") {
		day = Number.parseInt(p1, 10);
		month = Number.parseInt(p2, 10);
	} else {
		month = Number.parseInt(p1, 10);
		day = Number.parseInt(p2, 10);
	}

	let year = Number.parseInt(yearStr, 10);
	if (year < 100) {
		year += 2000;
	}

	// Parse time
	const timeParts = timePart.split(":");
	let hours = Number.parseInt(timeParts[0]!, 10);
	const minutes = Number.parseInt(timeParts[1]!, 10);
	const seconds = timeParts[2] ? Number.parseInt(timeParts[2], 10) : 0;

	// Handle AM/PM
	if (ampm) {
		if (ampm === "PM" && hours !== 12) hours += 12;
		if (ampm === "AM" && hours === 12) hours = 0;
	}

	const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
	return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function parseMessageBody(
	body: string,
	timestamp: string,
	lineRange: [number, number],
): ParsedMessage {
	// Try to split into sender: content
	// Check for "sender: content" or "sender:" (empty content)
	const colonIndex = body.indexOf(": ");
	let sender: string;
	let rawContent: string;

	if (colonIndex !== -1) {
		sender = body.slice(0, colonIndex);
		rawContent = body.slice(colonIndex + 2);
	} else if (body.endsWith(":") || body.includes(":\n")) {
		// Empty content: "Sender:" or "Sender:\ncontinuation"
		const endColonIndex = body.indexOf(":");
		sender = body.slice(0, endColonIndex);
		rawContent = body.slice(endColonIndex + 1).trimStart();
	} else {
		// No colon → system message
		return createSystemMessage(body, timestamp, lineRange);
	}

	// Check if this is actually a system message (some system messages have no sender)
	if (isSystemContent(body) && colonIndex > 50) {
		// Long text before colon likely means no real sender
		return createSystemMessage(body, timestamp, lineRange);
	}

	const msg: ParsedMessage = {
		lineRange,
		timestamp,
		sender,
		content: "",
		type: "text",
		subtype: null,
		mediaFile: null,
		isMediaOmitted: false,
		edited: false,
		replyTo: null,
	};

	msg.content = processContent(rawContent, msg);
	return msg;
}

function processContent(rawContent: string, msg: ParsedMessage): string {
	let content = rawContent;

	// Check for deleted messages
	for (const pattern of DELETED_PATTERNS) {
		if (content.trim() === pattern) {
			msg.type = "deleted";
			return content.trim();
		}
	}

	// Check for edited messages
	for (const pattern of EDITED_PATTERNS) {
		if (content.includes(pattern)) {
			msg.edited = true;
			content = content.replace(pattern, "").trim();
		}
	}

	// Check for media omitted
	for (const pattern of MEDIA_OMITTED_PATTERNS) {
		if (content.includes(pattern)) {
			msg.isMediaOmitted = true;
			msg.type = "media";
			// Keep any text after the omitted marker
			content = content.replace(pattern, "").trim();
			return content;
		}
	}

	// iOS attachment: "[caption] <attached: FILE>"
	const iosAttachment = extractIosAttachment(content);
	if (iosAttachment) {
		msg.mediaFile = iosAttachment.filename;
		msg.type = "media";
		msg.subtype = classifyMediaFile(iosAttachment.filename);
		return iosAttachment.caption;
	}

	// iOS export without media: "image omitted", "Doc.pdf • 3 pages document omitted"
	const iosOmitted = matchIosOmitted(content);
	if (iosOmitted) {
		msg.isMediaOmitted = true;
		msg.type = "media";
		msg.subtype = iosOmitted.subtype;
		return iosOmitted.rest;
	}

	// Check for file attached
	const firstLine = content.split("\n")[0]!;
	const fileMatch =
		firstLine.match(FILE_ATTACHED_RE) ?? firstLine.match(ARQUIVO_ANEXADO_RE);

	if (fileMatch) {
		const filename = fileMatch[1]!.trim();
		msg.mediaFile = filename;
		msg.type = "media";
		msg.subtype = classifyMediaFile(filename);

		// Get remaining content after the attachment line (excluding filename echo)
		const contentLines = content.split("\n");
		const remainingLines: string[] = [];
		let skipEcho = true;

		for (let i = 1; i < contentLines.length; i++) {
			if (skipEcho && contentLines[i]!.trim() === filename) {
				skipEcho = false;
				continue;
			}
			skipEcho = false;
			remainingLines.push(contentLines[i]!);
		}

		return remainingLines.join("\n").trim();
	}

	return content;
}

function createSystemMessage(
	body: string,
	timestamp: string,
	lineRange: [number, number],
): ParsedMessage {
	return {
		lineRange,
		timestamp,
		sender: "",
		content: body,
		type: "system",
		subtype: classifySystemMessage(body),
		mediaFile: null,
		isMediaOmitted: false,
		edited: false,
		replyTo: null,
	};
}

function classifySystemMessage(content: string): SystemSubtype {
	const lower = content.toLowerCase();

	for (const pattern of ENCRYPTION_PATTERNS) {
		if (lower.includes(pattern.toLowerCase())) return "encryption";
	}

	for (const pattern of CALL_PATTERNS) {
		if (lower.includes(pattern.toLowerCase())) return "call";
	}

	for (const pattern of ADMIN_PATTERNS) {
		if (lower.includes(pattern.toLowerCase())) return "admin";
	}

	for (const pattern of MEMBERSHIP_PATTERNS) {
		if (lower.includes(pattern.toLowerCase())) return "membership";
	}

	return "other";
}

function classifyMediaFile(filename: string): MediaSubtype {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";

	if (AUDIO_EXTENSIONS.has(ext)) return "audio";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (VIDEO_EXTENSIONS.has(ext)) return "video";
	if (STICKER_EXTENSIONS.has(ext)) return "sticker";
	if (CONTACT_EXTENSIONS.has(ext)) return "contact";
	return "document";
}

function isSystemContent(body: string): boolean {
	const lower = body.toLowerCase();
	return (
		ENCRYPTION_PATTERNS.some((p) => lower.includes(p.toLowerCase())) ||
		CALL_PATTERNS.some((p) => lower.includes(p.toLowerCase())) ||
		ADMIN_PATTERNS.some((p) => lower.includes(p.toLowerCase())) ||
		MEMBERSHIP_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
	);
}
