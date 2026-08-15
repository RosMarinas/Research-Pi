import { createHash } from "node:crypto";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";

const FLAG_NAME = "v4-pro-anchor";
const VARIANT_FLAG_NAME = "v4-pro-anchor-variant";
const ENTRY_KIND = "deepseek-v4-pro-anchor";
const STATUS_KEY = "v4-pro-anchor";
const TARGET_PROVIDER = "deepseek";
const TARGET_MODEL = "deepseek-v4-pro";
const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";
const BOOTSTRAP_TOOLS = ["bash", "read"] as const;
const BOOTSTRAP_MAX_TOKENS = 1024;
const REFERENCE_PROBE_PROMPT =
	"Inspect the current repository before answering. First determine its top-level structure, then locate and read the project README. " +
	"Do not guess from prior knowledge. Use the available tools first.";

const REFERENCE_BOOTSTRAP_TOOLS = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run a command in a persistent shell.",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a text file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
] as const;

type AnchorVariant = "exact" | "research";

type AnchorPhase = "off" | "bootstrap" | "promoted";

interface AnchorState {
	version: 1;
	phase: AnchorPhase;
	variant?: AnchorVariant;
	at: string;
	reason: string;
}

interface PayloadMessage {
	role?: string;
	content?: unknown;
	[key: string]: unknown;
}

interface ProviderPayload {
	model?: string;
	messages?: PayloadMessage[];
	tools?: Array<{ function?: { name?: string }; name?: string; [key: string]: unknown }>;
	max_tokens?: number;
	max_completion_tokens?: number;
	thinking?: { type?: string; [key: string]: unknown };
	reasoning_effort?: string;
	[key: string]: unknown;
}

interface WireAudit {
	phase: Exclude<AnchorPhase, "off">;
	toolNames: string[];
	maxTokens?: number;
	minimalSystem: boolean;
	researchContext: boolean;
	reasoningMax: boolean;
	toolSchemaHash: string;
	trajectory?: "minimal-like" | "standard-like" | "ambiguous";
}

function toolName(tool: NonNullable<ProviderPayload["tools"]>[number]): string | undefined {
	return tool.function?.name ?? tool.name;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 10);
}

const REFERENCE_TOOL_SCHEMA_HASH = digest(REFERENCE_BOOTSTRAP_TOOLS);

