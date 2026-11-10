import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createResearchBranchBinding, listResearchBranches, readResearchBranchBinding, researchBranchBindingPath, researchBranchContext } from "./research-branches.mjs";
import { appendRuntimeEvent, assertResearchBranchQuiescent, projectRuntimeEvents, readRuntimeEvents, readRuntimeSnapshot, resolveResearchRuntime, runtimeResearchTrack, withResearchBranchMutation } from "./research-runtime.mjs";
import { compressResearchLedger, expandResearchLedger } from "./research-ledger-storage.mjs";
import { withOwnerFileLock } from "./owner-file-lock.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const LIVE = new Set(["queued", "starting", "running", "input_required", "cancelling", "outcome_unknown"]);
const RESEARCH_FIELDS = ["projectState", "projectBrief", "evidence", "transitions", "revision"];
const researchState = snapshot => Object.fromEntries(RESEARCH_FIELDS.map(field => [field, snapshot[field]]));
const text = (value, field, max = 3000) => {
	value = String(value ?? "").trim();
	if (!value || value.length > max) throw new Error(`${field} must contain 1–${max} characters`);
	return value;
};
const git = async (cwd, args, signal) => (await execute("git", args, { cwd, signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

export async function captureResearchCode(cwd, { label, signal } = {}) {
	const repository = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
	const head = await git(repository, ["rev-parse", "--verify", "HEAD"], signal);
	const commonDir = await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
	const status = () => git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
	const signature = async () => hash([await status(), await git(repository, ["diff", "--binary", "HEAD"], signal)]);
	const beforeStatus = await status(), before = await signature();
	const commit = await git(repository, ["-c", "user.name=Research Pi", "-c", "user.email=research-pi@localhost",
		"stash", "create", `Research checkpoint: ${label ?? "checkpoint"}`], signal) || head;
	if (await signature() !== before) throw new Error("Code changed during checkpoint capture; retry after writers settle");
	const ref = `refs/pi-research/checkpoints/cp-${randomUUID()}`;
	await git(repository, ["update-ref", ref, commit], signal);
	return { repository, commonDir, head, commit, ref, hadTrackedChanges: commit !== head,
		untrackedFiles: beforeStatus.split("\n").filter(line => line.startsWith("?? ")).map(line => line.slice(3)) };
}

export async function checkpointResearchBranch(runtime, input) {
	const label = text(input.label, "Checkpoint label", 120), rationale = text(input.rationale, "Checkpoint rationale");
	return await withResearchBranchMutation(runtime, input, async ({ snapshot, events, append }) => {
		if (snapshot.actions.some(action => LIVE.has(action.status) && (action.metadata?.role ?? action.metadata?.mode) !== "advisor")) {
			throw new Error("Settle workspace writers before capturing its code checkpoint");
		}
		const code = await captureResearchCode(runtime.workspaceRoot, { label, signal: input.signal });
		const data = { id: `cp-${randomUUID()}`, label, rationale,
			cursor: events.at(-1)?.id ?? null, revision: snapshot.revision,
			parents: snapshot.headCheckpoint ? [snapshot.headCheckpoint] : [], code,
			context: { sessionId: input.sessionId ?? null, entryId: input.entryId ?? null },
		};
		await append("branch.checkpoint", data, `checkpoint:${data.id}`);
		return data;
	});
}

export async function inspectResearchCheckpoint(runtime, checkpointId) {
	const events = await readRuntimeEvents(runtime);
	const checkpoint = events.find(event => event.type === "branch.checkpoint" && event.data.id === checkpointId);
	if (!checkpoint) throw new Error(`Unknown checkpoint ${checkpointId} in ${runtime.branchName}`);
	const end = checkpoint.data.cursor === null ? -1 : events.findIndex(event => event.id === checkpoint.data.cursor);
	if (checkpoint.data.cursor !== null && end < 0) throw new Error("Checkpoint history cursor is missing");
	return { ...checkpoint.data, branchId: runtime.branchId,
		research: researchState(projectRuntimeEvents(runtime, events.slice(0, end + 1))) };
}

export async function researchBranchHistory(runtime) {
	const snapshot = await readRuntimeSnapshot(runtime);
	return { branchId: runtime.branchId, name: runtime.branchName, lifecycle: snapshot.lifecycle,
		generation: snapshot.generation, head: snapshot.headCheckpoint, forkedFrom: snapshot.forkedFrom,
		checkpoints: snapshot.checkpoints,
		events: (await readRuntimeEvents(runtime)).filter(event => ["branch.forked", "branch.rewound", "branch.archived", "branch.restored", "evidence.imported"].includes(event.type))
			.map(event => ({ id: event.id, at: event.at, type: event.type, checkpoint: event.data.checkpoint,
				reason: event.data.reason ?? event.data.adoption?.reason, origin: event.data.origin })),
	};
}

// A new Git worktree is created from the frozen tracked-code snapshot. Forks
// materialize research metadata once; transcripts, binaries, leases and Jobs
// are never copied or replayed.
export async function forkResearchBranch(source, input) {
	text(input.name, "Branch name", 120);
	const checkpoint = await inspectResearchCheckpoint(source, text(input.checkpointId, "Checkpoint ID", 160));
	const target = resolve(text(input.to, "New worktree path", 4000));
	try { await lstat(target); throw new Error("Fork destination already exists; choose a new worktree directory"); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	const gitBranch = `pi/${input.name.normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "research"}-${randomUUID().slice(0, 8)}`;
	await git(dirname(checkpoint.code.commonDir), ["--git-dir", checkpoint.code.commonDir, "worktree", "add", "-b", gitBranch, target, checkpoint.code.commit], input.signal);
	// If publication fails, retain the new worktree for inspection rather than
	// deleting potentially valuable work or changing the source branch.
	try {
		const identity = await resolveResearchRuntime(target, { runtimeRoot: source.runtimeRoot });
		if (await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.signal) !== checkpoint.code.commonDir) throw new Error("Fork worktree does not belong to the source repository");
		identity.projectKey = source.projectKey;
		const baseCheckpointId = `cp-${randomUUID()}`;
		const binding = await createResearchBranchBinding(identity, source.runtimeRoot, { name: input.name,
			initialize: async runtime => {
				const event = await appendRuntimeEvent(runtime, "branch.forked", {
				checkpoint: { branchId: source.branchId, checkpointId: checkpoint.id }, research: checkpoint.research,
				code: checkpoint.code, context: checkpoint.context, gitBranch,
			}, { id: `fork:${checkpoint.id}` });
				await appendRuntimeEvent(runtime, "branch.checkpoint", {
					id: baseCheckpointId, label: "Fork base", rationale: `Forked from ${source.branchName}/${checkpoint.id}`,
					cursor: event.id, revision: checkpoint.research.revision + 1,
					parents: [{ branchId: source.branchId, checkpointId: checkpoint.id }], code: checkpoint.code, context: checkpoint.context,
				}, { id: `checkpoint:${baseCheckpointId}` });
			},
		});
		return { ...binding, gitBranch, checkpointId: checkpoint.id, baseCheckpointId, untrackedFilesExcluded: checkpoint.code.untrackedFiles };
	} catch (error) {
		throw new Error(`Fork worktree was created at ${target}, but Runtime publication failed: ${error.message}`, { cause: error });
	}
}

export async function rewindResearchBranch(runtime, input) {
	const reason = text(input.reason, "Rewind reason");
	const checkpoint = await inspectResearchCheckpoint(runtime, input.checkpointId);
	return await withResearchBranchMutation(runtime, { ...input, quiescent: true, detached: true }, async ({ snapshot, append }) => {
		await append("branch.rewound", { checkpoint: { branchId: runtime.branchId, checkpointId: checkpoint.id },
			research: checkpoint.research, reason, code: checkpoint.code, generation: snapshot.generation + 1 });
		return { checkpointId: checkpoint.id, generation: snapshot.generation + 1, code: checkpoint.code,
			codeRestored: false, message: "Research state restored. Code and real executions are unchanged; use fork to resume the historical code in another worktree." };
	});
}

export async function importResearchEvidence(target, source, input) {
	if (target.projectKey !== source.projectKey || target.branchId === source.branchId) throw new Error("Evidence import requires a different branch of the same project");
	const reason = text(input.reason, "Adoption reason");
	const sourceState = input.checkpointId ? (await inspectResearchCheckpoint(source, input.checkpointId)).research : await readRuntimeSnapshot(source);
	const evidence = sourceState.evidence.find(item => item.id === input.evidenceId);
	if (!evidence) throw new Error(`Unknown source evidence ${input.evidenceId}`);
	const origin = { projectKey: source.projectKey, branchId: source.branchId, evidenceId: evidence.id,
		eventId: evidence.eventId ?? null, contentHash: hash(evidence), checkpointId: input.checkpointId ?? null,
		...(evidence.origin ? { prior: evidence.origin } : {}) };
	const id = `import-${hash([origin.branchId, origin.evidenceId, origin.contentHash]).slice(0, 24)}`;
	return await withResearchBranchMutation(target, input, async ({ snapshot, append }) => {
		const existing = snapshot.evidence.find(item => item.id === id);
		if (existing) return { id, duplicate: true, origin: existing.origin };
		const track = runtimeResearchTrack(snapshot);
		await append("evidence.imported", { ...evidence, id, origin, branchId: target.branchId,
			trackRef: track.ref, trackLabel: track.label, sourceTrackRef: evidence.trackRef,
			adoption: { reason, interpretation: input.interpretation ? text(input.interpretation, "Adoption interpretation") : "", sessionId: input.sessionId ?? null },
			projectRevision: snapshot.revision }, `evidence:${id}`);
		return { id, origin, duplicate: false };
	});
}

export async function archiveResearchBranch(runtime, input) {
	return await withResearchBranchMutation(runtime, { ...input, allowArchived: true, quiescent: true, detached: true }, async ({ snapshot, append }) => {
		if (snapshot.lifecycle === "archived") return { branchId: runtime.branchId, lifecycle: "archived", ...await compressResearchLedger(runtime) };
		await append("branch.archived", { reason: text(input.reason, "Archive reason") });
		return { branchId: runtime.branchId, lifecycle: "archived", ...await compressResearchLedger(runtime) };
	});
}

export async function restoreResearchBranch(runtime, input) {
	const reason = text(input.reason, "Restore reason");
	return await withResearchBranchMutation(runtime, { ...input, allowArchived: true, quiescent: true, detached: true }, async ({ snapshot, append }) => {
		if (snapshot.lifecycle !== "archived") return { branchId: runtime.branchId, lifecycle: "active", unchanged: true };
		await expandResearchLedger(runtime);
		await append("branch.restored", { reason });
		return { branchId: runtime.branchId, lifecycle: "active" };
	});
}

const processAlive = pid => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

export async function doctorResearchBranches(runtime) {
	const issues = [];
	const branches = await listResearchBranches(runtime, { onError: issue => issues.push(issue) });
	let bindings = [];
	try { bindings = await readdir(join(runtime.runtimeRoot, "workspaces")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	for (const name of bindings.filter(name => name.endsWith(".json"))) {
		try {
			const binding = JSON.parse(await readFile(join(runtime.runtimeRoot, "workspaces", name), "utf8"));
			if (binding.projectKey !== runtime.projectKey || branches.some(branch => branch.branchId === binding.branchId)) continue;
			if (name !== `${binding.workspaceKey}.json`) throw new Error("Workspace index filename does not match its binding");
			await readResearchBranchBinding(binding, runtime.runtimeRoot);
			branches.push({ ...binding, bindingStatus: "orphan" });
		} catch (error) { issues.push({ code: "invalid_binding_file", path: join(runtime.runtimeRoot, "workspaces", name), detail: error.message, repairable: false }); }
	}
	for (const branch of branches) {
		const scope = researchBranchContext({ ...branch, cwd: branch.workspaceRoot }, runtime.runtimeRoot, branch);
		let snapshot;
		try { snapshot = await readRuntimeSnapshot(scope); }
		catch (error) { issues.push({ code: "invalid_ledger", branchId: branch.branchId, detail: error.message, repairable: false }); continue; }
		let missing = false;
		try { const info = await stat(branch.workspaceRoot); if (!info.isDirectory()) throw new Error("Workspace is not a directory"); }
		catch (error) {
			missing = error.code === "ENOENT";
			issues.push({ code: missing ? "missing_workspace" : "unavailable_workspace", branchId: branch.branchId,
				workspaceKey: branch.workspaceKey, path: branch.workspaceRoot,
				repairable: missing && ["bound", "orphan"].includes(branch.bindingStatus) && !issues.some(issue => issue.code === "invalid_branch_metadata" && issue.branchId === branch.branchId), detail: error.message });
		}
		if (branch.bindingStatus !== "bound") issues.push({ code: `binding_${branch.bindingStatus}`, branchId: branch.branchId,
			workspaceKey: branch.workspaceKey, repairable: false });
		let locks = [];
		try { locks = (await readdir(scope.scopeDir)).filter(name => name.endsWith(".lock")).map(name => join(scope.scopeDir, name)); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		locks.push(`${researchBranchBindingPath(runtime.runtimeRoot, branch.workspaceKey)}.lock`);
		for (const path of locks) {
			try {
				const [info, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
				let owner; try { owner = JSON.parse(raw); } catch { owner = null; }
				if (Date.now() - info.mtimeMs > 30_000 && !processAlive(owner?.pid)) issues.push({ code: "stale_lock", branchId: branch.branchId, path, repairable: true });
			} catch (error) { if (error.code !== "ENOENT") throw error; }
		}
		if (missing && ["bound", "orphan"].includes(branch.bindingStatus)) {
			try { assertResearchBranchQuiescent(snapshot, { detached: true }); }
			catch (error) { issues.find(issue => issue.code === "missing_workspace" && issue.branchId === branch.branchId).repairable = false;
				issues.push({ code: "unresolved_ownership", branchId: branch.branchId, detail: error.message, repairable: false }); }
		}
	}
	return { projectKey: runtime.projectKey, branches, issues };
}

export async function pruneResearchBranches(runtime, { apply = false } = {}) {
	const report = await doctorResearchBranches(runtime), repaired = [], skipped = [];
	if (!apply) return { ...report, dryRun: true, repaired };
	// Reclaim dead locks first. Use the owner-aware protocol rather than
	// unconditionally unlinking a lock observed by an earlier scan.
	for (const issue of report.issues.filter(issue => issue.code === "stale_lock" && issue.repairable)) {
		try { await withOwnerFileLock(issue.path, async () => {}, { attempts: 2, waitMs: 0 }); repaired.push(issue); }
		catch (error) { skipped.push({ ...issue, detail: error.message }); }
	}
	for (const issue of report.issues.filter(issue => issue.code === "missing_workspace" && issue.repairable)) {
		const branch = report.branches.find(branch => branch.branchId === issue.branchId);
		const path = researchBranchBindingPath(runtime.runtimeRoot, branch.workspaceKey);
		try {
			await withOwnerFileLock(`${path}.lock`, async () => {
				const binding = await readResearchBranchBinding(branch, runtime.runtimeRoot);
				if (!binding || binding.branchId !== branch.branchId) throw new Error("Workspace binding changed during prune");
				try { await stat(branch.workspaceRoot); throw new Error("Workspace reappeared during prune"); }
				catch (error) { if (error.code !== "ENOENT") throw error; }
				const scope = researchBranchContext({ ...branch, cwd: branch.workspaceRoot }, runtime.runtimeRoot, branch);
				try { await stat(scope.scopeDir); } catch (error) { if (error.code === "ENOENT") return await unlink(path); throw error; }
				await withResearchBranchMutation(scope, { authority: "user", allowArchived: true, quiescent: true, detached: true }, async () => {
					// Preserve discoverability of retained history when its derived
					// branch catalog entry was lost but the binding survived.
					if (branch.bindingStatus === "orphan") {
						try { await writeFile(join(scope.scopeDir, "branch.json"), `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 }); }
						catch (error) { if (error.code !== "EEXIST") throw error; }
					}
					await unlink(path);
				});
			});
			repaired.push(issue);
		} catch (error) { skipped.push({ ...issue, detail: error.message }); }
	}
	return { ...report, dryRun: false, repaired, skipped };
}
