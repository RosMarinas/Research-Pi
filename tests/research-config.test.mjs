import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import researchConfigExtension, { compactConfigPath, themeSelectItems } from "../.pi/extensions/research-config.ts";
import {
	defaultResearchPiConfig,
	ensureResearchPiConfig,
	readResearchPiConfig,
	researchPiCredentialEnvironmentNames,
	researchPiDeepSeekSearchEnabled,
	researchPiEnvironment,
	RESEARCH_PI_DEFAULT_CONFIG_PATH,
	resolveResearchPiConfig,
	writeResearchPiAgentConfig,
	writeResearchPiConfig,
} from "../.pi/lib/research-config.mjs";

test("bundled defaults remain readable by loaded pre-cleanup validators without reviving the retired tail setting", () => {
	const bundled = JSON.parse(readFileSync(RESEARCH_PI_DEFAULT_CONFIG_PATH, "utf8"));
	// Already-running pre-cleanup modules re-read this file on every request
	// and require a non-empty positive-integer array before merging user config.
	const tail = bundled.research.compaction.recentTailTokens;
	assert.ok(Array.isArray(tail) && tail.length > 0, "loaded validators require recentTailTokens in the raw defaults");
	assert.ok(tail.every((value) => Number.isInteger(value) && value > 0));
	const current = defaultResearchPiConfig();
	assert.equal(Object.hasOwn(current.research.compaction, "recentTailTokens"), false);
	assert.equal(Object.hasOwn(resolveResearchPiConfig(bundled).research.compaction, "recentTailTokens"), false);
	assert.equal(Object.hasOwn(researchPiEnvironment(current), "RESEARCH_PI_COMPACT_RECENT_TAIL_TOKENS"), false);
});

test("a loaded config reader keeps its bundled defaults snapshot while user settings remain live", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-config-upgrade-"));
	try {
		const library = join(root, "lib", "research-config.mjs");
		const defaultsPath = join(root, "config.defaults.json");
		const configPath = join(root, "config.json");
		mkdirSync(join(root, "lib"));
		copyFileSync(new URL("../.pi/lib/research-config.mjs", import.meta.url), library);
		copyFileSync(RESEARCH_PI_DEFAULT_CONFIG_PATH, defaultsPath);
		writeFileSync(configPath, JSON.stringify({ ui: { density: "compact" } }));
		const reader = await import(pathToFileURL(library).href);
		const before = reader.readResearchPiConfig(configPath);
		// Simulate updating the checkout while this reader is still in memory.
		writeFileSync(defaultsPath, JSON.stringify({ ...before, version: before.version + 1 }));
		assert.deepEqual(reader.readResearchPiConfig(configPath), before);
		writeFileSync(configPath, JSON.stringify({ ui: { density: "balanced" } }));
		assert.equal(reader.readResearchPiConfig(configPath).ui.density, "balanced");
		reader.defaultResearchPiConfig().subagents.general.model = "caller-local-change";
		assert.equal(reader.defaultResearchPiConfig().subagents.general.model, before.subagents.general.model);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Research Pi config owns research runtime settings, not the Leader model catalog", () => {
	const config = defaultResearchPiConfig();
	assert.equal(config.version, 3);
	assert.equal(Object.hasOwn(config, "activeProfile"), false);
	assert.equal(Object.hasOwn(config, "profiles"), false);
	assert.equal(Object.hasOwn(config, "providerCompat"), false);
	assert.deepEqual(config.subagents.advisor, { backend: "codex", model: "gpt-5.6-sol", thinking: "max", speed: "inherit" });
	assert.deepEqual(config.subagents.executor, { backend: "codex", model: "gpt-5.6-sol", thinking: "max", speed: "inherit" });
	assert.deepEqual(config.subagents.environment, { backend: "antigravity", model: "gemini-3.1-pro-high", thinking: "high" });
	assert.deepEqual(config.subagents.general, { backend: "pi", model: "inherit", thinking: "inherit" });
	assert.equal(config.codex.maxExecutors, 4);
	assert.deepEqual(config.pi.settings.defaultTools, ["+codemode"]);
	assert.equal(config.research.search.enabled, "off");
	assert.deepEqual(config.codex.retention, { terminalDays: 30, keepTerminalJobs: 200 });
	assert.equal(config.research.compaction.hardTokens, 384 * 1024);
	assert.equal(config.research.compaction.softTokens, 360 * 1024);
	assert.equal(config.research.compaction.summaryTargetTokens, 8 * 1024);
	assert.equal(config.research.compaction.summaryMaxTokens, 16 * 1024);
	assert.equal(config.research.search.model, "deepseek-v4-flash");
	assert.equal(config.ui.density, "balanced");
	assert.equal(config.pi.settings.theme, "research-pi");
});

