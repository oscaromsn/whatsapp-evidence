// =============================================================================
// Index Store
// Reads and writes .whatsapp-evidence.json, merges messages incrementally
// =============================================================================

import { join } from "node:path";
import { writeFileAtomic } from "./atomic";
import { sanitizeName } from "./contacts";
import { computeMediaMatchKey, computeMessageId } from "./dedup";
import { assignPeriod } from "./splitter";
import type {
	ContactEntry,
	EvidenceIndex,
	IndexConfig,
	MessageEntry,
	ParsedMessage,
	SplitInterval,
} from "./types";

const INDEX_FILENAME = ".whatsapp-evidence.json";

// ===== Public API =====

export function createEmptyIndex(config: IndexConfig): EvidenceIndex {
	return {
		version: 1,
		config,
		contacts: {},
		messages: {},
		mediaProcessing: {},
	};
}

export async function loadIndex(
	outputDir: string,
): Promise<EvidenceIndex | null> {
	const indexPath = join(outputDir, INDEX_FILENAME);
	const file = Bun.file(indexPath);

	if (!(await file.exists())) return null;

	const text = await file.text();
	return JSON.parse(text) as EvidenceIndex;
}

export async function saveIndex(
	outputDir: string,
	index: EvidenceIndex,
): Promise<void> {
	const indexPath = join(outputDir, INDEX_FILENAME);
	await writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
}

export function mergeMessages(
	index: EvidenceIndex,
	contactName: string,
	messages: ParsedMessage[],
	zipName: string,
	splitInterval: SplitInterval,
	timezone: string,
): { added: number; skipped: number; upgraded: number } {
	// Ensure contact entry exists
	if (!index.contacts[contactName]) {
		index.contacts[contactName] = {
			type: "individual",
			sourceZips: [],
			messageCount: 0,
			sanitizedName: sanitizeName(contactName),
			dateFormat: "DD/MM",
			encoding: "utf-8",
		};
	}

	const contact = index.contacts[contactName];

	// Add zip source if not already present
	if (!contact.sourceZips.includes(zipName)) {
		contact.sourceZips.push(zipName);
	}

	// Find the current max seq for this contact
	let maxSeq = 0;
	for (const entry of Object.values(index.messages)) {
		if (entry.contact === contactName && entry.seq > maxSeq) {
			maxSeq = entry.seq;
		}
	}

	// Lookups by timestamp+sender for media matching. Only genuine media-omitted
	// entries (type "media" without a file) may be upgraded — a text message that
	// shares timestamp+sender with a following attachment must never be replaced.
	const omittedByMediaKey = new Map<
		string,
		{ id: string; entry: MessageEntry }
	>();
	const withMediaKeys = new Set<string>();
	const trackMediaKey = (key: string, id: string, entry: MessageEntry) => {
		if (entry.type !== "media") return;
		if (entry.mediaFile) {
			withMediaKeys.add(key);
			omittedByMediaKey.delete(key);
		} else if (!withMediaKeys.has(key)) {
			omittedByMediaKey.set(key, { id, entry });
		}
	};
	for (const [id, entry] of Object.entries(index.messages)) {
		if (entry.contact === contactName) {
			trackMediaKey(
				computeMediaMatchKey(entry.timestamp, entry.sender),
				id,
				entry,
			);
		}
	}

	let added = 0;
	let skipped = 0;
	let upgraded = 0;

	for (const msg of messages) {
		const id = computeMessageId(
			msg.timestamp,
			msg.sender,
			msg.content,
			msg.mediaFile,
		);

		// Exact hash match — skip, saving the text if this index predates it
		const known = index.messages[id];
		if (known) {
			if (known.content === undefined) known.content = msg.content;
			skipped++;
			continue;
		}

		// Indexes written before the export's final line break was dropped keyed each
		// chat's last message with a trailing "\n" — re-key it instead of duplicating it
		const legacyId = computeMessageId(
			msg.timestamp,
			msg.sender,
			`${msg.content}\n`,
			msg.mediaFile,
		);
		const legacy = index.messages[legacyId];
		if (legacy) {
			delete index.messages[legacyId];
			index.messages[id] = { ...legacy, content: msg.content };
			skipped++;
			continue;
		}

		// Check for media-variant match: same timestamp+sender but
		// one is <Media omitted> and the other has actual media
		const mediaKey = computeMediaMatchKey(msg.timestamp, msg.sender);
		const existingMatch = omittedByMediaKey.get(mediaKey);

		if (existingMatch && msg.mediaFile) {
			// Upgrade: existing is media-omitted, new has actual media
			// Replace the existing entry with the media version
			delete index.messages[existingMatch.id];
			const period = assignPeriod(msg.timestamp, splitInterval, timezone);
			const entry: MessageEntry = {
				seq: existingMatch.entry.seq, // keep original seq for ordering
				timestamp: msg.timestamp,
				sender: msg.sender,
				contact: contactName,
				type: msg.type,
				subtype: msg.subtype,
				mediaFile: msg.mediaFile,
				mediaProcessed: false,
				replyTo: msg.replyTo,
				edited: msg.edited,
				content: msg.content,
				sourceZip: zipName,
				sourceLineRange: msg.lineRange,
				period,
			};
			index.messages[id] = entry;
			trackMediaKey(mediaKey, id, entry);
			upgraded++;
			continue;
		}

		if (msg.isMediaOmitted && withMediaKeys.has(mediaKey)) {
			// Existing already has media, new is omitted — skip
			skipped++;
			continue;
		}

		maxSeq++;
		const period = assignPeriod(msg.timestamp, splitInterval, timezone);

		const entry: MessageEntry = {
			seq: maxSeq,
			timestamp: msg.timestamp,
			sender: msg.sender,
			contact: contactName,
			type: msg.type,
			subtype: msg.subtype,
			mediaFile: msg.mediaFile,
			mediaProcessed: false,
			replyTo: msg.replyTo,
			edited: msg.edited,
			content: msg.content,
			sourceZip: zipName,
			sourceLineRange: msg.lineRange,
			period,
		};

		index.messages[id] = entry;
		trackMediaKey(mediaKey, id, entry);
		added++;
	}

	// Update contact message count
	contact.messageCount = Object.values(index.messages).filter(
		(m) => m.contact === contactName,
	).length;

	return { added, skipped, upgraded };
}

