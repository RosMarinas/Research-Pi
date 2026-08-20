import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import researchConfigExtension, { compactConfigPath, formatProfileStatus, profileSelectItems, themeSelectItems } from "../.pi/extensions/research-config.ts";
import {
	defaultResearchPiConfig,
	ensureResearchPiConfig,
	readResearchPiConfig,
	researchPiCredentialEnvironmentNames,
	researchPiDeepSeekSearchEnabled,
	researchPiEnvironment,
	researchPiProfileCredential,
	resolveResearchPiConfig,
	writeResearchPiAgentConfig,
	writeResearchPiConfig,
} from "../.pi/lib/research-config.mjs";

test("one Research Pi config resolves leader, Codex, compact, search, and UI defaults", () => {
	const config = defaultResearchPiConfig();
	assert.equal(config.activeProfile, "deepseek-pro");
	assert.equal(config.profiles[config.activeProfile].model, "deepseek-v4-pro");
	assert.equal(config.codex.executor.model, "gpt-5.6-sol");
	assert.equal(config.research.compaction.hardTokens, 384 * 1024);
	assert.equal(config.research.search.model, "deepseek-v4-flash");
	assert.equal(config.research.search.enabled, "auto");
	assert.equal(config.profiles["opencode-go-flash"].provider, "opencode-go");
	assert.equal(config.profiles["opencode-go-luna"].model, "gpt-5.6-luna");
	assert.equal(config.profiles["opencode-go-qwen"].model, "qwen3.7-plus");
	assert.equal(config.ui.density, "balanced");
	assert.equal(config.ui.runtimeStrip, "auto");
	assert.equal(config.ui.showProfileStatus, false);
	assert.equal(config.pi.settings.theme, "research-pi");
});

test("partial user config merges over defaults and rejects dangerous ambiguity", () => {
	const config = resolveResearchPiConfig({
		activeProfile: "deepseek-flash",
		codex: { executor: { model: "gpt-5.6-luna" } },
	});
	assert.equal(config.profiles[config.activeProfile].model, "deepseek-v4-flash");
	assert.equal(config.codex.executor.model, "gpt-5.6-luna");
	assert.equal(config.codex.executor.reasoningEffort, "max");
	assert.throws(() => resolveResearchPiConfig({ activeProfile: "missing" }), /does not exist/);
	assert.throws(() => resolveResearchPiConfig({ typoSetting: true }), /Unknown Research Pi config key/);
	assert.throws(() => resolveResearchPiConfig({ research: { compaction: { softTokens: 500_000 } } }), /below hardTokens/);
	assert.throws(() => resolveResearchPiConfig({ research: { search: { enabled: "sometimes" } } }), /auto, on, or off/);
	assert.throws(() => resolveResearchPiConfig({ pi: { settings: { api_key: "do-not-store-here" } } }), /credential-like/);
});

