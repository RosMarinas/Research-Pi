import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getWslVersion, SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, BashOperations } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import {
	boundaryWarning,
	buildSandboxRuntimeConfig,
	directToolPath,
	assertWslSandboxDependencies,
	isProtectedProjectMutation,
	likelySandboxDenial,
	prepareBoundaryRuntime,
	readGitIdentity,
	resolveBoundaryPath,
	sanitizeBoundaryEnvironment,
} from "../lib/project-boundary.mjs";

type BoundaryRuntime = Awaited<ReturnType<typeof prepareBoundaryRuntime>>;

async function verifyWslHostInteropBlocked(
	runtime: BoundaryRuntime,
	gitIdentity: Awaited<ReturnType<typeof readGitIdentity>>,
) {
	const wslVersion = getWslVersion();
	if (wslVersion === undefined) return undefined;

	const dependencies = await SandboxManager.checkDependenciesAsync();
	assertWslSandboxDependencies(dependencies, wslVersion);

	let output = "";
	const probe = await createProjectBashOperations(runtime, gitIdentity).exec("cmd.exe /d /c exit 0", runtime.root, {
		onData(chunk) {
			output = `${output}${chunk.toString()}`.slice(-8192);
		},
		timeout: 10,
		env: process.env,
	});
	if (probe.exitCode === 0) {
		throw new Error(
			"WSL host interop escaped the Research Pi sandbox: cmd.exe executed successfully. " +
				"Disable WSL interop or restore seccomp and /mnt isolation before using agent shell tools.",
		);
	}
	return { version: wslVersion, probeExitCode: probe.exitCode, output };
}

function terminateProcess(child: ReturnType<typeof spawn>) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function createProjectBashOperations(
	runtime: BoundaryRuntime,
	gitIdentity: Awaited<ReturnType<typeof readGitIdentity>>,
): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const workingPath = await resolveBoundaryPath(runtime.root, cwd);
			if (!workingPath.inside) {
				onData(Buffer.from(`${boundaryWarning(workingPath, "bash working directory")}\n`));
				return { exitCode: 126 };
			}

			const commandId = `research-pi-${randomUUID()}`;
			const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/zsh", undefined, signal, cwd, {
				commandId,
				commandText: command,
			});
			const childEnv = sanitizeBoundaryEnvironment({ ...env, ...wrapped.env });
			childEnv.TMPDIR = runtime.runtimeTmp;
			childEnv.TMP = runtime.runtimeTmp;
			childEnv.TEMP = runtime.runtimeTmp;
			childEnv.GIT_CONFIG_GLOBAL = "/dev/null";
			childEnv.GIT_CONFIG_NOSYSTEM = "1";
			const gitConfigCount = Number.parseInt(childEnv.GIT_CONFIG_COUNT ?? "0", 10) || 0;
			childEnv.GIT_CONFIG_COUNT = String(gitConfigCount + 1);
			childEnv[`GIT_CONFIG_KEY_${gitConfigCount}`] = "core.excludesFile";
			childEnv[`GIT_CONFIG_VALUE_${gitConfigCount}`] = "/dev/null";
			if (gitIdentity) {
				childEnv.GIT_AUTHOR_NAME = gitIdentity.name;
				childEnv.GIT_AUTHOR_EMAIL = gitIdentity.email;
				childEnv.GIT_COMMITTER_NAME = gitIdentity.name;
				childEnv.GIT_COMMITTER_EMAIL = gitIdentity.email;
			}

			return await new Promise((resolveExec, reject) => {
				const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
					cwd,
					detached: true,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: childEnv,
				});
				let outputTail = "";
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				const capture = (chunk: Buffer) => {
					onData(chunk);
					outputTail = `${outputTail}${chunk.toString()}`.slice(-65536);
				};
				child.stdout?.on("data", capture);
				child.stderr?.on("data", capture);

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						terminateProcess(child);
					}, timeout * 1000);
				}

				const abort = () => terminateProcess(child);
				signal?.addEventListener("abort", abort, { once: true });
				child.on("error", (error) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", abort);
					SandboxManager.cleanupAfterCommand();
					reject(error);
				});
				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", abort);
					if (signal?.aborted) return reject(new Error("aborted"));
					if (timedOut) return reject(new Error(`timeout:${timeout}`));
					const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
					const violationText = violations.map((violation) => violation.line).join("\n");
					const crossedBoundary = likelySandboxDenial(`${outputTail}\n${violationText}`);
					if (crossedBoundary) {
						onData(
							Buffer.from(
								"\n[Research Pi boundary] Agent shell crossed the project boundary. Do not bypass it indirectly. Ask the user to approve one explicit file-tool access or to run the exact command with !.\n",
							),
						);
					}
					SandboxManager.cleanupAfterCommand();
					resolveExec({ exitCode: crossedBoundary && (code ?? 0) === 0 ? 126 : code });
				});
			});
		},
	};
}

