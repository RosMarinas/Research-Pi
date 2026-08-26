import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

export async function withOwnerFileLock(lockPath, operation, options = {}) {
	const token = randomUUID();
	const attempts = options.attempts ?? 80;
	const waitMs = options.waitMs ?? 25;
	const staleMs = options.staleMs ?? 30_000;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		let handle;
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const [age, owner] = await Promise.all([
				stat(lockPath).then((entry) => Date.now() - entry.mtimeMs).catch(() => 0),
				readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null),
			]);
			if (age > staleMs && !processIsAlive(owner?.pid)) await unlink(lockPath).catch(() => undefined);
			else await delay(waitMs);
			continue;
		}
		let initialized = false;
		try {
			await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
			initialized = true;
			return await operation();
		} finally {
			await handle.close().catch(() => undefined);
			const stillOwned = !initialized || await readFile(lockPath, "utf8")
				.then((text) => JSON.parse(text)?.token === token)
				.catch(() => false);
			if (stillOwned) await unlink(lockPath).catch(() => undefined);
		}
	}
	throw new Error(options.timeoutMessage ?? `Timed out acquiring file lock: ${lockPath}`);
}
