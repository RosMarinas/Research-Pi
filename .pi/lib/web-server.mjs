import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const require = createRequire(import.meta.url);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const secretEquals = (a, b) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_BODY = 8 * 1024 * 1024;

export async function createWebGateway({ port = 8787, publicOrigin, tailscaleLogin, assetsRoot, command, terminal, token = randomBytes(32).toString("base64url") }) {
	const cookieName = "rpi_web_" + createHash("sha256").update(token).digest("hex").slice(0, 16);
	const clients = new Set();
	const calls = new Map();
	const origins = new Set();
	let localOrigin;
	let closed = false;
	const publicUrl = publicOrigin ? new URL(publicOrigin) : null;
	if (publicUrl && (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username)) {
		throw new Error("The public Web origin must be an HTTPS origin without a path");
	}
	const vendor = {
		"/vendor/xterm.js": require.resolve("@xterm/xterm"),
		"/vendor/xterm.css": join(require.resolve("@xterm/xterm/package.json"), "..", "css/xterm.css"),
		"/vendor/fit.js": require.resolve("@xterm/addon-fit"),
		"/vendor/marked.js": require.resolve("marked"),
		"/vendor/purify.js": require.resolve("dompurify").replace(/purify\.cjs\.js$/, "purify.min.js"),
	};
	const assets = { "/": "index.html", "/app.js": "app.js", "/timeline.js": "timeline.js", "/style.css": "style.css", "/icon.svg": "icon.svg", "/manifest.webmanifest": "manifest.webmanifest" };
	const headers = {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"X-Frame-Options": "DENY",
		"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	};
	function checkHost(req) {
		const host = req.headers.host;
		const origin = [...origins].find((value) => new URL(value).host === host);
		if (!origin) throw fail(403, "Unrecognized host");
		if (publicUrl && host === publicUrl.host && tailscaleLogin && req.headers["tailscale-user-login"] !== tailscaleLogin) {
			throw fail(403, "This Tailscale identity is not allowed");
		}
		return origin;
	}
	function checkOrigin(req) {
		const expected = checkHost(req);
		if (req.headers.origin !== expected) throw fail(403, "Same-origin request required");
	}
	function authenticated(req) {
		const cookies = String(req.headers.cookie ?? "").split(";").map((part) => part.trim());
		return cookies.some((part) => part.startsWith(cookieName + "=") && secretEquals(part.slice(cookieName.length + 1), token));
	}
	const cookie = (req, clear = false) => cookieName + "=" + (clear ? "" : token) +
		"; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + (clear ? "0" : "2592000") +
		(publicUrl && req.headers.host === publicUrl.host ? "; Secure" : "");
	async function body(req) {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY) throw fail(413, "Request too large");
			chunks.push(chunk);
		}
		try { return JSON.parse(Buffer.concat(chunks).toString()); }
		catch { throw fail(400, "Invalid JSON"); }
	}
	const send = (res, status, data, extra = {}) => {
		res.writeHead(status, { ...headers, "Content-Type": "application/json", ...extra });
		res.end(JSON.stringify(data));
	};
	async function execute(input) {
		if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.id)) throw fail(400, "A request ID is required");
		const serialized = JSON.stringify({ method: input.method, params: input.params, projectId: input.projectId, sessionId: input.sessionId, sessionEpoch: input.sessionEpoch });
		const previous = calls.get(input.id);
		if (previous) {
			if (previous.serialized !== serialized) throw fail(409, "Request ID was already used for a different operation");
			return previous.promise;
		}
		const promise = Promise.resolve().then(() => command(input));
		calls.set(input.id, { serialized, promise });
		// Only retain settled requests; never evict an in-flight request.
		promise.finally(() => {
			const entry = calls.get(input.id);
			if (entry) entry.settled = true;
			if (calls.size > 512) for (const [id, entry] of calls) {
				if (entry.settled) calls.delete(id);
				if (calls.size <= 384) break;
			}
		}).catch(() => {});
		return promise;
	}
	const server = createServer(async (req, res) => {
		try {
			checkHost(req);
			const url = new URL(req.url, localOrigin);
			if (req.method === "POST") {
				checkOrigin(req);
				if (!String(req.headers["content-type"]).startsWith("application/json")) throw fail(415, "JSON required");
				if (url.pathname === "/api/login") {
					const input = await body(req);
					if (!secretEquals(input.token, token)) throw fail(401, "Invalid access token");
					return send(res, 200, { ok: true }, { "Set-Cookie": cookie(req) });
				}
				if (!authenticated(req)) throw fail(401, "Pair this browser first");
				if (url.pathname === "/api/logout") return send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, true) });
				if (url.pathname === "/api/command") return send(res, 200, { ok: true, result: await execute(await body(req)) });
				throw fail(404, "Not found");
			}
			if (req.method !== "GET") throw fail(405, "Method not allowed");
			if (url.pathname === "/api/session") {
				if (!authenticated(req)) throw fail(401, "Pair this browser first");
				return send(res, 200, { ok: true, result: await command({ method: "state", projectId: url.searchParams.get("project") ?? undefined }) });
			}
			const path = vendor[url.pathname] ?? (assets[url.pathname] && join(assetsRoot, assets[url.pathname]));
			if (!path) throw fail(404, "Not found");
			const content = await readFile(path);
			const extension = url.pathname === "/" ? ".html" : "." + url.pathname.split(".").at(-1);
			res.writeHead(200, { ...headers, "Content-Type": (MIME[extension] ?? "application/octet-stream") + "; charset=utf-8" });
			res.end(content);
		} catch (error) {
			send(res, error.status ?? 500, { ok: false, error: error.message });
		}
	});
	server.requestTimeout = 30_000;
	const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
	server.on("upgrade", (req, socket, head) => {
		try {
			checkOrigin(req);
			if (req.url !== "/ws" || !authenticated(req)) throw fail(401, "Unauthorized");
			wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
		} catch (error) { socket.end("HTTP/1.1 " + (error.status ?? 403) + " Forbidden\r\nConnection: close\r\n\r\n"); }
	});
	wss.on("connection", async (ws) => {
		try {
			if (!terminal) {
				clients.add(ws);
				const state = await command({ method: "state" });
				if (ws.readyState !== WebSocket.OPEN) { clients.delete(ws); return; }
				ws.send(JSON.stringify({ type: "state", state }));
			} else {
			const replay = await terminal.snapshot();
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify({ type: "terminal_snapshot", ...replay }));
			clients.add(ws);
			}
			ws.send(JSON.stringify({ type: "connected" }));
		} catch (error) { ws.close(1011, "Terminal unavailable"); }
		ws.on("message", (raw) => {
			try {
				const input = JSON.parse(raw.toString());
				if (!terminal) throw new Error("Runtime clients use structured commands");
				if (input.type === "input" && typeof input.data === "string" && input.data.length <= 64 * 1024) terminal.write(input.data);
				else if (input.type === "resize" && Number.isInteger(input.cols) && Number.isInteger(input.rows) &&
					input.cols >= 20 && input.cols <= 300 && input.rows >= 8 && input.rows <= 150) terminal.resize(input.cols, input.rows);
			} catch { ws.close(1008, "Invalid terminal input"); }
		});
		ws.on("close", () => clients.delete(ws));
		ws.on("error", () => clients.delete(ws));
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
	port = server.address().port;
	localOrigin = "http://127.0.0.1:" + port;
	origins.add(localOrigin);
	origins.add("http://localhost:" + port);
	if (publicOrigin) origins.add(publicUrl.origin);
	return {
		port, localOrigin,
		accessUrl: (publicOrigin ?? localOrigin) + "/#token=" + token,
		localAccessUrl: localOrigin + "/#token=" + token,
		broadcast(event) {
			const data = JSON.stringify(event);
			for (const ws of clients) {
				if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, "Reconnect to catch up"); continue; }
				if (ws.readyState === WebSocket.OPEN) ws.send(data);
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const ws of clients) ws.terminate();
			wss.close();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
