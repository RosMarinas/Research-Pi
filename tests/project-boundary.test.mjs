import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	CODEX_FULL_ACCESS_PROFILE,
	analysisSshCommandPolicy,
	boundaryWarning,
	buildSandboxRuntimeConfig,
	codexPermissionConfigArguments,
	directToolPath,
	ensureProjectLocalStateExcluded,
	fullAccessPermissionProfileDefinition,
	isAnalysisReadOnlySshCommand,
	isProtectedProjectMutation,
	permissionProfileDefinition,
	researchPiFullAccessEnabled,
	resolveBoundaryPath,
	resolveExecutablePath,
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

test("full access bypasses direct-path approval for Leader but keeps the mode explicit in prompt and UI", async () => {
	const previous = process.env.RESEARCH_PI_FULL_ACCESS;
	const tools = [];
	const handlers = {};
	try {
		process.env.RESEARCH_PI_FULL_ACCESS = "1";
		projectBoundaryExtension({
			registerTool(tool) { tools.push(tool); },
			registerCommand() {},
			on(name, handler) { handlers[name] = handler; },
		});
		assert.match(tools.find((tool) => tool.name === "bash").label, /full access/);
		const ctx = {
			hasUI: true,
			sessionManager: { getBranch: () => [], getSessionId: () => "full-access-session" },
			ui: { confirm() { throw new Error("full access must not prompt"); } },
		};
		assert.equal(await handlers.tool_call({ toolName: "read", input: { path: "/outside/project.txt" } }, ctx), undefined);
		const injected = handlers.before_agent_start({ systemPrompt: "base" }, ctx);
		assert.match(injected.systemPrompt, /explicitly launched Research Pi with full access/);
		const wire = { messages: [{ role: "system", content: "base" }, { role: "user", content: "task" }] };
		const normalized = handlers.before_provider_request({ payload: wire }, ctx);
		assert.equal(normalized.messages[0].content, injected.systemPrompt, "mailbox continuation must retain the same permission explanation");
		assert.deepEqual(handlers.before_provider_request({ payload: normalized }, ctx), normalized, "never append the explanation twice");
		const anthropic = { system: [{ type: "text", text: "Provider-owned identity" }, { type: "text", text: "base", cache_control: { type: "ephemeral" } }] };
		const blocks = handlers.before_provider_request({ payload: anthropic }, ctx).system;
		assert.deepEqual(blocks[0], anthropic.system[0], "do not change the provider-owned prelude");
		assert.equal(blocks[1].text, injected.systemPrompt);
		assert.deepEqual(blocks[1].cache_control, anthropic.system[1].cache_control);
		const analysisCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: "research-runtime-session-policy", data: { policy: "analysis" } }] } };
		assert.equal(handlers.before_agent_start({ systemPrompt: "base" }, analysisCtx), undefined);
		assert.deepEqual(handlers.before_provider_request({ payload: normalized }, analysisCtx), wire, "an explicit role change must not replay a stale full-access explanation");
	} finally {
		if (previous === undefined) delete process.env.RESEARCH_PI_FULL_ACCESS;
		else process.env.RESEARCH_PI_FULL_ACCESS = previous;
	}
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

test("project-local Research Pi state is idempotently excluded through shared Git metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-local-exclude-"));
	try {
		const main = join(root, "main");
		const worktree = join(root, "worktree");
		mkdirSync(main);
		execFileSync("git", ["init", "-q", main]);
		writeFileSync(join(main, "README.md"), "fixture\n");
		execFileSync("git", ["-C", main, "add", "README.md"]);
		execFileSync("git", ["-C", main, "-c", "user.name=Research Pi Test", "-c", "user.email=test@research-pi.invalid", "commit", "-q", "-m", "fixture"]);
		execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "fixture-worktree", worktree]);

		const first = await ensureProjectLocalStateExcluded(worktree, { environment: { ...process.env } });
		assert.equal(first.status, "added");
		assert.equal(first.changed, true);
		assert.equal(realpathSync(first.path), realpathSync(join(main, ".git", "info", "exclude")));
		mkdirSync(join(worktree, ".pi", "research"), { recursive: true });
		writeFileSync(join(worktree, ".pi", "research", "experiments.jsonl"), "{}\n");
		assert.equal(execFileSync("git", ["-C", worktree, "status", "--short"], { encoding: "utf8" }), "");

		const second = await ensureProjectLocalStateExcluded(worktree, { environment: { ...process.env } });
		assert.equal(second.status, "already-ignored");
		assert.equal(second.changed, false);
		assert.equal((readFileSync(first.path, "utf8").match(/^\/\.pi\/$/gm) ?? []).length, 1);
		assert.equal((await ensureProjectLocalStateExcluded(join(root, "plain"))).status, "not-git");
	} finally {
		rmSync(root, { recursive: true, force: true });
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
	assert.equal(config.network.allowLocalBinding, true);
	assert.deepEqual(config.filesystem.allowWrite.slice(0, 1), [root]);
	assert.ok(config.filesystem.denyRead.includes("/Users"));
	assert.equal(config.filesystem.allowGitConfig, true);
	assert.deepEqual(
		config.credentials.envVars.map((item) => item.name).sort(),
		["DEEPSEEK_API_KEY", "HF_TOKEN", "OPENCODE_API_KEY", "ZAI_API_KEY"],
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

test("explicit full access selects a root-write Codex executor profile without widening advisor", () => {
	assert.equal(researchPiFullAccessEnabled({ RESEARCH_PI_FULL_ACCESS: "1" }), true);
	assert.equal(researchPiFullAccessEnabled({ RESEARCH_PI_FULL_ACCESS: "0" }), false);
	const profile = fullAccessPermissionProfileDefinition();
	assert.match(profile, /":root" = "write"/);
	assert.match(profile, /domains = \{ "\*" = "allow" \}/);

	const executorArgs = codexPermissionConfigArguments("executor", "/project", "/project/.tmp", null, undefined, {
		fullAccess: true,
	});
	assert.ok(executorArgs.some((arg) => arg.includes(`default_permissions="${CODEX_FULL_ACCESS_PROFILE}"`)));
	assert.ok(executorArgs.some((arg) => arg.includes('filesystem = { ":root" = "write" }')));

	const advisorArgs = codexPermissionConfigArguments("advisor", "/project", undefined, null, undefined, {
		fullAccess: true,
	});
	assert.ok(advisorArgs.some((arg) => arg.includes('default_permissions="research_pi_advisor"')));
	assert.ok(advisorArgs.some((arg) => arg.includes('":root" = "deny"')));
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
