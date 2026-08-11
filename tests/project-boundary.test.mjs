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
	isProtectedProjectMutation,
	permissionProfileDefinition,
	resolveBoundaryPath,
	resolveProjectRoot,
	sanitizeBoundaryEnvironment,
} from "../.pi/lib/project-boundary.mjs";

test("project boundary exposes one opaque host-capability tool", () => {
	const tools = [];
	const commands = [];
	projectBoundaryExtension({
		registerTool(tool) {
			tools.push(tool.name);
		},
		registerCommand(name) {
			commands.push(name);
		},
		on() {},
	});
	assert.deepEqual(tools.sort(), ["bash", "host_capability"]);
	assert.deepEqual(commands, ["boundary"]);
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
		["DEEPSEEK_API_KEY", "HF_TOKEN"],
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
			environment: { DEVELOPER_DIR: "/Library/Developer/CommandLineTools" },
		};
		const profile = permissionProfileDefinition({ access: "write", workspaceRoot: root, runtimePolicy });
		assert.ok(profile.includes('"/Library/Developer/CommandLineTools" = "read"'));
		assert.ok(!profile.includes('"/Library/Developer/CommandLineTools" = "write"'));

		const args = codexPermissionConfigArguments("executor", root, join(root, ".git", "research-pi", "tmp"), null, runtimePolicy);
		assert.ok(args.some((arg) => arg.includes("DEVELOPER_DIR")));
		assert.ok(args.some((arg) => arg.includes("GIT_CONFIG_GLOBAL")));

		const config = buildSandboxRuntimeConfig(root, {}, runtimePolicy);
		assert.ok(config.filesystem.allowRead.includes("/Library/Developer/CommandLineTools"));
		assert.ok(!config.filesystem.allowWrite.includes("/Library/Developer/CommandLineTools"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
