import { pruneMemoryIndexSources } from "./research-memory.mjs";
import { join, resolve } from "node:path";
import { createRuntimeResearchBranch, listResearchBranches, readRuntimeSnapshot, resolveResearchRuntime } from "./research-runtime.mjs";
import { selectResearchBranch, researchBranchContext } from "./research-branches.mjs";
import { archiveResearchBranch, checkpointResearchBranch, doctorResearchBranches, forkResearchBranch, importResearchEvidence, inspectResearchCheckpoint, pruneResearchBranches, researchBranchHistory, restoreResearchBranch, rewindResearchBranch } from "./research-branch-history.mjs";

const USAGE = "Usage: pi branch <init|migrate|status|list|checkpoint|history|inspect|fork|rewind|import|archive|restore|doctor|prune> [arguments] [--workspace <path>] [--json]";
const OPTIONS = {
	migrate: ["keep", "fresh-workspace", "fresh-name", "session", "apply"], init: [], status: ["branch"], list: [], checkpoint: ["reason"], history: [], inspect: ["branch"],
	fork: ["from", "at", "to"], rewind: ["reason"], import: ["at", "reason", "interpretation"],
	archive: ["reason"], restore: ["reason"], doctor: [], prune: ["apply"],
};

export async function runResearchBranchCommand(argv, { cwd = process.cwd(), stateRoot, runtimeRoot } = {}) {
	const args = [...argv], action = args.shift() ?? "list", flags = {}, positional = [];
	if (!Object.hasOwn(OPTIONS, action)) throw new Error(USAGE);
	while (args.length) {
		const arg = args.shift();
		if (!arg.startsWith("--")) { positional.push(arg); continue; }
		const flag = arg.slice(2);
		if (!["workspace", "json", ...OPTIONS[action]].includes(flag) || Object.hasOwn(flags, flag)) throw new Error(`Unsupported or duplicate option ${arg}. ${USAGE}`);
		if (["json", "apply"].includes(flag)) flags[flag] = true;
		else {
			if (!args.length || args[0].startsWith("--")) throw new Error(`${arg} requires a value`);
			flags[flag] = args.shift();
		}
	}
	const runtime = await resolveResearchRuntime(resolve(flags.workspace ?? cwd), {
		runtimeRoot: runtimeRoot ?? process.env.RESEARCH_PI_RUNTIME_DIR ?? join(stateRoot, "runtime", "projects"),
	});
	const authority = { authority: "user" };
	let result;
	if (action === "migrate") {
		const { migrateLegacyResearchBranch } = await import("./research-branch-migration.mjs");
		if (positional.length || !flags.keep || !flags["fresh-workspace"] || !flags["fresh-name"]) throw new Error("Usage: pi branch migrate --keep <name> --fresh-workspace <path> --fresh-name <name> [--session <id>] [--apply]");
		result = await migrateLegacyResearchBranch({ cwd: runtime.workspaceRoot, runtimeRoot: runtime.runtimeRoot, stateRoot,
			name: flags.keep, freshWorkspace: flags["fresh-workspace"], freshName: flags["fresh-name"], sessionId: flags.session, apply: flags.apply });
	} else if (action === "init") {
		if (!positional.length) throw new Error("Usage: pi branch init <name>");
		result = await createRuntimeResearchBranch(runtime.workspaceRoot, { runtimeRoot: runtime.runtimeRoot, name: positional.join(" ") });
	} else if (action === "status") {
		if (positional.length) throw new Error("Usage: pi branch status [--branch <name|id>]");
		const selected = flags.branch ? await selectResearchBranch(runtime, flags.branch) : runtime;
		const snapshot = await readRuntimeSnapshot(selected);
		result = { ...selected, lifecycle: snapshot.lifecycle, generation: snapshot.generation, head: snapshot.headCheckpoint };
	} else if (action === "list") {
		if (positional.length) throw new Error("Usage: pi branch list");
		const branches = await listResearchBranches(runtime);
		result = { projectKey: runtime.projectKey, legacy: runtime.legacy, branches: await Promise.all(branches.map(async branch => {
			const snapshot = await readRuntimeSnapshot(researchBranchContext({ ...branch, cwd: branch.workspaceRoot }, runtime.runtimeRoot, branch));
			return { ...branch, current: branch.branchId === runtime.branchId, lifecycle: snapshot.lifecycle,
				revision: snapshot.revision, head: snapshot.headCheckpoint, forkedFrom: snapshot.forkedFrom,
				leaderSessionId: snapshot.attachments.find(item => item.actorId === "research-leader")?.sessionId ?? null,
				activeActions: snapshot.actions.filter(item => ["queued", "starting", "running", "input_required", "cancelling", "outcome_unknown"].includes(item.status)).length };
		})) };
	} else if (action === "checkpoint") {
		if (!positional.length) throw new Error("Usage: pi branch checkpoint <label> [--reason <reason>]");
		result = await checkpointResearchBranch(runtime, { ...authority, label: positional.join(" "), rationale: flags.reason ?? "Explicit user checkpoint" });
	} else if (action === "history") {
		if (positional.length > 1) throw new Error("Usage: pi branch history [branch]");
		result = await researchBranchHistory(positional[0] ? await selectResearchBranch(runtime, positional[0]) : runtime);
	} else if (action === "inspect") {
		if (positional.length !== 1) throw new Error("Usage: pi branch inspect <checkpoint> [--branch <name|id>]");
		result = await inspectResearchCheckpoint(flags.branch ? await selectResearchBranch(runtime, flags.branch) : runtime, positional[0]);
	} else if (action === "fork") {
		if (positional.length !== 1 || !flags.to) throw new Error("Usage: pi branch fork <name> --to <new-worktree> [--from <branch>] [--at <checkpoint>]");
		const source = flags.from ? await selectResearchBranch(runtime, flags.from) : runtime;
		const snapshot = await readRuntimeSnapshot(source);
		const checkpointId = flags.at ?? snapshot.checkpoints.at(-1)?.id;
		if (!checkpointId) throw new Error("Create a checkpoint before forking this branch");
		result = await forkResearchBranch(source, { name: positional[0], checkpointId, to: flags.to });
	} else if (action === "rewind") {
		if (positional.length !== 1) throw new Error("Usage: pi branch rewind <checkpoint> [--reason <reason>]");
		result = await rewindResearchBranch(runtime, { ...authority, checkpointId: positional[0], reason: flags.reason ?? "Explicit user research rewind" });
	} else if (action === "import") {
		if (positional.length !== 2) throw new Error("Usage: pi branch import <source-branch> <evidence-id> --reason <reason> [--at <checkpoint>]");
		result = await importResearchEvidence(runtime, await selectResearchBranch(runtime, positional[0]), {
			...authority, evidenceId: positional[1], checkpointId: flags.at, reason: flags.reason, interpretation: flags.interpretation,
		});
	} else if (["archive", "restore"].includes(action)) {
		if (positional.length > 1) throw new Error(`Usage: pi branch ${action} [branch] [--reason <reason>]`);
		const target = positional[0] ? await selectResearchBranch(runtime, positional[0]) : runtime;
		result = await (action === "archive" ? archiveResearchBranch : restoreResearchBranch)(target, {
			...authority, reason: flags.reason ?? `Explicit user ${action}`,
		});
	} else {
		if (positional.length) throw new Error(`Usage: pi branch ${action}${action === "prune" ? " [--apply]" : ""}`);
		result = action === "doctor" ? await doctorResearchBranches(runtime) : await pruneResearchBranches(runtime, { apply: flags.apply });
		if (action === "prune" && stateRoot) result.memory = pruneMemoryIndexSources(join(stateRoot, "memory", "memory-v5.sqlite"), { apply: flags.apply, projectKey: runtime.projectKey });
	}
	return { action, json: flags.json === true, result };
}

