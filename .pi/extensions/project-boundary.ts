import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getWslVersion, SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { dirname, join } from "node:path";
import type { ExtensionAPI, BashOperations } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	authorizeCapabilityRequest,
	capabilityGrantSummary,
	createCapabilityGrant,
	executeGrantedCapability,
	findCapabilityGrant,
	inspectCapabilityAuthorization,
	isForbiddenCredentialRead,
	listCapabilityGrants,
	prepareCapabilityRequest,
	resolveCapabilityContext,
	revokeCapabilityGrant,
} from "../lib/host-capabilities.mjs";
import { registerHostCapabilityUiAdapter } from "../lib/research-runtime-adapters.mjs";
import {
	boundaryWarning,
	analysisSshCommandPolicy,
	buildSandboxRuntimeConfig,
	directToolPath,
	assertWslSandboxDependencies,
	isProtectedProjectMutation,
	likelySandboxDenial,
	prepareBoundaryRuntime,
	readGitIdentity,
	resolveBoundaryPath,
	runCodexSandboxPreflight,
	sanitizeBoundaryEnvironment,
} from "../lib/project-boundary.mjs";
import { runtimeSessionInheritancePolicy } from "../lib/research-runtime.mjs";
import { resolveSystemRuntimePolicy } from "../lib/security-policy.mjs";

type BoundaryRuntime = Awaited<ReturnType<typeof prepareBoundaryRuntime>>;
type CapabilityContext = Awaited<ReturnType<typeof resolveCapabilityContext>>;
type SystemRuntimePolicy = Awaited<ReturnType<typeof resolveSystemRuntimePolicy>>;
const INITIAL_SESSION_POLICY = process.env.RESEARCH_PI_INITIAL_SESSION_MODE === "analysis" ? "analysis" : "project";

function currentSessionPolicy(ctx: any) {
	return runtimeSessionInheritancePolicy(ctx.sessionManager.getBranch(), null, null, INITIAL_SESSION_POLICY);
}

function sameCapabilityProject(left: CapabilityContext, right: CapabilityContext): boolean {
	if (left.projectRoot !== right.projectRoot || left.projectLedgerPath !== right.projectLedgerPath) return false;
	const stateDir = dirname(left.projectLedgerPath);
	return (
		right.ledgerPath === join(stateDir, "sessions", `${right.sessionId}.json`)
		&& right.legacyLedgerPath === join(stateDir, `${right.sessionId}.json`)
	);
}

function parseCommandWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of String(input ?? "").trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (escaped || quote) throw new Error("Unterminated quote or escape in /boundary command");
	if (current) words.push(current);
	return words;
}

function capabilityInput(params: any, options: { commandScopedSsh?: boolean } = {}) {
	if (params.action === "read") return { kind: "external-read", path: params.path };
	if (params.action === "ssh") {
		return {
			kind: "ssh-target",
			target: params.target,
			port: params.port,
			remoteCommand: params.remoteCommand,
			commandScoped: options.commandScopedSsh === true,
			timeoutSeconds: params.timeoutSeconds,
		};
	}
	if (params.action === "script") {
		return {
			kind: "project-script",
			path: params.path,
			args: params.args ?? [],
			timeoutSeconds: params.timeoutSeconds,
		};
	}
	if (params.action === "command") {
		return {
			kind: "host-command",
			grantId: params.grantId,
			argv: params.argv ?? [],
			cwd: params.cwd,
			timeoutSeconds: params.timeoutSeconds,
		};
	}
	throw new Error(`Unsupported host capability action: ${params.action}`);
}

function analysisCapabilityBlockReason(ctx: any, params: any): string | null {
	if (currentSessionPolicy(ctx) !== "analysis") return null;
	if (params.action === "list" || params.action === "read") return null;
	if (params.action === "ssh") {
		return analysisSshCommandPolicy(params.remoteCommand) === "denied"
			? "Analysis Session cannot request an SSH command that may expose credential material or has an invalid command shape. Use opaque SSH credentials without reading credential contents."
			: null;
	}
	return `Analysis Session cannot use host_capability action=${String(params.action)}. External exact-file reads and conservatively validated SSH inspection are allowed; host commands and scripts require promotion to the Leader Session.`;
}

