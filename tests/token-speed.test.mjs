import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { defaultResearchPiConfig, writeResearchPiAgentConfig } from "../.pi/lib/research-config.mjs";
import { researchPiExtensions } from "../.pi/lib/research-extensions.mjs";
import { PerformanceFooterComponent } from "../.pi/lib/performance-footer.mjs";
import { visibleWidth } from "@earendil-works/pi-tui";

test("bundled TPS extension reads isolated defaults, counts provider tokens and displays TTFT across reload", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-tps-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	// Upstream getAgentDir() is evaluated when jiti loads the extension.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeResearchPiAgentConfig(agentDir, defaultResearchPiConfig());
		const extensionPath = researchPiExtensions(fileURLToPath(new URL("..", import.meta.url)))
			.find((path) => path.endsWith("/token-speed.ts"));
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir),
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [extensionPath],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		let extension = loader.getExtensions().extensions[0];
		assert.ok(extension.commands.has("tps"));
		let status;
		let widget;
		let widgetPlacement;
		let renders = 0;
		const notices = [];
		const context = {
			mode: "tui",
			model: { provider: "synthetic" },
			ui: {
				theme: { fg: (_style, text) => text },
				setStatus: (key, text) => { assert.equal(key, "tokenSpeed"); assert.equal(text, undefined); },
				setWidget: (key, factory, options) => {
					assert.equal(key, "research_performance");
					widgetPlacement = options?.placement;
					widget = factory?.({ requestRender: () => { renders += 1; } });
				},
				notify: (...args) => notices.push(args),
			},
		};
		const emit = async (name, event) => {
			for (const handler of extension.handlers.get(name) ?? []) await handler(event, context);
			status = widget?.render(100).join("\n");
		};
		let now = 1000;
		t.mock.method(Date, "now", () => now);
		await emit("session_start", { type: "session_start", reason: "startup" });
		assert.match(status, /TPS: --/);
		assert.match(status, /TTFT: --/);
		assert.equal(widgetPlacement, "belowEditor");
		await emit("message_start", { message: { role: "user" } });
		now = 1250;
		await emit("message_update", { assistantMessageEvent: { type: "text_start" } });
		now = 1500;
		await emit("message_update", {
			assistantMessageEvent: { type: "text_delta", delta: "a chunk", partial: { usage: { output: 10 } } },
		});
		// Ten reported tokens in the upstream minimum 100ms window; delta counting would show 10 tok/s.
		assert.match(status, /100\.0 tok\/s/);
		assert.match(status, /TTFT: 250 ms/);
		now = 1750;
		await emit("message_update", {
			assistantMessageEvent: { type: "text_delta", delta: "another chunk", partial: { usage: { output: 30 } } },
		});
		now = 2250;
		await emit("agent_end", { messages: [{ role: "assistant", usage: { output: 30 } }] });
		assert.match(status, /30\.0 tok\/s/);
		assert.match(status, /TTFT: 250 ms/);
		assert.deepEqual(notices, []);
		assert.ok(renders > 0, "measurement updates request a UI render");
		await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		assert.equal(widget, undefined);
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		extension = loader.getExtensions().extensions[0];
		await emit("session_start", { type: "session_start", reason: "reload" });
		assert.match(status, /TPS: --/);
	} finally {
		t.mock.restoreAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("the performance row keeps TPS and TTFT at narrow widths instead of clipping the second metric", () => {
	const widget = new PerformanceFooterComponent();
	widget.update("⚡ TPS: \x1b[32m42.3 tok/s\x1b[0m (TTFT: 450 ms)\u200b");
	for (const width of [20, 32, 80, 160]) {
		const lines = widget.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /42\.3 tok\/s/);
		assert.match(lines.join("\n"), /TTFT: 450 ms/);
		assert.equal(lines.length, width < 40 ? 2 : 1);
	}
});
