import { describe, expect, test } from "bun:test";
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import {
	type ChunkTranscription,
	mergeTranscriptions,
} from "../transcript-merger";

function word(
	overrides: Partial<ElevenLabs.SpeechToTextWordResponseModel> &
		Pick<ElevenLabs.SpeechToTextWordResponseModel, "text">,
): ElevenLabs.SpeechToTextWordResponseModel {
	return {
		type: "word",
		logprob: -0.1,
		start: 0,
		end: 0,
		...overrides,
	};
}

function chunk(
	partNumber: number,
	totalParts: number,
	startSeconds: number,
	words: ElevenLabs.SpeechToTextWordResponseModel[],
	text = words.map((w) => w.text).join(" "),
): ChunkTranscription {
	return {
		partNumber,
		totalParts,
		startSeconds,
		response: {
			languageCode: "pt",
			languageProbability: 0.97,
			text,
			words,
		},
	};
}

describe("mergeTranscriptions", () => {
	test("offsets timestamps by chunk startSeconds", () => {
		const c1 = chunk(1, 2, 0, [
			word({ text: "Olá", start: 0.5, end: 1.0, speakerId: "speaker_0" }),
		]);
		const c2 = chunk(2, 2, 3000, [
			word({ text: "Mundo", start: 1.2, end: 1.8, speakerId: "speaker_0" }),
		]);

		const { merged } = mergeTranscriptions([c1, c2]);

		expect(merged.words).toHaveLength(2);
		expect(merged.words[0]?.start).toBe(0.5);
		expect(merged.words[0]?.end).toBe(1.0);
		expect(merged.words[1]?.start).toBe(3001.2);
		expect(merged.words[1]?.end).toBe(3001.8);
	});

	test("prefixes speaker IDs with the part number", () => {
		const c1 = chunk(1, 2, 0, [
			word({ text: "A", speakerId: "speaker_0" }),
			word({ text: "B", speakerId: "speaker_1" }),
		]);
		const c2 = chunk(2, 2, 100, [word({ text: "C", speakerId: "speaker_0" })]);

		const { merged } = mergeTranscriptions([c1, c2]);

		expect(merged.words.map((w) => w.speakerId)).toEqual([
			"speaker_0 (parte 1)",
			"speaker_1 (parte 1)",
			"speaker_0 (parte 2)",
		]);
	});

	test("falls back to 'Desconhecido' for missing speaker IDs", () => {
		const c1 = chunk(1, 1, 0, [word({ text: "Hmm" })]);

		const { merged } = mergeTranscriptions([c1]);

		expect(merged.words[0]?.speakerId).toBe("Desconhecido (parte 1)");
	});

	test("preserves undefined start/end (no NaN from offsetting nothing)", () => {
		const c1 = chunk(1, 1, 1000, [
			word({ text: "x", start: undefined, end: undefined }),
		]);

		const { merged } = mergeTranscriptions([c1]);

		expect(merged.words[0]?.start).toBeUndefined();
		expect(merged.words[0]?.end).toBeUndefined();
	});

	test("inherits languageCode and languageProbability from the first chunk", () => {
		const c1 = chunk(1, 2, 0, [word({ text: "a" })]);
		const c2: ChunkTranscription = {
			...chunk(2, 2, 100, [word({ text: "b" })]),
			response: {
				languageCode: "en",
				languageProbability: 0.4,
				text: "b",
				words: [word({ text: "b" })],
			},
		};

		const { merged } = mergeTranscriptions([c1, c2]);

		expect(merged.languageCode).toBe("pt");
		expect(merged.languageProbability).toBe(0.97);
	});

	test("returns boundaries for every chunk in order", () => {
		const c1 = chunk(1, 3, 0, []);
		const c2 = chunk(2, 3, 3000, []);
		const c3 = chunk(3, 3, 6000, []);

		const { boundaries } = mergeTranscriptions([c1, c2, c3]);

		expect(boundaries).toEqual([
			{ partNumber: 1, totalParts: 3, startSeconds: 0 },
			{ partNumber: 2, totalParts: 3, startSeconds: 3000 },
			{ partNumber: 3, totalParts: 3, startSeconds: 6000 },
		]);
	});

	test("sorts chunks by partNumber even when input is out of order", () => {
		const c2 = chunk(2, 2, 100, [
			word({ text: "second", speakerId: "speaker_0" }),
		]);
		const c1 = chunk(1, 2, 0, [
			word({ text: "first", speakerId: "speaker_0" }),
		]);

		const { merged } = mergeTranscriptions([c2, c1]);

		expect(merged.words.map((w) => w.text)).toEqual(["first", "second"]);
	});

	test("single-chunk input is a no-op except for speaker prefix", () => {
		const c1 = chunk(1, 1, 0, [
			word({ text: "Solo", start: 1, end: 2, speakerId: "speaker_0" }),
		]);

		const { merged, boundaries } = mergeTranscriptions([c1]);

		expect(merged.words[0]?.start).toBe(1);
		expect(merged.words[0]?.end).toBe(2);
		expect(merged.words[0]?.speakerId).toBe("speaker_0 (parte 1)");
		expect(boundaries).toHaveLength(1);
	});

	test("throws on empty input", () => {
		expect(() => mergeTranscriptions([])).toThrow(
			/at least one chunk is required/,
		);
	});

	test("concatenates text from each chunk", () => {
		const c1 = chunk(1, 2, 0, [], "primeira parte.");
		const c2 = chunk(2, 2, 100, [], "segunda parte.");

		const { merged } = mergeTranscriptions([c1, c2]);

		expect(merged.text).toBe("primeira parte. segunda parte.");
	});
});
