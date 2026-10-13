import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withOwnerFileLock } from "./owner-file-lock.mjs";
import { getSubagentRuntimeAdapter } from "./research-runtime-adapters.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID, USER_ACTOR_ID, assertRuntimeActorAttachment, createRuntimeMessage, readRuntimeSnapshot, registerSubagentRuntimeJob,
	resolveRuntimeActor, runtimeActorBackend, settleRuntimeMessage, subagentActorId,
} from "./research-runtime.mjs";

const LIVE = new Set(["starting", "running", "input_required", "cancelling"]);
const missionKey = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function subagentBelongsToWorkspace(job, runtime) {
	if (job.projectKey && job.projectKey !== runtime.projectKey) return false;
	if (job.workspaceKey) return job.workspaceKey === runtime.workspaceKey;
	return Boolean(job.cwd && resolve(job.cwd) === resolve(runtime.cwd ?? runtime.workspaceRoot));
}

export function selectRuntimeSubagent(jobs, input) {
	if (input.reuse === "never" || !missionKey(input.mission)) return null;
	return [...jobs].reverse().find((job) =>
		(job.backend ?? "codex") === input.backend
		&& (job.role ?? job.mode ?? "general") === input.role
		&& missionKey(job.mission) === missionKey(input.mission)
		&& subagentBelongsToWorkspace(job, input.runtime)
		&& (job.researchTrackRef ?? "project:initial") === (input.researchTrackRef ?? "project:initial")
		&& job.reusable !== false
		&& (input.backend !== "codex" || LIVE.has(job.status) || job.threadId || job.status === "outcome_unknown")
	) ?? null;
}

export function subagentTaskText(input) {
	return [input.task ?? input.followUp,
		input.context ? `Context:\n${input.context}` : null,
		input.successCriteria?.length ? `Success criteria:\n${input.successCriteria.map((item) => `- ${item}`).join("\n")}` : null,
	].filter(Boolean).join("\n\n");
}

export async function queueSubagentMessage(runtime, input) {
	const snapshot = await readRuntimeSnapshot(runtime);
	const actor = resolveRuntimeActor(snapshot, input.actorId);
	if (!runtimeActorBackend(actor)) throw new Error("Select a subagent Actor");
	if (actor.metadata?.workspaceKey && actor.metadata.workspaceKey !== runtime.workspaceKey) {
		throw new Error("This subagent belongs to another workspace");
	}
	return await createRuntimeMessage(runtime, {
		from: input.from ?? USER_ACTOR_ID, to: actor.id, type: input.type ?? "notify", body: input.body,
		metadata: { workspaceKey: runtime.workspaceKey, jobId: input.jobId ?? null, requestId: input.requestId ?? null,
			...(input.answers ? { answers: input.answers } : {}), preempt: input.preempt === true },
	});
}

// Slash commands, model tools, and independent terminals use the same receipt
// and adapter path. A per-message lock prevents two observers delivering twice.
export async function deliverSubagentMessage(runtime, message, ctx) {
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withOwnerFileLock(join(runtime.projectDir, `${message.id}.delivery.lock`), async () => {
		await assertRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: ctx.sessionManager.getSessionId() });
		const snapshot = await readRuntimeSnapshot(runtime);
		const current = snapshot.messages.find((item) => item.id === message.id);
		if (!current || current.status !== "queued") return { status: current?.status ?? "missing", detail: "already handled" };
		const actor = resolveRuntimeActor(snapshot, current.to);
		if ((current.metadata?.workspaceKey && current.metadata.workspaceKey !== runtime.workspaceKey)
			|| (actor.metadata?.workspaceKey && actor.metadata.workspaceKey !== runtime.workspaceKey)) {
			return { status: "queued", detail: "waiting for the owning workspace" };
		}
		const adapter = getSubagentRuntimeAdapter(runtimeActorBackend(actor));
		if (!adapter?.dispatch) return { status: "queued", detail: "waiting for the subagent backend" };
		// Different messages for one Actor must not both resume the same terminal
		// turn. Keep per-message receipts, and serialize backend turn decisions.
		const actorLock = `${Buffer.from(actor.id).toString("hex")}.actor-delivery.lock`;
		const receipt = await withOwnerFileLock(join(runtime.projectDir, actorLock), async () => {
			await assertRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: ctx.sessionManager.getSessionId() });
			return await adapter.dispatch({ runtime, actor, message: current, ctx,
				jobId: current.metadata?.jobId ?? undefined, preempt: current.metadata?.preempt === true });
		});
		if (receipt.status === "delivered" || receipt.status === "superseded") {
			await settleRuntimeMessage(runtime, current.id, receipt.status, { actorId: actor.id });
		}
		return { ...receipt, settledByDelivery: true };
	});
}