export default function projectBoundaryExtension(pi: ExtensionAPI) {
	let runtime: BoundaryRuntime | undefined;
	let gitIdentity: Awaited<ReturnType<typeof readGitIdentity>>;
	let initializationError: string | undefined;
	let userOverrideNoticeShown = false;
	let wslIsolation: Awaited<ReturnType<typeof verifyWslHostInteropBlocked>>;
	const baseBash = createBashTool(process.cwd());

	pi.registerTool({
		...baseBash,
		label: "bash (project boundary)",
		promptSnippet: "Execute shell commands inside the current project boundary; public network is available",
		promptGuidelines: [
			"Agent-initiated shell commands may read minimal system runtime paths and may read/write the current project, including Git metadata; they cannot access other user directories or write system temp paths.",
			"Public network access is available without a domain allowlist. Unix sockets and host credential files remain outside the project boundary.",
			"When running under WSL2, Windows host mounts and Windows executable interop are outside the agent boundary. Do not invoke powershell.exe, cmd.exe, wsl.exe, or paths below /mnt; hand an exact command to the user instead.",
			"If an operation needs a path outside the project, do not attempt an indirect bypass. State the exact path and operation, then ask the user for one explicit approval or ask them to run the exact command with !.",
		],
		async execute(id, params, signal, onUpdate, ctx) {
			if (!runtime) {
				return {
					content: [
						{
							type: "text",
							text: `Research Pi project sandbox is unavailable and failed closed: ${initializationError ?? "not initialized"}`,
						},
					],
					isError: true,
				};
			}
			const sandboxed = createBashTool(ctx.cwd, {
				operations: createProjectBashOperations(runtime, gitIdentity),
				exposeSessionEnvironment: false,
			});
			return await sandboxed.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const requestedPath = directToolPath(event.toolName, event.input);
		if (requestedPath === undefined) return undefined;
		const info = await resolveBoundaryPath(runtime?.root ?? ctx.cwd, requestedPath);
		const protectedMutation =
			(event.toolName === "write" || event.toolName === "edit") &&
			isProtectedProjectMutation(info.root, info.resolvedPath);
		if (info.inside && !info.sensitive && !protectedMutation) return undefined;

		const warning = boundaryWarning(
			info,
			`${event.toolName} tool`,
			protectedMutation ? "受保护的 Git hooks 持久执行路径" : undefined,
		);
		if (!ctx.hasUI) return { block: true, reason: `${warning}\n非交互模式不能批准越界操作。`, terminate: false };
		const approved = await ctx.ui.confirm("⚠️ Research Pi 正在突破项目限制区", `${warning}\n\n只批准这一次工具调用吗？`);
		if (!approved) return { block: true, reason: `${warning}\n用户未批准。`, terminate: false };
		ctx.ui.notify(`已由人工批准一次性 ${event.toolName}: ${info.resolvedPath}`, "warning");
		return undefined;
	});

	pi.on("user_bash", (_event, ctx) => {
		if (!userOverrideNoticeShown) {
			ctx.ui.notify("! / !! 是人工权限通道：该命令不受 agent 项目沙箱约束，将以你的系统权限直接运行。", "warning");
			userOverrideNoticeShown = true;
		}
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			runtime = await prepareBoundaryRuntime(ctx.cwd);
			gitIdentity = await readGitIdentity(runtime.root);
			await SandboxManager.initialize(
				buildSandboxRuntimeConfig(runtime.root),
				async () => true,
				process.platform === "darwin",
			);
			wslIsolation = await verifyWslHostInteropBlocked(runtime, gitIdentity);
			initializationError = undefined;
			ctx.ui.setStatus(
				"boundary",
				ctx.ui.theme.fg(
					"accent",
					wslIsolation
						? `🔒 wsl${wslIsolation.version} · project-only · host bridge blocked`
						: "🔒 project-only · net open · git write",
				),
			);
		} catch (error) {
			await SandboxManager.reset().catch(() => undefined);
			runtime = undefined;
			wslIsolation = undefined;
			initializationError = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("boundary", ctx.ui.theme.fg("error", "🔒 boundary failed closed"));
			ctx.ui.notify(`Research Pi project boundary failed to initialize: ${initializationError}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await SandboxManager.reset().catch(() => undefined);
		runtime = undefined;
		wslIsolation = undefined;
	});

	pi.registerCommand("boundary", {
		description: "Show the active Research Pi project security boundary",
		handler: async (_args, ctx) => {
			const lines = runtime
				? [
						"Research Pi project boundary is active.",
						`Project root: ${runtime.root}`,
						"Agent shell: project read/write; .git commit/config/refs writable; .git/hooks read-only.",
						"Network: public destinations and local binding enabled; Unix sockets not inherited.",
						wslIsolation
							? `WSL${wslIsolation.version}: /mnt denied; seccomp required; cmd.exe host-interop probe blocked (exit ${wslIsolation.probeExitCode}).`
							: undefined,
						"Outside path: direct file tools ask once; shell fails and must be handed to the user as an exact ! command.",
					].filter(Boolean)
				: [`Boundary unavailable (failed closed): ${initializationError ?? "not initialized"}`];
			ctx.ui.notify(lines.join("\n"), runtime ? "info" : "error");
		},
	});
}
