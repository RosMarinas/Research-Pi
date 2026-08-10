import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	buildResearchCompactionDetails,
	buildResearchCompactionPrompt,
	collectResearchEvidence,
	normalizeResearchState,
	parseResearchState,
	renderResearchSummary,
	RESEARCH_COMPACTION_KIND,
	RESEARCH_COMPACTION_VERSION,
} from "../lib/research-compact.mjs";

function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		read: [...fileOps.read].filter((path) => !modified.has(path)),
		modified: [...modified],
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.model) {
			ctx.ui.notify("Research compaction could not resolve the active model; falling back to Pi compaction.", "warning");
			return;
		}

		const { preparation, branchEntries, customInstructions, reason, signal } = event;
		const sessionId = ctx.sessionManager.getSessionId();
		const evidence = collectResearchEvidence(branchEntries, sessionId, preparation.firstKeptEntryId);
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
			customInstructions,
		});

		ctx.ui.notify(
			`Research compaction: ${preparation.tokensBefore.toLocaleString()} tokens, ${evidence.experiments.length} experiment record(s).`,
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
