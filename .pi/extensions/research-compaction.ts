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
	parseResearchState,
	RESEARCH_HARD_COMPACT_TOKENS,
	renderResearchSummary,
	RESEARCH_COMPACTION_KIND,
	RESEARCH_COMPACTION_VERSION,
	RESEARCH_SOFT_COMPACT_TOKENS,
	selectResearchCompactionPolicy,
} from "../lib/research-compact.mjs";
import { readRuntimeSnapshot, resolveResearchRuntime } from "../lib/research-runtime.mjs";

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
		if (!usage || usage.tokens < RESEARCH_SOFT_COMPACT_TOKENS || compactionRunning || scheduledCompaction) return;

		const trigger = usage.tokens >= RESEARCH_HARD_COMPACT_TOKENS ? "hard" : "soft";
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
		const projectRevision = runtimeSnapshot.revision;
		const policy = selectResearchCompactionPolicy(branchEntries);
		const preparation = prepareWithDynamicTail(event, policy.keepRecentTokens);
		const sessionId = ctx.sessionManager.getSessionId();
		const evidence = mergeProjectRuntimeEvidence(
			collectResearchEvidence(branchEntries, sessionId, preparation.firstKeptEntryId),
			runtimeSnapshot,
		);
		const conversationText = serializeConversation(
			convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
		);
		const prompt = buildResearchCompactionPrompt({
			conversationText,
			previousState: evidence.previousState,
			legacyPreviousSummary: evidence.previousState ? undefined : preparation.previousSummary,
			experiments: evidence.experiments,
			checkpoints: evidence.checkpoints,
			sourceCatalog: evidence.sourceCatalog,
			projectTransitions: runtimeSnapshot.transitions?.slice(-4) ?? [],
			customInstructions,
		});

		ctx.ui.notify(
			`Research compaction #${policy.ordinal}: ${preparation.tokensBefore.toLocaleString()} tokens, keeping ~${policy.keepRecentTokens.toLocaleString()} recent tokens, ${evidence.experiments.length} experiment record(s).`,
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
				},
				{
					maxTokens: Math.min(12_000, ctx.model.maxTokens || 12_000),
					signal,
					cacheRetention: "none",
					sessionId: randomUUID(),
				},
			);
			const raw = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (!raw.trim()) throw new Error(`summarizer returned no text (stopReason=${response.stopReason})`);

			const candidate = parseResearchState(raw);
			const normalized = normalizeResearchState(candidate, evidence);
			const files = fileLists(preparation.fileOps);
			const summary = renderResearchSummary(normalized.state, evidence, files);
			const details = buildResearchCompactionDetails({
				state: normalized.state,
				evidence,
				warnings: normalized.warnings,
				sessionId,
				reason,
				tokensBefore: preparation.tokensBefore,
				fileOps: files,
				policy,
				projectRevision,
			});

			if (normalized.warnings.length) {
				ctx.ui.notify(
					`Research compaction retained the summary with ${normalized.warnings.length} validation warning(s).`,
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
