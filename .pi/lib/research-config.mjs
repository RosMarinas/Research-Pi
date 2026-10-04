import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const RESEARCH_PI_DEFAULT_CONFIG_PATH = resolve(LIB_DIR, "../config.defaults.json");
export const RESEARCH_PI_CONFIG_SCHEMA_PATH = resolve(LIB_DIR, "../schemas/research-pi-config.schema.json");
export const RESEARCH_PI_CONFIG_VERSION = 3;
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

const TOP_LEVEL_KEYS = new Set([
	"$schema",
	"version",
	"pi",
	"subagents",
	"codex",
	"research",
	"resources",
	"ui",
	"diagnostics",
]);
const SUBAGENT_BACKENDS = new Set(["codex", "antigravity", "pi"]);
const SUBAGENT_ROLES = Object.freeze(["advisor", "executor", "environment", "general"]);
const SUBAGENT_THINKING = new Set(["inherit", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const SERVICE_TIERS = new Set(["inherit", "standard", "fast"]);
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

function validateSubagentRunner(role, value) {
	if (!plainObject(value)) throw new Error(`subagents.${role} must be an object`);
	if (!SUBAGENT_BACKENDS.has(value.backend)) throw new Error(`subagents.${role}.backend must be codex, antigravity, or pi`);
	if (!SAFE_ID.test(String(value.model ?? ""))) throw new Error(`subagents.${role}.model is invalid`);
	if (value.backend === "codex" && value.model === "inherit") throw new Error(`subagents.${role}.model must name a Codex model`);
	if (!SUBAGENT_THINKING.has(value.thinking)) throw new Error(`subagents.${role}.thinking is invalid`);
	if (value.speed !== undefined && !SERVICE_TIERS.has(value.speed)) throw new Error(`subagents.${role}.speed is invalid`);
}

function validateCodexInternalSubagent(value) {
	if (!plainObject(value)) throw new Error("codex.internalSubagent must be an object");
	if (!SAFE_ID.test(String(value.model ?? ""))) throw new Error("codex.internalSubagent.model is invalid");
	if (!SUBAGENT_THINKING.has(value.thinking) || value.thinking === "off") throw new Error("codex.internalSubagent.thinking is invalid");
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
	for (const role of SUBAGENT_ROLES) validateSubagentRunner(role, config.subagents?.[role]);
	validateCodexInternalSubagent(config.codex?.internalSubagent);
	positiveInteger(config.codex.maxExecutors, "codex.maxExecutors");
	if (!plainObject(config.codex?.retention)) throw new Error("codex.retention must be an object");
	positiveInteger(config.codex.retention.terminalDays, "codex.retention.terminalDays");
	positiveInteger(config.codex.retention.keepTerminalJobs, "codex.retention.keepTerminalJobs");
	const compact = config.research?.compaction;
	if (!plainObject(compact)) throw new Error("research.compaction must be an object");
	positiveInteger(compact.softTokens, "research.compaction.softTokens");
	positiveInteger(compact.hardTokens, "research.compaction.hardTokens");
	if (compact.softTokens >= compact.hardTokens) throw new Error("research.compaction.softTokens must be below hardTokens");
	if (!plainObject(compact.modelOverrides)) throw new Error("research.compaction.modelOverrides must be an object");
	for (const [model, thresholds] of Object.entries(compact.modelOverrides)) {
		if (!plainObject(thresholds)) throw new Error(`Compaction override for ${model} must be an object`);
		positiveInteger(thresholds.softTokens, `compaction ${model}.softTokens`);
		positiveInteger(thresholds.hardTokens, `compaction ${model}.hardTokens`);
		if (thresholds.softTokens >= thresholds.hardTokens) throw new Error(`Compaction ${model}.softTokens must be below hardTokens`);
	}
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
	if (!plainObject(config.pi.modelServiceTiers) || Object.values(config.pi.modelServiceTiers).some((tier) => !SERVICE_TIERS.has(tier))) {
		throw new Error("pi.modelServiceTiers must map provider/model IDs to inherit, standard, or fast");
	}
	if (!UI_DENSITIES.has(config.ui?.density)) throw new Error("ui.density must be compact or balanced");
	if (!RUNTIME_STRIP_MODES.has(config.ui?.runtimeStrip)) throw new Error("ui.runtimeStrip must be auto, always, or off");
	if (!Number.isInteger(config.ui?.configPanelRows) || config.ui.configPanelRows < 3 || config.ui.configPanelRows > 20) {
		throw new Error("ui.configPanelRows must be between 3 and 20");
	}
	const web = config.ui?.web;
	if (!plainObject(web) || !["off", "local", "tailscale"].includes(web.mode) || typeof web.persistent !== "boolean") {
		throw new Error("ui.web requires mode off, local, or tailscale and a boolean persistent setting");
	}
	for (const [key, minimum] of [["port", 0], ["httpsPort", 1]]) {
		if (!Number.isInteger(web[key]) || web[key] < minimum || web[key] > 65535) throw new Error(`ui.web.${key} must be a port from ${minimum} to 65535`);
	}
	if (typeof config.diagnostics?.trace !== "boolean" || typeof config.diagnostics?.codexSqliteLogs !== "boolean") {
		throw new Error("diagnostics.trace and diagnostics.codexSqliteLogs must be boolean");
	}
	return config;
}

// Pin bundled defaults to the loaded code, not each provider request: a live
// process can outlast an update to its checkout. User config remains live-read.
// Migration strips the raw defaults' compatibility-only recentTailTokens field.
const BUNDLED_DEFAULT_CONFIG = validateResearchPiConfig(
	migrateLegacyConfig(JSON.parse(readFileSync(RESEARCH_PI_DEFAULT_CONFIG_PATH, "utf8"))).migrated,
);

export function defaultResearchPiConfig() {
	return clone(BUNDLED_DEFAULT_CONFIG);
}

function migrateLegacyConfig(input = {}) {
	const migrated = clone(input);
	// Pi Core now owns the retained context boundary; drop the unused v2 schedule.
	if (plainObject(migrated.research?.compaction)) delete migrated.research.compaction.recentTailTokens;
	let legacyModelDefault;
	if (migrated.version === 1 || migrated.activeProfile || migrated.profiles) {
		const profile = plainObject(migrated.profiles) ? migrated.profiles[migrated.activeProfile] : null;
		if (plainObject(profile) && SAFE_ID.test(String(profile.provider ?? "")) && SAFE_ID.test(String(profile.model ?? ""))) {
			legacyModelDefault = {
				provider: String(profile.provider),
				model: String(profile.model),
				thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinking)
					? profile.thinking
					: "high",
			};
		}
		delete migrated.activeProfile;
		delete migrated.profiles;
		delete migrated.providerCompat;
		if (plainObject(migrated.ui)) delete migrated.ui.showProfileStatus;
	}
	if ((migrated.version ?? 1) <= 2 || plainObject(migrated.codex?.advisor) || plainObject(migrated.codex?.executor)) {
		const legacyCodex = plainObject(migrated.codex) ? migrated.codex : {};
		const toRunner = (role, fallback) => {
			const current = plainObject(legacyCodex[role]) ? legacyCodex[role] : {};
			return {
				backend: "codex",
				model: current.model ?? fallback.model,
				thinking: current.reasoningEffort ?? fallback.thinking,
				speed: current.serviceTier ?? fallback.speed,
			};
		};
		migrated.subagents = plainObject(migrated.subagents) ? migrated.subagents : {};
		migrated.subagents.advisor ??= toRunner("advisor", { model: "gpt-5.6-sol", thinking: "max", speed: "inherit" });
		migrated.subagents.executor ??= toRunner("executor", { model: "gpt-5.6-sol", thinking: "max", speed: "inherit" });
		migrated.subagents.environment ??= { backend: "antigravity", model: "gemini-3.1-pro-high", thinking: "high" };
		migrated.subagents.general ??= { backend: "pi", model: "inherit", thinking: "inherit" };
		legacyCodex.internalSubagent ??= plainObject(legacyCodex.subagent)
			? { model: legacyCodex.subagent.model ?? "inherit", thinking: legacyCodex.subagent.reasoningEffort ?? "inherit" }
			: { model: "inherit", thinking: "inherit" };
		delete legacyCodex.advisor;
		delete legacyCodex.executor;
		delete legacyCodex.subagent;
		migrated.codex = legacyCodex;
	}
	if (migrated.version === undefined || migrated.version <= 2 || migrated.activeProfile || migrated.profiles) {
		migrated.version = RESEARCH_PI_CONFIG_VERSION;
	}
	return { migrated, legacyModelDefault };
}

export function resolveResearchPiConfig(input = {}) {
	const defaults = defaultResearchPiConfig();
	const { migrated, legacyModelDefault } = migrateLegacyConfig(input);
	const resolved = validateResearchPiConfig(merge(defaults, migrated));
	if (legacyModelDefault) {
		Object.defineProperty(resolved, "legacyModelDefault", { value: legacyModelDefault, enumerable: false });
	}
	return resolved;
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
	const raw = JSON.parse(readFileSync(path, "utf8"));
	const resolved = resolveResearchPiConfig(raw);
	if (raw.version !== RESEARCH_PI_CONFIG_VERSION || Object.hasOwn(raw, "activeProfile") || Object.hasOwn(raw, "profiles") || Object.hasOwn(raw.research?.compaction ?? {}, "recentTailTokens")) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${JSON.stringify(resolved, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
	}
	const schemaDestination = join(dirname(path), "schemas", "research-pi-config.schema.json");
	mkdirSync(dirname(schemaDestination), { recursive: true, mode: 0o700 });
	const schemaSource = resolve(options.schemaPath ?? RESEARCH_PI_CONFIG_SCHEMA_PATH);
	if (schemaSource !== resolve(schemaDestination)) copyFileSync(schemaSource, schemaDestination);
	return resolved;
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

export function researchPiCredentialEnvironmentNames(config) {
	const names = new Set(Object.values(RESEARCH_PI_PROVIDER_CREDENTIALS));
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

export function researchPiCoreSettings(config, coreVersion, existing = {}) {
	const settings = merge(plainObject(existing) ? existing : {}, config.pi.settings);
	if (config.legacyModelDefault) {
		settings.defaultProvider ??= config.legacyModelDefault.provider;
		settings.defaultModel ??= config.legacyModelDefault.model;
		settings.defaultThinkingLevel ??= config.legacyModelDefault.thinking;
		// v1 generated a curated scope on every launch. Remove it once so Pi's
		// native /model and /scoped-models regain the full authenticated catalog.
		delete settings.enabledModels;
	}
	if (coreVersion) settings.lastChangelogVersion = coreVersion;
	return settings;
}

export function writeResearchPiAgentConfig(agentDir, config, options = {}) {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const settingsPath = join(agentDir, "settings.json");
	let existingSettings = {};
	if (existsSync(settingsPath)) {
		try {
			existingSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch {
			throw new Error(`Pi native settings are not valid JSON: ${settingsPath}`);
		}
	}
	const settings = researchPiCoreSettings(config, options.coreVersion, existingSettings);
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(settingsPath, 0o600);
}

export function researchPiEnvironment(config) {
	const compact = config.research.compaction;
	const search = config.research.search;
	const advisor = config.subagents.advisor;
	const executor = config.subagents.executor;
	const codexAdvisor = advisor.backend === "codex" ? advisor : { model: "gpt-5.6-sol", thinking: "max", speed: "inherit" };
	const codexExecutor = executor.backend === "codex" ? executor : { model: "gpt-5.6-sol", thinking: "max", speed: "inherit" };
	const internalSubagent = config.codex.internalSubagent;
	const runnerEnvironment = {};
	for (const role of SUBAGENT_ROLES) {
		const runner = config.subagents[role];
		const prefix = `RESEARCH_PI_SUBAGENT_${role.toUpperCase()}`;
		runnerEnvironment[`${prefix}_BACKEND`] = runner.backend;
		runnerEnvironment[`${prefix}_MODEL`] = runner.model;
		runnerEnvironment[`${prefix}_THINKING`] = runner.thinking;
		runnerEnvironment[`${prefix}_SPEED`] = runner.speed ?? "inherit";
	}
	return {
		...runnerEnvironment,
		// Codex's mature job backend still consumes these internal names.
		RESEARCH_PI_CODEX_ADVISOR_MODEL: codexAdvisor.model,
		RESEARCH_PI_CODEX_ADVISOR_EFFORT: codexAdvisor.thinking,
		RESEARCH_PI_CODEX_ADVISOR_SERVICE_TIER: codexAdvisor.speed ?? "inherit",
		RESEARCH_PI_CODEX_EXECUTOR_MODEL: codexExecutor.model,
		RESEARCH_PI_CODEX_EXECUTOR_EFFORT: codexExecutor.thinking,
		RESEARCH_PI_CODEX_EXECUTOR_SERVICE_TIER: codexExecutor.speed ?? "inherit",
		RESEARCH_PI_CODEX_SUBAGENT_MODEL: internalSubagent.model,
		RESEARCH_PI_CODEX_SUBAGENT_EFFORT: internalSubagent.thinking,
		RESEARCH_PI_CODEX_MAX_EXECUTORS: String(config.codex.maxExecutors),
		RESEARCH_PI_CODEX_RETENTION_DAYS: String(config.codex.retention.terminalDays),
		RESEARCH_PI_CODEX_KEEP_TERMINAL_JOBS: String(config.codex.retention.keepTerminalJobs),
		RESEARCH_PI_COMPACT_SOFT_TOKENS: String(compact.softTokens),
		RESEARCH_PI_COMPACT_HARD_TOKENS: String(compact.hardTokens),
		RESEARCH_PI_COMPACT_SUMMARY_TARGET_TOKENS: String(compact.summaryTargetTokens),
		RESEARCH_PI_COMPACT_SUMMARY_MAX_TOKENS: String(compact.summaryMaxTokens),
		RESEARCH_PI_SEARCH_MODEL: search.model,
		RESEARCH_PI_SEARCH_ENABLED: search.enabled,
		RESEARCH_PI_SEARCH_THINKING_BUDGET_TOKENS: String(search.thinkingBudgetTokens),
		RESEARCH_PI_SEARCH_MAX_SOURCES: String(search.maxSources),
		RESEARCH_PI_SEARCH_DEFAULT_MAX_USES: String(search.defaultMaxUses),
		RESEARCH_PI_UI_DENSITY: config.ui.density,
		RESEARCH_PI_UI_RUNTIME_STRIP: config.ui.runtimeStrip,
		RESEARCH_PI_UI_CONFIG_PANEL_ROWS: String(config.ui.configPanelRows),
		RESEARCH_PI_TRACE: config.diagnostics.trace ? "1" : "0",
		PI_CODEX_SQLITE_LOGS: config.diagnostics.codexSqliteLogs ? "1" : "0",
	};
}

export function researchPiConfigSummary(config, path) {
	return [
		`Research Pi config v${config.version}`,
		`Path: ${path}`,
		"Leader model/auth: Pi Core native settings (/login, /model, /scoped-models, /settings)",
		`Model settings: /models (Leader and subagent roles); /fast for the current GPT Leader`,
		...SUBAGENT_ROLES.map((role) => {
			const runner = config.subagents[role];
			return `${role}: ${runner.backend} · ${runner.model}/${runner.thinking}${runner.speed ? ` · speed ${runner.speed}` : ""}`;
		}),
		`Codex internal subagent: ${config.codex.internalSubagent.model}/${config.codex.internalSubagent.thinking} · speed inherited from parent`,
		`Codex concurrency: up to ${config.codex.maxExecutors} executors per workspace with disjoint write scopes`,
		`Codex retention: ${config.codex.retention.terminalDays} days · keep at least ${config.codex.retention.keepTerminalJobs} terminal jobs`,
		`Research compact: ${config.research.compaction.softTokens}/${config.research.compaction.hardTokens} tokens · summary target/max ${config.research.compaction.summaryTargetTokens}/${config.research.compaction.summaryMaxTokens}`,
		`Search: ${config.research.search.enabled} · deepseek/${config.research.search.model} · max ${config.research.search.maxSources} sources`,
		`UI: theme ${config.pi.settings.theme ?? "research-pi"} · ${config.ui.density} · runtime strip ${config.ui.runtimeStrip}`,
		`Web: ${config.ui.web.mode} · ${config.ui.web.persistent ? "resident" : "foreground"}`,
	].join("\n");
}
