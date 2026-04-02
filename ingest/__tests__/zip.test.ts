import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, findZipFiles } from "../zip";

const FIXTURES_DIR = join(import.meta.dir, "../../zips");

let tempDir: string;
let cacheDir: string;
let mediasDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "wae-zip-test-"));
	cacheDir = join(tempDir, ".cache");
	mediasDir = join(tempDir, "medias");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("findZipFiles", () => {
	test("finds zip files in fixture directory", async () => {
		const files = await findZipFiles(FIXTURES_DIR);
		expect(files.length).toBeGreaterThanOrEqual(2);
		expect(files.every((f) => f.endsWith(".zip"))).toBe(true);
	});
});

describe("extractZip", () => {
	test("extracts individual chat (text only)", async () => {
		const zipPath = join(FIXTURES_DIR, "WhatsApp Chat with Tiago Rocha.zip");
		const result = await extractZip(zipPath, cacheDir, mediasDir);

		expect(result.contactName).toBe("Tiago Rocha");
		expect(result.encoding).toBe("utf-8");
		expect(result.zipFilename).toBe("WhatsApp Chat with Tiago Rocha.zip");

		// Chat log should be cached
		const cachedFile = Bun.file(result.chatLogPath);
		expect(await cachedFile.exists()).toBe(true);

		const text = await cachedFile.text();
		expect(text).toContain("Tiago Rocha");
		expect(text).toContain("end-to-end encrypted");

		// No media in this zip
		expect(result.mediaFiles.length).toBe(0);
	});

	test("extracts group chat with media", async () => {
		const zipPath = join(
			FIXTURES_DIR,
			"WhatsApp Chat with Equipe DaviTiago.zip",
		);
		const result = await extractZip(zipPath, cacheDir, mediasDir);

		expect(result.contactName).toBe("Equipe DaviTiago");
		expect(result.mediaFiles.length).toBeGreaterThan(0);

		// Verify at least one media file exists on disk
		const firstMedia = Bun.file(result.mediaFiles[0]!);
		expect(await firstMedia.exists()).toBe(true);
	}, 30000);

	test("chat log content is valid UTF-8", async () => {
		const zipPath = join(FIXTURES_DIR, "WhatsApp Chat with Tiago Rocha.zip");
		const result = await extractZip(zipPath, cacheDir, mediasDir);
		const text = await Bun.file(result.chatLogPath).text();

		// Should not have BOM
		expect(text.charCodeAt(0)).not.toBe(0xfeff);

		// Should contain Portuguese characters
		expect(text).toContain("ã");
	});
});
