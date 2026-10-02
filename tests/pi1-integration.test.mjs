import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { builtInExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { researchPiExtensions } from "../.pi/lib/research-extensions.mjs";

const harnessRoot = fileURLToPath(new URL("..", import.meta.url));

test("the exact Research Pi loadout loads on Pi 1.0 and excludes optional provider experiments", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-loadout-"));
	try {
		const paths = researchPiExtensions(harnessRoot);
		assert.ok(paths.includes("builtin:codemode"));
		assert.ok(paths.includes("builtin:tool-search"));
		assert.ok(!paths.some((path) => /deepseek/.test(path)));
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: paths, extensionFactories: builtInExtensions,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, paths.length);
		const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		assert.ok(tools.includes("codemode"));
		assert.equal(tools.filter((name) => name === "subagent").length, 1);
		assert.ok(!tools.includes("codex_advisor"));
		assert.ok(!tools.includes("codex_delegate"));
		assert.ok(!tools.includes("web_search"));
		const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
		for (const name of ["subagents", "watch", "models", "message", "steer"]) {
			assert.equal(commands.filter((command) => command === name).length, 1, `${name} has one shared entry point`);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("native codemode batches independent calls and nested calls retain policy hooks", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codemode-"));
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } });
	const faux = fauxProvider();
	const calls = [], errors = [];
	let forbiddenRan = false;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: 'const results = await Promise.allSettled([tools.probe({value:"A"}), tools.probe({value:"B"}), tools.forbidden({})]); for (const result of results) text(result.status === "fulfilled" ? result.value : result.reason.message);' }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: ["builtin:codemode"],
		extensionFactories: [...builtInExtensions, (pi) => {
			pi.registerProvider(faux.provider);
			pi.on("tool_call", (event) => {
				calls.push(event.toolName);
				if (event.toolName === "forbidden") return { block: true, reason: "scope denied" };
			});
		}],
	});
	let session;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root, agentDir, model: faux.getModel(), resourceLoader: loader, settingsManager,
			sessionManager: SessionManager.inMemory(root),
			customTools: [
				{ name: "probe", label: "Probe", description: "Return a test value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} }) },
				{ name: "forbidden", label: "Forbidden", description: "Blocked test operation", parameters: { type: "object", properties: {} }, execute: async () => { forbiddenRan = true; return { content: [{ type: "text", text: "wrong" }], details: {} }; } },
			],
		}));
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		assert.ok(session.getActiveToolNames().includes("codemode"));
		await session.prompt("Run the synthetic batch");
		assert.deepEqual(errors, []);
		assert.deepEqual(calls.sort(), ["codemode", "forbidden", "probe", "probe"]);
		assert.equal(forbiddenRan, false);
		const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.match(output, /A/);
		assert.match(output, /B/);
		assert.match(output, /scope denied/);
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
