// =============================================================================
// Test Fixtures
// Generates synthetic WhatsApp export zips on demand so the suite is
// self-contained — no private chat data or binary blobs checked into the repo.
// The content mirrors real iOS-export quirks (bracketed dates, CRLF endings,
// leading U+200E marks). Requires the `zip` CLI, the counterpart to the `unzip`
// the extractor already depends on.
// =============================================================================

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LRM = "\u200e"; // U+200E LEFT-TO-RIGHT MARK, as WhatsApp prepends on iOS

// Individual chat: two participants, text only, no media. "configuração"
// carries the accented characters the UTF-8 assertion looks for.
const TIAGO_CHAT = [
	`${LRM}[10/02/2026, 09:38:02] Bruno Teixeira: ${LRM}Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.`,
	"[10/02/2026, 11:38:38] Bruno Teixeira: Olá Oscar, a configuração foi concluída.",
	"[10/02/2026, 11:39:16] Oscar Neto: Perfeito, missão cumprida!",
].join("\r\n");

// Group chat: 3+ participants, a group-creation system line, and one media file.
const GROUP_CHAT = [
	`${LRM}[09/02/2026, 15:57:00] Bruno Teixeira: ${LRM}Messages and calls are end-to-end encrypted.`,
	`${LRM}[09/02/2026, 15:57:10] ${LRM}Bruno Teixeira created group "Equipe RenatoBruno"`,
	"[09/02/2026, 16:00:00] Renato L.: Bom dia a todos, configuração inicial.",
	`${LRM}[09/02/2026, 16:01:00] Oscar Neto: ${LRM}<attached: IMG-0001.jpg>`,
	"[09/02/2026, 16:02:00] Beatriz: recebido, obrigada!",
].join("\r\n");

// Minimal JPEG header bytes — enough for the extractor to move it as media.
const FAKE_JPEG = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

async function buildZip(
	dir: string,
	zipName: string,
	files: Record<string, string | Uint8Array>,
): Promise<void> {
	const stage = await mkdtemp(join(dir, "stage-"));
	const paths: string[] = [];
	for (const [name, content] of Object.entries(files)) {
		const filePath = join(stage, name);
		await writeFile(filePath, content);
		paths.push(filePath);
	}
	// -j junks paths so the archive is flat, like a real WhatsApp export.
	await Bun.$`zip -q -j ${join(dir, zipName)} ${paths}`.quiet();
	await rm(stage, { recursive: true, force: true });
}

/**
 * Create a temp directory containing two synthetic WhatsApp export zips:
 *  - "WhatsApp Chat with Bruno Teixeira.zip"      (individual, text only)
 *  - "WhatsApp Chat with Equipe RenatoBruno.zip" (group, with one media file)
 *
 * The caller is responsible for removing the returned directory.
 */
export async function createFixturesDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wae-fixtures-"));
	await buildZip(dir, "WhatsApp Chat with Bruno Teixeira.zip", {
		"_chat.txt": TIAGO_CHAT,
	});
	await buildZip(dir, "WhatsApp Chat with Equipe RenatoBruno.zip", {
		"_chat.txt": GROUP_CHAT,
		"IMG-0001.jpg": FAKE_JPEG,
	});
	return dir;
}
