import { createServer, createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";

export async function createDesktopTerminal({ path, instance, terminal, state, stop }) {
	const clients = new Set(), actions = new Map();
	const send = (socket, event) => { if (!socket.destroyed) socket.write(JSON.stringify(event) + "\n"); };
	const server = createServer((socket) => {
		clients.add(socket);
		let buffer = "", attached = false;
		socket.on("error", () => {});
		socket.on("close", () => { clients.delete(socket); for (const [id, waiter] of actions) if (waiter.socket === socket) { actions.delete(id); waiter.reject(new Error("Terminal disconnected during action")); } });
		socket.on("data", (data) => {
			buffer += data.toString();
			if (buffer.length > 256 * 1024) return socket.destroy();
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				try {
					const input = JSON.parse(line);
					if (input.instance !== instance) { socket.destroy(); return; }
					if (input.type === "status") send(socket, { type: "status", instance, state: state() });
					else if (input.type === "stop") { send(socket, { type: "stopping" }); stop(); }
					else if (input.type === "attach") {
						void terminal.snapshot().then((snapshot) => { send(socket, { type: "terminal_snapshot", ...snapshot }); attached = true; socket.attached = true; socket.observer = input.observer === true; }).catch(() => socket.destroy());
					} else if (attached && input.type === "action_result") { const waiter = actions.get(input.id); if (waiter?.socket === socket) { actions.delete(input.id); socket.actionPaused = false; input.error ? waiter.reject(new Error(input.error)) : waiter.resolve(input.result); } }
					else if (attached && input.type === "input" && typeof input.data === "string" && input.data.length <= 64 * 1024) terminal.write(input.data, socket);
					else if (attached && input.type === "capabilities") terminal.capabilities?.({kitty:input.kitty === true});
					else if (attached && input.type === "resize" && Number.isInteger(input.cols) && Number.isInteger(input.rows)
						&& input.cols >= 20 && input.cols <= 300 && input.rows >= 8 && input.rows <= 150) terminal.resize(input.cols, input.rows);
				} catch { socket.destroy(); }
			}
		});
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
	await chmod(path, 0o600);
	return {
		broadcast(event) {
			if (!["terminal", "terminal_resize", "link"].includes(event.type)) return;
			for (const socket of clients) if (socket.attached && !socket.actionPaused) {
				if (socket.writableLength > 2 * 1024 * 1024) socket.destroy();
				else send(socket, event);
			}
		},
		requestAction(socket, action, params = {}) {
			if (!socket?.attached || socket.destroyed || socket.observer) return Promise.reject(new Error("This action needs an attached desktop terminal"));
			const id = randomUUID(); socket.actionPaused = true;
			return new Promise((resolve, reject) => { actions.set(id, { socket, resolve, reject }); send(socket, { type: "client_action", id, action, params }); });
		},
		detach() { for (const socket of clients) if (socket.attached && !socket.observer) socket.end(); },
		async close() { for (const socket of clients) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
	};
}

export function residentRequest(record, type = "status") {
	return new Promise((resolve, reject) => {
		const socket = createConnection(record.terminalSocket);
		let buffer = "";
		socket.setTimeout(2000, () => socket.destroy(new Error("Resident Pi did not respond")));
		socket.on("error", reject);
		socket.on("connect", () => socket.write(JSON.stringify({ type, instance: record.instance }) + "\n"));
		socket.on("data", (data) => {
			buffer += data.toString();
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
			socket.destroy();
		});
		socket.on("close", () => reject(new Error("Resident Pi disconnected")));
	});
}

export async function attachResidentTerminal(record) {
	if (record.kind === "native-runtime") return (await import("./native-terminal-client.mjs")).attachNativeTerminal(record);
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Use pi web start for background access, or attach from an interactive terminal");
	const socket = createConnection(record.terminalSocket);
	const send = (event) => { if (!socket.destroyed) socket.write(JSON.stringify({ ...event, instance: record.instance }) + "\n"); };
	let buffer = "", attached = false, seq = 0;
	const resize = () => send({ type: "resize", cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
	const detach = () => socket.end();
	const input = (data) => {
		const text = data.toString();
		if (text === "\x1d") detach(); // Ctrl+] detaches; Ctrl+C remains a native Pi key.
		else send({ type: "input", data: text });
	};
	try {
		await new Promise((resolve, reject) => {
			socket.on("error", reject); socket.on("close", resolve);
			socket.on("connect", () => send({ type: "attach" }));
			socket.on("data", (data) => {
				buffer += data.toString(); let end;
				while ((end = buffer.indexOf("\n")) >= 0) {
					const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
					if (event.type === "terminal_snapshot") {
						process.stdout.write(event.data); seq = event.seq;
						if (!attached) {
							attached = true; process.stdin.setRawMode(true); process.stdin.resume();
							process.stdin.on("data", input); process.stdin.on("end", detach); process.stdout.on("resize", resize);
							process.on("SIGHUP", detach); process.on("SIGTERM", detach); resize();
						}
					} else if (event.type === "terminal" && event.seq > seq) { seq = event.seq; process.stdout.write(event.data); }
					else if (event.type === "link") process.stderr.write("\nResearch Pi Web: " + event.url + "\n");
				}
			});
		});
	} finally {
		socket.destroy();
		process.stdin.off("data", input); process.stdin.off("end", detach); process.stdout.off("resize", resize);
		process.off("SIGHUP", detach); process.off("SIGTERM", detach);
		if (attached) { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\x1b[?25h\x1b[?2004l\x1b[0m\n"); }
	}
}
