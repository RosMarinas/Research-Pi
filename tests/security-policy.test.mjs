import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSystemRuntimePolicy } from "../.pi/lib/security-policy.mjs";

test("macOS developer runtime is discovered and injected read-only", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-developer-runtime-"));
	try {
		const developer = join(root, "CommandLineTools");
		mkdirSync(developer);
		const policy = await resolveSystemRuntimePolicy({
			platform: "darwin",
			environment: {},
			execFile: async () => ({ stdout: `${developer}\n`, stderr: "" }),
		});
		assert.deepEqual(policy.readRoots, [realpathSync(developer)]);
		assert.equal(policy.environment.DEVELOPER_DIR, realpathSync(developer));
		assert.match(policy.diagnostics.join("\n"), /developer runtime/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex and agent skill directories are exposed as narrow read-only instruction roots", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-instruction-roots-"));
	try {
		const codexSkills = join(root, ".codex", "skills");
		const agentSkills = join(root, ".agents", "skills");
		mkdirSync(codexSkills, { recursive: true });
		mkdirSync(agentSkills, { recursive: true });
		const policy = await resolveSystemRuntimePolicy({
			platform: "linux",
			environment: {},
			homeDirectory: root,
		});
		assert.deepEqual(policy.instructionRoots, [realpathSync(codexSkills), realpathSync(agentSkills)]);
		assert.deepEqual(policy.readRoots, []);
		assert.match(policy.diagnostics.join("\n"), /trusted instruction root/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("home runtime roots require an explicit high-risk opt-in", async () => {
	await assert.rejects(
		resolveSystemRuntimePolicy({
			platform: "linux",
			environment: { RESEARCH_PI_RUNTIME_ROOTS: process.env.HOME },
		}),
		/ALLOW_HOME_RUNTIME_ROOTS/,
	);
});

test("filesystem-root runtime grants are always rejected", async () => {
	await assert.rejects(
		resolveSystemRuntimePolicy({
			platform: "linux",
			environment: { RESEARCH_PI_RUNTIME_ROOTS: "/" },
		}),
		/filesystem-root/,
	);
});
