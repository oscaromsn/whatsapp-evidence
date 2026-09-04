import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "../transcribe-audio";

describe("mapWithConcurrency", () => {
	test("preserves input order regardless of completion order", async () => {
		// Items finish in reverse order — last completes first.
		const items = [30, 20, 10];
		const results = await mapWithConcurrency(items, 3, async (n) => {
			await Bun.sleep(n);
			return n * 2;
		});
		expect(results).toEqual([60, 40, 20]);
	});

	test("respects the concurrency limit (max in-flight)", async () => {
		const items = Array.from({ length: 8 }, (_, i) => i);
		let inFlight = 0;
		let peak = 0;

		await mapWithConcurrency(items, 3, async (i) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(20);
			inFlight--;
			return i;
		});

		expect(peak).toBe(3);
	});

	test("with concurrency 1 behaves sequentially (peak = 1)", async () => {
		const items = [1, 2, 3, 4];
		let inFlight = 0;
		let peak = 0;

		const results = await mapWithConcurrency(items, 1, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(5);
			inFlight--;
			return n;
		});

		expect(peak).toBe(1);
		expect(results).toEqual([1, 2, 3, 4]);
	});

	test("clamps worker count to items.length when concurrency exceeds it", async () => {
		const items = [1, 2];
		let inFlight = 0;
		let peak = 0;

		await mapWithConcurrency(items, 100, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(5);
			inFlight--;
			return n;
		});

		expect(peak).toBe(2);
	});

	test("rejects when any worker throws", async () => {
		const items = [1, 2, 3];
		await expect(
			mapWithConcurrency(items, 2, async (n) => {
				if (n === 2) throw new Error("boom");
				await Bun.sleep(5);
				return n;
			}),
		).rejects.toThrow("boom");
	});

	test("handles empty input", async () => {
		const results = await mapWithConcurrency<number, number>(
			[],
			3,
			async (n) => n,
		);
		expect(results).toEqual([]);
	});

	test("passes the correct index to the worker", async () => {
		const seen: Array<[string, number]> = [];
		await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => {
			seen.push([item, i]);
			return item;
		});
		// Order may vary but every (item,index) pair must be present and consistent.
		seen.sort();
		expect(seen).toEqual([
			["a", 0],
			["b", 1],
			["c", 2],
		]);
	});
});
