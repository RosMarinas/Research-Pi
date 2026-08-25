import { open } from "node:fs/promises";

const MAX_COMMAND_LENGTH = 600;
const MAX_OUTPUT_TAIL = 2000;
const MAX_PROMPT_LENGTH = 800;
const MAX_PATH_LENGTH = 320;
const DEFAULT_MAX_EVENTS = 240;
const SENSITIVE_TEXT =
	/(?:api[_ -]?key|token|secret|password|passwd|credential|authorization|auth\.json|\.env(?:\.|$)|bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_a-z0-9]{12,}|AKIA[A-Z0-9]{12,})/i;

function now() {
	return new Date().toISOString();
}

function compactWhitespace(value) {
	return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeCodexActivityText(value, max = 400, protectedLabel = "[protected]") {
	const text = compactWhitespace(value);
	if (!text) return "";
	if (SENSITIVE_TEXT.test(text)) return protectedLabel;
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function sanitizeOutputTail(value) {
	const text = String(value ?? "").trim();
	if (!text) return null;
	const tail = text.length <= MAX_OUTPUT_TAIL ? text : `...${text.slice(-(MAX_OUTPUT_TAIL - 3))}`;
	if (SENSITIVE_TEXT.test(tail)) return "[protected command output]";
	return tail;
}

function safePath(value) {
	return sanitizeCodexActivityText(value, MAX_PATH_LENGTH, "[protected path]");
}

function boundedList(values, limit, mapper) {
	return Array.isArray(values) ? values.slice(0, limit).map(mapper).filter(Boolean) : [];
}

function compactAgentStates(states) {
	if (!states || typeof states !== "object" || Array.isArray(states)) return {};
	return Object.fromEntries(
		Object.entries(states)
			.slice(0, 16)
			.map(([threadId, state]) => [
				sanitizeCodexActivityText(threadId, 160),
				{
					status: sanitizeCodexActivityText(state?.status, 40),
					message: sanitizeCodexActivityText(state?.message, 240),
				},
			]),
	);
}

function activityBase(message, timestamp) {
	const method = message?.method;
	const params = message?.params ?? {};
	const item = params.item ?? {};
	return {
		timestamp: timestamp ?? now(),
		method,
		threadId: sanitizeCodexActivityText(params.threadId ?? params.thread?.id, 160) || null,
		turnId: sanitizeCodexActivityText(params.turnId ?? params.turn?.id, 160) || null,
		itemId: sanitizeCodexActivityText(item.id, 160) || null,
		itemType: sanitizeCodexActivityText(item.type, 80) || null,
	};
}

export function describeCodexNotification(message) {
	const method = message?.method;
	const params = message?.params ?? {};
	const item = params.item ?? {};
	if (method === "thread/started") return "Codex thread started";
	if (method === "turn/started") return "Codex turn running";
	if (method === "turn/completed") return `Codex turn ${sanitizeCodexActivityText(params.turn?.status ?? "completed", 80)}`;
	if (method === "error") return sanitizeCodexActivityText(params.error?.message ?? params.message ?? "Codex error", 1000);
	if (method !== "item/started" && method !== "item/completed") return null;
	if (item.type === "commandExecution") {
		const command = sanitizeCodexActivityText(item.command ?? "command", MAX_COMMAND_LENGTH, "[protected command]");
		return `command ${sanitizeCodexActivityText(item.status ?? method.slice("item/".length), 40)}: ${command}`;
	}
	if (item.type === "fileChange") {
		const paths = boundedList(item.changes, 4, (change) => safePath(change?.path));
		return `file changes ${sanitizeCodexActivityText(item.status ?? method.slice("item/".length), 40)}${paths.length ? `: ${paths.join(", ")}` : ""}`;
	}
	if (item.type === "mcpToolCall") {
		return `MCP ${sanitizeCodexActivityText(item.server, 80)}/${sanitizeCodexActivityText(item.tool, 120)} · ${sanitizeCodexActivityText(item.status, 40)}`;
	}
	if (item.type === "webSearch") return `web search: ${sanitizeCodexActivityText(item.query, 360)}`;
	if (item.type === "dynamicToolCall") {
		return `${sanitizeCodexActivityText(item.tool ?? "dynamic tool", 160)} · ${sanitizeCodexActivityText(item.status, 40)}`;
	}
	if (item.type === "collabAgentToolCall") {
		const receivers = boundedList(item.receiverThreadIds, 4, (value) => sanitizeCodexActivityText(value, 48));
		return `subagent ${sanitizeCodexActivityText(item.tool ?? "activity", 80)} · ${sanitizeCodexActivityText(item.status, 40)}${receivers.length ? ` · ${receivers.join(", ")}` : ""}`;
	}
	if (item.type === "subAgentActivity") {
		const target = sanitizeCodexActivityText(item.agentPath || item.agentThreadId, 160);
		return `subagent ${sanitizeCodexActivityText(item.kind ?? "activity", 60)}${target ? ` · ${target}` : ""}`;
	}
	// Reasoning, user-message echoes, and partial/final prose are not objective
	// execution progress. They remain outside the supervisor projection.
	return null;
}

const LIFECYCLE_METHODS = new Set(["thread/started", "turn/started", "turn/completed", "error"]);

export function compactCodexAuditEvent(message, options = {}) {
	const method = message?.method;
	if (method === "item/tool/call" && message.id !== undefined) {
		const params = message.params ?? {};
		const args = params.arguments ?? {};
		const tool = sanitizeCodexActivityText(params.tool ?? "dynamic tool", 160);
		const action = sanitizeCodexActivityText(args.action, 60);
		const target = args.action === "ssh"
			? sanitizeCodexActivityText(args.target, 200)
			: args.action === "command"
				? sanitizeCodexActivityText(Array.isArray(args.argv) ? args.argv.join(" ") : "", MAX_COMMAND_LENGTH, "[protected command]")
				: safePath(args.path);
		return {
			timestamp: options.timestamp ?? now(),
			category: tool === "consult_research_pi" ? "request" : "tool",
			direction: "server_request",
			id: message.id,
			method,
			threadId: sanitizeCodexActivityText(params.threadId, 160) || null,
			turnId: sanitizeCodexActivityText(params.turnId, 160) || null,
			tool,
			action: action || null,
			target: target || null,
			summary: tool === "consult_research_pi"
				? "Codex requested Research Pi input"
				: `${tool}${action ? ` ${action}` : ""}${target ? `: ${target}` : ""}`,
		};
	}
	if (method === "item/tool/requestUserInput" && message.id !== undefined) {
		return {
			timestamp: options.timestamp ?? now(),
			category: "request",
			direction: "server_request",
			id: message.id,
			method,
			threadId: sanitizeCodexActivityText(message.params?.threadId, 160) || null,
			turnId: sanitizeCodexActivityText(message.params?.turnId, 160) || null,
			summary: "Codex requested user input",
		};
	}
	if (method && message.id !== undefined) {
		return {
			timestamp: options.timestamp ?? now(),
			category: "protocol",
			direction: "server_request",
			id: message.id,
			method,
			threadId: sanitizeCodexActivityText(message.params?.threadId, 160) || null,
			turnId: sanitizeCodexActivityText(message.params?.turnId, 160) || null,
		};
	}
	if (message?.id !== undefined && !method) {
		return {
			timestamp: options.timestamp ?? now(),
			category: "protocol",
			direction: "rpc_response",
			id: message.id,
			ok: !message.error,
			...(message.error ? { error: sanitizeCodexActivityText(message.error?.message ?? JSON.stringify(message.error), 1000) } : {}),
		};
	}
	if (LIFECYCLE_METHODS.has(method)) {
		const base = activityBase(message, options.timestamp);
		return {
			...base,
			category: method === "error" ? "error" : "lifecycle",
			summary: describeCodexNotification(message),
			status: method === "error" ? "failed" : sanitizeCodexActivityText(message.params?.turn?.status, 40) || null,
		};
	}
	if (method !== "item/started" && method !== "item/completed") return null;

	const params = message.params ?? {};
	const item = params.item ?? {};
	const summary = describeCodexNotification(message);
	if (!summary) return null;
	const base = activityBase(message, options.timestamp);
	const common = {
		...base,
		phase: method.slice("item/".length),
		status: sanitizeCodexActivityText(item.status, 40) || null,
		durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
		summary,
	};

	switch (item.type) {
		case "commandExecution":
			return {
				...common,
				category: "command",
				command: sanitizeCodexActivityText(item.command, MAX_COMMAND_LENGTH, "[protected command]"),
				cwd: safePath(item.cwd) || null,
				exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
				outputTail: method === "item/completed" ? sanitizeOutputTail(item.aggregatedOutput) : null,
			};
		case "fileChange":
			return {
				...common,
				category: "file",
				changes: boundedList(item.changes, 24, (change) => ({
					path: safePath(change?.path),
					kind: sanitizeCodexActivityText(change?.kind, 40),
				})),
			};
		case "mcpToolCall":
			return {
				...common,
				category: "tool",
				server: sanitizeCodexActivityText(item.server, 80),
				tool: sanitizeCodexActivityText(item.tool, 160),
				error: sanitizeCodexActivityText(item.error?.message ?? item.error, 500) || null,
			};
		case "dynamicToolCall":
			return {
				...common,
				category: "tool",
				tool: sanitizeCodexActivityText(item.tool, 160),
				success: typeof item.success === "boolean" ? item.success : null,
			};
		case "webSearch":
			return {
				...common,
				category: "search",
				query: sanitizeCodexActivityText(item.query, 500),
			};
		case "collabAgentToolCall":
			return {
				...common,
				category: "subagent",
				collabTool: sanitizeCodexActivityText(item.tool, 80),
				senderThreadId: sanitizeCodexActivityText(item.senderThreadId, 160) || null,
				receiverThreadIds: boundedList(item.receiverThreadIds, 16, (value) => sanitizeCodexActivityText(value, 160)),
				agentsStates: compactAgentStates(item.agentsStates),
				model: sanitizeCodexActivityText(item.model, 120) || null,
				reasoningEffort: sanitizeCodexActivityText(item.reasoningEffort, 40) || null,
				prompt: sanitizeCodexActivityText(item.prompt, MAX_PROMPT_LENGTH, "[protected subagent prompt]") || null,
			};
		case "subAgentActivity":
			return {
				...common,
				category: "subagent",
				agentThreadId: sanitizeCodexActivityText(item.agentThreadId, 160) || null,
				agentPath: sanitizeCodexActivityText(item.agentPath, 200) || null,
				agentActivityKind: sanitizeCodexActivityText(item.kind, 60) || null,
			};
		default:
			return null;
	}
}

/**
 * Project one objective leaf event into bounded job-state activity. Job
 * lifecycle remains separate: an item/completed notification never means the
 * Codex turn or job completed.
 */
export function projectCodexActivityUpdate(message, options = {}) {
	if (message?.method !== "item/started" && message?.method !== "item/completed") return null;
	const record = compactCodexAuditEvent(message, options);
	if (!record?.summary || !record?.category) return null;
	const at = record.timestamp ?? options.timestamp ?? now();
	return {
		phase: record.phase,
		activity: {
			id: record.itemId ?? null,
			threadId: record.threadId ?? null,
			category: record.category,
			summary: record.summary,
			status: record.status ?? record.phase,
			at,
		},
	};
}

export function normalizeCodexActivityRecord(record) {
	if (!record || typeof record !== "object") return null;
	if (record.category && record.timestamp) return record;
	// PI_CODEX_TRACE=1 stores raw App Server messages. Convert them to the same
	// objective projection used by the default compact audit stream.
	return compactCodexAuditEvent(record);
}

export function projectCodexAgents(events) {
	const agents = new Map();
	for (const event of events) {
		if (event?.category !== "subagent") continue;
		for (const [threadId, state] of Object.entries(event.agentsStates ?? {})) {
			const current = agents.get(threadId) ?? { threadId };
			agents.set(threadId, {
				...current,
				status: state?.status || current.status || "unknown",
				message: state?.message || current.message || null,
				updatedAt: event.timestamp,
			});
		}
		for (const threadId of event.receiverThreadIds ?? []) {
			const current = agents.get(threadId) ?? { threadId };
			agents.set(threadId, {
				...current,
				status: current.status ?? (event.status === "failed" ? "errored" : "running"),
				model: event.model ?? current.model ?? null,
				reasoningEffort: event.reasoningEffort ?? current.reasoningEffort ?? null,
				prompt: event.prompt ?? current.prompt ?? null,
				updatedAt: event.timestamp,
			});
		}
		if (event.agentThreadId) {
			const current = agents.get(event.agentThreadId) ?? { threadId: event.agentThreadId };
			agents.set(event.agentThreadId, {
				...current,
				path: event.agentPath ?? current.path ?? null,
				activity: event.agentActivityKind ?? current.activity ?? null,
				status: event.agentActivityKind === "interrupted" ? "interrupted" : current.status ?? "running",
				updatedAt: event.timestamp,
			});
		}
	}
	return [...agents.values()].sort((left, right) => String(left.threadId).localeCompare(String(right.threadId)));
}

export class CodexActivityCursor {
	constructor(path, options = {}) {
		this.path = path;
		this.offset = 0;
		this.carry = "";
		this.events = [];
		this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
	}

	async poll() {
		let handle;
		try {
			handle = await open(this.path, "r");
			const stat = await handle.stat();
			if (stat.size < this.offset) {
				this.offset = 0;
				this.carry = "";
				this.events = [];
			}
			const remaining = stat.size - this.offset;
			if (remaining <= 0) return this.events;
			const buffer = Buffer.allocUnsafe(remaining);
			const { bytesRead } = await handle.read(buffer, 0, remaining, this.offset);
			this.offset += bytesRead;
			const text = this.carry + buffer.subarray(0, bytesRead).toString("utf8");
			const lines = text.split(/\r?\n/);
			this.carry = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = normalizeCodexActivityRecord(JSON.parse(line));
					if (event && event.category !== "protocol") this.events.push(event);
				} catch {
					// A damaged audit line should not make the live supervisor unusable.
				}
			}
			if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
			return this.events;
		} catch (error) {
			if (error?.code === "ENOENT") return this.events;
			throw error;
		} finally {
			await handle?.close();
		}
	}
}
