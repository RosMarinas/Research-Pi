import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import projectBoundaryExtension from "../.pi/extensions/project-boundary.ts";
import {
	CODEX_EXECUTOR_PROFILE,
	boundaryWarning,
	buildSandboxRuntimeConfig,
	codexPermissionConfigArguments,
	directToolPath,
	isAnalysisReadOnlySshCommand,
	isProtectedProjectMutation,
	permissionProfileDefinition,
	resolveBoundaryPath,
	resolveProjectRoot,
	sanitizeBoundaryEnvironment,
} from "../.pi/lib/project-boundary.mjs";
import { getHostCapabilityUiAdapter } from "../.pi/lib/research-runtime-adapters.mjs";

test("project boundary exposes one opaque host-capability tool", () => {
	const tools = [];
	const commands = [];
	projectBoundaryExtension({
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name) {
			commands.push(name);
		},
		on() {},
	});
	assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bash", "host_capability"]);
	const hostTool = tools.find((tool) => tool.name === "host_capability");
	assert.match(hostTool.description, /command runs an argv/);
	assert.match(JSON.stringify(hostTool.parameters), /host command argv/);
	assert.match(JSON.stringify(hostTool.parameters), /"command"/);
	assert.match(JSON.stringify(hostTool.parameters), /grantId/);
	assert.deepEqual(commands, ["boundary"]);
	assert.equal(typeof getHostCapabilityUiAdapter()?.review, "function");
});

test("path resolution accepts project paths and detects traversal plus symlink escapes", async () => {
	const parent = mkdtempSync(join(tmpdir(), "research-pi-boundary-path-"));
	try {
		const root = join(parent, "project");
		const outside = join(parent, "outside");
		mkdirSync(root);
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "nested"));
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "synthetic\n");
		symlinkSync(outside, join(root, "escape"));

		assert.equal((await resolveBoundaryPath(root, "inside/new.txt")).inside, true);
		assert.equal(await resolveProjectRoot(join(root, "nested")), realpathSync(root));
		assert.equal((await resolveBoundaryPath(root, "../outside/secret.txt")).inside, false);
		const escaped = await resolveBoundaryPath(root, "escape/future.txt");
		assert.equal(escaped.inside, false);
		assert.match(boundaryWarning(escaped, "read tool"), /真实路径/);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("credential-like project paths require the same one-shot gate", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-boundary-secret-"));
	try {
		assert.equal((await resolveBoundaryPath(root, ".env")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, ".env.local")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, "src/model.ts")).sensitive, false);
		assert.equal(directToolPath("grep", {}), ".");
		assert.equal(directToolPath("bash", { path: ".." }), undefined);
		assert.equal(isProtectedProjectMutation(root, join(root, ".git", "hooks", "pre-commit")), true);
		assert.equal(isProtectedProjectMutation(root, join(root, ".git", "config")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi sandbox runtime is project-write, host-region-read-denied, and network-unrestricted", () => {
	const root = "/Users/example/research-project";
	const config = buildSandboxRuntimeConfig(root, {
		PATH: "/bin",
		DEEPSEEK_API_KEY: "secret",
		OPENCODE_API_KEY: "go-secret",
		HF_TOKEN: "secret-too",
	});
	assert.deepEqual(config.network.allowedDomains, []);
	assert.equal(config.network.strictAllowlist, false);
	assert.equal(config.network.allowLocalBinding, true);
	assert.deepEqual(config.filesystem.allowWrite.slice(0, 1), [root]);
	assert.ok(config.filesystem.denyRead.includes("/Users"));
	assert.equal(config.filesystem.allowGitConfig, true);
	assert.deepEqual(
		config.credentials.envVars.map((item) => item.name).sort(),
		["DEEPSEEK_API_KEY", "HF_TOKEN", "OPENCODE_API_KEY"],
	);
});

