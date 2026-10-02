import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createSubagentSessionManager, formatSubagentSessionJob } from "../lib/subagent-sessions.mjs";
import { createSubagentActivityWriter } from "../lib/subagent-activity.mjs";
import { subagentTaskText, subagentBelongsToWorkspace } from "../lib/runtime-subagents.mjs";
import { getRuntimeUiAdapter, registerSubagentRuntimeAdapter } from "../lib/research-runtime-adapters.mjs";
import { readRuntimeSnapshot, recordSubagentRuntimeEvent, registerSubagentRuntimeJob, resolveResearchRuntime, runtimeMessageText, subagentActorId } from "../lib/research-runtime.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "input_required"]);

export default function subagentRunnersExtension(pi: ExtensionAPI) {
	const contexts = new Map<string, ExtensionContext>();
	const runtimes = new Map<string, any>();
	const writers = new Map<string, ReturnType<typeof createSubagentActivityWriter>>();
	const fingerprints = new Map<string, string>();
	const deliveredTurns = new Set<string>();
	const stateRoot = resolve(process.env.RESEARCH_PI_STATE_DIR ?? ".pi");
	const manager = createSubagentSessionManager({
		coreCli: process.env.RESEARCH_PI_CORE_CLI, stateRoot,
		boundaryExtension: process.env.RESEARCH_PI_HARNESS_ROOT ? join(process.env.RESEARCH_PI_HARNESS_ROOT, ".pi", "extensions", "project-boundary.ts") : undefined,
		onUpdate: async (job: any, event: any) => {
			const ctx = contexts.get(job.id);
			if (!ctx) return;
			const writer = writers.get(job.id);
			writer?.append(job, event);
			const fingerprint = JSON.stringify([job.status, job.turn, job.model, job.thinking, job.backendSessionId]);
			const changed = fingerprint !== fingerprints.get(job.id);
			if (changed) {
				fingerprints.set(job.id, fingerprint);
				await registerSubagentRuntimeJob(runtimes.get(job.id), job);
			}
			// Text deltas stay in the batched display journal. The Leader Dock only
			// refreshes for lifecycle changes or completed/started tools, not each token.
			if (changed || event?.type === "tool") await getRuntimeUiAdapter()?.refresh(ctx, { backend: job.backend, jobs: manager.list(job.backend) });
			if (!TERMINAL.has(job.status)) return;
			await writer?.flush();
			const turnKey = `${job.id}:${job.turn}:${job.status}`;
			if (deliveredTurns.has(turnKey)) return;
			deliveredTurns.add(turnKey);
			const message = await recordSubagentRuntimeEvent(runtimes.get(job.id), job, formatSubagentSessionJob(job));
			if (message) await getRuntimeUiAdapter()?.deliver(ctx, { messageId: message.id });
		},
	});
	const start = async (input: any) => {
		const backend = String(input.backend).toLowerCase();
		const id = `${backend}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const actorId = input.actorId ?? subagentActorId({ backend, jobId: id, role: input.role });
		const runtime = input.runtime ?? await resolveResearchRuntime(input.ctx.cwd);
		contexts.set(id, input.ctx); runtimes.set(id, runtime);
		const activityPath = join(stateRoot, "subagents", id, "events.jsonl");
		writers.set(id, createSubagentActivityWriter(activityPath));
		return await manager.start({ ...input, id, actorId, activityPath, workspaceKey: runtime.workspaceKey,
			projectKey: runtime.projectKey, task: subagentTaskText(input) });
	};
	for (const backend of ["pi", "antigravity"]) {
		registerSubagentRuntimeAdapter(backend, {
			start,
			resume: async (input: any) => {
				contexts.set(input.jobId, input.ctx); runtimes.set(input.jobId, input.runtime);
				return await manager.resume(input.jobId, { ...input, followUp: subagentTaskText({ ...input, task: input.followUp }) });
			},
			status: async ({ jobId }: any) => manager.get(jobId),
			result: async ({ jobId }: any) => manager.get(jobId),
			wait: async ({ jobId, signal }: any) => await manager.wait(jobId, signal),
			cancel: async ({ jobId }: any) => await manager.cancel(jobId),
			list: () => manager.list(backend),
			dispatch: async ({ runtime, actor, message, jobId, ctx }: any) => {
				const job = jobId ? manager.list(backend).find((job: any) => job.id === jobId) : manager.getByActor(actor.id);
				if (!job) return { status: "queued", detail: "The owning Pi process is not connected" };
				if (!subagentBelongsToWorkspace(job, runtime)) throw new Error("This subagent belongs to another workspace");
				contexts.set(job.id, ctx); runtimes.set(job.id, runtime);
				const body = runtimeMessageText(message, (await readRuntimeSnapshot(runtime)).actors);
				return await manager.send(actor.id, { ...message, body }, { jobId: job.id });
			},
		});
	}
	pi.on("session_shutdown", async () => {
		await manager.dispose();
		await Promise.all([...writers.values()].map((writer) => writer.flush()));
		contexts.clear(); runtimes.clear(); writers.clear(); fingerprints.clear();
	});
}
