import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initializeResearchRuntime, registerSubagentRuntimeJob, readRuntimeSnapshot } from "../.pi/lib/research-runtime.mjs";
import { createSubagentWatchClient, openSubagentTerminal, subagentWatchTranscript } from "../.pi/lib/subagent-watch.mjs";
import { SubagentWatchView, openSubagentWatch } from "../.pi/lib/subagent-watch-ui.mjs";
import { createSubagentActivityWriter } from "../.pi/lib/subagent-activity.mjs";

test("a separate watch client observes the same Actor and queues User messages without claiming Leader ownership", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-watch-"));
	try {
		const cwd = join(root, "workspace"), stateRoot = join(root, "state"); mkdirSync(cwd);
		const runtime = await initializeResearchRuntime(cwd, { sessionId: "leader" }, { runtimeRoot: join(stateRoot, "runtime", "projects") });
		const job = { id: "pi-watch-1", actorId: "pi:watch", backend: "pi", role: "general", model: "provider/model", thinking: "high", status: "running", cwd,
			workspaceKey: runtime.workspaceKey, projectKey: runtime.projectKey };
		await registerSubagentRuntimeJob(runtime, job);
		await registerSubagentRuntimeJob(runtime, { ...job, id: "pi-foreign", actorId: "pi:foreign", workspaceKey: "another-worktree" });
		const writer = createSubagentActivityWriter(join(stateRoot, "subagents", job.id, "events.jsonl"));
		writer.append(job, { type: "assistant", text: "## Observation\n\nThe targeted check passed." }); await writer.flush();
		const client = await createSubagentWatchClient({ cwd, stateRoot });
		assert.equal((await client.list()).length, 1);
		const before = statSync(runtime.ledgerPath).size;
		const view = await client.read(job.actorId);
		await client.read(job.actorId);
		assert.equal(statSync(runtime.ledgerPath).size, before, "viewing never writes a heartbeat or steals the Leader");
		assert.match(subagentWatchTranscript(view)[0].text, /targeted check passed/);
		await client.send(view.actor, "Please explain the evidence", "ask");
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.attachments.find((item) => item.actorId === "research-leader").sessionId, "leader");
		assert.equal(snapshot.messages.at(-1).from, "user");
		assert.equal(snapshot.messages.at(-1).to, job.actorId);
		assert.equal(snapshot.messages.at(-1).status, "queued");
		const previous = process.env.RESEARCH_PI_STATE_DIR;
		try {
			process.env.RESEARCH_PI_STATE_DIR = stateRoot;
			let overlay;
			await openSubagentWatch({ cwd, ui: { select: async () => "Switch in this terminal", notify: (message) => { throw new Error(message); }, custom: async (_factory, options) => { overlay = options; } } }, job.actorId);
			assert.deepEqual(overlay, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } });
		} finally { if (previous === undefined) delete process.env.RESEARCH_PI_STATE_DIR; else process.env.RESEARCH_PI_STATE_DIR = previous; }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the full-terminal watch reuses Pi chat components, identifies the backend, and sends direct user input", async () => {
	initTheme("dark");
	const sent = [];
	const actor = { id: "pi:watch", label: "worker", backend: "pi", role: "executor", model: "provider/model", thinking: "high", metadata: { mission: "validation" } };
	const data = { actor, actors: [actor], job: { status: "completed", model: actor.model, thinking: actor.thinking, result: { summary: "Validation passed." } }, events: [], messages: [], leaderConnected: true };
	const client = { read: async () => data, send: async (_actor, body, type) => { sent.push({ body, type }); return { id: "message-1" }; } };
	let closed = false;
	const ui = new SubagentWatchView({ terminal: { rows: 30, columns: 80 }, requestRender() {} }, client, actor.id, () => { closed = true; });
	try {
		await new Promise((done) => setImmediate(done));
		const rows = ui.render(80);
		assert.equal(rows.length, 30, "watch fits exactly within the terminal height");
		assert.ok(rows.every((row) => visibleWidth(row) <= 80));
		const text = stripTerminalSequences(rows.join("\n"));
		assert.match(text, /pi · executor/);
		assert.match(text, /provider\/model · thinking high/);
		assert.match(text, /Validation passed/);
		for (const width of [20, 37, 80, 120]) assert.ok(ui.render(width).every(row => visibleWidth(row) <= width));
		ui.editor.setText("unsent draft"); ui.handleInput("\x04");
		assert.equal(closed, false, "Ctrl+D with a draft must not leave the viewer");
		ui.handleInput("\x03"); assert.equal(ui.editor.getText(), "");
		ui.tui.terminal.rows = 8; ui.editor.setText("line\n".repeat(12));
		assert.equal(ui.render(20).length, 8, "short phone viewport still fits a multiline editor");
		ui.tui.terminal.rows = 30; ui.editor.setText("");
		await ui.submit("/reply Continue the check");
		assert.deepEqual(sent, [{ body: "Continue the check", type: "reply" }]);
		ui.handleInput("\x1b");
		assert.equal(closed, true);
	} finally { ui.dispose(); }
});

test("new-terminal launch passes literal paths and does not start another model session", async () => {
	const calls = [];
	const options = { launcher: "/tmp/a'b/bin/pi.mjs", cwd: "/tmp/project $(literal)", stateRoot: "/tmp/private state", actorId: "codex:actor" };
	const result = await openSubagentTerminal(options, { platform: "darwin", environment: {}, exec: async (...args) => calls.push(args) });
	assert.equal(result.opened, true);
	assert.equal(calls[0][0], "osascript");
	assert.equal(calls[0][1].at(-1), result.command);
	assert.match(result.command, /'watch'/);
	assert.match(result.command, /'"'"'/);
	assert.ok(result.command.includes("'/tmp/project $(literal)'"));
	assert.doesNotMatch(result.command, /--resume|--model/);
});

test("streamed display text is batched without persisting raw provider events", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-watch-stream-"));
	try {
		const path = join(root, "events.jsonl"), writer = createSubagentActivityWriter(path);
		for (let i = 0; i < 1000; i++) writer.append({ turn: 1 }, { type: "progress", raw: { step_type: "agent_response", text_delta: "x", unused: "provider-internals" } });
		await writer.flush();
		const lines = readFileSync(path, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).text.length, 1000);
		assert.doesNotMatch(lines[0], /provider-internals|unused/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
