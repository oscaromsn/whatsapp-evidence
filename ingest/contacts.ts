// =============================================================================
// Contact Management
// Zip name parsing, name sanitization, self-detection, alias resolution
// =============================================================================

const FORBIDDEN_CHARS = /[/\\:*?"<>|]/g;

// ===== Public API =====

/**
 * Extract the contact/group name from a WhatsApp zip filename.
 * Supports both EN and PT-BR formats.
 */
export function parseContactFromZipName(filename: string): string {
	// Strip path, keep just filename
	const basename = filename.split("/").pop() ?? filename;

	// EN: "WhatsApp Chat with <Name>.zip"
	const enMatch = basename.match(/^WhatsApp Chat with (.+?)\.zip$/i);
	if (enMatch) return enMatch[1]!;

	// Also without .zip
	const enMatch2 = basename.match(/^WhatsApp Chat with (.+)$/i);
	if (enMatch2) return enMatch2[1]!;

	// PT-BR: "Conversa do WhatsApp com <Name>.zip"
	const ptMatch = basename.match(/^Conversa do WhatsApp com (.+?)\.zip$/i);
	if (ptMatch) return ptMatch[1]!;

	// Fallback: filename without extension
	return basename.replace(/\.zip$/i, "");
}

/**
 * Make a name filesystem-safe while preserving readability.
 * Per spec: replace forbidden chars, trim dots/spaces, collapse underscores,
 * keep emoji, truncate to 200 chars.
 */
export function sanitizeName(name: string): string {
	let result = name.replace(FORBIDDEN_CHARS, "_");

	// Collapse consecutive underscores
	result = result.replace(/_+/g, "_");

	// Trim leading/trailing dots and spaces
	result = result.replace(/^[.\s]+|[.\s]+$/g, "");

	// Remove trailing underscore
	result = result.replace(/_+$/, "");

	// Truncate to 200 characters
	if (result.length > 200) {
		result = result.slice(0, 200);
	}

	return result;
}

/**
 * Auto-detect the self-sender: find the sender name that appears
 * across ALL contacts (since the exporter is always present in every export).
 * Returns null if ambiguous (0 or >1 candidates) or only one contact exists.
 */
export function detectSelf(contacts: Map<string, Set<string>>): string | null {
	if (contacts.size <= 1) return null;

	// Count how many contacts each sender appears in
	const senderCounts = new Map<string, number>();
	for (const senders of contacts.values()) {
		for (const sender of senders) {
			senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
		}
	}

	// Find senders that appear in ALL contacts
	const totalContacts = contacts.size;
	const ubiquitous = [...senderCounts.entries()]
		.filter(([, count]) => count === totalContacts)
		.map(([sender]) => sender);

	return ubiquitous.length === 1 ? ubiquitous[0]! : null;
}

/**
 * Apply alias mapping to a sender name.
 */
export function applyAliases(
	sender: string,
	aliases: Map<string, string>,
): string {
	return aliases.get(sender) ?? sender;
}
