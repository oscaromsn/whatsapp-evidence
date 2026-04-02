// =============================================================================
// Markdown Renderer
// Generates Obsidian-compatible markdown from structured messages
// =============================================================================

import { LEGAL_DISCLAIMER } from "../shared";
import type { ContactEntry, RenderedMessage, RenderOptions } from "./types";

// ===== Constants =====

const WEEKDAYS_PT: Record<number, string> = {
	0: "dom",
	1: "seg",
	2: "ter",
	3: "qua",
	4: "qui",
	5: "sex",
	6: "sáb",
};

// ===== Public API =====

export function renderPeriodMarkdown(
	messages: RenderedMessage[],
	contact: ContactEntry,
	period: string,
	options: RenderOptions,
): string {
	const lines: string[] = [];

	// YAML frontmatter
	lines.push("---");
	lines.push(`contact: ${contact.sanitizedName}`);
	lines.push(`type: ${contact.type}`);
	lines.push(`period: ${period}`);
	lines.push(`messages: ${messages.length}`);
	lines.push("sources:");
	for (const zip of contact.sourceZips) {
		lines.push(`  - ${zip}`);
	}
	lines.push("---");
	lines.push("");

	// H1 header with date range
	const [startStr, endStr] = period.split("-") as [string, string];
	const startDisplay = formatPeriodDate(startStr);
	const endDisplay = formatPeriodDate(endStr);
	lines.push(`# ${contact.sanitizedName} — ${startDisplay} a ${endDisplay}`);
	lines.push("");

	// Group messages by day
	let currentDay = "";

	for (const msg of messages) {
		const date = parseTimestamp(msg.timestamp);
		const dayKey = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
		const weekday = WEEKDAYS_PT[date.getDay()];

		if (dayKey !== currentDay) {
			currentDay = dayKey;
			lines.push(`## ${dayKey} ${weekday}`);
			lines.push("");
		}

		lines.push(...renderMessage(msg, options));
		lines.push("");
	}

	// Legal disclaimer
	if (options.disclaimer) {
		lines.push("---");
		lines.push("");
		lines.push(LEGAL_DISCLAIMER);
		lines.push("");
	}

	return lines.join("\n");
}

// ===== Internal Functions =====

function renderMessage(msg: RenderedMessage, options: RenderOptions): string[] {
	const time = formatTime(msg.timestamp);
	const lines: string[] = [];

	// System messages: italic, no sender
	if (msg.type === "system") {
		lines.push(`\`${time}\` _${msg.content}_`);
		return lines;
	}

	// Resolve sender display name
	const displaySender = resolveDisplaySender(msg.sender, options);

	// Deleted messages: sender + italic content
	if (msg.type === "deleted") {
		lines.push(`\`${time}\` **${displaySender}:** _${msg.content}_`);
		return lines;
	}

	// Media omitted
	if (msg.isMediaOmitted) {
		let line = `\`${time}\` **${displaySender}:** <Mídia oculta>`;
		if (msg.content) {
			line += `\n${msg.content}`;
		}
		lines.push(line);
		return lines;
	}

	// Media with file
	if (msg.type === "media" && msg.mediaFile) {
		lines.push(`\`${time}\` **${displaySender}:**`);

		// Wikilink
		if (msg.mediaExists) {
			lines.push(`![[medias/${msg.mediaFile}]]`);
		} else {
			lines.push(`![[medias/${msg.mediaFile}]] <!-- media:missing -->`);
		}

		// Transcription/description blockquote
		if (msg.transcription) {
			const label = getTranscriptionLabel(msg.subtype);
			lines.push(`> **[${label}]** ${msg.transcription}`);
		}

		// Additional text content
		if (msg.content) {
			lines.push(msg.content);
		}

		return lines;
	}

	// Regular text message
	let line = `\`${time}\` **${displaySender}:** ${msg.content}`;

	// Edited annotation
	if (msg.edited) {
		line += " _(editada)_";
	}

	lines.push(line);
	return lines;
}

function resolveDisplaySender(sender: string, options: RenderOptions): string {
	// Apply aliases first
	let resolved = sender;
	if (options.aliases.has(sender)) {
		resolved = options.aliases.get(sender)!;
	}

	// Replace self with "Eu" in individual chats only
	if (!options.isGroup && options.selfName && resolved === options.selfName) {
		return "Eu";
	}

	return resolved;
}

function getTranscriptionLabel(subtype: string | null | undefined): string {
	if (subtype === "image") return "Descrição";
	return "Transcrição";
}

function formatTime(timestamp: string): string {
	// Extract HH:MM from "2026-03-01T14:30:00"
	const timePart = timestamp.split("T")[1]!;
	const [hours, minutes] = timePart.split(":");
	return `${hours}:${minutes}`;
}

function formatPeriodDate(periodDateStr: string): string {
	// Convert "2026.02.24" to "24/02/2026"
	const [year, month, day] = periodDateStr.split(".") as [
		string,
		string,
		string,
	];
	return `${day}/${month}/${year}`;
}

function parseTimestamp(timestamp: string): Date {
	const [datePart, timePart] = timestamp.split("T") as [string, string];
	const [year, month, day] = datePart.split("-").map(Number) as [
		number,
		number,
		number,
	];
	const [hours, minutes, seconds] = timePart.split(":").map(Number) as [
		number,
		number,
		number,
	];
	return new Date(year, month - 1, day, hours, minutes, seconds);
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
