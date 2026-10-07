import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildSessionProjection,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	buildResearchCompactionDetails,
	buildResearchCompactionPrompt,
	collectResearchEvidence,
	mergeProjectRuntimeEvidence,
	normalizeResearchState,
	parseResearchCompactionResponse,
	RESEARCH_HARD_COMPACT_TOKENS,
	RESEARCH_COMPACTION_SYSTEM_PROMPT,
	RESEARCH_SUMMARY_MAX_TOKENS,
	renderResearchSummary,
	RESEARCH_COMPACTION_KIND,
	RESEARCH_COMPACTION_VERSION,
	RESEARCH_SOFT_COMPACT_TOKENS,
	RESEARCH_STATE_TOOL,
	selectResearchCompactionPolicy,
} from "../lib/research-compact.mjs";
import { readRuntimeSnapshot, resolveResearchRuntime, runtimeSessionInheritancePolicy } from "../lib/research-runtime.mjs";
import { defaultResearchPiConfig, readResearchPiConfig } from "../lib/research-config.mjs";
import { resolveResearchPiPaths } from "../lib/runtime-paths.mjs";

import { reserveRuntimeCompaction } from "../lib/runtime-compaction-gate.mjs";

const defaultCompaction = { ...defaultResearchPiConfig().research.compaction, softTokens: RESEARCH_SOFT_COMPACT_TOKENS, hardTokens: RESEARCH_HARD_COMPACT_TOKENS };

function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		read: [...fileOps.read].filter((path) => !modified.has(path)),
		modified: [...modified],
	};
}


export function researchCompactionThresholds(model?: { contextWindow?: number; id?: string; provider?: string } | null, config = defaultCompaction) {
	const override = ["openai", "openai-codex"].includes(model?.provider ?? "") && config.modelOverrides?.[model?.id ?? ""];
	const soft = override?.softTokens ?? config.softTokens;
	const hard = override?.hardTokens ?? config.hardTokens;
	const contextWindow = Number(model?.contextWindow);
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return { softTokens: soft, hardTokens: hard };
	}
	const reserved = Math.max(32 * 1024, Math.floor(contextWindow * 0.1));
	const modelSafeHard = Math.max(64 * 1024, contextWindow - reserved);
	const hardTokens = Math.min(hard, modelSafeHard);
	// Scale the configured ratio only for smaller models. A fixed 75% cap would
	// silently turn the requested 360k/384k thresholds into 288k/384k.
	const softTokens = Math.min(soft, Math.floor(hardTokens * soft / hard));
	return { softTokens, hardTokens };
}

