import { describe, expect, test } from "bun:test";
import { detectDateFormat, detectZipLanguage, parseChatLog } from "../parser";

// ===== Inline fixtures from real WhatsApp exports =====

const EN_ANDROID_INDIVIDUAL = `1/4/26, 00:09 - Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them. Learn more.
1/16/26, 10:09 - Tiago Rocha: Fala Oscar, bom dia. Tudo bem?
1/16/26, 14:11 - Oscar Neto: Opa, Tiago -  boa tarde! Tudo certo e por aí?
1/17/26, 13:19 - Tiago Rocha: Fala Oscar, me enrolei aqui ontem
1/17/26, 13:19 - Tiago Rocha: Tudo certo tbm
1/17/26, 13:19 - Tiago Rocha: Seguinte
1/17/26, 13:20 - Tiago Rocha: Deixa eu te perguntar, vai abrir uma vaga aqui no escritório e n sei se vc tá ainda no Toron
1/17/26, 13:20 - Tiago Rocha: Se tiver interesse ou conhecer alguém com até 5 anos de formado, me dá um toque
1/17/26, 17:32 - Oscar Neto: <Media omitted>
1/17/26, 17:32 - Oscar Neto: tá na mão`;

const EN_ANDROID_GROUP = `2/9/26, 15:57 - Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them. *Learn more*.
11/14/23, 14:19 - Tiago Rocha created group "Equipe Davi/Tiago"
2/9/26, 15:57 - Tiago Rocha added you
2/9/26, 15:57 - Tiago Rocha: Adicionando o @\u2068Oscar Neto\u2069 ao grupo
2/19/26, 10:16 - Davi L. Szuvarcfuter: <Media omitted>
PREVENT_Status e pendências_260202.xlsx
2/19/26, 10:16 - Oscar Neto: boa`;

const EN_ANDROID_FILE_ATTACHED = `3/4/26, 16:39 - Tiago Rocha: 1019767-17.2024.8.26.0050.pdf (file attached)
1019767-17.2024.8.26.0050.pdf
3/4/26, 17:02 - Oscar Neto: Sueli (69-84) - Denúncia.pdf (file attached)
Sueli (69-84) - Denúncia.pdf`;

const EN_ANDROID_EDITED = `3/27/26, 09:58 - Tiago Rocha: Leite, Alaor – Infidelidade patrimonial. A gestão infiel do patrimônio alheio como crime, São Paulo, 2026 <This message was edited>`;

const PTBR_ANDROID_BRACKETED = `[01/03/2026, 14:30:45] João Silva: Bom dia, tudo bem?
[01/03/2026, 14:31:00] Maria Santos: Tudo sim, e você?
[01/03/2026, 14:32:00] João Silva: Segue o áudio sobre o contrato
[01/03/2026, 14:32:00] João Silva: PTT-20260301-WA0001.opus (arquivo anexado)
PTT-20260301-WA0001.opus`;

const IOS_NO_BRACKETS = `01/03/2026, 14:30:45 - João Silva: Bom dia, tudo bem?
01/03/2026, 14:31:00 - Maria Santos: Tudo sim, e você?`;

const MULTILINE_MESSAGE = `1/17/26, 14:59 - Oscar Neto: Tenho interesse sim e fico bem feliz com a lembrança.
Não estou mais no Toron.
Vamos conversar quando quiser.
1/17/26, 16:11 - Tiago Rocha: Pra trabalhar cmg`;

const DELETED_MESSAGES = `1/17/26, 14:30 - João Silva: Esta mensagem foi apagada
1/17/26, 14:31 - Maria Santos: Você apagou esta mensagem
1/17/26, 14:32 - João Silva: This message was deleted`;

const SYSTEM_MESSAGES_CALLS = `1/17/26, 14:30 - Chamada de voz perdida
1/17/26, 14:31 - Missed voice call
1/17/26, 14:32 - Chamada de vídeo, 3 min 42 s`;

const EMPTY_CONTENT = `2/12/26, 13:38 - Oscar Neto:
2/12/26, 13:39 - Tiago Rocha: Texto normal`;

const MEDIA_OMITTED_WITH_TEXT = `3/27/26, 10:51 - Oscar Neto: <Media omitted>
Crimes Federais - José Baltazar - 2017`;

const FILE_ATTACHED_WITH_TEXT = `3/26/26, 14:19 - Tiago Rocha: IMG-20260326-WA0025.jpg (file attached)
é só esse arquivo né?`;

// ===== Date format detection fixtures =====