test("sandboxed commands do not inherit secret-named variables", () => {
	const env = sanitizeBoundaryEnvironment({
		PATH: "/bin",
		HOME: "/Users/example",
		OPENAI_API_KEY: "secret",
		SSH_AUTH_SOCK: "/tmp/ssh.sock",
		RUN_TOKEN: "token",
	});
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/Users/example");
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.SSH_AUTH_SOCK, undefined);
	assert.equal(env.RUN_TOKEN, undefined);
});

test("Analysis Session SSH accepts inspection commands and rejects remote side effects", () => {
	for (const command of [
		"cat /home/research/runs/r1/summary.json",
		"rg 'loss|accuracy' /home/research/runs/r1 | head -50",
		"git -C /home/research/project log -5 --oneline",
		"nvidia-smi --query-gpu=name,memory.used --format=csv,noheader",
		"squeue -u researcher",
	]) assert.equal(isAnalysisReadOnlySshCommand(command), true, command);

	for (const command of [
		"python3 -c 'print(1)'",
		"cat result.json > copied.json",
		"find /home/research/runs -delete",
		"git reset --hard HEAD~1",
		"git diff --output=/tmp/result.diff",
		"cat ~/.ssh/id_ed25519",
		"cat result.json; rm result.json",
		"journalctl --vacuum-time=1s",
		"nvidia-smi -pm 1",
	]) assert.equal(isAnalysisReadOnlySshCommand(command), false, command);
});

test("Codex executor profile keeps project and Git writable with public network", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-profile-"));
	try {
		mkdirSync(join(root, ".git"));
		const profile = permissionProfileDefinition({ access: "write", workspaceRoot: root });
		assert.match(profile, /":root" = "deny"/);
		assert.match(profile, /\.git\/objects.*"write"/);
		assert.match(profile, /\.git\/hooks.*"read"/);
		assert.match(profile, /domains = \{ "\*" = "allow" \}/);

		const args = codexPermissionConfigArguments("executor", root, `${root}/.git/research-pi/tmp`, {
			name: "Research Pi",
			email: "research-pi@example.invalid",
		});
		assert.ok(args.some((arg) => arg.includes(`default_permissions="${CODEX_EXECUTOR_PROFILE}"`)));
		assert.ok(args.some((arg) => arg.includes("ignore_default_excludes=false")));
		assert.ok(args.some((arg) => arg.includes("TMPDIR")));
		assert.ok(args.some((arg) => arg.includes("GIT_AUTHOR_NAME")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shared system runtime policy is read-only in both Pi and Codex sandboxes", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-policy-"));
	try {
		mkdirSync(join(root, ".git"));
		const runtimePolicy = {
			platform: "darwin",
			readRoots: ["/Library/Developer/CommandLineTools"],
			instructionRoots: ["/Users/example/.codex/skills"],
			environment: { DEVELOPER_DIR: "/Library/Developer/CommandLineTools" },
		};
		const profile = permissionProfileDefinition({ access: "write", workspaceRoot: root, runtimePolicy });
		assert.ok(profile.includes('"/Library/Developer/CommandLineTools" = "read"'));
		assert.ok(!profile.includes('"/Library/Developer/CommandLineTools" = "write"'));
		assert.ok(profile.includes('"/Users/example/.codex/skills" = "read"'));
		assert.ok(!profile.includes('"/Users/example/.codex/skills" = "write"'));

		const args = codexPermissionConfigArguments("executor", root, join(root, ".git", "research-pi", "tmp"), null, runtimePolicy);
		assert.ok(args.some((arg) => arg.includes("DEVELOPER_DIR")));
		assert.ok(args.some((arg) => arg.includes("GIT_CONFIG_GLOBAL")));

		const config = buildSandboxRuntimeConfig(root, {}, runtimePolicy);
		assert.ok(config.filesystem.allowRead.includes("/Library/Developer/CommandLineTools"));
		assert.ok(config.filesystem.allowRead.includes("/Users/example/.codex/skills"));
		assert.ok(!config.filesystem.allowWrite.includes("/Library/Developer/CommandLineTools"));
		assert.ok(!config.filesystem.allowWrite.includes("/Users/example/.codex/skills"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
