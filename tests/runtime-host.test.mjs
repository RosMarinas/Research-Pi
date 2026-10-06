import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { createResearchSessionRuntime } from "../.pi/lib/runtime-factory.mjs";
import { createRuntimeHost } from "../.pi/lib/runtime-host.mjs";
import { RuntimeClient } from "../.pi/lib/runtime-client.mjs";
import { createRuntimeGateway } from "../.pi/lib/runtime-gateway.mjs";
import { createRuntimeInteractions } from "../.pi/lib/runtime-interactions.mjs";
import { registerRuntimeUiAdapter, getRuntimeUiAdapter } from "../.pi/lib/research-runtime-adapters.mjs";
import researchMode from "../.pi/extensions/research-mode.ts";

async function until(condition) {
	const end = Date.now() + 4000;
	while (!condition()) { if (Date.now() > end) throw new Error("Expected state was not reached"); await new Promise((r) => setTimeout(r, 10)); }
}

async function fixture(responses, tools = [], factories = [], extraArgs = []) {
	const root = await mkdtemp(join(tmpdir(), "rpi-runtime-test-")), sessionDir = join(root, "sessions"); await mkdir(sessionDir);
	const faux = fauxProvider(); faux.setResponses(responses);
	const runtime = await createResearchSessionRuntime({ args: ["--no-extensions", "--no-skills", "--no-context-files", "--tools", tools.map((t) => t.name).join(","), ...extraArgs],
		cwd: root, agentDir: join(root, "agent"), sessionDir, model: faux.getModel(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		extensionFactories: [researchMode, ...factories, (pi) => { pi.registerProvider(faux.provider); for (const tool of tools) pi.registerTool(tool); }] });
	const host = await createRuntimeHost({ runtime, socketPath: join(root, "host.sock"), sessionDir, stateRoot: root });
	const clients = [];
	return { root, runtime, host, faux, async client() { const c = await new RuntimeClient(join(root, "host.sock")).connect(); clients.push(c); return c; },
		async close() { for (const client of clients) client.close(); await host.close(); await rm(root, { recursive: true, force: true }); } };
}

test("a tool and approval survive all UI disconnects; two UI answers settle once", async () => {
	let performed = 0;
	const f = await fixture([fauxAssistantMessage(fauxToolCall("approved_probe", {}, { id: "probe-1" }), { stopReason: "toolUse" }), fauxAssistantMessage("completed after reconnect")], [{
		name: "approved_probe", label: "Probe", description: "Synthetic approval", parameters: { type: "object", properties: {} },
		async execute(_id, _args, _signal, _update, ctx) { if (await ctx.ui.confirm("Approve synthetic tool?", "No external side effects")) performed++; return { content: [{ type: "text", text: "done" }], details: {} }; },
	}]);
	try {
		const first = await f.client(); await first.call("prompt", { message: "probe" });
		await until(() => f.host.interactions.list().length === 1); const id = f.host.interactions.list()[0].id;
		first.close(); await new Promise((r) => setTimeout(r, 30));
		assert.equal(f.host.interactions.list()[0].id, id); assert.equal(performed, 0);
		const second = await f.client(), third = await f.client(); assert.equal(second.state.dialogs[0].id, id);
		const results = await Promise.allSettled([second.call("dialog.answer", { id, value: true }), third.call("dialog.answer", { id, value: true })]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		await until(() => f.runtime.session.isIdle); assert.equal(performed, 1); assert.equal(f.runtime.session.getLastAssistantText(), "completed after reconnect");
	} finally { await f.close(); }
});

test("Host deduplicates a retried prompt across different UI connections", async () => {
	const f = await fixture([fauxAssistantMessage("single execution")]);
	try {
		const a = await f.client(), b = await f.client();
		const id = "same-request-123"; await Promise.all([a.call("prompt", { message: "one input" }, { id }), b.call("prompt", { message: "one input" }, { id })]);
		await until(() => f.runtime.session.isIdle && f.runtime.session.getLastAssistantText());
		assert.equal(f.runtime.session.messages.filter((m) => m.role === "user").length, 1);
		await assert.rejects(b.call("prompt", { message: "different input" }, { id }), /Request ID reused/);
	} finally { await f.close(); }
});

test("Session replacement restores history and rejects operations from an old UI epoch", async () => {
	const f = await fixture([fauxAssistantMessage("saved response")]);
	try {
		const a = await f.client(); await a.call("prompt", { message: "saved question" }); await until(() => f.runtime.session.isIdle && f.runtime.session.getLastAssistantText());
		const initial = await a.call("state"); await a.call("session.new");
		await assert.rejects(a.call("thinking.set", { level: "low" }, { sessionId: initial.sessionId, sessionEpoch: initial.sessionEpoch }), /session changed/);
		a.state = await a.call("state"); await a.call("session.resume", { id: initial.sessionId });
		const restored = await a.call("state"); assert.equal(restored.sessionId, initial.sessionId);
		assert.ok(restored.entries.some((e) => JSON.stringify(e).includes("saved response")));
	} finally { await f.close(); }
});

test("Web Gateway restart never stops the execution Host", async () => {
	const f = await fixture([fauxAssistantMessage("reply without gateway")]); let gateway;
	try {
		gateway = await createRuntimeGateway({ record: { socketPath: join(f.root, "host.sock") }, stateRoot: f.root, assetsRoot: new URL("../web", import.meta.url).pathname });
		await gateway.close(); gateway = undefined;
		const a = await f.client(); await a.call("prompt", { message: "continue" }); await until(() => f.runtime.session.isIdle && f.runtime.session.getLastAssistantText());
		gateway = await createRuntimeGateway({ record: { socketPath: join(f.root, "host.sock") }, stateRoot: f.root, assetsRoot: new URL("../web", import.meta.url).pathname });
		assert.equal(f.runtime.session.getLastAssistantText(), "reply without gateway");
	} finally { await gateway?.close(); await f.close(); }
});

test("older history is pageable without exposing hidden model context", async () => {
	const f = await fixture([]);
	try {
		for (let i = 0; i < 175; i++) f.runtime.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: `question-${i}` }], timestamp: Date.now() });
		const a = await f.client(); assert.equal(a.state.entries.length, 160);
		const older = await a.call("history", { offset: 0, limit: 15 }); assert.equal(older.length, 15); assert.match(JSON.stringify(older[0]), /question-0/);
		assert.ok(a.state.entries.every((e) => e.message?.role !== "system"));
		const tree = await a.call("tree"); assert.doesNotMatch(JSON.stringify(tree), /You are a computational research agent/);
	} finally { await f.close(); }
});

