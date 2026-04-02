import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIngest } from "../orchestrator";
import { loadIndex } from "../store";
import type { IngestOptions } from "../types";

const FIXTURES_DIR = join(import.meta.dir, "../../zips");

let outputDir: string;

function defaultOptions(overrides: Partial<IngestOptions> = {}): IngestOptions {
	return {
		input: FIXTURES_DIR,
		output: outputDir,
		split: "1mo",
		layout: "by-period",
		media: "none",
		disclaimer: false,
		force: false,
		self: "Oscar Neto",
		timezone: "America/Sao_Paulo",
		dateFormat: null,
		aliases: new Map(),
		concurrency: 3,
		regenerate: false,
		contact: null,
		dryRun: false,
		quiet: true,
		verbose: false,
		...overrides,
	};
}

beforeEach(async () => {
	outputDir = await mkdtemp(join(tmpdir(), "wae-orchestrator-test-"));
});

afterEach(async () => {
	await rm(outputDir, { recursive: true, force: true });
});

describe("runIngest", () => {
	test("dry-run does not create index or markdown files", async () => {
		await runIngest(defaultOptions({ dryRun: true }));

		// No index file should exist
		const indexFile = Bun.file(join(outputDir, ".whatsapp-evidence.json"));
		expect(await indexFile.exists()).toBe(false);

		// No .md files should exist
		const allFiles = await readdir(outputDir, { recursive: true });
		const mdFiles = allFiles.filter((f) => f.toString().endsWith(".md"));
		expect(mdFiles.length).toBe(0);
	}, 60000);

	test("creates index and markdown for smallest fixture", async () => {
		// Use a single zip to keep it fast
		const singleZipDir = await mkdtemp(join(tmpdir(), "wae-single-zip-"));
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Tiago Rocha.zip")}" ${singleZipDir}/`.quiet();

		await runIngest(
			defaultOptions({
				input: singleZipDir,
				split: "1mo",
			}),
		);

		// Check index was created
		const index = await loadIndex(outputDir);
		expect(index).not.toBeNull();
		expect(index!.version).toBe(1);
		expect(index!.contacts["Tiago Rocha"]).toBeDefined();
		expect(index!.contacts["Tiago Rocha"]!.type).toBe("individual");
		expect(Object.keys(index!.messages).length).toBeGreaterThan(0);

		// Check markdown files were created
		const outputFiles = await readdir(outputDir, { recursive: true });
		const mdFiles = outputFiles.filter((f) => f.toString().endsWith(".md"));
		expect(mdFiles.length).toBeGreaterThan(0);

		// Read one markdown file and verify format
		const firstMd = mdFiles[0]!;
		const mdContent = await Bun.file(
			join(outputDir, firstMd.toString()),
		).text();
		expect(mdContent).toContain("---");
		expect(mdContent).toContain("contact: Tiago Rocha");
		expect(mdContent).toContain("type: individual");
		expect(mdContent).toContain("# Tiago Rocha —");

		await rm(singleZipDir, { recursive: true, force: true });
	}, 30000);

	test("incremental run skips already-ingested messages", async () => {
		const singleZipDir = await mkdtemp(join(tmpdir(), "wae-incr-"));
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Tiago Rocha.zip")}" ${singleZipDir}/`.quiet();

		const opts = defaultOptions({ input: singleZipDir, split: "1mo" });

		// First run
		await runIngest(opts);
		const index1 = await loadIndex(outputDir);
		const msgCount1 = Object.keys(index1!.messages).length;

		// Second run — same data
		await runIngest(opts);
		const index2 = await loadIndex(outputDir);
		const msgCount2 = Object.keys(index2!.messages).length;

		// Same number of messages (all skipped)
		expect(msgCount2).toBe(msgCount1);

		await rm(singleZipDir, { recursive: true, force: true });
	}, 30000);

	test("by-contact layout creates contact directories", async () => {
		const singleZipDir = await mkdtemp(join(tmpdir(), "wae-layout-"));
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Tiago Rocha.zip")}" ${singleZipDir}/`.quiet();

		await runIngest(
			defaultOptions({
				input: singleZipDir,
				layout: "by-contact",
				split: "1mo",
			}),
		);

		const entries = await readdir(outputDir);
		// Should have a "Tiago Rocha" directory
		expect(entries.some((e) => e.toString() === "Tiago Rocha")).toBe(true);

		await rm(singleZipDir, { recursive: true, force: true });
	}, 30000);
});
