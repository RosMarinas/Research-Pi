import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runtimeMemoryPolicy } from "./runtime-memory-policy.mjs";
const HISTORY_VALUE = Symbol("history-value");
const materialize = value => value?.[HISTORY_VALUE] ?? value;

// Ordinary accessor objects remain compatible with structuredClone, unlike
// proxies. Reading/exporting an old body materializes only that entry.
function lazyObject(keys, metadata, full, edit) {
	const object = {};
	for (const key of keys) {
		if (key in metadata) object[key] = metadata[key];
		else Object.defineProperty(object, key, { enumerable: true, configurable: true,
			get: () => full()[key], set: value => edit(key, value) });
	}
	Object.defineProperty(object, HISTORY_VALUE, { get: full });
	return object;
}

function createIndexedEntry({ basic, keys, messageKeys, messageMetadata, length, start }, load) {
	let edited;
	const full = () => edited ?? load(start, length, basic);
	if (messageKeys) basic.message = lazyObject(messageKeys, messageMetadata, () => full().message,
		(key, item) => { edited ??= { ...full(), message: { ...full().message } }; edited.message[key] = item; });
	return lazyObject(keys, basic, full, (key, item) => { edited ??= { ...full() }; edited[key] = item; });
}

// Current-version history is append-only. Retain its tree index, not every
// historical tool output. Core continues to own projection, edits and writes.
export function indexSessionHistory(path, { cacheBytes = runtimeMemoryPolicy().sessionBytes } = {}) {
	const fd = openSync(path, "r");
	const initial = fstatSync(fd);
	const entries = [], cache = new Map();
	let bytes = 0, offset = 0, carry = Buffer.alloc(0), loads = 0, header;
	const load = (start, length, basic) => {
		if (cache.has(start)) { const hit = cache.get(start); cache.delete(start); cache.set(start, hit); return hit.value; }
		const input = openSync(path, "r");
		let buffer;
		try {
			const current = fstatSync(input);
			if (current.ino !== initial.ino || current.dev !== initial.dev || current.size < start + length) throw new Error("Session history changed on disk; reopen the Session");
			buffer = Buffer.allocUnsafe(length);
			let read = 0;
			while (read < length) { const n = readSync(input, buffer, read, length - read, start + read); if (!n) throw new Error("Session history was truncated"); read += n; }
		} finally { closeSync(input); }
		const value = JSON.parse(buffer.toString("utf8"));
		if (value.id !== basic.id || value.type !== basic.type) throw new Error("Session history index no longer matches its source");
		loads++;
		if (length <= cacheBytes) {
			cache.set(start, { value, length }); bytes += length;
			while (bytes > cacheBytes) { const key = cache.keys().next().value; bytes -= cache.get(key).length; cache.delete(key); }
		}
		return value;
	};
	const line = (buffer, start) => {
		let value;
		try { value = JSON.parse(buffer.toString("utf8")); } catch { return; }
		if (!header) { header = value; entries.push(value); return; }
		const basic = Object.fromEntries(["id", "parentId", "type", "timestamp"].filter(key => key in value).map(key => [key, value[key]]));
		const message = value.type === "message" && value.message && typeof value.message === "object" ? value.message : null;
		const messageMetadata = message && Object.fromEntries(["role", "provider", "model", "api", "timestamp", "stopReason", "usage"].filter(key => key in message).map(key => [key, message[key]]));
		// Construct accessors in a separate lexical scope: no getter may retain
		// this parser frame's full value, raw line, or reusable input buffer.
		entries.push(createIndexedEntry({ basic, keys: Object.keys(value), messageKeys: message && Object.keys(message), messageMetadata, length: buffer.length, start }, load));
	};
	try {
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let count;
		while ((count = readSync(fd, chunk, 0, chunk.length, null))) {
			const input = carry.length ? Buffer.concat([carry, chunk.subarray(0, count)]) : chunk.subarray(0, count);
			let begin = 0, end;
			while ((end = input.indexOf(10, begin)) >= 0) { line(input.subarray(begin, end), offset + begin); begin = end + 1; }
			carry = Buffer.from(input.subarray(begin)); offset += begin;
		}
		// Core repairs unterminated tails when opening normal history. Keep that
		// behavior on its eager path rather than silently changing this file.
		if (carry.length) return null;
	} finally { closeSync(fd); }
	if (header?.type !== "session" || header.version !== 3) return null;
	return { entries, stats: () => ({ cachedBytes: bytes, cachedEntries: cache.size, loads, indexedEntries: entries.length }), clear() { cache.clear(); bytes = 0; } };
}

export function openLazySession(SessionManager, path, sessionDir, cwd, options) {
	const indexed = indexSessionHistory(path, options);
	if (!indexed) return SessionManager.open(path, sessionDir, cwd);
	const manager = new SessionManager(cwd ?? indexed.entries[0].cwd, sessionDir ?? dirname(path), path, true, undefined, indexed.entries);
	const project = manager.buildSessionProjection.bind(manager);
	manager.buildSessionProjection = () => {
		const projection = project();
		// Only active context crosses Core's structuredClone/provider boundary.
		return { ...projection, messages: projection.messages.map(materialize),
			entries: projection.entries.map(entry => ({ ...entry, sourceEntry: materialize(entry.sourceEntry), messages: entry.messages.map(materialize) })) };
	};
	Object.defineProperty(manager, "historyCache", { value: indexed });
	return manager;
}

export function readSessionIdentity(path) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, bytes).indexOf(10);
		if (end < 0) return null;
		const header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
		return header.type === "session" ? header : null;
	} finally { closeSync(fd); }
}

export function discoverSessionHeaders(directory, cwd) {
	let names;
	try { names = readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
	return names.filter(name => name.endsWith(".jsonl")).flatMap(name => {
		const path = join(directory, name);
		try {
			const header = readSessionIdentity(path);
			return header && (!cwd || resolve(header.cwd) === resolve(cwd)) ? [{ ...header, path, mtime: statSync(path).mtimeMs }] : [];
		} catch { return []; }
	});
}
