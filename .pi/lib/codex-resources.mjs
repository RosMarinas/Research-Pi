import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withOwnerFileLock } from "./owner-file-lock.mjs";

const RUN_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const JOB_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const stamp = () => new Date().toISOString();
const statePath = (jobRoot) => join(dirname(resolve(jobRoot)), "execution-resources.json");

async function readState(jobRoot) {
	try { return JSON.parse(await readFile(statePath(jobRoot), "utf8")); }
	catch (error) { if (error.code === "ENOENT") return { version: 1, claims: {}, runs: [] }; throw error; }
}

async function changeState(jobRoot, change) {
	const path = statePath(jobRoot);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	return withOwnerFileLock(`${path}.lock`, async () => {
		const state = await readState(jobRoot);
		const result = await change(state);
		const temporary = `${path}.tmp`;
		await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
		await rename(temporary, path);
		return result;
	});
}

export function normalizeResourceClaims(resources = []) {
	if (!Array.isArray(resources) || resources.length > 16) throw new Error("resourceClaims must be an array of at most 16 stable resource keys");
	return [...new Set(resources.map((key) => {
		if (typeof key !== "string" || !key.trim() || key.length > 240 || /\p{Cc}/u.test(key)) throw new Error("Invalid resource key; use a stable host/GPU or run-directory identifier");
		return key.trim();
	}))].sort();
}

async function refreshClaim(state, jobRoot, jobId) {
	const claim = state.claims[jobId];
	if (!claim) return;
	let job;
	try { job = JSON.parse(await readFile(join(jobRoot, jobId, "job.json"), "utf8")); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	// Unknown outcomes and missing workers are not proof that remote work stopped.
	if (!JOB_TERMINAL.has(job.status)) return;
	if (job.status !== "completed" && job.sideEffect?.startedAt) return;
	const active = state.runs.filter((run) => run.jobId === jobId && !RUN_TERMINAL.has(run.status));
	const held = new Set(active.flatMap((run) => run.resources));
	claim.resources = claim.resources.filter((key) => held.has(key));
	if (!claim.resources.length) delete state.claims[jobId];
}

export async function reserveCodexResources(jobRoot, jobId, input) {
	const resources = normalizeResourceClaims(input);
	if (!resources.length) return resources;
	return changeState(jobRoot, async (state) => {
		for (const owner of Object.keys(state.claims)) await refreshClaim(state, jobRoot, owner);
		for (const claim of Object.values(state.claims)) {
			const overlap = claim.resources.filter((key) => resources.includes(key));
			if (overlap.length) throw new Error(`Resource conflict with ${claim.jobId}: ${overlap.join(", ")}. Inspect its job and external runs; do not infer release from worker completion.`);
		}
		state.claims[jobId] = { jobId, resources, createdAt: stamp() };
		return resources;
	});
}

export async function releaseCodexResources(jobRoot, jobId, { beforeStart = false, note } = {}) {
	// Do not create a registry for ordinary jobs that never requested resources.
	const state = await readState(jobRoot);
	if (!state.claims[jobId]) return;
	return changeState(jobRoot, async (current) => {
		if (beforeStart) delete current.claims[jobId];
		else if (note !== undefined) {
			const job = JSON.parse(await readFile(join(jobRoot, jobId, "job.json"), "utf8"));
			if (!JOB_TERMINAL.has(job.status)) throw new Error("Resource release requires a settled worker; reconcile unknown outcomes first");
			if (typeof note !== "string" || !note.trim() || note.length > 2000) throw new Error("Resource release requires an external-state inspection note (1–2000 characters)");
			if (current.runs.some((run) => run.jobId === jobId && !RUN_TERMINAL.has(run.status))) throw new Error("Settle the registered external runs before releasing resources");
			current.releases ??= [];
			current.releases.push({ jobId, resources: current.claims[jobId]?.resources ?? [], note: note.trim(), releasedAt: stamp() });
			delete current.claims[jobId];
		}
		else await refreshClaim(current, jobRoot, jobId);
	});
}

export async function heldCodexResources(jobRoot, jobId) {
	return (await readState(jobRoot)).claims[jobId]?.resources ?? [];
}

export async function listCodexExternalRuns(jobRoot, jobId) {
	return (await readState(jobRoot)).runs.filter((run) => run.jobId === jobId);
}

export async function registerCodexExternalRun(jobRoot, jobId, input) {
	const externalId = String(input.externalId ?? "").trim();
	const target = String(input.target ?? "").trim();
	if (!externalId || externalId.length > 500 || !target || target.length > 500) throw new Error("External runs require an actual externalId and target, each at most 500 characters");
	const evidenceRefs = input.evidenceRefs;
	if (!Array.isArray(evidenceRefs) || !evidenceRefs.length || evidenceRefs.length > 8 || evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 2000)) {
		throw new Error("External runs require 1–8 existing manifest/log references; do not create a report");
	}
	return changeState(jobRoot, (state) => {
		const reserved = state.claims[jobId]?.resources ?? [];
		const resources = normalizeResourceClaims(input.resources ?? reserved);
		if (resources.some((key) => !reserved.includes(key))) throw new Error("An external run cannot claim undeclared resources; ask Pi before launching");
		const previous = state.runs.find((run) => run.jobId === jobId && run.target === target && run.externalId === externalId);
		if (previous) return previous;
		const record = { id: `run-${randomUUID()}`, jobId, externalId, target, resources, evidenceRefs, status: "running", registeredAt: stamp() };
		state.runs.push(record);
		return record;
	});
}

export async function settleCodexExternalRun(jobRoot, jobId, runId, { status, note } = {}) {
	if (!RUN_TERMINAL.has(status)) throw new Error("Run settlement requires completed, failed, or cancelled");
	if (typeof note !== "string" || !note.trim() || note.length > 2000) throw new Error("Run settlement requires a concise evidence note from actual external-state inspection");
	return changeState(jobRoot, async (state) => {
		const run = state.runs.find((item) => item.id === runId && item.jobId === jobId);
		if (!run) throw new Error("External run does not belong to this job");
		if (RUN_TERMINAL.has(run.status)) throw new Error("External run is already settled; historical results are not overwritten");
		Object.assign(run, { status, settlementNote: note.trim(), settledAt: stamp() });
		await refreshClaim(state, jobRoot, jobId);
		return run;
	});
}

export const CODEX_RUN_TOOL = {
	type: "function", name: "research_pi_run",
	description: "Track an actual external experiment independently of your turn. Register its real scheduler/job ID and existing manifest/log refs immediately after launch, especially if it may outlive you. Only declared resources can be attached. list inspects registered runs; settle requires inspected terminal evidence and never stops a process. A completed worker is not a completed experiment, and a completed experiment is not a valid scientific result. Scope, budget, and stop conditions remain those assigned by Pi. Never invent executed-code identity or create a report for this tool.",
	inputSchema: {
		type: "object", additionalProperties: false, required: ["action"],
		properties: {
			action: { type: "string", enum: ["register", "list", "settle"] },
			ownerJobId: { type: "string", description: "Optional earlier job of this same Actor and research track, for list/settle after a resume" },
			externalId: { type: "string", maxLength: 500 }, target: { type: "string", maxLength: 500 },
			resources: { type: "array", maxItems: 16, items: { type: "string", maxLength: 240 } },
			evidenceRefs: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", maxLength: 2000 } },
			runId: { type: "string" }, status: { type: "string", enum: ["completed", "failed", "cancelled"] },
			note: { type: "string", maxLength: 2000 },
		},
	},
};
