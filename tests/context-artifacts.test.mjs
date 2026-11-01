import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import researchMode from "../.pi/extensions/research-mode.ts";
import { resolveBoundaryPath } from "../.pi/lib/project-boundary.mjs";

function toolResultHandler() {
	const handlers = new Map();
	researchMode({ on: (event, handler) => handlers.set(event, handler) });
	return handlers.get("tool_result");
}

test("large tool output is saved within the project and can be read without an external grant", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-artifact-"));
	try {
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "subdir"));
		const handler = toolResultHandler();
		const ctx = { cwd: join(root, "subdir"), sessionManager: { getSessionId: () => "session-1" } };
		const output = "large output ".repeat(1_000);
		const result = await handler({ toolName: "codemode", toolCallId: "call-1", content: [{ type: "text", text: output }], details: {} }, ctx);
		const artifact = result.details.contextArtifactPath;
		assert.ok(artifact.startsWith(join(realpathSync(root), "tmp", "pi", "context-artifacts", "session-1") + sep));
		assert.equal(readFileSync(artifact, "utf8"), output);
		assert.equal((await resolveBoundaryPath(root, artifact)).inside, true);
		assert.match(result.content[0].text, /Reference:/);

		const source = join(root, "full-output.txt");
		writeFileSync(source, "original bash output");
		const bash = await handler({ toolName: "bash", toolCallId: "call-2", content: [], details: { fullOutputPath: source } }, ctx);
		assert.equal(readFileSync(bash.details.contextArtifactPath, "utf8"), "original bash output");
		assert.equal((await resolveBoundaryPath(root, bash.details.contextArtifactPath)).inside, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("artifact storage rejects a tmp symlink that escapes the project", { skip: process.platform === "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-artifact-root-"));
	const outside = mkdtempSync(join(tmpdir(), "research-pi-artifact-outside-"));
	try {
		mkdirSync(join(root, "tmp"));
		symlinkSync(outside, join(root, "tmp", "pi"), "dir");
		await assert.rejects(toolResultHandler()({
			toolName: "codemode", toolCallId: "call-1", content: [{ type: "text", text: "x".repeat(8_001) }], details: {},
		}, { cwd: root, sessionManager: { getSessionId: () => "session-1" } }), /crosses the project boundary/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
