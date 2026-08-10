import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getGitSnapshot,
	readJson,
	releaseWriterLock,
	sanitizeCodexEnvironment,
	updateJobFile,
	writeJsonAtomic,
} from "./codex-jobs.mjs";

function now() {
	return new Date().toISOString();
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

function extractAgentText(event) {
	if (event?.type !== "item.completed") return null;
	const item = event.item ?? {};
	if (item.type !== "agent_message") return null;
	if (typeof item.text === "string") return item.text;
	if (typeof item.content === "string") return item.content;
	if (Array.isArray(item.content)) {
		return item.content
			.filter((part) => part && (part.type === "text" || part.type === "output_text"))
			.map((part) => part.text ?? "")
			.join("\n");
	}
	return null;
}

function describeProgress(event) {
	if (event?.type === "thread.started") return "Codex thread started";
	if (event?.type === "turn.started") return "Codex turn started";
	if (event?.type === "turn.completed") return "Codex turn completed";
	if (event?.type === "turn.failed") return "Codex turn failed";
	if (event?.type === "error") return truncate(event.message ?? event.error?.message ?? "Codex error", 1000);
	if (event?.type !== "item.completed" && event?.type !== "item.started" && event?.type !== "item.updated") return null;
	const item = event.item ?? {};
	if (item.type === "command_execution") {
		const command = item.command ?? item.aggregated_output ?? "command";
		return `${event.type}: ${truncate(String(command).replace(/\s+/g, " "), 400)}`;
	}
	if (item.type === "file_change") return `${event.type}: file changes`;
	if (item.type === "mcp_tool_call") return `${event.type}: MCP ${item.server ?? ""}/${item.tool ?? ""}`;
	if (item.type === "web_search") return `${event.type}: web search`;
	if (item.type === "agent_message") return "Codex produced a candidate final result";
	return item.type ? `${event.type}: ${item.type}` : event.type;
}

function fallbackResult(lastAgentText, error) {
	return {
		status: error ? "blocked" : "inconclusive",
		goal_satisfied: false,
		summary: truncate(lastAgentText || error || "Codex returned no structured final message."),
		evidence: [],
		actions_taken: [],
		changed_files: [],
		checks: [],
		external_effects: [],
		uncertainties: [error || "The final response did not parse as the required JSON schema."],
		recommended_next_step: "Research Pi should inspect the job log and decide whether to resume or rerun the delegation.",
	};
}

function parseStructuredResult(text, error) {
	if (!text) return fallbackResult(text, error);
	try {
		return JSON.parse(text);
	} catch {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
		if (fenced) {
			try {
				return JSON.parse(fenced);
			} catch {
				// Use the bounded fallback below.
			}
		}
		return fallbackResult(text, error);
	}
}

async function main() {
	const jobDir = parseArguments(process.argv.slice(2));
	const request = await readJson(join(jobDir, "request.json"));
	let child;
	let cancellationRequested = false;
	let timedOut = false;
	let timeout;
	let lastAgentText = "";
	let lastError = "";
	let stderrTail = "";
	let threadId = request.continuationThreadId ?? null;
	let updateQueue = Promise.resolve();
	const eventsStream = createWriteStream(join(jobDir, "events.jsonl"), { flags: "a", mode: 0o600 });
	const stderrStream = createWriteStream(join(jobDir, "stderr.log"), { flags: "a", mode: 0o600 });

	const enqueueJobUpdate = (update) => {
		updateQueue = updateQueue
			.then(() => updateJobFile(jobDir, (current) => ({ ...current, ...update, lastActivityAt: now() })))
			.catch(async (error) => {
				await appendFile(join(jobDir, "worker-errors.log"), `${now()} ${error?.stack ?? error}\n`, { mode: 0o600 });
			});
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
		enqueueJobUpdate({ status: "cancelling", progress: "stopping Codex process" });
		terminateChild("SIGTERM");
		setTimeout(() => terminateChild("SIGKILL"), 5000).unref();
	});

	try {
		await updateJobFile(jobDir, (current) => ({
			...current,
			status: "running",
			workerPid: process.pid,
			startedAt: now(),
			progress: request.continuationThreadId ? "resuming Codex thread" : "starting Codex thread",
			lastActivityAt: now(),
		}));

		const globalArgs = [
			"-m",
			request.model,
			"-c",
			`model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`,
			"-a",
			"never",
			"-s",
			request.sandbox,
			"-C",
			request.cwd,
		];
		const execArgs = request.continuationThreadId
			? ["exec", "resume", "--json", "--output-schema", request.schemaPath, request.continuationThreadId, "-"]
			: ["exec", "--json", "--output-schema", request.schemaPath, "-"];
		child = spawn(request.codexBin, [...globalArgs, ...execArgs], {
			cwd: request.cwd,
			detached: false,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: sanitizeCodexEnvironment(process.env),
		});
		await updateJobFile(jobDir, (current) => ({ ...current, codexPid: child.pid ?? null, lastActivityAt: now() }));
		child.stdin.on("error", (error) => {
			lastError = lastError || truncate(error?.stack ?? String(error), 4000);
		});
		child.stdin.end(request.prompt);
		child.stderr.on("data", (chunk) => {
			stderrTail = truncate(`${stderrTail}${chunk.toString()}`, 12000);
		});
		child.stderr.pipe(stderrStream, { end: false });
		if (cancellationRequested) terminateChild("SIGTERM");

		if (Number.isFinite(request.timeoutMinutes) && request.timeoutMinutes > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				enqueueJobUpdate({ progress: `timeout after ${request.timeoutMinutes} minutes` });
				terminateChild("SIGTERM");
				setTimeout(() => terminateChild("SIGKILL"), 5000).unref();
			}, request.timeoutMinutes * 60_000);
			timeout.unref();
		}

		let stdoutBuffer = "";
		const handleLine = (line) => {
			if (!line.trim()) return;
			eventsStream.write(`${line}\n`);
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "thread.started") threadId = event.thread_id ?? event.thread?.id ?? threadId;
			const agentText = extractAgentText(event);
			if (agentText) lastAgentText = agentText;
			if (event.type === "error" || event.type === "turn.failed") {
				lastError = truncate(event.message ?? event.error?.message ?? event.error ?? JSON.stringify(event), 4000);
			}
			const progress = describeProgress(event);
			if (progress || threadId) enqueueJobUpdate({ threadId, ...(progress ? { progress } : {}) });
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});

		const exit = await new Promise((resolveExit) => {
			child.on("error", (error) => {
				lastError = error?.stack ?? String(error);
				resolveExit({ code: 1, signal: null });
			});
			child.on("close", (code, signal) => resolveExit({ code: code ?? 1, signal }));
		});
		if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
		if (timeout) clearTimeout(timeout);
		await updateQueue;
		eventsStream.end();
		stderrStream.end();

		if (!lastError) lastError = stderrTail;
		if (!lastError) {
			try {
				lastError = truncate(await readFile(join(jobDir, "stderr.log"), "utf8"), 4000);
			} catch {
				// No stderr is normal.
			}
		}
		const result = parseStructuredResult(lastAgentText, exit.code === 0 ? "" : lastError);
		const resultPath = join(jobDir, "result.json");
		await writeJsonAtomic(resultPath, result);
		const status = cancellationRequested ? "cancelled" : exit.code === 0 && !timedOut ? "completed" : "failed";
		const gitAfter = await getGitSnapshot(request.cwd);
		await updateJobFile(jobDir, (current) => ({
			...current,
			status,
			finishedAt: now(),
			threadId,
			exitCode: exit.code,
			progress: cancellationRequested ? "cancelled" : timedOut ? "timed out" : status,
			gitAfter,
			resultPath,
			error: status === "failed" ? lastError || `Codex exited with code ${exit.code}` : null,
			lastActivityAt: now(),
		}));
	} catch (error) {
		lastError = error?.stack ?? String(error);
		const resultPath = join(jobDir, "result.json");
		await writeJsonAtomic(resultPath, fallbackResult(lastAgentText, lastError)).catch(() => undefined);
		await updateJobFile(jobDir, (current) => ({
			...current,
			status: cancellationRequested ? "cancelled" : "failed",
			finishedAt: now(),
			progress: cancellationRequested ? "cancelled" : "worker failed",
			resultPath,
			error: lastError,
			lastActivityAt: now(),
		})).catch(() => undefined);
	} finally {
		if (timeout) clearTimeout(timeout);
		eventsStream.end();
		stderrStream.end();
		await releaseWriterLock(request.lockPath, request.jobId).catch(() => undefined);
	}
}

main().catch(async (error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exitCode = 1;
});
