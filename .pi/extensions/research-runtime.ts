import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { getGitSnapshot, HARNESS_ROOT } from "../lib/codex-jobs.mjs";
import {
	buildProjectView,
	commitProjectState,
	materializeProjectView,
	migrateLatestProjectState,
	projectViewFingerprint,
	readRecentExperiments,
	renderProjectView,
} from "../lib/project-view.mjs";
import { RESEARCH_HARD_COMPACT_TOKENS, RESEARCH_SOFT_COMPACT_TOKENS } from "../lib/research-compact.mjs";
import { getCodexRuntimeAdapter } from "../lib/research-runtime-adapters.mjs";
import { buildRuntimeBoardModel } from "../lib/runtime-board.mjs";
import { RuntimeBoardOverlay } from "../lib/runtime-board-ui.mjs";
import { resolveResearchPiPaths } from "../lib/runtime-paths.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_EVENT_ENTRY_KIND,
	RUNTIME_MESSAGE_KIND,
	USER_ACTOR_ID,
	attachRuntimeActor,
	appendRuntimeEvent,
	appendRuntimeEventAtRevision,
	createRuntimeMessage,
	detachRuntimeActor,
	initializeResearchRuntime,
	isRuntimeActorAttached,
	pendingRuntimeMessages,
	readRuntimeSnapshot,
	requestRuntimeSessionRotation,
	resolveRuntimeActor,
	runtimeActorTarget,
	runtimeMessageText,
	settleRuntimeMessage,
	settleRuntimeSessionRotation,
	unconsumedRuntimeMessages,
} from "../lib/research-runtime.mjs";

type RuntimeContext = Awaited<ReturnType<typeof initializeResearchRuntime>>;
type RuntimeMessage = ReturnType<typeof pendingRuntimeMessages>[number];
type RuntimeSnapshot = Awaited<ReturnType<typeof readRuntimeSnapshot>>;

const MESSAGE_TYPES = new Set(["ask", "reply", "notify", "result"]);
const ACTIVE_ACTION_STATUSES = new Set(["starting", "running", "cancelling"]);
const RECOVERABLE_ACTION_STATUSES = new Set([...ACTIVE_ACTION_STATUSES, "input_required"]);

