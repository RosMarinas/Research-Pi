import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createSubagentSessionManager, formatSubagentSessionJob } from "../lib/subagent-sessions.mjs";
import { createSubagentActivityWriter } from "../lib/subagent-activity.mjs";
import { subagentTaskText, subagentBelongsToWorkspace } from "../lib/runtime-subagents.mjs";
import { getHostCapabilityUiAdapter, getRuntimeUiAdapter, registerSubagentRuntimeAdapter } from "../lib/research-runtime-adapters.mjs";
import { readRuntimeSnapshot, recordSubagentRuntimeEvent, registerSubagentRuntimeJob, resolveResearchRuntime, runtimeMessageText, subagentActorId, runtimeActorAttachment, RESEARCH_LEADER_ACTOR_ID } from "../lib/research-runtime.mjs";
import { createSubagentOwners } from "../lib/subagent-owners.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "input_required"]);

export default function subagentRunnersExtension(pi: ExtensionAPI) {
	const owners = createSubagentOwners();
	const runtimes = new Map<string, any>();
	const writers = new Map<string, ReturnType<typeof createSubagentActivityWriter>>();
	const fingerprints = new Map<string, string>();
	const deliveredTurns = new Map<string, string>();
	const unregisterAdapters: Array<() => void> = [];
	let approvalQueue: Promise<unknown> = Promise.resolve();
	const stateRoot = resolve(process.env.RESEARCH_PI_STATE_DIR ?? ".pi");
	const manager = createSubagentSessionManager({
		coreCli: process.env.RESEARCH_PI_CORE_CLI, stateRoot,
		boundaryExtension: process.env.RESEARCH_PI_HARNESS_ROOT ? join(process.env.RESEARCH_PI_HARNESS_ROOT, ".pi", "extensions", "project-boundary.ts") : undefined,
		canHibernate: async (job: any) => {
			const runtime = runtimes.get(job.id);
			if (!runtime) return false;
			const snapshot = await readRuntimeSnapshot(runtime);
			const ctx = owners.context(job.id);
			if (!ctx || !runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId())) return false;
			const settled = new Set(["completed", "failed", "cancelled"]);
			return !snapshot.messages.some(message => message.to === job.actorId && message.status === "queued")
				&& snapshot.actions.filter(action => action.actorId === job.actorId).every(action => settled.has(action.status)
					&& !(action.metadata?.externalRuns ?? []).some(run => !settled.has(run.status)));
		},
		onUiRequest: async (job: any, request: any, { signal }: any = {}) => {
			const review = async () => {
				signal?.throwIfAborted();
				const ctx = owners.context(job.id);
				if (request.method === "host_capability") {
					const adapter = getHostCapabilityUiAdapter();
					if (!ctx || !adapter) return { error: "Leader capability review is unavailable" };
					const reviewCtx = { ...ctx, ui: { ...ctx.ui, select: (title: string, choices: string[], options: any) =>
						ctx.ui.select(`${job.backend}/${job.role} · ${job.mission ?? job.id}\n${title}`, choices, options) } };
					return { decision: await adapter.review({ job, pendingRequest: request.pendingRequest, ctx: reviewCtx, signal }) };
				}
				if (!ctx?.hasUI) return { cancelled: true };
				const title = `${job.backend}/${job.role} · ${job.mission ?? job.id}\n${request.title ?? ""}`;
				if (request.method === "confirm") return { confirmed: await ctx.ui.confirm(title, request.message ?? "", { signal }) };
				const value = request.method === "select" ? await ctx.ui.select(title, request.options ?? [], { signal })
					: request.method === "editor" ? await ctx.ui.editor(title, request.prefill ?? "")
					: await ctx.ui.input(title, request.placeholder, { signal });
				return value === undefined ? { cancelled: true } : { value };
			};
			const pending = approvalQueue.then(review, review);
			approvalQueue = pending.catch(() => undefined);
			return await pending;
		},
		onUpdate: async (job: any, event: any) => {
			const ownership = owners.token(job.id);
			const ctx = owners.context(job.id);
			if (!ctx) return;
			const runtime = runtimes.get(job.id);
			if (!runtime) return;
			let writer = writers.get(job.id);
			if (!writer && job.residency === "warm") { writer = createSubagentActivityWriter(join(stateRoot, "subagents", job.id, "events.jsonl")); writers.set(job.id, writer); }
			await writer?.append(job, event);
			const fingerprint = JSON.stringify([job.status, job.turn, job.residency, job.model, job.thinking, job.backendSessionId, job.nativeTerminal, job.pendingRequest?.id]);
			const changed = fingerprint !== fingerprints.get(job.id);
			if (changed) {
				fingerprints.set(job.id, fingerprint);
				await registerSubagentRuntimeJob(runtime, job);
			}
			// Text deltas stay in the batched display journal. The Leader Dock only
			// refreshes for lifecycle changes or completed/started tools, not each token.
			if (changed || (event?.type === "tool" && (event.phase === "completed" || event.args))) await getRuntimeUiAdapter()?.refresh(ctx, { backend: job.backend, jobs: manager.list(job.backend) });
			if (!TERMINAL.has(job.status)) return;
			if (job.pendingRequest?.route === "leader") return;
			await writer?.flush();
			const turnKey = `${job.id}:${job.turn}:${job.status}:${job.pendingRequest?.id ?? ""}`;
			try {
				if (deliveredTurns.get(job.id) === turnKey) return;
				deliveredTurns.set(job.id, turnKey);
				const message = await recordSubagentRuntimeEvent(runtime, job);
				if (message) await getRuntimeUiAdapter()?.deliver(ctx, { messageId: message.id });
			} finally {
				if (["cold", "closed"].includes(job.residency)) { writers.delete(job.id); owners.release(job.id, ownership); }
				if (job.residency === "closed") { runtimes.delete(job.id); fingerprints.delete(job.id); }
			}
		},
	});
	const start = async (input: any) => {
		const backend = String(input.backend).toLowerCase();
		const id = `${backend}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const actorId = input.actorId ?? subagentActorId({ backend, jobId: id, role: input.role });
		const runtime = input.runtime ?? await resolveResearchRuntime(input.ctx.cwd);
		owners.remember(id, input.ctx); runtimes.set(id, runtime);
		const activityPath = join(stateRoot, "subagents", id, "events.jsonl");
		writers.set(id, createSubagentActivityWriter(activityPath));
		return await manager.start({ ...input, id, actorId, activityPath, workspaceKey: runtime.workspaceKey,
			projectKey: runtime.projectKey, branchId: runtime.branchId, task: subagentTaskText(input) });
	};
	for (const backend of ["pi", "antigravity"]) {
		unregisterAdapters.push(registerSubagentRuntimeAdapter(backend, {
			start,
			retire: async ({ jobId }: any) => {
				const ctx = owners.context(jobId);
				await manager.retire(jobId);
				await writers.get(jobId)?.flush();
				owners.release(jobId); runtimes.delete(jobId); writers.delete(jobId); fingerprints.delete(jobId); deliveredTurns.delete(jobId);
				if (ctx) await getRuntimeUiAdapter()?.refresh(ctx, { backend, jobs: manager.list(backend) });
			},
			resume: async (input: any) => {
				return await manager.resume(input.jobId, { ...input, followUp: subagentTaskText({ ...input, task: input.followUp }), onReady: () => {
					owners.remember(input.jobId, input.ctx); runtimes.set(input.jobId, input.runtime);
					if (!writers.has(input.jobId)) writers.set(input.jobId, createSubagentActivityWriter(join(stateRoot, "subagents", input.jobId, "events.jsonl")));
				} });
			},
			status: async ({ jobId }: any) => manager.get(jobId),
			result: async ({ jobId }: any) => manager.readResult(jobId),
			wait: async ({ jobId, signal }: any) => await manager.wait(jobId, signal),
			cancel: async ({ jobId }: any) => await manager.cancel(jobId),
			list: () => manager.list(backend),
			dispatch: async ({ runtime, actor, message, jobId, ctx }: any) => {
				const job = jobId ? manager.list(backend).find((job: any) => job.id === jobId) : manager.getByActor(actor.id);
				if (!job) return { status: "queued", detail: "The owning Pi process is not connected" };
				if (!subagentBelongsToWorkspace(job, runtime)) throw new Error("This subagent belongs to another workspace");
				const body = runtimeMessageText(message, (await readRuntimeSnapshot(runtime)).actors);
				return await manager.send(actor.id, { ...message, body }, { jobId: job.id, onReady: () => {
					owners.remember(job.id, ctx); runtimes.set(job.id, runtime);
					if (!writers.has(job.id)) writers.set(job.id, createSubagentActivityWriter(join(stateRoot, "subagents", job.id, "events.jsonl")));
				} });
			},
		}));
	}
	pi.on("session_shutdown", async () => {
		await manager.dispose();
		await Promise.all([...writers.values()].map((writer) => writer.flush()));
		owners.clear(); runtimes.clear(); writers.clear(); fingerprints.clear(); deliveredTurns.clear();
		for (const unregister of unregisterAdapters) unregister();
	});
}
