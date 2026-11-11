import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runtimeMemoryPolicy } from "./runtime-memory-policy.mjs";

// Shared results are immutable: callers must not corrupt later readers' state.
export function freezeRuntimeValue(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeRuntimeValue(child);
	return Object.freeze(value);
}

async function ledgerVersion(path, archivePath) {
	try {
		const s = await stat(path, { bigint: true });
		const current = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
		return archivePath ? `${current}:${await ledgerVersion(archivePath)}` : current;
	} catch (error) {
		if (error.code === "ENOENT") return "missing";
		throw error;
	}
}

// A bounded process-local cache, not a persisted checkpoint. Every lookup checks
// metadata, including after waiting for an in-flight read (which may predate a
// write by the caller). A file changed during reading is never cached.
export function createRuntimeLedgerCache(load, { version = ledgerVersion, limit = 8, maxBytes = runtimeMemoryPolicy().ledgerBytes,
		weight = value => value?.cacheBytes ?? Buffer.byteLength(JSON.stringify(value) ?? "null") * 2 } = {}) {
	const entries = new Map();
	let retainedBytes = 0;
	const discard = entry => { retainedBytes -= entry.bytes ?? 0; entry.bytes = 0; entry.value = undefined; entry.version = undefined; };
	const read = async (runtime) => {
		const key = JSON.stringify([resolve(runtime.ledgerPath), runtime.projectKey, runtime.branchId ?? null]);
		let entry = entries.get(key);
		if (!entry) {
			entry = {};
			entries.set(key, entry);
			if (entries.size > limit) { const oldest = entries.keys().next().value; discard(entries.get(oldest)); entries.delete(oldest); }
		} else {
			entries.delete(key);
			entries.set(key, entry);
		}
		for (;;) {
			while (entry.pending) {
				const pending = entry.pending, loadingVersion = entry.loadingVersion;
				const value = await pending;
				// Oversized values are not retained, but concurrent readers can still
				// share this flight after rechecking that no write superseded it.
				if (await version(runtime.ledgerPath, entry.archivePath) === loadingVersion) return value;
			}
			const before = await version(runtime.ledgerPath, entry.archivePath);
			// A different reader may have started loading during the stat call.
			if (entry.pending) continue;
			if (entry.version === before) return entry.value;
			discard(entry);
			entry.loadingVersion = before;
			const pending = (async () => {
				const value = freezeRuntimeValue(await load(runtime));
				entry.archivePath = value?.archivePath;
				const bytes = weight(value);
				if (bytes <= maxBytes && entries.get(key) === entry && await version(runtime.ledgerPath, entry.archivePath) === before) {
					entry.value = value;
					entry.version = before;
					entry.bytes = bytes; retainedBytes += bytes;
					for (const [oldKey, oldEntry] of entries) {
						if (retainedBytes <= maxBytes) break;
						if (oldEntry === entry) continue;
						discard(oldEntry); entries.delete(oldKey);
					}
				}
				return value;
			})();
			entry.pending = pending;
			try { return await pending; }
			finally { if (entry.pending === pending) entry.pending = null; }
		}
	};
	read.stats = () => ({ entries: entries.size, retainedBytes });
	return read;
}
