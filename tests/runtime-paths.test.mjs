import assert from "node:assert/strict";
import test from "node:test";
import { resolveResearchPiPaths } from "../.pi/lib/runtime-paths.mjs";

test("development launcher keeps fast-iteration state in the checkout", () => {
	const paths = resolveResearchPiPaths({
		harnessRoot: "/workspace/Research-Pi",
		environment: { RESEARCH_PI_DEV_MODE: "1" },
		platform: "linux",
	});
	assert.equal(paths.development, true);
	assert.equal(paths.credentialsPath, "/workspace/Research-Pi/.env");
	assert.equal(paths.configPath, "/workspace/Research-Pi/.pi/config.json");
	assert.equal(paths.agentDir, "/workspace/Research-Pi/.pi/agent");
	assert.equal(paths.sessionDir, "/workspace/Research-Pi/.pi/sessions");
});

test("packaged launcher separates configuration and state from installed code", () => {
	const paths = resolveResearchPiPaths({
		harnessRoot: "/opt/node/lib/node_modules/research-pi",
		environment: {
			XDG_CONFIG_HOME: "/home/user/.config",
			XDG_STATE_HOME: "/home/user/.local/state",
		},
		platform: "linux",
	});
	assert.equal(paths.development, false);
	assert.equal(paths.credentialsPath, "/home/user/.config/research-pi/credentials.env");
	assert.equal(paths.configPath, "/home/user/.config/research-pi/config.json");
	assert.equal(paths.agentDir, "/home/user/.local/state/research-pi/agent");
	assert.equal(paths.sessionDir, "/home/user/.local/state/research-pi/sessions");
	assert.ok(!paths.stateRoot.startsWith(paths.harnessRoot));
});
