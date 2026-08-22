import { randomUUID } from "node:crypto";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	buildResearchCompactionDetails,
	buildResearchCompactionPrompt,
	collectResearchEvidence,
	mergeProjectRuntimeEvidence,
	normalizeResearchState,
	parseResearchCompactionResponse,
	RESEARCH_HARD_COMPACT_TOKENS,
	renderResearchSummary,
	RESEARCH_COMPACTION_KIND,
	RESEARCH_COMPACTION_VERSION,
	RESEARCH_SOFT_COMPACT_TOKENS,
	RESEARCH_STATE_TOOL,
	selectResearchCompactionPolicy,
} from "../lib/research-compact.mjs";
import { readRuntimeSnapshot, resolveResearchRuntime, runtimeSessionInheritancePolicy } from "../lib/research-runtime.mjs";

function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		read: [...fileOps.read].filter((path) => !modified.has(path)),
		modified: [...modified],
	};
}

function prepareWithDynamicTail(event: SessionBeforeCompactEvent, keepRecentTokens: number) {
	const { branchEntries, preparation } = event;
	let previousCompactionIndex = -1;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		if (branchEntries[index].type === "compaction") {
			previousCompactionIndex = index;
			break;
		}
	}

	let boundaryStart = 0;
	if (previousCompactionIndex >= 0) {
		const previousCompaction = branchEntries[previousCompactionIndex];
		if (previousCompaction.type === "compaction") {
			const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId);
			boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : previousCompactionIndex + 1;
		}
	}

	const cutPoint = findCutPoint(branchEntries, boundaryStart, branchEntries.length, keepRecentTokens);
	const firstKeptEntry = branchEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) return preparation;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize = [];
	for (let index = boundaryStart; index < historyEnd; index += 1) {
		const entry = branchEntries[index];
		if (entry.type === "compaction") continue;
		const message = sessionEntryToContextMessages(entry)[0];
		if (message) messagesToSummarize.push(message);
	}

	const turnPrefixMessages = [];
	if (cutPoint.isSplitTurn) {
		for (let index = cutPoint.turnStartIndex; index < cutPoint.firstKeptEntryIndex; index += 1) {
			const entry = branchEntries[index];
			if (entry.type === "compaction") continue;
			const message = sessionEntryToContextMessages(entry)[0];
			if (message) turnPrefixMessages.push(message);
		}
	}

	if (!messagesToSummarize.length && !turnPrefixMessages.length) return preparation;
	return {
		...preparation,
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		settings: { ...preparation.settings, keepRecentTokens },
	};
}

export function researchCompactionThresholds(model?: { contextWindow?: number } | null) {
	const contextWindow = Number(model?.contextWindow);
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return { softTokens: RESEARCH_SOFT_COMPACT_TOKENS, hardTokens: RESEARCH_HARD_COMPACT_TOKENS };
	}
	const reserved = Math.max(32 * 1024, Math.floor(contextWindow * 0.1));
	const modelSafeHard = Math.max(64 * 1024, contextWindow - reserved);
	const hardTokens = Math.min(RESEARCH_HARD_COMPACT_TOKENS, modelSafeHard);
	const softTokens = Math.min(RESEARCH_SOFT_COMPACT_TOKENS, Math.floor(hardTokens * 0.75));
	return { softTokens, hardTokens };
}

export default function (pi: ExtensionAPI) {
	let compactionRunning = false;
	let scheduledCompaction: { trigger: "soft" | "hard"; tokens: number } | undefined;

	pi.on("session_start", () => {
		compactionRunning = false;
		scheduledCompaction = undefined;
	});

	pi.on("session_compact", () => {
		compactionRunning = false;
		scheduledCompaction = undefined;
	});

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const thresholds = researchCompactionThresholds(ctx.model);
		if (!usage || usage.tokens < thresholds.softTokens || compactionRunning || scheduledCompaction) return;

		const trigger = usage.tokens >= thresholds.hardTokens ? "hard" : "soft";
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
		scheduledCompaction = undefined;
		compactionRunning = true;
		ctx.compact({
			customInstructions: `Automatic research ${scheduled.trigger} compaction at ${scheduled.tokens} context tokens.`,
			onComplete: () => {
				compactionRunning = false;
			},
			onError: (error) => {
				compactionRunning = false;
				if (ctx.hasUI) ctx.ui.notify(`Research compaction failed: ${error.message}`, "warning");
			},
		});
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
		const policy = selectResearchCompactionPolicy(branchEntries);
		const preparation = prepareWithDynamicTail(event, policy.keepRecentTokens);
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionEvidence = collectResearchEvidence(branchEntries, sessionId, preparation.firstKeptEntryId, { inheritancePolicy });
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
			&& latestResearchCompaction.details?.inheritancePolicy === "clean"
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
			`Research compaction #${policy.ordinal}${inheritancePolicy === "clean" ? " (clean Session, no Project inheritance)" : ""}: ${preparation.tokensBefore.toLocaleString()} tokens, keeping ~${policy.keepRecentTokens.toLocaleString()} recent tokens, ${evidence.experiments.length} experiment record(s).`,
			"info",
		);

		try {
			const response = await ctx.modelRegistry.complete(
				ctx.model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
					tools: [RESEARCH_STATE_TOOL],
				},
				{
					maxTokens: Math.min(12_000, ctx.model.maxTokens || 12_000),
					signal,
					cacheRetention: "none",
					sessionId: randomUUID(),
				},
			);
			let parsed;
			try {
				parsed = parseResearchCompactionResponse(response.content);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)} (stopReason=${response.stopReason})`);
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