test("interaction cancellation and stale answers cannot grant permission", async () => {
	let epoch = "one"; const events = [];
	const broker = createRuntimeInteractions((e) => events.push(e), () => epoch);
	const wait = broker.request("confirm", "Permission", "Target"); const id = broker.list()[0].id;
	epoch = "two"; assert.throws(() => broker.answer(id, true), /session changed/); broker.cancelAll(); assert.equal(await wait, false);
	assert.throws(() => broker.answer(id, true), /ended/);
});

test("events use immutable bounded replay; changed epoch requires a fresh snapshot", async () => {
	const f = await fixture([]);
	try {
		const client = await f.client(), baseline = await client.call("state");
		const event = { type: "notice", message: "original" }; f.host.publish(event); event.message = "mutated later";
		const replay = await client.call("events", { since: baseline.seq, hostEpoch: baseline.hostEpoch });
		assert.equal(replay.resyncRequired, false); assert.equal(replay.events[0].message, "original");
		for (let i = 0; i < 270; i++) f.host.publish({ type: "notice", message: "bounded " + i });
		assert.equal((await client.call("events", { since: baseline.seq, hostEpoch: baseline.hostEpoch })).resyncRequired, true);
		assert.equal((await client.call("events", { since: 0, hostEpoch: "old-host" })).resyncRequired, true);
	} finally { await f.close(); }
});

