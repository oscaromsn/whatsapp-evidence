import { describe, expect, test } from "bun:test";
import { assignPeriod, computePeriodBoundaries } from "../splitter";

const TZ = "America/Sao_Paulo";

describe("assignPeriod", () => {
	describe("1w (ISO weeks, Mon-Sun)", () => {
		test("assigns Monday to its own week", () => {
			// 2026-02-23 is a Monday
			const period = assignPeriod("2026-02-23T10:00:00", "1w", TZ);
			expect(period).toBe("2026.02.23-2026.03.01");
		});

		test("assigns Sunday to the same week as its Monday", () => {
			// 2026-03-01 is a Sunday
			const period = assignPeriod("2026-03-01T23:59:59", "1w", TZ);
			expect(period).toBe("2026.02.23-2026.03.01");
		});

		test("assigns next Monday to the next week", () => {
			// 2026-03-02 is a Monday
			const period = assignPeriod("2026-03-02T00:00:00", "1w", TZ);
			expect(period).toBe("2026.03.02-2026.03.08");
		});

		test("handles mid-week correctly", () => {
			// 2026-02-25 is a Wednesday
			const period = assignPeriod("2026-02-25T14:30:00", "1w", TZ);
			expect(period).toBe("2026.02.23-2026.03.01");
		});
	});

	describe("2w (bi-weekly, consecutive ISO week pairs)", () => {
		test("assigns to bi-weekly period", () => {
			// 2026-01-05 is a Monday, ISO week 2
			const period = assignPeriod("2026-01-05T10:00:00", "2w", TZ);
			expect(period).toBe("2026.01.05-2026.01.18");
		});

		test("second week of pair stays in same period", () => {
			// 2026-01-12 is ISO week 3, still in pair W2-W3
			const period = assignPeriod("2026-01-12T10:00:00", "2w", TZ);
			expect(period).toBe("2026.01.05-2026.01.18");
		});

		test("third week starts new period", () => {
			// 2026-01-19 is ISO week 4, starts new pair W4-W5
			const period = assignPeriod("2026-01-19T10:00:00", "2w", TZ);
			expect(period).toBe("2026.01.19-2026.02.01");
		});
	});

	describe("1mo (calendar months)", () => {
		test("assigns to calendar month", () => {
			const period = assignPeriod("2026-03-15T10:00:00", "1mo", TZ);
			expect(period).toBe("2026.03.01-2026.03.31");
		});

		test("first day of month", () => {
			const period = assignPeriod("2026-01-01T00:00:00", "1mo", TZ);
			expect(period).toBe("2026.01.01-2026.01.31");
		});

		test("last day of month", () => {
			const period = assignPeriod("2026-02-28T23:59:00", "1mo", TZ);
			expect(period).toBe("2026.02.01-2026.02.28");
		});

		test("handles leap year February", () => {
			// 2028 is a leap year
			const period = assignPeriod("2028-02-29T10:00:00", "1mo", TZ);
			expect(period).toBe("2028.02.01-2028.02.29");
		});
	});

	describe("3mo (calendar quarters)", () => {
		test("Q1: Jan-Mar", () => {
			const period = assignPeriod("2026-02-15T10:00:00", "3mo", TZ);
			expect(period).toBe("2026.01.01-2026.03.31");
		});

		test("Q2: Apr-Jun", () => {
			const period = assignPeriod("2026-05-01T10:00:00", "3mo", TZ);
			expect(period).toBe("2026.04.01-2026.06.30");
		});

		test("Q3: Jul-Sep", () => {
			const period = assignPeriod("2026-08-20T10:00:00", "3mo", TZ);
			expect(period).toBe("2026.07.01-2026.09.30");
		});

		test("Q4: Oct-Dec", () => {
			const period = assignPeriod("2026-12-31T23:59:00", "3mo", TZ);
			expect(period).toBe("2026.10.01-2026.12.31");
		});
	});

	describe("1y (calendar years)", () => {
		test("assigns to calendar year", () => {
			const period = assignPeriod("2026-06-15T10:00:00", "1y", TZ);
			expect(period).toBe("2026.01.01-2026.12.31");
		});

		test("first day of year", () => {
			const period = assignPeriod("2026-01-01T00:00:00", "1y", TZ);
			expect(period).toBe("2026.01.01-2026.12.31");
		});

		test("last day of year", () => {
			const period = assignPeriod("2026-12-31T23:59:00", "1y", TZ);
			expect(period).toBe("2026.01.01-2026.12.31");
		});
	});
});

describe("computePeriodBoundaries", () => {
	test("generates weekly boundaries spanning the date range", () => {
		const start = new Date("2026-02-23T10:00:00");
		const end = new Date("2026-03-10T10:00:00");
		const periods = computePeriodBoundaries(start, end, "1w", TZ);

		expect(periods.length).toBe(3);
		expect(periods[0]!.label).toBe("2026.02.23-2026.03.01");
		expect(periods[1]!.label).toBe("2026.03.02-2026.03.08");
		expect(periods[2]!.label).toBe("2026.03.09-2026.03.15");
	});

	test("generates monthly boundaries", () => {
		const start = new Date("2026-01-15T10:00:00");
		const end = new Date("2026-03-20T10:00:00");
		const periods = computePeriodBoundaries(start, end, "1mo", TZ);

		expect(periods.length).toBe(3);
		expect(periods[0]!.label).toBe("2026.01.01-2026.01.31");
		expect(periods[1]!.label).toBe("2026.02.01-2026.02.28");
		expect(periods[2]!.label).toBe("2026.03.01-2026.03.31");
	});

	test("generates quarterly boundaries", () => {
		const start = new Date("2026-02-01T10:00:00");
		const end = new Date("2026-08-01T10:00:00");
		const periods = computePeriodBoundaries(start, end, "3mo", TZ);

		expect(periods.length).toBe(3);
		expect(periods[0]!.label).toBe("2026.01.01-2026.03.31");
		expect(periods[1]!.label).toBe("2026.04.01-2026.06.30");
		expect(periods[2]!.label).toBe("2026.07.01-2026.09.30");
	});

	test("single message returns single period", () => {
		const date = new Date("2026-03-15T10:00:00");
		const periods = computePeriodBoundaries(date, date, "1mo", TZ);
		expect(periods.length).toBe(1);
		expect(periods[0]!.label).toBe("2026.03.01-2026.03.31");
	});
});
