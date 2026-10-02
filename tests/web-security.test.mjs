import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createWebGateway } from "../.pi/lib/web-server.mjs";
import { inspectWebTailnet } from "../.pi/lib/web-tailscale.mjs";
import { publicWebEntries } from "../.pi/extensions/research-web.ts";
import { parseWebOptions } from "../.pi/lib/web-launcher.mjs";

test("Web auth covers APIs and sockets, rejects foreign origins and deduplicates commands", async () => {
	let executions = 0, typed = "";
	const gateway = await createWebGateway({
		port: 0, assetsRoot: fileURLToPath(new URL("../web", import.meta.url)),
		command: async ({ method }) => method === "state" ? { ready: true } : (++executions, { accepted: true }),
		terminal: { snapshot: async () => ({ data: "hello", cols: 80, rows: 24, seq: 0 }), write: (data) => typed += data, resize() {} },
	});
	const root = gateway.localOrigin;
	const token = new URL(gateway.accessUrl).hash.slice(7);
	const post = (path, body, cookie = "", origin = root) => fetch(root + path, { method: "POST",
		headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	try {
		assert.equal((await fetch(root + "/api/session")).status, 401);
		assert.equal((await post("/api/login", { token: "坏".repeat(43) })).status, 401);
		assert.equal((await post("/api/login", { token }, "", "https://evil.example")).status, 403);
		const login = await post("/api/login", { token });
		assert.equal(login.status, 200);
		const setCookie = login.headers.get("set-cookie");
		assert.match(setCookie, /HttpOnly; SameSite=Strict/);
		const cookie = setCookie.split(";")[0];
		assert.equal((await fetch(root + "/api/session", { headers: { Cookie: cookie } })).status, 200);
		const operation = { id: "request-0001", method: "prompt", params: { message: "once" } };
		const responses = await Promise.all([post("/api/command", operation, cookie), post("/api/command", operation, cookie)]);
		assert.deepEqual(responses.map((r) => r.status), [200, 200]);
		assert.equal(executions, 1);
		assert.equal((await post("/api/command", { ...operation, method: "abort" }, cookie)).status, 409);
		assert.equal((await post("/api/command", { ...operation, id: "request-0002" }, cookie, "https://evil.example")).status, 403);
		for (const asset of ["/", "/app.js", "/vendor/xterm.js", "/vendor/fit.js", "/vendor/xterm.css", "/vendor/marked.js", "/vendor/purify.js"]) {
			const response = await fetch(root + asset);
			assert.equal(response.status, 200, asset);
			assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
		}
		const unauthorized = await new Promise((resolve) => {
			const ws = new WebSocket(root.replace("http", "ws") + "/ws", { origin: root });
			ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
			ws.on("error", () => {});
		});
		assert.equal(unauthorized, 401);
		const ws = new WebSocket(root.replace("http", "ws") + "/ws", { origin: root, headers: { Cookie: cookie } });
		const replay = await new Promise((resolve, reject) => { ws.once("message", (data) => resolve(JSON.parse(data))); ws.once("error", reject); });
		assert.equal(replay.type, "terminal_snapshot");
		assert.equal(replay.data, "hello");
		ws.send(JSON.stringify({ type: "input", data: "test" }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(typed, "test"); ws.close();
	} finally { await gateway.close(); }
});

test("Tailnet proxy requires the configured current user and secure cookies", async () => {
	const publicOrigin = "https://desktop.test.ts.net:8443";
	const gateway = await createWebGateway({ port: 0, publicOrigin, tailscaleLogin: "user@example.test",
		assetsRoot: fileURLToPath(new URL("../web", import.meta.url)), command: async () => ({ ready: true }),
		terminal: { snapshot: async () => ({ data: "" }), write() {}, resize() {} } });
	const token = new URL(gateway.accessUrl).hash.slice(7);
	const send = (identity) => new Promise((resolve, reject) => {
		const req = httpRequest(gateway.localOrigin + "/api/login", { method: "POST",
			headers: { Host: "desktop.test.ts.net:8443", Origin: publicOrigin, "Content-Type": "application/json",
				...(identity ? { "Tailscale-User-Login": identity } : {}) } }, (res) => {
			res.resume(); res.on("end", () => resolve({ status: res.statusCode, cookie: res.headers["set-cookie"]?.[0] }));
		});
		req.on("error", reject); req.end(JSON.stringify({ token }));
	});
	try {
		assert.equal((await send()).status, 403);
		assert.equal((await send("another@example.test")).status, 403);
		const response = await send("user@example.test");
		assert.equal(response.status, 200);
		assert.match(response.cookie, /; Secure/);
	} finally { await gateway.close(); }
});

test("Tailnet integration inspects the signed-in account and refuses occupied or public endpoints", async () => {
	const calls = []; let serve = {};
	const run = async (_file, args) => {
		calls.push(args);
		return { stdout: JSON.stringify(args[0] === "status" ?
			{ BackendState: "Running", Self: { DNSName: "desktop.test.ts.net.", UserID: 42 }, User: { 42: { LoginName: "owner" } }, CertDomains: ["desktop.test.ts.net"] } : serve) };
	};
	assert.equal((await inspectWebTailnet({ run })).origin, "https://desktop.test.ts.net:8443");
	assert.deepEqual(calls, [["status", "--json"], ["serve", "status", "--json"]]);
	serve = { AllowFunnel: { "desktop.test.ts.net:8443": true } };
	await assert.rejects(inspectWebTailnet({ run }), /already has/);
	serve = { TCP: { 8443: { HTTPS: true } } };
	await assert.rejects(inspectWebTailnet({ run }), /already has/);
	serve = { Foreground: { "another-session": { TCP: { 8443: { HTTPS: true } } } } };
	await assert.rejects(inspectWebTailnet({ run }), /already has/);
	assert.equal(parseWebOptions(["--web-tailscale", "--web-port", "9000", "--workspace", "/tmp"]).port, 9000);
	assert.deepEqual(parseWebOptions(["--web", "--analysis"]).args, ["--analysis"]);
	assert.throws(() => parseWebOptions(["--web-port", "0"]), /requires a port/);
});


test("Web snapshots omit hidden system context and private extension entries", () => {
	const visible = { type: "message", message: { role: "assistant", content: "visible" } };
	assert.deepEqual(publicWebEntries([
		{ type: "message", message: { role: "system", content: "private system" } },
		{ type: "custom_message", display: false, content: "private ProjectView" },
		{ type: "custom", data: { private: true } }, visible,
	]), [visible]);
});
