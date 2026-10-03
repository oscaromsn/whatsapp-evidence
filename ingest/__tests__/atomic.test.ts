import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wae-atomic-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
	test("creates and replaces a file, leaving no temp files", async () => {
		const path = join(dir, "index.json");
		await writeFileAtomic(path, "v1");
		await writeFileAtomic(path, "v2");
		expect(await Bun.file(path).text()).toBe("v2");
		expect(await readdir(dir)).toEqual(["index.json"]);
	});

	test("a failed write leaves the target untouched and cleans up", async () => {
		// A non-empty directory at the target path makes the final rename fail
		const path = join(dir, "index.json");
		await mkdir(path);
		await writeFile(join(path, "keep"), "x");

		await expect(writeFileAtomic(path, "new")).rejects.toThrow();
		expect(await readdir(dir)).toEqual(["index.json"]);
		expect(await readdir(path)).toEqual(["keep"]);
	});
});
