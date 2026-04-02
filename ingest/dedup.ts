// =============================================================================
// Deduplication
// SHA256-based message ID computation and duplicate removal
// Handles media-variant messages: <Media omitted> vs actual attachment
// =============================================================================

import type { ParsedMessage } from "./types";

export function computeMessageId(
	timestamp: string,
	sender: string,
	content: string,
): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${timestamp}\0${sender}\0${content}`);
	return hasher.digest("hex");
}

/**
 * Compute a secondary key for matching media-variant messages.
 * Two messages with the same timestamp+sender where one is <Media omitted>
 * and the other has a (file attached) are the same underlying message.
 */
export function computeMediaMatchKey(
	timestamp: string,
	sender: string,
): string {
	return `${timestamp}\0${sender}`;
}

export function deduplicateMessages(
	messages: ParsedMessage[],
): ParsedMessage[] {
	const seenById = new Set<string>();
	// Track media-omitted messages by timestamp+sender so we can upgrade them
	const mediaOmittedByKey = new Map<string, number>(); // key → index in result
	const result: ParsedMessage[] = [];

	for (const msg of messages) {
		const id = computeMessageId(msg.timestamp, msg.sender, msg.content);

		// Exact duplicate — skip
		if (seenById.has(id)) continue;

		const mediaKey = computeMediaMatchKey(msg.timestamp, msg.sender);

		if (msg.isMediaOmitted) {
			// This is a <Media omitted> message
			const existingIdx = mediaOmittedByKey.get(mediaKey);
			if (existingIdx !== undefined) {
				const existing = result[existingIdx]!;
				// If existing has actual media, skip this omitted version
				if (existing.mediaFile) continue;
			}
			// Check if we already have a media version for this key
			const hasMediaVersion = result.some(
				(r) =>
					r.timestamp === msg.timestamp &&
					r.sender === msg.sender &&
					r.mediaFile,
			);
			if (hasMediaVersion) continue;

			seenById.add(id);
			mediaOmittedByKey.set(mediaKey, result.length);
			result.push(msg);
		} else if (msg.mediaFile) {
			// This message has actual media — check if we stored an omitted version
			const omittedIdx = mediaOmittedByKey.get(mediaKey);
			if (omittedIdx !== undefined) {
				// Upgrade: replace the omitted version with the media version
				const omittedMsg = result[omittedIdx]!;
				const omittedId = computeMessageId(
					omittedMsg.timestamp,
					omittedMsg.sender,
					omittedMsg.content,
				);
				seenById.delete(omittedId);
				result[omittedIdx] = msg;
				seenById.add(id);
			} else {
				seenById.add(id);
				result.push(msg);
			}
		} else {
			// Regular text message
			seenById.add(id);
			result.push(msg);
		}
	}

	return result;
}
