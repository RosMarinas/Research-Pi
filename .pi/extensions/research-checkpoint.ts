import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureResearchCode, checkpointResearchBranch } from "../lib/research-branch-history.mjs";
import { resolveResearchRuntime } from "../lib/research-runtime.mjs";

interface CheckpointRecord {
	id: string;
	timestamp: string;
	label: string;
	rationale: string;
	repository: string;
	ref: string;
	commit: string;
	head: string;
	hadTrackedChanges: boolean;
	untrackedFiles: string[];
	sessionId: string;
	sessionFile?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Checkpoint",
		description:
			"Checkpoint the current research state, evidence references and tracked code without changing the Git branch, index or working tree. Untracked files are reported but not captured. Use at a research decision boundary.",
		promptSnippet: "Create a persistent, non-mutating Git checkpoint at a research decision boundary",
		promptGuidelines: [
			"Use research_checkpoint only when losing the current state would be meaningfully costly before a high-contrast intervention, rollback, or abandonment of a research route; never call it automatically every turn or for read-only work.",
			"research_checkpoint does not capture untracked files. If they matter, explicitly review and stage only the intended files before checkpointing; never stage secrets or large artifacts.",
		],
		parameters: Type.Object({
			label: Type.String({ description: "Short human-readable name for this research state" }),
			rationale: Type.String({ description: "Why this state is worth preserving before the next intervention" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = await resolveResearchRuntime(ctx.cwd);
			const context = { sessionId: ctx.sessionManager.getSessionId(), entryId: ctx.sessionManager.getLeafId(), signal };
			const checkpoint = runtime.branchId
				? await checkpointResearchBranch(runtime, { ...params, ...context }) : null;
			const code = checkpoint?.code ?? await captureResearchCode(ctx.cwd, { label: params.label, signal });
			const { repository, ref, commit, head, hadTrackedChanges, untrackedFiles } = code;
			const record: CheckpointRecord = {
				id: checkpoint?.id ?? ref.split("/").at(-1)!, timestamp: new Date().toISOString(),
				label: params.label, rationale: params.rationale, repository, ref, commit, head, hadTrackedChanges, untrackedFiles,
				sessionId: context.sessionId, sessionFile: ctx.sessionManager.getSessionFile(),
			};

			pi.appendEntry<CheckpointRecord>("research-checkpoint", record);

			const warning = untrackedFiles.length
				? ` Warning: ${untrackedFiles.length} untracked file(s) were not captured.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Created ${ref} at ${commit}.${warning} Recover non-destructively with: git worktree add <new-dir> ${ref}`,
					},
				],
				details: { ...record, ...(checkpoint ? { branchId: runtime.branchId, checkpointId: checkpoint.id, parents: checkpoint.parents } : {}) },
			};
		},
	});
}
