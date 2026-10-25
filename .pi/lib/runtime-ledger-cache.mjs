import { stat } from "node:fs/promises";
import { resolve } from "node:path";

// Shared results are immutable: callers must not corrupt later readers' state.
export function freezeRuntimeValue(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeRuntimeValue(child);
	return Object.freeze(value);
}

async function ledgerVersion(path) {
	try {
		const s = await stat(path, { bigint: true });
		return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
	} catch (error) {
		if (error.code === "ENOENT") return "missing";
		throw error;
	}
}

// A bounded process-local cache, not a persisted checkpoint. Every lookup checks
// metadata, including after waiting for an in-flight read (which may predate a
// write by the caller). A file changed during reading is never cached.
export function createRuntimeLedgerCache(load, { version = ledgerVersion, limit = 8 } = {}) {
	const entries = new Map();
	return async (runtime) => {
		const key = JSON.stringify([resolve(runtime.ledgerPath), runtime.projectKey]);
		let entry = entries.get(key);
		if (!entry) {
			entry = {};
			entries.set(key, entry);
			if (entries.size > limit) entries.delete(entries.keys().next().value);
		} else {
			entries.delete(key);
			entries.set(key, entry);
		}
		for (;;) {
			while (entry.pending) await entry.pending;
			const before = await version(runtime.ledgerPath);
			// A different reader may have started loading during the stat call.
			if (entry.pending) continue;
			if (entry.version === before) return entry.value;
			entry.version = undefined;
			entry.value = undefined;
			const pending = (async () => {
				const value = freezeRuntimeValue(await load(runtime));
				if (await version(runtime.ledgerPath) === before) {
					entry.value = value;
					entry.version = before;
				}
				return value;
			})();
			entry.pending = pending;
			try { return await pending; }
			finally { if (entry.pending === pending) entry.pending = null; }
		}
	};
}
