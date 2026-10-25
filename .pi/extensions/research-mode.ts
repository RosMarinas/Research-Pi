import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mapProviderSystemPrompt } from "../lib/provider-system-prompt.mjs";
import { researchPiStateRoot } from "../lib/runtime-paths.mjs";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_ROOT = researchPiStateRoot(HARNESS_ROOT);
const MAX_CODEMODE_CONTEXT_CHARS = 8_000;
const PARTIAL_CORE_TOOLS = new Set(["bash", "powershell", "read", "grep", "find", "ls"]);

const NATIVE_IDENTITY =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const RESEARCH_IDENTITY =
	"You are a computational research agent operating inside Pi. Use code, experiments and discussion to answer research questions.";

function codemodeText(event: any): string {
	return (event?.content ?? [])
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item.text ?? ""))
		.join("\n");
}

export function codemodeOutputNeedsArtifact(event: any, maxChars = MAX_CODEMODE_CONTEXT_CHARS): boolean {
	return Boolean(event?.details?.fullOutputPath) || codemodeText(event).length > maxChars;
}

export function codemodeOutputReceipt(event: any, artifactPath: string, artifactBytes: number): string {
	const calls = Array.isArray(event?.details?.calls) ? event.details.calls : [];
	const states = new Map<string, number>();
	for (const call of calls) states.set(String(call?.status ?? "unknown"), (states.get(String(call?.status ?? "unknown")) ?? 0) + 1);
	const stateText = [...states].map(([state, count]) => `${state}=${count}`).join(", ");
	return [
		"CODEMODE RESULT",
		`Call: ${event?.toolCallId ?? "unknown"}.`,
		`State: ${event?.isError ? "failed" : "completed"}.`,
		`Nested calls: ${calls.length}${stateText ? ` (${stateText})` : ""}.`,
		`Output: not inserted into model context. The complete output is ${artifactBytes.toLocaleString()} bytes.`,
		`Reference: ${artifactPath}.`,
		"Reason: The script output did not satisfy the compact result contract.",
		"If missing output affects the current judgment, read the needed section from the existing artifact. Truncation alone is not a reason to rerun operations; rerunning needs a separate task-specific reason.",
	].join("\n");
}

export function partialToolResultNeedsReceipt(event: any): boolean {
	if (!PARTIAL_CORE_TOOLS.has(String(event?.toolName ?? ""))) return false;
	const details = event?.details ?? {};
	return Boolean(
		details?.truncation?.truncated
		|| details?.fullOutputPath
		|| details?.matchLimitReached
		|| details?.resultLimitReached
		|| details?.entryLimitReached
		|| details?.linesTruncated,
	);
}

function partialToolTarget(event: any): string | null {
	const input = event?.input ?? {};
	if (event?.toolName === "read") return input.path ? `Target: ${input.path}.` : null;
	if (event?.toolName === "grep") return `Target: ${input.path ?? "."}. Pattern: ${input.pattern ?? "unknown"}.`;
	if (event?.toolName === "find") return `Target: ${input.path ?? "."}. Pattern: ${input.pattern ?? "unknown"}.`;
	if (event?.toolName === "ls") return `Target: ${input.path ?? "."}.`;
	return null;
}

export function partialToolResultReceipt(event: any, artifactPath?: string): string {
	const truncation = event?.details?.truncation ?? {};
	const reportedSize = [
		Number.isFinite(truncation.totalLines) ? `${truncation.totalLines} lines` : null,
		Number.isFinite(truncation.totalBytes) ? `${truncation.totalBytes.toLocaleString()} bytes` : null,
	].filter(Boolean).join(", ");
	return [
		"PARTIAL TOOL RESULT",
		`Call: ${event?.toolCallId ?? "unknown"}.`,
		`Tool: ${event?.toolName ?? "unknown"}.`,
		`State: ${event?.isError ? "error" : "completed"}.`,
		partialToolTarget(event),
		reportedSize ? `Reported size: ${reportedSize}.` : undefined,
		"Output: not inserted into model context because the tool reported a partial result.",
		artifactPath ? `Reference: ${artifactPath}.` : undefined,
		"Evidence rule: Do not treat a partial prefix, tail, or result set as complete evidence.",
		event?.toolName === "bash" || event?.toolName === "powershell"
			? "If missing output affects the judgment, read the needed section from the existing artifact. Rerun only with a separate reason; do not repeat an experiment because output was truncated."
			: "If missing output affects the judgment, narrow the query or read only the necessary range. Do not reconstruct all output merely for completeness.",
	].filter(Boolean).join("\n");
}

