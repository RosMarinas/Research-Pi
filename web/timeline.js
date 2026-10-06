// Typed presentation only: Pi messages and tool-call IDs remain authoritative.
const text = (content) => typeof content === "string" ? content : (content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
export function renderToolCard(call, result, live, { escape, md, expanded = false }) {
	const args = call.arguments ?? {}, job = result?.details?.job ?? result?.details ?? live?.result?.details ?? {};
	const name = call.name ?? result?.toolName ?? "工具", subagent = /subagent/i.test(name) || Boolean(job.actorId);
	const status = job.status ?? (result ? result.isError ? "failed" : "completed" : live?.status ?? "running");
	const variant = subagent ? "subagent" : /bash|shell|exec/i.test(name) ? "shell" : /edit|write|patch/i.test(name) ? "edit" : /read|search|find|grep/i.test(name) ? "read" : "generic";
	const title = subagent ? `Subagent ${args.action ?? "run"}` : name;
	const summary = args.task ?? args.followUp ?? args.message ?? args.command ?? args.path ?? args.pattern ?? job.mission ?? "";
	const output = text(result?.content ?? live?.result?.content);
	const actorId = job.actorId ?? args.actorId;
	const metadata = [job.backend ?? args.backend, job.role ?? args.role ?? job.mode, job.id, job.model, job.thinking ?? job.reasoningEffort, job.mission].filter(Boolean).join(" · ");
	return `<section class="tool-card ${variant}" data-tool-call="${escape(call.id ?? result?.toolCallId ?? "")}"><header><strong>${escape(title)}</strong><span class="tool-state ${status === "failed" ? "failed" : ""}">${escape(status)}${job.result?.outcome ? " / " + escape(job.result.outcome) : ""}</span></header>${summary ? `<p class="tool-summary">${escape(String(summary).slice(0, 360))}</p>` : ""}${metadata ? `<p class="tool-meta">${escape(metadata)}</p>` : ""}${job.progress || job.phase ? `<p class="tool-phase">${escape(job.progress ?? job.phase)}</p>` : ""}${actorId ? `<button class="quiet watch-tool" data-watch="${escape(actorId)}">查看 Agent ↗</button>` : ""}<details${expanded ? " open" : ""}><summary>参数与输出${output ? " · " + output.length + " 字符" : ""}</summary><pre>${escape(JSON.stringify(args, null, 2))}</pre>${output ? `<div class="tool-output">${variant === "shell" ? `<pre>${escape(output)}</pre>` : md(output)}</div>` : '<small>等待工具输出…</small>'}</details></section>`;
}
export function renderTimeline(entries, options) {
	const { escape, md, activeMessage, liveTools = [], hiddenThinking = false, expanded = false } = options;
	const messages = entries.map((e) => e.message ?? e), results = new Map(), calls = new Set();
	for (const m of messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	for (const m of [...messages, ...(activeMessage ? [activeMessage] : [])]) for (const p of Array.isArray(m.content) ? m.content : []) if (p.type === "toolCall") calls.add(p.id);
	const blocks = (m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []).map((p) => {
		if (p.type === "text") return md(p.text);
		if (p.type === "thinking" || p.type === "reasoning") return hiddenThinking ? "" : `<details class="thinking-block"><summary>思考过程</summary>${md(p.thinking ?? p.text ?? "")}</details>`;
		if (p.type === "toolCall") return renderToolCard(p, results.get(p.id), liveTools.find((t) => t.id === p.id), { escape, md, expanded });
		if (p.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(p.mimeType) && p.data) return `<img alt="对话图片" src="data:${escape(p.mimeType)};base64,${escape(p.data)}">`;
		return "";
	}).join("");
	return [...messages, ...(activeMessage ? [activeMessage] : [])].map((m) => {
		if (m.role === "toolResult") return calls.has(m.toolCallId) ? "" : renderToolCard({ name: m.toolName, id: m.toolCallId }, m, undefined, { escape, md, expanded });
		const content = blocks(m); if (!content) return "";
		if (m.customType === "research-side") return `<details class="side-card"${expanded ? " open" : ""}><summary>独立讨论 · SIDE</summary>${content}</details>`;
		const role = m.role ?? "runtime";
		return `<article class="message ${role === "user" ? "user" : "assistant"}"><div class="message-label">${escape(role === "user" ? "You" : role === "assistant" ? "Pi" : m.customType ?? "Runtime")}</div>${content}</article>`;
	}).join("");
}
