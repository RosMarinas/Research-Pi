import { spawn } from "node:child_process";
import { readFile, open, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureRuntime } from "./runtime-resident.mjs";
import { RuntimeClient } from "./runtime-client.mjs";
import { harnessDirectory } from "./harness-projects.mjs";
import { withOwnerFileLock } from "./owner-file-lock.mjs";

export async function findRuntimeGateway(record) {
	let gateway;
	try { gateway = JSON.parse(await readFile(join(record.stateRoot ? harnessDirectory(record.stateRoot) : record.directory, "gateway.json"), "utf8")); }
	catch (e) { if (e.code === "ENOENT") return null; throw e; }
	try { process.kill(gateway.pid, 0); return gateway; }
	catch (e) { if (e.code !== "ESRCH") throw e; await unlink(join(record.stateRoot ? harnessDirectory(record.stateRoot) : record.directory, "gateway.json")); return null; }
}

export async function ensureRuntimeGateway({ record, stateRoot, packageRoot, env, web }) {
	record ??= { stateRoot, directory: harnessDirectory(stateRoot) };
	await mkdir(harnessDirectory(stateRoot), { recursive: true, mode: 0o700 });
	return withOwnerFileLock(join(harnessDirectory(stateRoot), "gateway.lock"), async () => {
		const old = await findRuntimeGateway(record); if (old) return old;
		const logPath = join(harnessDirectory(stateRoot), "gateway.log"), log = await open(logPath, "a", 0o600);
		let child;
		try { child = spawn(process.execPath, [join(packageRoot, ".pi/lib/runtime-gateway-process.mjs")], { cwd: packageRoot, env, detached: true, stdio: ["pipe", log.fd, log.fd] }); }
		finally { await log.close(); }
		let error; child.on("error", (e) => { error = e; }); child.stdin.on("error", (e) => { error = e; });
		child.stdin.end(JSON.stringify({ record, stateRoot, packageRoot, assetsRoot: join(packageRoot, "web"), web })); child.unref();
		const end = Date.now() + 35000;
		while (Date.now() < end) {
			if (error) throw error;
			if (child.exitCode !== null || child.signalCode) throw new Error("Web gateway startup failed; Runtime is still available. Inspect " + logPath);
			const gateway = await findRuntimeGateway(record); if (gateway) return gateway;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		child.kill("SIGTERM"); throw new Error("Web gateway startup timed out: " + logPath);
	});
}

export async function launchRuntime(options) {
	const record = await ensureRuntime(options);
	if (options.web.enabled) {
		const gateway = await ensureRuntimeGateway({ ...options, record });
		process.stderr.write(`Research Pi local Web: ${gateway.localUrl.replace("/#", "/?project=" + record.projectId + "#")}\n`);
		if (gateway.url !== gateway.localUrl) process.stderr.write(`Research Pi mobile Web: ${gateway.url.replace("/#", "/?project=" + record.projectId + "#")}\n`);
	}
	if (!options.background) {
		const { attachRuntimeTui } = await import("./runtime-tui.mjs");
		await attachRuntimeTui(record);
	}
	return record;
}

export async function stopRuntime(record) {
	const client = await new RuntimeClient(record.socketPath).connect();
	try { return await client.call("runtime.stop"); } finally { client.close(); }
}
