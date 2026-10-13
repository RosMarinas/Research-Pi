import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { fauxProvider, fauxAssistantMessage } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { createResearchSessionRuntime } from "../.pi/lib/native-runtime-factory.mjs";
import { createNativeRuntimeHost } from "../.pi/lib/native-runtime-host.mjs";
import { defaultResearchPiConfig, writeResearchPiAgentConfig } from "../.pi/lib/research-config.mjs";

process.env.PI_OFFLINE = "1";

async function until(check) {
	const deadline = Date.now() + 10_000;
	while (!await check()) {
		if (Date.now() >= deadline) throw new Error("Expected isolated TUI state did not appear");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("native TUI retains TPS and TTFT beside overflowing task status, across resize and settings menus", async () => {
	const root = await mkdtemp(join(tmpdir(), "research-pi-performance-tui-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let host, runtime;
	try {
		await mkdir(join(root, "sessions"));
		const config = defaultResearchPiConfig();
		config.pi.settings.compaction.enabled = false;
		config.pi.settings.quietStartup = true;
		writeResearchPiAgentConfig(agentDir, config);
		const faux = fauxProvider({ tokensPerSecond: 50 });
		faux.setResponses([fauxAssistantMessage("Synthetic response for telemetry")]);
		runtime = await createResearchSessionRuntime({
			cwd: root, agentDir, sessionDir: join(root, "sessions"), model: faux.getModel(),
			args: ["--no-extensions", "--no-skills", "--no-themes", "--no-context-files",
				"--extension", fileURLToPath(new URL("../.pi/extensions/token-speed.ts", import.meta.url))],
			extensionFactories: [(pi) => {
				pi.registerProvider(faux.provider);
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setStatus("subagent", "LONG TASK DESCRIPTION ".repeat(40));
				});
			}],
		});
		host = await createNativeRuntimeHost({ runtime, instance: crypto.randomUUID(), terminalSocket: join(root, "terminal.sock") });
		const screen = async () => stripTerminalSequences((await host.terminal.snapshot()).data);
		await until(() => host.mode.onInputCallback);
		host.terminal.resize(100, 30);
		await until(async () => (await screen()).includes("TTFT: --"));
		assert.match(await screen(), /TPS: --.*TTFT: --/);
		assert.equal(host.mode.footerDataProvider.getExtensionStatuses().has("tokenSpeed"), false);
		host.terminal.input("\x1b[200~synthetic prompt\x1b[201~\r");
		await until(() => runtime.session.messages.some((message) => message.role === "assistant") && runtime.session.isIdle);
		await until(async () => /TTFT: \d+ ms/.test(await screen()));
		assert.match(await screen(), /TPS: [\d.]+ tok\/s.*TTFT: \d+ ms/);
		host.terminal.resize(24, 35);
		await until(async () => /TTFT: \d+ ms/.test(await screen()));
		assert.match(await screen(), /TPS: [\d.]+ tok\/s/);
		host.terminal.resize(100, 30);
		host.terminal.input("\x1b[200~/tps\x1b[201~\r");
		await until(async () => (await screen()).includes("Use provider tokens"));
		host.terminal.input("\x1b");
		await until(async () => /TPS: [\d.]+ tok\/s.*TTFT: \d+ ms/.test(await screen()));
	} finally {
		if (host) await host.close();
		else await runtime?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