test("partial runtime config merges over defaults and rejects ambiguous or secret fields", () => {
	const config = resolveResearchPiConfig({ subagents: { executor: { model: "gpt-5.6-luna" } } });
	assert.equal(config.subagents.executor.model, "gpt-5.6-luna");
	assert.equal(config.subagents.executor.thinking, "max");
	assert.throws(() => resolveResearchPiConfig({ typoSetting: true }), /Unknown Research Pi config key/);
	assert.throws(() => resolveResearchPiConfig({ research: { compaction: { softTokens: 500_000 } } }), /below hardTokens/);
	assert.throws(
		() => resolveResearchPiConfig({ research: { compaction: { summaryTargetTokens: 20_000, summaryMaxTokens: 10_000 } } }),
		/below summaryMaxTokens/,
	);
	assert.throws(() => resolveResearchPiConfig({ research: { search: { enabled: "sometimes" } } }), /auto, on, or off/);
	assert.throws(() => resolveResearchPiConfig({ codex: { retention: { terminalDays: 0 } } }), /positive integer/);
	assert.throws(() => resolveResearchPiConfig({ codex: { maxExecutors: 0 } }), /positive integer/);
	assert.throws(() => resolveResearchPiConfig({ codex: { maxExecutors: 1.5 } }), /positive integer/);
	assert.throws(() => resolveResearchPiConfig({ pi: { settings: { api_key: "do-not-store-here" } } }), /credential-like/);
});

