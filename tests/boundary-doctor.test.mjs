import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWslSandboxProbe } from "../.pi/lib/boundary-doctor.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "research-pi-wsl-doctor-"));
	const runtimeTmp = join(root, ".git", "research-pi", "tmp");
	mkdirSync(runtimeTmp, { recursive: true });
	return { root, runtimeTmp };
}

test("WSL doctor requires strong dependencies and executes the isolation probe", async () => {
	const runtime = fixture();
	let initialized = false;
	let wrappedCommand = "";
	let reset = false;
	const sandboxManager = {
		async checkDependenciesAsync() {
			return { warnings: [], errors: [] };
		},
		async initialize(config) {
			initialized = true;
			assert.equal(config.network.allowAllUnixSockets, false);
		},
		async wrapWithSandboxArgv(command) {
			wrappedCommand = command;
			return {
				argv: [process.execPath, "-e", "process.stdout.write('research-pi-wsl-preflight=ok\\n')"],
				env: {},
			};
		},
		async reset() {
			reset = true;
		},
	};
	try {
		const result = await runWslSandboxProbe(
			runtime,
			{ PATH: "/usr/bin:/mnt/c/Windows/System32" },
			{ readRoots: [], environment: {}, diagnostics: [] },
			{ wslVersion: "2", sandboxManager },
		);
		assert.equal(result.ok, true);
		assert.equal(initialized, true);
		assert.equal(reset, true);
		assert.match(wrappedCommand, /ls \/mnt\/c/);
		assert.match(wrappedCommand, /cmd\.exe/);
	} finally {
		rmSync(runtime.root, { recursive: true, force: true });
	}
});

test("WSL doctor fails closed when seccomp cannot restrict host interop", async () => {
	const runtime = fixture();
	let initialized = false;
	const sandboxManager = {
		async checkDependenciesAsync() {
			return { warnings: ["seccomp not available - unix socket access not restricted"], errors: [] };
		},
		async initialize() {
			initialized = true;
		},
		async reset() {},
	};
	try {
		const result = await runWslSandboxProbe(
			runtime,
			{ PATH: "/usr/bin" },
			{ readRoots: [], environment: {}, diagnostics: [] },
			{ wslVersion: "2", sandboxManager },
		);
		assert.equal(result.ok, false);
		assert.match(result.error, /refuses degraded WSL isolation/);
		assert.equal(initialized, false);
	} finally {
		rmSync(runtime.root, { recursive: true, force: true });
	}
});
