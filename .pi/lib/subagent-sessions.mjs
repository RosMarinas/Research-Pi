import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeBoundaryEnvironment } from "./project-boundary.mjs";

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
		model: job.model,
		thinking: job.thinking,
		reasoningEffort: job.thinking,
		status: job.status,
		progress: job.progress,
		cwd: job.cwd,
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
	return [
		`${job.backend}/${job.role ?? job.mode ?? "general"} ${job.id} is ${job.status}.`,
		`Model/thinking: ${job.model ?? "inherit"}/${job.thinking ?? job.reasoningEffort ?? "inherit"}`,
		job.mission ? `Mission: ${job.mission}` : undefined,
		job.progress ? `Progress: ${job.progress}` : undefined,
		job.result?.summary ? `Summary: ${job.result.summary}` : undefined,
		job.error ? `Error: ${job.error}` : undefined,
	].filter(Boolean).join("\n");
}

function piRolePrompt(role) {
	if (role === "advisor") return "Act as a read-only research advisor. Clarify design, compare explanations, and return a concise synthesis. Do not modify files.";
	if (role === "environment") return "Act as an environment and tooling specialist. Diagnose and configure the project environment end to end, staying inside the current workspace and reporting exact checks.";
	if (role === "executor") return "Act as an execution subagent. Complete the bounded task end to end, modify the project when needed, run focused checks, and return the result rather than a plan.";
	return "Act as a context-isolated research subagent. Complete the bounded task and return concise observations, actions, checks, and remaining uncertainty.";
}

