import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIngest } from "../orchestrator";
import { loadIndex } from "../store";
import type { IngestOptions } from "../types";
import { createFixturesDir } from "./fixtures";

let FIXTURES_DIR: string;
let outputDir: string;

function defaultOptions(overrides: Partial<IngestOptions> = {}): IngestOptions {
	return {
		input: FIXTURES_DIR,
		output: outputDir,
		split: "1mo",
		layout: "by-period",
		media: "none",
		mediaSince: null,
		mediaUntil: null,
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

beforeAll(async () => {
	FIXTURES_DIR = await createFixturesDir();
});

afterAll(async () => {
	await rm(FIXTURES_DIR, { recursive: true, force: true });
});

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
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Bruno Teixeira.zip")}" ${singleZipDir}/`.quiet();

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
		expect(index!.contacts["Bruno Teixeira"]).toBeDefined();
		expect(index!.contacts["Bruno Teixeira"]!.type).toBe("individual");
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
		expect(mdContent).toContain("contact: Bruno Teixeira");
		expect(mdContent).toContain("type: individual");
		expect(mdContent).toContain("# Bruno Teixeira —");

		await rm(singleZipDir, { recursive: true, force: true });
	}, 30000);

	test("links iOS <attached:> media and renders clean content", async () => {
		const singleZipDir = await mkdtemp(join(tmpdir(), "wae-ios-media-"));
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Equipe RenatoBruno.zip")}" ${singleZipDir}/`.quiet();

		await runIngest(defaultOptions({ input: singleZipDir, split: "1w" }));

		const index = await loadIndex(outputDir);
		const linked = Object.values(index!.messages).filter((m) => m.mediaFile);
		expect(linked.map((m) => m.mediaFile)).toEqual(["IMG-0001.jpg"]);
		expect(linked[0]!.subtype).toBe("image");

		const period = linked[0]!.period;
		const md = await Bun.file(
			join(outputDir, period, "Equipe RenatoBruno.md"),
		).text();
		expect(md).toContain("![[medias/IMG-0001.jpg]]");
		expect(md).not.toContain("<attached:");
		// The raw "[date] Sender:" prefix of bidi-prefixed lines must not leak
		expect(md).not.toContain("[09/02/2026");
		expect(md).not.toContain("\u200e");
		expect(
			await Bun.file(
				join(outputDir, period, "medias", "IMG-0001.jpg"),
			).exists(),
		).toBe(true);
		// Linked into the week folder without duplicating the staged file
		const staged = await stat(
			join(outputDir, "_medias_staging", "IMG-0001.jpg"),
		);
		const linkedCopy = await stat(
			join(outputDir, period, "medias", "IMG-0001.jpg"),
		);
		expect(linkedCopy.ino).toBe(staged.ino);

		await rm(singleZipDir, { recursive: true, force: true });
	}, 30000);

	test("a newer export under the same zip name keeps every message's own text", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wae-reexport-"));
		const zip = join(dir, "WhatsApp Chat - Ana.zip");
		const exportZip = async (lines: string[]) => {
			const stage = await mkdtemp(join(tmpdir(), "wae-reexport-stage-"));
			await Bun.write(join(stage, "_chat.txt"), `${lines.join("\r\n")}\r\n`);
			await rm(zip, { force: true });
			await Bun.$`zip -q -j ${zip} ${join(stage, "_chat.txt")}`.quiet();
			await rm(stage, { recursive: true, force: true });
		};
		const opts = defaultOptions({
			input: dir,
			split: "1w",
			dateFormat: "DD/MM",
		});

		await exportZip([
			"[01/09/26, 09:00:00] Ana: primeira",
			"[01/09/26, 09:05:00] Oscar Neto: segunda",
		]);
		await runIngest(opts);
		// Re-exported later: an older message the first export lacked, and a new one
		await exportZip([
			"[31/08/26, 18:00:00] Ana: antiga",
			"[01/09/26, 09:00:00] Ana: primeira",
			"[01/09/26, 09:05:00] Oscar Neto: segunda",
			"[02/09/26, 10:00:00] Ana: nova",
		]);
		await runIngest(opts);

		const index = await loadIndex(outputDir);
		expect(Object.keys(index!.messages).length).toBe(4);
		const md = await Bun.file(
			join(outputDir, "2026.08.31-2026.09.06", "WhatsApp Chat - Ana.md"),
		).text();
		expect(md.split("\n").filter((l) => l.startsWith("`"))).toEqual([
			"`18:00` **Ana:** antiga",
			"`09:00` **Ana:** primeira",
			"`09:05` **Eu:** segunda",
			"`10:00` **Ana:** nova",
		]);
		await rm(dir, { recursive: true, force: true });
	}, 30000);

	test("incremental run skips already-ingested messages", async () => {
		const singleZipDir = await mkdtemp(join(tmpdir(), "wae-incr-"));
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Bruno Teixeira.zip")}" ${singleZipDir}/`.quiet();

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
		await Bun.$`cp "${join(FIXTURES_DIR, "WhatsApp Chat with Bruno Teixeira.zip")}" ${singleZipDir}/`.quiet();

		await runIngest(
			defaultOptions({
				input: singleZipDir,
				layout: "by-contact",
				split: "1mo",
			}),
		);

		const entries = await readdir(outputDir);
		// Should have a "Bruno Teixeira" directory
		expect(entries.some((e) => e.toString() === "Bruno Teixeira")).toBe(true);

		await rm(singleZipDir, { recursive: true, force: true });
	}, 30000);
});
