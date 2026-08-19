import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { executeGrantedCapability } from "./host-capabilities.mjs";
import { compactCodexAuditEvent, describeCodexNotification } from "./codex-activity.mjs";
import { configureCodexSqliteLogs } from "./codex-sqlite-logs.mjs";
import {
	getGitSnapshot,
	readJson,
	releaseWriterLock,
	sanitizeCodexEnvironment,
	updateJobFile,
	writeJsonAtomic,
} from "./codex-jobs.mjs";
import { codexPermissionConfigArguments, runCodexSandboxPreflight } from "./project-boundary.mjs";
import { resolveSystemRuntimePolicy } from "./security-policy.mjs";

function now() {
	return new Date().toISOString();
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArguments(argv) {
	const index = argv.indexOf("--job-dir");
	if (index < 0 || !argv[index + 1]) throw new Error("Usage: codex-job-worker.mjs --job-dir <path>");
	return argv[index + 1];
}

function truncate(text, max = 12000) {
	if (!text) return "";
	return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

function parseStructuredResult(text, error) {
	const fallback = {
		status: error ? "blocked" : "inconclusive",
		goal_satisfied: false,
		summary: truncate(text || error || "Codex returned no structured final message."),
		evidence: [],
		actions_taken: [],
		changed_files: [],
		checks: [],
		external_effects: [],
		uncertainties: [error || "The final response did not parse as the required JSON schema."],
		recommended_next_step: "Research Pi should inspect the job log and decide whether to steer, resume, or rerun the delegation.",
	};
	if (!text) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
		if (!fenced) return fallback;
		try {
			return JSON.parse(fenced);
		} catch {
			return fallback;
		}
	}
}

function requestId(jobId, rpcId, method) {
	const suffix = createHash("sha256").update(`${rpcId}:${method}`).digest("hex").slice(0, 12);
	return `request-${jobId.slice(-8)}-${suffix}`;
}

function publicPendingRequest(record) {
	return {
		id: record.id,
		kind: record.kind,
		audience: record.audience,
		question: record.question,
		whyBlocking: record.whyBlocking,
		options: record.options,
		questions: record.questions,
		secret: record.secret,
		createdAt: record.createdAt,
	};
}

async function main() {
	const jobDir = parseArguments(process.argv.slice(2));
	const request = await readJson(join(jobDir, "request.json"));
	const outputSchema = await readJson(request.schemaPath);
	const eventsStream = createWriteStream(join(jobDir, "events.jsonl"), { flags: "a", mode: 0o600 });
	const stderrStream = createWriteStream(join(jobDir, "stderr.log"), { flags: "a", mode: 0o600 });
	const rawEventTrace = process.env.PI_CODEX_TRACE === "1";
	const maxEventLogBytes = rawEventTrace ? 32 * 1024 * 1024 : 2 * 1024 * 1024;
	const maxStderrLogBytes = 2 * 1024 * 1024;
	let eventLogBytes = 0;
	let stderrLogBytes = 0;
	let eventLogCapped = false;
	let stderrLogCapped = false;
	let child;
	let stdoutBuffer = "";
	let stderrTail = "";
	let lastAgentText = "";
	let lastError = "";
	let threadId = request.continuationThreadId ?? null;
	let activeTurnId = null;
	const ownedThreadIds = new Set(threadId ? [threadId] : []);
	const activeTurnsByThread = new Map();
	let cancellationRequested = false;
	let timedOut = false;
	let timeout;
	let commandTimer;
	let notificationUpdateTimer;
	let pendingNotificationUpdate = null;
	let lastNotificationProgress = null;
	let rpcSequence = 1;
	let updateQueue = Promise.resolve();
	let resolveTurn;
	let rejectTurn;
	const pendingRpc = new Map();
	const pendingHumanResponses = new Map();
	const handledCommands = new Set();
	const hostCapabilityAbort = new AbortController();
	const workerIo = {
		appServerMessagesSeen: 0,
		deltaNotificationsSeen: 0,
		auditRecordsWritten: 0,
		progressUpdatesPersisted: 0,
		foreignMessagesIgnored: 0,
		// startCodexJob created job.json once before this worker started.
		jobStateWrites: 1,
	};
	const turnDone = new Promise((resolve, reject) => {
		resolveTurn = resolve;
		rejectTurn = reject;
	});
	// A process can fail during initialization before main() reaches the turn await.
	// Keep the deferred rejection observed until the normal control flow awaits it.
	void turnDone.catch(() => undefined);

	const messageIdentity = (message) => {
		const params = message?.params ?? {};
		return {
			thread: params.threadId ?? params.thread?.id ?? null,
			turn: params.turnId ?? params.turn?.id ?? null,
		};
	};

	const registerRootThread = (id) => {
		if (!id) return;
		threadId = id;
		ownedThreadIds.add(id);
	};

	const registerRootTurn = (id) => {
		if (!id || !threadId) return;
		activeTurnId = id;
		activeTurnsByThread.set(threadId, id);
	};

	const isOwnedServerRequest = (message) => {
		const identity = messageIdentity(message);
		if (!identity.thread || !ownedThreadIds.has(identity.thread) || !identity.turn) return false;
		if (identity.thread === threadId) return identity.turn === activeTurnId;
		const expectedTurn = activeTurnsByThread.get(identity.thread);
		return expectedTurn ? identity.turn === expectedTurn : true;
	};

	const writeJobUpdate = async (update) => {
		const nextWriteCount = workerIo.jobStateWrites + 1;
		const result = await updateJobFile(jobDir, async (current) => {
			const next = typeof update === "function" ? await update(current) : { ...current, ...update };
			return { ...next, workerIo: { ...workerIo, jobStateWrites: nextWriteCount } };
		});
		workerIo.jobStateWrites = nextWriteCount;
		return result;
	};

	const enqueueJobUpdate = (update) => {
		updateQueue = updateQueue
			.then(() => writeJobUpdate((current) => ({ ...current, ...update, lastActivityAt: now() })))
			.catch(async (error) => {
				await appendFile(join(jobDir, "worker-errors.log"), `${now()} ${error?.stack ?? error}\n`, { mode: 0o600 });
			});
		return updateQueue;
	};

	const writeBounded = (stream, value, kind) => {
		const bytes = Buffer.byteLength(value);
		const limit = kind === "event" ? maxEventLogBytes : maxStderrLogBytes;
		const used = kind === "event" ? eventLogBytes : stderrLogBytes;
		if (used >= limit) {
			if (kind === "event") eventLogCapped = true;
			else stderrLogCapped = true;
			return false;
		}
		const remaining = limit - used;
		if (kind === "event" && bytes > remaining) {
			// Never leave a truncated JSON record at the end of events.jsonl.
			eventLogCapped = true;
			return false;
		}
		const chunk = bytes <= remaining ? value : Buffer.from(value).subarray(0, remaining);
		stream.write(chunk);
		if (kind === "event") {
			eventLogBytes += Math.min(bytes, remaining);
			eventLogCapped ||= bytes > remaining;
		} else {
			stderrLogBytes += Math.min(bytes, remaining);
			stderrLogCapped ||= bytes > remaining;
		}
		return true;
	};

	const writeAuditEvent = (message) => {
		const record = rawEventTrace ? message : compactCodexAuditEvent(message);
		if (!record) return;
		if (writeBounded(eventsStream, `${JSON.stringify(record)}\n`, "event")) workerIo.auditRecordsWritten += 1;
	};

	const cancelNotificationUpdate = () => {
		if (notificationUpdateTimer) clearTimeout(notificationUpdateTimer);
		notificationUpdateTimer = undefined;
		pendingNotificationUpdate = null;
	};

	const flushNotificationUpdate = () => {
		if (notificationUpdateTimer) clearTimeout(notificationUpdateTimer);
		notificationUpdateTimer = undefined;
		const update = pendingNotificationUpdate;
		pendingNotificationUpdate = null;
		if (!update) return updateQueue;
		workerIo.progressUpdatesPersisted += 1;
		return enqueueJobUpdate(update);
	};

	const queueNotificationUpdate = (update) => {
		pendingNotificationUpdate = { ...(pendingNotificationUpdate ?? {}), ...update };
		if (!notificationUpdateTimer) {
			notificationUpdateTimer = setTimeout(() => void flushNotificationUpdate(), 400);
		}
	};

	const send = (message) => {
		if (!child?.stdin?.writable) throw new Error("Codex app-server stdin is not writable");
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	const rpcRequest = (method, params, timeoutMs = 60_000) => {
		const id = rpcSequence++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRpc.delete(id);
				reject(new Error(`Codex app-server request timed out: ${method}`));
			}, timeoutMs);
			pendingRpc.set(id, { method, resolve, reject, timer });
			try {
				send({ id, method, params });
			} catch (error) {
				clearTimeout(timer);
				pendingRpc.delete(id);
				reject(error);
			}
		});
	};

	const settleHumanRequest = async (record, response) => {
		await writeJsonAtomic(join(jobDir, "requests", `${record.id}.json`), {
			...record,
			status: "resolved",
			resolvedAt: now(),
			responseLength: response.response?.length ?? JSON.stringify(response.answers ?? {}).length,
			responseSha256: createHash("sha256").update(response.response || JSON.stringify(response.answers ?? {})).digest("hex"),
		});
		await enqueueJobUpdate({ status: "running", pendingRequest: null, progress: "Codex received Research Pi response" });
	};

	const waitForHumanResponse = async (record) => {
		cancelNotificationUpdate();
		await writeJsonAtomic(join(jobDir, "requests", `${record.id}.json`), record);
		await enqueueJobUpdate({
			status: "input_required",
			pendingRequest: publicPendingRequest(record),
			progress: record.secret ? "waiting for direct user secret setup" : "waiting for Research Pi response",
		});
		return await new Promise((resolve) => pendingHumanResponses.set(record.id, { resolve, record }));
	};

	const handleServerRequest = async (message) => {
		const method = message.method;
		const params = message.params ?? {};
		const id = requestId(request.jobId, message.id, method);
		try {
			if (method === "item/tool/call" && params.tool === "research_pi_host") {
				if (!request.hostCapabilityContext) throw new Error("This Codex job has no Pi session capability ledger");
				const args = params.arguments ?? {};
				if (request.mode === "advisor" && args.action !== "read") {
					throw new Error("Advisor mode may use only external-read host capabilities");
				}
				const input = args.action === "read"
					? { kind: "external-read", path: args.path }
					: args.action === "ssh"
						? {
							kind: "ssh-target",
							target: args.target,
							port: args.port,
							remoteCommand: args.remoteCommand,
							timeoutSeconds: args.timeoutSeconds,
						}
						: args.action === "command"
							? {
								kind: "host-command",
								argv: args.argv ?? [],
								cwd: args.cwd,
								timeoutSeconds: args.timeoutSeconds,
							}
							: {
							kind: "project-script",
							path: args.path,
							args: args.args ?? [],
							timeoutSeconds: args.timeoutSeconds,
						};
				await enqueueJobUpdate({ progress: `host capability ${args.action ?? "unknown"} running` });
				const result = await executeGrantedCapability(request.hostCapabilityContext, input, {
					signal: hostCapabilityAbort.signal,
					env: process.env,
				});
				await enqueueJobUpdate({ progress: `host capability ${args.action} finished with exit ${result.exitCode}` });
				const content = truncate([
					`Grant ${result.grantId} executed (${result.kind}: ${result.target}).`,
					`Exit: ${result.exitCode}${result.timedOut ? " · timed out" : ""}${result.outputTruncated ? " · output truncated" : ""}`,
					result.stdout ? `stdout:\n${result.stdout}` : undefined,
					result.stderr ? `stderr:\n${result.stderr}` : undefined,
				].filter(Boolean).join("\n"), 64000);
				send({
					id: message.id,
					result: { success: result.exitCode === 0, contentItems: [{ type: "inputText", text: content }] },
				});
				return;
			}
			if (method === "item/tool/call" && params.tool === "consult_research_pi") {
				const args = params.arguments ?? {};
				const record = {
					version: 1,
					id,
					jobId: request.jobId,
					threadId: params.threadId ?? threadId,
					turnId: params.turnId ?? activeTurnId,
					kind: "leader_consultation",
					audience: args.audience === "user" ? "user" : "leader",
					question: truncate(String(args.question ?? "Codex needs guidance."), 4000),
					whyBlocking: truncate(String(args.why_blocking ?? ""), 4000),
					options: Array.isArray(args.options) ? args.options.slice(0, 8).map(String) : [],
					secret: false,
					status: "pending",
					createdAt: now(),
				};
				const response = await waitForHumanResponse(record);
				await settleHumanRequest(record, response);
				send({
					id: message.id,
					result: { success: true, contentItems: [{ type: "inputText", text: response.response || JSON.stringify(response.answers) }] },
				});
				return;
			}
			if (method === "item/tool/requestUserInput") {
				const questions = Array.isArray(params.questions) ? params.questions : [];
				const record = {
					version: 1,
					id,
					jobId: request.jobId,
					threadId: params.threadId ?? threadId,
					turnId: params.turnId ?? activeTurnId,
					kind: "user_input",
					audience: questions.some((question) => question.isSecret) ? "user" : "leader",
					question: questions.map((question) => question.question).join("\n"),
					questions,
					secret: questions.some((question) => question.isSecret),
					status: "pending",
					createdAt: now(),
				};
				const response = await waitForHumanResponse(record);
				const answers = response.answers ?? Object.fromEntries(questions.map((question) => [question.id, [response.response]]));
				await settleHumanRequest(record, response);
				send({
					id: message.id,
					result: { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: value }])) },
				});
				return;
			}
			// The thread runs with approvalPolicy=never and a project-bound permission profile.
			// Unexpected approval/elicitation requests are denied instead of hanging invisibly.
			send({ id: message.id, result: { decision: "decline", action: "decline", content: null } });
			await appendFile(join(jobDir, "worker-errors.log"), `${now()} denied unsupported server request ${method}\n`, { mode: 0o600 });
		} catch (error) {
			lastError = truncate(error?.stack ?? String(error), 4000);
			try {
				send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
			} catch {
				// The app-server may have closed while the human request was pending.
			}
		}
	};

	const handleMessage = (message) => {
		workerIo.appServerMessagesSeen += 1;
		if (message?.method === "item/agentMessage/delta") workerIo.deltaNotificationsSeen += 1;
		writeAuditEvent(message);
		if (message?.method && message.id !== undefined) {
			if (!isOwnedServerRequest(message)) {
				workerIo.foreignMessagesIgnored += 1;
				try {
					send({ id: message.id, error: { code: -32001, message: "Research Pi rejected a server request from an unrelated Codex thread or turn" } });
				} catch {
					// The unrelated requester may already have stopped.
				}
				return;
			}
			void handleServerRequest(message);
			return;
		}
		if (message?.id !== undefined && !message.method) {
			const pending = pendingRpc.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			pendingRpc.delete(message.id);
			if (message.error) {
				pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
			} else {
				if (pending.method === "thread/start" || pending.method === "thread/resume") {
					registerRootThread(message.result?.thread?.id ?? request.continuationThreadId);
				}
				if (pending.method === "turn/start") registerRootTurn(message.result?.turn?.id);
				pending.resolve(message.result);
			}
			return;
		}
		const method = message?.method;
		const params = message?.params ?? {};
		const identity = messageIdentity(message);
		if (!identity.thread || !ownedThreadIds.has(identity.thread)) {
			workerIo.foreignMessagesIgnored += 1;
			return;
		}
		if (method === "turn/started" && identity.turn) {
			const expectedTurn = activeTurnsByThread.get(identity.thread);
			if (expectedTurn && expectedTurn !== identity.turn) {
				workerIo.foreignMessagesIgnored += 1;
				return;
			}
			activeTurnsByThread.set(identity.thread, identity.turn);
		}
		const expectedTurn = activeTurnsByThread.get(identity.thread);
		if (identity.turn && expectedTurn && identity.turn !== expectedTurn) {
			workerIo.foreignMessagesIgnored += 1;
			return;
		}
		if (
			(method === "item/started" || method === "item/completed") &&
			params.item?.type === "collabAgentToolCall" &&
			Array.isArray(params.item.receiverThreadIds)
		) {
			for (const childThreadId of params.item.receiverThreadIds) {
				if (typeof childThreadId === "string" && childThreadId) ownedThreadIds.add(childThreadId);
			}
		}
		if (
			identity.thread === threadId &&
			identity.turn === activeTurnId &&
			method === "item/completed" &&
			params.item?.type === "agentMessage" &&
			typeof params.item.text === "string"
		) {
			lastAgentText = params.item.text;
		}
		if (method === "error") lastError = truncate(params.error?.message ?? params.message ?? JSON.stringify(params), 4000);
		const progress = describeCodexNotification(message);
		const progressChanged = progress && progress !== lastNotificationProgress;
		if (progressChanged) lastNotificationProgress = progress;
		if (progressChanged) queueNotificationUpdate({ progress });
		if (
			method === "turn/completed" &&
			identity.thread === threadId &&
			identity.turn === activeTurnId
		) {
			resolveTurn(params.turn ?? { status: "completed" });
		}
	};

	const processCommands = async () => {
		let entries = [];
		try {
			entries = await readdir(join(jobDir, "commands"));
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
			if (handledCommands.has(name)) continue;
			handledCommands.add(name);
			const path = join(jobDir, "commands", name);
			let command;
			try {
				command = await readJson(path);
				if (command.status !== "pending") continue;
				const { response: commandResponse, answers: commandAnswers, ...safeCommand } = command;
				if (command.type === "respond") {
					const pending = pendingHumanResponses.get(command.requestId);
					if (!pending) throw new Error(`No pending Codex request ${command.requestId}`);
					pendingHumanResponses.delete(command.requestId);
					pending.resolve({ response: commandResponse ?? "", answers: commandAnswers ?? null });
				} else if (command.type === "steer") {
					if (!threadId || !activeTurnId) throw new Error("Codex job has no active turn to steer");
					await rpcRequest("turn/steer", {
						threadId,
						expectedTurnId: activeTurnId,
						input: [{ type: "text", text: command.message }],
					});
				} else {
					throw new Error(`Unsupported Codex command ${command.type}`);
				}
				await writeJsonAtomic(path, {
					...safeCommand,
					status: "applied",
					appliedAt: now(),
					...(command.type === "respond"
						? {
							responseLength: commandResponse?.length ?? JSON.stringify(commandAnswers ?? {}).length,
							responseSha256: createHash("sha256").update(commandResponse || JSON.stringify(commandAnswers ?? {})).digest("hex"),
						}
						: {}),
				});
			} catch (error) {
				const { response: _response, answers: _answers, ...safeCommand } = command ?? {};
				await writeJsonAtomic(path, { ...safeCommand, status: "failed", failedAt: now(), error: error instanceof Error ? error.message : String(error) });
				enqueueJobUpdate({ progress: `command failed: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
	};

	const terminateChild = (signal = "SIGTERM") => {
		if (!child || child.exitCode !== null) return;
		try {
			child.kill(signal);
		} catch {
			// Child may have exited between the checks.
		}
	};

	process.on("SIGTERM", () => {
		cancellationRequested = true;
		hostCapabilityAbort.abort();
		enqueueJobUpdate({ status: "cancelling", progress: "interrupting Codex turn" });
		if (threadId && activeTurnId) {
			void rpcRequest("turn/interrupt", { threadId, turnId: activeTurnId }, 5000).catch(() => terminateChild("SIGTERM"));
		} else {
			terminateChild("SIGTERM");
		}
		setTimeout(() => terminateChild("SIGKILL"), 7000).unref();
	});

	try {
		await writeJobUpdate((current) => ({
			...current,
			status: "running",
			workerPid: process.pid,
			startedAt: now(),
			progress: request.continuationThreadId ? "connecting to Codex app-server and resuming thread" : "connecting to Codex app-server",
			lastActivityAt: now(),
		}));

		const systemRuntime = await resolveSystemRuntimePolicy();
		const permissionArgs = codexPermissionConfigArguments(
			request.mode,
			request.boundaryRoot ?? request.cwd,
			request.runtimeTmp,
			request.gitIdentity,
			systemRuntime,
		);
		if (!request.skipSandboxPreflight) {
			await writeJobUpdate((current) => ({
				...current,
				progress: "validating Codex project, Git, and system-runtime permissions",
				lastActivityAt: now(),
			}));
			await runCodexSandboxPreflight({
				codexBin: request.codexBin,
				mode: request.mode,
				cwd: request.boundaryRoot ?? request.cwd,
				runtimeTmp: request.runtimeTmp,
				gitIdentity: request.gitIdentity,
				runtimePolicy: systemRuntime,
				environment: process.env,
			});
		}
		const appServerArgs = [
			...permissionArgs,
			"app-server",
			"--stdio",
		];
		const codexStateHome = join(dirname(dirname(jobDir)), "state");
		await mkdir(codexStateHome, { recursive: true, mode: 0o700 });
		const codexChildEnvironment = sanitizeCodexEnvironment(process.env);
		// The worker retains the opaque SSH agent handle for research_pi_host;
		// the sandboxed Codex process itself must not even inherit its path.
		delete codexChildEnvironment.SSH_AUTH_SOCK;
		child = spawn(request.codexBin, appServerArgs, {
			cwd: request.cwd,
			detached: false,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...codexChildEnvironment, CODEX_SQLITE_HOME: codexStateHome },
		});
		await writeJobUpdate((current) => ({ ...current, codexPid: child.pid ?? null, lastActivityAt: now() }));
		child.stderr.on("data", (chunk) => {
			stderrTail = truncate(`${stderrTail}${chunk.toString()}`, 12000);
			writeBounded(stderrStream, chunk, "stderr");
		});
		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					handleMessage(JSON.parse(line));
				} catch {
					writeBounded(eventsStream, `${JSON.stringify({ timestamp: now(), malformed: truncate(line, 4000) })}\n`, "event");
				}
			}
		});
		const rejectAppServer = (error) => {
			for (const pending of pendingRpc.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			pendingRpc.clear();
			rejectTurn(error);
		};
		child.on("error", (error) => rejectAppServer(error));
		child.on("close", (code, signal) => {
			if (stdoutBuffer.trim()) {
				try {
					handleMessage(JSON.parse(stdoutBuffer));
				} catch {
					// The stderr/exit error below is more useful than a final malformed fragment.
				}
			}
			rejectAppServer(new Error(`Codex app-server exited before turn completion (code=${code}, signal=${signal})`));
		});

		await rpcRequest("initialize", {
			clientInfo: { name: "research_pi", title: "Research Pi Harness", version: "0.1.0" },
			capabilities: {
				experimentalApi: true,
				optOutNotificationMethods: ["item/agentMessage/delta"],
			},
		}, 30_000);
		send({ method: "initialized", params: {} });
		try {
			const sqliteLogs = configureCodexSqliteLogs(codexStateHome);
			await enqueueJobUpdate({
				codexSqliteLogs: {
					mode: sqliteLogs.mode,
					database: sqliteLogs.databasePath ? basename(sqliteLogs.databasePath) : null,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await appendFile(join(jobDir, "worker-errors.log"), `${now()} could not configure Codex SQLite logs: ${message}\n`, { mode: 0o600 });
			await enqueueJobUpdate({ codexSqliteLogs: { mode: "unavailable", database: null, error: truncate(message, 1000) } });
		}

		const dynamicTools = [
			{
				name: "research_pi_host",
				description:
					"Use Research Pi host capabilities for justified SSH or host-user operations. Project-trusted SSH targets and command prefixes run automatically; otherwise ask Research Pi for approval through consult_research_pi. Normal uv/Python/shell commands stay in the project sandbox. Advisor mode may use read only.",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					required: ["action"],
					properties: {
						action: { type: "string", enum: ["read", "ssh", "command", "script"] },
						path: { type: "string", maxLength: 4096 },
						target: { type: "string", maxLength: 255 },
						port: { type: "integer", minimum: 1, maximum: 65535 },
						remoteCommand: { type: "string", maxLength: 32768 },
						argv: { type: "array", maxItems: 128, items: { type: "string", maxLength: 4096 } },
						cwd: { type: "string", maxLength: 4096 },
						args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } },
						timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
					},
				},
			},
			{
				name: "consult_research_pi",
				description:
					"Ask Research Pi only when a missing research decision or user-only fact materially blocks progress. Resolve implementation details yourself. Never request or transmit secrets with this tool.",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					required: ["audience", "question", "why_blocking"],
					properties: {
						audience: { type: "string", enum: ["leader", "user"] },
						question: { type: "string", maxLength: 4000 },
						why_blocking: { type: "string", maxLength: 4000 },
						options: { type: "array", maxItems: 8, items: { type: "string", maxLength: 1000 } },
					},
				},
			},
		];
		const threadParams = {
			cwd: request.cwd,
			model: request.model,
			approvalPolicy: "never",
			permissions: request.sandbox,
			dynamicTools,
			serviceName: "research_pi",
		};
		const threadResponse = request.continuationThreadId
			? await rpcRequest("thread/resume", { ...threadParams, threadId: request.continuationThreadId }, 60_000)
			: await rpcRequest("thread/start", threadParams, 60_000);
		registerRootThread(threadResponse?.thread?.id ?? request.continuationThreadId);
		if (!threadId) throw new Error("Codex app-server did not return a thread id");
		const turnResponse = await rpcRequest(
			"turn/start",
			{
				threadId,
				input: [{ type: "text", text: request.prompt }],
				cwd: request.cwd,
				model: request.model,
				effort: request.reasoningEffort,
				approvalPolicy: "never",
				permissions: request.sandbox,
				outputSchema,
			},
			60_000,
		);
		registerRootTurn(turnResponse?.turn?.id);
		if (!activeTurnId) throw new Error("Codex app-server did not return a turn id");
		await enqueueJobUpdate({ threadId, activeTurnId, progress: "Codex turn running" });

		commandTimer = setInterval(() => {
			void processCommands().catch((error) => {
				enqueueJobUpdate({ progress: `command monitor retry: ${error instanceof Error ? error.message : String(error)}` });
			});
		}, 300);
		if (Number.isFinite(request.timeoutMinutes) && request.timeoutMinutes > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				enqueueJobUpdate({ progress: `timeout after ${request.timeoutMinutes} minutes; interrupting turn` });
				void rpcRequest("turn/interrupt", { threadId, turnId: activeTurnId }, 5000).catch(() => terminateChild("SIGTERM"));
			}, request.timeoutMinutes * 60_000);
		}

		const turn = await turnDone;
		if (timeout) clearTimeout(timeout);
		if (commandTimer) clearInterval(commandTimer);
		cancelNotificationUpdate();
		await updateQueue;
		const turnFailed = turn?.status === "failed";
		if (turnFailed) lastError = truncate(turn.error?.message ?? (lastError || "Codex turn failed"), 4000);
		const result = parseStructuredResult(lastAgentText, turnFailed ? lastError : "");
		const resultPath = join(jobDir, "result.json");
		await writeJsonAtomic(resultPath, result);
		const status = cancellationRequested ? "cancelled" : !turnFailed && !timedOut ? "completed" : "failed";
		const gitAfter = await getGitSnapshot(request.cwd);
		await writeJobUpdate((current) => ({
			...current,
			status,
			finishedAt: now(),
			threadId,
			activeTurnId: null,
			pendingRequest: null,
			exitCode: status === "completed" ? 0 : 1,
			progress: cancellationRequested ? "cancelled" : timedOut ? "timed out" : status,
			gitAfter,
			resultPath,
			error: status === "failed" ? lastError || "Codex turn failed" : null,
			logCapped: { events: eventLogCapped, stderr: stderrLogCapped },
			lastActivityAt: now(),
		}));
	} catch (error) {
		cancelNotificationUpdate();
		await updateQueue;
		lastError = truncate(error?.stack ?? String(error), 12000);
		const resultPath = join(jobDir, "result.json");
		await writeJsonAtomic(resultPath, parseStructuredResult(lastAgentText, lastError)).catch(() => undefined);
		await writeJobUpdate((current) => ({
			...current,
			status: cancellationRequested ? "cancelled" : "failed",
			finishedAt: now(),
			activeTurnId: null,
			pendingRequest: null,
			progress: cancellationRequested ? "cancelled" : "worker failed",
			resultPath,
			error: lastError,
			logCapped: { events: eventLogCapped, stderr: stderrLogCapped },
			lastActivityAt: now(),
		})).catch(() => undefined);
	} finally {
		hostCapabilityAbort.abort();
		if (timeout) clearTimeout(timeout);
		if (commandTimer) clearInterval(commandTimer);
		cancelNotificationUpdate();
		for (const pending of pendingRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Codex app-server worker stopped"));
		}
		pendingRpc.clear();
		terminateChild("SIGTERM");
		await delay(100);
		terminateChild("SIGKILL");
		eventsStream.end();
		stderrStream.end();
		// stderr.log already contains the stream. Preserve a second tail only when
		// the bounded log dropped later diagnostics after reaching its cap.
		if (stderrLogCapped && stderrTail) {
			await appendFile(join(jobDir, "stderr-tail.log"), stderrTail, { mode: 0o600 }).catch(() => undefined);
		}
		await releaseWriterLock(request.lockPath, request.jobId).catch(() => undefined);
	}
}

main().catch((error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exitCode = 1;
});