function describeCapabilityRequest(request: any, operation?: any): string {
	if (request.kind === "external-read") {
		return `Read ${request.directory ? "directory" : "file"}: ${request.target}`;
	}
	if (request.kind === "ssh-target") {
		return [
			`Use local SSH credentials for: ${request.target}`,
			operation?.remoteCommand ? `Current remote command:\n${operation.remoteCommand}` : "This pre-grant authorizes commands to this target.",
			request.remoteCommand
				? "This request authorizes only the exact remote command shown above; it does not broaden trust for the SSH target."
				: "A project trust grant permits future commands to this target without repeated approval.",
		].join("\n");
	}
	if (request.kind === "host-command") {
		return [
			"Run a project command with host-user authority:",
			`cwd: ${request.cwd}`,
			`argv: ${request.argv.map((arg: string) => JSON.stringify(arg)).join(" ")}`,
			`Suggested persistent prefix: ${request.suggestedPrefix.map((arg: string) => JSON.stringify(arg)).join(" ")}`,
			"This command runs outside the project sandbox and can use your host account. Review the argv before approving.",
		].join("\n");
	}
	return [
		`Run project script outside the sandbox:`,
		request.target,
		`Args: ${(request.args ?? []).join(" ") || "(none)"}`,
		`SHA-256: ${request.sha256}`,
		`Preview (first 20 lines):\n${request.approvalPreview || "[empty]"}`,
	].join("\n");
}

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
	systemRuntime: SystemRuntimePolicy,
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
			Object.assign(childEnv, systemRuntime.environment);
			childEnv.TMPDIR = runtime.runtimeTmp;
			childEnv.TMP = runtime.runtimeTmp;
			childEnv.TEMP = runtime.runtimeTmp;
			childEnv.GIT_CONFIG_GLOBAL = "/dev/null";
			childEnv.GIT_CONFIG_NOSYSTEM = "1";
			childEnv.GIT_OPTIONAL_LOCKS = "0";
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
								"\n[Research Pi boundary] This command needs host authority. Do not hand the command back to the user by default: retry it through host_capability with an exact argv, or use an already trusted SSH target.\n",
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
	let capabilityContext: CapabilityContext | undefined;
	let systemRuntime: SystemRuntimePolicy | undefined;
	let gitIdentity: Awaited<ReturnType<typeof readGitIdentity>>;
	let initializationError: string | undefined;
	let userOverrideNoticeShown = false;
	let wslIsolation: Awaited<ReturnType<typeof verifyWslHostInteropBlocked>>;
	const baseBash = createBashTool(process.cwd());

	const refreshBoundaryStatus = async (ctx: any) => {
		if (!ctx.hasUI) return;
		const count = capabilityContext ? (await listCapabilityGrants(capabilityContext)).length : 0;
		const label = runtime ? `🔒 project${count ? ` · ${count} grant${count === 1 ? "" : "s"}` : ""}` : "🔒 boundary failed closed";
		ctx.ui.setStatus("boundary", ctx.ui.theme.fg(runtime ? "accent" : "error", label));
	};

	const requireCapabilityContext = () => {
		if (!capabilityContext) throw new Error("Host capability ledger is not initialized");
		return capabilityContext;
	};

	const requestInteractiveGrant = async (
		request: any,
		ctx: any,
		operation?: any,
		approvalContext: CapabilityContext = requireCapabilityContext(),
		announce = true,
		allowProjectScope = true,
	) => {
		if (!ctx.hasUI) return undefined;
		const wslOneShot = approvalContext.wslVersion !== undefined &&
			(request.kind === "host-command" || request.kind === "project-script");
		const projectTrustLabel = !allowProjectScope
			? undefined
			: request.kind === "ssh-target"
			? "Trust this SSH target for the project"
			: request.kind === "host-command" && !wslOneShot
				? "Trust the suggested command prefix for the project"
				: undefined;
		const choices = ["Approve once", wslOneShot ? undefined : "Approve this Pi session (24h)", projectTrustLabel, "Deny"].filter(Boolean) as string[];
		const footer = wslOneShot
			? "WSL host execution can reach Windows-mounted disks. This grant is one-shot; /mnt and Windows executables remain prohibited."
			: request.kind === "host-command"
			? "Host commands have your user authority. Project trust is stored outside the repository and can be revoked."
			: "SSH credentials remain opaque to the model.";
		const choice = await ctx.ui.select(
			`⚠️ Research Pi requests a host capability\n\n${describeCapabilityRequest(request, operation)}\n\n${footer}`,
			choices,
		);
		if (choice !== "Approve once" && choice !== "Approve this Pi session (24h)" && choice !== projectTrustLabel) return undefined;
		const grant = await createCapabilityGrant(
			approvalContext,
			request,
			choice === "Approve once" ? "once" : choice === "Approve this Pi session (24h)" ? "session" : "project",
		);
		if (announce) {
			ctx.ui.notify(`Approved ${capabilityGrantSummary(grant)}`, "warning");
			await refreshBoundaryStatus(ctx);
		}
		return grant;
	};

	registerHostCapabilityUiAdapter({
		review: async ({ pendingRequest, ctx }: { pendingRequest: any; ctx: any }) => {
			const capability = pendingRequest?.capability;
			if (pendingRequest?.kind !== "host_capability" || !capability?.input || !capability?.context) {
				return { status: "unsupported" as const };
			}
			if (!ctx.hasUI) return { status: "unavailable" as const };
			const activeContext = requireCapabilityContext();
			const sourceContext = capability.context as CapabilityContext;
			if (!sameCapabilityProject(activeContext, sourceContext)) {
				throw new Error("Codex host-capability request belongs to another project capability ledger");
			}
			const inspected = await inspectCapabilityAuthorization(sourceContext, capability.input);
			if (inspected.grant) {
				return { status: "approved" as const, grant: inspected.grant, existing: true };
			}
			const grant = await requestInteractiveGrant(inspected.request, ctx, capability.input, sourceContext, false);
			if (grant) await refreshBoundaryStatus(ctx).catch(() => undefined);
			return grant
				? { status: "approved" as const, grant, existing: false }
				: { status: "denied" as const };
		},
	});

	pi.registerTool({
		name: "host_capability",
		label: "Host Capability",
		description: [
			"Use a host capability when a justified project operation needs SSH credentials or host-user authority.",
			"read accesses an approved external file; ssh uses an approved exact target with opaque credentials; command runs an argv inside the project cwd with host authority; script is the legacy strict exact-script mode.",
			"In an Analysis Session, exact external reads and conservative SSH inspection are available; broader exact SSH commands can be requested from the user without promoting the Session.",
			"Project-trusted SSH targets and command prefixes run without repeated approval. Never use this tool to inspect private keys, tokens, or credential stores.",
			"Under WSL2, SSH target trust may persist, but host commands and project scripts require one-shot approval and cannot invoke Windows interop.",
		].join(" "),
		promptSnippet: "Use project-trusted SSH or host-command capabilities instead of handing executable commands back to the user",
		promptGuidelines: [
			"In a Leader Session, run arbitrary uv, Python, shell, Node, Git, and test commands normally inside the project sandbox. In an Analysis Session, use read tools or read-only SSH inspection instead.",
			"For Analysis Session SSH inspection, prefer the auto-approved read-only grammar. If a broader exact remote command is necessary, request it through this tool; the user sees and approves that exact command.",
			"When a justified command needs host SSH access or another host-user capability, call host_capability command with an exact argv. Reuse a listed grantId when possible; its approved cwd is then restored automatically.",
			"Direct SSH uses opaque credentials. Host-command has broader user authority and must match an approved exact command or project prefix; never request, read, print, copy, or transmit private keys or tokens.",
			"If a command grant reports a cwd mismatch, retry the same command action with that grantId. Do not switch to script or wrap it in a new shell command merely to obtain another grant.",
			"A missing capability is a user authorization boundary. Do not route around it with bash, symlinks, proxy commands, copied credentials, or another agent.",
			"Under WSL2, never access /mnt or launch Windows/PowerShell executables through host-command; those operations remain direct human authority.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("ssh"), Type.Literal("command"), Type.Literal("script")]),
			path: Type.Optional(Type.String({ description: "External path for read, or in-project executable path for script" })),
			target: Type.Optional(Type.String({ description: "Exact SSH alias or [user@]host[:port]" })),
			port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
			remoteCommand: Type.Optional(Type.String({ description: "Exact remote shell command for ssh" })),
			grantId: Type.Optional(Type.String({ description: "Exact existing grant-XXXXXXXX id; restores its approved cwd without broadening authority" })),
			argv: Type.Optional(Type.Array(Type.String(), { maxItems: 128, description: "Exact host command argv, for example [\"uv\",\"run\",\"remote_run.py\",\"bash\",\"experiment.sh\"]" })),
			cwd: Type.Optional(Type.String({ description: "Working directory inside the current project; defaults to the project root" })),
			args: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: "Legacy exact argv for project-script" })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const analysisBlock = analysisCapabilityBlockReason(ctx, params);
				if (analysisBlock) throw new Error(analysisBlock);
				const context = requireCapabilityContext();
				if (params.action === "list") {
					const grants = await listCapabilityGrants(context);
					return { content: [{ type: "text", text: grants.length ? grants.map(capabilityGrantSummary).join("\n") : "No active host capabilities." }] };
				}
				const analysisSshPolicy = currentSessionPolicy(ctx) === "analysis" && params.action === "ssh"
					? analysisSshCommandPolicy(params.remoteCommand)
					: null;
				const commandScopedSsh = analysisSshPolicy === "approval_required";
				const input = capabilityInput(params, { commandScopedSsh });
				const inspected = await inspectCapabilityAuthorization(context, input);
				const request = inspected.request;
				if (!inspected.grant) {
					const grant = await requestInteractiveGrant(request, ctx, input, context, true, !commandScopedSsh);
					if (!grant) throw new Error("Host capability was not approved by the user");
				}
				let outputTail = "";
				const result = await executeGrantedCapability(context, input, {
					signal,
					env: process.env,
					onData: (chunk: Buffer) => {
						outputTail = `${outputTail}${chunk.toString()}`.slice(-12000);
						onUpdate?.({ content: [{ type: "text", text: outputTail }] });
					},
				});
				const text = [
					`Capability ${result.grantId} executed (${result.kind}: ${result.target}).`,
					`Exit: ${result.exitCode}${result.timedOut ? " · timed out" : ""}${result.outputTruncated ? " · output truncated" : ""}`,
					result.stdout ? `stdout:\n${result.stdout}` : undefined,
					result.stderr ? `stderr:\n${result.stderr}` : undefined,
				].filter(Boolean).join("\n");
				await refreshBoundaryStatus(ctx);
				return { content: [{ type: "text", text }], isError: result.exitCode !== 0 };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
		},
	});

	pi.registerTool({
		...baseBash,
		label: "bash (project boundary)",
		promptSnippet: "Execute shell commands inside the current project boundary; public network is available",
		promptGuidelines: [
			"Agent-initiated shell commands may read minimal system runtime paths and may read/write the current project, including Git metadata; they cannot access other user directories or write system temp paths.",
			"Public network access is available without a domain allowlist. Arbitrary project-local uv, Python, shell, Node, Git, and test commands are allowed; command syntax is not a policy boundary.",
			"Unix sockets and host credential files remain outside the project sandbox. If a justified operation needs them, use host_capability command or a project-trusted SSH target instead of asking the user to copy a terminal command.",
			"Under WSL2, Windows host mounts and Windows executable interop remain outside the agent boundary. Do not invoke powershell.exe, cmd.exe, wsl.exe, or paths below /mnt; Windows-native operations remain a direct human action, while Linux host commands for SSH-backed work require one-shot approval.",
			"Do not attempt an indirect boundary bypass. Request the exact brokered target or argv and continue after approval; use ! only if the broker cannot express the operation.",
		],
		async execute(id, params, signal, onUpdate, ctx) {
			if (currentSessionPolicy(ctx) === "analysis") {
				return {
					content: [{ type: "text", text: "Analysis Session cannot use project bash because an arbitrary command could modify code or start work. Use read/grep/find/ls, approved external reads, or host_capability ssh with a read-only inspection command." }],
					isError: true,
				};
			}
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
				operations: createProjectBashOperations(runtime, gitIdentity, systemRuntime ?? await resolveSystemRuntimePolicy()),
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
		const readLike = event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls";
		if (!info.inside && readLike) {
			if (isForbiddenCredentialRead(info.lexicalPath) || isForbiddenCredentialRead(info.resolvedPath)) {
				return {
					block: true,
					reason: "Credential material cannot be made model-readable. Use an opaque SSH capability or an approved host command without reading the credential contents.",
					terminate: false,
				};
			}
			try {
				const request = await prepareCapabilityRequest(requireCapabilityContext(), { kind: "external-read", path: requestedPath });
				if (event.toolName === "grep" && request.directory) {
					return { block: true, reason: "Recursive grep cannot use an external directory grant; approve and read exact files instead.", terminate: false };
				}
				let grant = await findCapabilityGrant(requireCapabilityContext(), request);
				if (!grant) grant = await requestInteractiveGrant(request, ctx);
				if (!grant) return { block: true, reason: "External read was not approved by the user.", terminate: false };
				const authorized = await authorizeCapabilityRequest(requireCapabilityContext(), { kind: "external-read", path: requestedPath });
				if (!authorized.grant) return { block: true, reason: "External-read grant disappeared before use.", terminate: false };
				ctx.ui.notify(`Using ${authorized.grant.id} for ${info.resolvedPath}`, "warning");
				await refreshBoundaryStatus(ctx);
				return undefined;
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error), terminate: false };
			}
		}

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
			systemRuntime = await resolveSystemRuntimePolicy();
			capabilityContext = await resolveCapabilityContext(runtime.root, ctx.sessionManager.getSessionId());
			gitIdentity = await readGitIdentity(runtime.root);
			await SandboxManager.initialize(
				buildSandboxRuntimeConfig(runtime.root, process.env, systemRuntime),
				async () => true,
				process.platform === "darwin",
			);
			wslIsolation = await verifyWslHostInteropBlocked(runtime, gitIdentity);
			initializationError = undefined;
			await refreshBoundaryStatus(ctx);
		} catch (error) {
			await SandboxManager.reset().catch(() => undefined);
			runtime = undefined;
			systemRuntime = undefined;
			wslIsolation = undefined;
			capabilityContext = undefined;
			initializationError = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("boundary", ctx.ui.theme.fg("error", "🔒 boundary failed closed"));
			ctx.ui.notify(`Research Pi project boundary failed to initialize: ${initializationError}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await SandboxManager.reset().catch(() => undefined);
		runtime = undefined;
		capabilityContext = undefined;
		systemRuntime = undefined;
		wslIsolation = undefined;
	});

	pi.registerCommand("boundary", {
		description: "Show the active Research Pi project security boundary",
		handler: async (args, ctx) => {
			const words = parseCommandWords(args ?? "");
			const action = words.shift();
			if (action === "doctor") {
				if (!runtime || !systemRuntime) {
					ctx.ui.notify(`Boundary unavailable: ${initializationError ?? "not initialized"}`, "error");
					return;
				}
				ctx.ui.setWorkingMessage("Validating Pi and Codex permission boundaries...");
				try {
					let piOutput = "";
					const piProbe = await createProjectBashOperations(runtime, gitIdentity, systemRuntime).exec(
						"set -e\ngit --version >/dev/null\ngit status --porcelain=v1 --untracked-files=no >/dev/null\nif command -v python3 >/dev/null 2>&1; then python3 --version >/dev/null; fi\nprintf 'research-pi-shell-preflight=ok\\n'",
						runtime.root,
						{
							onData: (chunk) => {
								piOutput = `${piOutput}${chunk.toString()}`.slice(-8000);
							},
							timeout: 20,
							env: process.env,
						},
					);
					if (piProbe.exitCode !== 0) throw new Error(`Pi shell preflight exited ${piProbe.exitCode}: ${piOutput}`);
					const [advisorProbe, executorProbe] = await Promise.all([
						runCodexSandboxPreflight({
							codexBin: process.env.PI_CODEX_BIN ?? "codex",
							mode: "advisor",
							cwd: runtime.root,
							gitIdentity,
							runtimePolicy: systemRuntime,
						}),
						runCodexSandboxPreflight({
							codexBin: process.env.PI_CODEX_BIN ?? "codex",
							mode: "executor",
							cwd: runtime.root,
							runtimeTmp: runtime.runtimeTmp,
							gitIdentity,
							runtimePolicy: systemRuntime,
						}),
					]);
					ctx.ui.notify(
						[
							"Research Pi boundary doctor passed.",
							"Pi shell: project/Git/runtime OK.",
							`Codex advisor: ${advisorProbe.stdout || "project/Git/runtime OK"}.`,
							`Codex executor: ${executorProbe.stdout || "project/Git/runtime OK"}.`,
							...systemRuntime.diagnostics,
						].join("\n"),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} finally {
					ctx.ui.setWorkingMessage();
				}
				return;
			}
			if (action === "grants") {
				const grants = await listCapabilityGrants(requireCapabilityContext());
				ctx.ui.notify(grants.length ? grants.map(capabilityGrantSummary).join("\n") : "No active host capabilities.", "info");
				return;
			}
			if (action === "revoke") {
				const selector = words[0];
				if (!selector) {
					ctx.ui.notify("Usage: /boundary revoke <grant-id|all>", "warning");
					return;
				}
				const removed = await revokeCapabilityGrant(requireCapabilityContext(), selector);
				ctx.ui.notify(`Revoked ${removed} host capability grant(s).`, removed ? "warning" : "info");
				await refreshBoundaryStatus(ctx);
				return;
			}
			if (["grant-read", "grant-ssh", "trust-ssh", "grant-script", "grant-command", "trust-command"].includes(action ?? "")) {
				const validArguments =
					(action === "grant-read" && words.length === 1) ||
					((action === "grant-ssh" || action === "trust-ssh") && words.length === 1) ||
					(action === "grant-script" && words.length >= 1) ||
					((action === "grant-command" || action === "trust-command") && words.length >= 1);
				if (!validArguments) {
					const usage = action === "grant-read"
						? "/boundary grant-read <external-path>"
						: action === "grant-ssh" || action === "trust-ssh"
							? `/boundary ${action} <alias|user@host[:port]>`
							: action === "grant-command" || action === "trust-command"
								? `/boundary ${action} <executable> [argv-prefix...]`
								: "/boundary grant-script <project-script> [exact args...]";
					ctx.ui.notify(`Usage: ${usage}`, "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("Host grants require interactive confirmation.", "error");
					return;
				}
				if (action === "trust-command" && capabilityContext?.wslVersion !== undefined) {
					ctx.ui.notify(
						"WSL does not persist host-command trust because an out-of-sandbox project process could reach Windows disks. Use /boundary grant-command for one-shot approval, or trust an opaque SSH target.",
						"error",
					);
					return;
				}
				const input = action === "grant-read"
					? { kind: "external-read", path: words[0] }
					: action === "grant-ssh" || action === "trust-ssh"
						? { kind: "ssh-target", target: words[0] }
						: action === "grant-command" || action === "trust-command"
							? { kind: "host-command", argv: words, cwd: ctx.cwd }
							: { kind: "project-script", path: words[0], args: words.slice(1) };
				const request = await prepareCapabilityRequest(requireCapabilityContext(), input);
				const projectScope = action === "trust-ssh" || action === "trust-command";
				if (action === "trust-command" && request.kind === "host-command") {
					// An explicit user command defines the persistent prefix verbatim. Automatic
					// model requests still receive the conservative recommended prefix.
					request.suggestedPrefix = [...request.argv];
				}
				const wslOneShot = capabilityContext?.wslVersion !== undefined &&
					(request.kind === "host-command" || request.kind === "project-script");
				const approved = await ctx.ui.confirm(
					wslOneShot
						? "Approve this one WSL host execution?"
						: projectScope
							? "Trust this host capability for the project?"
							: "Approve host capability for this Pi session?",
					describeCapabilityRequest(request),
				);
				if (!approved) {
					ctx.ui.notify("Host capability not approved.", "info");
					return;
				}
				const grant = await createCapabilityGrant(
					requireCapabilityContext(),
					request,
					wslOneShot ? "once" : projectScope ? "project" : "session",
				);
				ctx.ui.notify(`Approved ${capabilityGrantSummary(grant)}`, "warning");
				await refreshBoundaryStatus(ctx);
				return;
			}
			if (action === "help") {
				ctx.ui.notify([
					"/boundary — show policy and active grant count",
					"/boundary doctor — validate Pi/Codex Git and runtime permissions without a model call",
						"/boundary grants — list active project and session grants",
					"/boundary grant-read <external-path>",
					"/boundary grant-ssh <alias|user@host[:port]> — current session",
					"/boundary trust-ssh <alias|user@host[:port]> — persistent for this project",
					`/boundary grant-command <executable> [exact argv...] — ${capabilityContext?.wslVersion !== undefined ? "one-shot on WSL" : "current session"}`,
					`/boundary trust-command <executable> [argv-prefix...] — ${capabilityContext?.wslVersion !== undefined ? "disabled on WSL" : "persistent for this project"}`,
					`/boundary grant-script <project-script> [exact args...] — ${capabilityContext?.wslVersion !== undefined ? "one-shot on WSL" : "current session"}`,
					"/boundary revoke <grant-id|all>",
				].join("\n"), "info");
				return;
			}
			if (action) {
				ctx.ui.notify(`Unknown /boundary action: ${action}. Use /boundary help.`, "warning");
				return;
			}
			const lines = runtime
				? [
						"Research Pi project boundary is active.",
						`Project root: ${runtime.root}`,
						"Agent shell: project read/write; .git commit/config/refs writable; .git/hooks read-only.",
						`System runtime: ${(systemRuntime?.readRoots ?? []).join(", ") || "platform minimal runtime"} (read-only).`,
						wslIsolation
							? "Network: public web is open; project-trusted SSH targets run without repeated approval; host commands are one-shot."
							: "Network: public web is open; project-trusted SSH targets and command prefixes run without repeated approval.",
						wslIsolation
							? `WSL${wslIsolation.version}: /mnt denied; seccomp required; cmd.exe host-interop probe blocked (exit ${wslIsolation.probeExitCode}).`
							: undefined,
						`Host grants: ${capabilityContext ? (await listCapabilityGrants(capabilityContext)).length : 0} active across project/session scopes.`,
						wslIsolation
							? "Commands: arbitrary uv/Python/shell syntax is allowed inside the project sandbox; WSL host commands require one-shot user approval."
							: "Commands: arbitrary uv/Python/shell syntax is allowed inside the project sandbox; approved host commands may use user authority.",
						wslIsolation
							? "Outside path and /mnt access still require explicit approval; credential contents remain protected."
							: "Outside path: direct reads still require approval; credential contents remain protected.",
						"Use /boundary help for grant and revoke commands.",
					].filter(Boolean)
				: [`Boundary unavailable (failed closed): ${initializationError ?? "not initialized"}`];
			ctx.ui.notify(lines.join("\n"), runtime ? "info" : "error");
		},
	});
}