export function classifyTrajectory(reasoning: string): "minimal-like" | "standard-like" | "ambiguous" {
	const firstLine = reasoning.trim().split(/\r?\n/, 1)[0] ?? "";
	const we = (reasoning.match(/\bwe\b/gi) ?? []).length;
	const letMe = (reasoning.match(/\blet me\b/gi) ?? []).length;
	if (/^we need\b/i.test(firstLine) || (we > 0 && letMe === 0)) return "minimal-like";
	if (letMe > 0 || /^the user (wants|asks|is asking)\b/i.test(firstLine)) return "standard-like";
	return "ambiguous";
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function formatSkillCatalog(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"The following skills provide specialized instructions for matching tasks.",
		"Use read to load the corresponding SKILL.md only when its description matches.",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function buildPromotedHarnessContext(options: BuildSystemPromptOptions, variant: AnchorVariant): string {
	const sections: string[] = [];
	if (variant === "research" && options.appendSystemPrompt?.trim()) {
		sections.push(`<research_operating_contract>\n${options.appendSystemPrompt.trim()}\n</research_operating_contract>`);
	}
	if (options.contextFiles?.length) {
		const files = options.contextFiles.map(({ path, content }) =>
			`<project_instructions path="${escapeXml(path)}">\n${content}\n</project_instructions>`);
		sections.push(`<project_context>\n${files.join("\n\n")}\n</project_context>`);
	}
	const skillCatalog = formatSkillCatalog(options.skills ?? []);
	if (skillCatalog) sections.push(skillCatalog);
	return sections.join("\n\n");
}

function researchContextMessage(context: string): PayloadMessage {
	return {
		role: "user",
		content:
			"<anchored_harness_context>\n" +
			"The following project context becomes available after the V4 Pro bootstrap request.\n\n" +
			context +
			"\n</anchored_harness_context>",
	};
}

/** Pure payload transform exported for the small wire-contract test. */
export function rewriteDeepSeekV4ProPayload(payload: unknown, phase: "bootstrap" | "promoted", promotedContext = ""): ProviderPayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload as ProviderPayload;
	const source = payload as ProviderPayload;
	const messages = Array.isArray(source.messages) ? source.messages : [];
	const conversation = messages.filter((message) => message?.role !== "system");
	const minimalSystem: PayloadMessage = { role: "system", content: MINIMAL_SYSTEM_PROMPT };
	const rewritten: ProviderPayload = {
		...source,
		thinking: { ...(source.thinking ?? {}), type: "enabled" },
		reasoning_effort: "max",
	};

	delete rewritten.max_completion_tokens;
	if (phase === "bootstrap") {
		const lastUser = [...conversation].reverse().find((message) => message?.role === "user");
		rewritten.messages = lastUser ? [minimalSystem, lastUser] : [minimalSystem];
		rewritten.tools = structuredClone(REFERENCE_BOOTSTRAP_TOOLS) as unknown as ProviderPayload["tools"];
		rewritten.max_tokens = BOOTSTRAP_MAX_TOKENS;
		return rewritten;
	}

	rewritten.messages = promotedContext
		? [minimalSystem, researchContextMessage(promotedContext), ...conversation]
		: [minimalSystem, ...conversation];
	if (typeof source.max_tokens === "number") rewritten.max_tokens = source.max_tokens;
	else if (typeof source.max_completion_tokens === "number") rewritten.max_tokens = source.max_completion_tokens;
	return rewritten;
}

function restoreState(ctx: ExtensionContext): AnchorState | undefined {
	let latest: AnchorState | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_KIND) continue;
		const data = entry.data as Partial<AnchorState> | undefined;
		if (data?.version === 1 && ["off", "bootstrap", "promoted"].includes(String(data.phase))) latest = data as AnchorState;
	}
	return latest;
}

function isFreshSession(ctx: ExtensionContext): boolean {
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant");
}

function isTarget(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === TARGET_PROVIDER && ctx.model.id === TARGET_MODEL;
}

function formatStatus(phase: AnchorPhase, variant: AnchorVariant, audit?: WireAudit): string | undefined {
	if (phase === "off") return undefined;
	if (!audit) return phase === "bootstrap" ? `V4 Pro anchor · ${variant} · bootstrap pending` : `V4 Pro anchor · ${variant} · promoted`;
	const tools = audit.toolNames.length > 0 ? audit.toolNames.join("/") : "0 tools";
	const context = audit.researchContext ? "research ctx" : "clean ctx";
	const bootstrapShape = audit.phase !== "bootstrap" ||
		(audit.toolNames.length === BOOTSTRAP_TOOLS.length && BOOTSTRAP_TOOLS.every((name) => audit.toolNames.includes(name)) &&
			audit.maxTokens === BOOTSTRAP_MAX_TOKENS && audit.toolSchemaHash === REFERENCE_TOOL_SCHEMA_HASH);
	const wireOk = audit.minimalSystem && audit.reasoningMax && bootstrapShape;
	const label = phase === "promoted" && audit.phase === "bootstrap" ? "promoted · first" : audit.phase;
	const trajectory = audit.trajectory ? ` · trajectory:${audit.trajectory}` : "";
	return `V4 Pro anchor · ${variant} · ${label} · ${tools} · ${audit.maxTokens ?? "default"} · schema:${audit.toolSchemaHash} · ${context} · shape ${wireOk ? "✓" : "✗"}${trajectory}`;
}