/**
 * Media keys ("<contact>/<file>") of messages dated within [since, until].
 * Bounds are inclusive "YYYY-MM-DD" strings; null leaves that side open.
 */
export function getLinkedMediaKeys(
	index: EvidenceIndex,
	since: string | null,
	until: string | null,
): Set<string> {
	const keys = new Set<string>();
	for (const entry of Object.values(index.messages)) {
		if (!entry.mediaFile) continue;
		const day = entry.timestamp.slice(0, 10);
		if ((since && day < since) || (until && day > until)) continue;
		keys.add(`${entry.contact}/${entry.mediaFile}`);
	}
	return keys;
}

export function getExistingMessageIds(
	index: EvidenceIndex,
	contactName: string,
): Set<string> {
	const ids = new Set<string>();
	for (const [id, entry] of Object.entries(index.messages)) {
		if (entry.contact === contactName) {
			ids.add(id);
		}
	}
	return ids;
}

/**
 * Detect if a set of messages overlaps significantly with an existing contact.
 * Returns the existing contact name if >30% of messages already exist under it,
 * null otherwise.
 */
export function detectOverlappingContact(
	index: EvidenceIndex,
	messages: ParsedMessage[],
	zipContactName: string,
): string | null {
	// Count how many messages already exist and which contact they belong to
	const contactOverlap = new Map<string, number>();
	let totalOverlap = 0;

	for (const msg of messages) {
		const id = computeMessageId(
			msg.timestamp,
			msg.sender,
			msg.content,
			msg.mediaFile,
		);
		const existing = index.messages[id];
		if (existing && existing.contact !== zipContactName) {
			totalOverlap++;
			const count = contactOverlap.get(existing.contact) ?? 0;
			contactOverlap.set(existing.contact, count + 1);
		}
	}

	if (totalOverlap === 0) return null;

	// Find the contact with the most overlap
	let bestContact = "";
	let bestCount = 0;
	for (const [contact, count] of contactOverlap) {
		if (count > bestCount) {
			bestCount = count;
			bestContact = contact;
		}
	}

	// Require >30% overlap to consider it the same conversation
	const overlapRate = bestCount / messages.length;
	if (overlapRate > 0.3) {
		return bestContact;
	}

	return null;
}

/**
 * Update contact metadata (type, dateFormat, encoding).
 */
export function updateContactMeta(
	index: EvidenceIndex,
	contactName: string,
	meta: Partial<
		Pick<ContactEntry, "type" | "dateFormat" | "dateFormatSource" | "encoding">
	>,
): void {
	const contact = index.contacts[contactName];
	if (!contact) return;
	Object.assign(contact, meta);
}

/**
 * Get all unique periods that have messages for a given contact.
 */
export function getContactPeriods(
	index: EvidenceIndex,
	contactName: string,
): string[] {
	const periods = new Set<string>();
	for (const entry of Object.values(index.messages)) {
		if (entry.contact === contactName) {
			periods.add(entry.period);
		}
	}
	return [...periods].sort();
}

/**
 * Get all messages for a contact in a given period, sorted by seq.
 */
export function getMessagesForPeriod(
	index: EvidenceIndex,
	contactName: string,
	period: string,
): MessageEntry[] {
	return (
		Object.values(index.messages)
			.filter((m) => m.contact === contactName && m.period === period)
			// Chronological: a newer export can bring older messages, which get higher
			// seqs. seq still orders same-second messages as they appeared in the export.
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.seq - b.seq)
	);
}
