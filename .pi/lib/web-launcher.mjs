import { createServer } from "node:net";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createWebGateway } from "./web-server.mjs";
import { inspectWebTailnet, startWebTailnet } from "./web-tailscale.mjs";

const require = createRequire(import.meta.url);
export function parseWebOptions(argv) {
	const args = [...argv];
	const takeFlag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
	const takePort = (name, fallback) => {
		const i = args.indexOf(name);
		if (i < 0) return fallback;
		const value = Number(args[i + 1]);
		if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(name + " requires a port from 1 to 65535");
		args.splice(i, 2); return value;
	};
	const enabled = takeFlag("--web");
	const tailscale = takeFlag("--web-tailscale");
	const port = takePort("--web-port", 8787);
	const httpsPort = takePort("--web-https-port", 8443);
	return { enabled: enabled || tailscale, tailscale, port, httpsPort, args };
}

export async function launchResearchWeb({ executable, args, cwd, env, packageRoot, options, localTerminal = process.stdin.isTTY && process.stdout.isTTY }) {
	const pty = require("node-pty");
	const { Terminal } = require("@xterm/headless");
	const { SerializeAddon } = require("@xterm/addon-serialize");
	const tailnet = options.tailscale ? await inspectWebTailnet({ httpsPort: options.httpsPort }) : null;
	const privateDir = await mkdtemp(join(tmpdir(), "rpi-web-"));
	await chmod(privateDir, 0o700);
	const socketPath = join(privateDir, "bridge.sock");
	let bridge, child, gateway, serving;
	let lastState = { ready: false, cwd };
	let closed = false, childExited = false;
	let seq = 0;
	const pending = new Map();
	const terminal = new Terminal({ cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, scrollback: 2000, allowProposedApi: true });
	const serializer = new SerializeAddon();
	terminal.loadAddon(serializer);
	const broadcast = (event) => gateway?.broadcast(event);
	const ipc = createServer((socket) => {
		if (bridge && !bridge.destroyed) bridge.destroy();
		bridge = socket;
		let buffer = "";
		socket.on("data", (data) => {
			buffer += data.toString();
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				try {
					const event = JSON.parse(line);
					if (event.type === "response") {
						const waiter = pending.get(event.id);
						if (waiter) { pending.delete(event.id); clearTimeout(waiter.timer); event.error ? waiter.reject(new Error(event.error)) : waiter.resolve(event.result); }
					} else {
						if (event.type === "state") lastState = event.state;
						if (event.type === "show_link") { process.stderr.write("\nResearch Pi Web: " + gateway.accessUrl + "\n"); continue; }
						broadcast(event);
					}
				} catch (error) { process.stderr.write("Web bridge: " + error.message + "\n"); }
			}
		});
		socket.on("close", () => {
			if (bridge !== socket) return;
			bridge = null;
			lastState = { ...lastState, ready: false };
			for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Pi is switching sessions or disconnected")); }
			pending.clear();
			broadcast({ type: "state", state: lastState });
		});
		socket.on("error", () => {});
	});
	const command = async (input) => {
		if (input.method === "state" && !bridge) return lastState;
		if (!bridge) throw new Error("Pi is not ready");
		const id = randomUUID();
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { pending.delete(id); reject(new Error("Pi did not acknowledge the command")); }, 15_000);
			pending.set(id, { resolve, reject, timer });
			bridge.write(JSON.stringify({ ...input, type: "command", id }) + "\n");
		});
		if (result?.terminalEnter) child?.write("\r");
		return result;
	};
	const resize = (cols, rows) => {
		if (cols === terminal.cols && rows === terminal.rows) return;
		terminal.resize(cols, rows); child?.resize(cols, rows);
		broadcast({ type: "terminal_resize", cols, rows });
	};
	const localInput = (data) => child?.write(data.toString());
	const localResize = () => resize(process.stdout.columns || 100, process.stdout.rows || 30);
	const shutdown = async () => {
		if (closed) return;
		closed = true;
		await serving?.stop();
		process.stdin.off("data", localInput);
		process.stdout.off("resize", localResize);
		if (localTerminal) { process.stdin.setRawMode(false); process.stdin.pause(); }
		bridge?.destroy();
		for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Pi exited")); }
		pending.clear();
		await gateway?.close();
		await new Promise((resolve) => ipc.close(resolve));
		terminal.dispose();
		await rm(privateDir, { recursive: true, force: true });
	};
	try {
		await new Promise((resolve, reject) => { ipc.once("error", reject); ipc.listen(socketPath, resolve); });
		await chmod(socketPath, 0o600);
		gateway = await createWebGateway({
			port: options.port, publicOrigin: tailnet?.origin, tailscaleLogin: tailnet?.login,
			assetsRoot: join(packageRoot, "web"), command,
			terminal: {
				write: (data) => child?.write(data), resize,
				snapshot: () => new Promise((resolve) => terminal.write("", () => resolve({ data: serializer.serialize(), cols: terminal.cols, rows: terminal.rows, seq }))),
			},
		});
		await writeFile(join(privateDir, "access.json"), JSON.stringify({ url: gateway.accessUrl, localUrl: gateway.localAccessUrl, cwd, pid: process.pid }), { mode: 0o600 });
		process.stderr.write("\nResearch Pi Web: " + gateway.accessUrl + "\nAccess details: " + join(privateDir, "access.json") + "\n");
		child = pty.spawn(executable, args, {
			name: "xterm-256color", cols: terminal.cols, rows: terminal.rows, cwd,
			env: { ...env, TERM: "xterm-256color", RESEARCH_PI_WEB_SOCKET: socketPath },
		});
		child.onData((data) => {
			if (localTerminal) process.stdout.write(data);
			terminal.write(data, () => broadcast({ type: "terminal", data, seq: ++seq }));
		});
		if (localTerminal) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", localInput); process.stdout.on("resize", localResize); }
		if (tailnet) serving = startWebTailnet({ httpsPort: tailnet.httpsPort, localPort: gateway.port, onError: (error) => process.stderr.write(error.message + "\nLocal access remains available.\n") });
		const signal = () => child.kill("SIGTERM");
		process.once("SIGTERM", signal); process.once("SIGINT", signal); process.once("SIGHUP", signal);
		const exitCode = await new Promise((resolve) => child.onExit(({ exitCode }) => { childExited = true; resolve(exitCode); }));
		process.off("SIGTERM", signal); process.off("SIGINT", signal); process.off("SIGHUP", signal);
		return exitCode;
	} finally {
		if (!closed) { try { if (!childExited) child?.kill(); } catch {} }
		await shutdown();
	}
}
