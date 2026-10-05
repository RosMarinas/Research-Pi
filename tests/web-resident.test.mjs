import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureResidentWeb, findResidentWeb, stopResidentWeb } from "../.pi/lib/web-resident.mjs";
import { parseWebOptions } from "../.pi/lib/web-launcher.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("configured Web starts automatically only for interactive Pi, with explicit overrides", () => {
	const defaults = { mode: "tailscale", persistent: true, port: 0, httpsPort: 8443 };
	const options = { interactive: true };
	const automatic = parseWebOptions([], defaults, options);
	assert.equal(automatic.enabled, true); assert.equal(automatic.tailscale, true); assert.equal(automatic.persistent, true);
	assert.equal(automatic.port, 0);
	assert.equal(parseWebOptions([], defaults, { interactive: false }).enabled, false);
	for (const args of [["--mode", "rpc"], ["--mode=rpc"], ["--print", "hello"], ["--version"], ["--help"]]) {
		assert.equal(parseWebOptions(args, defaults, options).enabled, false);
	}
	assert.equal(parseWebOptions(["--no-web"], defaults, options).enabled, false);
	assert.equal(parseWebOptions(["--analysis"], defaults, options).enabled, false, "Analysis must coexist with the workspace's resident Leader");
	assert.equal(parseWebOptions(["--web"], defaults, options).tailscale, false);
	assert.equal(parseWebOptions(["--web-foreground"], defaults, options).persistent, false);
	assert.equal(parseWebOptions(["--web-https-port", "9443"], defaults, options).autoHttpsPort, false);
	assert.throws(() => parseWebOptions(["--no-web", "--web"], defaults, options), /cannot be combined/);
});

test("one token and browser cookie survive projects, gateway failure, and resident restarts", { timeout: 20000 }, async (t) => {
	try { await promisify(execFile)("tmux", ["-V"]); } catch { t.skip("tmux is not installed"); return; }
	const root = await mkdtemp(join(tmpdir(), "rpi-tmux-recovery-"));
	const other = join(root, "other");
	const { mkdir } = await import("node:fs/promises"); await mkdir(other);
	const input = { stateRoot: root, cwd: root, packageRoot, env: { PATH: process.env.PATH, HOME: root }, executable: process.execPath,
		args: ["-e", "process.stdout.write('PI_OWNER:'+process.pid);process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('AFTER_RECOVERY:'+d))"], options: { port: 0, tailscale: false } };
	let first, second;
	try {
		first = await ensureResidentWeb(input); assert.ok(first.tmuxSocket);
		const token = new URL(first.localUrl).hash.slice(7);
		const origin = new URL(first.localUrl).origin;
		const login = await fetch(origin + "/api/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
		const cookie = login.headers.get("set-cookie").split(";")[0];
		second = await ensureResidentWeb({ ...input, cwd: other });
		assert.equal(new URL(second.localUrl).hash.slice(7), token);
		assert.equal((await fetch(new URL(second.localUrl).origin + "/api/session", { headers: { cookie } })).status, 200);
		const tmux = promisify(execFile);
		const before = (await tmux("tmux", ["-S", first.tmuxSocket, "display-message", "-p", "#{pane_pid}"])).stdout.trim();
		process.kill(first.pid, "SIGKILL");
		for (let i = 0; i < 50; i++) { try { process.kill(first.pid, 0); } catch { break; } await new Promise(r => setTimeout(r, 20)); }
		first = await ensureResidentWeb(input);
		assert.equal(first.recovered, true);
		assert.equal((await tmux("tmux", ["-S", first.tmuxSocket, "display-message", "-p", "#{pane_pid}"])).stdout.trim(), before);
		assert.equal(new URL(first.localUrl).hash.slice(7), token);
		assert.equal((await fetch(new URL(first.localUrl).origin + "/api/session", { headers: { cookie } })).status, 200);
		await tmux("tmux", ["-S", first.tmuxSocket, "send-keys", "-l", "still-running"]);
		await new Promise(r => setTimeout(r, 80));
		assert.match((await tmux("tmux", ["-S", first.tmuxSocket, "capture-pane", "-p"])).stdout, /AFTER_RECOVERY:still-running/);
		const oldSocket = first.tmuxSocket;
		await stopResidentWeb(first); first = null;
		await assert.rejects(tmux("tmux", ["-S", oldSocket, "has-session", "-t", "pi"]));
	} finally {
		if (first) await stopResidentWeb(first);
		if (second) await stopResidentWeb(second);
		await rm(root, { recursive: true, force: true });
	}
});

test("resident Pi survives desktop detach, reuses one PTY and stops only on an explicit stop", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "rpi-resident-test-"));
	const environment = { PATH: process.env.PATH, HOME: root, TERM: "xterm-256color" };
	const input = { stateRoot: root, cwd: root, packageRoot, env: environment, executable: process.execPath,
		args: ["-e", "process.stdout.write('RESIDENT_READY');process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write('ECHO:'+data.toString()))"],
		options: { port: 0, tailscale: false } };
	let record, client;
	try {
		record = await ensureResidentWeb(input);
		assert.equal(record.reused, false);
		assert.equal((await ensureResidentWeb(input)).pid, record.pid);
		await assert.rejects(ensureResidentWeb({ ...input, hasSessionOptions: true }), /already has a resident Pi/);
		const modulePath = fileURLToPath(new URL("../.pi/lib/web-terminal.mjs", import.meta.url));
		client = pty.spawn(process.execPath, ["--input-type=module", "-e",
			`import {attachResidentTerminal} from ${JSON.stringify(modulePath)};await attachResidentTerminal(${JSON.stringify({ instance: record.instance, terminalSocket: record.terminalSocket })});`],
			{ cwd: root, env: environment, cols: 100, rows: 30 });
		let output = "";
		const listeners = new Set();
		client.onData((data) => { output += data; for (const notify of listeners) notify(); });
		const until = (text) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Missing terminal output: " + text)); }, 5000);
			const check = () => { if (output.includes(text)) { clearTimeout(timer); listeners.delete(check); resolve(); } };
			listeners.add(check); check();
		});
		await until("RESIDENT_READY");
		client.write("persistent-message"); await until("ECHO:persistent-message");
		const exit = new Promise((resolve) => client.onExit(resolve));
		client.write("\x1d");
		assert.equal((await exit).exitCode, 0); client = null;
		assert.equal((await findResidentWeb(root, root)).pid, record.pid);
		assert.equal((await ensureResidentWeb(input)).pid, record.pid);
		assert.equal(JSON.parse(await readFile(join(record.directory, "access.json"), "utf8")).instance, record.instance);
		await stopResidentWeb(record); record = null;
		assert.equal(await findResidentWeb(root, root), null);
	} finally {
		client?.kill();
		if (record) await stopResidentWeb(record);
		await rm(root, { recursive: true, force: true });
	}
});
