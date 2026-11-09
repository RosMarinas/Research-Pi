import { openVsCodeTerminal } from "./vscode-terminal.mjs";
import { captureTerminalContext, launchTerminal, terminalCommand } from "./terminal-launcher.mjs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexActivityCursor } from "./codex-activity.mjs";
import { publicSubagentText } from "./subagent-activity.mjs";
import { readCodexJob, publicJobView } from "./codex-jobs.mjs";
import { queueSubagentMessage } from "./runtime-subagents.mjs";
import { runtimeActorRetired, readRuntimeSnapshot, resolveResearchRuntime, resolveRuntimeActor, runtimeActorBackend, runtimeActorTarget, RESEARCH_LEADER_ACTOR_ID } from "./research-runtime.mjs";

const runFile = promisify(execFile);
const active = (status) => ["starting", "running", "input_required", "cancelling"].includes(status);

export async function createSubagentWatchClient({ cwd, stateRoot }) {
	stateRoot = resolve(stateRoot);
	const runtime = await resolveResearchRuntime(cwd, { runtimeRoot: join(stateRoot, "runtime", "projects") });
	let stamp, snapshot;
	const cursors = new Map(), jobs = new Map();
	const refresh = async () => {
		const info = await stat(runtime.ledgerPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
		const nextStamp = info ? `${info.ino}:${info.size}:${info.mtimeMs}` : "missing";
		if (!snapshot || stamp !== nextStamp) { snapshot = await readRuntimeSnapshot(runtime); stamp = nextStamp; }
		return snapshot;
	};
	const list = async () => {
		const state = await refresh();
		const latest = new Map(); for (const action of state.actions) latest.set(action.actorId, action);
		return state.actors.filter((actor) => !runtimeActorRetired(actor) && runtimeActorBackend(actor)
			&& (!actor.metadata?.workspaceKey || actor.metadata.workspaceKey === runtime.workspaceKey))
			.map((actor) => ({ ...actor, action: latest.get(actor.id) }))
			.sort((a, b) => Number(active(b.action?.status)) - Number(active(a.action?.status)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
	};
	const read = async (selector) => {
		const actors = await list();
		if (!actors.length) throw new Error("No subagent is registered in this workspace");
		const actor = selector ? resolveRuntimeActor({ actors }, selector) : actors[0];
		const backend = runtimeActorBackend(actor);
		const action = actor.action;
		const jobId = action?.externalId ?? actor.metadata?.latestJobId;
		let job = { id: jobId, status: action?.status ?? "registered", model: actor.model, thinking: actor.thinking,
			progress: action?.metadata?.progress, result: { summary: action?.metadata?.summary }, ...action?.metadata };
		if (backend === "codex" && jobId) {
			const info = await stat(join(stateRoot, "codex", "jobs", jobId, "job.json")).catch(() => null);
			const key = `${info?.size}:${info?.mtimeMs}`;
			if (!jobs.has(jobId) || jobs.get(jobId).key !== key) {
				const current = publicJobView(await readCodexJob(jobId, { jobRoot: join(stateRoot, "codex", "jobs"), expectedCwd: runtime.cwd,
					expectedProjectKey: runtime.projectKey, expectedResearchBranchId: runtime.branchId, allowLegacyLeaderJob: true, reconcile: false }));
				jobs.set(jobId, { key, job: current });
			}
			job = jobs.get(jobId).job;
		}
		let events = [];
		if (jobId && /^[a-zA-Z0-9-]+$/.test(jobId)) {
			if (!cursors.has(jobId)) cursors.set(jobId, new CodexActivityCursor(join(stateRoot, backend === "codex" ? "codex/jobs" : "subagents", jobId, "events.jsonl")));
			events = await cursors.get(jobId).poll();
		}
		const messages = snapshot.messages.filter((message) => message.to === actor.id || (message.from === actor.id && message.type !== "result")).slice(-80);
		return { actor, job, events, messages, actors, leaderConnected: snapshot.attachments.some((item) => item.actorId === RESEARCH_LEADER_ACTOR_ID) };
	};
	const send = async (actor, body, type = "notify") => {
		if (!["notify", "reply", "ask", "steer"].includes(type)) throw new Error("Use a message, /ask, /reply, or /steer");
		return await queueSubagentMessage(runtime, { actorId: actor.id, body, type });
	};
	return { runtime, stateRoot, list, read, send };
}

export function subagentWatchTranscript(view) {
	const rows = [];
	const tools = new Map();
	for (const event of view.events) {
		const text = publicSubagentText(event.text ?? event.summary ?? "");
		if (!text) continue;
		const previous = rows.at(-1);
		if (event.category === "tool" && event.tool) {
			const key = event.toolCallId ?? `${event.turn}:${event.tool}:${event.timestamp}`;
			let row = tools.get(key);
			if (!row) { row = { kind: "tool", timestamp: event.timestamp }; tools.set(key, row); rows.push(row); }
			Object.assign(row, { text, tool: event.tool, toolCallId: key, phase: event.phase, isError: event.isError });
			if (event.args) row.args = event.args;
			if (event.result) row.result = event.result;
		} else if (event.category === "thinking_delta") {
			if (previous?.kind === "thinking" && previous.turn === event.turn) previous.text += text;
			else rows.push({ kind: "thinking", text, turn: event.turn, timestamp: event.timestamp });
		} else if (event.category === "assistant_delta" && previous?.streaming && previous.turn === event.turn) previous.text += text;
		else if (event.category === "assistant") {
			if (previous?.streaming && previous.turn === event.turn) rows.pop();
			if (rows.at(-1)?.text !== text) rows.push({ kind: "assistant", text, timestamp: event.timestamp, turn: event.turn });
		} else if (event.category === "assistant_delta") rows.push({ kind: "assistant", text, timestamp: event.timestamp, turn: event.turn, streaming: true });
		else if (event.category === "message") {
			// Directed Runtime messages are shown below with their sender and receipt.
			if (!view.messages.some((message) => message.id === event.messageId || message.body === event.text)) {
				rows.push({ kind: "user", label: event.source ?? "Leader", text, timestamp: event.timestamp });
			}
		} else rows.push({ kind: "tool", text: [text, event.outputTail].filter(Boolean).join("\n"), timestamp: event.timestamp });
	}
	const summary = publicSubagentText(view.job.result?.summary ?? view.job.result?.working_synthesis);
	if (summary && !rows.some((row) => row.kind === "assistant" && row.text === summary)) {
		rows.push({ kind: "assistant", text: summary, timestamp: view.job.finishedAt ?? view.actor.updatedAt });
	}
	for (const message of view.messages) {
		const sender = message.from === "user" ? "You" : message.from;
		const recipient = message.to === view.actor.id ? "agent" : message.to;
		const kind = message.type === "notify" ? "" : ` ${message.type}`;
		rows.push({ kind: "user", label: `${sender} → ${recipient}${kind} · ${message.status}`,
			text: publicSubagentText(message.body), timestamp: message.queuedAt });
	}
	return rows.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
}

export function subagentWatchCommand({ launcher, cwd, stateRoot, actorId }) {
	const args = [launcher, "watch", "--workspace", cwd, "--state-dir", stateRoot, ...(actorId ? [actorId] : [])];
	return { args, command: terminalCommand(process.execPath, args) };
}

export async function openSubagentTerminal(options, dependencies = {}) {
	const launch = subagentWatchCommand(options);
	const context = dependencies.context ?? captureTerminalContext(dependencies);
	const exec = dependencies.exec ?? runFile;
	return await launchTerminal({ executable: process.execPath, args: launch.args, cwd: options.cwd, title: "Pi subagent" }, {
		context, exec,
		openIde: async () => await openVsCodeTerminal(options, {
			environment: context.environment, platform: context.platform,
			exec: (file, args, options) => exec(file, args, { ...options, env: context.environment }),
		}),
	});
}

export function subagentWatchLabel(actor) {
	return `${actor.label} · ${actor.backend ?? actor.provider}/${actor.role ?? actor.metadata?.role} · ${actor.model ?? "inherit"}/${actor.thinking ?? "inherit"} · @${runtimeActorTarget(actor)}`;
}
