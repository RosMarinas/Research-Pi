import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import runnersExtension from "../.pi/extensions/subagent-runners.ts";
import { getSubagentRuntimeAdapter, registerRuntimeUiAdapter } from "../.pi/lib/research-runtime-adapters.mjs";
import { initializeResearchRuntime, readRuntimeEvents } from "../.pi/lib/research-runtime.mjs";

test("real runner stream batches 1000 fragments without per-token Runtime or Dock updates", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runner-stream-"));
	const keys = ["RESEARCH_PI_STATE_DIR", "PI_ANTIGRAVITY_BIN"];
	const previous = keys.map((key) => process.env[key]);
	const handlers = new Map();
	try {
		const cwd = join(root, "workspace"), stateRoot = join(root, "state"), cli = join(root, "fake-agy");
		mkdirSync(cwd);
		writeFileSync(cli, `#!/usr/bin/env node
process.stdin.on("data", () => {
 const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
 send({event:"init",conversation_id:"synthetic"});
 for (let i=0;i<1000;i++) send({event:"step_update",step_update:{step_type:"agent_response",text_delta:"x"}});
 send({event:"result",result:{status:"SUCCESS",response:"finished"}});
});
`, { mode: 0o700 });
		process.env.RESEARCH_PI_STATE_DIR = stateRoot; process.env.PI_ANTIGRAVITY_BIN = cli;
		const runtime = await initializeResearchRuntime(cwd, { sessionId: "leader" }, { runtimeRoot: join(stateRoot, "runtime", "projects") });
		const ctx = { cwd, sessionManager: { getSessionId: () => "leader" } };
		let refreshes = 0;
		registerRuntimeUiAdapter({ refresh: async () => { refreshes++; }, deliver: async () => {} });
		runnersExtension({ on(name, handler) { handlers.set(name, handler); } });
		const adapter = getSubagentRuntimeAdapter("antigravity");
		const job = await adapter.start({ backend: "antigravity", role: "environment", model: "synthetic-model", thinking: "high",
			task: "stream test", cwd, ctx, runtime, actorId: "antigravity:stream" });
		const result = await adapter.wait({ jobId: job.id, signal: AbortSignal.timeout(6000) });
		assert.equal(result.status, "completed");
		assert.equal(result.result.summary, "finished");
		const events = await readRuntimeEvents(runtime);
		assert.ok(events.filter((event) => event.type === "action.upsert").length <= 5);
		assert.ok(refreshes <= 5, `${refreshes} Dock refreshes for one turn`);
		const journal = readFileSync(join(stateRoot, "subagents", job.id, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(journal.filter((event) => event.category === "assistant_delta").map((event) => event.text).join("").length, 1000);
		assert.ok(journal.length < 10, "stream fragments should be batched, not individually persisted");
	} finally {
		await handlers.get("session_shutdown")?.();
		keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
		rmSync(root, { recursive: true, force: true });
	}
});