const UNAMBIGUOUS_DDMM = `25/03/2026, 14:30 - João: Bom dia
13/04/2026, 10:00 - Maria: Olá`;

const UNAMBIGUOUS_MMDD = `3/25/26, 14:30 - John: Good morning
4/13/26, 10:00 - Mary: Hello`;

const AMBIGUOUS_DATES = `1/2/26, 14:30 - Oscar: Test
3/4/26, 10:00 - Tiago: Test`;

// ===== Tests =====

describe("detectZipLanguage", () => {
	test("detects English zip filename", () => {
		expect(detectZipLanguage("WhatsApp Chat with Tiago Rocha.zip")).toBe("en");
	});

	test("detects Portuguese zip filename", () => {
		expect(detectZipLanguage("Conversa do WhatsApp com João Silva.zip")).toBe(
			"pt-br",
		);
	});

	test("defaults to en for unknown format", () => {
		expect(detectZipLanguage("unknown.zip")).toBe("en");
	});
});

describe("detectDateFormat", () => {
	test("detects DD/MM when day > 12", () => {
		const lines = UNAMBIGUOUS_DDMM.split("\n");
		expect(detectDateFormat(lines, "pt-br")).toBe("DD/MM");
	});

	test("detects MM/DD when day > 12 in second position", () => {
		const lines = UNAMBIGUOUS_MMDD.split("\n");
		expect(detectDateFormat(lines, "en")).toBe("MM/DD");
	});

	test("falls back to language hint for ambiguous dates", () => {
		const lines = AMBIGUOUS_DATES.split("\n");
		expect(detectDateFormat(lines, "en")).toBe("MM/DD");
		expect(detectDateFormat(lines, "pt-br")).toBe("DD/MM");
	});
});

