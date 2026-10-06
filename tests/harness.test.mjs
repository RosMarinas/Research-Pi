import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { createResearchSessionRuntime } from "../.pi/lib/runtime-factory.mjs";
import { createRuntimeHost } from "../.pi/lib/runtime-host.mjs";
import { runtimeDirectory, writeRuntimeRecord } from "../.pi/lib/runtime-resident.mjs";
import { createHarnessGateway } from "../.pi/lib/harness-server.mjs";
import { registerHarnessProject } from "../.pi/lib/harness-projects.mjs";
import { renderTimeline } from "../web/timeline.js";

async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rpi-harness-test-"))), stateRoot = join(root, "state"), sessionDir = join(root, "sessions"), hosts = [], runtimes = new Map();
	await mkdir(stateRoot); await mkdir(sessionDir);
	async function start(project) {
		const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage("reply for " + project.name)]);
		const runtime = await createResearchSessionRuntime({ cwd: project.cwd, args: ["--no-extensions", "--no-skills", "--no-context-files"], agentDir: join(root, "agent"), sessionDir, model: faux.getModel(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), extensionFactories: [(pi) => pi.registerProvider(faux.provider)] });
		const directory = await runtimeDirectory(stateRoot, project.cwd), socketPath = join(root, project.name + ".sock"); await mkdir(directory, { recursive: true });
		const host = await createRuntimeHost({ runtime, stateRoot, sessionDir, socketPath }); hosts.push(host); runtimes.set(project.id, runtime);
		await writeRuntimeRecord(directory, { pid: process.pid, cwd: project.cwd, socketPath });
	}
	const projects = [];
	for (const name of ["Alpha", "Beta"]) { const cwd = join(root, name); await mkdir(cwd); projects.push(await registerHarnessProject(stateRoot, cwd, { name })); }
	await start(projects[0]);
	const gateway = await createHarnessGateway({ stateRoot, packageRoot: new URL("..", import.meta.url).pathname, startProject: start });
	return { root, stateRoot, projects, gateway, runtimes, async close() { await gateway.close(); for (const h of hosts) await h.close(); await rm(root, { recursive: true, force: true }); } };
}

test("one pairing accesses multiple projects; explicit project routing fences mutations", async () => {
	const f = await setup();
	try {
		const origin = f.gateway.localOrigin, token = new URL(f.gateway.localAccessUrl).hash.slice(7);
		const login = await fetch(origin + "/api/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
		const cookie = login.headers.get("set-cookie").split(";")[0];
		const state = async (project) => (await (await fetch(origin + "/api/session?project=" + project.id, { headers: { cookie } })).json()).result;
		const a = await state(f.projects[0]), b = await state(f.projects[1]); assert.equal(a.ready, true); assert.equal(b.stopped, true);
		const input = (project, s, method, params) => ({ id: crypto.randomUUID(), projectId: project.id, sessionId: s.sessionId, sessionEpoch: s.sessionEpoch, method, params });
		await f.gateway.command(input(f.projects[0], a, "prompt", { message: "only Alpha" }));
		await f.gateway.command({ id: crypto.randomUUID(), projectId: f.projects[1].id, method: "project.start" });
		const startedB = await state(f.projects[1]); assert.equal(startedB.ready, true);
		await assert.rejects(f.gateway.command(input(f.projects[1], a, "prompt", { message: "stale Alpha context" })), /session changed/);
		await assert.rejects(f.gateway.command({ method: "prompt", params: { message: "no routing" } }), /explicit project ID/);
		assert.equal(f.runtimes.get(f.projects[1].id).session.messages.filter((m) => m.role === "user").length, 0);
		const list = await f.gateway.command({ method: "projects" }); assert.equal(list.length, 2); assert.ok(list.every((p) => p.running));
		await f.gateway.close(); assert.equal(f.runtimes.get(f.projects[0].id).session.sessionId, a.sessionId);
	} finally { await f.close(); }
});

test("unified tool cards pair native IDs, preserve subagent state and escape parameters", () => {
	const escape = (x) => String(x).replaceAll("<", "&lt;").replaceAll('"', "&quot;"), md = escape;
	const entries = [ { message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { action: "resume", task: "<script>bad</script>" } }] } },
		{ message: { role: "toolResult", toolCallId: "call-1", toolName: "subagent", content: [{ type: "text", text: "tool body" }], details: { id: "probe", actorId: "pi:probe", backend: "pi", role: "advisor", model: "demo", thinking: "high", status: "running", progress: "bash running" } } } ];
	const html = renderTimeline(entries, { escape, md }); assert.equal((html.match(/data-tool-call=/g) ?? []).length, 1);
	assert.match(html, /Subagent resume/); assert.match(html, /bash running/); assert.match(html, /pi:probe/); assert.doesNotMatch(html, /<script>/);
});