export function formatResearchBranchCommand({ action, json, result }) {
	if (json) return `${JSON.stringify(result, null, 2)}\n`;
	if (["init", "status"].includes(action)) return `${result.branchName ?? "Legacy shared Runtime"} · ${result.branchId ?? result.projectKey} · ${result.lifecycle ?? "active"}\nWorkspace: ${result.workspaceRoot}\n`;
	if (action === "list") return result.branches.length ? result.branches.map(branch => `${branch.current ? "*" : " "} ${branch.name} · ${branch.lifecycle} · ${branch.branchId} · r${branch.revision} · ${branch.activeActions} active\n  ${branch.workspaceRoot} · binding ${branch.bindingStatus}`).join("\n") + "\n" : "No independent research branches are registered.\n";
	if (action === "checkpoint") return `${result.id} · ${result.label}\nCode: ${result.code.commit}\n${result.code.untrackedFiles.length ? `Excluded ${result.code.untrackedFiles.length} untracked file(s).\n` : ""}`;
	if (action === "fork") return `${result.name} · ${result.branchId}\nWorkspace: ${result.workspaceRoot}\nSource checkpoint: ${result.checkpointId}\n`;
	if (action === "history") return `${result.name} · ${result.lifecycle} · generation ${result.generation}\n${result.checkpoints.map(cp => `${cp.id} · ${cp.label} · parents ${cp.parents.map(parent => `${parent.branchId}/${parent.checkpointId}`).join(", ") || "none"}`).join("\n")}\n`;
	if (["doctor", "prune"].includes(action)) return `${result.issues.length} issue(s)${action === "prune" ? ` · ${result.dryRun ? "preview; use --apply to repair" : `${result.repaired.length} repaired, ${result.skipped.length} skipped`}` : ""}\n${result.issues.map(issue => `${issue.code} · ${issue.branchId} · ${issue.repairable ? "repairable" : "retained"}${issue.path ? ` · ${issue.path}` : ""}`).join("\n")}\n`;
	return `${JSON.stringify(result, null, 2)}\n`;
}