export default function (pi: ExtensionAPI) {
	let phase: AnchorPhase = "off";
	let variant: AnchorVariant = "exact";
	let fullTools: string[] = [];
	let promotedContext = "";
	let latestContext: ExtensionContext | undefined;
	let latestAudit: WireAudit | undefined;
	let bootstrapNoticeShown = false;
	let probeOnly = false;

	pi.registerFlag(FLAG_NAME, {
		description: "Opt in to the visible DeepSeek V4 Pro anchored first-request experiment",
		type: "boolean",
		default: false,
	});
	pi.registerFlag(VARIANT_FLAG_NAME, {
		description: "V4 Pro anchor promotion context: exact (project/skills only) or research (also Research Pi contract)",
		type: "string",
		default: "exact",
	});

	const parseVariant = (value: unknown): AnchorVariant | undefined => value === "exact" || value === "research" ? value : undefined;

	const updateStatus = (ctx: ExtensionContext) => {
		latestContext = ctx;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatStatus(phase, variant, latestAudit));
	};

	const persist = (nextPhase: AnchorPhase, reason: string) => {
		phase = nextPhase;
		pi.appendEntry<AnchorState>(ENTRY_KIND, { version: 1, phase, variant, reason, at: new Date().toISOString() });
	};

	const arm = (ctx: ExtensionContext, reason: string, requestedVariant: AnchorVariant): boolean => {
		if (!isTarget(ctx)) {
			ctx.ui.notify(`V4 Pro anchor requires ${TARGET_PROVIDER}/${TARGET_MODEL}.`, "warning");
			return false;
		}
		if (ctx.thinkingLevel !== "max") {
			ctx.ui.notify("V4 Pro anchor requires thinking level max.", "warning");
			return false;
		}
		if (!isFreshSession(ctx)) {
			ctx.ui.notify("Anchor request must be the first model request. Start /new, then arm it before sending a prompt.", "warning");
			return false;
		}
		fullTools = pi.getActiveTools();
		const missing = BOOTSTRAP_TOOLS.filter((name) => !fullTools.includes(name));
		if (missing.length > 0) {
			ctx.ui.notify(`V4 Pro anchor unavailable; missing bootstrap tools: ${missing.join(", ")}.`, "error");
			return false;
		}
		// Keep Pi's runtime tool registry intact. Only the provider payload is narrowed
		// during bootstrap so the same agent loop can expose every tool after promotion.
		variant = requestedVariant;
		latestAudit = undefined;
		bootstrapNoticeShown = false;
		persist("bootstrap", reason);
		updateStatus(ctx);
		return true;
	};

	const promote = (ctx: ExtensionContext, reason: string) => {
		if (phase !== "bootstrap") return;
		persist("promoted", reason);
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify(`V4 Pro anchor promoted: exposing ${fullTools.length} tools and Research Pi context.`, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		fullTools = pi.getActiveTools();
		const restored = restoreState(ctx);
		phase = restored?.phase ?? "off";
		variant = restored?.variant ?? "exact";
		if (!restored && pi.getFlag(FLAG_NAME) === true) {
			const requestedVariant = parseVariant(pi.getFlag(VARIANT_FLAG_NAME));
			if (!requestedVariant) ctx.ui.notify("--v4-pro-anchor-variant must be exact or research.", "error");
			else arm(ctx, "cli-flag", requestedVariant);
		}
		else updateStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		promotedContext = buildPromotedHarnessContext(event.systemPromptOptions, variant);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (phase === "off" || !isTarget(ctx)) return undefined;
		const activePhase = phase;
		const rewritten = rewriteDeepSeekV4ProPayload(event.payload, activePhase, promotedContext);
		const tools = Array.isArray(rewritten.tools) ? rewritten.tools.map(toolName).filter((name): name is string => Boolean(name)) : [];
		const messages = Array.isArray(rewritten.messages) ? rewritten.messages : [];
		latestAudit = {
			phase: activePhase,
			toolNames: tools,
			maxTokens: rewritten.max_tokens,
			minimalSystem: messages[0]?.role === "system" && messages[0]?.content === MINIMAL_SYSTEM_PROMPT,
			researchContext: messages.some((message) => typeof message.content === "string" && message.content.startsWith("<anchored_harness_context>")),
			reasoningMax: rewritten.thinking?.type === "enabled" && rewritten.reasoning_effort === "max",
			toolSchemaHash: digest(rewritten.tools ?? []),
		};
		updateStatus(ctx);
		if (activePhase === "bootstrap" && !bootstrapNoticeShown && ctx.hasUI) {
			bootstrapNoticeShown = true;
			ctx.ui.notify("V4 Pro anchor sent: exact Minimal system · bash/read · max_tokens 1024 · reasoning max.", "info");
		}
		return rewritten;
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || phase !== "bootstrap") return;
		const { usage, stopReason } = event.message;
		const reasoning = event.message.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("\n");
		const trajectory = classifyTrajectory(reasoning);
		if (latestAudit) latestAudit.trajectory = trajectory;
		const cacheRatio = usage.input > 0 ? Math.round((usage.cacheRead / usage.input) * 100) : 0;
		if (ctx.hasUI) ctx.ui.notify(`V4 Pro anchor result: trajectory=${trajectory} · stop=${stopReason} · input=${usage.input} · output=${usage.output} · cache=${cacheRatio}% (fingerprint, not ability evidence).`, "info");
		promote(ctx, "first-assistant-message");
	});

	pi.on("tool_call", (_event, ctx) => {
		promote(ctx, "first-tool-call");
		if (probeOnly) {
			probeOnly = false;
			return { block: true, terminate: true, reason: "V4 Pro anchor probe stops after the first tool call; no command was executed." };
		}
		return undefined;
	});

	pi.on("agent_settled", () => {
		probeOnly = false;
	});

	pi.on("model_select", (event, ctx) => {
		if (phase !== "off" && (event.model.provider !== TARGET_PROVIDER || event.model.id !== TARGET_MODEL)) {
			persist("off", "model-changed");
			latestAudit = undefined;
		}
		updateStatus(ctx);
	});

	pi.registerCommand("v4pro-anchor", {
		description: "Inspect or control the DeepSeek V4 Pro anchored-request experiment (status|probe|arm|off)",
		handler: async (args, ctx) => {
			const [action = "status", variantArg] = args.trim().toLowerCase().split(/\s+/);
			if (action === "probe") {
				if (phase !== "off") {
					ctx.ui.notify(`V4 Pro anchor is already ${phase}; use /new for a clean probe.`, "warning");
					return;
				}
				if (!arm(ctx, "probe", "exact")) return;
				probeOnly = true;
				pi.sendUserMessage(REFERENCE_PROBE_PROMPT);
				return;
			}
			if (action === "arm") {
				const requestedVariant = parseVariant(variantArg ?? "exact");
				if (!requestedVariant) {
					ctx.ui.notify("Usage: /v4pro-anchor arm [exact|research]", "warning");
					return;
				}
				if (phase !== "off") ctx.ui.notify(`V4 Pro anchor is already ${phase}.`, "info");
				else if (arm(ctx, "command", requestedVariant)) ctx.ui.notify(`V4 Pro anchor (${requestedVariant}) armed for the next prompt.`, "info");
				return;
			}
			if (action === "off") {
				persist("off", "command");
				latestAudit = undefined;
				updateStatus(ctx);
				ctx.ui.notify("V4 Pro anchor disabled; normal Research Pi prompt and tools restored.", "info");
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /v4pro-anchor [status|probe|arm [exact|research]|off]", "warning");
				return;
			}
			ctx.ui.notify(formatStatus(phase, variant, latestAudit) ?? "V4 Pro anchor · off", "info");
		},
	});

	pi.on("session_shutdown", () => {
		if (latestContext?.hasUI) latestContext.ui.setStatus(STATUS_KEY, undefined);
	});
}
