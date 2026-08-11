import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import projectBoundaryExtension from "../.pi/extensions/project-boundary.ts";
import {
	CODEX_EXECUTOR_PROFILE,
	assertWslSandboxDependencies,
	assertWslWorkspaceBoundary,
	boundaryWarning,
	buildSandboxRuntimeConfig,
	codexPermissionConfigArguments,
	directToolPath,
	isProtectedProjectMutation,
	isWslHostMount,
	permissionProfileDefinition,
	resolveBoundaryPath,
	resolveProjectRoot,
	sanitizeBoundaryEnvironment,
	sanitizeWslInteropEnvironment,
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
	assert.equal(config.network.allowAllUnixSockets, false);
	assert.equal(config.network.allowLocalBinding, true);
	assert.equal(config.enableWeakerNestedSandbox, false);
	assert.deepEqual(config.filesystem.allowWrite.slice(0, 1), [root]);
	assert.ok(config.filesystem.denyRead.includes("/Users"));
	assert.equal(config.filesystem.allowGitConfig, true);
	assert.deepEqual(
		config.credentials.envVars.map((item) => item.name).sort(),
		["DEEPSEEK_API_KEY", "HF_TOKEN"],
	);
});

test("WSL policy refuses host-mounted projects and degraded interop isolation", () => {
	assert.equal(isWslHostMount("/mnt/c/Users/example/project"), true);
	assert.equal(isWslHostMount("/home/example/project"), false);
	assert.throws(
		() => assertWslWorkspaceBoundary("/mnt/c/Users/example/project", "2"),
		/Windows host/,
	);
	assert.throws(() => assertWslWorkspaceBoundary("/home/example/project", "1"), /requires WSL2/);
	assert.doesNotThrow(() => assertWslWorkspaceBoundary("/home/example/project", "2"));
	assert.doesNotThrow(() => assertWslWorkspaceBoundary("/mnt/c/Users/example/project", undefined));

	assert.throws(
		() =>
			assertWslSandboxDependencies(
				{ warnings: ["seccomp not available - unix socket access not restricted"], errors: [] },
				"2",
			),
		/host-interop sockets/,
	);
	assert.doesNotThrow(() => assertWslSandboxDependencies({ warnings: [], errors: [] }, "2"));
	assert.doesNotThrow(() =>
		assertWslSandboxDependencies(
			{ warnings: ["seccomp not available - unix socket access not restricted"], errors: [] },
			undefined,
		),
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

test("WSL child environments cannot discover Windows executables or the host bridge", () => {
	const env = sanitizeWslInteropEnvironment(
		{
			PATH: "/usr/local/bin:/usr/bin:/mnt/c/Windows/System32:/run/desktop/mnt/host/c/tools",
			WSL_INTEROP: "/run/WSL/123_interop",
			WSLENV: "PATH/l",
			WSL_DISTRO_NAME: "Ubuntu",
		},
		"2",
	);
	assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
	assert.equal(env.WSL_INTEROP, undefined);
	assert.equal(env.WSLENV, undefined);
	assert.equal(env.WSL_DISTRO_NAME, "Ubuntu");

	const native = sanitizeWslInteropEnvironment({ PATH: "/bin:/mnt/c/tools", WSL_INTEROP: "kept" }, undefined);
	assert.equal(native.PATH, "/bin:/mnt/c/tools");
	assert.equal(native.WSL_INTEROP, "kept");
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
