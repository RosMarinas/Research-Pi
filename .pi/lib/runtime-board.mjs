import { basename } from "node:path";
import { RESEARCH_LEADER_ACTOR_ID, runtimeActorTarget } from "./research-runtime.mjs";

const ACTIVE_ACTION_STATUSES = new Set(["starting", "running", "cancelling"]);
const OPEN_MESSAGE_STATUSES = new Set(["queued", "delivered"]);

function inline(value, limit = 240) {
	const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	if (!text) return "";
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function shortId(value, length = 10) {
	const text = String(value ?? "");
	return text.length <= length ? text : text.slice(-length);
}

function latestActionsByActor(actions = []) {
	const latest = new Map();
	for (const action of actions) latest.set(action.actorId, action);
	return latest;
}

function actorState(actor, action, attachment) {
	if (actor.kind === "user") return "present";
	if (action?.status === "input_required") return "waiting for input";
	if (ACTIVE_ACTION_STATUSES.has(action?.status)) return action.status;
	if (action?.status === "outcome_unknown") return "outcome unknown";
	if (actor.kind === "codex") {
		return actor.metadata?.threadId
			? `suspended · ${action?.status ?? "resumable"}`
			: action?.status ?? "registered";
	}
	return attachment ? `attached · ${shortId(attachment.sessionId, 8)}` : "detached";
}

function actorPriority(actor, state) {
	if (["starting", "running", "cancelling", "waiting for input", "outcome unknown"].includes(state)) return 0;
	if (actor.id === RESEARCH_LEADER_ACTOR_ID) return 1;
	if (actor.kind === "codex") return 2;
	if (actor.kind === "user") return 4;
	return 3;
}

/**
 * Produce a bounded, presentation-neutral Project Runtime snapshot for the TUI.
 * This is a projection only: constructing it never appends Runtime events.
 */
export function buildRuntimeBoardModel({ runtime, snapshot, view, health, sessionId, inheritancePolicy = "project" }) {
	const actionByActor = latestActionsByActor(snapshot.actions);
	const actors = snapshot.actors.map((actor) => {
		const action = actionByActor.get(actor.id) ?? null;
		const attachment = snapshot.attachments.find((candidate) => candidate.actorId === actor.id) ?? null;
		const state = actorState(actor, action, attachment);
		return {
			id: actor.id,
			target: `@${runtimeActorTarget(actor)}`,
			label: inline(actor.id === RESEARCH_LEADER_ACTOR_ID ? "Leader Session" : actor.label || actor.id, 100),
			kind: actor.kind,
			provider: actor.provider ?? null,
			state,
			action: action ? {
				id: action.id,
				status: action.status,
				label: inline(action.label || action.mission || action.id, 160),
				externalId: action.externalId ?? null,
				updatedAt: action.updatedAt ?? action.createdAt ?? null,
			} : null,
			attachment: attachment ? {
				sessionId: attachment.sessionId,
				branchAnchorId: attachment.branchAnchorId ?? null,
				attachedAt: attachment.attachedAt ?? null,
			} : null,
		};
	}).sort((left, right) => {
		const priority = actorPriority(left, left.state) - actorPriority(right, right.state);
		if (priority !== 0) return priority;
		return String(right.action?.updatedAt ?? "").localeCompare(String(left.action?.updatedAt ?? ""));
	});
	const leaderAttachment = snapshot.attachments.find((item) => item.actorId === RESEARCH_LEADER_ACTOR_ID) ?? null;
	const leaderActivation = [...(snapshot.activeActivations ?? [])].reverse().find((item) =>
		item.actorId === RESEARCH_LEADER_ACTOR_ID
		&& item.sessionId === leaderAttachment?.sessionId
		&& (!leaderAttachment?.epoch || item.attachmentEpoch === leaderAttachment.epoch),
	) ?? null;
	const openMessageRecords = snapshot.messages.filter((message) => OPEN_MESSAGE_STATUSES.has(message.status));
	const openMessages = openMessageRecords
		.slice(-8)
		.reverse()
		.map((message) => ({
			id: message.id,
			type: message.type,
			status: message.status,
			from: message.from,
			to: message.to,
			body: inline(message.body, 300),
			at: message.deliveredAt ?? message.queuedAt ?? null,
		}));
	const rotations = [...(snapshot.rotations ?? [])].slice(-6).reverse().map((rotation) => ({
		id: rotation.id,
		status: rotation.status,
		fromSessionId: rotation.fromSessionId ?? null,
		toSessionId: rotation.toSessionId ?? null,
		reason: inline(rotation.reason, 180),
		at: rotation.completedAt ?? rotation.cancelledAt ?? rotation.requestedAt ?? null,
	}));
	const state = view.state;
	const transition = view.activeTransition;
	const transitionSupersedesState = Boolean(view.transitionSupersedesState);
	const currentQuestion = transitionSupersedesState
		? inline(transition?.to, 300)
		: inline(state?.researchQuestion || transition?.to, 300);
	const nextStep = inline(
		transition?.nextDecision
			|| (view.freshness === "current" ? state?.nextExperiment?.question || state?.nextExperiment?.intervention : ""),
		300,
	);
	return {
		generatedAt: new Date().toISOString(),
		project: {
			key: runtime.projectKey,
			shortKey: shortId(runtime.projectKey, 8),
			name: basename(runtime.workspaceRoot) || runtime.workspaceRoot,
			root: runtime.workspaceRoot,
			revision: view.projectRevision,
			stateRevision: view.stateRevision,
			freshness: view.freshness,
			freshnessReasons: (view.freshnessReasons ?? []).slice(0, 3).map((reason) => inline(reason, 260)),
			git: view.git,
		},
		research: {
			activeTrack: inline(transition?.to, 300),
			previousTrack: transitionSupersedesState ? inline(view.stateTrackLabel, 240) : "",
			question: currentQuestion,
			claim: transitionSupersedesState ? "" : inline(state?.currentClaim, 300),
			previousClaim: transitionSupersedesState ? inline(state?.currentClaim, 300) : "",
			nextStep,
			recentEvidence: (view.experiments ?? []).slice(-3).reverse().map((item) => ({
				id: item.id,
				validity: item.validityJudgment ?? "inconclusive",
				question: inline(item.question, 180),
				conclusion: inline(item.conclusion, 220),
			})),
		},
		leader: {
			sessionId: leaderAttachment?.sessionId ?? null,
			sessionSuffix: shortId(leaderAttachment?.sessionId, 8),
			currentSessionId: sessionId ?? null,
			isCurrentSessionAttached: Boolean(sessionId && leaderAttachment?.sessionId === sessionId),
			branchAnchorId: leaderAttachment?.branchAnchorId ?? null,
			attachedAt: leaderAttachment?.attachedAt ?? null,
			attachmentEpoch: leaderAttachment?.epoch ?? null,
			inheritancePolicy,
			activation: leaderActivation ? {
				id: leaderActivation.id,
				sessionId: leaderActivation.sessionId,
				startedAt: leaderActivation.startedAt ?? null,
			} : null,
		},
		counts: {
			active: health.active,
			waiting: health.waiting,
			unknown: health.unknown,
			actors: snapshot.actors.length,
			// The rows are bounded, but the headline must not imply that the
			// eighth visible message is the whole mailbox.
			openMessages: openMessageRecords.length,
			rotations: snapshot.rotations?.length ?? 0,
		},
		health: {
			recommendation: health.recommendation,
			reason: inline(health.reason, 320),
			ready: health.ready,
			blockers: (health.blockers ?? []).slice(0, 4).map((item) => inline(item, 240)),
			tokens: health.tokens,
			contextWindow: health.contextWindow,
			percent: health.percent,
			compactions: health.compactions,
			memoryLag: health.memoryLag,
		},
		actors,
		openMessages,
		rotations,
	};
}

export const RUNTIME_BOARD_SECTIONS = Object.freeze(["overview", "actors", "messages", "sessions"]);
