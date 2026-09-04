import { describe, expect, test } from "bun:test";
import { detectDateFormat, detectZipLanguage, parseChatLog } from "../parser";

// ===== Inline fixtures =====
// Synthetic conversations that reproduce the quirks of real WhatsApp exports
// (bidi marks, continuation lines, same-minute bursts, media markers) without
// carrying anyone's actual chat content.

const EN_ANDROID_INDIVIDUAL = `1/4/26, 00:09 - Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them. Learn more.
1/16/26, 10:09 - Bruno Teixeira: Bom dia, tudo bem?
1/16/26, 14:11 - Oscar Neto: Opa, Bruno -  boa tarde! Tudo certo e por aí?
1/17/26, 13:19 - Bruno Teixeira: Bom dia, desculpa a demora de ontem
1/17/26, 13:19 - Bruno Teixeira: Tudo certo tbm
1/17/26, 13:19 - Bruno Teixeira: Seguinte
1/17/26, 13:20 - Bruno Teixeira: Deixa eu te perguntar, a reunião de quinta ficou de manhã ou à tarde?
1/17/26, 13:20 - Bruno Teixeira: Se puder confirmar na agenda depois, me dá um toque
1/17/26, 17:32 - Oscar Neto: <Media omitted>
1/17/26, 17:32 - Oscar Neto: tá na mão`;

const EN_ANDROID_GROUP = `2/9/26, 15:57 - Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them. *Learn more*.
11/14/23, 14:19 - Bruno Teixeira created group "Equipe Renato/Bruno"
2/9/26, 15:57 - Bruno Teixeira added you
2/9/26, 15:57 - Bruno Teixeira: Adicionando o @\u2068Oscar Neto\u2069 ao grupo
2/19/26, 10:16 - Renato L. Vasconcelos: <Media omitted>
Projeto_Status e pendências_260202.xlsx
2/19/26, 10:16 - Oscar Neto: boa`;

const EN_ANDROID_FILE_ATTACHED = `3/4/26, 16:39 - Bruno Teixeira: 0000000-00.2026.8.26.0000.pdf (file attached)
0000000-00.2026.8.26.0000.pdf
3/4/26, 17:02 - Oscar Neto: Helena (69-84) - Denúncia.pdf (file attached)
Helena (69-84) - Denúncia.pdf`;

const EN_ANDROID_EDITED = `3/27/26, 09:58 - Bruno Teixeira: Leite, Alaor – Infidelidade patrimonial. A gestão infiel do patrimônio alheio como crime, São Paulo, 2026 <This message was edited>`;

const PTBR_ANDROID_BRACKETED = `[01/03/2026, 14:30:45] João Silva: Bom dia, tudo bem?
[01/03/2026, 14:31:00] Maria Santos: Tudo sim, e você?
[01/03/2026, 14:32:00] João Silva: Segue o áudio sobre o contrato
[01/03/2026, 14:32:00] João Silva: PTT-20260301-WA0001.opus (arquivo anexado)
PTT-20260301-WA0001.opus`;

const IOS_NO_BRACKETS = `01/03/2026, 14:30:45 - João Silva: Bom dia, tudo bem?
01/03/2026, 14:31:00 - Maria Santos: Tudo sim, e você?`;

const MULTILINE_MESSAGE = `1/17/26, 14:59 - Oscar Neto: Consigo revisar sim, sem problema.
Vou olhar o documento hoje à noite.
Amanhã cedo te retorno.
1/17/26, 16:11 - Bruno Teixeira: Combinado`;

const DELETED_MESSAGES = `1/17/26, 14:30 - João Silva: Esta mensagem foi apagada
1/17/26, 14:31 - Maria Santos: Você apagou esta mensagem
1/17/26, 14:32 - João Silva: This message was deleted`;

const SYSTEM_MESSAGES_CALLS = `1/17/26, 14:30 - Chamada de voz perdida
1/17/26, 14:31 - Missed voice call
1/17/26, 14:32 - Chamada de vídeo, 3 min 42 s`;

const EMPTY_CONTENT = `2/12/26, 13:38 - Oscar Neto:
2/12/26, 13:39 - Bruno Teixeira: Texto normal`;

const MEDIA_OMITTED_WITH_TEXT = `3/27/26, 10:51 - Oscar Neto: <Media omitted>
Crimes Federais - José Baltazar - 2017`;

const FILE_ATTACHED_WITH_TEXT = `3/26/26, 14:19 - Bruno Teixeira: IMG-20260326-WA0025.jpg (file attached)
é só esse arquivo né?`;

// ===== Date format detection fixtures =====

const UNAMBIGUOUS_DDMM = `25/03/2026, 14:30 - João: Bom dia
13/04/2026, 10:00 - Maria: Olá`;

const UNAMBIGUOUS_MMDD = `3/25/26, 14:30 - John: Good morning
4/13/26, 10:00 - Mary: Hello`;

const AMBIGUOUS_DATES = `1/2/26, 14:30 - Oscar: Test
3/4/26, 10:00 - Bruno: Test`;

// ===== iOS real-world quirks: CRLF endings + leading bidi marks ===== //
// Real iOS exports use "\r\n" line endings and prepend U+200E (LEFT-TO-RIGHT
// MARK) to many lines (notably media/attachment and system lines). Both must be
// tolerated or the message-start regexes fail and ~all lines collapse into
// continuations of the first parsed message.

