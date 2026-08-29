import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
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
	isProtectedProjectMutation,
	likelySandboxDenial,
	prepareBoundaryRuntime,
	readGitIdentity,
	researchPiFullAccessEnabled,
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
								"\n[Research Pi boundary] This command needs host authority. Do not hand the command back to the user by default: retry it through host_capability command with an exact argv, or use an already trusted SSH target/command prefix.\n",
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
	let sandboxAccess: "read" | "write" | "full" | undefined;
	let sandboxUpdate = Promise.resolve();
	const inheritedSandboxTmp = process.env.CLAUDE_CODE_TMPDIR;
	const baseBash = createBashTool(process.cwd());
	const launchFullAccess = researchPiFullAccessEnabled();
	const leaderHasFullAccess = (ctx: any) => launchFullAccess && currentSessionPolicy(ctx) !== "analysis";

	const ensureProjectSandbox = async (ctx: any) => {
		if (!runtime || !systemRuntime) throw new Error(initializationError ?? "Project boundary is not initialized");
		if (leaderHasFullAccess(ctx)) {
			if (sandboxAccess === "full") return;
			const update = sandboxUpdate.catch(() => undefined).then(async () => {
				if (sandboxAccess === "full") return;
				await SandboxManager.reset();
				sandboxAccess = "full";
			});
			sandboxUpdate = update;
			await update;
			return;
		}
		const access = currentSessionPolicy(ctx) === "analysis" ? "read" : "write";
		if (sandboxAccess === access) return;
		const update = sandboxUpdate.catch(() => undefined).then(async () => {
			if (sandboxAccess === access) return;
			// A write-to-read transition must fail closed if the previous sandbox
			// grants cannot be revoked, especially on Windows where ACLs persist.
			await SandboxManager.reset();
			await SandboxManager.initialize(
				buildSandboxRuntimeConfig(runtime!.root, process.env, systemRuntime, {
					access,
					runtimeTmp: runtime!.runtimeTmp,
				}),
				async () => true,
				process.platform === "darwin",
			);
			sandboxAccess = access;
		});
		sandboxUpdate = update;
		await update;
	};

	const refreshBoundaryStatus = async (ctx: any) => {
		if (!ctx.hasUI) return;
		const count = capabilityContext ? (await listCapabilityGrants(capabilityContext)).length : 0;
		const label = runtime
			? leaderHasFullAccess(ctx)
				? "🔓 full access"
				: `🔒 project${count ? ` · ${count} grant${count === 1 ? "" : "s"}` : ""}`
			: "🔒 boundary failed closed";
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
		const projectTrustLabel = !allowProjectScope
			? undefined
			: request.kind === "ssh-target"
			? "Trust this SSH target for the project"
			: request.kind === "host-command"
				? "Trust the suggested command prefix for the project"
				: undefined;
		const choices = ["Approve once", "Approve this Pi session (24h)", projectTrustLabel, "Deny"].filter(Boolean) as string[];
		const footer = request.kind === "host-command"
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
			"In an Analysis Session, project-local shell runs in an OS-enforced read-only profile; exact external reads and conservative SSH inspection are available, while broader exact SSH commands can be requested from the user without promoting the Session.",
			"Project-trusted SSH targets and command prefixes run without repeated approval. Never use this tool to inspect private keys, tokens, or credential stores.",
		].join(" "),
		promptSnippet: "Use project-trusted SSH or host-command capabilities instead of handing executable commands back to the user",
		promptGuidelines: [
			"Leader project bash is writable. Analysis project bash is OS-enforced read-only; a broader exact Analysis SSH command requires user approval through this tool.",
			"For justified host authority, send the exact target or argv. Reuse a listed grantId so its approved cwd is restored; on cwd mismatch retry the same capability rather than switching kind or adding a shell wrapper.",
			"SSH credentials remain opaque. Host commands must match approved authority; never request, read, print, copy, or transmit private keys, tokens, or credential stores.",
			"A missing capability is a user authorization boundary. Do not route around it with bash, symlinks, proxy commands, copied credentials, or another agent.",
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
		label: launchFullAccess ? "bash (full access for Leader)" : "bash (project boundary)",
		promptSnippet: launchFullAccess
			? "Execute host commands with explicit full access in the Leader Session; Analysis remains project-read-only"
			: "Execute shell commands inside the current project boundary with role-scoped write and network authority",
		promptGuidelines: launchFullAccess
			? [
					"This Leader Session has explicit host-user filesystem, command, network, and Unix-socket access. Keep operations within the user's task, protect credentials, and verify exact destructive targets.",
					"Analysis Sessions still use an OS-enforced read-only project profile with no local shell network; full access does not widen the Analysis role.",
				]
			: [
					"Leader shell may read/write the current project, including Git metadata. Analysis shell uses an OS-enforced read-only project profile with only project-local runtime temp writable. Neither role can access other user directories or write system temp paths.",
					"Leader project shell has public network access. Analysis local shell has no network; use web_search for public evidence and host_capability for approved SSH inspection. Command syntax is not a policy boundary.",
					"Unix sockets and host credential files remain outside the project sandbox. If a justified operation needs them, use host_capability command or a project-trusted SSH target instead of asking the user to copy a terminal command.",
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
			try {
				await ensureProjectSandbox(ctx);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Research Pi project sandbox failed closed: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
				};
			}
			if (leaderHasFullAccess(ctx)) return await baseBash.execute(id, params, signal, onUpdate);
			const sandboxed = createBashTool(ctx.cwd, {
				operations: createProjectBashOperations(runtime, gitIdentity, systemRuntime ?? await resolveSystemRuntimePolicy()),
				exposeSessionEnvironment: false,
			});
			return await sandboxed.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (leaderHasFullAccess(ctx)) return undefined;
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
			// sandbox-runtime bakes TMPDIR into its wrapped command from this
			// harness variable, so set it before initialization and wrapping.
			process.env.CLAUDE_CODE_TMPDIR = runtime.runtimeTmp;
			systemRuntime = await resolveSystemRuntimePolicy();
			capabilityContext = await resolveCapabilityContext(runtime.root, ctx.sessionManager.getSessionId());
			gitIdentity = await readGitIdentity(runtime.root);
			await ensureProjectSandbox(ctx);
			initializationError = undefined;
			await refreshBoundaryStatus(ctx);
		} catch (error) {
			runtime = undefined;
			systemRuntime = undefined;
			initializationError = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("boundary", ctx.ui.theme.fg("error", "🔒 boundary failed closed"));
			ctx.ui.notify(`Research Pi project boundary failed to initialize: ${initializationError}`, "error");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!leaderHasFullAccess(ctx)) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<research_pi_full_access>\nThe user explicitly launched Research Pi with full access. The project remains the task scope, but it is not an OS filesystem or command sandbox for this Leader Session. You may use host files, commands, network, Unix sockets, credentials, and external paths when they are genuinely required by the user's task, without requesting a Research Pi boundary grant. Do not broaden the task, expose secrets, or skip exact-target checks for destructive operations. Analysis Sessions and Codex advisor Actors remain read-only.\n</research_pi_full_access>`,
		};
	});

	pi.on("session_shutdown", async () => {
		await sandboxUpdate.catch(() => undefined);
		await SandboxManager.reset().catch(() => undefined);
		sandboxAccess = undefined;
		if (inheritedSandboxTmp === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
		else process.env.CLAUDE_CODE_TMPDIR = inheritedSandboxTmp;
		runtime = undefined;
		capabilityContext = undefined;
		systemRuntime = undefined;
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
							fullAccess: leaderHasFullAccess(ctx),
						}),
					]);
					ctx.ui.notify(
						[
							"Research Pi boundary doctor passed.",
							leaderHasFullAccess(ctx) ? "Pi shell: explicit full host access active." : "Pi shell: project/Git/runtime OK.",
							`Codex advisor: ${advisorProbe.codexVersion || "version unknown"} · ${advisorProbe.codexBin} · project/Git/runtime OK.`,
							`Codex executor: ${executorProbe.codexVersion || "version unknown"} · ${executorProbe.codexBin} · ${leaderHasFullAccess(ctx) ? "full host access/runtime OK" : "project/Git/runtime OK"}.`,
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
				const approved = await ctx.ui.confirm(
					projectScope ? "Trust this host capability for the project?" : "Approve host capability for this Pi session?",
					describeCapabilityRequest(request),
				);
				if (!approved) {
					ctx.ui.notify("Host capability not approved.", "info");
					return;
				}
				const grant = await createCapabilityGrant(requireCapabilityContext(), request, projectScope ? "project" : "session");
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
					"/boundary grant-command <executable> [exact argv...] — current session",
					"/boundary trust-command <executable> [argv-prefix...] — persistent for this project",
					"/boundary grant-script <project-script> [exact args...]",
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
						leaderHasFullAccess(ctx) ? "Research Pi full access is active for this Leader Session." : "Research Pi project boundary is active.",
						`Project root: ${runtime.root}`,
						currentSessionPolicy(ctx) === "analysis"
							? "Agent shell: Analysis project read-only; project-local runtime temp writable; host authority remains brokered."
							: leaderHasFullAccess(ctx)
								? "Agent shell: unsandboxed host-user authority; project boundary grants are bypassed for this launch."
								: "Agent shell: project read/write; .git commit/config/refs writable; .git/hooks read-only.",
						leaderHasFullAccess(ctx)
							? "System runtime: host-visible under the user's account."
							: `System runtime: ${(systemRuntime?.readRoots ?? []).join(", ") || "platform minimal runtime"} (read-only).`,
						leaderHasFullAccess(ctx)
							? "Network: host network and Unix sockets are available without boundary grants."
							: "Network: public web is open; project-trusted SSH targets and command prefixes run without repeated approval.",
						`Host grants: ${capabilityContext ? (await listCapabilityGrants(capabilityContext)).length : 0} active across project/session scopes.`,
						leaderHasFullAccess(ctx)
							? "Commands: run directly with host-user authority; existing grants are not required for this Leader launch."
							: "Commands: arbitrary uv/Python/shell syntax is allowed inside the project sandbox; approved host commands may use user authority.",
						leaderHasFullAccess(ctx)
							? "Outside path: no boundary prompt; host files and credentials may be readable, so never expose secrets."
							: "Outside path: direct reads still require approval; credential contents remain protected.",
						"Use /boundary help for grant and revoke commands.",
					]
				: [`Boundary unavailable (failed closed): ${initializationError ?? "not initialized"}`];
			ctx.ui.notify(lines.join("\n"), runtime ? "info" : "error");
		},
	});
}
