import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withOwnerFileLock } from "../.pi/lib/owner-file-lock.mjs";

test("owner file locks preserve live holders and recover dead stale holders", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-owner-lock-"));
	const lockPath = join(root, "ledger.lock");
	try {
		let release;
		const held = withOwnerFileLock(lockPath, () => new Promise((resolve) => { release = resolve; }));
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(
			withOwnerFileLock(lockPath, async () => "must not run", { attempts: 2, waitMs: 1, staleMs: 0 }),
			/Timed out acquiring file lock/,
		);
		release();
		await held;

		writeFileSync(lockPath, `${JSON.stringify({ token: "dead", pid: 2_147_483_647 })}\n`);
		assert.equal(
			await withOwnerFileLock(lockPath, async () => "recovered", { attempts: 2, waitMs: 1, staleMs: -1 }),
			"recovered",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