const IOS_CRLF = [
	"[10/02/26, 09:38:02] Beatriz Nogueira: Oi",
	"[10/02/26, 11:38:38] Oscar Neto: Bom dia",
	"[10/02/26, 11:39:16] Beatriz Nogueira: Tudo certo?",
].join("\r\n");

const IOS_LEADING_MARK = [
	"\u200e[10/02/26, 09:38:02] Beatriz Nogueira: \u200eMessages and calls are end-to-end encrypted.",
	"[10/02/26, 11:38:38] Oscar Neto: Bom dia",
	"\u200e[15/04/26, 16:04:50] Beatriz Nogueira: \u200e<attached: 0000123-doc.pdf>",
].join("\r\n");

// First lines are all day<=12 (ambiguous) with an ENGLISH encryption banner, so
// a language-only fallback would wrongly pick MM/DD. A later line (27/05) is the
// only one that disambiguates → detection must scan past the early lines.
const AMBIGUOUS_THEN_DDMM = [
	"[10/02/26, 09:38:02] A: Messages and calls are end-to-end encrypted.",
	...Array.from(
		{ length: 25 },
		(_, i) => `[0${(i % 9) + 1}/02/26, 10:0${i % 10}:00] A: msg ${i}`,
	),
	"[27/05/26, 15:00:00] A: later message",
].join("\r\n");

// ===== Tests =====

describe("detectZipLanguage", () => {
	test("detects English zip filename", () => {
		expect(detectZipLanguage("WhatsApp Chat with Bruno Teixeira.zip")).toBe("en");
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

	test("scans past early ambiguous lines to find a disambiguating date", () => {
		// All but the last line are day<=12; only line 27 (27/05) disambiguates.
		// Language hint is "en" (would wrongly yield MM/DD) — detection must not
		// stop early and must not fall back to language here.
		const lines = AMBIGUOUS_THEN_DDMM.split("\r\n");
		expect(detectDateFormat(lines, "en")).toBe("DD/MM");
	});

	test("tolerates leading bidi marks when reading the date", () => {
		const lines = IOS_LEADING_MARK.split("\r\n");
		expect(detectDateFormat(lines, "en")).toBe("DD/MM");
	});
});

describe("iOS real-world quirks (CRLF + leading bidi marks)", () => {
	test("parses CRLF (\\r\\n) lines without dropping messages", () => {
		const result = parseChatLog(IOS_CRLF);
		expect(result.messages.length).toBe(3);
		expect(result.warnings.length).toBe(0);
	});

	test("strips trailing \\r from message content", () => {
		const result = parseChatLog(IOS_CRLF);
		expect(result.messages[0]!.sender).toBe("Beatriz Nogueira");
		expect(result.messages[0]!.content).toBe("Oi");
		// no carriage return leaked into content
		expect(result.messages.some((m) => m.content.includes("\r"))).toBe(false);
	});

	test("recognizes lines prefixed with U+200E as message starts", () => {
		const result = parseChatLog(IOS_LEADING_MARK);
		// Without stripping the mark, the 1st and 3rd lines would collapse into
		// continuations and the count would be wrong (1 instead of 3).
		expect(result.messages.length).toBe(3);
		expect(result.messages[1]!.sender).toBe("Oscar Neto");
		expect(result.messages[2]!.sender).toBe("Beatriz Nogueira");
	});

	test("resolves DD/MM dates correctly on a real-world iOS export", () => {
		const result = parseChatLog(IOS_LEADING_MARK);
		expect(result.detectedFormat).toBe("DD/MM");
		// 15/04/26 must be 15 April, not 4 March / invalid month 15
		expect(result.messages[2]!.timestamp).toBe("2026-04-15T16:04:50");
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
			expect(msg.sender).toBe("Bruno Teixeira");
			expect(msg.content).toBe("Bom dia, tudo bem?");
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
			expect(msg.sender).toBe("Bruno Teixeira");
			expect(msg.content).toContain("@");
			expect(msg.content).toContain("Oscar Neto");
		});

		test("handles media omitted with continuation text", () => {
			const result = parseChatLog(EN_ANDROID_GROUP);
			const media = result.messages[4]!;
			expect(media.isMediaOmitted).toBe(true);
			expect(media.content).toContain("Projeto_Status");
		});
	});

	describe("file attachments", () => {
		test("parses (file attached) with filename", () => {
			const result = parseChatLog(EN_ANDROID_FILE_ATTACHED);
			const msg = result.messages[0]!;
			expect(msg.type).toBe("media");
			expect(msg.mediaFile).toBe("0000000-00.2026.8.26.0000.pdf");
			expect(msg.subtype).toBe("document");
		});

		test("handles filenames with parentheses", () => {
			const result = parseChatLog(EN_ANDROID_FILE_ATTACHED);
			const msg = result.messages[1]!;
			expect(msg.mediaFile).toBe("Helena (69-84) - Denúncia.pdf");
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
			expect(msg.content).toContain("Vou olhar o documento hoje à noite.");
			expect(msg.content).toContain("Amanhã cedo te retorno.");
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