async function persistContextArtifact(event: any, ctx: any, prefix: string, sourcePath: string | null, text: string) {
	const sessionId = String(ctx.sessionManager.getSessionId());
	const callKey = createHash("sha256").update(String(event.toolCallId)).digest("hex").slice(0, 20);
	const artifactDir = join(STATE_ROOT, "context-artifacts", sessionId);
	const artifactPath = join(artifactDir, `${prefix}-${callKey}.txt`);
	await mkdir(artifactDir, { recursive: true, mode: 0o700 });
	if (sourcePath) {
		await copyFile(sourcePath, artifactPath);
		await chmod(artifactPath, 0o600);
	} else {
		await writeFile(artifactPath, text, { encoding: "utf8", mode: 0o600 });
	}
	return { path: artifactPath, bytes: (await stat(artifactPath)).size };
}

export function applyResearchIdentity(systemPrompt: string): string {
	if (!systemPrompt.startsWith(NATIVE_IDENTITY)) return systemPrompt;
	return `${RESEARCH_IDENTITY}${systemPrompt.slice(NATIVE_IDENTITY.length)}`;
}

export default function (pi: ExtensionAPI) {
	// An earlier extension (e.g. full-access boundary messaging) may force a
	// complete prompt, which Core applies after context hooks. Normalize it too.
	pi.on("before_agent_start", (event) => {
		const forced = event.systemPromptOptions.forceSystemPrompt;
		if (typeof forced === "string") event.systemPromptOptions.forceSystemPrompt = applyResearchIdentity(forced);
	});
	// Pi 1.0 exposes the full transcript before provider serialization. This
	// also covers mailbox wakes and preserves mid-conversation prompt sections
	// and tool changes, without patching each provider's HTTP payload.
	pi.on("context_with_system", (event) => ({
		messages: mapProviderSystemPrompt({ messages: event.messages }, applyResearchIdentity).messages.map((message: any) => {
			if (message.role !== "system" || !message.sections) return message;
			return { ...message, sections: Object.fromEntries(Object.entries(message.sections).map(([name, value]) =>
				[name, typeof value === "string" ? applyResearchIdentity(value) : value])) };
		}),
	}));
	pi.on("tool_result", async (event, ctx) => {
		if (event.parentToolCallId) return;
		if (event.toolName === "codemode" && codemodeOutputNeedsArtifact(event)) {
			const sourcePath = typeof (event.details as any)?.fullOutputPath === "string"
			? (event.details as any).fullOutputPath
			: null;
			const artifact = await persistContextArtifact(event, ctx, "codemode", sourcePath, codemodeText(event));
			return {
				content: [
					{ type: "text", text: codemodeOutputReceipt(event, artifact.path, artifact.bytes) },
					...event.content.filter((item: any) => item.type === "image"),
				],
				details: { ...((event.details as any) ?? {}), contextArtifactPath: artifact.path, modelOutputOmitted: true },
			};
		}
		if (!partialToolResultNeedsReceipt(event)) return;
		const sourcePath = typeof (event.details as any)?.fullOutputPath === "string"
			? (event.details as any).fullOutputPath
			: null;
		const artifact = sourcePath
			? await persistContextArtifact(event, ctx, String(event.toolName), sourcePath, "")
			: null;
		return {
			content: [{ type: "text", text: partialToolResultReceipt(event, artifact?.path) }],
			details: {
				...((event.details as any) ?? {}),
				...(artifact ? { contextArtifactPath: artifact.path } : {}),
				modelOutputOmitted: true,
			},
		};
	});
}
