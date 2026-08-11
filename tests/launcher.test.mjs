import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
		assert.equal(statSync(credentials).mode & 0o777, 0o600);

		const paths = spawnSync(process.execPath, [launcher, "paths"], { encoding: "utf8", env: environment });
		assert.equal(paths.status, 0, paths.stderr);
		const parsed = JSON.parse(paths.stdout);
		assert.equal(parsed.stateRoot, state);
		assert.ok(!parsed.stateRoot.startsWith(root));

		const version = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8", env: environment });
		assert.equal(version.status, 0, version.stderr);
		assert.match(version.stdout, /0\.84\.1/);
		assert.ok(statSync(join(state, "agent", "models.json")).isFile());
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
