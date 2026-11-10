import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createResearchBranchBinding, researchBranchContext } from "./research-branches.mjs";
import { assertResearchBranchQuiescent, readRuntimeEvents, readRuntimeSnapshot, resolveResearchRuntime, runtimeSessionInheritancePolicy, runtimeSessionProjectContext } from "./research-runtime.mjs";
import { captureResearchCode } from "./research-branch-history.mjs";
import { replaceResearchFile } from "./research-ledger-storage.mjs";
import { withOwnerFileLock } from "./owner-file-lock.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function readJson(path) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
async function requireStoppedHosts(stateRoot, workspaces) {
	const root = join(stateRoot, "native-hosts");
	let hosts; try { hosts = await readdir(root); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	for (const host of hosts) {
		const record = await readJson(join(root, host, "access.json"));
		if (record && workspaces.has(resolve(record.cwd)) && alive(record.pid)) {
			throw new Error(`Stop the Native Host for ${record.cwd} before migrating; PID ${record.pid} is still alive`);
		}
	}
}
async function workspaceSessions(sessionDir, workspaceRoot) {
	let files; try { files = await readdir(sessionDir); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
	const result = [];
	for (const name of files.filter(name => name.endsWith(".jsonl"))) {
		const path = join(sessionDir, name), bytes = await readFile(path, "utf8");
		const header = JSON.parse(bytes.split("\n", 1)[0]);
		if (header.type === "session" && resolve(header.cwd) === workspaceRoot) result.push({ path, id: header.id, bytes });
	}
	return result;
}

// Explicit, offline adoption of one legacy history by one workspace. The
// sibling starts empty. No task is cancelled or assumed finished by this API.
// A receipt and immutable backups make partial publication retryable.
export async function migrateLegacyResearchBranch(input) {
	for (const field of ["name", "freshName"]) {
		const value = String(input[field] ?? "").trim();
		if (!value || value.length > 120 || /\p{Cc}/u.test(value)) throw new Error("Migration branch names must contain 1–120 readable characters");
		input = { ...input, [field]: value };
	}
	const { stateRoot, runtimeRoot, sessionDir = join(stateRoot, "sessions") } = input;
	const keep = await resolveResearchRuntime(input.cwd, { runtimeRoot });
	const fresh = await resolveResearchRuntime(input.freshWorkspace, { runtimeRoot });
	if (keep.workspaceKey === fresh.workspaceKey || keep.projectKey !== fresh.projectKey) throw new Error("Migration requires two different workspaces of the same project");
	const receiptPath = join(keep.projectDir, "legacy-migration.json");
	const previous = await readJson(receiptPath);
	if (!previous && (keep.branchId || fresh.branchId)) throw new Error("Legacy migration cannot reassign an existing research branch");
	if (previous && (previous.keepWorkspaceKey !== keep.workspaceKey || previous.freshWorkspaceKey !== fresh.workspaceKey
		|| previous.keepName !== input.name || previous.freshName !== input.freshName)) throw new Error("This legacy project already has a different migration plan");
	const source = researchBranchContext({ ...keep, branchId: null }, runtimeRoot);
	const snapshot = await readRuntimeSnapshot(source);
	if (previous?.status === "complete") {
		if (keep.branchId !== previous.keepBranchId || fresh.branchId !== previous.freshBranchId) throw new Error("Completed migration bindings changed; inspect the receipt");
		return { ...previous, dryRun: !input.apply, unchanged: true };
	}
	assertResearchBranchQuiescent(snapshot, { detached: true });
	await requireStoppedHosts(stateRoot, new Set([keep.workspaceRoot, fresh.workspaceRoot]));
	const sessions = await workspaceSessions(sessionDir, keep.workspaceRoot);
	if (input.sessionId && !sessions.some(session => session.id === input.sessionId)) throw new Error("Requested handoff Session does not belong to the retained workspace");
	const plan = { projectKey: keep.projectKey, keepWorkspace: keep.workspaceRoot, freshWorkspace: fresh.workspaceRoot,
		revision: snapshot.revision, sessionIds: sessions.map(session => session.id), evidence: snapshot.evidence.length,
		actions: snapshot.actions.length, dryRun: !input.apply };
	if (!input.apply) return plan;
	await mkdir(source.projectDir, { recursive: true, mode: 0o700 });
	return await withOwnerFileLock(`${source.ledgerPath}.lock`, async () => {
		assertResearchBranchQuiescent(await readRuntimeSnapshot(source), { detached: true });
		await requireStoppedHosts(stateRoot, new Set([keep.workspaceRoot, fresh.workspaceRoot]));
		const bytes = await readFile(source.ledgerPath, "utf8");
		const events = await readRuntimeEvents(source);
		if (bytes.split("\n").filter(Boolean).length !== events.length) throw new Error("Legacy ledger is incomplete or contains foreign records; inspect it before migrating");
		const id = previous?.id ?? `migration-${randomUUID()}`;
		const backupDir = previous?.backupDir ?? join(stateRoot, "runtime", "migrations", id);
		await mkdir(join(backupDir, "sessions"), { recursive: true, mode: 0o700 });
		const sourceHash = digest(bytes);
		if (previous?.sourceHash && previous.sourceHash !== sourceHash) throw new Error("Legacy source changed after migration preparation");
		const receipt = previous ?? { version: 1, id, status: "preparing", projectKey: source.projectKey,
			keepWorkspaceKey: keep.workspaceKey, freshWorkspaceKey: fresh.workspaceKey,
			keepName: input.name, freshName: input.freshName, backupDir, sourceHash,
			at: new Date().toISOString(), sourceLedger: source.ledgerPath };
		if (!previous) {
			await writeFile(join(backupDir, "legacy.events.jsonl"), bytes, { flag: "wx", mode: 0o400 });
			for (const session of sessions) await writeFile(join(backupDir, "sessions", session.path.split("/").at(-1)), session.bytes, { flag: "wx", mode: 0o400 });
			await replaceResearchFile(receiptPath, `${JSON.stringify(receipt)}\n`);
		}
		// Fence earlier, cached append implementations too. The immutable legacy
		// file remains available for provenance and recovery.
		await chmod(source.ledgerPath, 0o400);
		const code = receipt.code ?? await captureResearchCode(keep.workspaceRoot, { label: "Legacy handoff" });
		receipt.code = code;
		await replaceResearchFile(receiptPath, `${JSON.stringify(receipt)}\n`);
		const migrated = await createResearchBranchBinding(keep, runtimeRoot, { name: input.name, initialize: async runtime => {
			const ledgerRecords = new Map();
			try {
				for (const line of (await readFile(join(keep.workspaceRoot, ".pi", "research", "experiments.jsonl"), "utf8")).split("\n").filter(Boolean)) {
					const record = JSON.parse(line); if (record.id) ledgerRecords.set(record.id, record);
				}
			} catch (error) { if (error.code !== "ENOENT") throw error; }
			const normalized = value => String(value ?? "").replace(/\s+/g, " ").trim();
			const copied = events.map(event => {
				const record = event.type === "evidence.recorded" ? ledgerRecords.get(event.data?.id) : null;
				const provenance = record && record.contentFingerprint && ["question", "observation", "intervention", "conclusion"].every(field => normalized(record[field]) === normalized(event.data[field]))
					? { contentFingerprint: record.contentFingerprint, idempotencyKeyHash: record.idempotencyKeyHash, sessionId: record.sessionId, sessionFile: record.sessionFile } : {};
				return { ...event, branchId: runtime.branchId, data: { ...event.data, ...provenance } };
			});
			const append = (type, data, eventId) => copied.push({ version: 1, id: eventId, type, at: receipt.at,
				projectKey: runtime.projectKey, branchId: runtime.branchId, data });
			for (const actor of snapshot.actors.filter(actor => actor.kind === "subagent" || actor.kind === "codex")) {
				append("actor.retired", { actorId: actor.id, reason: "Legacy process sessions ended at explicit handoff; results remain historical" }, `${id}:retire:${actor.id}`);
			}
			append("branch.legacy.migrated", { migrationId: id, sourceLedger: source.ledgerPath, sourceHash, sessionIds: sessions.map(session => session.id), sessions: sessions.map(session => ({ id: session.id, path: session.path })) }, id);
			append("branch.checkpoint", { id: `cp-${id}`, label: "Legacy handoff", rationale: "Preserve the retained workspace's research progress at the explicit restart handoff",
				cursor: id, revision: snapshot.revision, parents: [], code, context: { sessionId: input.sessionId ?? null, entryId: null } }, `checkpoint:${id}`);
			await replaceResearchFile(runtime.ledgerPath, copied.map(event => JSON.stringify(event)).join("\n") + "\n");
		} });
		receipt.keepBranchId = migrated.branchId;
		await replaceResearchFile(receiptPath, `${JSON.stringify(receipt)}\n`);
		const empty = await createResearchBranchBinding(fresh, runtimeRoot, { name: input.freshName,
			initialize: async runtime => replaceResearchFile(runtime.ledgerPath, "") });
		receipt.freshBranchId = empty.branchId;
		await replaceResearchFile(receiptPath, `${JSON.stringify(receipt)}\n`);
		// Only the explicitly selected, stopped Leader transcript is updated now.
		// Historical/Analysis Sessions are admitted lazily on their next open.
		for (const session of sessions.filter(session => session.id === input.sessionId)) {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const manager = SessionManager.open(session.path, sessionDir);
			const entries = manager.getBranch();
			const bound = entries.findLast(entry => entry.type === "custom" && entry.customType === "research-runtime-branch")?.data;
			if (bound?.branchId && bound.branchId !== migrated.branchId) throw new Error(`Session ${session.id} is already bound to another branch`);
			if (bound?.migrationId !== id) {
				const policy = runtimeSessionInheritancePolicy(entries, snapshot, session.id);
				manager.appendCustomEntry("research-runtime-branch", { projectKey: source.projectKey, branchId: migrated.branchId,
					workspaceKey: keep.workspaceKey, generation: 0, migrationId: id });
				manager.appendCustomEntry("research-runtime-session-policy", { policy, projectContext: runtimeSessionProjectContext(entries, policy),
					projectKey: source.projectKey, reason: "Explicit legacy branch migration", migrationId: id });
			}
			if (session.id === input.sessionId && input.handoff && !manager.getBranch().some(entry => entry.customType === "research-branch-handoff" && entry.details?.migrationId === id)) {
				manager.appendCustomMessageEntry("research-branch-handoff", input.handoff, true, { migrationId: id });
			}
		}
		if (digest(await readFile(source.ledgerPath)) !== sourceHash) throw new Error("Legacy history changed during migration; keep the handoff offline for inspection");
		receipt.status = "complete";
		await replaceResearchFile(receiptPath, `${JSON.stringify(receipt)}\n`);
		return { ...plan, ...receipt, dryRun: false };
	});
}
