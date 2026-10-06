import { spawn } from "node:child_process";
import { join } from "node:path";
import { createWebGateway } from "./web-server.mjs";
import { persistentWebToken } from "./web-token.mjs";
import { RuntimeClient } from "./runtime-client.mjs";
import { findRuntime } from "./runtime-resident.mjs";
import { readHarnessProjects, registerHarnessProject, discoverHarnessProjects } from "./harness-projects.mjs";

export async function createHarnessGateway({ stateRoot, packageRoot, assetsRoot = join(packageRoot, "web"), env = process.env, port = 0, publicOrigin, tailscaleLogin, startProject }) {
	const connections = new Map(), connecting = new Map(), starting = new Map(); let gateway, closed = false;
	const tagged = (id, event) => ({ ...event, projectId: id });
	async function openConnection(project) {
		const old = connections.get(project.id); if (old && !old.socket.destroyed) return old;
		const record = await findRuntime(stateRoot, project.cwd, project.analysis); if (!record) return null;
		const client = await new RuntimeClient(record.socketPath, { forwardAllViews: true }).connect(); if (closed) { client.close(); return null; } connections.set(project.id, client);
		client.on("event", (event) => gateway?.broadcast(tagged(project.id, event)));
		client.on("disconnect", () => {
			gateway?.broadcast(tagged(project.id, { type: "state", state: { ...client.state, projectId: project.id, harness: true, ready: false, idle: false, executionUnknown: true } }));
		}); return client;
	}
	async function connect(project) {
		const old = connections.get(project.id); if (old && !old.socket.destroyed) return old;
		if (!connecting.has(project.id)) {
			const promise = openConnection(project); connecting.set(project.id, promise);
			promise.finally(() => connecting.delete(project.id)).catch(() => {});
		} return connecting.get(project.id);
	}

	async function list() {
		const projects = await discoverHarnessProjects(stateRoot), result = [];
		for (const project of projects) {
			let client, unavailable; try { client = await connect(project); } catch (e) { unavailable = e.message; /* Never replace a live but unavailable Host. */ }
			result.push({ ...project, unavailable, running: Boolean(client && !client.socket.destroyed), idle: client?.state?.idle, sessionId: client?.state?.sessionId, pending: client?.state?.dialogs?.length ?? 0, model: client?.state?.model });
		} return result;
	}
	async function launch(project, options = {}) {
		if (startProject) return startProject(project, options);
		const args = [join(packageRoot, "bin/pi.mjs"), "runtime", "start", "--no-web", "--workspace", project.cwd, ...(project.analysis ? ["--analysis"] : [])];
		for (const key of ["provider", "model", "thinking"]) if (options[key]) { if (typeof options[key] !== "string" || options[key].length > 160) throw new Error("Invalid startup option"); args.push("--" + key, options[key]); }
		const childEnv = { ...env }; delete childEnv.RESEARCH_PI_INITIAL_SESSION_MODE; delete childEnv.RESEARCH_PI_FULL_ACCESS;
		await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, args, { cwd: packageRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
			child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; }); child.on("error", reject);
			child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output.replace(/#token=[^\s]+/g, "#token=[redacted]"))));
		});
	}
	async function command(input) {
		const { method, params = {}, projectId } = input;
		if (method === "projects") return list();
		if (method === "project.add") {
			if (typeof params.cwd !== "string" || !params.cwd.trim() || params.cwd.length > 4096) throw new Error("Enter a project directory on this computer");
			const project = await registerHarnessProject(stateRoot, params.cwd, { name: params.name, analysis: params.analysis === true });
			gateway?.broadcast({ type: "projects", projects: await list() }); return project;
		}
		if (method === "state" && !projectId) return { harness: true, ready: false, projects: await list(), entries: [], dialogs: [] };
		const project = (await readHarnessProjects(stateRoot)).find((p) => p.id === projectId);
		if (!project) throw new Error("Choose a registered project; operations require an explicit project ID");
		if (method === "project.start") {
			if (!starting.has(project.id)) {
				const operation = (async () => { if (!await connect(project)) await launch(project, params); const client = await connect(project); if (!client) throw new Error("Runtime did not start"); return { ...client.state, harness: true, projectId: project.id }; })();
				starting.set(project.id, operation); operation.finally(() => starting.delete(project.id)).catch(() => {});
			} return starting.get(project.id);
		}
		const client = await connect(project);
		if (method === "state" && !client) return { harness: true, projectId, cwd: project.cwd, name: project.name, ready: false, stopped: true, entries: [], dialogs: [] };
		if (!client) throw new Error("Project Runtime is stopped; start it before submitting an operation");
		const result = await client.call(method, params, { id: input.id, sessionId: input.sessionId, sessionEpoch: input.sessionEpoch, uiClientId: input.uiClientId });
		return method === "state" ? { ...result, harness: true, projectId } : result;
	}
	gateway = await createWebGateway({ port, publicOrigin, tailscaleLogin, assetsRoot, token: await persistentWebToken(stateRoot), command });
	await list();
	const refresh = setInterval(() => { if (!closed) void list().then((projects) => gateway.broadcast({ type: "projects", projects })).catch(() => {}); }, 5000); refresh.unref();
	return { ...gateway, command, async close() { closed = true; clearInterval(refresh); for (const client of connections.values()) client.close(); await gateway.close(); } };
}
