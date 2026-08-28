import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import projectBoundaryExtension from "../.pi/extensions/project-boundary.ts";
import {
	createCapabilityGrant,
	prepareCapabilityRequest,
	resolveCapabilityContext,
} from "../.pi/lib/host-capabilities.mjs";
import {
	CODEX_EXECUTOR_PROFILE,
	analysisSshCommandPolicy,
	assertWslSandboxDependencies,
	assertWslWorkspaceBoundary,
	boundaryWarning,
	buildSandboxRuntimeConfig,
	codexPermissionConfigArguments,
	directToolPath,
	isAnalysisReadOnlySshCommand,
	isProtectedProjectMutation,
	isWslHostMount,
	permissionProfileDefinition,
	resolveBoundaryPath,
	resolveExecutablePath,
	resolveProjectRoot,
	sanitizeBoundaryEnvironment,
	sanitizeWslInteropEnvironment,
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

test("project boundary reuses an approved external-read grant", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-boundary-external-read-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	const capabilityDir = join(root, "capabilities");
	const sessionId = "session-external-read";
	const handlers = {};
	const notifications = [];
	const previousCapabilityDir = process.env.PI_RESEARCH_CAPABILITY_DIR;
	try {
		mkdirSync(join(project, ".git"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		const externalFile = join(outside, "briefing.md");
		writeFileSync(externalFile, "synthetic briefing\n");
		process.env.PI_RESEARCH_CAPABILITY_DIR = capabilityDir;

		projectBoundaryExtension({
			registerTool() {},
			registerCommand() {},
			on(name, handler) {
				handlers[name] = handler;
			},
		});
		const ctx = {
			cwd: project,
			hasUI: true,
			sessionManager: {
				getSessionId: () => sessionId,
				getBranch: () => [],
			},
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
				notify(message) { notifications.push(message); },
				select() { throw new Error("existing grant should avoid prompting"); },
			},
		};
		await handlers.session_start({}, ctx);
		const capabilityContext = await resolveCapabilityContext(project, sessionId, { stateRoot: capabilityDir });
		const request = await prepareCapabilityRequest(capabilityContext, { kind: "external-read", path: externalFile });
		const grant = await createCapabilityGrant(capabilityContext, request, "session");

		const result = await handlers.tool_call({ toolName: "read", input: { path: externalFile } }, ctx);
		assert.equal(result, undefined);
		assert.ok(notifications.some((message) => message.includes(`Using ${grant.id}`)));
	} finally {
		await handlers.session_shutdown?.();
		if (previousCapabilityDir === undefined) delete process.env.PI_RESEARCH_CAPABILITY_DIR;
		else process.env.PI_RESEARCH_CAPABILITY_DIR = previousCapabilityDir;
		rmSync(root, { recursive: true, force: true });
	}
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

test("Codex executable resolution pins the canonical target behind PATH symlinks", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-bin-"));
	try {
		const target = join(root, "codex-real");
		const link = join(root, "codex");
		writeFileSync(target, "#!/bin/sh\nexit 0\n");
		chmodSync(target, 0o755);
		symlinkSync(target, link);
		assert.equal(
			await resolveExecutablePath("codex", { environment: { PATH: root }, platform: "darwin" }),
			realpathSync(target),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("credential-like project paths require the same one-shot gate", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-boundary-secret-"));
	try {
		assert.equal((await resolveBoundaryPath(root, ".env")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, ".env.local")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, ".npmrc")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, ".codex/auth.json")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, ".config/gh/hosts.yml")).sensitive, true);
		assert.equal((await resolveBoundaryPath(root, ".config/research-pi/credentials.env")).sensitive, true);
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
		ZAI_API_KEY: "zai-secret",
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
		["DEEPSEEK_API_KEY", "HF_TOKEN", "OPENCODE_API_KEY", "ZAI_API_KEY"],
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

test("Analysis shell keeps the project read-only with only Runtime temp writable", () => {
	const root = "/Users/example/research-project";
	const runtimeTmp = `${root}/.git/research-pi/tmp`;
	const config = buildSandboxRuntimeConfig(root, { PATH: "/bin" }, undefined, {
		access: "read",
		runtimeTmp,
	});
	assert.ok(config.filesystem.allowRead.includes(root));
	assert.ok(config.filesystem.allowWrite.includes(runtimeTmp));
	assert.ok(!config.filesystem.allowWrite.includes(root));
	assert.ok(config.filesystem.denyRead.includes("/Users"));
	assert.equal(config.network.strictAllowlist, true);
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

	for (const command of ["./cat result.json", "/tmp/cat result.json", "./git status"]) {
		assert.equal(isAnalysisReadOnlySshCommand(command), false, command);
		assert.equal(analysisSshCommandPolicy(command), "approval_required", command);
	}
	for (const command of ["cat ~/.codex/auth.json", "cat ~/.docker/config.json", "cat ~/.config/gh/hosts.yml", "cat ~/_netrc"]) {
		assert.equal(analysisSshCommandPolicy(command), "denied", command);
	}
});

test("Codex executor profile keeps project and Git writable with public network", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-profile-"));
	try {
		mkdirSync(join(root, ".git"));
		const profile = permissionProfileDefinition({ access: "write", workspaceRoot: root });
		assert.match(profile, /":root" = "deny"/);
		assert.match(profile, /\.git\/objects.*"write"/);
		assert.match(profile, /\.git\/hooks.*"read"/);
		assert.match(profile, /\.npmrc.*"deny"/);
		assert.match(profile, /\.codex\/auth\.json.*"deny"/);
		assert.match(profile, /\.config\/gh\/hosts\.yml.*"deny"/);
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

test("linked worktrees grant their real Git dir and common dir without making hooks writable", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-linked-worktree-"));
	try {
		const commonGit = join(root, "main", ".git");
		const worktreeGit = join(commonGit, "worktrees", "feature");
		const worktree = join(root, "feature");
		mkdirSync(worktreeGit, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
		writeFileSync(join(worktreeGit, "commondir"), "../..\n");
		const profile = permissionProfileDefinition({ access: "write", workspaceRoot: worktree });
		assert.match(profile, new RegExp(worktreeGit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(profile, new RegExp(join(commonGit, "objects").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(profile, new RegExp(`${join(commonGit, "hooks").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*read`));
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
