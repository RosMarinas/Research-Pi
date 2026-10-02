import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeResearchRuntime, readRuntimeSnapshot } from "../.pi/lib/research-runtime.mjs";
import { registerSubagentRuntimeAdapter } from "../.pi/lib/research-runtime-adapters.mjs";
import { dispatchRuntimeSubagent, queueSubagentMessage, drainSubagentMailbox } from "../.pi/lib/runtime-subagents.mjs";

for (const backend of ["codex", "pi", "antigravity"]) {
	test(`${backend}: Runtime owns reuse, fresh contexts, direct messages, and captured settings`, async () => {
		const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-subagents-"));
		try {
			const cwd = join(root, "workspace"); mkdirSync(cwd);
			const runtime = await initializeResearchRuntime(cwd, { sessionId: "leader" }, { runtimeRoot: join(root, "runtime") });
			const ctx = { sessionManager: { getSessionId: () => "leader" } };
			const jobs = [], received = [];
			registerSubagentRuntimeAdapter(backend, {
				list: () => jobs,
				status: async ({ jobId }) => jobs.find((job) => job.id === jobId),
				start: async (input) => { const job = { ...input, id: `${backend}-${jobs.length}`, status: "running", threadId: "synthetic-thread" }; jobs.push(job); return job; },
				resume: async (input) => { const job = jobs.find((job) => job.id === input.jobId); job.status = "running"; job.model = input.model ?? job.model; job.thinking = input.thinking ?? job.thinking; return job; },
				dispatch: async ({ message, jobId }) => { received.push({ message, jobId }); return { status: "delivered", detail: "accepted without a Leader model turn" }; },
			});
			const input = { runtime, cwd, workspaceKey: runtime.workspaceKey, projectKey: runtime.projectKey, backend, role: "executor", mission: "implementation",
				task: "implement", defaults: { model: "model-a", thinking: "high" }, ctx, leaderSessionId: "leader" };
			const first = await dispatchRuntimeSubagent(input);
			assert.equal((await readRuntimeSnapshot(runtime)).messages.length, 0, "starting a worker is a lifecycle operation, not a mailbox message");
			const continuing = await dispatchRuntimeSubagent({ ...input, task: "also check the boundary" });
			assert.equal(jobs.length, 1);
			assert.equal(continuing.job.id, first.job.id);
			assert.equal(received[0].message.body, "also check the boundary");
			assert.equal(received[0].message.from, "research-leader");
			jobs[0].status = "completed";
			await dispatchRuntimeSubagent({ ...input, task: "verify", defaults: { model: "model-b", thinking: "low" } });
			assert.equal(jobs[0].model, "model-a");
			assert.equal(jobs[0].thinking, "high");
			const fresh = await dispatchRuntimeSubagent({ ...input, reuse: "never" });
			assert.notEqual(fresh.job.actorId, first.job.actorId);
			const other = await dispatchRuntimeSubagent({ ...input, mission: "independent review" });
			assert.notEqual(other.job.actorId, first.job.actorId);
			const message = await queueSubagentMessage(runtime, { actorId: first.job.actorId, body: "User correction", type: "steer" });
			assert.equal(await drainSubagentMailbox(runtime, ctx), 1);
			assert.equal(await drainSubagentMailbox(runtime, ctx), 0);
			assert.equal(received.at(-1).message.from, "user");
			assert.equal((await readRuntimeSnapshot(runtime)).messages.find((entry) => entry.id === message.id).status, "delivered");
			const parallel = await Promise.all([dispatchRuntimeSubagent({ ...input, mission: "one owner", task: "first" }), dispatchRuntimeSubagent({ ...input, mission: "one owner", task: "next" })]);
			assert.equal(parallel[0].job.actorId, parallel[1].job.actorId);
			assert.equal(jobs.filter((job) => job.mission === "one owner").length, 1);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
