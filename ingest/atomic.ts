// =============================================================================
// Atomic file writes
// =============================================================================

import { rename, rm } from "node:fs/promises";

/**
 * Writes through a temp file in the same directory, then renames it into place.
 * A crash or a full disk mid-write leaves the previous file intact instead of a
 * truncated one — the index holds an export's whole history, so this matters.
 */
export async function writeFileAtomic(
	path: string,
	data: string,
): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await Bun.write(temp, data);
		await rename(temp, path);
	} catch (err) {
		await rm(temp, { force: true });
		throw err;
	}
}
