import { describe, expect, test } from "bun:test";
import { parseIngestArgs } from "../cli";

describe("parseIngestArgs", () => {
	test("returns defaults with no args", () => {
		const opts = parseIngestArgs([]);
		expect(opts.input).toBe("./to-ingest/");
		expect(opts.output).toBe("./evidence/");
		expect(opts.split).toBe("1w");
		expect(opts.layout).toBe("by-period");
		expect(opts.media).toBe("none");
		expect(opts.disclaimer).toBe(false);
		expect(opts.force).toBe(false);
		expect(opts.self).toBeNull();
		expect(opts.timezone).toBe("America/Sao_Paulo");
		expect(opts.dateFormat).toBeNull();
		expect(opts.aliases.size).toBe(0);
		expect(opts.concurrency).toBe(3);
		expect(opts.regenerate).toBe(false);
		expect(opts.contact).toBeNull();
		expect(opts.dryRun).toBe(false);
		expect(opts.quiet).toBe(false);
		expect(opts.verbose).toBe(false);
	});

	test("parses --input", () => {
		const opts = parseIngestArgs(["--input", "./zips/"]);
		expect(opts.input).toBe("./zips/");
	});

	test("parses --output", () => {
		const opts = parseIngestArgs(["--output", "./out/"]);
		expect(opts.output).toBe("./out/");
	});

	test("parses --split with valid values", () => {
		expect(parseIngestArgs(["--split", "1w"]).split).toBe("1w");
		expect(parseIngestArgs(["--split", "2w"]).split).toBe("2w");
		expect(parseIngestArgs(["--split", "1mo"]).split).toBe("1mo");
		expect(parseIngestArgs(["--split", "3mo"]).split).toBe("3mo");
		expect(parseIngestArgs(["--split", "1y"]).split).toBe("1y");
	});

	test("throws on invalid --split", () => {
		expect(() => parseIngestArgs(["--split", "invalid"])).toThrow();
	});

	test("parses --layout", () => {
		expect(parseIngestArgs(["--layout", "by-period"]).layout).toBe("by-period");
		expect(parseIngestArgs(["--layout", "by-contact"]).layout).toBe(
			"by-contact",
		);
	});

	test("throws on invalid --layout", () => {
		expect(() => parseIngestArgs(["--layout", "invalid"])).toThrow();
	});

	test("parses --media", () => {
		expect(parseIngestArgs(["--media", "none"]).media).toBe("none");
		expect(parseIngestArgs(["--media", "audio"]).media).toBe("audio");
		expect(parseIngestArgs(["--media", "images"]).media).toBe("images");
		expect(parseIngestArgs(["--media", "all"]).media).toBe("all");
	});

	test("parses boolean flags", () => {
		const opts = parseIngestArgs([
			"--disclaimer",
			"--force",
			"--regenerate",
			"--dry-run",
			"--quiet",
		]);
		expect(opts.disclaimer).toBe(true);
		expect(opts.force).toBe(true);
		expect(opts.regenerate).toBe(true);
		expect(opts.dryRun).toBe(true);
		expect(opts.quiet).toBe(true);
	});

	test("parses --verbose", () => {
		expect(parseIngestArgs(["--verbose"]).verbose).toBe(true);
	});

	test("parses --self", () => {
		const opts = parseIngestArgs(["--self", "Maria Santos"]);
		expect(opts.self).toBe("Maria Santos");
	});

	test("parses --timezone", () => {
		const opts = parseIngestArgs(["--timezone", "America/Manaus"]);
		expect(opts.timezone).toBe("America/Manaus");
	});

	test("parses --date-format", () => {
		expect(parseIngestArgs(["--date-format", "DD/MM"]).dateFormat).toBe(
			"DD/MM",
		);
		expect(parseIngestArgs(["--date-format", "MM/DD"]).dateFormat).toBe(
			"MM/DD",
		);
	});

	test("parses --concurrency", () => {
		const opts = parseIngestArgs(["--concurrency", "5"]);
		expect(opts.concurrency).toBe(5);
	});

	test("parses --contact for scoped regeneration", () => {
		const opts = parseIngestArgs(["--contact", "João Silva"]);
		expect(opts.contact).toBe("João Silva");
	});

	test("parses single --alias", () => {
		const opts = parseIngestArgs(["--alias", "+55 11 99999-0000=João Silva"]);
		expect(opts.aliases.get("+55 11 99999-0000")).toBe("João Silva");
	});

	test("parses multiple --alias flags", () => {
		const opts = parseIngestArgs([
			"--alias",
			"+55 11 99999-0000=João Silva",
			"--alias",
			"Joãozinho=João Silva",
		]);
		expect(opts.aliases.size).toBe(2);
		expect(opts.aliases.get("+55 11 99999-0000")).toBe("João Silva");
		expect(opts.aliases.get("Joãozinho")).toBe("João Silva");
	});

	test("combines multiple flags", () => {
		const opts = parseIngestArgs([
			"--input",
			"./zips/",
			"--output",
			"./evidence/",
			"--split",
			"1mo",
			"--media",
			"audio",
			"--disclaimer",
			"--self",
			"Oscar Neto",
		]);
		expect(opts.input).toBe("./zips/");
		expect(opts.output).toBe("./evidence/");
		expect(opts.split).toBe("1mo");
		expect(opts.media).toBe("audio");
		expect(opts.disclaimer).toBe(true);
		expect(opts.self).toBe("Oscar Neto");
	});
});
