import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConnection } from "node:net";
import { join } from "node:path";
import { attachWebDialogs } from "../lib/web-dialogs.mjs";
import { createSubagentWatchClient, subagentWatchTranscript } from "../lib/subagent-watch.mjs";
import { getRuntimeUiAdapter } from "../lib/research-runtime-adapters.mjs";
import { readRuntimeSnapshot, RESEARCH_LEADER_ACTOR_ID, runtimeActorAttachment } from "../lib/research-runtime.mjs";

const text = (value: any) => String(value ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const modelView = (model: any) => model ? { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow } : null;

export function publicWebEntries(entries: any[]) {
	return entries.filter((entry) =>
		entry.type === "custom_message" ? entry.display !== false :
		entry.type === "message" && ["user", "assistant", "toolResult", "bashExecution"].includes(entry.message?.role),
	).slice(-160);
}

export default function researchWebExtension(pi: ExtensionAPI) {
	let socket: ReturnType<typeof createConnection> | undefined;
	let context: ExtensionContext | undefined;
	let dialogs: ReturnType<typeof attachWebDialogs> | undefined;
	let watch: Awaited<ReturnType<typeof createSubagentWatchClient>> | undefined;
	let nativePrompt: any;
	let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	const statuses = new Map<string, string>();
	const seenEvents = new Map<string, any[]>();
	let originalNotify: any;
	let originalStatus: any;
	let patchedUi: any;
	let generation = 0;
	const publish = (event: any) => { if (socket && !socket.destroyed) socket.write(JSON.stringify(event) + "\n"); };
	const state = () => {
		const ctx = context;
		if (!ctx) return { ready: false };
		return {
			ready: true, sessionId: ctx.sessionManager.getSessionId(), name: pi.getSessionName() ?? "Research Pi",
			cwd: ctx.cwd, idle: ctx.isIdle(), model: modelView(ctx.model), thinking: pi.getThinkingLevel(),
			usage: ctx.getContextUsage(), entries: publicWebEntries(ctx.sessionManager.getBranch()),
			dialogs: dialogs?.list() ?? [], nativePrompt, statuses: Object.fromEntries(statuses),
		};
	};
	const sendState = () => {
		clearTimeout(snapshotTimer);
		const current = generation;
		snapshotTimer = setTimeout(() => { if (generation === current && context) publish({ type: "state", state: state() }); }, 60);
	};
	const handle = async (request: any) => {
		const ctx = context;
		if (!ctx) throw new Error("Pi is not ready");
		const { method, params = {} } = request;
		const reads = ["state", "models", "commands", "runtime", "actors", "actor.read"];
		if (!reads.includes(method) && request.sessionId !== ctx.sessionManager.getSessionId()) {
			throw new Error("The session changed. Refresh before sending another operation.");
		}
		switch (method) {
			case "state": return state();
			case "models": return (await ctx.modelRegistry.getAvailable()).map(modelView);
			case "commands": return pi.getCommands();
			case "prompt": {
				if (dialogs?.list().length || nativePrompt) throw new Error("Answer the pending request first");
				const message = String(params.message ?? "").trim();
				const images = Array.isArray(params.images) ? params.images : [];
				if (!message && !images.length) throw new Error("Enter a message");
				if (message.startsWith("/") || message.startsWith("!")) throw new Error("Use the terminal to run this command");
				if (message.length > 100_000 || images.length > 4) throw new Error("Message too large");
				const content: any[] = [{ type: "text", text: message || "Describe these images." }];
				for (const image of images) {
					if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) ||
						typeof image.data !== "string" || image.data.length > 5_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.data)) throw new Error("Invalid image");
					content.push({ type: "image", mimeType: image.mimeType, data: image.data });
				}
				pi.sendUserMessage(images.length ? content : message, { deliverAs: params.behavior === "steer" ? "steer" : "followUp" });
				return { accepted: true };
			}
			case "abort": ctx.abort(); return { accepted: true };
			case "dialog.answer": return dialogs?.answer(params.id, params.value, params.cancelled === true);
			case "model.set": {
				if (!ctx.isIdle() || nativePrompt) throw new Error("Wait until the current turn and dialog finish");
				const models = await ctx.modelRegistry.getAvailable();
				const model = models.find((item) => item.id === params.id && item.provider === params.provider);
				if (!model || !await pi.setModel(model)) throw new Error("Model is unavailable");
				sendState(); return { changed: true };
			}
			case "thinking.set": {
				if (!["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(params.level)) throw new Error("Invalid thinking level");
				if (!ctx.isIdle() || nativePrompt) throw new Error("Wait until the current turn and dialog finish");
				pi.setThinkingLevel(params.level); sendState(); return { changed: true };
			}
			case "terminal.command": {
				if (!ctx.isIdle() || nativePrompt || dialogs?.list().length) throw new Error("Finish the current turn or dialog first");
				if (ctx.ui.getEditorText().trim()) throw new Error("The terminal has an unsent draft. Send or clear it in the Terminal view first.");
				const value = String(params.command ?? "");
				if (!/^[\/!]/.test(value) || /[\r\n\x00-\x1f]/.test(value) || value.length > 2000) throw new Error("Enter a single terminal command");
				ctx.ui.setEditorText(value);
				return { terminalEnter: true };
			}
			case "runtime": return await getRuntimeUiAdapter()?.snapshot?.(ctx) ?? null;
			case "actors": return await watch?.list() ?? [];
			case "actor.read": {
				if (!watch) throw new Error("Runtime is not ready");
				const view = await watch.read(params.actorId);
				const previous = seenEvents.get(view.actor.id) ?? [];
				const byId = new Map(previous.map((event: any) => [event.id ?? JSON.stringify(event), event]));
				for (const event of view.events) byId.set(event.id ?? JSON.stringify(event), event);
				view.events = [...byId.values()].slice(-400);
				seenEvents.set(view.actor.id, view.events);
				return { actor: view.actor, job: view.job, rows: subagentWatchTranscript(view), messages: view.messages };
			}
			case "actor.send": {
				if (!watch) throw new Error("Runtime is not ready");
				const snapshot = await readRuntimeSnapshot(watch.runtime);
				if (!runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId())) {
					throw new Error("This is not the owning Leader session");
				}
				const actor = (await watch.list()).find((item: any) => item.id === params.actorId);
				if (!actor) throw new Error("Select an Actor in this workspace");
				const receipt = await watch.send(actor, String(params.body ?? ""), params.kind ?? "notify");
				return { id: receipt.id, status: receipt.status };
			}
			default: throw new Error("Unsupported Web operation");
		}
	};
	pi.registerCommand("web", {
		description: "Show the private browser link for this Pi process (start with --web)",
		handler: async (_args, ctx) => {
			if (socket) publish({ type: "show_link" });
			else ctx.ui.notify("Start a new Research Pi process with --web or --web-tailscale. The current process has no Web gateway.", "info");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!process.env.RESEARCH_PI_WEB_SOCKET) return;
		generation++;
		context = ctx;
		socket = createConnection(process.env.RESEARCH_PI_WEB_SOCKET);
		await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
				let request: any;
				try { request = JSON.parse(line); } catch { continue; }
				if (request.type !== "command") continue;
				const replySocket = socket;
				handle(request).then(
					(result) => { if (!replySocket?.destroyed) replySocket?.write(JSON.stringify({ type: "response", id: request.id, result }) + "\n"); },
					(error) => { if (!replySocket?.destroyed) replySocket?.write(JSON.stringify({ type: "response", id: request.id, error: error.message }) + "\n"); },
				);
			}
		});
		socket.on("error", () => {});
		patchedUi = ctx.ui;
		dialogs = attachWebDialogs(patchedUi, publish);
		originalNotify = patchedUi.notify;
		originalStatus = patchedUi.setStatus;
		patchedUi.notify = (message: string, kind: string) => { publish({ type: "notice", message: text(message), kind }); originalNotify(message, kind); };
		patchedUi.setStatus = (key: string, value: string) => { value === undefined ? statuses.delete(key) : statuses.set(key, text(value)); originalStatus(key, value); publish({ type: "status", key, value: value === undefined ? null : text(value) }); };
		watch = await createSubagentWatchClient({ cwd: ctx.cwd, stateRoot: process.env.RESEARCH_PI_STATE_DIR ?? join(ctx.cwd, ".pi") });
		sendState();
	});
	for (const type of ["agent_start", "agent_settled", "message_end", "model_select", "thinking_level_select", "session_info_changed", "session_compact", "session_tree"] as const) {
		pi.on(type, async (event, ctx) => { if (socket) { context = ctx; if (type === "message_end") publish({ type: "agent_event", event }); sendState(); } });
	}
	for (const type of ["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"] as const) {
		pi.on(type, async (event, ctx) => { if (socket) { context = ctx; publish({ type: "agent_event", event }); } });
	}
	pi.on("ui_prompt_start", async (event) => { if (socket) { nativePrompt = { kind: event.kind, title: event.title }; sendState(); } });
	pi.on("ui_prompt_end", async () => { nativePrompt = undefined; if (socket) sendState(); });
	pi.on("session_shutdown", async () => {
		generation++;
		clearTimeout(snapshotTimer);
		dialogs?.dispose(); dialogs = undefined;
		if (patchedUi) { patchedUi.notify = originalNotify; patchedUi.setStatus = originalStatus; }
		patchedUi = undefined;
		publish({ type: "state", state: { ready: false } });
		socket?.end(); socket = undefined;
		context = undefined; watch = undefined; nativePrompt = undefined; statuses.clear(); seenEvents.clear();
	});
}