test("config persistence creates a private file, schema, and generated Pi adapters", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-config-"));
	try {
		const path = join(root, "config.json");
		const config = ensureResearchPiConfig(path);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.ok(statSync(join(root, "schemas", "research-pi-config.schema.json")).isFile());
		const changed = writeResearchPiConfig(path, { ...config, activeProfile: "deepseek-flash" });
		assert.equal(readResearchPiConfig(path).activeProfile, "deepseek-flash");
		const agentDir = join(root, "generated-agent");
		writeResearchPiAgentConfig(agentDir, changed, { coreVersion: "0.84.1" });
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		assert.equal(settings.defaultModel, "deepseek-v4-flash");
		assert.equal(settings.defaultThinkingLevel, "max");
		assert.deepEqual(settings.enabledModels.sort(), [
			"deepseek/deepseek-v4-flash:max",
			"deepseek/deepseek-v4-pro:max",
			"opencode-go/deepseek-v4-flash:max",
			"opencode-go/gpt-5.6-luna:high",
			"opencode-go/qwen3.7-plus:high",
		]);
		assert.equal(models.providers.deepseek.modelOverrides["deepseek-v4-flash"].compat.maxTokensField, "max_tokens");

		writeResearchPiAgentConfig(agentDir, resolveResearchPiConfig({ activeProfile: "opencode-go-flash" }), {
			coreVersion: "0.84.1",
			environment: { OPENCODE_API_KEY: "configured" },
		});
		const goOnlySettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.deepEqual(goOnlySettings.enabledModels.sort(), [
			"opencode-go/deepseek-v4-flash:max",
			"opencode-go/gpt-5.6-luna:high",
			"opencode-go/qwen3.7-plus:high",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config exports one deterministic environment for runtime consumers", () => {
	const config = resolveResearchPiConfig({ activeProfile: "deepseek-flash" });
	const environment = researchPiEnvironment(config);
	assert.equal(environment.RESEARCH_PI_ACTIVE_PROFILE, "deepseek-flash");
	assert.equal(environment.RESEARCH_PI_CODEX_ADVISOR_MODEL, "gpt-5.6-sol");
	assert.equal(environment.RESEARCH_PI_COMPACT_HARD_TOKENS, String(384 * 1024));
	assert.equal(environment.RESEARCH_PI_SEARCH_MODEL, "deepseek-v4-flash");
	assert.equal(environment.RESEARCH_PI_SEARCH_ENABLED, "auto");
	assert.equal(environment.RESEARCH_PI_UI_DENSITY, "balanced");
	assert.equal(environment.RESEARCH_PI_UI_RUNTIME_STRIP, "auto");
	assert.equal(environment.RESEARCH_PI_UI_SHOW_PROFILE_STATUS, "0");
});

test("provider credentials and native search are independent", () => {
	const official = resolveResearchPiConfig({ activeProfile: "deepseek-flash" });
	const go = resolveResearchPiConfig({ activeProfile: "opencode-go-flash" });
	assert.equal(researchPiProfileCredential(official).environmentVariable, "DEEPSEEK_API_KEY");
	assert.equal(researchPiProfileCredential(go).environmentVariable, "OPENCODE_API_KEY");
	assert.deepEqual(researchPiCredentialEnvironmentNames(go).sort(), ["DEEPSEEK_API_KEY", "OPENCODE_API_KEY"]);
	assert.equal(researchPiDeepSeekSearchEnabled(go, { OPENCODE_API_KEY: "go-key" }), false);
	assert.equal(researchPiDeepSeekSearchEnabled(go, { OPENCODE_API_KEY: "go-key", DEEPSEEK_API_KEY: "ds-key" }), true);
	assert.equal(researchPiDeepSeekSearchEnabled(resolveResearchPiConfig({ research: { search: { enabled: "off" } } }), {}), false);
	assert.throws(
		() => researchPiDeepSeekSearchEnabled(resolveResearchPiConfig({ research: { search: { enabled: "on" } } }), {}),
		/DEEPSEEK_API_KEY is missing/,
	);
});

test("Codex, compact, and search modules consume the configured environment", () => {
	const root = resolve(new URL("..", import.meta.url).pathname);
	const codex = pathToFileURL(join(root, ".pi", "lib", "codex-jobs.mjs")).href;
	const compact = pathToFileURL(join(root, ".pi", "lib", "research-compact.mjs")).href;
	const search = pathToFileURL(join(root, ".pi", "lib", "deepseek-web-search.mjs")).href;
	const script = `
		const codex = await import(${JSON.stringify(codex)});
		const compact = await import(${JSON.stringify(compact)});
		const search = await import(${JSON.stringify(search)});
		const parsed = search.parseDeepSeekWebSearchResponse({content:[{type:"web_search_tool_result",content:[1,2,3].map(i=>({type:"web_search_result",url:"https://example.com/"+i,title:"S"+i}))}]});
		console.log(JSON.stringify({advisor:codex.defaultCodexModel("advisor"),executor:codex.defaultCodexModel("executor"),effort:codex.defaultCodexReasoningEffort("advisor"),soft:compact.RESEARCH_SOFT_COMPACT_TOKENS,hard:compact.RESEARCH_HARD_COMPACT_TOKENS,tail:compact.RESEARCH_RECENT_TAIL_SCHEDULE,sources:parsed.sources.length}));
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		env: {
			...process.env,
			RESEARCH_PI_CODEX_ADVISOR_MODEL: "gpt-advisor-configured",
			RESEARCH_PI_CODEX_EXECUTOR_MODEL: "gpt-executor-configured",
			RESEARCH_PI_CODEX_ADVISOR_EFFORT: "high",
			RESEARCH_PI_COMPACT_SOFT_TOKENS: "111",
			RESEARCH_PI_COMPACT_HARD_TOKENS: "222",
			RESEARCH_PI_COMPACT_RECENT_TAIL_TOKENS: "7,8",
			RESEARCH_PI_SEARCH_MAX_SOURCES: "2",
		},
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		advisor: "gpt-advisor-configured",
		executor: "gpt-executor-configured",
		effort: "high",
		soft: 111,
		hard: 222,
		tail: [7, 8],
		sources: 2,
	});
});

test("model profile UI is concise, descriptive, and reflects live session overrides", () => {
	const config = defaultResearchPiConfig();
	const items = profileSelectItems(config);
	assert.equal(items.length, 5);
	assert.match(items[0].label, /^● /);
	assert.match(items[0].description, /deepseek\/deepseek-v4-pro/);
	assert.match(items[1].description, /Lower latency/);
	assert.match(items[2].description, /opencode-go\/deepseek-v4-flash/);
	assert.equal(compactConfigPath("/Users/polaris/Documents/Utils/Pi/.worktrees/runtime-next/.pi/config.json"), "…/.worktrees/runtime-next/.pi/config.json");
	const status = formatProfileStatus(config, {
		model: { provider: "deepseek", id: "deepseek-v4-flash" },
		thinkingLevel: "max",
	});
	assert.equal(status, "◇ deepseek-flash");
	const themes = themeSelectItems(config);
	assert.match(themes[0].label, /^● Ocean/);
	assert.ok(themes.some((item) => item.value === "research-graphite"));
	assert.ok(themes.some((item) => item.value === "research-ember"));
	assert.deepEqual(
		themeSelectItems(config, [{ name: "light" }, { name: "research-ember" }, { name: "research-pi" }, { name: "dark" }, { name: "research-graphite" }]).map((item) => item.value),
		["research-pi", "research-graphite", "research-ember", "dark", "light"],
	);
});

test("/config renders a bordered native overlay with current-model context and keyboard hints", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-config-ui-"));
	const previousPath = process.env.RESEARCH_PI_CONFIG_FILE;
	try {
		const configPath = join(root, "config.json");
		process.env.RESEARCH_PI_CONFIG_FILE = configPath;
		ensureResearchPiConfig(configPath);
		const commands = new Map();
		let rendered = [];
		let overlayOptions;
		let selectedModel;
		let selectedThinking;
		let selectedTheme;
		const pi = {
			on() {},
			registerCommand(name, command) { commands.set(name, command); },
			getThinkingLevel: () => "max",
			setThinkingLevel(value) { selectedThinking = value; },
			setModel: async (model) => { selectedModel = model; return true; },
		};
		researchConfigExtension(pi);
		const theme = {
			fg: (_name, text) => text,
			bold: (text) => text,
		};
		const ctx = {
			hasUI: true,
			model: { provider: "deepseek", id: "deepseek-v4-pro" },
			thinkingLevel: "max",
			modelRegistry: { find: (provider, model) => ({ provider, id: model }) },
			ui: {
				theme,
				getAllThemes: () => ["research-pi", "research-graphite", "research-ember", "dark", "light"].map((name) => ({ name })),
				setTheme(name) { selectedTheme = name; return { success: true }; },
				setStatus() {},
				notify() {},
				custom: async (factory, options) => {
					overlayOptions = options;
					const component = factory({ requestRender() {} }, theme, {}, () => {});
					rendered = component.render(80);
					return null;
				},
			},
		};
		await commands.get("config").handler("", ctx);
		const text = rendered.join("\n");
		assert.equal(overlayOptions.overlay, true);
		assert.equal(overlayOptions.overlayOptions.anchor, "center");
		assert.equal(overlayOptions.overlayOptions.width, "88%");
		assert.match(text, /Research Pi \/ Model Profiles/);
		assert.match(text, /current deepseek\/deepseek-v4-pro/);
		assert.match(text, /enter apply \+ persist/);
		assert.match(text, /[─╭╮]/);
		await commands.get("config").handler("use deepseek-flash", ctx);
		assert.equal(selectedModel.id, "deepseek-v4-flash");
		assert.equal(selectedThinking, "max");
		assert.equal(readResearchPiConfig(configPath).activeProfile, "deepseek-flash");
		await commands.get("config").handler("theme research-graphite", ctx);
		assert.equal(selectedTheme, "research-graphite");
		assert.equal(readResearchPiConfig(configPath).pi.settings.theme, "research-graphite");
	} finally {
		if (previousPath === undefined) delete process.env.RESEARCH_PI_CONFIG_FILE;
		else process.env.RESEARCH_PI_CONFIG_FILE = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
});