export async function drainSubagentMailbox(runtime, ctx) {
	const snapshot = await readRuntimeSnapshot(runtime);
	const actors = new Map(snapshot.actors.map((actor) => [actor.id, actor]));
	let delivered = 0;
	for (const message of snapshot.messages) {
		if (message.status !== "queued" || !runtimeActorBackend(actors.get(message.to))) continue;
		if (message.metadata?.transport === "codex_peer") continue; // The owning worker records the native delivery receipt.
		if (message.metadata?.workspaceKey && message.metadata.workspaceKey !== runtime.workspaceKey) continue;
		const result = await deliverSubagentMessage(runtime, message, ctx);
		if (result.status === "delivered") delivered++;
	}
	return delivered;
}

// The Leader chooses whether work is related. Runtime only implements that
// choice: a named mission continues by default, and reuse=never starts fresh.
export async function dispatchRuntimeSubagent(input) {
	const { runtime, backend, ctx } = input;
	const adapter = getSubagentRuntimeAdapter(backend);
	if (!adapter?.start) throw new Error(`${backend} subagent adapter is not loaded`);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withOwnerFileLock(join(runtime.projectDir, "subagent-dispatch.lock"), async () => {
		if (input.leaderSessionId) await assertRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: input.leaderSessionId });
		const previous = input.jobId
			? await adapter.status({ ...input, jobId: input.jobId })
			: selectRuntimeSubagent(await adapter.list(input), input);
		if (previous && !subagentBelongsToWorkspace(previous, runtime)) throw new Error("The subagent belongs to another workspace");
		if (previous && input.role && input.role !== (previous.role ?? previous.mode)) throw new Error("Choose a new subagent to change its role");
		if (previous?.status === "outcome_unknown") throw new Error("Reconcile the previous subagent outcome before continuing");
		if (previous?.status === "cancelling") throw new Error("Wait for cancellation to settle before continuing this subagent");
		if (previous && LIVE.has(previous.status)) {
			if ((input.model && input.model !== previous.model) || (input.thinking && input.thinking !== (previous.thinking ?? previous.reasoningEffort))) {
				throw new Error("The subagent is running; keep its settings or start a fresh context with reuse=never");
			}
			await registerSubagentRuntimeJob(runtime, previous);
			const message = await queueSubagentMessage(runtime, {
				actorId: previous.actorId, jobId: previous.id, from: RESEARCH_LEADER_ACTOR_ID,
				type: "notify", body: subagentTaskText(input),
			});
			const receipt = await deliverSubagentMessage(runtime, message, ctx);
			return { job: await adapter.status({ ...input, jobId: previous.id }), reused: true, receipt: receipt.detail };
		}
		if (previous) {
			const job = await adapter.resume({ ...input, jobId: previous.id, previous, followUp: input.followUp ?? input.task });
			await registerSubagentRuntimeJob(runtime, job);
			return { job, reused: true, receipt: `Continued ${backend} Actor ${previous.actorId}` };
		}
		const role = input.role ?? "executor";
		const actorId = subagentActorId({ backend, role, jobId: `actor-${randomUUID().replaceAll("-", "").slice(0, 16)}` });
		const job = await adapter.start({ ...input, role, actorId,
			model: input.model ?? input.defaults.model, thinking: input.thinking ?? input.defaults.thinking,
			serviceTier: input.serviceTier ?? input.defaults.speed });
		await registerSubagentRuntimeJob(runtime, job);
		return { job, reused: false, receipt: `Started ${backend} Actor ${actorId}` };
	});
}
