import { describe, expect, test } from "bun:test";
import { renderPeriodMarkdown } from "../renderer";
import type { ContactEntry, RenderedMessage, RenderOptions } from "../types";

function makeMsg(overrides: Partial<RenderedMessage> = {}): RenderedMessage {
	return {
		timestamp: "2026-02-24T14:30:00",
		sender: "João Silva",
		content: "Bom dia, tudo bem?",
		type: "text",
		subtype: null,
		mediaFile: null,
		isMediaOmitted: false,
		edited: false,
		replyTo: null,
		transcription: null,
		mediaExists: true,
		...overrides,
	};
}

const defaultContact: ContactEntry = {
	type: "individual",
	sourceZips: ["Conversa do WhatsApp com João Silva.zip"],
	messageCount: 47,
	sanitizedName: "João Silva",
	dateFormat: "DD/MM",
	encoding: "utf-8",
};

const defaultOptions: RenderOptions = {
	disclaimer: false,
	selfName: "Maria Santos",
	aliases: new Map(),
	isGroup: false,
};

describe("renderPeriodMarkdown", () => {
	test("renders YAML frontmatter", () => {
		const messages = [makeMsg()];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("---");
		expect(md).toContain("contact: João Silva");
		expect(md).toContain("type: individual");
		expect(md).toContain("period: 2026.02.24-2026.03.01");
		expect(md).toContain("messages: 1");
		expect(md).toContain("  - Conversa do WhatsApp com João Silva.zip");
	});

	test("renders H1 header with date range", () => {
		const messages = [makeMsg()];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("# João Silva — 24/02/2026 a 01/03/2026");
	});

	test("renders day headers with abbreviated weekday", () => {
		const messages = [
			makeMsg({ timestamp: "2026-02-24T14:30:00" }), // Tuesday
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("## 24/02 ter");
	});

	test("renders text messages with inline timestamp and bold sender", () => {
		const messages = [makeMsg()];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("`14:30` **João Silva:** Bom dia, tudo bem?");
	});

	test("replaces self-sender with Eu in individual chats", () => {
		const messages = [makeMsg({ sender: "Maria Santos", content: "Oi!" })];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("`14:30` **Eu:** Oi!");
	});

	test("uses actual name in group chats (not Eu)", () => {
		const groupContact = { ...defaultContact, type: "group" as const };
		const groupOptions = { ...defaultOptions, isGroup: true };
		const messages = [makeMsg({ sender: "Maria Santos", content: "Oi!" })];
		const md = renderPeriodMarkdown(
			messages,
			groupContact,
			"2026.02.24-2026.03.01",
			groupOptions,
		);

		expect(md).toContain("`14:30` **Maria Santos:** Oi!");
		expect(md).not.toContain("**Eu:**");
	});

	test("renders system messages in italic without sender", () => {
		const messages = [
			makeMsg({
				type: "system",
				sender: "",
				content:
					"As mensagens e as ligações são protegidas com a criptografia de ponta a ponta",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain(
			"`14:30` _As mensagens e as ligações são protegidas com a criptografia de ponta a ponta_",
		);
	});

	test("renders deleted messages with italic content", () => {
		const messages = [
			makeMsg({
				type: "deleted",
				content: "Esta mensagem foi apagada",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("`14:30` **João Silva:** _Esta mensagem foi apagada_");
	});

	test("renders edited messages with trailing annotation", () => {
		const messages = [makeMsg({ content: "Texto da mensagem", edited: true })];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain(
			"`14:30` **João Silva:** Texto da mensagem _(editada)_",
		);
	});

	test("renders media with wikilink", () => {
		const messages = [
			makeMsg({
				type: "media",
				subtype: "audio",
				mediaFile: "PTT-20260224-WA0001.opus",
				content: "",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("![[medias/PTT-20260224-WA0001.opus]]");
	});

	test("renders media with transcription as blockquote", () => {
		const messages = [
			makeMsg({
				type: "media",
				subtype: "audio",
				mediaFile: "PTT-20260224-WA0001.opus",
				content: "",
				transcription:
					"Bom dia, estou ligando sobre o contrato que discutimos.",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("![[medias/PTT-20260224-WA0001.opus]]");
		expect(md).toContain(
			"> **[Transcrição]** Bom dia, estou ligando sobre o contrato que discutimos.",
		);
	});

	test("renders image with description blockquote", () => {
		const messages = [
			makeMsg({
				type: "media",
				subtype: "image",
				mediaFile: "IMG-20260224-WA0042.jpg",
				content: "",
				transcription: "Foto de um documento impresso.",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("![[medias/IMG-20260224-WA0042.jpg]]");
		expect(md).toContain("> **[Descrição]** Foto de um documento impresso.");
	});

	test("renders missing media with comment", () => {
		const messages = [
			makeMsg({
				type: "media",
				subtype: "image",
				mediaFile: "IMG-20260224-WA0042.jpg",
				content: "",
				mediaExists: false,
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain(
			"![[medias/IMG-20260224-WA0042.jpg]] <!-- media:missing -->",
		);
	});

	test("renders media omitted", () => {
		const messages = [
			makeMsg({
				type: "media",
				isMediaOmitted: true,
				content: "",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("`14:30` **João Silva:** <Mídia oculta>");
	});

	test("preserves multiline messages", () => {
		const messages = [
			makeMsg({
				content: "Primeira linha\nSegunda linha\nTerceira linha",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("Primeira linha\nSegunda linha\nTerceira linha");
	});

	test("groups messages by day with day headers", () => {
		const messages = [
			makeMsg({ timestamp: "2026-02-24T10:00:00" }),
			makeMsg({
				timestamp: "2026-02-24T11:00:00",
				content: "Segundo",
			}),
			makeMsg({
				timestamp: "2026-02-25T09:00:00",
				content: "Outro dia",
			}),
		];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).toContain("## 24/02 ter");
		expect(md).toContain("## 25/02 qua");
	});

	test("appends legal disclaimer when enabled", () => {
		const messages = [makeMsg()];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			{ ...defaultOptions, disclaimer: true },
		);

		expect(md).toContain("Aviso Legal");
		expect(md).toContain("OAB");
	});

	test("does not include disclaimer by default", () => {
		const messages = [makeMsg()];
		const md = renderPeriodMarkdown(
			messages,
			defaultContact,
			"2026.02.24-2026.03.01",
			defaultOptions,
		);

		expect(md).not.toContain("Aviso Legal");
	});
});
