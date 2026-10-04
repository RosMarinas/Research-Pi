import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const launcher = join(root, "bin", "pi.mjs");

test("packaged launcher creates external config/state and runs the pinned core", () => {
	const temp = mkdtempSync(join(tmpdir(), "research-pi-launcher-"));
	try {
		const config = join(temp, "config");
		const state = join(temp, "state");
		const environment = {
			...process.env,
			RESEARCH_PI_CONFIG_DIR: config,
			RESEARCH_PI_STATE_DIR: state,
		};
		delete environment.RESEARCH_PI_DEV_MODE;

		const setup = spawnSync(process.execPath, [launcher, "setup"], { encoding: "utf8", env: environment });
		assert.equal(setup.status, 0, setup.stderr);
		const credentials = join(config, "credentials.env");
		assert.match(readFileSync(credentials, "utf8"), /DEEPSEEK_API_KEY=/);
		assert.match(readFileSync(credentials, "utf8"), /OPENCODE_API_KEY=/);
		assert.match(readFileSync(credentials, "utf8"), /ZAI_API_KEY=/);
		assert.equal(statSync(credentials).mode & 0o777, 0o600);
		const configPath = join(config, "config.json");
		const persistedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(persistedConfig.version, 3);
		assert.equal(Object.hasOwn(persistedConfig, "activeProfile"), false);
		assert.equal(Object.hasOwn(persistedConfig, "profiles"), false);
		assert.equal(statSync(configPath).mode & 0o777, 0o600);
		assert.ok(statSync(join(config, "schemas", "research-pi-config.schema.json")).isFile());

		const paths = spawnSync(process.execPath, [launcher, "paths"], { encoding: "utf8", env: environment });
		assert.equal(paths.status, 0, paths.stderr);
		const parsed = JSON.parse(paths.stdout);
		assert.equal(parsed.stateRoot, state);
		assert.ok(!parsed.stateRoot.startsWith(root));
		assert.equal(parsed.configPath, configPath);

		const obsoleteProfileCommand = spawnSync(process.execPath, [launcher, "config", "use", "deepseek-flash"], { encoding: "utf8", env: environment });
		assert.notEqual(obsoleteProfileCommand.status, 0);
		assert.match(obsoleteProfileCommand.stderr, /pi config \[show\|path\|themes\|theme/);
		const settings = JSON.parse(readFileSync(join(state, "agent", "settings.json"), "utf8"));
		assert.equal(Object.hasOwn(settings, "defaultProvider"), false);
		assert.equal(Object.hasOwn(settings, "defaultModel"), false);
		assert.equal(Object.hasOwn(settings, "enabledModels"), false);
		assert.equal(existsSync(join(state, "agent", "models.json")), false);


		const version = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8", env: environment });
		assert.equal(version.status, 0, version.stderr);
		assert.equal(version.stdout.trim(), "1.0.0");
		const configureWeb = spawnSync(process.execPath, [launcher, "config", "web", "tailscale"], { encoding: "utf8", env: environment });
		assert.equal(configureWeb.status, 0, configureWeb.stderr);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).ui.web.mode, "tailscale");
		const fullAccessVersion = spawnSync(process.execPath, [launcher, "--full-access", "--version"], { encoding: "utf8", env: environment });
		assert.equal(fullAccessVersion.status, 0, fullAccessVersion.stderr);
		assert.equal(fullAccessVersion.stdout.trim(), "1.0.0");
		assert.equal(existsSync(join(state, "web")), false, "Informational commands must not start a resident host");
		assert.equal(existsSync(join(state, "agent", "models.json")), false);
		const context = spawnSync(process.execPath, [launcher, "config", "context", "openai-codex/gpt-6.1-sol", "872k"], { encoding: "utf8", env: environment });
		assert.equal(context.status, 0, context.stderr);
		assert.equal(JSON.parse(readFileSync(join(state, "agent", "models.json"), "utf8")).providers["openai-codex"].modelOverrides["gpt-6.1-sol"].contextWindow, 872000);
		const resetContext = spawnSync(process.execPath, [launcher, "config", "context", "openai-codex/gpt-6.1-sol", "inherit"], { encoding: "utf8", env: environment });
		assert.equal(resetContext.status, 0, resetContext.stderr);
		assert.equal(JSON.parse(readFileSync(join(state, "agent", "models.json"), "utf8")).providers["openai-codex"], undefined);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
