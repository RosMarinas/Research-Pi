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
export function createSubagentActivityWriter(path) {
	let buffer = [], timer, writes = Promise.resolve(), directoryReady = false;
	const partials = new Map();
	const flush = () => {
		clearTimeout(timer); timer = undefined;
		if (!buffer.length) return writes;
		partials.clear();
		const batch = buffer.splice(0).map((record) => JSON.stringify({ ...record, ...(record.result ? { result: sanitizeDisplayValue(record.result) } : {}) })).join("\n") + "\n";
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
		if (["assistant_delta", "thinking_delta"].includes(category) && previous?.category === category && previous.turn === job.turn) previous.text += text;
		else {
		const record = { timestamp: event.at ?? new Date().toISOString(), category, text,
			summary: publicSubagentText(event.summary, 600), source: event.source, messageId: event.messageId, turn: job.turn,
			tool: event.tool, toolCallId: event.toolCallId, phase: event.phase, isError: event.isError,
			...(event.args ? { args: sanitizeDisplayValue(event.args) } : {}),
			...(event.result ? { result: event.result } : {}) };
		const key = event.toolCallId ? `${job.turn}:${event.toolCallId}` : null;
		if (key && event.result && partials.has(key)) {
			Object.assign(partials.get(key), record); runtimePerformance.count("toolSnapshotsCoalesced");
		} else {
			buffer.push(record);
			if (key && event.result) partials.set(key, record);
		}
		}
		if (!timer) { timer = setTimeout(() => { void flush().catch(() => undefined); }, 400); timer.unref(); }
	};
	return { append, flush };
}

function sanitizeDisplayValue(value) {
	if (typeof value === "string") return publicSubagentText(value);
	if (Array.isArray(value)) return value.filter(item => item?.type !== "image").map(sanitizeDisplayValue);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDisplayValue(item)]));
	return value;
}