test("v1 profile config migrates once into Pi native defaults and removes the curated scope", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-config-migrate-"));
	try {
		const defaults = defaultResearchPiConfig();
		const configPath = join(root, "config.json");
		writeFileSync(configPath, `${JSON.stringify({
			...defaults,
			version: 1,
			activeProfile: "go-flash",
			profiles: { "go-flash": { provider: "opencode-go", model: "deepseek-v4-flash", thinking: "max" } },
			providerCompat: { obsolete: true },
			ui: { ...defaults.ui, showProfileStatus: true },
		}, null, 2)}\n`);
		const config = ensureResearchPiConfig(configPath);
		const persisted = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(persisted.version, 3);
		assert.equal(Object.hasOwn(persisted, "activeProfile"), false);
		assert.equal(Object.hasOwn(persisted, "profiles"), false);
		assert.equal(Object.hasOwn(persisted, "providerCompat"), false);
		assert.equal(Object.hasOwn(persisted.ui, "showProfileStatus"), false);

		const agentDir = join(root, "agent");
		writeResearchPiAgentConfig(agentDir, config, { coreVersion: "0.84.2" });
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(settings.defaultProvider, "opencode-go");
		assert.equal(settings.defaultModel, "deepseek-v4-flash");
		assert.equal(settings.defaultThinkingLevel, "max");
		assert.equal(Object.hasOwn(settings, "enabledModels"), false);
		assert.equal(existsSync(join(agentDir, "models.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("v2 Codex role settings migrate into unified v3 subagent runners", () => {
	const defaults = defaultResearchPiConfig();
	const legacy = {
		...defaults,
		version: 2,
		research: { ...defaults.research, compaction: { ...defaults.research.compaction, recentTailTokens: [24576, 32768, 40960] } },
		codex: {
			maxExecutors: 3,
			advisor: { model: "gpt-advisor", reasoningEffort: "high", serviceTier: "standard" },
			executor: { model: "gpt-executor", reasoningEffort: "xhigh", serviceTier: "fast" },
			subagent: { model: "gpt-child", reasoningEffort: "medium" },
			retention: defaults.codex.retention,
		},
	};
	delete legacy.subagents;
	const migrated = resolveResearchPiConfig(legacy);
	assert.equal(migrated.version, 3);
	assert.deepEqual(migrated.subagents.advisor, { backend: "codex", model: "gpt-advisor", thinking: "high", speed: "standard" });
	assert.deepEqual(migrated.subagents.executor, { backend: "codex", model: "gpt-executor", thinking: "xhigh", speed: "fast" });
	assert.deepEqual(migrated.subagents.environment, { backend: "antigravity", model: "gemini-3.1-pro-high", thinking: "high" });
	assert.deepEqual(migrated.subagents.general, { backend: "pi", model: "inherit", thinking: "inherit" });
	assert.deepEqual(migrated.codex.internalSubagent, { model: "gpt-child", thinking: "medium" });
	assert.equal(Object.hasOwn(migrated.codex, "advisor"), false);
	assert.equal(Object.hasOwn(migrated.codex, "executor"), false);
	assert.equal(Object.hasOwn(migrated.codex, "subagent"), false);
	assert.equal(Object.hasOwn(migrated.research.compaction, "recentTailTokens"), false);
	assert.equal(migrated.pi.settings.compaction.keepRecentTokens, defaults.pi.settings.compaction.keepRecentTokens);
});

test("normal launches preserve Pi native model scope and custom models", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-native-models-"));
	try {
		const agentDir = join(root, "agent");
		const config = defaultResearchPiConfig();
		writeResearchPiAgentConfig(agentDir, config);
		const settingsPath = join(agentDir, "settings.json");
		const modelsPath = join(agentDir, "models.json");
		const nativeSettings = {
			defaultProvider: "new-provider",
			defaultModel: "new-model",
			defaultThinkingLevel: "high",
			enabledModels: ["new-provider/new-model:high"],
			theme: "research-ember",
		};
		writeFileSync(settingsPath, `${JSON.stringify(nativeSettings, null, 2)}\n`);
		writeFileSync(modelsPath, "{\"providers\":{\"new-provider\":{}}}\n");
		const modelsBefore = readFileSync(modelsPath, "utf8");
		writeResearchPiAgentConfig(agentDir, config, { coreVersion: "0.84.2" });
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(settings.defaultProvider, "new-provider");
		assert.equal(settings.defaultModel, "new-model");
		assert.equal(settings.defaultThinkingLevel, "high");
		assert.deepEqual(settings.enabledModels, ["new-provider/new-model:high"]);
		assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config persistence creates a private v3 file and schema", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-config-"));
	try {
		const configPath = join(root, "config.json");
		const config = ensureResearchPiConfig(configPath);
		assert.equal(config.version, 3);
		assert.equal(statSync(configPath).mode & 0o777, 0o600);
		assert.ok(statSync(join(root, "schemas", "research-pi-config.schema.json")).isFile());
		const changed = writeResearchPiConfig(configPath, { ...config, ui: { ...config.ui, density: "compact" } });
		assert.equal(readResearchPiConfig(configPath).ui.density, "compact");
		assert.equal(changed.ui.density, "compact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config exports runtime environment without a second Leader model selection", () => {
	const environment = researchPiEnvironment(defaultResearchPiConfig());
	assert.equal(Object.hasOwn(environment, "RESEARCH_PI_ACTIVE_PROFILE"), false);
	assert.equal(environment.RESEARCH_PI_CODEX_ADVISOR_MODEL, "gpt-5.6-sol");
	assert.equal(environment.RESEARCH_PI_SUBAGENT_ENVIRONMENT_BACKEND, "antigravity");
	assert.equal(environment.RESEARCH_PI_SUBAGENT_GENERAL_MODEL, "inherit");
	assert.equal(environment.RESEARCH_PI_CODEX_RETENTION_DAYS, "30");
	assert.equal(environment.RESEARCH_PI_CODEX_KEEP_TERMINAL_JOBS, "200");
	assert.equal(environment.RESEARCH_PI_CODEX_MAX_EXECUTORS, "4");
	assert.equal(environment.RESEARCH_PI_COMPACT_HARD_TOKENS, String(384 * 1024));
	assert.equal(environment.RESEARCH_PI_SEARCH_MODEL, "deepseek-v4-flash");
	assert.equal(environment.RESEARCH_PI_UI_DENSITY, "balanced");
	const alternate = researchPiEnvironment(resolveResearchPiConfig({
		subagents: {
			advisor: { backend: "pi", model: "opencode-go/deepseek-v4-flash", thinking: "high" },
			executor: { backend: "antigravity", model: "gemini-3.1-pro-high", thinking: "high" },
		},
	}));
	assert.equal(alternate.RESEARCH_PI_SUBAGENT_ADVISOR_MODEL, "opencode-go/deepseek-v4-flash");
	assert.equal(alternate.RESEARCH_PI_CODEX_ADVISOR_MODEL, "gpt-5.6-sol");
	assert.equal(alternate.RESEARCH_PI_CODEX_EXECUTOR_MODEL, "gpt-5.6-sol");
});

test("legacy credential file support and native search are independent of Leader selection", () => {
	const config = resolveResearchPiConfig({ research: { search: { enabled: "auto" } } });
	assert.deepEqual(researchPiCredentialEnvironmentNames(config).sort(), ["DEEPSEEK_API_KEY", "OPENCODE_API_KEY", "ZAI_API_KEY"]);
	assert.equal(researchPiDeepSeekSearchEnabled(config, { OPENCODE_API_KEY: "go-key" }), false);
	assert.equal(researchPiDeepSeekSearchEnabled(config, { DEEPSEEK_API_KEY: "ds-key" }), true);
	assert.equal(researchPiDeepSeekSearchEnabled(resolveResearchPiConfig({ research: { search: { enabled: "off" } } }), {}), false);
	assert.throws(
		() => researchPiDeepSeekSearchEnabled(resolveResearchPiConfig({ research: { search: { enabled: "on" } } }), {}),
		/DEEPSEEK_API_KEY is missing/,
	);
});

test("Codex, compact, and search modules consume the configured runtime environment", () => {
	const root = resolve(new URL("..", import.meta.url).pathname);
	const codex = pathToFileURL(join(root, ".pi", "lib", "codex-jobs.mjs")).href;
	const compact = pathToFileURL(join(root, ".pi", "lib", "research-compact.mjs")).href;
	const search = pathToFileURL(join(root, ".pi", "lib", "deepseek-web-search.mjs")).href;
	const script = `
		const codex = await import(${JSON.stringify(codex)});
		const compact = await import(${JSON.stringify(compact)});
		const search = await import(${JSON.stringify(search)});
		const parsed = search.parseDeepSeekWebSearchResponse({content:[{type:"web_search_tool_result",content:[1,2,3].map(i=>({type:"web_search_result",url:"https://example.com/"+i,title:"S"+i}))}]});
		console.log(JSON.stringify({advisor:codex.defaultCodexModel("advisor"),executor:codex.defaultCodexModel("executor"),effort:codex.defaultCodexReasoningEffort("advisor"),retentionDays:codex.DEFAULT_CODEX_RETENTION_DAYS,keepTerminal:codex.DEFAULT_CODEX_KEEP_TERMINAL_JOBS,soft:compact.RESEARCH_SOFT_COMPACT_TOKENS,hard:compact.RESEARCH_HARD_COMPACT_TOKENS,summaryTarget:compact.RESEARCH_SUMMARY_TARGET_TOKENS,summaryMax:compact.RESEARCH_SUMMARY_MAX_TOKENS,sources:parsed.sources.length}));
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		env: {
			...process.env,
			RESEARCH_PI_CODEX_ADVISOR_MODEL: "gpt-advisor-configured",
			RESEARCH_PI_CODEX_EXECUTOR_MODEL: "gpt-executor-configured",
			RESEARCH_PI_CODEX_ADVISOR_EFFORT: "high",
			RESEARCH_PI_CODEX_RETENTION_DAYS: "17",
			RESEARCH_PI_CODEX_KEEP_TERMINAL_JOBS: "33",
			RESEARCH_PI_COMPACT_SOFT_TOKENS: "111",
			RESEARCH_PI_COMPACT_HARD_TOKENS: "222",
			RESEARCH_PI_COMPACT_SUMMARY_TARGET_TOKENS: "9",
			RESEARCH_PI_COMPACT_SUMMARY_MAX_TOKENS: "18",
			RESEARCH_PI_SEARCH_MAX_SOURCES: "2",
		},
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		advisor: "gpt-advisor-configured",
		executor: "gpt-executor-configured",
		effort: "high",
		retentionDays: 17,
		keepTerminal: 33,
		soft: 111,
		hard: 222,
		summaryTarget: 9,
		summaryMax: 18,
		sources: 2,
	});
});

test("/config keeps Research Pi themes while exposing Pi Core model commands", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-config-ui-"));
	const previousPath = process.env.RESEARCH_PI_CONFIG_FILE;
	try {
		const configPath = join(root, "config.json");
		process.env.RESEARCH_PI_CONFIG_FILE = configPath;
		ensureResearchPiConfig(configPath);
		const commands = new Map();
		const handlers = new Map();
		const notices = [];
		let selectedTheme;
		let autocompleteFactory;
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, command) { commands.set(name, command); },
		};
		researchConfigExtension(pi);
		assert.equal(handlers.has("model_select"), false);
		assert.equal(handlers.has("thinking_level_select"), false);
		const ctx = {
			hasUI: true,
			ui: {
				getAllThemes: () => ["research-pi", "research-graphite", "research-ember", "dark", "light"].map((name) => ({ name })),
				setTheme(name) { selectedTheme = name; return { success: true }; },
				notify(message) { notices.push(message); },
				addAutocompleteProvider(factory) { autocompleteFactory = factory; },
			},
		};
		await commands.get("config").handler("", ctx);
		assert.match(notices.at(-1), /\/login/);
		assert.match(notices.at(-1), /\/model/);
		assert.match(notices.at(-1), /\/scoped-models/);
		assert.equal(autocompleteFactory, undefined);
		const visited = [], choices = ["Models and roles", undefined, "Current configuration", undefined];
		ctx.ui.select = async (title, items) => { visited.push(title); const choice = choices.shift(); if (choice) assert.ok(items.includes(choice)); return choice; };
		await commands.get("config").handler("", ctx);
		assert.equal(visited.length, 4);
		assert.match(visited[1], /Models/);
		assert.equal(visited[2], visited[0], "Esc in the model submenu returns to Config");
		await commands.get("config").handler("theme research-graphite", ctx);
		assert.equal(selectedTheme, "research-graphite");
		assert.equal(readResearchPiConfig(configPath).pi.settings.theme, "research-graphite");
		await commands.get("config").handler("use old-profile", ctx);
		assert.match(notices.at(-1), /Usage:/);
	} finally {
		if (previousPath === undefined) delete process.env.RESEARCH_PI_CONFIG_FILE;
		else process.env.RESEARCH_PI_CONFIG_FILE = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(compactConfigPath("/Users/polaris/Documents/Utils/Pi/.pi/config.json"), "…/Utils/Pi/.pi/config.json");
	const themes = themeSelectItems(defaultResearchPiConfig());
	assert.match(themes[0].label, /^● Ocean/);
	assert.ok(themes.some((item) => item.value === "research-ember"));
});
