import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEmptyIndex,
	getExistingMessageIds,
	loadIndex,
	mergeMessages,
	saveIndex,
} from "../store";
import type { EvidenceIndex, IndexConfig, ParsedMessage } from "../types";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "wae-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const defaultConfig: IndexConfig = {
	split: "1w",
	layout: "by-period",
	timezone: "America/Sao_Paulo",
	self: null,
	aliases: {},
};

function makeMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
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

describe("createEmptyIndex", () => {
	test("creates valid empty index", () => {
		const index = createEmptyIndex(defaultConfig);
		expect(index.version).toBe(1);
		expect(index.config).toEqual(defaultConfig);
		expect(index.contacts).toEqual({});
		expect(index.messages).toEqual({});
		expect(index.mediaProcessing).toEqual({});
	});
});

describe("loadIndex / saveIndex round-trip", () => {
	test("returns null for non-existent index", async () => {
		const result = await loadIndex(tempDir);
		expect(result).toBeNull();
	});

	test("saves and loads index correctly", async () => {
		const index = createEmptyIndex(defaultConfig);
		index.contacts["João Silva"] = {
			type: "individual",
			sourceZips: ["test.zip"],
			messageCount: 1,
			sanitizedName: "João Silva",
			dateFormat: "DD/MM",
			encoding: "utf-8",
		};

		await saveIndex(tempDir, index);
		const loaded = await loadIndex(tempDir);

		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(1);
		expect(loaded!.contacts["João Silva"]!.messageCount).toBe(1);
	});

	test("preserves all fields through round-trip", async () => {
		const index = createEmptyIndex(defaultConfig);
		index.messages["abc123"] = {
			seq: 1,
			timestamp: "2026-03-01T14:30:00",
			sender: "João",
			contact: "João",
			type: "text",
			subtype: null,
			mediaFile: null,
			mediaProcessed: false,
			replyTo: null,
			edited: false,
			sourceZip: "test.zip",
			sourceLineRange: [1, 1],
			period: "2026.02.24-2026.03.01",
		};

		await saveIndex(tempDir, index);
		const loaded = await loadIndex(tempDir);

		expect(loaded!.messages["abc123"]).toEqual(index.messages["abc123"]);
	});
});

describe("mergeMessages", () => {
	test("adds new messages to empty index", () => {
		const index = createEmptyIndex(defaultConfig);
		const messages = [
			makeMsg({ content: "Hello" }),
			makeMsg({
				content: "World",
				timestamp: "2026-03-01T14:31:00",
			}),
		];

		const result = mergeMessages(
			index,
			"João Silva",
			messages,
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		expect(result.added).toBe(2);
		expect(result.skipped).toBe(0);
		expect(Object.keys(index.messages).length).toBe(2);
		expect(index.contacts["João Silva"]!.messageCount).toBe(2);
	});

	test("skips duplicate messages", () => {
		const index = createEmptyIndex(defaultConfig);
		const messages = [makeMsg({ content: "Hello" })];

		// First merge
		mergeMessages(
			index,
			"João Silva",
			messages,
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		// Second merge with same message
		const result = mergeMessages(
			index,
			"João Silva",
			messages,
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		expect(result.added).toBe(0);
		expect(result.skipped).toBe(1);
		expect(Object.keys(index.messages).length).toBe(1);
	});

	test("assigns monotonic sequence numbers", () => {
		const index = createEmptyIndex(defaultConfig);
		const messages = [
			makeMsg({ content: "First", timestamp: "2026-03-01T10:00:00" }),
			makeMsg({ content: "Second", timestamp: "2026-03-01T11:00:00" }),
			makeMsg({ content: "Third", timestamp: "2026-03-01T12:00:00" }),
		];

		mergeMessages(
			index,
			"João Silva",
			messages,
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		const seqs = Object.values(index.messages).map((m) => m.seq);
		expect(seqs).toEqual([1, 2, 3]);
	});

	test("assigns period labels", () => {
		const index = createEmptyIndex(defaultConfig);
		const messages = [makeMsg({ timestamp: "2026-03-01T14:30:00" })];

		mergeMessages(
			index,
			"João Silva",
			messages,
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		const entry = Object.values(index.messages)[0]!;
		expect(entry.period).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{4}\.\d{2}\.\d{2}$/);
	});

	test("creates contact entry on first merge", () => {
		const index = createEmptyIndex(defaultConfig);
		mergeMessages(
			index,
			"João Silva",
			[makeMsg()],
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		expect(index.contacts["João Silva"]).toBeDefined();
		expect(index.contacts["João Silva"]!.sourceZips).toContain("test.zip");
	});

	test("appends source zip to existing contact", () => {
		const index = createEmptyIndex(defaultConfig);
		mergeMessages(
			index,
			"João Silva",
			[makeMsg()],
			"export1.zip",
			"1w",
			"America/Sao_Paulo",
		);
		mergeMessages(
			index,
			"João Silva",
			[makeMsg({ content: "New", timestamp: "2026-04-01T10:00:00" })],
			"export2.zip",
			"1w",
			"America/Sao_Paulo",
		);

		expect(index.contacts["João Silva"]!.sourceZips).toEqual([
			"export1.zip",
			"export2.zip",
		]);
	});
});

describe("getExistingMessageIds", () => {
	test("returns empty set for unknown contact", () => {
		const index = createEmptyIndex(defaultConfig);
		expect(getExistingMessageIds(index, "Unknown").size).toBe(0);
	});

	test("returns message ids for known contact", () => {
		const index = createEmptyIndex(defaultConfig);
		mergeMessages(
			index,
			"João Silva",
			[makeMsg()],
			"test.zip",
			"1w",
			"America/Sao_Paulo",
		);

		const ids = getExistingMessageIds(index, "João Silva");
		expect(ids.size).toBe(1);
	});
});
