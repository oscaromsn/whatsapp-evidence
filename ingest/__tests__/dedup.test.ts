import { describe, expect, test } from "bun:test";
import { computeMessageId, deduplicateMessages } from "../dedup";
import type { ParsedMessage } from "../types";

function makeMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		lineRange: [1, 1] as [number, number],
		timestamp: "2026-03-01T14:30:00",
		sender: "João Silva",
		content: "Bom dia",
		type: "text",
		subtype: null,
		mediaFile: null,
		isMediaOmitted: false,
		edited: false,
		replyTo: null,
		...overrides,
	};
}

describe("computeMessageId", () => {
	test("returns deterministic hash", () => {
		const id1 = computeMessageId("2026-03-01T14:30:00", "João", "Bom dia");
		const id2 = computeMessageId("2026-03-01T14:30:00", "João", "Bom dia");
		expect(id1).toBe(id2);
	});

	test("returns hex string", () => {
		const id = computeMessageId("2026-03-01T14:30:00", "João", "Bom dia");
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	test("different timestamp produces different hash", () => {
		const id1 = computeMessageId("2026-03-01T14:30:00", "João", "Bom dia");
		const id2 = computeMessageId("2026-03-01T14:31:00", "João", "Bom dia");
		expect(id1).not.toBe(id2);
	});

	test("different sender produces different hash", () => {
		const id1 = computeMessageId("2026-03-01T14:30:00", "João", "Bom dia");
		const id2 = computeMessageId("2026-03-01T14:30:00", "Maria", "Bom dia");
		expect(id1).not.toBe(id2);
	});

	test("different content produces different hash", () => {
		const id1 = computeMessageId("2026-03-01T14:30:00", "João", "Bom dia");
		const id2 = computeMessageId("2026-03-01T14:30:00", "João", "Boa tarde");
		expect(id1).not.toBe(id2);
	});
});

describe("deduplicateMessages", () => {
	test("removes exact duplicate messages", () => {
		const msgs = [
			makeMessage({ content: "Hello" }),
			makeMessage({ content: "Hello" }),
			makeMessage({ content: "World" }),
		];
		const result = deduplicateMessages(msgs);
		expect(result.length).toBe(2);
		expect(result[0]!.content).toBe("Hello");
		expect(result[1]!.content).toBe("World");
	});

	test("preserves order", () => {
		const msgs = [
			makeMessage({ content: "First", timestamp: "2026-03-01T10:00:00" }),
			makeMessage({ content: "Second", timestamp: "2026-03-01T11:00:00" }),
			makeMessage({ content: "Third", timestamp: "2026-03-01T12:00:00" }),
		];
		const result = deduplicateMessages(msgs);
		expect(result.map((m) => m.content)).toEqual(["First", "Second", "Third"]);
	});

	test("keeps first occurrence on duplicate", () => {
		const msgs = [
			makeMessage({ content: "Hello", lineRange: [1, 1] }),
			makeMessage({ content: "Hello", lineRange: [5, 5] }),
		];
		const result = deduplicateMessages(msgs);
		expect(result.length).toBe(1);
		expect(result[0]!.lineRange).toEqual([1, 1]);
	});

	test("returns empty array for empty input", () => {
		expect(deduplicateMessages([])).toEqual([]);
	});

	test("same content from different senders are not duplicates", () => {
		const msgs = [
			makeMessage({ sender: "João", content: "Bom dia" }),
			makeMessage({ sender: "Maria", content: "Bom dia" }),
		];
		const result = deduplicateMessages(msgs);
		expect(result.length).toBe(2);
	});
});
