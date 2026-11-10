import { runtimePerformance } from "./runtime-performance.mjs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeCodexActivityText } from "./codex-activity.mjs";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function publicSubagentText(value, limit = 16000) {
	const text = stripTerminalSequences(String(value ?? ""));
	const safe = sanitizeCodexActivityText(text, limit, "[protected content]");
	return safe === "[protected content]" ? safe : text.slice(0, limit);
}

// A display journal, not a second task/mailbox protocol. Stream fragments are
// batched into one append; they never become canonical Runtime progress events.
export function createSubagentActivityWriter(path, { batchBytes = 512 * 1024 } = {}) {
	let buffer = [], timer, writes = Promise.resolve(), directoryReady = false, bufferedBytes = 0;
	const partials = new Map();
	const flush = () => {
		clearTimeout(timer); timer = undefined;
		if (!buffer.length) return writes;
		partials.clear();
		const batch = buffer.splice(0).map((record) => JSON.stringify({ ...record, ...(record.result ? { result: sanitizeDisplayValue(record.result) } : {}) })).join("\n") + "\n";
		bufferedBytes = 0;
		writes = writes.then(async () => {
			if (!directoryReady) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); directoryReady = true; }
			await appendFile(path, batch, { encoding: "utf8", mode: 0o600 });
			runtimePerformance.count("journalWrites");
			if (runtimePerformance.enabled) runtimePerformance.count("journalBytes", Buffer.byteLength(batch));
		});
		return writes;
	};
	const append = (job, event) => {
		if (!event) return;
		const delta = event.raw?.step_type === "agent_response" ? event.raw.text_delta : null;
		const category = ["assistant_delta", "thinking_delta"].includes(event.type) ? event.type : delta ? "assistant_delta" : event.type === "assistant" || event.type === "done" ? "assistant"
			: event.type === "message" ? "message" : event.tool ? "tool" : "lifecycle";
		const text = publicSubagentText(delta ?? event.text ?? (event.type === "done" ? job.result?.summary : null) ?? event.summary);
		if (!text) return;
		const previous = buffer.at(-1);
		if (["assistant_delta", "thinking_delta"].includes(category) && previous?.category === category && previous.turn === job.turn && previous.text.length + text.length <= 16000) previous.text += text;
		else {
		const record = { timestamp: event.at ?? new Date().toISOString(), category, text,
			summary: publicSubagentText(event.summary, 600), source: event.source, messageId: event.messageId, turn: job.turn,
			tool: event.tool, toolCallId: event.toolCallId, phase: event.phase, isError: event.isError,
			...(event.args ? { args: sanitizeDisplayValue(event.args) } : {}),
			...(event.result ? { result: sanitizeDisplayValue(event.result) } : {}) };
		const key = event.toolCallId ? `${job.turn}:${event.toolCallId}` : null;
		if (key && event.result && partials.has(key)) {
			Object.assign(partials.get(key), record); runtimePerformance.count("toolSnapshotsCoalesced");
		} else {
			buffer.push(record);
			if (key && event.result) partials.set(key, record);
		}
		}
		bufferedBytes += Buffer.byteLength(text) + (event.result ? Buffer.byteLength(JSON.stringify(sanitizeDisplayValue(event.result))) : 0);
		if (bufferedBytes >= batchBytes) return flush();
		if (!timer) { timer = setTimeout(() => { void flush().catch(() => undefined); }, 400); timer.unref(); }
	};
	return { append, flush, stats: () => ({ bufferedBytes, records: buffer.length }) };
}

function sanitizeDisplayValue(value, budget = { bytes: 64 * 1024 }, depth = 0) {
	if (budget.bytes <= 0 || depth > 8) return "[display truncated; full output remains in Session]";
	budget.bytes -= 32;
	if (typeof value === "string") {
		const text = publicSubagentText(value, Math.min(16000, Math.max(0, Math.floor(budget.bytes / 4))));
		budget.bytes -= Buffer.byteLength(text); return text;
	}
	if (Array.isArray(value)) {
		const result = [];
		for (const item of value) { if (result.length >= 128 || budget.bytes <= 0) break; if (item?.type !== "image") result.push(sanitizeDisplayValue(item, budget, depth + 1)); }
		if (result.length < value.length) result.push("[display truncated; full output remains in Session]");
		return result;
	}
	if (value && typeof value === "object") {
		const pairs = [];
		for (const [key, item] of Object.entries(value)) { if (pairs.length >= 128 || budget.bytes <= 0) break; budget.bytes -= Buffer.byteLength(key); pairs.push([key, sanitizeDisplayValue(item, budget, depth + 1)]); }
		return Object.fromEntries(pairs);
	}
	return value;
}
