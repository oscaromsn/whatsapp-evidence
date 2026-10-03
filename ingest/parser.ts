// =============================================================================
// Chat Log Parser
// Parses WhatsApp exported chat log files into structured messages
// Supports EN and PT-BR formats, Android and iOS
// =============================================================================

import type {
	DateFormat,
	DateFormatSource,
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

// ===== Date order =====
// A chat's dates are day-first (DD/MM, a Brazilian phone) or month-first (MM/DD, US).
// The order is decided by evidence, never by the language of the export's banner:
// an iPhone set to English still writes Brazilian dates.

// Date fields at the start of a message line, tolerating WhatsApp's leading bidi marks
const DATE_FIELDS_RE = new RegExp(
	`${LEADING_MARKS_RE.source.replace(/\+$/, "*")}\\[?(\\d{1,2})\\/(\\d{1,2})\\/\\d{2,4}`,
);

/**
 * Evidence from the dates themselves: a field above 12 can only be the day. Scans the
 * whole chat (a 20-line cap once misfired on chats opening with days <= 12). Null when
 * no date ever disambiguates.
 */
export function detectDateFormat(lines: string[]): DateFormat | null {
	for (const line of lines) {
		const match = line.match(DATE_FIELDS_RE);
		if (!match) continue;
		const first = Number.parseInt(match[1]!, 10);
		const second = Number.parseInt(match[2]!, 10);
		if (first > 12) return "DD/MM";
		if (second > 12) return "MM/DD";
	}
	return null;
}

// Attachment names that embed the real date: iOS "00000019-PHOTO-2026-10-02-09-14-31.jpg",
// Android "IMG-20260326-WA0025.jpg".
const ATTACHMENT_DATE_RES = [
	/-(?:PHOTO|AUDIO|VIDEO|STICKER|GIF)-(\d{4})-(\d{2})-(\d{2})-/,
	/\b(?:IMG|VID|AUD|PTT|STK|DOC)-(\d{4})(\d{2})(\d{2})-WA\d+/,
];

/**
 * Evidence from attachments: the date in an attachment's name, compared with the date
 * of the message carrying it, shows which field is the day. A majority vote, since a
 * forwarded file can carry another date.
 */
export function detectDateFormatFromAttachments(
	lines: string[],
): DateFormat | null {
	let dayFirst = 0;
	let monthFirst = 0;
	let fields: [number, number] | null = null;
	for (const line of lines) {
		const start = line.match(DATE_FIELDS_RE);
		if (start) {
			fields = [Number.parseInt(start[1]!, 10), Number.parseInt(start[2]!, 10)];
		}
		if (!fields || fields[0] === fields[1]) continue;
		for (const re of ATTACHMENT_DATE_RES) {
			const named = line.match(re);
			if (!named) continue;
			const month = Number.parseInt(named[2]!, 10);
			const day = Number.parseInt(named[3]!, 10);
			if (fields[0] === day && fields[1] === month) dayFirst++;
			else if (fields[0] === month && fields[1] === day) monthFirst++;
		}
	}
	if (dayFirst > monthFirst) return "DD/MM";
	if (monthFirst > dayFirst) return "MM/DD";
	return null;
}

/** Forced order, else the dates' evidence, else the attachments', else the default. */
export function resolveDateFormat(
	lines: string[],
	options: { dateFormat?: DateFormat; defaultDateFormat?: DateFormat } = {},
): { format: DateFormat; source: DateFormatSource } {
	if (options.dateFormat)
		return { format: options.dateFormat, source: "forced" };
	const fromDates = detectDateFormat(lines);
	if (fromDates) return { format: fromDates, source: "dates" };
	const fromAttachments = detectDateFormatFromAttachments(lines);
	if (fromAttachments)
		return { format: fromAttachments, source: "attachments" };
	return { format: options.defaultDateFormat ?? "DD/MM", source: "default" };
}

/** A date that exists on the calendar: rejects month 25, 31/02 and the like. */
function isRealDate(timestamp: string): boolean {
	const [year, month, day] = timestamp
		.slice(0, 10)
		.split("-")
		.map((part) => Number.parseInt(part, 10)) as [number, number, number];
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

export function parseChatLog(
	text: string,
	options: { dateFormat?: DateFormat; defaultDateFormat?: DateFormat } = {},
): ParseResult {
	// Split on CRLF, lone CR, or LF. WhatsApp exports are commonly CRLF; a
	// leftover trailing "\r" breaks the message-start regexes (the `.` in `(.*)$`
	// does not match "\r", and `$` does not anchor before a lone "\r").
	// The export's final line break is dropped first: otherwise it becomes part of
	// the last message, which then differs from the same message in a later export.
	const lines = text.replace(/(?:\r\n|\r|\n)+$/, "").split(/\r\n|\r|\n/);
	const warnings: string[] = [];

	const { format: dateFormat, source: dateFormatSource } = resolveDateFormat(
		lines,
		options,
	);

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
	const impossible: string[] = [];

	for (const block of blocks) {
		const timestamp = resolveTimestamp(
			block.datePart,
			block.timePart,
			block.ampm,
			dateFormat,
		);
		if (!isRealDate(timestamp)) {
			impossible.push(`linha ${block.startLine} ("${block.datePart}")`);
			continue;
		}

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

	// A date that cannot exist means the order is wrong (e.g. a US export forced to
	// DD/MM turns "1/25/26" into month 25) — refuse rather than file it years away
	if (impossible.length > 0) {
		const other = dateFormat === "DD/MM" ? "MM/DD" : "DD/MM";
		throw new Error(
			`${impossible.length} data(s) impossível(is) lida(s) como ${dateFormat}: ${impossible.slice(0, 3).join(", ")}. ` +
				`A conversa usa a ordem ${other}: rode sem --date-format (detecção automática) ou com --date-format ${other}`,
		);
	}

	return { messages, detectedFormat: dateFormat, dateFormatSource, warnings };
}

// ===== Internal Functions =====

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
