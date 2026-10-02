import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerModelSettings } from "../.pi/extensions/research-config.ts";
import { defaultCodexModel, defaultCodexReasoningEffort, defaultCodexServiceTier } from "../.pi/lib/codex-jobs.mjs";
import { defaultResearchPiConfig, readResearchPiConfig, resolveResearchPiConfig, writeResearchPiAgentConfig, writeResearchPiConfig } from "../.pi/lib/research-config.mjs";
import { codexModelConfigArgs, codexReasoningChoices, codexServiceTierParams, codexSupportsFast, leaderServiceTierPayload, parseAntigravityModels } from "../.pi/lib/model-settings.mjs";

const catalog = [
	{ model: "gpt-6-astra", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "high", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })), serviceTiers: [{ id: "priority", name: "Fast" }] },
	{ model: "gpt-6-luna", defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high", "max"].map((reasoningEffort) => ({ reasoningEffort })), serviceTiers: [{ id: "priority", name: "Fast" }] },
	{ model: "gpt-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })), serviceTiers: [] },
];
const leader = { provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };

test("Fast changes only the selected native GPT request tier, not effort or other providers", () => {
	const payload = { model: leader.id, reasoning: { effort: "max" }, input: [] };
	const tiers = { "openai-codex/gpt-6-astra": "fast" };
	assert.deepEqual(leaderServiceTierPayload(payload, leader, tiers), { ...payload, service_tier: "priority" });
	assert.equal(payload.service_tier, undefined);
	assert.equal(leaderServiceTierPayload(payload, { ...leader, id: "gpt-6-luna" }, tiers), undefined);
	assert.equal(leaderServiceTierPayload(payload, { ...leader, provider: "deepseek" }, tiers), undefined);
	assert.equal(leaderServiceTierPayload(payload, leader, {}), undefined);
	assert.equal(leaderServiceTierPayload(payload, leader, { "openai-codex/gpt-6-astra": "standard" }).service_tier, "default");
	assert.equal(codexSupportsFast(catalog[0]), true);
	assert.equal(codexSupportsFast(catalog[2]), false);
});

test("Codex speed and subagent settings use native keys; inherit sends no override", () => {
	assert.deepEqual(codexModelConfigArgs({ serviceTier: "inherit", subagent: { model: "inherit", reasoningEffort: "inherit" } }), ["-c", 'web_search="live"']);
	assert.deepEqual(codexModelConfigArgs({ serviceTier: "fast", subagent: { model: "gpt-6-luna", reasoningEffort: "high" } }), [
		"-c", 'web_search="live"', "-c", 'service_tier="fast"', "-c", "features.fast_mode=true",
		"-c", 'agents.default_subagent_model="gpt-6-luna"', "-c", 'agents.default_subagent_reasoning_effort="high"',
	]);
	assert.deepEqual(codexModelConfigArgs({ serviceTier: "standard" }), ["-c", 'web_search="live"', "-c", 'service_tier="default"']);
	assert.deepEqual(codexServiceTierParams("inherit"), {});
	assert.deepEqual(codexServiceTierParams("fast"), { serviceTier: "priority" });
	assert.deepEqual(codexServiceTierParams("standard"), { serviceTier: "default" });
	const config = resolveResearchPiConfig({ subagents: { advisor: { model: "gpt-6-astra" }, executor: { model: "gpt-6-luna" } } });
	assert.deepEqual(codexReasoningChoices(config, catalog, "inherit"), ["low", "high", "max"]);
	assert.throws(() => resolveResearchPiConfig({ subagents: { executor: { speed: "ultrafast" } } }), /speed/);
	assert.throws(() => resolveResearchPiConfig({ subagents: { executor: { model: "inherit" } } }), /must name a Codex model/);
	assert.throws(() => resolveResearchPiConfig({ pi: { modelServiceTiers: { "openai/gpt-6-astra": "oops" } } }), /modelServiceTiers/);
});

test("Antigravity model catalog ignores progress text and keeps model labels", () => {
	assert.deepEqual(parseAntigravityModels([
		"Fetching available models...",
		"gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
		"claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
		"",
	].join("\n")), [
		{ model: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
		{ model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
	]);
});

test("model center persists native Leader defaults, updates live worker defaults, and confirms extra quota", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-model-settings-"));
	const previousEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^RESEARCH_PI_(?:CODEX|SUBAGENT)_/.test(key)));
	try {
		const configPath = join(root, "config.json");
		const agentDir = join(root, "agent");
		writeResearchPiConfig(configPath, defaultResearchPiConfig());
		writeResearchPiAgentConfig(agentDir, defaultResearchPiConfig());
		const commands = new Map(), handlers = new Map(), notices = [];
		let effort = "max", approve = false, confirmations = 0;
		const pi = {
			registerCommand(name, command) { commands.set(name, command); },
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel: () => effort,
			setThinkingLevel: (value) => { effort = value; },
			setModel: async (model) => { ctx.model = model; return true; },
		};
		const ctx = {
			cwd: root, model: leader, hasUI: true, isIdle: () => true,
			modelRegistry: { refresh: async () => {}, getAvailable: () => [leader] },
			ui: { notify(message, type) { notices.push({ message, type }); }, confirm: async () => { confirmations++; return approve; } },
		};
		const handler = registerModelSettings(pi, { configPath, agentDir, listModels: async () => catalog });
		await handler("executor model gpt-6-astra", ctx);
		await handler("executor thinking high", ctx);
		assert.equal(defaultCodexModel("executor"), "gpt-6-astra");
		assert.equal(defaultCodexReasoningEffort("executor"), "high");
		assert.equal(defaultCodexModel("advisor"), "gpt-5.6-sol");
		await handler("executor speed fast", ctx);
		assert.equal(defaultCodexServiceTier("executor"), "inherit", "cancel must not enable Fast");
		approve = true;
		await handler("executor speed fast", ctx);
		assert.equal(defaultCodexServiceTier("executor"), "fast");
		assert.equal(confirmations, 2);
		await handler("internal model gpt-6-luna", ctx);
		await handler("internal thinking high", ctx);
		assert.deepEqual(readResearchPiConfig(configPath).codex.internalSubagent, { model: "gpt-6-luna", thinking: "high" });
		await handler("internal thinking ultra", ctx);
		assert.match(notices.at(-1).message, /Unsupported reasoning effort/);
		assert.equal(readResearchPiConfig(configPath).codex.internalSubagent.thinking, "high");
		await handler("internal speed fast", ctx);
		assert.match(notices.at(-1).message, /inherit backend and speed/);
		await handler("leader model openai-codex/gpt-6-astra", ctx);
		await handler("leader thinking high", ctx);
		const native = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(native.defaultProvider, "openai-codex");
		assert.equal(native.defaultModel, "gpt-6-astra");
		assert.equal(native.defaultThinkingLevel, "high");
		assert.equal(native.modelThinkingLevels["openai-codex/gpt-6-astra"], "high");
		assert.equal(native.theme, "research-pi");
		assert.equal(readResearchPiConfig(configPath).pi.settings.defaultModel, undefined);
		await commands.get("fast").handler("on", ctx);
		assert.deepEqual(handlers.get("before_provider_request")({ payload: { model: leader.id } }, ctx), { model: leader.id, service_tier: "priority" });
		await commands.get("fast").handler("off", ctx);
		assert.equal(handlers.get("before_provider_request")({ payload: {} }, ctx).service_tier, "default");
		await commands.get("fast").handler("inherit", ctx);
		assert.equal(handlers.get("before_provider_request")({ payload: {} }, ctx), undefined);
		await handler("executor speed standard", ctx);
		await handler("executor model gpt-5.5", ctx);
		await handler("executor speed fast", ctx);
		assert.match(notices.at(-1).message, /does not advertise Fast/);
		assert.equal(defaultCodexServiceTier("executor"), "standard");
		await handler("executor model inherit", ctx);
		assert.match(notices.at(-1).message, /must name its model/);
		ctx.ui.select = async (title, choices) => title.includes("select a role") ? choices[2] : title.endsWith("setting") ? "thinking" : "low";
		await handler("", ctx);
		assert.equal(defaultCodexReasoningEffort("executor"), "low", "the interactive entry must reach the same live configuration");
		await handler("show", ctx);
		assert.match(notices.at(-1).message, /explicit dispatch values override one Action only/);
	} finally {
		for (const key of Object.keys(process.env)) if (/^RESEARCH_PI_(?:CODEX|SUBAGENT)_/.test(key)) delete process.env[key];
		Object.assign(process.env, previousEnvironment);
		rmSync(root, { recursive: true, force: true });
	}
});
