import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
	buildAntigravityRunnerArgs,
	buildPiRunnerArgs,
	createSubagentSessionManager,
} from "../.pi/lib/subagent-sessions.mjs";

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.input = [];
	child.stdin = new Writable({
		write(chunk, _encoding, callback) {
			child.input.push(chunk.toString());
			callback();
		},
	});
	child.kill = (signal = "SIGTERM") => {
		queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	return child;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Pi and Antigravity runner arguments expose model and thinking without a second catalog", () => {
	const pi = buildPiRunnerArgs({
		id: "pi-demo", role: "general", sessionDir: "/tmp/pi-sessions", sessionId: "session-1",
		model: "opencode-go/deepseek-v4-flash", thinking: "max", boundaryExtension: "/harness/project-boundary.ts",
	});
	assert.deepEqual(pi.slice(0, 2), ["--mode", "rpc"]);
	assert.ok(pi.includes("opencode-go/deepseek-v4-flash"));
	assert.ok(pi.includes("max"));
	assert.ok(pi.includes("/harness/project-boundary.ts"));
	assert.ok(pi.includes("--append-system-prompt"));
	assert.equal(pi.includes("--no-context-files"), false);

	const agy = buildAntigravityRunnerArgs({ role: "environment", model: "gemini-3.1-pro-high", thinking: "high" });
	assert.deepEqual(agy.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
	assert.ok(agy.includes("gemini-3.1-pro-high"));
	assert.ok(agy.includes("high"));
	assert.ok(agy.includes("--sandbox"));
	assert.ok(agy.includes("--dangerously-skip-permissions"));
	assert.equal(buildAntigravityRunnerArgs({ role: "advisor", model: "gemini-3.1-pro-high", thinking: "high" }).includes("--dangerously-skip-permissions"), false);
});

test("Antigravity stream-json keeps one Actor session and accepts direct follow-up messages", async (t) => {
	const children = [];
	const updates = [];
	let spawnOptions;
	const previousSecret = process.env.RESEARCH_PI_TEST_TOKEN;
	process.env.RESEARCH_PI_TEST_TOKEN = "must-not-reach-antigravity";
	t.after(() => {
		if (previousSecret === undefined) delete process.env.RESEARCH_PI_TEST_TOKEN;
		else process.env.RESEARCH_PI_TEST_TOKEN = previousSecret;
	});
	const manager = createSubagentSessionManager({
		coreCli: "/fake/pi-cli.js",
		stateRoot: "/tmp/research-pi-test-state",
		spawn(_command, _args, options) { spawnOptions = options; const child = fakeChild(); children.push(child); return child; },
		onUpdate: async (job, event) => updates.push({ job, event }),
	});
	const job = await manager.start({
		id: "antigravity-demo", actorId: "antigravity:demo:environment", backend: "antigravity",
		role: "environment", model: "gemini-3.1-pro-high", thinking: "high", cwd: "/tmp", task: "configure the SDK",
	});
	assert.equal(job.status, "running");
	assert.equal(spawnOptions.env.RESEARCH_PI_TEST_TOKEN, undefined);
	assert.match(children[0].input[0], /configure the SDK/);
	const queued = await manager.send(job.actorId, { from: "user", body: "wait for the installation" }, { jobId: job.id });
	assert.equal(queued.status, "queued", "Runtime owns deferred Antigravity messages, not a second in-process mailbox");
	assert.equal(children[0].input.length, 1);
	await assert.rejects(manager.start({ id: "antigravity-other", actorId: job.actorId, backend: "antigravity", cwd: "/tmp", task: "duplicate" }), /already has a session/);
	await assert.rejects(manager.send("antigravity:another", { body: "misdirected" }, { jobId: job.id }), /does not belong/);
	children[0].stdout.write(`${JSON.stringify({ event: "init", conversation_id: "conversation-1", init: {} })}\n`);
	children[0].stdout.write(`${JSON.stringify({ event: "result", result: { conversation_id: "conversation-1", status: "SUCCESS", response: "configured", usage: {} } })}\n`);
	await tick();
	assert.equal(manager.get(job.id).status, "completed");
	assert.equal(manager.get(job.id).backendSessionId, "conversation-1");

	const receipt = await manager.send(job.actorId, { type: "notify", body: "verify the installation" });
	assert.equal(receipt.status, "delivered");
	assert.equal(manager.get(job.id).status, "running");
	assert.match(children[0].input.at(-1), /verify the installation/);
	children[0].stdout.write(`${JSON.stringify({ event: "result", result: { conversation_id: "conversation-1", status: "SUCCESS", response: "verified", usage: {} } })}\n`);
	await tick();
	assert.equal(manager.get(job.id).turn, 2);
	assert.notEqual(manager.get(job.id).actionId, job.actionId, "each turn is a new Action on the same Actor");
	assert.equal(manager.get(job.id).result.summary, "verified");
	assert.ok(updates.some((item) => item.event?.type === "done"));
	await manager.dispose();
});

