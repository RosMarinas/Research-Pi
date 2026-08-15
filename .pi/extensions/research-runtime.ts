import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { getCodexRuntimeAdapter } from "../lib/research-runtime-adapters.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_EVENT_ENTRY_KIND,
	RUNTIME_MESSAGE_KIND,
	USER_ACTOR_ID,
	attachRuntimeActor,
	createRuntimeMessage,
	detachRuntimeActor,
	initializeResearchRuntime,
	isRuntimeActorAttached,
	pendingRuntimeMessages,
	readRuntimeSnapshot,
	resolveRuntimeActor,
	runtimeActorTarget,
	runtimeMessageText,
	settleRuntimeMessage,
} from "../lib/research-runtime.mjs";

type RuntimeContext = Awaited<ReturnType<typeof initializeResearchRuntime>>;
type RuntimeMessage = ReturnType<typeof pendingRuntimeMessages>[number];

const MESSAGE_TYPES = new Set(["ask", "reply", "notify", "result"]);

function compact(text: string, limit = 160): string {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function splitTargetAndBody(input: string): { target: string; body: string } {
	const match = input.trim().match(/^(@[^\s]+)\s+([\s\S]+)$/);
	if (!match) throw new Error("Expected @actor followed by a message");
	return { target: match[1], body: match[2].trim() };
}

function actorLines(snapshot: Awaited<ReturnType<typeof readRuntimeSnapshot>>): string {
	if (!snapshot.actors.length) return "No Runtime Actors are registered for this project.";
	return [
		`Project ${snapshot.projectKey}`,
		...snapshot.actors.map((actor) => {
			const attachment = snapshot.attachments.find((candidate) => candidate.actorId === actor.id);
			const latestAction = snapshot.actions.filter((action) => action.actorId === actor.id).at(-1);
			const target = `@${runtimeActorTarget(actor)}`;
			let state;
			if (actor.kind === "user") state = "present";
			else if (actor.kind === "codex") {
				state = latestAction?.status === "input_required"
					? "waiting for input"
					: ["starting", "running", "cancelling"].includes(latestAction?.status)
						? `active (${latestAction.status})`
						: actor.metadata?.threadId
							? `suspended (${latestAction?.status ?? "resumable"})`
							: latestAction?.status ?? "registered";
			} else state = attachment ? `attached ${String(attachment.sessionId).slice(-8)}` : "detached";
			return `- ${target} · ${actor.label} · ${actor.kind} · ${state}`;
		}),
	].join("\n");
}

function inboxLines(snapshot: Awaited<ReturnType<typeof readRuntimeSnapshot>>, includeSettled = false): string {
	const messages = snapshot.messages
		.filter((message) => includeSettled || message.status === "queued")
		.slice(-30)
		.reverse();
	if (!messages.length) return includeSettled ? "The project Runtime mailbox is empty." : "No queued Runtime messages.";
	return messages
		.map((message) => `${message.status.padEnd(10)} ${message.type.padEnd(7)} ${message.id} · ${message.from} -> ${message.to}\n${compact(message.body, 240)}`)
		.join("\n\n");
}

export default function researchRuntimeExtension(pi: ExtensionAPI) {
	let runtime: RuntimeContext | undefined;
	let attachedSessionId: string | undefined;
	const consumedMessageIds = new Set<string>();
	const materializedMessageIds = new Set<string>();

	const getRuntime = async (ctx: ExtensionContext, options: { claim?: boolean } = {}): Promise<RuntimeContext> => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (runtime && runtime.cwd === ctx.cwd && attachedSessionId === sessionId) {
			if (options.claim && !(await isRuntimeActorAttached(runtime, RESEARCH_LEADER_ACTOR_ID, sessionId))) {
				await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, {
					sessionId,
					branchAnchorId: ctx.sessionManager.getLeafId(),
				});
			}
			return runtime;
		}
		runtime = await initializeResearchRuntime(ctx.cwd, {
			sessionId,
			branchAnchorId: ctx.sessionManager.getLeafId(),
		});
		attachedSessionId = sessionId;
		return runtime;
	};

	const refreshStatus = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const activeRuntime = await getRuntime(ctx);
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		const queued = pendingRuntimeMessages(snapshot).length;
		ctx.ui.setStatus("research_runtime", `Runtime ${activeRuntime.projectKey.slice(-8)} · ${snapshot.actors.length} actors${queued ? ` · ${queued} queued` : ""}`);
	};

	const displayOperationalCard = (message: RuntimeMessage, status: string) => {
		pi.appendEntry(RUNTIME_EVENT_ENTRY_KIND, {
			messageId: message.id,
			type: message.type,
			from: message.from,
			to: message.to,
			body: message.body,
			status,
			at: new Date().toISOString(),
		});
	};

	const deliverToCurrentLeader = async (
		activeRuntime: RuntimeContext,
		message: RuntimeMessage,
		ctx: ExtensionContext,
		options: { preempt?: boolean; triggerTurn?: boolean } = {},
	) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!(await isRuntimeActorAttached(activeRuntime, RESEARCH_LEADER_ACTOR_ID, sessionId))) {
			return { status: "queued" as const, detail: "Research Leader is attached to another Pi session" };
		}
		if (options.preempt && !ctx.isIdle()) ctx.abort();
		const idle = ctx.isIdle();
		pi.sendMessage(
			{
				customType: RUNTIME_MESSAGE_KIND,
				content: runtimeMessageText(message),
				display: true,
				details: {
					messageId: message.id,
					type: message.type,
					from: message.from,
					to: message.to,
					transient: true,
				},
			},
			idle
				? { triggerTurn: options.triggerTurn ?? true }
				: { triggerTurn: false, deliverAs: "followUp" },
		);
		return { status: "delivered" as const, detail: idle ? "started a leader turn" : "queued for the next safe leader turn" };
	};

	const dispatchMessage = async (
		activeRuntime: RuntimeContext,
		message: RuntimeMessage,
		actor: Awaited<ReturnType<typeof resolveRuntimeActor>>,
		ctx: ExtensionCommandContext,
		options: { preempt?: boolean } = {},
	) => {
		if (!actor) throw new Error("Runtime Actor is unavailable");
		if (actor.id === RESEARCH_LEADER_ACTOR_ID) {
			return await deliverToCurrentLeader(activeRuntime, message, ctx, { preempt: options.preempt });
		}
		if (actor.kind === "codex") {
			const adapter = getCodexRuntimeAdapter();
			if (!adapter) return { status: "queued", detail: "Codex Runtime adapter is not loaded" };
			return await adapter.dispatch({ runtime: activeRuntime, actor, message, preempt: options.preempt === true, ctx });
		}
		return { status: "queued", detail: `${actor.label} has no live Provider adapter` };
	};

	pi.registerMessageRenderer<{ messageId?: string; type?: string; from?: string }>(RUNTIME_MESSAGE_KIND, (message, options, theme) => {
		const details = message.details ?? {};
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		card.addChild(new Text(theme.fg("accent", theme.bold(`[Runtime ${details.type ?? "message"}]`)), 0, 0));
		card.addChild(new Text(theme.fg("dim", `${details.from ?? "unknown"} · ${details.messageId ?? "unknown"}`), 0, 0));
		card.addChild(new Text(compact(content, options.expanded ? 4000 : 600), 0, 0));
		return card;
	});

	pi.registerEntryRenderer<{
		messageId: string;
		type: string;
		from: string;
		to: string;
		body: string;
		status: string;
	}>(RUNTIME_EVENT_ENTRY_KIND, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data?.messageId) return undefined;
		const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		card.addChild(new Text(theme.fg("accent", theme.bold(`[Runtime ${data.type}] ${data.status}`)), 0, 0));
		card.addChild(new Text(`${data.from} -> ${data.to}`, 0, 0));
		card.addChild(new Text(compact(data.body, expanded ? 4000 : 240), 0, 0));
		card.addChild(new Text(theme.fg("dim", data.messageId), 0, 0));
		return card;
	});

	pi.on("session_start", async (_event, ctx) => {
		const activeRuntime = await getRuntime(ctx);
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		consumedMessageIds.clear();
		materializedMessageIds.clear();
		for (const message of snapshot.messages) {
			if (message.status === "consumed") consumedMessageIds.add(message.id);
		}
		for (const message of pendingRuntimeMessages(snapshot, { to: RESEARCH_LEADER_ACTOR_ID })) {
			const result = await deliverToCurrentLeader(activeRuntime, message, ctx, { triggerTurn: false });
			if (result.status === "delivered") {
				await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
					sessionId: ctx.sessionManager.getSessionId(),
					actorId: RESEARCH_LEADER_ACTOR_ID,
				});
			}
		}
		await refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!runtime || !attachedSessionId) return;
		await detachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, attachedSessionId);
		if (ctx.hasUI) ctx.ui.setStatus("research_runtime", undefined);
		runtime = undefined;
		attachedSessionId = undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		await getRuntime(ctx, { claim: true });
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => {
			if (message.role !== "custom" || message.customType !== RUNTIME_MESSAGE_KIND) return true;
			const messageId = String(message.details?.messageId ?? "");
			if (!messageId) return true;
			if (consumedMessageIds.has(messageId)) return false;
			materializedMessageIds.add(messageId);
			return true;
		});
		return { messages };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!materializedMessageIds.size) return;
		const activeRuntime = await getRuntime(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		for (const messageId of materializedMessageIds) {
			await settleRuntimeMessage(activeRuntime, messageId, "consumed", { sessionId, actorId: RESEARCH_LEADER_ACTOR_ID });
			consumedMessageIds.add(messageId);
		}
		materializedMessageIds.clear();
		await refreshStatus(ctx);
	});

	pi.registerCommand("actors", {
		description: "List project Runtime Actors and their current activation state",
		handler: async (_args, ctx) => {
			try {
				const activeRuntime = await getRuntime(ctx, { claim: true });
				ctx.ui.notify(actorLines(await readRuntimeSnapshot(activeRuntime)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("inbox", {
		description: "Inspect queued project Runtime messages (/inbox all includes settled messages)",
		handler: async (args, ctx) => {
			try {
				const activeRuntime = await getRuntime(ctx, { claim: true });
				ctx.ui.notify(inboxLines(await readRuntimeSnapshot(activeRuntime), args.trim() === "all"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("message", {
		description: "Send an ask/reply/notify/result to a project Actor",
		handler: async (args, ctx) => {
			try {
				const match = args.trim().match(/^(ask|reply|notify|result)\s+([\s\S]+)$/);
				if (!match || !MESSAGE_TYPES.has(match[1])) throw new Error("Usage: /message <ask|reply|notify|result> @actor <message>");
				const { target, body } = splitTargetAndBody(match[2]);
				const activeRuntime = await getRuntime(ctx, { claim: true });
				const snapshot = await readRuntimeSnapshot(activeRuntime);
				const actor = resolveRuntimeActor(snapshot, target);
				const message = await createRuntimeMessage(activeRuntime, {
					type: match[1],
					from: USER_ACTOR_ID,
					to: actor.id,
					body,
				});
				const result = await dispatchMessage(activeRuntime, message, actor, ctx);
				if (result.status === "delivered") await settleRuntimeMessage(activeRuntime, message.id, "delivered", { actorId: actor.id });
				displayOperationalCard(message, result.status);
				ctx.ui.notify(`${message.id}: ${result.detail}`, result.status === "delivered" ? "info" : "warning");
				await refreshStatus(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("steer", {
		description: "Correct a project Actor without aborting by default; add --preempt for urgent interruption",
		handler: async (args, ctx) => {
			try {
				let input = args.trim();
				const preempt = input.startsWith("--preempt ");
				if (preempt) input = input.slice("--preempt ".length).trim();
				const { target, body } = splitTargetAndBody(input);
				const activeRuntime = await getRuntime(ctx, { claim: true });
				const snapshot = await readRuntimeSnapshot(activeRuntime);
				const actor = resolveRuntimeActor(snapshot, target);
				const message = await createRuntimeMessage(activeRuntime, {
					type: "steer",
					from: USER_ACTOR_ID,
					to: actor.id,
					body,
				});
				const result = await dispatchMessage(activeRuntime, message, actor, ctx, { preempt });
				if (result.status === "delivered") await settleRuntimeMessage(activeRuntime, message.id, "delivered", { actorId: actor.id });
				if (actor.id !== RESEARCH_LEADER_ACTOR_ID) displayOperationalCard(message, result.status);
				ctx.ui.notify(`${message.id}: ${result.detail}`, result.status === "delivered" ? "info" : "warning");
				await refreshStatus(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
