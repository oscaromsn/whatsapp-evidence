import { describe, expect, test } from "bun:test";
import {
	applyAliases,
	detectSelf,
	parseContactFromZipName,
	sanitizeName,
} from "../contacts";

describe("parseContactFromZipName", () => {
	test("parses English zip name", () => {
		expect(parseContactFromZipName("WhatsApp Chat with Tiago Rocha.zip")).toBe(
			"Tiago Rocha",
		);
	});

	test("parses Portuguese zip name", () => {
		expect(
			parseContactFromZipName("Conversa do WhatsApp com João Silva.zip"),
		).toBe("João Silva");
	});

	test("parses group name with special chars", () => {
		expect(
			parseContactFromZipName("WhatsApp Chat with Equipe DaviTiago.zip"),
		).toBe("Equipe DaviTiago");
	});

	test("parses English name without .zip extension", () => {
		expect(parseContactFromZipName("WhatsApp Chat with Someone")).toBe(
			"Someone",
		);
	});

	test("falls back to filename without extension for unknown format", () => {
		expect(parseContactFromZipName("random-file.zip")).toBe("random-file");
	});

	test("handles accented characters", () => {
		expect(
			parseContactFromZipName("Conversa do WhatsApp com José Antônio.zip"),
		).toBe("José Antônio");
	});
});

describe("sanitizeName", () => {
	test("replaces forbidden characters", () => {
		expect(sanitizeName('test/file:name*?"<>|')).toBe("test_file_name");
	});

	test("trims leading/trailing dots and spaces", () => {
		expect(sanitizeName("...name...")).toBe("name");
		expect(sanitizeName("  name  ")).toBe("name");
	});

	test("collapses consecutive underscores", () => {
		expect(sanitizeName("a///b")).toBe("a_b");
	});

	test("keeps emoji", () => {
		expect(sanitizeName("Grupo 🔥")).toBe("Grupo 🔥");
	});

	test("truncates to 200 characters", () => {
		const longName = "a".repeat(250);
		expect(sanitizeName(longName).length).toBe(200);
	});

	test("preserves normal names", () => {
		expect(sanitizeName("João Silva")).toBe("João Silva");
		expect(sanitizeName("Equipe DaviTiago")).toBe("Equipe DaviTiago");
	});

	test("handles backslash", () => {
		expect(sanitizeName("Equipe Davi\\Tiago")).toBe("Equipe Davi_Tiago");
	});
});

describe("detectSelf", () => {
	test("finds sender present across all contacts", () => {
		const contacts = new Map<string, Set<string>>();
		contacts.set("Tiago Rocha", new Set(["Oscar Neto", "Tiago Rocha"]));
		contacts.set(
			"Equipe DaviTiago",
			new Set(["Oscar Neto", "Tiago Rocha", "Davi L. Szuvarcfuter"]),
		);
		contacts.set(
			"Manoela Siccherino",
			new Set(["Oscar Neto", "Manoela Siccherino"]),
		);

		expect(detectSelf(contacts)).toBe("Oscar Neto");
	});

	test("returns null when ambiguous (multiple common senders)", () => {
		const contacts = new Map<string, Set<string>>();
		contacts.set("Chat1", new Set(["Alice", "Bob"]));
		contacts.set("Chat2", new Set(["Alice", "Bob"]));

		// Both Alice and Bob appear in all chats
		expect(detectSelf(contacts)).toBeNull();
	});

	test("returns null for single contact", () => {
		const contacts = new Map<string, Set<string>>();
		contacts.set("Tiago Rocha", new Set(["Oscar Neto", "Tiago Rocha"]));

		// With only one chat, both senders appear "everywhere"
		expect(detectSelf(contacts)).toBeNull();
	});

	test("handles empty input", () => {
		expect(detectSelf(new Map())).toBeNull();
	});
});

describe("applyAliases", () => {
	test("replaces aliased sender name", () => {
		const aliases = new Map([
			["+55 11 99999-0000", "João Silva"],
			["Joãozinho", "João Silva"],
		]);
		expect(applyAliases("+55 11 99999-0000", aliases)).toBe("João Silva");
		expect(applyAliases("Joãozinho", aliases)).toBe("João Silva");
	});

	test("returns original if no alias matches", () => {
		const aliases = new Map([["+55 11 99999-0000", "João Silva"]]);
		expect(applyAliases("Maria Santos", aliases)).toBe("Maria Santos");
	});

	test("handles empty alias map", () => {
		expect(applyAliases("Oscar Neto", new Map())).toBe("Oscar Neto");
	});
});
