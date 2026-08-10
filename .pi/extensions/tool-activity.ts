import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ActiveTool {
	id: string;
	name: string;
	summary: string;
	startedAt: number;
}

const STATUS_KEY = "tool_activity";
const TERMINAL_HOLD_MS = 5000;
const SENSITIVE_TEXT =
	/(?:api[_ -]?key|token|secret|password|passwd|credential|authorization|auth\.json|\.env(?:\.|$)|bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_a-z0-9]{12,}|AKIA[A-Z0-9]{12,})/i;

function bounded(value: unknown, max = 64): string {
	const text = String(value ?? "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	if (SENSITIVE_TEXT.test(text)) return "[protected]";
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function pathSummary(args: Record<string, unknown>): string {
	return bounded(args.path ?? ".");
}

export function summarizeToolCall(toolName: string, rawArgs: unknown): string {
	const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return pathSummary(args);
		case "grep":
		case "find": {
			const pattern = bounded(args.pattern);
			const path = pathSummary(args);
			return bounded([pattern ? `“${pattern}”` : "", path ? `in ${path}` : ""].filter(Boolean).join(" "));
		}
		case "bash":
			return bounded(args.command);
		case "web_search":
		case "research_memory_search":
			return bounded(args.query);
		case "research_memory_read":
			return bounded(`S:${args.sessionId ?? "?"}/E:${args.entryId ?? "?"}`);
		case "research_checkpoint":
			return bounded(args.label);
		case "record_experiment":
			return bounded(args.runId ?? args.validityJudgment ?? "research memo");
		case "codex_delegate":
			return bounded([args.action, args.mode, args.jobId ? String(args.jobId).slice(-8) : ""].filter(Boolean).join(" · "));
		default:
			return "";
	}
}

function duration(milliseconds: number): string {
	if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function formatToolActivity(tools: ActiveTool[], now = Date.now()): string | undefined {
	const latest = tools.at(-1);
	if (!latest) return undefined;
	const count = tools.length > 1 ? `${tools.length} tools · latest ` : "";
	const target = latest.summary ? ` · ${latest.summary}` : "";
	return `⚙ ${count}${latest.name}${target} · ${duration(now - latest.startedAt)}`;
}

export function formatToolTerminal(tool: ActiveTool, isError: boolean, finishedAt = Date.now()): string {
	const target = tool.summary ? ` · ${tool.summary}` : "";
	return `${isError ? "✗" : "✓"} ${tool.name}${target} · ${isError ? "failed · " : ""}${duration(finishedAt - tool.startedAt)}`;
}

export default function toolActivityExtension(pi: ExtensionAPI) {
	const active = new Map<string, ActiveTool>();
	let ticker: NodeJS.Timeout | undefined;
	let terminalClear: NodeJS.Timeout | undefined;
	let latestContext: ExtensionContext | undefined;

	const refresh = () => {
		if (!latestContext?.hasUI) return;
		latestContext.ui.setStatus(STATUS_KEY, formatToolActivity([...active.values()]));
	};

	const stopTickerIfIdle = () => {
		if (active.size > 0 || !ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	const ensureTicker = () => {
		if (ticker) return;
		ticker = setInterval(refresh, 500);
		ticker.unref();
	};

	pi.on("tool_execution_start", (event, ctx) => {
		latestContext = ctx;
		if (terminalClear) {
			clearTimeout(terminalClear);
			terminalClear = undefined;
		}
		active.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			summary: summarizeToolCall(event.toolName, event.args),
			startedAt: Date.now(),
		});
		refresh();
		ensureTicker();
	});

	pi.on("tool_execution_update", (_event, ctx) => {
		latestContext = ctx;
		refresh();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		latestContext = ctx;
		const finished = active.get(event.toolCallId) ?? {
			id: event.toolCallId,
			name: event.toolName,
			summary: "",
			startedAt: Date.now(),
		};
		active.delete(event.toolCallId);
		stopTickerIfIdle();

		if (active.size > 0) {
			refresh();
			return;
		}
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, formatToolTerminal(finished, event.isError));
		terminalClear = setTimeout(() => {
			if (active.size === 0 && latestContext?.hasUI) latestContext.ui.setStatus(STATUS_KEY, undefined);
			terminalClear = undefined;
		}, TERMINAL_HOLD_MS);
		terminalClear.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ticker) clearInterval(ticker);
		if (terminalClear) clearTimeout(terminalClear);
		ticker = undefined;
		terminalClear = undefined;
		active.clear();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		latestContext = undefined;
	});
}
