import { spawn } from "node:child_process";
import { mkdir, chmod, readFile, writeFile, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { residentWebDirectory, findResidentWeb } from "./web-resident.mjs";
import { residentControlDirectory } from "./web-tmux.mjs";
import { withOwnerFileLock } from "./owner-file-lock.mjs";
import { RuntimeClient } from "./runtime-client.mjs";

export async function runtimeDirectory(stateRoot, cwd, analysis = false) {
	const original = await residentWebDirectory(stateRoot, cwd);
	return join(stateRoot, "hosts", original.split(/[\\/]/).at(-1) + (analysis ? "-analysis" : ""));
}

export async function findRuntime(stateRoot, cwd, analysis = false) {
	const directory = await runtimeDirectory(stateRoot, cwd, analysis);
	let record;
	try { record = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8")); }
	catch (e) { if (e.code === "ENOENT") return null; throw e; }
	const client = new RuntimeClient(record.socketPath);
	try { await client.connect(); return { ...record, directory, state: client.state }; }
	catch (e) {
		try { process.kill(record.pid, 0); } catch (probe) { if (probe.code === "ESRCH") { await unlink(join(directory, "runtime.json")); return null; } throw probe; }
		throw new Error(`Runtime ${record.pid} is alive but unavailable: ${e.message}`);
	} finally { client.close(); }
}

export async function ensureRuntime({ stateRoot, cwd, env, packageRoot, args, agentDir, sessionDir, hasSessionOptions = false, analysis = false }) {
	const directory = await runtimeDirectory(stateRoot, cwd, analysis);
	await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
	return withOwnerFileLock(join(directory, "startup.lock"), async () => {
		const old = await findRuntime(stateRoot, cwd, analysis);
		if (old) {
			if (hasSessionOptions) throw new Error("This Runtime is already running; attach and change its model/session there, or explicitly stop it first");
			return old;
		}
		const legacy = await findResidentWeb(stateRoot, cwd);
		if (legacy) throw new Error("An existing legacy Pi is running in this workspace. Attach with --legacy-ui; migrate only after saving and explicitly stopping that resident.");
		const socketPath = join(await residentControlDirectory(directory), "runtime.sock");
		const logPath = join(directory, "runtime.log"), log = await open(logPath, "a", 0o600);
		let child;
		try { child = spawn(process.execPath, [join(packageRoot, ".pi/lib/runtime-process.mjs")], { cwd, env, detached: true, stdio: ["pipe", log.fd, log.fd] }); }
		finally { await log.close(); }
		let failure; child.on("error", (e) => { failure = e; }); child.stdin.on("error", (e) => { failure = e; });
		child.stdin.end(JSON.stringify({ directory, socketPath, stateRoot, cwd, args, agentDir, sessionDir })); child.unref();
		const deadline = Date.now() + 35000;
		while (Date.now() < deadline) {
			if (failure) throw failure;
			if (child.exitCode !== null || child.signalCode) throw new Error("Runtime startup failed; inspect " + logPath);
			const record = await findRuntime(stateRoot, cwd, analysis); if (record) return record;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		child.kill("SIGTERM"); throw new Error("Runtime startup timed out: " + logPath);
	});
}

export async function writeRuntimeRecord(directory, record) {
	await writeFile(join(directory, "runtime.json"), JSON.stringify(record), { mode: 0o600 });
}
