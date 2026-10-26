import { runtimePerformance } from "./runtime-performance.mjs";
import { RESEARCH_PRINCIPLES, researchRolePrompt } from "./research-prompts.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeBoundaryEnvironment } from "./project-boundary.mjs";
import { subagentModelCard, SUBAGENT_WORKSPACE_POLICY } from "./subagent-message.mjs";

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled", "input_required"]);
const BACKENDS = new Set(["pi", "antigravity"]);
const MAX_EVENTS = 240;

function now() {
	return new Date().toISOString();
}

function compact(value, limit = 600) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function assistantText(message) {
	if (!message || message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim();
}

function createJobId(backend) {
	return `${backend}-${now().replace(/[:.]/g, "-")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function publicJob(job) {
	return {
		id: job.id,
		actionId: job.actionId,
		actorId: job.actorId,
		backend: job.backend,
		role: job.role,
		mode: job.role,
		mission: job.mission,
		task: job.task,
		model: job.model,
		thinking: job.thinking,
		reasoningEffort: job.thinking,
		status: job.status,
		reusable: job.closed !== true,
		progress: job.progress,
		pendingRequest: job.pendingRequest,
		performance: job.performance,
		cwd: job.cwd,
		workspaceKey: job.workspaceKey,
		projectKey: job.projectKey,
		researchTrackRef: job.researchTrackRef,
		activityPath: job.activityPath,
		nativeTerminal: job.closed ? null : job.nativeTerminal,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		turn: job.turn,
		result: job.result,
		error: job.error,
		backendSessionId: job.backendSessionId,
		conversationId: job.conversationId,
		sessionId: job.sessionId,
		events: job.events.slice(-MAX_EVENTS),
	};
}

export function formatSubagentSessionJob(job) {
	return subagentModelCard(job);
}

export function buildWorkerPrompt(input) {
	return [RESEARCH_PRINCIPLES, researchRolePrompt(input.role), input.systemPrompt,
		input.role === "advisor" ? "" : SUBAGENT_WORKSPACE_POLICY].filter(Boolean).join("\n\n");
}

function writeRecord(child, value) {
	if (!child?.stdin?.writable) throw new Error("Subagent input stream is not writable");
	child.stdin.write(`${JSON.stringify(value)}\n`);
}

export function buildPiRunnerArgs(input) {
	const args = [
		"--mode", "rpc",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--approve",
		"--session-dir", input.sessionDir,
		"--session-id", input.sessionId,
		"--name", `Research Pi ${input.role} ${input.id.slice(-8)}`,
		"--append-system-prompt", buildWorkerPrompt(input),
	];
	if (input.boundaryExtension) args.push("--extension", input.boundaryExtension);
	if (input.model && input.model !== "inherit") args.push("--model", input.model);
	if (input.thinking && input.thinking !== "inherit") {
		args.push("--thinking", input.thinking === "none" ? "off" : input.thinking);
	}
	return args;
}

export function buildAntigravityRunnerArgs(input) {
	const args = [
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--mode", input.role === "advisor" ? "plan" : "accept-edits",
	];
	if (input.role === "advisor" || input.fullAccess !== true) args.push("--sandbox");
	// Headless Antigravity cannot show permission prompts. Non-advisor work is
	// auto-approved inside the CLI sandbox so environment commands are executed
	// instead of being silently soft-denied.
	if (input.role !== "advisor") args.push("--dangerously-skip-permissions");
	if (input.model && input.model !== "inherit") args.push("--model", input.model);
	if (input.thinking && input.thinking !== "inherit" && input.thinking !== "off" && input.thinking !== "none") {
		args.push("--effort", input.thinking);
	}
	return args;
}

export function createSubagentSessionManager(options = {}) {
	const spawnProcess = options.spawn ?? spawn;
	const agyBin = options.agyBin ?? process.env.PI_ANTIGRAVITY_BIN ?? "agy";
	const stateRoot = resolve(options.stateRoot ?? process.env.RESEARCH_PI_STATE_DIR ?? ".pi");
	const sessionDir = resolve(options.sessionDir ?? join(stateRoot, "subagents", "pi-sessions"));
	const boundaryExtension = options.boundaryExtension
		?? (process.env.RESEARCH_PI_HARNESS_ROOT ? join(process.env.RESEARCH_PI_HARNESS_ROOT, ".pi", "extensions", "project-boundary.ts") : null);
	const onUpdate = options.onUpdate ?? (async () => {});
	const jobs = new Map();
	const actorJobs = new Map();
	let disposed = false, performanceTimer;
	const pollPerformance = () => {
		for (const job of jobs.values()) if (job.backend === "pi" && job.nativeTerminal && !job.closed && job.child?.stdin?.writable) {
			writeRecord(job.child, { type: "performance", enabled: runtimePerformance.enabled });
			if (!runtimePerformance.enabled) job.performance = undefined;
		}
	};
	const configurePerformance = () => {
		clearInterval(performanceTimer); pollPerformance();
		if (runtimePerformance.enabled) { performanceTimer = setInterval(pollPerformance, 2000); performanceTimer.unref(); }
	};
	const unsubscribePerformance = runtimePerformance.onToggle(configurePerformance);
	configurePerformance();

	const emit = async (job, event) => {
		if (event) {
			job.events.push({ at: now(), ...event });
			if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
		}
		await onUpdate(publicJob(job), event ?? null);
	};

	const settle = async (job, status, result = null, error = null) => {
		job.status = status;
		job.finishedAt = now();
		job.result = result;
		job.error = error ? compact(error, 4000) : null;
		job.progress = status === "completed" ? "turn completed" : status === "input_required" ? "waiting for input" : job.error ?? status;
		await emit(job, { type: status === "completed" ? "done" : status === "input_required" ? "input_required" : "error", summary: job.progress });
		for (const waiter of job.waiters.splice(0)) waiter(publicJob(job));
	};

	// Preserve provider event order even when an update writes the Runtime ledger.
	const enqueue = (job, operation) => {
		job.records = job.records.then(operation).catch((error) => settle(job, "failed", null, error.message));
		return job.records;
	};

	const beginTurn = async (job, body, source = "research-leader", messageId = null) => {
		job.turn += 1;
		job.actionId = `action:${job.id}:turn-${job.turn}`;
		job.status = "running";
		job.startedAt ??= now();
		job.finishedAt = null;
		job.result = null;
		job.error = null;
		job.cancelling = false;
		job.lastResponse = ""; job.lastStopReason = null;
		job.progress = `turn ${job.turn} running`;
		await emit(job, { type: "message", text: body, summary: compact(body, 300), source, messageId });
		if (job.backend === "pi") {
			writeRecord(job.child, { id: `prompt-${job.turn}`, type: "prompt", message: body });
		} else {
			writeRecord(job.child, { event: "user", message: { content: body } });
		}
	};

	const startPi = async (job, task) => {
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		job.sessionId = randomUUID();
		const args = buildPiRunnerArgs({ ...job, sessionDir, boundaryExtension });
		const child = spawnProcess(process.execPath, [options.piRunner ?? fileURLToPath(new URL("./subagent-native-process.mjs", import.meta.url)), ...args], {
			cwd: job.cwd,
			env: { ...process.env,
				RESEARCH_PI_SUBAGENT: JSON.stringify({ id: job.id, actorId: job.actorId, mission: job.mission, role: job.role, stateRoot }),
				RESEARCH_PI_FULL_ACCESS: job.fullAccess ? "1" : "0",
				RESEARCH_PI_INITIAL_SESSION_MODE: job.role === "advisor" ? "analysis" : "project",
				RESEARCH_PI_CAPABILITY_SESSION_ID: job.leaderSessionId ?? job.sessionId,
			},
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		job.child = child;
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) void enqueue(job, () => handlePiRecord(job, line));
		});
		child.stderr.on("data", (chunk) => {
			job.stderr = compact(`${job.stderr}\n${chunk}`, 8000);
		});
		child.on("error", (error) => { job.closed = true; void enqueue(job, () => settle(job, "failed", null, error.message)); });
		child.on("close", (code, signal) => {
			job.closed = true;
			void enqueue(job, async () => {
				if (buffer.trim()) await handlePiRecord(job, buffer);
				if (!FINAL_STATUSES.has(job.status)) await settle(job, job.cancelling ? "cancelled" : "failed", null, `Pi runner exited (${code ?? "?"}${signal ? `, ${signal}` : ""})`);
			});
		});
		await beginTurn(job, task);
		writeRecord(child, { id: "initial-state", type: "get_state" });
	};

	const handlePiRecord = async (job, line) => {
		let record;
		try { record = JSON.parse(line); } catch { return; }
		if (record.type === "performance_sample") { job.performance = record.sample; return; }
		if (record.type === "native_status") {
			if (record.state === "blocked" && job.status === "running") {
				job.nativeBlocked = true; job.status = "input_required";
				job.pendingRequest = { id: randomUUID(), kind: record.kind, summary: record.message };
				job.progress = `${record.message ?? "Input required"} — open /watch to respond`;
				await emit(job, { type: "input_required", summary: job.progress });
			} else if (record.state !== "blocked" && job.nativeBlocked) {
				job.nativeBlocked = false; job.pendingRequest = null; job.status = "running";
				await emit(job, { type: "progress", summary: "Native input resolved" });
			}
		} else if (record.type === "subagent_ready") {
			job.nativeTerminal = record.nativeTerminal;
			await emit(job, { type: "progress", summary: "Native conversation ready" });
		} else if (record.type === "agent_start" && FINAL_STATUSES.has(job.status)) {
			job.turn += 1; job.actionId = `action:${job.id}:turn-${job.turn}`;
			job.status = "running"; job.result = null; job.finishedAt = null; job.error = null; job.lastResponse = ""; job.lastStopReason = null; job.cancelling = false;
			await emit(job, { type: "progress", summary: "User started a turn in the native conversation" });
		} else if (record.type === "message_update") {
			const update = record.assistantMessageEvent;
			if (["text_delta", "thinking_delta"].includes(update?.type)) {
				await emit(job, { type: update.type === "text_delta" ? "assistant_delta" : "thinking_delta", text: update.delta });
			}
		} else if (record.type === "response" && record.command === "get_state" && record.success) {
			const model = record.data?.model;
			if (model?.id) job.model = model.provider ? `${model.provider}/${model.id}` : model.id;
			if (record.data?.thinkingLevel) job.thinking = record.data.thinkingLevel;
			await emit(job, { type: "progress", summary: "runner model settings resolved" });
		} else if (record.type === "extension_ui_request") {
			if (["select", "confirm", "input", "editor"].includes(record.method) && record.id) {
				job.progress = `${record.method} request awaiting the Leader UI`;
				await emit(job, { type: "progress", summary: job.progress });
				const response = await options.onUiRequest?.(publicJob(job), record);
				writeRecord(job.child, { ...response, type: "extension_ui_response", id: record.id, ...(!response ? { cancelled: true } : {}) });
				job.progress = response && !response.cancelled ? "Leader UI responded; continuing" : "Leader UI unavailable or request cancelled";
				await emit(job, { type: "progress", summary: job.progress });
			}
		} else if (record.type === "tool_execution_start") {
			job.progress = `${record.toolName ?? "tool"} running`;
			await emit(job, { type: "tool", summary: job.progress, tool: record.toolName ?? null, toolCallId: record.toolCallId, phase: "running", args: record.args });
		} else if (record.type === "tool_execution_update") {
			await emit(job, { type: "tool", summary: `${record.toolName} running`, tool: record.toolName, toolCallId: record.toolCallId, phase: "running", result: record.partialResult });
		} else if (record.type === "tool_execution_end") {
			job.progress = `${record.toolName ?? "tool"} ${record.isError ? "failed" : "completed"}`;
			await emit(job, { type: record.isError ? "error" : "tool", summary: job.progress, tool: record.toolName ?? null, toolCallId: record.toolCallId, phase: "completed", result: record.result, isError: record.isError });
		} else if (record.type === "message_end") {
			if (record.message?.role === "assistant") {
				job.lastStopReason = record.message.stopReason;
				job.lastModelError = record.message.errorMessage;
			}
			const text = assistantText(record.message);
			if (text) {
				job.lastResponse = text;
				await emit(job, { type: "assistant", text, summary: compact(text, 300) });
			}
			if (record.message?.model && job.model === "inherit") job.model = record.message.model;
		} else if (record.type === "agent_settled") {
			if (job.cancelling || job.lastStopReason === "aborted") await settle(job, "cancelled", null, "cancelled by user");
			else if (job.lastStopReason === "error") await settle(job, "failed", null, job.lastModelError ?? "Model request failed");
			else await settle(job, "completed", { summary: job.lastResponse || "Pi runner completed without a text response." });
		} else if (record.type === "response" && record.success === false) {
			await settle(job, "failed", null, record.error ?? `${record.command ?? "RPC command"} failed`);
		}
	};

	const startAntigravity = async (job, task) => {
		const child = spawnProcess(agyBin, buildAntigravityRunnerArgs(job), {
			cwd: job.cwd,
			env: sanitizeBoundaryEnvironment(process.env),
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		job.child = child;
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) void enqueue(job, () => handleAntigravityRecord(job, line));
		});
		child.stderr.on("data", (chunk) => {
			job.stderr = compact(`${job.stderr}\n${chunk}`, 8000);
		});
		child.on("error", (error) => { job.closed = true; void enqueue(job, () => settle(job, "failed", null, error.message)); });
		child.on("close", (code, signal) => {
			job.closed = true;
			void enqueue(job, async () => {
				if (buffer.trim()) await handleAntigravityRecord(job, buffer);
				if (!FINAL_STATUSES.has(job.status)) await settle(job, job.cancelling ? "cancelled" : "failed", null, `Antigravity runner exited (${code ?? "?"}${signal ? `, ${signal}` : ""})`);
			});
		});
		await beginTurn(job, `${buildWorkerPrompt(job)}\n\nTask: ${task}`);
	};

	const handleAntigravityRecord = async (job, line) => {
		let record;
		try { record = JSON.parse(line); } catch { return; }
		if (record.event === "init") {
			job.conversationId = record.conversation_id ?? record.init?.conversation_id ?? null;
			job.backendSessionId = job.conversationId;
			await emit(job, { type: "progress", summary: `Antigravity conversation ${job.conversationId ?? "started"}` });
			return;
		}
		if (record.event === "step_update") {
			const step = record.step_update ?? {};
			const info = step.tool_info ?? {};
			const summary = step.step_type === "tool"
				? `${step.tool_name ?? info.name ?? "tool"} ${String(step.state ?? "").toLowerCase()}`
				: step.step_type === "agent_response" ? compact(step.text_delta, 300) : `${step.step_type ?? "step"} ${String(step.state ?? "").toLowerCase()}`;
			if (summary) {
				job.progress = summary;
				await emit(job, { type: step.step_type === "tool" ? "tool" : step.subagent_info ? "child" : "progress", summary, raw: step });
			}
			return;
		}
		if (record.event !== "result") return;
		const result = record.result ?? {};
		job.conversationId = result.conversation_id ?? job.conversationId;
		job.backendSessionId = job.conversationId;
		if (result.status === "SUCCESS") await settle(job, "completed", { summary: String(result.response ?? "").trim(), usage: result.usage ?? null });
		else if (result.status === "WAITING") await settle(job, "input_required", { summary: String(result.response ?? "").trim() }, result.error ?? null);
		else if (["CANCELED", "INTERRUPTED"].includes(result.status)) await settle(job, "cancelled", null, result.error ?? result.status);
		else await settle(job, "failed", null, result.error ?? `Antigravity ended with ${result.status ?? "ERROR"}`);
	};

	const start = async (input) => {
		if (disposed) throw new Error("Subagent session manager is closed");
		const backend = String(input.backend ?? "").toLowerCase();
		if (!BACKENDS.has(backend)) throw new Error(`Unsupported process subagent backend: ${backend}`);
		const id = input.id ?? createJobId(backend);
		if (actorJobs.has(input.actorId)) throw new Error("This Actor already has a session; continue it instead of starting another process");
		const job = {
			id,
			actionId: input.actionId ?? `action:${id}:turn-1`,
			actorId: input.actorId,
			backend,
			role: input.role ?? "general",
			fullAccess: input.role !== "advisor" && (input.fullAccess ?? process.env.RESEARCH_PI_FULL_ACCESS === "1"),
			leaderSessionId: input.leaderSessionId,
			mission: input.mission ?? null,
			task: input.task,
			model: input.model ?? "inherit",
			thinking: input.thinking ?? "inherit",
			cwd: resolve(input.cwd),
			workspaceKey: input.workspaceKey ?? null,
			projectKey: input.projectKey ?? null,
			researchTrackRef: input.researchTrackRef ?? "project:initial",
			activityPath: input.activityPath ?? null,
			systemPrompt: input.systemPrompt,
			status: "starting",
			progress: "starting runner",
			createdAt: now(),
			startedAt: null,
			finishedAt: null,
			turn: 0,
			result: null,
			error: null,
			events: [],
			records: Promise.resolve(),
			waiters: [],
			stderr: "",
			cancelling: false,
			child: null,
			backendSessionId: null,
			conversationId: null,
			sessionId: null,
			lastResponse: "",
		};
		jobs.set(id, job);
		actorJobs.set(job.actorId, id);
		await emit(job, { type: "progress", summary: "starting runner" });
		if (backend === "pi") await startPi(job, input.task);
		else await startAntigravity(job, input.task);
		return publicJob(job);
	};

	const get = (id) => {
		const job = jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job: ${id}`);
		return publicJob(job);
	};

	const getByActor = (actorId) => {
		const id = actorJobs.get(actorId);
		return id ? get(id) : null;
	};

	const send = async (actorId, message, { jobId } = {}) => {
		const id = jobId ?? actorJobs.get(actorId);
		const job = id ? jobs.get(id) : null;
		if (!job) return { status: "queued", detail: `No live ${actorId} session is attached` };
		if (job.actorId !== actorId) throw new Error("The job does not belong to this Actor");
		if (job.closed) return { status: "queued", detail: "The backend process has closed; start a new subagent" };
		if (job.status === "cancelling") return { status: "queued", detail: "Waiting for cancellation to settle" };
		const body = String(message?.body ?? message ?? "").trim();
		if (!body) throw new Error("Subagent message body is required");
		if (job.backend === "pi") {
			if (job.status === "running" || job.status === "starting" || job.nativeBlocked) {
				// Pi steering enters the current agent loop at its next safe boundary,
				// matching Runtime's direct-message semantics without creating a
				// second queued turn whose lifecycle would be ambiguous here.
				writeRecord(job.child, { type: "steer", message: body });
				await emit(job, { type: "message", source: message.from ?? "user", messageId: message.id, text: body, summary: compact(body, 300) });
				return { status: "delivered", detail: `delivered to active Pi Actor ${actorId}` };
			}
			await beginTurn(job, body, message.from ?? "user", message.id);
			return { status: "delivered", detail: `resumed Pi Actor ${actorId}` };
		}
		if (job.status === "running" || job.status === "starting") {
			return { status: "queued", detail: `waiting in Runtime for Antigravity Actor ${actorId}; the next turn starts after the current result` };
		}
		await beginTurn(job, body, message.from ?? "user", message.id);
		return { status: "delivered", detail: `resumed Antigravity Actor ${actorId}` };
	};

	const resume = async (id, input) => {
		const job = jobs.get(id);
		if (!job || job.closed) throw new Error("The backend process is no longer available; start a new subagent");
		if ((input.model && input.model !== job.model) || (input.thinking && input.thinking !== job.thinking)) {
			throw new Error("A live Pi/Antigravity session keeps its model settings; use reuse=never to choose another model or thinking level");
		}
		job.researchTrackRef = input.researchTrackRef ?? job.researchTrackRef;
		await send(job.actorId, { body: input.followUp, from: "research-leader" }, { jobId: id });
		return publicJob(job);
	};

	const cancel = async (id) => {
		const job = jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job: ${id}`);
		if (FINAL_STATUSES.has(job.status) && !job.nativeBlocked) return publicJob(job);
		job.cancelling = true;
		job.status = "cancelling";
		job.progress = "cancelling";
		await emit(job, { type: "progress", summary: "cancelling" });
		if (job.backend === "pi" && job.child?.stdin?.writable) writeRecord(job.child, { id: `abort-${job.turn}`, type: "abort" });
		else job.child?.kill("SIGINT");
		return publicJob(job);
	};

	const wait = async (id, signal) => {
		const job = jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job: ${id}`);
		if (FINAL_STATUSES.has(job.status)) return publicJob(job);
		return await new Promise((resolveWait, reject) => {
			const done = (value) => {
				signal?.removeEventListener("abort", aborted);
				resolveWait(value);
			};
			const aborted = () => {
				const index = job.waiters.indexOf(done);
				if (index >= 0) job.waiters.splice(index, 1);
				reject(new Error("Subagent wait aborted"));
			};
			job.waiters.push(done);
			if (signal?.aborted) aborted();
			else signal?.addEventListener("abort", aborted, { once: true });
		});
	};

	const dispose = async () => {
		disposed = true; clearInterval(performanceTimer); unsubscribePerformance();
		for (const job of jobs.values()) {
			if (!FINAL_STATUSES.has(job.status)) {
				job.cancelling = true;
				job.child?.kill("SIGTERM");
				await settle(job, "cancelled", null, "Research Pi session closed");
			}
			job.child?.stdin?.end();
		}
	};

	return {
		start,
		retire: async (id) => {
			const job = jobs.get(id);
			if (!job) return; // A prior host already closed this process.
			if (!["completed", "failed", "cancelled"].includes(job.status)) throw new Error("Finish or cancel the subagent before retirement");
			job.closed = true;
			job.child?.stdin?.end();
			job.child?.kill("SIGTERM");
		},
		get,
		getByActor,
		resume,
		list: (backend) => [...jobs.values()].filter((job) => !backend || job.backend === backend).map(publicJob),
		send,
		cancel,
		wait,
		dispose,
	};
}
