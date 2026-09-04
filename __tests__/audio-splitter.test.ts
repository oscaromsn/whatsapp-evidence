import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
	cleanupChunks,
	ensureFfmpegAvailable,
	getAudioDuration,
	splitAudio,
} from "../audio-splitter";

let fixtureDir: string;
let fixturePath: string;
const FIXTURE_DURATION_SEC = 10;

beforeAll(async () => {
	// Generate a synthetic 10-second mono mp3 at 8kHz — small (~10 KB), valid.
	fixtureDir = await mkdtemp(join(tmpdir(), "wae-splitter-fixture-"));
	fixturePath = join(fixtureDir, "sine.mp3");
	await $`ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=${FIXTURE_DURATION_SEC}:sample_rate=8000 -ac 1 -y ${fixturePath}`.quiet();
});

afterAll(async () => {
	await rm(fixtureDir, { recursive: true, force: true });
});

describe("ensureFfmpegAvailable", () => {
	test("succeeds when ffmpeg is on PATH", async () => {
		await expect(ensureFfmpegAvailable()).resolves.toBeUndefined();
	});
});

describe("getAudioDuration", () => {
	test("returns the fixture's duration in seconds", async () => {
		const duration = await getAudioDuration(fixturePath);
		expect(duration).toBeGreaterThan(FIXTURE_DURATION_SEC - 0.5);
		expect(duration).toBeLessThan(FIXTURE_DURATION_SEC + 0.5);
	});

	test("throws on a non-audio file", async () => {
		const bogusDir = await mkdtemp(join(tmpdir(), "wae-splitter-bogus-"));
		const bogusPath = join(bogusDir, "not-audio.mp3");
		await Bun.write(bogusPath, "not actually audio");
		try {
			await expect(getAudioDuration(bogusPath)).rejects.toThrow();
		} finally {
			await rm(bogusDir, { recursive: true, force: true });
		}
	});
});

describe("splitAudio", () => {
	test("splits a 10s file into 3 chunks of ~4s, ~4s, ~2s", async () => {
		const { tmpDir, chunks } = await splitAudio(fixturePath, 4);
		try {
			expect(chunks).toHaveLength(3);

			expect(chunks[0]?.startSeconds).toBe(0);
			expect(chunks[1]?.startSeconds).toBe(4);
			expect(chunks[2]?.startSeconds).toBe(8);

			expect(chunks[0]?.durationSeconds).toBe(4);
			expect(chunks[1]?.durationSeconds).toBe(4);
			expect(chunks[2]?.durationSeconds).toBeCloseTo(2, 0);

			// All chunk files exist and are non-empty.
			for (const c of chunks) {
				const info = await stat(c.path);
				expect(info.size).toBeGreaterThan(0);
			}

			// Sum of probed chunk durations is within 0.5s of the original.
			let totalProbed = 0;
			for (const c of chunks) {
				totalProbed += await getAudioDuration(c.path);
			}
			expect(totalProbed).toBeGreaterThan(FIXTURE_DURATION_SEC - 0.5);
			expect(totalProbed).toBeLessThan(FIXTURE_DURATION_SEC + 0.5);
		} finally {
			await cleanupChunks(tmpDir);
		}
	});

	test("returns a single chunk when chunk size exceeds duration", async () => {
		const { tmpDir, chunks } = await splitAudio(fixturePath, 60);
		try {
			expect(chunks).toHaveLength(1);
			expect(chunks[0]?.startSeconds).toBe(0);
			expect(chunks[0]?.durationSeconds).toBeCloseTo(FIXTURE_DURATION_SEC, 0);
		} finally {
			await cleanupChunks(tmpDir);
		}
	});

	test("rejects non-positive chunk sizes", async () => {
		await expect(splitAudio(fixturePath, 0)).rejects.toThrow(/must be > 0/);
		await expect(splitAudio(fixturePath, -5)).rejects.toThrow(/must be > 0/);
	});
});

describe("cleanupChunks", () => {
	test("removes the directory and its files", async () => {
		const { tmpDir, chunks } = await splitAudio(fixturePath, 5);
		expect(chunks.length).toBeGreaterThan(0);
		const before = await readdir(tmpDir);
		expect(before.length).toBeGreaterThan(0);

		await cleanupChunks(tmpDir);

		await expect(stat(tmpDir)).rejects.toThrow();
	});

	test("is idempotent on a missing directory", async () => {
		const ghost = join(tmpdir(), "wae-splitter-does-not-exist-12345");
		await expect(cleanupChunks(ghost)).resolves.toBeUndefined();
	});
});
