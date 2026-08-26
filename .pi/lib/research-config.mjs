import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const RESEARCH_PI_DEFAULT_CONFIG_PATH = resolve(LIB_DIR, "../config.defaults.json");
export const RESEARCH_PI_CONFIG_SCHEMA_PATH = resolve(LIB_DIR, "../schemas/research-pi-config.schema.json");
export const RESEARCH_PI_CONFIG_VERSION = 1;
export const RESEARCH_PI_PROVIDER_CREDENTIALS = Object.freeze({
	deepseek: "DEEPSEEK_API_KEY",
	zai: "ZAI_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
});
export const RESEARCH_PI_THEME_CHOICES = Object.freeze([
	{ name: "research-pi", label: "Ocean", description: "Cool cyan, indigo, and violet for long research sessions." },
	{ name: "research-graphite", label: "Graphite", description: "Low-saturation graphite with restrained aqua accents." },
	{ name: "research-ember", label: "Ember", description: "Warm copper and amber balanced by scientific teal." },
	{ name: "dark", label: "Pi Dark", description: "Pi Core built-in dark palette." },
	{ name: "light", label: "Pi Light", description: "Pi Core built-in light palette for light terminals." },
]);

const RESEARCH_PI_CUSTOM_MODELS = Object.freeze({
	zai: [
		{
			id: "glm-5.3-flash",
			name: "GLM-5.3 Flash",
			api: "openai-completions",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			reasoning: true,
			thinkingLevelMap: {
				off: "low",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "max",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "zai",
			},
		},
	],
});

const RETIRED_PROFILE_FALLBACKS = Object.freeze({
	"opencode-go-ox-alpha": "opencode-go-flash",
});

