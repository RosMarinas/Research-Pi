import { homedir } from "node:os";
import { join, resolve } from "node:path";

function defaultConfigRoot(environment, platform) {
	if (environment.RESEARCH_PI_CONFIG_DIR) return resolve(environment.RESEARCH_PI_CONFIG_DIR);
	if (environment.XDG_CONFIG_HOME) return resolve(environment.XDG_CONFIG_HOME, "research-pi");
	if (platform === "win32") return resolve(environment.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Research-Pi");
	return resolve(homedir(), ".config", "research-pi");
}

function defaultStateRoot(environment, platform) {
	if (environment.RESEARCH_PI_STATE_DIR) return resolve(environment.RESEARCH_PI_STATE_DIR);
	if (environment.XDG_STATE_HOME) return resolve(environment.XDG_STATE_HOME, "research-pi");
	if (platform === "win32") {
		return resolve(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Research-Pi", "state");
	}
	return resolve(homedir(), ".local", "state", "research-pi");
}

export function resolveResearchPiPaths(options) {
	const harnessRoot = resolve(options.harnessRoot);
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const development = environment.RESEARCH_PI_DEV_MODE === "1";
	const configRoot = development ? harnessRoot : defaultConfigRoot(environment, platform);
	const stateRoot = development ? join(harnessRoot, ".pi") : defaultStateRoot(environment, platform);
	const configPath = environment.RESEARCH_PI_CONFIG_FILE
		? resolve(environment.RESEARCH_PI_CONFIG_FILE)
		: development
			? join(harnessRoot, ".pi", "config.json")
			: join(configRoot, "config.json");
	return {
		development,
		harnessRoot,
		configRoot,
		configPath,
		stateRoot,
		credentialsPath: development ? join(harnessRoot, ".env") : join(configRoot, "credentials.env"),
		agentDir: join(stateRoot, "agent"),
		sessionDir: join(stateRoot, "sessions"),
		memoryDir: join(stateRoot, "memory"),
		runtimeDir: join(stateRoot, "runtime"),
		codexDir: join(stateRoot, "codex"),
		capabilityDir: join(stateRoot, "capabilities"),
		traceDir: join(stateRoot, "agent", "traces"),
	};
}

export function researchPiStateRoot(harnessRoot, environment = process.env) {
	return resolveResearchPiPaths({ harnessRoot, environment }).stateRoot;
}
