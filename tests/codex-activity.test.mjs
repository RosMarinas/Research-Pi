import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexWatchExtension from "../.pi/extensions/codex-watch.ts";
import {
	CodexActivityCursor,
	compactCodexAuditEvent,
	projectCodexActivityUpdate,
	projectCodexAgents,
} from "../.pi/lib/codex-activity.mjs";

test("Codex Watch registers one on-demand TUI command", () => {
	let registered;
	codexWatchExtension({
		registerCommand(name, definition) {
			registered = { name, definition };
		},
	});
	assert.equal(registered.name, "watch");
	assert.match(registered.definition.description, /objective Codex execution/);
});

test("objective Codex activity keeps bounded command evidence and protects sensitive output", () => {
	const command = compactCodexAuditEvent({
		method: "item/completed",
		params: {
			threadId: "thread-root",
			turnId: "turn-root",
			item: {
				id: "command-1",
				type: "commandExecution",
				status: "completed",
				command: "python3 remote_run.py status",
				cwd: "/workspace",
				exitCode: 0,
				durationMs: 1234,
				aggregatedOutput: "API_KEY=should-not-be-visible",
			},
		},
	}, { timestamp: "2026-08-15T00:00:00.000Z" });
	assert.equal(command.category, "command");
	assert.equal(command.exitCode, 0);
	assert.equal(command.durationMs, 1234);
	assert.match(command.summary, /remote_run\.py status/);
	assert.equal(command.outputTail, "[protected command output]");
});

test("leaf completion projects as last activity, not job lifecycle completion", () => {
	const update = projectCodexActivityUpdate({
		method: "item/completed",
		params: {
			threadId: "thread-root",
			turnId: "turn-root",
			item: {
				id: "tool-1",
				type: "dynamicToolCall",
				tool: "research_pi_host",
				status: "completed",
				success: true,
			},
		},
	}, { timestamp: "2026-08-20T00:00:00.000Z" });
	assert.equal(update.phase, "completed");
	assert.equal(update.activity.id, "tool-1");
	assert.equal(update.activity.category, "tool");
	assert.equal(update.activity.status, "completed");
	assert.equal(update.activity.summary, "research_pi_host · completed");
	assert.equal(Object.hasOwn(update.activity, "jobStatus"), false);
});

test("Codex collaboration events project internal subagents without creating Runtime Actors", () => {
	const spawn = compactCodexAuditEvent({
		method: "item/completed",
		params: {
			threadId: "thread-root",
			turnId: "turn-root",
			item: {
				id: "collab-1",
				type: "collabAgentToolCall",
				tool: "spawnAgent",
				status: "completed",
				senderThreadId: "thread-root",
				receiverThreadIds: ["thread-child"],
				agentsStates: { "thread-child": { status: "running", message: "checking implementation" } },
				model: "gpt-5.6-luna",
				reasoningEffort: "high",
				prompt: "Inspect the rank calculation",
			},
		},
	}, { timestamp: "2026-08-15T00:00:01.000Z" });
	assert.equal(spawn.category, "subagent");
	const agents = projectCodexAgents([spawn]);
	assert.equal(agents.length, 1);
	assert.equal(agents[0].threadId, "thread-child");
	assert.equal(agents[0].status, "running");
	assert.equal(agents[0].model, "gpt-5.6-luna");
});

test("Codex activity cursor tails only new objective records", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-activity-"));
	try {
		const path = join(root, "events.jsonl");
		writeFileSync(path, `${JSON.stringify({ timestamp: "2026-08-15T00:00:00.000Z", category: "lifecycle", summary: "Codex turn started" })}\n`);
		const cursor = new CodexActivityCursor(path);
		assert.equal((await cursor.poll()).length, 1);
		appendFileSync(path, `${JSON.stringify({ timestamp: "2026-08-15T00:00:01.000Z", category: "search", summary: "web search: test" })}\n`);
		assert.equal((await cursor.poll()).length, 2);
		assert.equal((await cursor.poll()).length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
