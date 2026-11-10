import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withOwnerFileLock } from "./owner-file-lock.mjs";

const KEY = /^[a-z]+-[a-zA-Z0-9-]{1,80}$/;
function key(value) {
	if (!KEY.test(value ?? "")) throw new Error(`Invalid research identity: ${value}`);
	return value;
}
async function json(path) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function bindingPath(runtimeRoot, workspaceKey) {
	return join(resolve(runtimeRoot), "workspaces", `${key(workspaceKey)}.json`);
}

// Bindings are immutable in phase one. Git metadata is only used for initial
// discovery; subsequent resolutions must use the persisted project/branch IDs.
export async function readResearchBranchBinding(identity, runtimeRoot) {
	const binding = await json(bindingPath(runtimeRoot, identity.workspaceKey));
	if (!binding) return null;
	key(binding.projectKey); key(binding.branchId);
	if (binding.version !== 1 || binding.workspaceKey !== identity.workspaceKey
		|| resolve(binding.workspaceRoot) !== resolve(identity.workspaceRoot)) {
		throw new Error("Research branch binding does not match this workspace");
	}
	if (binding.workspaceIdentity) {
		try {
			const actual = await stat(binding.workspaceRoot, { bigint: true });
			if (String(actual.dev) !== binding.workspaceIdentity.dev || String(actual.ino) !== binding.workspaceIdentity.ino) throw new Error("Workspace directory was replaced; its persisted branch binding requires inspection with pi branch doctor");
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	return binding;
}

export function researchBranchContext(identity, runtimeRoot, binding = null) {
	const projectKey = binding?.projectKey ?? identity.projectKey;
	const projectDir = join(resolve(runtimeRoot), key(projectKey));
	const branchId = binding?.branchId ?? null;
	const scopeDir = branchId ? join(projectDir, "branches", key(branchId)) : projectDir;
	return { ...identity, projectKey, runtimeRoot: resolve(runtimeRoot), projectDir,
		branchId, branchName: binding?.name ?? null, scopeDir,
		ledgerPath: join(scopeDir, "events.jsonl"), legacy: !branchId };
}

export async function createResearchBranchBinding(identity, runtimeRoot, { name, initialize } = {}) {
	name = String(name ?? "").trim();
	if (!name || name.length > 120 || /\p{Cc}/u.test(name)) throw new Error("A branch name of 1–120 characters is required");
	const path = bindingPath(runtimeRoot, identity.workspaceKey);
	await mkdir(join(resolve(runtimeRoot), "workspaces"), { recursive: true, mode: 0o700 });
	return await withOwnerFileLock(`${path}.lock`, async () => {
		const existing = await readResearchBranchBinding(identity, runtimeRoot);
		if (existing) {
			if (existing.name !== name) throw new Error(`Workspace is already bound to research branch ${existing.name}; bindings cannot be switched implicitly`);
			return existing;
		}
		const directory = await stat(identity.workspaceRoot, { bigint: true });
		const binding = { version: 1, workspaceIdentity: { dev: String(directory.dev), ino: String(directory.ino) }, projectKey: identity.projectKey,
			branchId: `branch-${randomUUID()}`, name, workspaceKey: identity.workspaceKey,
			workspaceRoot: identity.workspaceRoot, createdAt: new Date().toISOString() };
		const context = researchBranchContext(identity, runtimeRoot, binding);
		await mkdir(context.scopeDir, { recursive: true, mode: 0o700 });
		// This is a derived project index. Publish the authoritative binding last.
		await writeFile(join(context.scopeDir, "branch.json"), `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: "wx" });
		// A fork's baseline must exist before its workspace binding is visible.
		if (initialize) await initialize(context, binding);
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
		return binding;
	});
}

export async function listResearchBranches(runtime, { onError } = {}) {
	let entries;
	try { entries = await readdir(join(runtime.projectDir, "branches"), { withFileTypes: true }); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
	const branches = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !KEY.test(entry.name)) continue;
		let candidate;
		try { candidate = await json(join(runtime.projectDir, "branches", entry.name, "branch.json")); }
		catch (error) { onError?.({ code: "invalid_branch_metadata", branchId: entry.name,
			path: join(runtime.projectDir, "branches", entry.name, "branch.json"), detail: error.message, repairable: false }); continue; }
		if (!candidate || candidate.projectKey !== runtime.projectKey || candidate.branchId !== entry.name) continue;
		let binding, bindingError;
		try { binding = await readResearchBranchBinding(candidate, runtime.runtimeRoot); }
		catch (error) { bindingError = error.message; }
		branches.push({ ...candidate, bindingStatus: bindingError ? "corrupt"
			: !binding ? "missing" : binding.branchId === candidate.branchId && binding.projectKey === runtime.projectKey ? "bound" : "mismatch",
			...(bindingError ? { bindingError } : {}) });
	}
	return branches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function selectResearchBranch(runtime, selector) {
	const branches = await listResearchBranches(runtime);
	const matches = branches.filter(branch => branch.branchId === selector || branch.name === selector);
	if (matches.length !== 1) throw new Error(matches.length ? "Branch name is ambiguous; use its exact branch ID" : `Unknown research branch: ${selector}`);
	return researchBranchContext({ ...matches[0], cwd: matches[0].workspaceRoot }, runtime.runtimeRoot, matches[0]);
}

export { bindingPath as researchBranchBindingPath };