test("view switching is targeted to the requesting UI, not other screens", async () => {
	const f = await fixture([]);
	try {
		const a = await f.client(), b = await f.client(), aa = [], bb = [];
		a.on("event", (e) => aa.push(e)); b.on("event", (e) => bb.push(e));
		await a.call("prompt", { message: "/tree" }); await until(() => aa.some((e) => e.type === "view"));
		assert.equal(bb.some((e) => e.type === "view"), false);
	} finally { await f.close(); }
});

test("UI reads, reconnects and views do not change the next model request prefix", async () => {
	const captured = [];
	const capture = (answer) => (context) => { captured.push(structuredClone(context)); return fauxAssistantMessage(answer); };
	const f = await fixture([capture("first answer"), capture("second answer")]);
	try {
		const a = await f.client(); assert.equal((await a.call("prompt", { message: "first question" })).disposition, "started");
		await until(() => f.runtime.session.isIdle && captured.length === 1);
		const modelContext = [...captured[0].messages, structuredClone(f.runtime.session.messages.at(-1))], systemPrompt = captured[0].systemPrompt;
		await a.call("ui.draft", { hasDraft: true }); assert.ok(f.host.ui.getEditorText()); await a.call("ui.draft", { hasDraft: false }); assert.equal(f.host.ui.getEditorText(), "");
		for (const method of ["state", "models", "commands", "runtime", "actors", "history", "tree", "queue"]) await a.call(method);
		await a.call("prompt", { message: "/tree" }); a.close();
		const b = await f.client(); await b.call("prompt", { message: "second question" });
		await until(() => f.runtime.session.isIdle && captured.length === 2);
		assert.deepEqual(captured[1].messages.slice(0, modelContext.length), modelContext);
		assert.equal(captured[1].systemPrompt, systemPrompt);
		assert.deepEqual(captured[1].tools, captured[0].tools);
	} finally { await f.close(); }
});

test("native preflight failure is rejected, not reported as an accepted message", async () => {
	const f = await fixture([]);
	try {
		const a = await f.client(); f.runtime.session.agent.state.model = undefined;
		await assert.rejects(a.call("prompt", { message: "no model" }), /model/i);
		await assert.rejects(a.call("prompt", { message: "invalid", images: [{ mimeType: "text/html", data: "eA==" }] }), /Invalid image/);
	} finally { await f.close(); }
});

test("tree navigation invalidates old UI mutations even when the Session ID stays the same", async () => {
	const f = await fixture([fauxAssistantMessage("branch response")]);
	try {
		const a = await f.client(); await a.call("prompt", { message: "branch question" }); await until(() => f.runtime.session.isIdle && f.runtime.session.getLastAssistantText());
		const before = await a.call("state"), entryId = f.runtime.session.sessionManager.getLeafId();
		await a.call("session.tree", { entryId }); const after = await a.call("state");
		assert.equal(after.sessionId, before.sessionId); assert.notEqual(after.sessionEpoch, before.sessionEpoch);
		await assert.rejects(a.call("thinking.set", { level: "low" }, { sessionId: before.sessionId, sessionEpoch: before.sessionEpoch }), /session changed/);
	} finally { await f.close(); }
});

test("extension command waits for interaction and blocks a competing prompt; RPC UI methods work", async () => {
	let mode, collapsed;
	const f = await fixture([], [], [(pi) => pi.registerCommand("interaction-probe", { handler: async (_args, ctx) => {
		mode = ctx.mode; ctx.ui.setToolsExpanded(true); ctx.ui.setToolsExpanded(false); collapsed = !ctx.ui.getToolsExpanded();
		await ctx.ui.confirm("Keep waiting", "Owned by Host");
	} })]);
	try {
		const a = await f.client(), b = await f.client(); let settled = false;
		const command = a.call("prompt", { message: "/interaction-probe" }).then((r) => { settled = true; return r; });
		await until(() => f.host.interactions.list().length > 0); assert.equal(settled, false);
		await assert.rejects(b.call("prompt", { message: "competing input" }), /pending interaction/);
		await b.call("dialog.answer", { id: f.host.interactions.list()[0].id, value: false });
		assert.equal((await command).disposition, "handled"); assert.equal(mode, "rpc"); assert.equal(collapsed, true);
	} finally { await f.close(); }
});