describe("parseChatLog", () => {
	describe("EN Android individual chat", () => {
		test("parses basic messages", () => {
			const result = parseChatLog(EN_ANDROID_INDIVIDUAL);
			expect(result.messages.length).toBe(10);
			expect(result.detectedFormat).toBe("MM/DD");
		});

		test("identifies system message (encryption banner)", () => {
			const result = parseChatLog(EN_ANDROID_INDIVIDUAL);
			const first = result.messages[0]!;
			expect(first.type).toBe("system");
			expect(first.subtype).toBe("encryption");
			expect(first.sender).toBe("");
			expect(first.content).toContain("end-to-end encrypted");
		});

		test("parses sender and content correctly", () => {
			const result = parseChatLog(EN_ANDROID_INDIVIDUAL);
			const msg = result.messages[1]!;
			expect(msg.sender).toBe("Tiago Rocha");
			expect(msg.content).toBe("Fala Oscar, bom dia. Tudo bem?");
			expect(msg.type).toBe("text");
			expect(msg.timestamp).toBe("2026-01-16T10:09:00");
		});

		test("parses media omitted", () => {
			const result = parseChatLog(EN_ANDROID_INDIVIDUAL);
			const media = result.messages[8]!;
			expect(media.sender).toBe("Oscar Neto");
			expect(media.isMediaOmitted).toBe(true);
			expect(media.type).toBe("media");
		});

		test("assigns line ranges", () => {
			const result = parseChatLog(EN_ANDROID_INDIVIDUAL);
			expect(result.messages[0]!.lineRange).toEqual([1, 1]);
			expect(result.messages[1]!.lineRange).toEqual([2, 2]);
		});
	});

	describe("EN Android group chat", () => {
		test("parses group creation system message", () => {
			const result = parseChatLog(EN_ANDROID_GROUP);
			const creation = result.messages[1]!;
			expect(creation.type).toBe("system");
			expect(creation.subtype).toBe("admin");
			expect(creation.sender).toBe("");
			expect(creation.content).toContain("created group");
		});

		test("parses member addition system message", () => {
			const result = parseChatLog(EN_ANDROID_GROUP);
			const added = result.messages[2]!;
			expect(added.type).toBe("system");
			expect(added.subtype).toBe("membership");
			expect(added.content).toContain("added you");
		});

		test("parses mentions with Unicode directional chars", () => {
			const result = parseChatLog(EN_ANDROID_GROUP);
			const msg = result.messages[3]!;
			expect(msg.sender).toBe("Tiago Rocha");
			expect(msg.content).toContain("@");
			expect(msg.content).toContain("Oscar Neto");
		});

		test("handles media omitted with continuation text", () => {
			const result = parseChatLog(EN_ANDROID_GROUP);
			const media = result.messages[4]!;
			expect(media.isMediaOmitted).toBe(true);
			expect(media.content).toContain("PREVENT_Status");
		});
	});

	describe("file attachments", () => {
		test("parses (file attached) with filename", () => {
			const result = parseChatLog(EN_ANDROID_FILE_ATTACHED);
			const msg = result.messages[0]!;
			expect(msg.type).toBe("media");
			expect(msg.mediaFile).toBe("1019767-17.2024.8.26.0050.pdf");
			expect(msg.subtype).toBe("document");
		});

		test("handles filenames with parentheses", () => {
			const result = parseChatLog(EN_ANDROID_FILE_ATTACHED);
			const msg = result.messages[1]!;
			expect(msg.mediaFile).toBe("Sueli (69-84) - Denúncia.pdf");
			expect(msg.subtype).toBe("document");
		});

		test("consumes filename echo on continuation line", () => {
			const result = parseChatLog(EN_ANDROID_FILE_ATTACHED);
			// The continuation line with just the filename should be consumed
			expect(result.messages.length).toBe(2);
		});

		test("file attached with additional text preserves text", () => {
			const result = parseChatLog(FILE_ATTACHED_WITH_TEXT);
			const msg = result.messages[0]!;
			expect(msg.mediaFile).toBe("IMG-20260326-WA0025.jpg");
			expect(msg.content).toContain("é só esse arquivo né?");
			expect(msg.subtype).toBe("image");
		});
	});

	describe("edited messages", () => {
		test("strips <This message was edited> and sets flag", () => {
			const result = parseChatLog(EN_ANDROID_EDITED);
			const msg = result.messages[0]!;
			expect(msg.edited).toBe(true);
			expect(msg.content).not.toContain("<This message was edited>");
			expect(msg.content).toContain("Leite, Alaor");
		});
	});

	describe("PT-BR Android bracketed format", () => {
		test("parses bracketed timestamp format", () => {
			const result = parseChatLog(PTBR_ANDROID_BRACKETED, {
				dateFormat: "DD/MM",
			});
			// 4 messages: 2 text + 1 text + 1 arquivo anexado (filename echo is consumed)
			expect(result.messages.length).toBe(4);
			expect(result.messages[0]!.sender).toBe("João Silva");
			expect(result.messages[0]!.timestamp).toBe("2026-03-01T14:30:45");
		});

		test("parses (arquivo anexado) media", () => {
			const result = parseChatLog(PTBR_ANDROID_BRACKETED, {
				dateFormat: "DD/MM",
			});
			const media = result.messages[3]!;
			expect(media.type).toBe("media");
			expect(media.mediaFile).toBe("PTT-20260301-WA0001.opus");
			expect(media.subtype).toBe("audio");
		});
	});

	describe("iOS no-brackets format", () => {
		test("parses iOS format with full date and seconds", () => {
			const result = parseChatLog(IOS_NO_BRACKETS, { dateFormat: "DD/MM" });
			expect(result.messages.length).toBe(2);
			expect(result.messages[0]!.sender).toBe("João Silva");
			expect(result.messages[0]!.timestamp).toBe("2026-03-01T14:30:45");
		});
	});

	describe("multiline messages", () => {
		test("joins continuation lines preserving line breaks", () => {
			const result = parseChatLog(MULTILINE_MESSAGE);
			expect(result.messages.length).toBe(2);
			const msg = result.messages[0]!;
			expect(msg.sender).toBe("Oscar Neto");
			expect(msg.content).toContain("\n");
			expect(msg.content).toContain("Não estou mais no Toron.");
			expect(msg.content).toContain("Vamos conversar quando quiser.");
		});

		test("tracks correct line range for multiline messages", () => {
			const result = parseChatLog(MULTILINE_MESSAGE);
			expect(result.messages[0]!.lineRange).toEqual([1, 3]);
			expect(result.messages[1]!.lineRange).toEqual([4, 4]);
		});
	});

	describe("deleted messages", () => {
		test("detects PT-BR deleted message", () => {
			const result = parseChatLog(DELETED_MESSAGES);
			expect(result.messages[0]!.type).toBe("deleted");
			expect(result.messages[0]!.sender).toBe("João Silva");
		});

		test("detects self-deleted message", () => {
			const result = parseChatLog(DELETED_MESSAGES);
			expect(result.messages[1]!.type).toBe("deleted");
		});

		test("detects EN deleted message", () => {
			const result = parseChatLog(DELETED_MESSAGES);
			expect(result.messages[2]!.type).toBe("deleted");
		});
	});

	describe("system messages - calls", () => {
		test("detects call system messages", () => {
			const result = parseChatLog(SYSTEM_MESSAGES_CALLS);
			for (const msg of result.messages) {
				expect(msg.type).toBe("system");
				expect(msg.subtype).toBe("call");
			}
		});
	});

	describe("empty content", () => {
		test("handles messages with empty content", () => {
			const result = parseChatLog(EMPTY_CONTENT);
			expect(result.messages.length).toBe(2);
			expect(result.messages[0]!.content).toBe("");
			expect(result.messages[0]!.sender).toBe("Oscar Neto");
		});
	});

	describe("media omitted with continuation text", () => {
		test("preserves text after <Media omitted>", () => {
			const result = parseChatLog(MEDIA_OMITTED_WITH_TEXT);
			const msg = result.messages[0]!;
			expect(msg.isMediaOmitted).toBe(true);
			expect(msg.content).toContain("Crimes Federais");
		});
	});

	describe("media subtype detection", () => {
		test("classifies audio files", () => {
			const chat = `1/1/26, 10:00 - User: PTT-20260101-WA0001.opus (file attached)
PTT-20260101-WA0001.opus`;
			const result = parseChatLog(chat);
			expect(result.messages[0]!.subtype).toBe("audio");
		});

		test("classifies image files", () => {
			const chat = `1/1/26, 10:00 - User: IMG-20260101-WA0001.jpg (file attached)
IMG-20260101-WA0001.jpg`;
			const result = parseChatLog(chat);
			expect(result.messages[0]!.subtype).toBe("image");
		});

		test("classifies video files", () => {
			const chat = `1/1/26, 10:00 - User: VID-20260101-WA0001.mp4 (file attached)
VID-20260101-WA0001.mp4`;
			const result = parseChatLog(chat);
			expect(result.messages[0]!.subtype).toBe("video");
		});

		test("classifies sticker files", () => {
			const chat = `1/1/26, 10:00 - User: STK-20260101-WA0001.webp (file attached)
STK-20260101-WA0001.webp`;
			const result = parseChatLog(chat);
			expect(result.messages[0]!.subtype).toBe("sticker");
		});

		test("classifies contact files", () => {
			const chat = `1/1/26, 10:00 - User: Amanda.vcf (file attached)
Amanda.vcf`;
			const result = parseChatLog(chat);
			expect(result.messages[0]!.subtype).toBe("contact");
		});

		test("classifies document files (pdf, docx)", () => {
			const chat = `1/1/26, 10:00 - User: report.pdf (file attached)
report.pdf`;
			const result = parseChatLog(chat);
			expect(result.messages[0]!.subtype).toBe("document");
		});
	});

	describe("warnings", () => {
		test("reports unparseable lines", () => {
			const chat = `1/1/26, 10:00 - User: Hello
This is clearly not a valid start line but is a continuation
1/1/26, 10:01 - User: World`;
			const result = parseChatLog(chat);
			// The middle line is a continuation, not a warning
			expect(result.messages.length).toBe(2);
			expect(result.messages[0]!.content).toContain("not a valid start line");
		});
	});

	describe("date parsing", () => {
		test("handles 2-digit year (EN: M/D/YY)", () => {
			const result = parseChatLog("1/4/26, 00:09 - User: Test");
			expect(result.messages[0]!.timestamp).toBe("2026-01-04T00:09:00");
		});

		test("handles 4-digit year (PT-BR: DD/MM/YYYY)", () => {
			const result = parseChatLog("[01/03/2026, 14:30:45] User: Test", {
				dateFormat: "DD/MM",
			});
			expect(result.messages[0]!.timestamp).toBe("2026-03-01T14:30:45");
		});

		test("handles AM/PM time format", () => {
			const result = parseChatLog("3/1/26, 2:30 PM - User: Test");
			expect(result.messages[0]!.timestamp).toBe("2026-03-01T14:30:00");
		});

		test("handles 12:xx AM correctly", () => {
			const result = parseChatLog("3/1/26, 12:30 AM - User: Test");
			expect(result.messages[0]!.timestamp).toBe("2026-03-01T00:30:00");
		});

		test("handles 12:xx PM correctly", () => {
			const result = parseChatLog("3/1/26, 12:30 PM - User: Test");
			expect(result.messages[0]!.timestamp).toBe("2026-03-01T12:30:00");
		});
	});
});
