// =============================================================================
// Period Splitter
// Calendar-boundary splitting for message grouping
// =============================================================================

import type { SplitInterval } from "./types";

// ===== Public API =====

/**
 * Assign a timestamp to its period label (YYYY.MM.DD-YYYY.MM.DD).
 * The timestamp is naive local time; timezone is used for calendar boundary computation.
 */
export function assignPeriod(
	timestamp: string,
	interval: SplitInterval,
	_timezone: string,
): string {
	// Parse the naive timestamp directly (no timezone conversion needed since
	// WhatsApp timestamps are already in local time)
	const date = parseNaiveTimestamp(timestamp);
	const { start, end } = getPeriodForDate(date, interval);
	return formatPeriodLabel(start, end);
}

/**
 * Compute all period boundaries spanning a date range.
 */
export function computePeriodBoundaries(
	start: Date,
	end: Date,
	interval: SplitInterval,
	_timezone: string,
): Array<{ label: string; start: Date; end: Date }> {
	const periods: Array<{ label: string; start: Date; end: Date }> = [];
	const seen = new Set<string>();

	// Get the first period
	let current = getPeriodForDate(start, interval);
	const endTime = end.getTime();

	while (current.start.getTime() <= endTime) {
		const label = formatPeriodLabel(current.start, current.end);
		if (!seen.has(label)) {
			seen.add(label);
			periods.push({ label, start: current.start, end: current.end });
		}

		// Advance to next period
		const nextDay = new Date(current.end);
		nextDay.setDate(nextDay.getDate() + 1);
		current = getPeriodForDate(nextDay, interval);

		// Safety: avoid infinite loop
		if (periods.length > 10000) break;
	}

	return periods;
}

// ===== Internal Functions =====

function parseNaiveTimestamp(timestamp: string): Date {
	// Parse "2026-03-01T14:30:00" as local time
	const [datePart, timePart] = timestamp.split("T") as [string, string];
	const [year, month, day] = datePart.split("-").map(Number) as [
		number,
		number,
		number,
	];
	const [hours, minutes, seconds] = timePart.split(":").map(Number) as [
		number,
		number,
		number,
	];
	return new Date(year, month - 1, day, hours, minutes, seconds);
}

interface PeriodBounds {
	start: Date;
	end: Date;
}

function getPeriodForDate(date: Date, interval: SplitInterval): PeriodBounds {
	switch (interval) {
		case "1w":
			return getWeekBounds(date);
		case "2w":
			return getBiWeekBounds(date);
		case "1mo":
			return getMonthBounds(date);
		case "3mo":
			return getQuarterBounds(date);
		case "1y":
			return getYearBounds(date);
	}
}

function getWeekBounds(date: Date): PeriodBounds {
	// ISO week: Monday = 1, Sunday = 7
	const day = date.getDay();
	const diffToMonday = day === 0 ? -6 : 1 - day;

	const monday = new Date(date);
	monday.setDate(date.getDate() + diffToMonday);
	monday.setHours(0, 0, 0, 0);

	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	sunday.setHours(23, 59, 59, 999);

	return { start: monday, end: sunday };
}

function getBiWeekBounds(date: Date): PeriodBounds {
	// Get the ISO week number
	const weekBounds = getWeekBounds(date);
	const jan1 = new Date(weekBounds.start.getFullYear(), 0, 1);
	const daysDiff = Math.floor(
		(weekBounds.start.getTime() - jan1.getTime()) / 86400000,
	);
	const jan1Day = jan1.getDay();
	const isoWeekNum = Math.ceil(
		(daysDiff + (jan1Day === 0 ? -6 : 2 - jan1Day)) / 7,
	);

	// Pair weeks: W1-W2, W3-W4, W5-W6, etc.
	// Odd weeks start a new pair
	const isFirstOfPair = isoWeekNum % 2 === 0;

	if (isFirstOfPair) {
		// This is the second week of the pair; go back one week for the start
		const pairStart = new Date(weekBounds.start);
		pairStart.setDate(pairStart.getDate() - 7);

		const pairEnd = new Date(weekBounds.end);
		return { start: pairStart, end: pairEnd };
	}

	// This is the first week of the pair; extend one week forward for the end
	const pairEnd = new Date(weekBounds.end);
	pairEnd.setDate(pairEnd.getDate() + 7);

	return { start: weekBounds.start, end: pairEnd };
}

function getMonthBounds(date: Date): PeriodBounds {
	const year = date.getFullYear();
	const month = date.getMonth();

	const start = new Date(year, month, 1, 0, 0, 0, 0);
	// Last day of month: day 0 of next month
	const lastDay = new Date(year, month + 1, 0).getDate();
	const end = new Date(year, month, lastDay, 23, 59, 59, 999);

	return { start, end };
}

function getQuarterBounds(date: Date): PeriodBounds {
	const year = date.getFullYear();
	const quarter = Math.floor(date.getMonth() / 3);
	const startMonth = quarter * 3;
	const endMonth = startMonth + 2;

	const start = new Date(year, startMonth, 1, 0, 0, 0, 0);
	const lastDay = new Date(year, endMonth + 1, 0).getDate();
	const end = new Date(year, endMonth, lastDay, 23, 59, 59, 999);

	return { start, end };
}

function getYearBounds(date: Date): PeriodBounds {
	const year = date.getFullYear();
	const start = new Date(year, 0, 1, 0, 0, 0, 0);
	const end = new Date(year, 11, 31, 23, 59, 59, 999);
	return { start, end };
}

function formatPeriodLabel(start: Date, end: Date): string {
	return `${formatDate(start)}-${formatDate(end)}`;
}

function formatDate(date: Date): string {
	const y = date.getFullYear().toString().padStart(4, "0");
	const m = (date.getMonth() + 1).toString().padStart(2, "0");
	const d = date.getDate().toString().padStart(2, "0");
	return `${y}.${m}.${d}`;
}
