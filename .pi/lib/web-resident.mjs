import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, chmod, realpath, readFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withOwnerFileLock } from "./owner-file-lock.mjs";
import { residentRequest } from "./web-terminal.mjs";

export async function residentWebDirectory(stateRoot, cwd) {
	const canonical = await realpath(cwd);
	const key = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	return join(stateRoot, "web", key);
}

export async function findResidentWeb(stateRoot, cwd) {
	const directory = await residentWebDirectory(stateRoot, cwd);
	let record;
	try { record = JSON.parse(await readFile(join(directory, "access.json"), "utf8")); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
	try {
		const response = await residentRequest(record);
		if (response.instance !== record.instance) throw new Error("Resident instance changed");
		return { ...record, directory, state: response.state };
	} catch (error) {
		let alive = true;
		try { process.kill(record.pid, 0); } catch (probe) { if (probe.code === "ESRCH") alive = false; }
		if (alive) throw new Error("A resident Pi is still running but its control socket is unavailable: " + error.message);
		await unlink(join(directory, "access.json"));
		return null;
	}
}

export async function ensureResidentWeb({ stateRoot, cwd, env, packageRoot, executable, args, options, hasSessionOptions = false }) {
	const root = join(stateRoot, "web");
	await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
	// Serialize startup across projects so two new hosts do not claim one Serve port.
	return await withOwnerFileLock(join(root, "startup.lock"), async () => {
		const existing = await findResidentWeb(stateRoot, cwd);
		if (existing) {
			if (existing.state?.cwd && await realpath(existing.state.cwd) !== await realpath(cwd)) throw new Error("This resident Pi switched to " + existing.state.cwd + ". Use its existing terminal, or pi web stop in the original workspace before restarting.");
			if (hasSessionOptions) throw new Error("This workspace already has a resident Pi. Run pi to attach, then use /resume or /model there; use pi web stop before changing startup options.");
			return { ...existing, reused: true };
		}
		const directory = await residentWebDirectory(stateRoot, cwd);
		await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
		const logPath = join(directory, "host.log");
		const log = await open(logPath, "a", 0o600);
		let child;
		try {
			child = spawn(process.execPath, [join(packageRoot, ".pi/lib/web-host.mjs")], {
				cwd, env: { ...env, RESEARCH_PI_STATE_DIR: stateRoot }, detached: true, stdio: ["pipe", log.fd, log.fd],
			});
		} finally { await log.close(); }
		let failure;
		child.on("error", (error) => { failure = error; });
		child.stdin.on("error", (error) => { failure = error; });
		child.stdin.end(JSON.stringify({ executable, args, cwd, packageRoot, options: { ...options, hasSessionOptions }, residentDir: directory }));
		child.unref();
		const deadline = Date.now() + 35_000;
		while (Date.now() < deadline) {
			if (failure) throw failure;
			if (child.exitCode !== null || child.signalCode) {
				const detail = (await readFile(logPath, "utf8")).slice(-3000).replace(/#token=[^\s]+/g, "#token=[redacted]");
				throw new Error("Resident Pi failed to start. " + detail);
			}
			const record = await findResidentWeb(stateRoot, cwd);
			if (record) return { ...record, reused: false };
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		child.kill("SIGTERM");
		throw new Error("Resident Pi startup timed out; see " + logPath);
	}, { attempts: 450, waitMs: 100, timeoutMessage: "Another resident Pi is starting; try pi again after it finishes" });
}

export async function stopResidentWeb(record) {
	await residentRequest(record, "stop");
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try { await readFile(join(record.directory, "access.json")); }
		catch (error) { if (error.code === "ENOENT") return; throw error; }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Pi is still shutting down; check pi web status before starting it again");
}