function antigravityRolePrompt(role) {
	if (role === "environment") return "You are the environment specialist for Research Pi. Configure and diagnose toolchains, dependencies, SDKs, runtimes, containers, remote execution, and system integration needed by the task. Complete the work and report exact checks.";
	return piRolePrompt(role);
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
		"--append-system-prompt", input.systemPrompt ?? piRolePrompt(input.role),
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
		"--sandbox",
	];
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
	const coreCli = resolve(options.coreCli ?? process.env.RESEARCH_PI_CORE_CLI ?? process.argv[1]);
	const agyBin = options.agyBin ?? process.env.PI_ANTIGRAVITY_BIN ?? "agy";
	const stateRoot = resolve(options.stateRoot ?? process.env.RESEARCH_PI_STATE_DIR ?? ".pi");
	const sessionDir = resolve(options.sessionDir ?? join(stateRoot, "subagents", "pi-sessions"));
	const boundaryExtension = options.boundaryExtension
		?? (process.env.RESEARCH_PI_HARNESS_ROOT ? join(process.env.RESEARCH_PI_HARNESS_ROOT, ".pi", "extensions", "project-boundary.ts") : null);
	const onUpdate = options.onUpdate ?? (async () => {});
	const jobs = new Map();
	const actorJobs = new Map();
	let disposed = false;

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

	const beginTurn = async (job, body) => {
		job.turn += 1;
		job.status = "running";
		job.startedAt ??= now();
		job.finishedAt = null;
		job.result = null;
		job.error = null;
		job.progress = `turn ${job.turn} running`;
		await emit(job, { type: "message", summary: compact(body, 300), source: "user" });
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
		const child = spawnProcess(process.execPath, [coreCli, ...args], {
			cwd: job.cwd,
			env: process.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		job.child = child;
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) void handlePiRecord(job, line);
		});
		child.stderr.on("data", (chunk) => {
			job.stderr = compact(`${job.stderr}\n${chunk}`, 8000);
		});
		child.on("error", (error) => void settle(job, "failed", null, error.message));
		child.on("close", (code, signal) => {
			if (buffer.trim()) void handlePiRecord(job, buffer);
			if (!FINAL_STATUSES.has(job.status)) void settle(job, job.cancelling ? "cancelled" : "failed", null, `Pi runner exited (${code ?? "?"}${signal ? `, ${signal}` : ""})`);
		});
		await beginTurn(job, task);
	};

	const handlePiRecord = async (job, line) => {
		let record;
		try { record = JSON.parse(line); } catch { return; }
		if (record.type === "extension_ui_request") {
			if (["select", "confirm", "input", "editor"].includes(record.method) && record.id) {
				writeRecord(job.child, { type: "extension_ui_response", id: record.id, cancelled: true });
				job.progress = `${record.method} request declined; interactive approvals stay with the Leader`;
				await emit(job, { type: "input_required", summary: job.progress });
			}
		} else if (record.type === "tool_execution_start") {
			job.progress = `${record.toolName ?? "tool"} running`;
			await emit(job, { type: "tool", summary: job.progress, tool: record.toolName ?? null });
		} else if (record.type === "tool_execution_end") {
			job.progress = `${record.toolName ?? "tool"} ${record.isError ? "failed" : "completed"}`;
			await emit(job, { type: record.isError ? "error" : "tool", summary: job.progress, tool: record.toolName ?? null });
		} else if (record.type === "message_end") {
			const text = assistantText(record.message);
			if (text) job.lastResponse = text;
			if (record.message?.model && job.model === "inherit") job.model = record.message.model;
		} else if (record.type === "agent_settled") {
			if (job.cancelling) await settle(job, "cancelled", null, "cancelled by user");
			else await settle(job, "completed", { summary: job.lastResponse || "Pi runner completed without a text response." });
		} else if (record.type === "response" && record.success === false) {
			await settle(job, "failed", null, record.error ?? `${record.command ?? "RPC command"} failed`);
		}
	};

	const startAntigravity = async (job, task) => {
		job.systemPrompt = job.systemPrompt ?? antigravityRolePrompt(job.role);
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
			for (const line of lines) void handleAntigravityRecord(job, line);
		});
		child.stderr.on("data", (chunk) => {
			job.stderr = compact(`${job.stderr}\n${chunk}`, 8000);
		});
		child.on("error", (error) => void settle(job, "failed", null, error.message));
		child.on("close", (code, signal) => {
			if (buffer.trim()) void handleAntigravityRecord(job, buffer);
			if (!FINAL_STATUSES.has(job.status)) void settle(job, job.cancelling ? "cancelled" : "failed", null, `Antigravity runner exited (${code ?? "?"}${signal ? `, ${signal}` : ""})`);
		});
		await beginTurn(job, `${job.systemPrompt}\n\nTask: ${task}`);
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
		if (job.pending.length && job.status !== "failed" && job.status !== "cancelled") {
			const next = job.pending.shift();
			await beginTurn(job, next.body);
		}
	};

	const start = async (input) => {
		if (disposed) throw new Error("Subagent session manager is closed");
		const backend = String(input.backend ?? "").toLowerCase();
		if (!BACKENDS.has(backend)) throw new Error(`Unsupported process subagent backend: ${backend}`);
		const id = input.id ?? createJobId(backend);
		const job = {
			id,
			actionId: input.actionId ?? `action:${id}`,
			actorId: input.actorId,
			backend,
			role: input.role ?? "general",
			mission: input.mission ?? null,
			model: input.model ?? "inherit",
			thinking: input.thinking ?? "inherit",
			cwd: resolve(input.cwd),
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
			pending: [],
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

	const send = async (actorId, message) => {
		const id = actorJobs.get(actorId);
		const job = id ? jobs.get(id) : null;
		if (!job) return { status: "queued", detail: `No live ${actorId} session is attached` };
		const body = String(message?.body ?? message ?? "").trim();
		if (!body) throw new Error("Subagent message body is required");
		if (job.backend === "pi") {
			if (job.status === "running" || job.status === "starting") {
				// Pi steering enters the current agent loop at its next safe boundary,
				// matching Runtime's direct-message semantics without creating a
				// second queued turn whose lifecycle would be ambiguous here.
				writeRecord(job.child, { type: "steer", message: body });
				await emit(job, { type: "message", source: "user", summary: compact(body, 300) });
				return { status: "delivered", detail: `delivered to active Pi Actor ${actorId}` };
			}
			await beginTurn(job, body);
			return { status: "delivered", detail: `resumed Pi Actor ${actorId}` };
		}
		if (job.status === "running" || job.status === "starting") {
			job.pending.push({ body });
			await emit(job, { type: "message", source: "user", summary: `queued: ${compact(body, 280)}` });
			return { status: "delivered", detail: `queued for Antigravity Actor ${actorId}; stream-json accepts the next turn after the current result` };
		}
		await beginTurn(job, body);
		return { status: "delivered", detail: `resumed Antigravity Actor ${actorId}` };
	};

	const cancel = async (id) => {
		const job = jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job: ${id}`);
		if (FINAL_STATUSES.has(job.status)) return publicJob(job);
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
		disposed = true;
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
		get,
		getByActor,
		list: (backend) => [...jobs.values()].filter((job) => !backend || job.backend === backend).map(publicJob),
		send,
		cancel,
		wait,
		dispose,
	};
}