export default function (pi: ExtensionAPI) {
	const compactConfig = process.env.RESEARCH_PI_HARNESS_ROOT
		? readResearchPiConfig(resolveResearchPiPaths({ harnessRoot: process.env.RESEARCH_PI_HARNESS_ROOT }).configPath).research.compaction
		: defaultCompaction;
	let compactionRunning = false;
	let releaseCompaction: (() => void) | undefined;
	let compactTimer: ReturnType<typeof setTimeout> | undefined;
	let scheduledCompaction: { trigger: "soft" | "hard"; tokens: number } | undefined;

	pi.on("session_start", () => {
		if (compactTimer) clearTimeout(compactTimer);
		compactTimer = undefined;
		releaseCompaction?.();
		releaseCompaction = undefined;
		compactionRunning = false;
		scheduledCompaction = undefined;
	});

	pi.on("session_compact", () => {
		// Native Pi emits this before it clears its compaction state.
		// Release the automatic reservation only from onComplete/onError.
		scheduledCompaction = undefined;
	});

	pi.on("session_shutdown", () => {
		if (compactTimer) clearTimeout(compactTimer);
		compactTimer = undefined;
		releaseCompaction?.();
		releaseCompaction = undefined;
		compactionRunning = false;
		scheduledCompaction = undefined;
	});

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const thresholds = researchCompactionThresholds(ctx.model, compactConfig);
		if (!usage || usage.tokens === null || usage.tokens < thresholds.softTokens || compactionRunning) return;

		const trigger = usage.tokens >= thresholds.hardTokens ? "hard" : "soft";
		if (scheduledCompaction && (scheduledCompaction.trigger === "hard" || trigger === "soft")) return;
		scheduledCompaction = { trigger, tokens: usage.tokens };
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Research ${trigger} compaction scheduled after the current run settles: ${usage.tokens.toLocaleString()} context tokens.`,
				trigger === "hard" ? "warning" : "info",
			);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		const scheduled = scheduledCompaction;
		if (!scheduled || compactionRunning) return;
		compactionRunning = true;
		releaseCompaction = reserveRuntimeCompaction(ctx);
		// Leave agent_settled before invoking the native manual interface. Other
		// extensions may already have queued a continuation at this boundary.
		compactTimer = setTimeout(() => {
			compactTimer = undefined;
			const release = releaseCompaction;
			const finish = () => {
				release?.();
				if (releaseCompaction === release) {
					releaseCompaction = undefined;
					compactionRunning = false;
				}
			};
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				// Keep the request for the next settle; never abort a new run.
				finish();
				return;
			}
			scheduledCompaction = undefined;
			ctx.compact({
				customInstructions: `Automatic research ${scheduled.trigger} compaction at ${scheduled.tokens} context tokens.`,
				onComplete: finish,
				onError: (error) => {
					finish();
					if (ctx.hasUI) ctx.ui.notify(`Research compaction failed: ${error.message}`, "warning");
				},
			});
		}, 0);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.model) {
			ctx.ui.notify("Research compaction could not resolve the active model; falling back to Pi compaction.", "warning");
			return;
		}

		const { branchEntries, customInstructions, reason, signal } = event;
		const runtimeSnapshot = await readRuntimeSnapshot(await resolveResearchRuntime(ctx.cwd));
		const inheritancePolicy = runtimeSessionInheritancePolicy(branchEntries, runtimeSnapshot, ctx.sessionManager.getSessionId());
		const projectRevision = runtimeSnapshot.revision;
		// Pi 1.0 prepares the canonical projection, including context edits,
		// prior compaction boundaries, and nested tool file operations. Re-slicing
		// raw entries here would reintroduce omitted/replaced messages.
		const preparation = event.preparation;
		const policy = selectResearchCompactionPolicy(branchEntries, preparation.settings.keepRecentTokens);
		const thresholds = researchCompactionThresholds(ctx.model, compactConfig);
		policy.softTriggerTokens = thresholds.softTokens;
		policy.hardTriggerTokens = thresholds.hardTokens;
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionEvidence = collectResearchEvidence(branchEntries, sessionId, preparation.firstKeptEntryId, {
			inheritancePolicy,
			projectedEntries: buildSessionProjection(branchEntries).entries,
		});
		const evidence = inheritancePolicy === "clean"
			? sessionEvidence
			: mergeProjectRuntimeEvidence(sessionEvidence, runtimeSnapshot);
		const latestResearchCompaction = [...branchEntries].reverse().find((entry) =>
			entry.type === "compaction"
			&& entry.details?.kind === RESEARCH_COMPACTION_KIND
			&& entry.details?.version === RESEARCH_COMPACTION_VERSION,
		);
		const independentSessionSummary = inheritancePolicy === "project"
			&& latestResearchCompaction?.type === "compaction"
			&& ["clean", "analysis"].includes(latestResearchCompaction.details?.inheritancePolicy)
				? preparation.previousSummary
				: undefined;
		const conversationText = serializeConversation(
			convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
		);
		const prompt = buildResearchCompactionPrompt({
			conversationText,
			previousState: evidence.previousState,
			legacyPreviousSummary: evidence.previousState ? undefined : preparation.previousSummary,
			independentSessionSummary,
			experiments: evidence.experiments,
			checkpoints: evidence.checkpoints,
			sourceCatalog: evidence.sourceCatalog,
			projectTransitions: inheritancePolicy === "clean" ? [] : runtimeSnapshot.transitions?.slice(-4) ?? [],
			customInstructions,
		});

		ctx.ui.notify(
			`Research compaction #${policy.ordinal}${inheritancePolicy === "clean" ? " (clean Session, no Project inheritance)" : inheritancePolicy === "analysis" ? " (Analysis Session, Project read-only)" : ""}: ${preparation.tokensBefore.toLocaleString()} tokens, keeping ~${policy.keepRecentTokens.toLocaleString()} recent tokens, ${evidence.experiments.length} experiment record(s).`,
			"info",
		);

		try {
			const requestState = async (requestPrompt: string) => await ctx.modelRegistry.complete(
				ctx.model,
					{
						systemPrompt: RESEARCH_COMPACTION_SYSTEM_PROMPT,
						messages: [
						{
							role: "user",
							content: [{ type: "text", text: requestPrompt }],
							timestamp: Date.now(),
						},
					],
					tools: [RESEARCH_STATE_TOOL],
				},
				{
					maxTokens: Math.min(RESEARCH_SUMMARY_MAX_TOKENS, ctx.model.maxTokens || RESEARCH_SUMMARY_MAX_TOKENS),
					toolChoice: ctx.model.api === "openai-completions"
						? { type: "function", function: { name: RESEARCH_STATE_TOOL.name } }
						: undefined,
					signal,
						cacheRetention: "short",
					sessionId: randomUUID(),
				},
			);
			let response = await requestState(prompt);
			let parsed;
			try {
				parsed = parseResearchCompactionResponse(response.content);
			} catch (firstError) {
				if (response.stopReason !== "length") {
					throw new Error(`${firstError instanceof Error ? firstError.message : String(firstError)} (stopReason=${response.stopReason})`);
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Research compaction output reached its ${RESEARCH_SUMMARY_MAX_TOKENS.toLocaleString()}-token cap; retrying once with a minimal-state instruction.`,
						"warning",
					);
				}
				response = await requestState(
					`${prompt}\n\nRECOVERY: The previous structured response was truncated. Return a minimal state well below the target budget. Keep only decision-relevant hypotheses, observations, provenance, and the next discriminating experiment; do not elaborate.`,
				);
				try {
					parsed = parseResearchCompactionResponse(response.content);
				} catch (retryError) {
					throw new Error(`${retryError instanceof Error ? retryError.message : String(retryError)} (stopReason=${response.stopReason}, after one bounded retry)`);
				}
			}
			const normalized = normalizeResearchState(parsed.state, evidence);
			const validationWarnings = [
				...parsed.repairs.map((repair) => `Conservatively repaired compaction JSON syntax: ${repair}.`),
				...normalized.warnings,
			];
			const files = fileLists(preparation.fileOps);
			const summary = renderResearchSummary(normalized.state, evidence, files);
			const details = buildResearchCompactionDetails({
				state: normalized.state,
				evidence,
				warnings: validationWarnings,
				sessionId,
				reason,
				tokensBefore: preparation.tokensBefore,
				fileOps: files,
				policy,
				projectRevision,
				inheritancePolicy,
			});

			if (validationWarnings.length) {
				ctx.ui.notify(
					`Research compaction retained the summary with ${validationWarnings.length} validation warning(s).`,
					"warning",
				);
			}
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: response.usage,
					details,
				},
			};
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(
					`Research compaction failed validation; falling back to Pi compaction: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			return;
		}
	});

	pi.registerCommand("research-state", {
		description: "Inspect the latest structured research compaction state",
		handler: async (_args, ctx) => {
			const latest = [...ctx.sessionManager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "compaction" &&
						entry.details?.kind === RESEARCH_COMPACTION_KIND &&
						entry.details?.version === RESEARCH_COMPACTION_VERSION,
				);
			if (!latest || latest.type !== "compaction") {
				ctx.ui.notify("This session has no structured research compaction yet.", "info");
				return;
			}
			const state = latest.details.researchState;
			const hypotheses = Array.isArray(state?.hypotheses)
				? state.hypotheses.map((item: { id?: string; status?: string; statement?: string }) => `${item.id} [${item.status}] ${item.statement}`).join("\n")
				: "No hypotheses recorded.";
			ctx.ui.notify(
				`Question: ${state?.researchQuestion || "unknown"}\nClaim: ${state?.currentClaim || "unknown"}\n${hypotheses}`,
				"info",
			);
		},
	});
}