test("Actor messages require the owning Leader and cannot bypass Analysis restrictions", async () => {
	const f = await fixture([]), previous = getRuntimeUiAdapter();
	try {
		const a = await f.client();
		registerRuntimeUiAdapter({ snapshot: () => ({ leader: { inheritancePolicy: "analysis", isCurrentSessionAttached: true } }) });
		await assert.rejects(a.call("actor.send", { actorId: "pi:probe", body: "do work" }), /Analysis Session/);
		registerRuntimeUiAdapter({ snapshot: () => ({ leader: { inheritancePolicy: "project", isCurrentSessionAttached: false } }) });
		await assert.rejects(a.call("actor.send", { actorId: "pi:probe", body: "do work" }), /owning Leader/);
	} finally { registerRuntimeUiAdapter(previous); await f.close(); }
});

test("prompt templates load through native flags and expand in the Host", async () => {
	const directory = await mkdtemp(join(tmpdir(), "rpi-template-test-")), path = join(directory, "prefix-probe.md");
	await writeFile(path, "---\ndescription: Test template\n---\nExpanded template argument: $1\n");
	let captured; const f = await fixture([(context) => { captured = context; return fauxAssistantMessage("expanded"); }], [], [], ["--prompt-template", path]);
	try {
		const a = await f.client(); assert.equal((await a.call("prompt", { message: "/prefix-probe example" })).disposition, "started");
		await until(() => f.runtime.session.isIdle && captured); assert.match(JSON.stringify(captured.messages), /Expanded template argument: example/);
	} finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Gateway reconnects after Host restart without replaying a mutation", async () => {
	const f = await fixture([]); let gateway, restarted;
	try {
		gateway = await createRuntimeGateway({ record: { socketPath: join(f.root, "host.sock") }, stateRoot: f.root, assetsRoot: new URL("../web", import.meta.url).pathname });
		const request = async () => { const response = await fetch(`http://127.0.0.1:${gateway.port}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${gateway.port}` }, body: JSON.stringify({ token: new URL(gateway.localAccessUrl).hash.slice(7) }) }); return response.headers.get("set-cookie").split(";")[0]; };
		const cookie = await request(), previousEpoch = f.host.state().hostEpoch; await f.host.close();
		const runtime = await createResearchSessionRuntime({ args: ["--no-extensions", "--no-skills", "--no-context-files"], cwd: f.root, agentDir: join(f.root, "agent"), sessionDir: join(f.root, "sessions"), model: f.faux.getModel(), settingsManager: SettingsManager.inMemory(), extensionFactories: [(pi) => pi.registerProvider(f.faux.provider)] });
		restarted = await createRuntimeHost({ runtime, socketPath: join(f.root, "host.sock"), stateRoot: f.root, sessionDir: join(f.root, "sessions") });
		let snapshot; const end = Date.now() + 4000;
		while (Date.now() < end) { const response = await fetch(`http://127.0.0.1:${gateway.port}/api/session`, { headers: { cookie } }); const body = await response.json(); if (body.ok) { snapshot = body.result; if (snapshot.hostEpoch !== previousEpoch) break; } await new Promise((r) => setTimeout(r, 30)); }
		assert.equal(snapshot?.hostEpoch, restarted.state().hostEpoch); assert.equal(snapshot.ready, true); assert.equal(runtime.session.messages.filter((m) => m.role === "user").length, 0);
	} finally { await gateway?.close(); await restarted?.close(); await f.close(); }
});

test("a handled native input restores the draft only in the requesting UI", async () => {
	const f = await fixture([], [], [(pi) => pi.on("input", (event, ctx) => { ctx.ui.setEditorText(event.text); return { action: "handled" }; })]);
	try {
		const a = await f.client(), b = await f.client(), aa = [], bb = []; a.on("event", (e) => aa.push(e)); b.on("event", (e) => bb.push(e));
		assert.equal((await a.call("prompt", { message: "retain my unsent input" })).disposition, "handled");
		await until(() => aa.some((e) => e.type === "draft")); assert.equal(aa.find((e) => e.type === "draft").text, "retain my unsent input"); assert.equal(bb.some((e) => e.type === "draft"), false);
	} finally { await f.close(); }
});
