import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "checkpoint";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Checkpoint",
		description:
			"Create a persistent Git ref for the current tracked code state without changing the branch, index, or working tree. Use only at a research decision boundary. Untracked files are reported but not captured.",
		promptSnippet: "Create a persistent, non-mutating Git checkpoint at a research decision boundary",
		promptGuidelines: [
			"Use research_checkpoint only before a high-contrast intervention, rollback, or abandonment of a research route; never call it automatically every turn or for read-only work.",
			"research_checkpoint does not capture untracked files. If they matter, explicitly review and stage only the intended files before checkpointing; never stage secrets or large artifacts.",
		],
		parameters: Type.Object({
			label: Type.String({ description: "Short human-readable name for this research state" }),
			rationale: Type.String({ description: "Why this state is worth preserving before the next intervention" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
				cwd: ctx.cwd,
				signal,
				timeout: 5000,
			});
			if (rootResult.code !== 0) {
				throw new Error("research_checkpoint requires a Git worktree; the current directory is not inside one.");
			}

			const repository = rootResult.stdout.trim();
			const headResult = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], {
				cwd: repository,
				signal,
				timeout: 5000,
			});
			if (headResult.code !== 0) {
				throw new Error("research_checkpoint requires a repository with an initial commit.");
			}
			const head = headResult.stdout.trim();

			const beforeStatus = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
				cwd: repository,
				signal,
				timeout: 10000,
			});
			if (beforeStatus.code !== 0) throw new Error(`Unable to inspect Git state: ${beforeStatus.stderr.trim()}`);

			const statusLines = beforeStatus.stdout.split("\n").filter(Boolean);
			const untrackedFiles = statusLines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
			const hadTrackedChanges = statusLines.some((line) => !line.startsWith("?? "));

			const stash = await pi.exec("git", ["stash", "create", `pi research checkpoint: ${params.label}`], {
				cwd: repository,
				signal,
				timeout: 30000,
			});
			if (stash.code !== 0) throw new Error(`Unable to create Git snapshot: ${stash.stderr.trim()}`);
			const commit = stash.stdout.trim() || head;

			const timestamp = new Date().toISOString();
			const id = `cp-${timestamp.replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
			const ref = `refs/pi-research/checkpoints/${id}-${slugify(params.label)}`;
			const updateRef = await pi.exec("git", ["update-ref", ref, commit], {
				cwd: repository,
				signal,
				timeout: 10000,
			});
			if (updateRef.code !== 0) throw new Error(`Unable to persist checkpoint ref: ${updateRef.stderr.trim()}`);

			const afterStatus = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
				cwd: repository,
				signal,
				timeout: 10000,
			});
			if (afterStatus.code !== 0 || afterStatus.stdout !== beforeStatus.stdout) {
				throw new Error(
					`Checkpoint ref ${ref} was created, but the working-tree preservation check failed; inspect the repository before continuing.`,
				);
			}

			const record: CheckpointRecord = {
				id,
				timestamp,
				label: params.label,
				rationale: params.rationale,
				repository,
				ref,
				commit,
				head,
				hadTrackedChanges,
				untrackedFiles,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
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
				details: record,
			};
		},
	});
}