test("runner event projection remains ordered while Runtime updates await disk", async () => {
	const child = fakeChild(), seen = [];
	const manager = createSubagentSessionManager({
		spawn: () => child,
		onUpdate: async (job) => { await tick(); seen.push(`${job.turn}:${job.status}`); },
	});
	try {
		const job = await manager.start({ id: "antigravity-ordered", actorId: "antigravity:ordered", backend: "antigravity", cwd: "/tmp", task: "inspect" });
		child.stdout.write([
			{ event: "init", conversation_id: "one" },
			{ event: "step_update", step_update: { step_type: "agent_response", text_delta: "observed" } },
			{ event: "result", result: { status: "SUCCESS", response: "done" } },
		].map(JSON.stringify).join("\n") + "\n");
		const done = await manager.wait(job.id);
		assert.equal(done.result.summary, "done");
		assert.equal(seen.at(-1), "1:completed");
		await manager.resume(job.id, { followUp: "continue" });
		assert.equal(manager.get(job.id).turn, 2);
		assert.equal(seen.at(-1), "2:running");
	} finally { await manager.dispose(); }
});

test("Pi RPC maps a direct user message to safe-boundary steering in the live isolated runner", async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "research-pi-runner-"));
	const children = [];
	const manager = createSubagentSessionManager({
		coreCli: "/fake/pi-cli.js",
		stateRoot,
		spawn() { const child = fakeChild(); children.push(child); return child; },
	});
	try {
		const job = await manager.start({
			id: "pi-demo", actorId: "pi:demo:general", backend: "pi", role: "general",
			model: "opencode-go/deepseek-v4-flash", thinking: "max", cwd: "/tmp", task: "inspect the alternative",
		});
		const initial = JSON.parse(children[0].input[0]);
		assert.equal(initial.type, "prompt");
		assert.equal(initial.message, "inspect the alternative");
		assert.equal(JSON.parse(children[0].input[1]).type, "get_state");
		children[0].stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "Outside project" })}\n`);
		await tick();
		assert.deepEqual(JSON.parse(children[0].input.at(-1)), { type: "extension_ui_response", id: "approval-1", cancelled: true });
		await manager.send(job.actorId, { type: "notify", body: "focus on the failing assumption" });
		const steer = JSON.parse(children[0].input.at(-1));
		assert.equal(steer.type, "steer");
		children[0].stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "deepseek-v4-flash", content: [{ type: "text", text: "assumption isolated" }] } })}\n`);
		children[0].stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
		await tick();
		assert.equal(manager.get(job.id).status, "completed");
		assert.equal(manager.get(job.id).model, "opencode-go/deepseek-v4-flash");
		assert.equal(manager.get(job.id).result.summary, "assumption isolated");
		const inherited = await manager.start({ id: "pi-inherited", actorId: "pi:inherited", backend: "pi", cwd: "/tmp", task: "inspect" });
		children[1].stdout.write(`${JSON.stringify({ type: "response", command: "get_state", success: true,
			data: { model: { provider: "provider", id: "selected-model" }, thinkingLevel: "high" } })}\n`);
		await tick();
		assert.equal(manager.get(inherited.id).model, "provider/selected-model");
		assert.equal(manager.get(inherited.id).thinking, "high", "show effective inherited settings instead of hiding them behind inherit");
	} finally {
		await manager.dispose();
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
