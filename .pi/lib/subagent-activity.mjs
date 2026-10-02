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
	let buffer = [], timer, writes = Promise.resolve();
	const flush = () => {
		clearTimeout(timer); timer = undefined;
		if (!buffer.length) return writes;
		const batch = buffer.splice(0).map((record) => JSON.stringify(record)).join("\n") + "\n";
		writes = writes.then(async () => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await appendFile(path, batch, { encoding: "utf8", mode: 0o600 });
		});
		return writes;
	};
	const append = (job, event) => {
		if (!event) return;
		const delta = event.raw?.step_type === "agent_response" ? event.raw.text_delta : null;
		const category = delta ? "assistant_delta" : event.type === "assistant" || event.type === "done" ? "assistant"
			: event.type === "message" ? "message" : event.type === "tool" ? "tool" : "lifecycle";
		const text = publicSubagentText(delta ?? event.text ?? (event.type === "done" ? job.result?.summary : null) ?? event.summary);
		if (!text) return;
		const previous = buffer.at(-1);
		if (category === "assistant_delta" && previous?.category === category && previous.turn === job.turn) previous.text += text;
		else buffer.push({ timestamp: event.at ?? new Date().toISOString(), category, text,
			summary: publicSubagentText(event.summary, 600), source: event.source, messageId: event.messageId, turn: job.turn });
		if (!timer) { timer = setTimeout(() => { void flush().catch(() => undefined); }, 400); timer.unref(); }
	};
	return { append, flush };
}