const TOP_LEVEL_KEYS = new Set([
	"$schema",
	"version",
	"activeProfile",
	"profiles",
	"pi",
	"codex",
	"research",
	"resources",
	"ui",
	"diagnostics",
	"providerCompat",
]);
const PROFILE_KEYS = new Set(["label", "description", "provider", "model", "thinking"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const UI_DENSITIES = new Set(["compact", "balanced"]);
const RUNTIME_STRIP_MODES = new Set(["auto", "always", "off"]);
const SEARCH_MODES = new Set(["auto", "on", "off"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function merge(base, override) {
	if (!plainObject(base) || !plainObject(override)) return clone(override);
	const result = clone(base);
	for (const [key, value] of Object.entries(override)) {
		result[key] = plainObject(value) && plainObject(result[key]) ? merge(result[key], value) : clone(value);
	}
	return result;
}

function positiveInteger(value, label) {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
	return value;
}

function rejectSecretFields(value, path = "config") {
	if (Array.isArray(value)) {
		value.forEach((item, index) => rejectSecretFields(item, `${path}[${index}]`));
		return;
	}
	if (!plainObject(value)) return;
	for (const [key, item] of Object.entries(value)) {
		if (/(?:^|[_-])(?:api[_-]?key|password|secret|credential|private[_-]?key)(?:$|[_-])/i.test(key)) {
			throw new Error(`${path}.${key} is credential-like; keep secrets in credentials.env or .env`);
		}
		rejectSecretFields(item, `${path}.${key}`);
	}
}

function validateCodexRole(role, value) {
	if (!plainObject(value)) throw new Error(`codex.${role} must be an object`);
	if (!SAFE_ID.test(String(value.model ?? ""))) throw new Error(`codex.${role}.model is invalid`);
	if (!CODEX_EFFORTS.has(value.reasoningEffort)) throw new Error(`codex.${role}.reasoningEffort is invalid`);
}

export function validateResearchPiConfig(config) {
	if (!plainObject(config)) throw new Error("Research Pi config must be a JSON object");
	rejectSecretFields(config);
	for (const key of Object.keys(config)) {
		if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`Unknown Research Pi config key: ${key}`);
	}
	if (config.version !== RESEARCH_PI_CONFIG_VERSION) {
		throw new Error(`Unsupported Research Pi config version: ${config.version}`);
	}
	if (!plainObject(config.profiles) || !Object.keys(config.profiles).length) {
		throw new Error("Research Pi config requires at least one model profile");
	}
	for (const [name, profile] of Object.entries(config.profiles)) {
		if (!SAFE_ID.test(name)) throw new Error(`Invalid model profile name: ${name}`);
		if (!plainObject(profile)) throw new Error(`Model profile ${name} must be an object`);
		for (const key of Object.keys(profile)) {
			if (!PROFILE_KEYS.has(key)) throw new Error(`Unknown key profiles.${name}.${key}`);
		}
		if (!SAFE_ID.test(String(profile.provider ?? ""))) throw new Error(`profiles.${name}.provider is invalid`);
		if (!SAFE_ID.test(String(profile.model ?? ""))) throw new Error(`profiles.${name}.model is invalid`);
		if (!THINKING_LEVELS.has(profile.thinking)) throw new Error(`profiles.${name}.thinking is invalid`);
	}
	if (!config.profiles[config.activeProfile]) {
		throw new Error(`activeProfile does not exist: ${config.activeProfile}`);
	}
	validateCodexRole("advisor", config.codex?.advisor);
	validateCodexRole("executor", config.codex?.executor);
	const compact = config.research?.compaction;
	if (!plainObject(compact)) throw new Error("research.compaction must be an object");
	positiveInteger(compact.softTokens, "research.compaction.softTokens");
	positiveInteger(compact.hardTokens, "research.compaction.hardTokens");
	if (compact.softTokens >= compact.hardTokens) throw new Error("research.compaction.softTokens must be below hardTokens");
	if (!Array.isArray(compact.recentTailTokens) || !compact.recentTailTokens.length) {
		throw new Error("research.compaction.recentTailTokens must be a non-empty array");
	}
	compact.recentTailTokens.forEach((value, index) => positiveInteger(value, `research.compaction.recentTailTokens[${index}]`));
	positiveInteger(compact.summaryTargetTokens, "research.compaction.summaryTargetTokens");
	positiveInteger(compact.summaryMaxTokens, "research.compaction.summaryMaxTokens");
	if (compact.summaryTargetTokens >= compact.summaryMaxTokens) {
		throw new Error("research.compaction.summaryTargetTokens must be below summaryMaxTokens");
	}
	const search = config.research?.search;
	if (!plainObject(search) || !SAFE_ID.test(String(search.model ?? ""))) throw new Error("research.search.model is invalid");
	if (!SEARCH_MODES.has(search.enabled)) throw new Error("research.search.enabled must be auto, on, or off");
	positiveInteger(search.thinkingBudgetTokens, "research.search.thinkingBudgetTokens");
	positiveInteger(search.maxSources, "research.search.maxSources");
	positiveInteger(search.defaultMaxUses, "research.search.defaultMaxUses");
	if (search.maxSources > 50) throw new Error("research.search.maxSources must be at most 50");
	if (search.defaultMaxUses > 5) throw new Error("research.search.defaultMaxUses must be at most 5");
	if (!Array.isArray(config.resources?.skills) || config.resources.skills.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error("resources.skills must be an array of non-empty paths");
	}
	if (!plainObject(config.pi?.settings)) throw new Error("pi.settings must be an object");
	if (!UI_DENSITIES.has(config.ui?.density)) throw new Error("ui.density must be compact or balanced");
	if (!RUNTIME_STRIP_MODES.has(config.ui?.runtimeStrip)) throw new Error("ui.runtimeStrip must be auto, always, or off");
	if (typeof config.ui?.showProfileStatus !== "boolean") throw new Error("ui.showProfileStatus must be boolean");
	if (!Number.isInteger(config.ui?.configPanelRows) || config.ui.configPanelRows < 3 || config.ui.configPanelRows > 20) {
		throw new Error("ui.configPanelRows must be between 3 and 20");
	}
	if (typeof config.diagnostics?.trace !== "boolean" || typeof config.diagnostics?.codexSqliteLogs !== "boolean") {
		throw new Error("diagnostics.trace and diagnostics.codexSqliteLogs must be boolean");
	}
	return config;
}

export function defaultResearchPiConfig() {
	return validateResearchPiConfig(JSON.parse(readFileSync(RESEARCH_PI_DEFAULT_CONFIG_PATH, "utf8")));
}

export function resolveResearchPiConfig(input = {}) {
	const defaults = defaultResearchPiConfig();
	const resolved = merge(defaults, input);
	for (const name of Object.keys(RETIRED_PROFILE_FALLBACKS)) delete resolved.profiles?.[name];
	resolved.activeProfile = RETIRED_PROFILE_FALLBACKS[resolved.activeProfile] ?? resolved.activeProfile;
	return validateResearchPiConfig(resolved);
}

export function writeResearchPiConfig(path, config) {
	const resolved = resolveResearchPiConfig(config);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(resolved, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
	return resolved;
}

export function ensureResearchPiConfig(path, options = {}) {
	if (!existsSync(path)) writeResearchPiConfig(path, options.defaults ?? defaultResearchPiConfig());
	const schemaDestination = join(dirname(path), "schemas", "research-pi-config.schema.json");
	if (!existsSync(schemaDestination)) {
		mkdirSync(dirname(schemaDestination), { recursive: true, mode: 0o700 });
		copyFileSync(options.schemaPath ?? RESEARCH_PI_CONFIG_SCHEMA_PATH, schemaDestination);
	}
	return readResearchPiConfig(path);
}

export function readResearchPiConfig(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error(`Research Pi config does not exist: ${path}`);
		throw new Error(`Research Pi config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return resolveResearchPiConfig(parsed);
}

export function researchPiProfile(config, name = config.activeProfile) {
	const profile = config.profiles[name];
	if (!profile) throw new Error(`Unknown Research Pi model profile: ${name}`);
	return { name, ...profile };
}

export function researchPiProfileForModel(config, provider, model) {
	const matches = Object.entries(config.profiles).filter(([, profile]) => profile.provider === provider && profile.model === model);
	return matches.length === 1 ? researchPiProfile(config, matches[0][0]) : null;
}

export function researchPiProfileCredential(config, name = config.activeProfile) {
	const profile = researchPiProfile(config, name);
	const environmentVariable = RESEARCH_PI_PROVIDER_CREDENTIALS[profile.provider];
	return environmentVariable ? { profile, environmentVariable } : { profile, environmentVariable: undefined };
}

export function researchPiCredentialEnvironmentNames(config) {
	const names = new Set();
	for (const profile of Object.values(config.profiles)) {
		const name = RESEARCH_PI_PROVIDER_CREDENTIALS[profile.provider];
		if (name) names.add(name);
	}
	if (config.research.search.enabled !== "off") names.add("DEEPSEEK_API_KEY");
	return [...names];
}

export function researchPiDeepSeekSearchEnabled(config, environment = process.env) {
	const mode = config.research.search.enabled;
	if (mode === "off") return false;
	const available = Boolean(environment.DEEPSEEK_API_KEY?.trim());
	if (mode === "on" && !available) {
		throw new Error("DEEPSEEK_API_KEY is missing while research.search.enabled is on");
	}
	return available;
}

export function researchPiCoreSettings(config, coreVersion, environment) {
	const profile = researchPiProfile(config);
	const configuredProfiles = environment
		? Object.entries(config.profiles).filter(([name, item]) => {
			if (name === config.activeProfile) return true;
			const credentialName = RESEARCH_PI_PROVIDER_CREDENTIALS[item.provider];
			return !credentialName || Boolean(environment[credentialName]?.trim());
		})
		: Object.entries(config.profiles);
	const enabledModels = [...new Set(configuredProfiles.map(([, item]) => `${item.provider}/${item.model}:${item.thinking}`))];
	return {
		...clone(config.pi.settings),
		...(coreVersion ? { lastChangelogVersion: coreVersion } : {}),
		defaultProvider: profile.provider,
		defaultModel: profile.model,
		defaultThinkingLevel: profile.thinking,
		enabledModels,
	};
}

export function researchPiModels(config) {
	const providers = {};
	for (const [provider, models] of Object.entries(config.providerCompat ?? {})) {
		providers[provider] = { modelOverrides: {} };
		for (const [model, compat] of Object.entries(models)) {
			providers[provider].modelOverrides[model] = { compat: clone(compat) };
		}
	}
	for (const [provider, models] of Object.entries(RESEARCH_PI_CUSTOM_MODELS)) {
		providers[provider] ??= {};
		providers[provider].models = clone(models);
	}
	return { providers };
}

export function writeResearchPiAgentConfig(agentDir, config, options = {}) {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	for (const [name, value] of [
		["settings.json", researchPiCoreSettings(config, options.coreVersion, options.environment)],
		["models.json", researchPiModels(config)],
	]) {
		const path = join(agentDir, name);
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
	}
}

export function researchPiEnvironment(config) {
	const compact = config.research.compaction;
	const search = config.research.search;
	return {
		RESEARCH_PI_ACTIVE_PROFILE: config.activeProfile,
		RESEARCH_PI_CODEX_ADVISOR_MODEL: config.codex.advisor.model,
		RESEARCH_PI_CODEX_ADVISOR_EFFORT: config.codex.advisor.reasoningEffort,
		RESEARCH_PI_CODEX_EXECUTOR_MODEL: config.codex.executor.model,
		RESEARCH_PI_CODEX_EXECUTOR_EFFORT: config.codex.executor.reasoningEffort,
		RESEARCH_PI_COMPACT_SOFT_TOKENS: String(compact.softTokens),
		RESEARCH_PI_COMPACT_HARD_TOKENS: String(compact.hardTokens),
		RESEARCH_PI_COMPACT_RECENT_TAIL_TOKENS: compact.recentTailTokens.join(","),
		RESEARCH_PI_COMPACT_SUMMARY_TARGET_TOKENS: String(compact.summaryTargetTokens),
		RESEARCH_PI_COMPACT_SUMMARY_MAX_TOKENS: String(compact.summaryMaxTokens),
		RESEARCH_PI_SEARCH_MODEL: search.model,
		RESEARCH_PI_SEARCH_ENABLED: search.enabled,
		RESEARCH_PI_SEARCH_THINKING_BUDGET_TOKENS: String(search.thinkingBudgetTokens),
		RESEARCH_PI_SEARCH_MAX_SOURCES: String(search.maxSources),
		RESEARCH_PI_SEARCH_DEFAULT_MAX_USES: String(search.defaultMaxUses),
		RESEARCH_PI_UI_DENSITY: config.ui.density,
		RESEARCH_PI_UI_RUNTIME_STRIP: config.ui.runtimeStrip,
		RESEARCH_PI_UI_SHOW_PROFILE_STATUS: config.ui.showProfileStatus ? "1" : "0",
		RESEARCH_PI_UI_CONFIG_PANEL_ROWS: String(config.ui.configPanelRows),
		RESEARCH_PI_TRACE: config.diagnostics.trace ? "1" : "0",
		PI_CODEX_SQLITE_LOGS: config.diagnostics.codexSqliteLogs ? "1" : "0",
	};
}

export function researchPiConfigSummary(config, path) {
	const profile = researchPiProfile(config);
	return [
		`Research Pi config v${config.version}`,
		`Path: ${path}`,
		`Leader: ${config.activeProfile} · ${profile.provider}/${profile.model} · thinking ${profile.thinking}`,
		`Codex advisor: ${config.codex.advisor.model}/${config.codex.advisor.reasoningEffort}`,
		`Codex executor: ${config.codex.executor.model}/${config.codex.executor.reasoningEffort}`,
		`Research compact: ${config.research.compaction.softTokens}/${config.research.compaction.hardTokens} tokens · summary target/max ${config.research.compaction.summaryTargetTokens}/${config.research.compaction.summaryMaxTokens}`,
		`Search: ${config.research.search.enabled} · deepseek/${config.research.search.model} · max ${config.research.search.maxSources} sources`,
		`UI: theme ${config.pi.settings.theme ?? "research-pi"} · ${config.ui.density} · runtime strip ${config.ui.runtimeStrip}`,
		`Profiles: ${Object.keys(config.profiles).join(", ")}`,
	].join("\n");
}