function compact(text: string, limit = 160): string {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function splitTargetAndBody(input: string): { target: string; body: string } {
	const match = input.trim().match(/^(@[^\s]+)\s+([\s\S]+)$/);
	if (!match) throw new Error("Expected @actor followed by a message");
	return { target: match[1], body: match[2].trim() };
}

function latestActionsByActor(snapshot: RuntimeSnapshot) {
	const latest = new Map<string, RuntimeSnapshot["actions"][number]>();
	for (const action of snapshot.actions) latest.set(action.actorId, action);
	return latest;
}

export function runtimeActorSummary(snapshot: RuntimeSnapshot) {
	const latest = latestActionsByActor(snapshot);
	let active = 0;
	let waiting = 0;
	for (const actor of snapshot.actors) {
		const status = latest.get(actor.id)?.status;
		if (status === "input_required") waiting += 1;
		else if (ACTIVE_ACTION_STATUSES.has(status)) active += 1;
	}
	return { active, waiting, registered: snapshot.actors.length };
}

export function runtimeRotationReadiness(snapshot: RuntimeSnapshot) {
	const blockers: string[] = [];
	const revision = snapshot.revision ?? 0;
	const stateRevision = snapshot.projectState?.revision ?? 0;
	const unknown = snapshot.actions.filter((action) => action.status === "outcome_unknown");
	const untrackedActive = snapshot.actions.filter((action) =>
		RECOVERABLE_ACTION_STATUSES.has(action.status) && !action.externalId,
	);
	if (!snapshot.projectState) blockers.push("no structured Project State is available");
	else if (revision > stateRevision) blockers.push(`${revision - stateRevision} Project revision(s) have not reached structured state`);
	if (unknown.length) blockers.push(`${unknown.length} executor outcome(s) are unknown`);
	if (untrackedActive.length) blockers.push(`${untrackedActive.length} active Action(s) have no recoverable external identity`);
	return {
		ready: blockers.length === 0,
		blockers,
		projectRevision: revision,
		stateRevision,
		activeActionIds: snapshot.actions
			.filter((action) => RECOVERABLE_ACTION_STATUSES.has(action.status))
			.map((action) => action.id),
		openMessageIds: unconsumedRuntimeMessages(snapshot, { to: RESEARCH_LEADER_ACTOR_ID }).map((message) => message.id),
	};
}

export function formatRuntimeStatus(projectKey: string, snapshot: RuntimeSnapshot): string {
	const { active, waiting } = runtimeActorSummary(snapshot);
	const open = unconsumedRuntimeMessages(snapshot).length;
	const states = [
		active ? `${active} active` : "",
		waiting ? `${waiting} waiting` : "",
	].filter(Boolean);
	if (!states.length) states.push("idle");
	if (open) states.push(`${open} open`);
	return `Runtime ${projectKey.slice(-8)} · ${states.join(" · ")}`;
}

export function runtimeHealth(snapshot: RuntimeSnapshot, usage: ReturnType<ExtensionContext["getContextUsage"]>, branchEntries: any[]) {
	const actionSummary = runtimeActorSummary(snapshot);
	const unknown = snapshot.actions.filter((action) => action.status === "outcome_unknown").length;
	const compactions = branchEntries.filter((entry) => entry.type === "compaction").length;
	const memoryLag = Math.max(0, (snapshot.revision ?? 0) - (snapshot.projectState?.revision ?? 0));
	const tokens = usage?.tokens ?? null;
	const rotation = runtimeRotationReadiness(snapshot);
	let recommendation = "continue";
	let reason = "No Runtime recovery issue or context-pressure threshold currently requires intervention.";
	if (unknown) {
		recommendation = "reconcile";
		reason = `${unknown} executor outcome(s) are unknown; inspect external state before further writes.`;
	} else if (memoryLag > 0) {
		recommendation = actionSummary.active || actionSummary.waiting ? "continue-then-compact" : "compact";
		reason = `${memoryLag} Project transition/evidence revision(s) are newer than structured state${actionSummary.active || actionSummary.waiting ? "; let active work settle, then refresh state" : "; compact can refresh state now"}.`;
	} else if (tokens !== null && tokens >= RESEARCH_HARD_COMPACT_TOKENS) {
		recommendation = "compact";
		reason = `Context is at or above the ${RESEARCH_HARD_COMPACT_TOKENS.toLocaleString()} hard research threshold.`;
	} else if (tokens !== null && tokens >= RESEARCH_SOFT_COMPACT_TOKENS) {
		recommendation = rotation.ready && compactions >= 2 && !actionSummary.active && !actionSummary.waiting ? "consider-rotation" : "compact";
		reason = recommendation === "consider-rotation"
			? "A structured project state exists, actions are settled, and context pressure is high; a fresh Session may now be cheaper than another long continuation."
			: "Context is above the soft research threshold; compact before evidence is displaced by overflow.";
	}
	return { tokens, contextWindow: usage?.contextWindow ?? null, percent: usage?.percent ?? null, compactions, unknown, memoryLag, ...actionSummary, ...rotation, recommendation, reason };
}

export function formatRuntimeHealth(health: ReturnType<typeof runtimeHealth>): string {
	return [
		`Context: ${health.tokens?.toLocaleString() ?? "unknown"}/${health.contextWindow?.toLocaleString() ?? "unknown"}${health.percent === null ? "" : ` (${health.percent.toFixed(1)}%)`}`,
		`Session: ${health.compactions} compaction(s)`,
		`Runtime: ${health.active} active · ${health.waiting} waiting · ${health.unknown} outcome_unknown`,
		`Project memory: ${health.memoryLag ? `${health.memoryLag} revision(s) pending synthesis` : "current"}`,
		`Rotation: ${health.ready ? "ready for /runtime rotate" : `blocked (${health.blockers.join("; ")})`}`,
		`Recommendation: ${health.recommendation}`,
		health.reason,
		"Lifecycle remains manual: Research Pi never rotates or reconciles automatically.",
	].join("\n");
}

export function actorLines(snapshot: RuntimeSnapshot, activeOnly = true): string {
	if (!snapshot.actors.length) return "No Runtime Actors are registered for this project.";
	const latest = latestActionsByActor(snapshot);
	const summary = runtimeActorSummary(snapshot);
	const visibleActors = activeOnly
		? snapshot.actors.filter((actor) => {
			const status = latest.get(actor.id)?.status;
			return status === "input_required" || ACTIVE_ACTION_STATUSES.has(status);
		})
		: snapshot.actors;
	const stateSummary = [
		summary.active ? `${summary.active} active` : "",
		summary.waiting ? `${summary.waiting} waiting` : "",
	].filter(Boolean).join(" · ") || "idle";
	return [
		`Project ${snapshot.projectKey} · ${stateSummary} · ${summary.registered} registered`,
		...(visibleActors.length ? visibleActors.map((actor) => {
			const attachment = snapshot.attachments.find((candidate) => candidate.actorId === actor.id);
			const latestAction = latest.get(actor.id);
			const target = `@${runtimeActorTarget(actor)}`;
			let state;
			if (actor.kind === "user") state = "present";
			else if (latestAction?.status === "input_required") state = "waiting for input";
			else if (ACTIVE_ACTION_STATUSES.has(latestAction?.status)) state = `active (${latestAction.status})`;
			else if (actor.kind === "codex") {
				state = actor.metadata?.threadId
					? `suspended (${latestAction?.status ?? "resumable"})`
					: latestAction?.status ?? "registered";
			} else state = attachment ? `attached ${String(attachment.sessionId).slice(-8)}` : "detached";
			return `- ${target} · ${actor.label} · ${actor.kind} · ${state}`;
		}) : ["No active Runtime Actor. Use /actors all to inspect registered and suspended Actors."]),
	].join("\n");
}

function inboxLines(snapshot: Awaited<ReturnType<typeof readRuntimeSnapshot>>, includeSettled = false): string {
	const messages = snapshot.messages
		.filter((message) => includeSettled || message.status === "queued" || message.status === "delivered")
		.slice(-30)
		.reverse();
	if (!messages.length) return includeSettled ? "The project Runtime mailbox is empty." : "No open Runtime messages.";
	return messages
		.map((message) => `${message.status.padEnd(10)} ${message.type.padEnd(7)} ${message.id} · ${message.from} -> ${message.to}\n${compact(message.body, 240)}`)
		.join("\n\n");
}

export default function researchRuntimeExtension(pi: ExtensionAPI) {
	let runtime: RuntimeContext | undefined;
	let runtimeInputCwd: string | undefined;
	let attachedSessionId: string | undefined;
	const consumedMessageIds = new Set<string>();
	const materializedMessageIds = new Set<string>();
	const migrationAttemptedProjects = new Set<string>();
	let projectViewText = "";
	let projectViewHash = "";

	const getRuntime = async (ctx: ExtensionContext, options: { claim?: boolean } = {}): Promise<RuntimeContext> => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (runtime && runtimeInputCwd === ctx.cwd && attachedSessionId === sessionId) {
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
		runtimeInputCwd = ctx.cwd;
		attachedSessionId = sessionId;
		return runtime;
	};

	const refreshStatus = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const activeRuntime = await getRuntime(ctx);
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		ctx.ui.setStatus("research_runtime", formatRuntimeStatus(activeRuntime.projectKey, snapshot));
	};

	const refreshProjectView = async (ctx: ExtensionContext) => {
		const activeRuntime = await getRuntime(ctx);
		let snapshot = await readRuntimeSnapshot(activeRuntime);
		if (!snapshot.projectState && !migrationAttemptedProjects.has(activeRuntime.projectKey)) {
			migrationAttemptedProjects.add(activeRuntime.projectKey);
			if (!snapshot.activeTransition && snapshot.revision === 0) {
				await migrateLatestProjectState({
					runtime: activeRuntime,
					sessionDir: resolveResearchPiPaths({ harnessRoot: HARNESS_ROOT }).sessionDir,
					cwd: ctx.cwd,
					appendRuntimeEvent,
					appendRuntimeEventAtRevision,
					readRuntimeSnapshot,
				});
			}
			snapshot = await readRuntimeSnapshot(activeRuntime);
		}
		const [git, experiments] = await Promise.all([
			getGitSnapshot(ctx.cwd),
			readRecentExperiments(join(ctx.cwd, ".pi", "research", "experiments.jsonl")),
		]);
		const view = buildProjectView({ runtime: activeRuntime, snapshot, git, experiments });
		projectViewText = renderProjectView(view);
		projectViewHash = projectViewFingerprint(view);
		return { snapshot, view };
	};

	const runtimeBoardModel = async (ctx: ExtensionContext) => {
		const activeRuntime = await getRuntime(ctx);
		const { snapshot, view } = await refreshProjectView(ctx);
		const health = runtimeHealth(snapshot, ctx.getContextUsage(), ctx.sessionManager.getBranch());
		return buildRuntimeBoardModel({
			runtime: activeRuntime,
			snapshot,
			view,
			health,
			sessionId: ctx.sessionManager.getSessionId(),
		});
	};

	const showRuntimeBoard = async (ctx: ExtensionCommandContext) => {
		// The board is an observe-only surface. In particular, opening it must not
		// steal the Research Leader attachment from another Session; action
		// commands use `claim: true` explicitly when they need ownership.
		await getRuntime(ctx);
		const initial = await runtimeBoardModel(ctx);
		const result = await ctx.ui.custom<"close" | "view" | "watch">(
			(tui, theme, _keybindings, done) => new RuntimeBoardOverlay(
				tui,
				theme,
				done,
				initial,
				async () => {
					const model = await runtimeBoardModel(ctx);
					await refreshStatus(ctx);
					return model;
				},
			),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%", margin: 1 },
			},
		);
		if (result === "view") ctx.ui.notify(projectViewText, "info");
		else if (result === "watch") {
			ctx.ui.setEditorText("/watch");
			ctx.ui.notify("Codex Watch command is ready; press Enter to open it.", "info");
		}
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

	pi.on("session_start", async (event, ctx) => {
		const activeRuntime = await getRuntime(ctx);
		const { snapshot, view } = await refreshProjectView(ctx);
		consumedMessageIds.clear();
		materializedMessageIds.clear();
		if (event.reason === "new") {
			const currentSessionId = ctx.sessionManager.getSessionId();
			const pendingRotation = [...(snapshot.pendingRotations ?? [])].reverse().find((rotation) => {
				if (rotation.fromSessionId === currentSessionId) return false;
				if (event.previousSessionFile && rotation.fromSessionFile) {
					return event.previousSessionFile === rotation.fromSessionFile;
				}
				return !event.previousSessionFile || !rotation.fromSessionFile;
			});
			if (pendingRotation) {
				await settleRuntimeSessionRotation(activeRuntime, pendingRotation.id, "completed", {
					toSessionId: currentSessionId,
					toSessionFile: ctx.sessionManager.getSessionFile(),
					projectRevision: snapshot.revision,
					projectViewFingerprint: projectViewHash,
					projectViewFreshness: view.freshness,
				});
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Runtime rotation ${pendingRotation.id} completed. ProjectView r${snapshot.revision} (${view.freshness}) is ready in the new Session.`,
						"info",
					);
				}
			}
		}
		for (const message of snapshot.messages) {
			if (message.status === "consumed") consumedMessageIds.add(message.id);
		}
		const currentSessionId = ctx.sessionManager.getSessionId();
		for (const message of unconsumedRuntimeMessages(snapshot, { to: RESEARCH_LEADER_ACTOR_ID, forSessionId: currentSessionId })) {
			const result = await deliverToCurrentLeader(activeRuntime, message, ctx, { triggerTurn: false });
			if (result.status === "delivered") {
				await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
					sessionId: currentSessionId,
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
		runtimeInputCwd = undefined;
		attachedSessionId = undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		await getRuntime(ctx, { claim: true });
		await refreshProjectView(ctx);
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
		return { messages: materializeProjectView(messages, projectViewText, { fingerprint: projectViewHash }) };
	});

	pi.on("session_compact", async (event, ctx) => {
		const activeRuntime = await getRuntime(ctx, { claim: true });
		const result = await commitProjectState(activeRuntime, {
			compactionEntry: event.compactionEntry,
			sessionId: ctx.sessionManager.getSessionId(),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
			git: await getGitSnapshot(ctx.cwd),
		});
		if (result?.status === "conflict" && ctx.hasUI) {
			ctx.ui.notify(
				`Research compact preserved as Session history but did not replace Project State: it was based on an older Project revision (${result.revision} is current).`,
				"warning",
			);
		}
		await refreshProjectView(ctx);
		await refreshStatus(ctx);
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
		await refreshProjectView(ctx);
		await refreshStatus(ctx);
	});

	pi.registerCommand("runtime", {
		description: "Open the Project Runtime board, inspect health/View, or manually rotate the Leader Session",
		handler: async (args, ctx) => {
			try {
				const [mode = "board", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (!["board", "health", "recommend", "view", "rotate"].includes(mode)) throw new Error("Usage: /runtime [board|health|recommend|view|rotate [reason]]");
				if (mode === "board") {
					await showRuntimeBoard(ctx);
					await refreshStatus(ctx);
					return;
				}
				if (mode === "rotate") await ctx.waitForIdle();
				const activeRuntime = await getRuntime(ctx, { claim: true });
				const { snapshot, view } = await refreshProjectView(ctx);
				if (mode === "rotate") {
					const readiness = runtimeRotationReadiness(snapshot);
					if (!readiness.ready) {
						throw new Error(`Runtime rotation is blocked: ${readiness.blockers.join("; ")}. Refresh Project State with /compact or reconcile the listed Action first.`);
					}
					const fromSessionId = ctx.sessionManager.getSessionId();
					const fromSessionFile = ctx.sessionManager.getSessionFile();
					const rotation = await requestRuntimeSessionRotation(activeRuntime, {
						fromSessionId,
						fromSessionFile,
						projectRevision: readiness.projectRevision,
						stateRevision: readiness.stateRevision,
						projectViewFingerprint: projectViewHash,
						projectViewFreshness: view.freshness,
						reason: rest.join(" ") || "manual Runtime rotation",
						activeActionIds: readiness.activeActionIds,
						openMessageIds: readiness.openMessageIds,
					});
					const result = await ctx.newSession({
						...(fromSessionFile ? { parentSession: fromSessionFile } : {}),
					});
					if (result.cancelled) {
						await settleRuntimeSessionRotation(activeRuntime, rotation.id, "cancelled", { reason: "Pi session replacement was cancelled" });
						ctx.ui.notify(`Runtime rotation ${rotation.id} was cancelled; the current Session remains attached.`, "info");
					}
					return;
				}
				if (mode === "view") ctx.ui.notify(projectViewText, "info");
				else {
					const health = runtimeHealth(snapshot, ctx.getContextUsage(), ctx.sessionManager.getBranch());
					ctx.ui.notify(mode === "recommend" ? `${health.recommendation}: ${health.reason}\nNo lifecycle action was taken.` : formatRuntimeHealth(health), health.unknown ? "warning" : "info");
				}
				await refreshStatus(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("actors", {
		description: "List active project Runtime Actors (/actors all includes suspended history)",
		handler: async (args, ctx) => {
			try {
				const mode = args.trim() || "active";
				if (mode !== "active" && mode !== "all") throw new Error("Usage: /actors [active|all]");
				const activeRuntime = await getRuntime(ctx, { claim: true });
				ctx.ui.notify(actorLines(await readRuntimeSnapshot(activeRuntime), mode !== "all"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("inbox", {
		description: "Inspect open project Runtime messages (/inbox all includes settled messages)",
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
				if (result.status === "delivered") await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
					actorId: actor.id,
					...(actor.id === RESEARCH_LEADER_ACTOR_ID ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
				});
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
				if (result.status === "delivered") await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
					actorId: actor.id,
					...(actor.id === RESEARCH_LEADER_ACTOR_ID ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
				});
				if (actor.id !== RESEARCH_LEADER_ACTOR_ID) displayOperationalCard(message, result.status);
				ctx.ui.notify(`${message.id}: ${result.detail}`, result.status === "delivered" ? "info" : "warning");
				await refreshStatus(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
