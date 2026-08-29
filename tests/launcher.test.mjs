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
		assert.equal(persistedConfig.version, 2);
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
		assert.match(version.stdout, /0\.84\.2/);
		assert.equal(existsSync(join(state, "agent", "models.json")), false);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
