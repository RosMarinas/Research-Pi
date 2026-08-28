import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { Type } from "typebox";
import {
	getGitSnapshot,
	HARNESS_ROOT,
	readCodexJob,
	supersedePendingCodexRequests,
} from "../lib/codex-jobs.mjs";
import {
	PROJECT_VIEW_DELTA_KIND,
	PROJECT_VIEW_KIND,
	buildProjectView,
	commitProjectState,
	materializeProjectViewDelta,
	migrateLatestProjectState,
	projectViewFingerprint,
	projectViewDeltaCursor,
	projectViewRefreshFingerprint,
	readRecentExperiments,
	renderProjectView,
	renderProjectViewDelta,
} from "../lib/project-view.mjs";
import { RESEARCH_HARD_COMPACT_TOKENS, RESEARCH_SOFT_COMPACT_TOKENS } from "../lib/research-compact.mjs";
import {
	getCodexRuntimeAdapter,
	getCodexWatchAdapter,
	registerRuntimeUiAdapter,
} from "../lib/research-runtime-adapters.mjs";
import { buildRuntimeBoardModel } from "../lib/runtime-board.mjs";
import { RuntimeBoardOverlay } from "../lib/runtime-board-ui.mjs";
import {
	createRuntimeDockClock,
	RuntimeDockComponent,
	runtimeDockNeedsClock,
	runtimeDockVisible,
} from "../lib/runtime-dock-ui.mjs";
import { resolveResearchPiPaths } from "../lib/runtime-paths.mjs";
import { createRuntimeMailboxWatcher } from "../lib/runtime-mailbox-watch.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_EVENT_ENTRY_KIND,
	RUNTIME_MESSAGE_KIND,
	RUNTIME_SESSION_POLICY_ENTRY_KIND,
	RuntimeAttachmentChangedError,
	USER_ACTOR_ID,
	analysisSessionActorId,
	appendRuntimeEvent,
	appendRuntimeEventAtRevision,
	claimRuntimeActorAttachment,
	createRuntimeMessage,
	consumeRuntimeMessagesForAttachment,
	detachRuntimeActor,
	ensureRuntimeActor,
	initializeResearchRuntime,
	isRuntimeActorAttached,
	pendingRuntimeMessages,
	readRuntimeSnapshot,
	reconcileCodexRuntimeAsks,
	recordRuntimeHandoff,
	requestRuntimeSessionRotation,
	requestRuntimeSessionInheritance,
	resolveRuntimeActor,
	runtimeActorAttachment,
	runtimeActorTarget,
	runtimeMessageText,
	runtimeSessionInheritancePolicy,
	runtimeSessionProjectContext,
	settleRuntimeActorActivation,
	settleRuntimeMessage,
	settleRuntimeSessionRotation,
	settleRuntimeSessionInheritance,
	startRuntimeActorActivation,
	unconsumedRuntimeMessages,
} from "../lib/research-runtime.mjs";

type RuntimeContext = Awaited<ReturnType<typeof initializeResearchRuntime>>;
type RuntimeMessage = ReturnType<typeof pendingRuntimeMessages>[number];
type RuntimeSnapshot = Awaited<ReturnType<typeof readRuntimeSnapshot>>;
type RuntimeActivation = RuntimeSnapshot["activations"][number];
type SessionInheritancePolicy = "project" | "clean" | "analysis";
type ProjectContextMode = "project" | "none";
type ProjectViewReceipt = {
	version: number;
	persistent: true;
	mode: "snapshot" | "delta";
	projectRevision: number;
	stateRevision: number;
	trackRef: string;
	gitFingerprint: string;
	fingerprint: string;
	freshness: string;
	latestHandoffId: string | null;
	actionsFingerprint: string;
};

class RuntimeLeaderBusyError extends Error {
	readonly activation: RuntimeActivation;
	constructor(activation: RuntimeActivation) {
		super(`The Leader Session is active in Session ${String(activation.sessionId).slice(-8)}. Wait for it to settle or use /runtime takeover <reason>.`);
		this.name = "RuntimeLeaderBusyError";
		this.activation = activation;
	}
}

const MESSAGE_TYPES = new Set(["ask", "reply", "notify", "result"]);
const ACTIVE_ACTION_STATUSES = new Set(["starting", "running", "cancelling"]);
const RECOVERABLE_ACTION_STATUSES = new Set([...ACTIVE_ACTION_STATUSES, "input_required"]);
const CODEX_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "outcome_unknown"]);
const RUNTIME_DOCK_KEY = "research_runtime_dock";
const RUNTIME_MAILBOX_WATCH_INTERVAL_MS = 250;
const UI_DENSITY = process.env.RESEARCH_PI_UI_DENSITY === "compact" ? "compact" : "balanced";
const UI_RUNTIME_STRIP = ["auto", "always", "off"].includes(process.env.RESEARCH_PI_UI_RUNTIME_STRIP ?? "")
	? process.env.RESEARCH_PI_UI_RUNTIME_STRIP as "auto" | "always" | "off"
	: "auto";
const ANALYSIS_SAFE_TOOLS = new Set([
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"research_memory_search",
	"research_memory_read",
	"web_search",
	"host_capability",
	"analysis_send_to_leader",
]);
const ANALYSIS_CODEX_READ_ACTIONS = new Set(["status", "result", "missions"]);
const PROJECT_VIEW_MUTATING_TOOLS = new Set([
	"bash",
	"edit",
	"write",
	"record_experiment",
	"record_research_transition",
	"amend_project_state",
	"research_checkpoint",
]);
const PROJECT_VIEW_READ_ONLY_CODEX_ACTIONS = new Set(["status", "result", "missions"]);

export function projectViewToolMutates(
	toolName: string,
	input: Record<string, unknown> = {},
): boolean {
	if (toolName === "codex_delegate") {
		return !PROJECT_VIEW_READ_ONLY_CODEX_ACTIONS.has(String(input.action ?? ""));
	}
	return PROJECT_VIEW_MUTATING_TOOLS.has(toolName);
}

export function analysisSessionToolBlockReason(
	policy: SessionInheritancePolicy,
	toolName: string,
	input: Record<string, unknown> = {},
): string | null {
	if (policy !== "analysis") return null;
	if (ANALYSIS_SAFE_TOOLS.has(toolName)) return null;
	if (toolName === "codex_delegate" && ANALYSIS_CODEX_READ_ACTIONS.has(String(input.action ?? ""))) return null;
	return `Analysis Session cannot use ${toolName}: it may inspect local/remote evidence, including OS-sandboxed read-only project shell commands, but cannot modify code, run experiments, steer workers, or update Project State. Use analysis_send_to_leader, or /runtime promote <reason> to become the Leader Session.`;
}

export async function reconcileStaleCodexMailbox(
	runtime: RuntimeContext,
	snapshot: RuntimeSnapshot,
	dependencies: {
		readJob?: typeof readCodexJob;
		supersedeRequests?: typeof supersedePendingCodexRequests;
	} = {},
): Promise<RuntimeSnapshot> {
	const readJob = dependencies.readJob ?? readCodexJob;
	const supersedeRequests = dependencies.supersedeRequests ?? supersedePendingCodexRequests;
	const jobIds = new Set(snapshot.messages
		.filter((message) => message.type === "ask" && ["queued", "delivered"].includes(message.status))
		.map((message) => String(message.metadata?.jobId ?? ""))
		.filter(Boolean));
	let changed = false;
	for (const jobId of jobIds) {
		let job;
		try {
			job = await readJob(jobId, {
				expectedProjectKey: runtime.projectKey,
				expectedLeaderActorId: RESEARCH_LEADER_ACTOR_ID,
			});
		} catch {
			// Missing, damaged, legacy, or cross-project jobs need explicit user review.
			continue;
		}
		if (CODEX_TERMINAL_STATUSES.has(job.status)) {
			await supersedeRequests(job.id, { terminalStatus: job.status }).catch(() => undefined);
		}
		const settled = await reconcileCodexRuntimeAsks(runtime, job);
		if (settled.length) changed = true;
	}
	return changed ? await readRuntimeSnapshot(runtime) : snapshot;
}

function sessionRoleContext(role: "analysis" | "leader", content: string): string {
	const rolePrompt = role === "analysis"
		? "You are the current read-only Analysis Session. Discuss, explain, compare hypotheses, and inspect local or approved remote evidence. You may run project-local shell commands under an OS-enforced read-only filesystem profile, but must not start experiments or external side effects. Do not modify code, steer workers, consume the Leader mailbox, or update Project State. Treat new interpretations as proposals, not evidence. Use analysis_send_to_leader for a useful synthesis; project execution requires explicit user promotion."
		: "You are the currently attached Leader Session. This role block supersedes any earlier Analysis Session role block in this conversation. Execution tools, Project State writes, Codex coordination, and the durable Leader mailbox are active within their normal authority boundaries.";
	return [`# Session role: ${role === "analysis" ? "Analysis" : "Leader"} Session`, rolePrompt, content]
		.filter(Boolean)
		.join("\n\n");
}

function compact(text: string, limit = 160): string {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function latestAssistantText(messages: any[]): string {
	for (const message of [...(messages ?? [])].reverse()) {
		if (message?.role !== "assistant") continue;
		const content = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
				: "";
		if (content.trim()) return content.trim();
	}
	return "";
}

function handoffKind(toolNames: Set<string>): string {
	if (toolNames.has("record_research_transition")) return "research-route-change";
	if (toolNames.has("record_experiment")) return "research-evidence";
	if (toolNames.has("codex_delegate")) return "delegated-project-work";
	return "leader-project-task";
}

function runtimeDisplayBody(content: string): string {
	const lines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
	if (/^\[Research Runtime\b/.test(lines[0] ?? "")) lines.shift();
	return lines.join("\n").trim();
}

export function codexRuntimeMessagePreview(content: string, limit = 360): string {
	const body = runtimeDisplayBody(content);
	const summary = body.match(/(?:^|\n)Summary:\s*([\s\S]*?)(?=\n(?:Evidence|Actions taken|Changed files|Checks|External effects|Uncertainties|Recommended next step|Error):|\nUse codex_delegate|$)/)?.[1] ?? body;
	return compact(summary, limit);
}

export function codexRuntimeMessageMarkdown(content: string): string {
	const body = runtimeDisplayBody(content);
	const summaryIndex = body.search(/(?:^|\n)Summary:/);
	const relevant = summaryIndex >= 0 ? body.slice(summaryIndex + (body[summaryIndex] === "\n" ? 1 : 0)) : body;
	return relevant
		.replace(/^Summary:\s*/m, "## Summary\n\n")
		.replace(/^(Evidence|Actions taken|Changed files|Checks|External effects|Uncertainties):\s*$/gm, "## $1")
		.replace(/^Recommended next step:\s*/m, "## Recommended next step\n\n")
		.replace(/^Error:\s*/m, "## Error\n\n")
		.replace(/^(Use codex_delegate[^\n]*)$/gm, "> $1")
		.trim();
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

export function formatRuntimeStatus(projectKey: string, snapshot: RuntimeSnapshot, inheritancePolicy: SessionInheritancePolicy = "project"): string {
	const { active, waiting } = runtimeActorSummary(snapshot);
	const open = unconsumedRuntimeMessages(snapshot).length;
	const states = [
		active ? `${active} active` : "",
		waiting ? `${waiting} waiting` : "",
	].filter(Boolean);
	if (!states.length) states.push("idle");
	if (open) states.push(`${open} open`);
	if (inheritancePolicy === "clean") states.push("clean context");
	if (inheritancePolicy === "analysis") states.push("analysis only");
	return `Runtime ${projectKey.slice(-8)} · ${states.join(" · ")}`;
}

export function runtimeHealth(
	snapshot: RuntimeSnapshot,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
	branchEntries: any[],
	inheritancePolicy: SessionInheritancePolicy = "project",
) {
	const actionSummary = runtimeActorSummary(snapshot);
	const unknown = snapshot.actions.filter((action) => action.status === "outcome_unknown").length;
	const compactions = branchEntries.filter((entry) => entry.type === "compaction").length;
	const memoryLag = Math.max(0, (snapshot.revision ?? 0) - (snapshot.projectState?.revision ?? 0));
	const tokens = usage?.tokens ?? null;
	const baseRotation = runtimeRotationReadiness(snapshot);
	const rotation = inheritancePolicy === "clean"
		? { ...baseRotation, ready: false, blockers: ["current Session intentionally has clean context; use /runtime inherit before a Project-aware handoff", ...baseRotation.blockers] }
		: inheritancePolicy === "analysis"
			? { ...baseRotation, ready: false, blockers: ["current Session is analysis-only; use /runtime promote before a Leader handoff", ...baseRotation.blockers] }
		: baseRotation;
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
	return {
		tokens,
		contextWindow: usage?.contextWindow ?? null,
		percent: usage?.percent ?? null,
		compactions,
		unknown,
		memoryLag,
		memoryStatus: inheritancePolicy === "clean" ? "paused" : snapshot.projectState ? (memoryLag ? "stale" : "current") : "missing",
		inheritancePolicy,
		...actionSummary,
		...rotation,
		recommendation,
		reason,
	};
}

export function formatRuntimeHealth(health: ReturnType<typeof runtimeHealth>): string {
	return [
		`Context: ${health.tokens?.toLocaleString() ?? "unknown"}/${health.contextWindow?.toLocaleString() ?? "unknown"}${health.percent === null ? "" : ` (${health.percent.toFixed(1)}%)`}`,
		`Session: ${health.compactions} compaction(s)`,
		`Runtime: ${health.active} active · ${health.waiting} waiting · ${health.unknown} outcome_unknown`,
		`Project memory: ${health.memoryStatus === "paused" ? "paused for this clean Session" : health.memoryStatus === "missing" ? "missing (no structured Project State)" : health.memoryLag ? `${health.memoryLag} revision(s) pending synthesis` : "current"}`,
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
			return `- ${target} · ${actor.id === RESEARCH_LEADER_ACTOR_ID ? "Leader Session" : actor.label} · ${actor.kind} · ${state}`;
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

function projectViewGitFingerprint(view: Awaited<ReturnType<typeof buildProjectView>>): string {
	return `${view.git.branch ?? "unknown"}:${view.git.commit ?? "unknown"}:${String(view.git.dirty ?? "unknown")}`;
}

function latestProjectViewReceipt(entries: any[]): ProjectViewReceipt | undefined {
	let afterCompaction = 0;
	for (const [index, entry] of entries.entries()) if (entry?.type === "compaction") afterCompaction = index + 1;
	for (let index = entries.length - 1; index >= afterCompaction; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom_message" || entry.customType !== PROJECT_VIEW_KIND) continue;
		const details = entry.details;
		if (details?.persistent !== true || !Number.isInteger(details.projectRevision)) continue;
		return details as ProjectViewReceipt;
	}
	return undefined;
}

function projectViewReceipt(
	view: Awaited<ReturnType<typeof buildProjectView>>,
	mode: ProjectViewReceipt["mode"],
): ProjectViewReceipt {
	return {
		version: view.version,
		persistent: true,
		mode,
		projectRevision: view.projectRevision,
		stateRevision: view.stateRevision,
		trackRef: view.currentTrack?.ref ?? "project:initial",
		gitFingerprint: projectViewGitFingerprint(view),
		fingerprint: projectViewFingerprint(view),
		freshness: view.freshness,
		...projectViewDeltaCursor(view),
	};
}

function projectViewPersistenceMode(
	view: Awaited<ReturnType<typeof buildProjectView>>,
	previous?: ProjectViewReceipt,
): ProjectViewReceipt["mode"] | null {
	if (!previous) return "snapshot";
	if (previous.version !== view.version) return "snapshot";
	const gitChanged = previous.gitFingerprint !== projectViewGitFingerprint(view);
	const revisionChanged = previous.projectRevision !== view.projectRevision;
	const viewChanged = previous.fingerprint !== projectViewFingerprint(view);
	if (!gitChanged && !revisionChanged && !viewChanged) return null;
	if (
		view.projectRevision < previous.projectRevision
		|| view.stateRevision !== previous.stateRevision
		|| (view.currentTrack?.ref ?? "project:initial") !== previous.trackRef
	) return "snapshot";
	return "delta";
}

export default function researchRuntimeExtension(pi: ExtensionAPI) {
	let runtime: RuntimeContext | undefined;
	let runtimeInputCwd: string | undefined;
	let localSessionId: string | undefined;
	let localAttachmentEpoch: string | undefined;
	let activeActivationId: string | undefined;
	const consumedMessageIds = new Set<string>();
	const supersededMessageIds = new Set<string>();
	const deliveringMessageIds = new Set<string>();
	const materializedMessages = new Map<string, {
		attachmentEpoch: string | null;
		requestId: string | null;
		type: string | null;
	}>();
	const migrationAttemptedProjects = new Set<string>();
	let projectViewText = "";
	let projectViewHash = "";
	let projectViewSnapshotHash = "";
	let projectViewDirty = true;
	let persistedProjectView: ProjectViewReceipt | undefined;
	let latestProjectView: Awaited<ReturnType<typeof buildProjectView>> | undefined;
	let latestCodexJobs: any[] = [];
	let runtimeDockTui: { requestRender?: () => void } | undefined;
	const runtimeDockClock = createRuntimeDockClock(() => runtimeDockTui?.requestRender?.());
	let attachmentLossNotified = false;
	let sessionInheritancePolicy: SessionInheritancePolicy = "project";
	let projectContextMode: ProjectContextMode = "project";
	let requestedInitialSessionMode: SessionInheritancePolicy | undefined =
		process.env.RESEARCH_PI_INITIAL_SESSION_MODE === "analysis" ? "analysis" : undefined;
	let lastUserPrompt = "";
	let projectWorkThisRun = false;
	const projectToolsThisRun = new Set<string>();
	const toolExecutionInputs = new Map<string, Record<string, unknown>>();
	const setSessionMode = (
		policy: SessionInheritancePolicy,
		context: ProjectContextMode = policy === "clean" ? "none" : "project",
	) => {
		sessionInheritancePolicy = policy;
		projectContextMode = context;
	};

	const isAnalysisSession = () => sessionInheritancePolicy === "analysis";
	const isProjectAwareSession = () => projectContextMode === "project";

	const ensureAnalysisSessionActor = async (activeRuntime: RuntimeContext, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const actorId = analysisSessionActorId(sessionId);
		await ensureRuntimeActor(activeRuntime, {
			id: actorId,
			kind: "analysis",
			label: `Analysis Session ${String(sessionId).slice(-8)}`,
			provider: "pi",
			metadata: { sessionId },
		});
		return actorId;
	};

	const getRuntime = async (
		ctx: ExtensionContext,
		options: { claim?: boolean; force?: boolean; onlyIfUnattached?: boolean; reason?: string } = {},
	): Promise<RuntimeContext> => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (runtime && runtimeInputCwd === ctx.cwd && localSessionId === sessionId) {
			if (!options.claim || await isRuntimeActorAttached(runtime, RESEARCH_LEADER_ACTOR_ID, sessionId)) return runtime;
		} else {
			runtime = await initializeResearchRuntime(ctx.cwd, {
				sessionId,
				branchAnchorId: ctx.sessionManager.getLeafId(),
			}, { attach: false });
			runtimeInputCwd = ctx.cwd;
			localSessionId = sessionId;
			const snapshot = await readRuntimeSnapshot(runtime);
			const existingAttachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID);
			if (existingAttachment?.sessionId === sessionId) localAttachmentEpoch = existingAttachment.epoch ?? undefined;
		}
		if (options.claim && !(await isRuntimeActorAttached(runtime, RESEARCH_LEADER_ACTOR_ID, sessionId))) {
			const claim = await claimRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, {
				sessionId,
				branchAnchorId: ctx.sessionManager.getLeafId(),
				reason: options.reason ?? (options.force ? "explicit takeover" : "user activity"),
			}, { force: options.force === true, onlyIfUnattached: options.onlyIfUnattached === true });
			if (claim.status === "busy" && !options.onlyIfUnattached) throw new RuntimeLeaderBusyError(claim.activation);
			if (claim.attachment?.sessionId === sessionId) localAttachmentEpoch = claim.attachment.epoch ?? undefined;
		}
		return runtime;
	};

	const refreshProjectView = async (ctx: ExtensionContext, suppliedSnapshot?: RuntimeSnapshot) => {
		const activeRuntime = await getRuntime(ctx);
		let snapshot = suppliedSnapshot ?? await readRuntimeSnapshot(activeRuntime);
		if (!snapshot.projectState && !migrationAttemptedProjects.has(activeRuntime.projectKey)) {
			const sessionId = ctx.sessionManager.getSessionId();
			const attachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, sessionId);
			if (attachment?.epoch && !snapshot.activeTransition && snapshot.revision === 0) {
				migrationAttemptedProjects.add(activeRuntime.projectKey);
				await migrateLatestProjectState({
					runtime: activeRuntime,
					sessionDir: resolveResearchPiPaths({ harnessRoot: HARNESS_ROOT }).sessionDir,
					cwd: ctx.cwd,
					leaderSessionId: sessionId,
					attachmentEpoch: attachment.epoch,
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
		latestProjectView = view;
		projectViewText = renderProjectView(view);
		projectViewHash = projectViewFingerprint(view);
		projectViewSnapshotHash = projectViewRefreshFingerprint(snapshot);
		projectViewDirty = false;
		return { snapshot, view };
	};

	const runtimeModelFromSnapshot = async (ctx: ExtensionContext, activeRuntime: RuntimeContext, snapshot: RuntimeSnapshot) => {
		let view = latestProjectView;
		if (!view) view = (await refreshProjectView(ctx, snapshot)).view;
		const health = runtimeHealth(snapshot, ctx.getContextUsage(), ctx.sessionManager.getBranch(), sessionInheritancePolicy);
		return buildRuntimeBoardModel({
			runtime: activeRuntime,
			snapshot,
			view,
			health,
			sessionId: ctx.sessionManager.getSessionId(),
			inheritancePolicy: sessionInheritancePolicy,
		});
	};

	const runtimeBoardModel = async (ctx: ExtensionContext) => {
		const activeRuntime = await getRuntime(ctx);
		const { snapshot, view } = await refreshProjectView(ctx);
		const health = runtimeHealth(snapshot, ctx.getContextUsage(), ctx.sessionManager.getBranch(), sessionInheritancePolicy);
		return buildRuntimeBoardModel({
			runtime: activeRuntime,
			snapshot,
			view,
			health,
			sessionId: ctx.sessionManager.getSessionId(),
			inheritancePolicy: sessionInheritancePolicy,
		});
	};

	const refreshDock = async (ctx: ExtensionContext, options: { snapshot?: RuntimeSnapshot; codexJobs?: any[] } = {}) => {
		if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
		if (options.codexJobs) latestCodexJobs = options.codexJobs;
		if (UI_RUNTIME_STRIP === "off") {
			runtimeDockClock.stop();
			runtimeDockTui = undefined;
			ctx.ui.setWidget(RUNTIME_DOCK_KEY, undefined);
			return;
		}
		const activeRuntime = await getRuntime(ctx);
		const snapshot = options.snapshot ?? await readRuntimeSnapshot(activeRuntime);
		const model = await runtimeModelFromSnapshot(ctx, activeRuntime, snapshot);
		if (!runtimeDockVisible(model, UI_RUNTIME_STRIP)) {
			runtimeDockClock.stop();
			runtimeDockTui = undefined;
			ctx.ui.setWidget(RUNTIME_DOCK_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			RUNTIME_DOCK_KEY,
			(tui, theme) => {
				runtimeDockTui = tui;
				return new RuntimeDockComponent(model, latestCodexJobs, theme, { density: UI_DENSITY });
			},
			{ placement: "aboveEditor" },
		);
		runtimeDockClock.setActive(runtimeDockNeedsClock(latestCodexJobs));
	};

	const refreshStatus = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const activeRuntime = await getRuntime(ctx);
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		const summary = runtimeActorSummary(snapshot);
		const open = unconsumedRuntimeMessages(snapshot).length;
		const showFooterStatus = summary.active > 0 || summary.waiting > 0 || open > 0 || sessionInheritancePolicy === "clean" || sessionInheritancePolicy === "analysis" || UI_RUNTIME_STRIP === "off";
		ctx.ui.setStatus(
			"research_runtime",
			showFooterStatus
				? `${formatRuntimeStatus(activeRuntime.projectKey, snapshot, sessionInheritancePolicy)}${isAnalysisSession() && !isProjectAwareSession() ? " · view off" : ""}`
				: undefined,
		);
		await refreshDock(ctx, { snapshot });
	};

	registerRuntimeUiAdapter({
		refresh: async (ctx: ExtensionContext, options: { codexJobs?: any[] } = {}) => refreshDock(ctx, options),
		deliver: async (ctx: ExtensionContext, options: { messageId: string }) => {
			const activeRuntime = await getRuntime(ctx);
			return await deliverLeaderMailboxMessage(activeRuntime, options.messageId, ctx, {
				triggerTurn: true,
				deferWhenBusy: true,
			});
		},
	});

	const showRuntimeBoard = async (ctx: ExtensionCommandContext) => {
		// The board is an observe-only surface. In particular, opening it must not
		// steal the Research Leader attachment from another Session; action
		// commands use `claim: true` explicitly when they need ownership.
		await getRuntime(ctx);
		const initial = await runtimeBoardModel(ctx);
		const result = await ctx.ui.custom<"close" | "view" | { action: "watch"; selector: string }>(
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
		else if (result && typeof result === "object" && result.action === "watch") {
			const watch = getCodexWatchAdapter();
			if (watch) await watch.open(ctx, result.selector);
			else ctx.ui.notify("Codex Watch adapter is not loaded.", "warning");
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
		message: RuntimeMessage,
		attachment: NonNullable<ReturnType<typeof runtimeActorAttachment>>,
		ctx: ExtensionContext,
		options: { preempt?: boolean; triggerTurn?: boolean; deferWhenBusy?: boolean } = {},
	) => {
		if (options.preempt && !ctx.isIdle()) ctx.abort();
		const idle = ctx.isIdle();
		if (!idle && options.deferWhenBusy) {
			return { status: "queued" as const, detail: "The Leader is still running; delivery remains in the Runtime mailbox" };
		}
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
					requestId: message.metadata?.requestId ?? null,
					jobId: message.metadata?.jobId ?? null,
					transient: true,
					attachmentEpoch: attachment.epoch ?? null,
				},
			},
			idle
				? { triggerTurn: options.triggerTurn ?? true }
				: { triggerTurn: false, deliverAs: "followUp" },
		);
		return {
			status: "delivered" as const,
			detail: idle ? "started a leader turn" : "queued for the next safe leader turn",
			attachmentEpoch: attachment.epoch ?? null,
		};
	};

	const deliverLeaderMailboxMessage = async (
		activeRuntime: RuntimeContext,
		messageId: string,
		ctx: ExtensionContext,
		options: { preempt?: boolean; triggerTurn?: boolean; deferWhenBusy?: boolean } = {},
	): Promise<"delivered" | "deferred" | "handled"> => {
		if (deliveringMessageIds.has(messageId)) return "deferred";
		deliveringMessageIds.add(messageId);
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			// Re-read immediately before send. The message may have been answered
			// and consumed after an earlier monitor snapshot was taken.
			const snapshot = await readRuntimeSnapshot(activeRuntime);
			const attachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, sessionId);
			if (!attachment) return "deferred";
			const message = unconsumedRuntimeMessages(snapshot, {
				to: RESEARCH_LEADER_ACTOR_ID,
				forSessionId: sessionId,
				forAttachmentEpoch: attachment?.epoch,
			}).find((candidate) => candidate.id === messageId);
			if (!message) return "handled";
			const result = await deliverToCurrentLeader(message, attachment, ctx, options);
			if (result.status !== "delivered") return "deferred";
			await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
				sessionId,
				actorId: RESEARCH_LEADER_ACTOR_ID,
				attachmentEpoch: result.attachmentEpoch,
			});
			return "delivered";
		} finally {
			deliveringMessageIds.delete(messageId);
		}
	};

	const deliverOpenLeaderMessages = async (
		activeRuntime: RuntimeContext,
		snapshot: RuntimeSnapshot,
		ctx: ExtensionContext,
		options: { triggerTurn?: boolean; deferWhenBusy?: boolean } = {},
	) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const currentSnapshot = await reconcileStaleCodexMailbox(activeRuntime, snapshot);
		for (const message of currentSnapshot.messages) {
			if (message.status === "superseded") supersededMessageIds.add(message.id);
		}
		let delivered = 0;
		const attachment = runtimeActorAttachment(currentSnapshot, RESEARCH_LEADER_ACTOR_ID, sessionId);
		for (const message of unconsumedRuntimeMessages(currentSnapshot, {
			to: RESEARCH_LEADER_ACTOR_ID,
			forSessionId: sessionId,
			forAttachmentEpoch: attachment?.epoch,
		})) {
			const result = await deliverLeaderMailboxMessage(activeRuntime, message.id, ctx, options);
			if (result === "delivered") delivered += 1;
		}
		return delivered;
	};

	const drainLeaderMailboxIfAttached = async (
		activeRuntime: RuntimeContext,
		ctx: ExtensionContext,
		options: { triggerTurn?: boolean; deferWhenBusy?: boolean } = {},
	) => {
		if (sessionInheritancePolicy !== "project") return null;
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		const sessionId = ctx.sessionManager.getSessionId();
		const attachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, sessionId);
		if (!attachment) return null;
		const open = unconsumedRuntimeMessages(snapshot, {
			to: RESEARCH_LEADER_ACTOR_ID,
			forSessionId: sessionId,
			forAttachmentEpoch: attachment.epoch,
		});
		if (!open.length) return 0;
		return await deliverOpenLeaderMessages(activeRuntime, snapshot, ctx, options);
	};

	const runtimeMailboxWatcher = createRuntimeMailboxWatcher({
		intervalMs: RUNTIME_MAILBOX_WATCH_INTERVAL_MS,
		drain: async (activeRuntime, ctx) => {
			if (sessionInheritancePolicy !== "project" || runtime !== activeRuntime) return null;
			return await drainLeaderMailboxIfAttached(activeRuntime, ctx, {
				triggerTurn: true,
				deferWhenBusy: true,
			});
		},
		onDelivered: async (ctx) => await refreshStatus(ctx),
		onWarning: async (ctx, message) => {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
		},
	});
	const stopRuntimeMailboxWatch = runtimeMailboxWatcher.stop;
	const startRuntimeMailboxWatch = runtimeMailboxWatcher.start;

	const dispatchMessage = async (
		activeRuntime: RuntimeContext,
		message: RuntimeMessage,
		actor: Awaited<ReturnType<typeof resolveRuntimeActor>>,
		ctx: ExtensionCommandContext,
		options: { preempt?: boolean } = {},
	) => {
		if (!actor) throw new Error("Runtime Actor is unavailable");
		if (actor.id === RESEARCH_LEADER_ACTOR_ID) {
			const delivery = await deliverLeaderMailboxMessage(activeRuntime, message.id, ctx, {
				preempt: options.preempt,
				triggerTurn: true,
			});
			return delivery === "deferred"
				? { status: "queued" as const, detail: "The message remains in the durable Leader mailbox" }
				: {
					status: "delivered" as const,
					detail: delivery === "delivered" ? "delivered to the attached Leader" : "already handled by the attached Leader",
					settledByDelivery: true,
				};
		}
		if (actor.kind === "codex") {
			const adapter = getCodexRuntimeAdapter();
			if (!adapter) return { status: "queued", detail: "Codex Runtime adapter is not loaded" };
			return await adapter.dispatch({ runtime: activeRuntime, actor, message, preempt: options.preempt === true, ctx });
		}
		return { status: "queued", detail: `${actor.label} has no live Provider adapter` };
	};

	pi.registerMessageRenderer<{
		messageId?: string;
		type?: string;
		from?: string;
		jobId?: string;
		status?: string;
		mode?: string;
		model?: string;
		reasoningEffort?: string;
		mission?: string | null;
	}>(RUNTIME_MESSAGE_KIND, (message, options, theme) => {
		const details = message.details ?? {};
		if (details.messageId && details.type === "ask" && supersededMessageIds.has(String(details.messageId))) {
			return new Text(
				`${theme.fg("success", "✓")} ${theme.fg("dim", `CODEX / ASK settled · ${String(details.messageId).slice(-8)} · obsolete request`)}`,
				0,
				0,
			);
		}
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const isCodex = Boolean(details.jobId) || String(details.from ?? "").startsWith("codex:");
		if (isCodex) {
			const status = String(details.status ?? details.type ?? "result");
			const icon = status === "completed"
				? theme.fg("success", "✓")
				: status === "failed" || status === "cancelled"
					? theme.fg("error", "✗")
					: theme.fg("warning", status === "input_required" ? "?" : "!");
			card.addChild(new Text(
				`${icon} ${theme.fg("customMessageLabel", theme.bold(` CODEX / ${String(details.type ?? "result").toUpperCase()} `))} ${theme.fg("muted", status)}`,
				0,
				0,
			));
			card.addChild(new Text(
				[
					details.mode,
					details.jobId ? String(details.jobId).slice(-8) : undefined,
					details.mission,
					details.model,
					details.reasoningEffort,
				].filter(Boolean).map(String).join(" · "),
				0,
				0,
			));
			if (options.expanded) {
				card.addChild(new Markdown(codexRuntimeMessageMarkdown(content), 0, 0, getMarkdownTheme()));
				card.addChild(new Text(theme.fg("dim", "Ctrl+O collapses · /watch shows objective execution events"), 0, 0));
			} else {
				card.addChild(new Text(codexRuntimeMessagePreview(content), 0, 0));
				card.addChild(new Text(theme.fg("dim", "Ctrl+O expands the Codex response"), 0, 0));
			}
			return card;
		}
		card.addChild(new Text(theme.fg("customMessageLabel", theme.bold(` RUNTIME / ${String(details.type ?? "message").toUpperCase()} `)), 0, 0));
		card.addChild(new Text(`${theme.fg("accent", compact(details.from ?? "unknown", 54))} ${theme.fg("dim", `· ${details.messageId ?? "unknown"}`)}`, 0, 0));
		card.addChild(new Text(compact(content, options.expanded ? 4000 : 280), 0, 0));
		if (!options.expanded) card.addChild(new Text(theme.fg("dim", "Ctrl+O expands Runtime details"), 0, 0));
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
		if (String(data.from ?? "").startsWith("codex:")) {
			const icon = data.status === "delivered" ? theme.fg("success", "✓") : theme.fg("warning", "!");
			card.addChild(new Text(`${icon} ${theme.fg("customMessageLabel", theme.bold(` CODEX / ${String(data.type).toUpperCase()} `))} ${theme.fg("muted", data.status)}`, 0, 0));
			card.addChild(new Text(`${theme.fg("accent", compact(data.from, 48))} ${theme.fg("dim", `· ${data.messageId}`)}`, 0, 0));
			if (expanded) card.addChild(new Markdown(codexRuntimeMessageMarkdown(data.body), 0, 0, getMarkdownTheme()));
			else card.addChild(new Text(codexRuntimeMessagePreview(data.body, 280), 0, 0));
			card.addChild(new Text(theme.fg("dim", `${expanded ? "Ctrl+O collapses" : "Ctrl+O expands the Codex response"}`), 0, 0));
			return card;
		}
		card.addChild(new Text(theme.fg("customMessageLabel", theme.bold(` RUNTIME / ${String(data.type).toUpperCase()} `)) + ` ${theme.fg(data.status === "delivered" ? "success" : "warning", data.status)}`, 0, 0));
		card.addChild(new Text(`${theme.fg("accent", compact(data.from, 36))} ${theme.fg("dim", "→")} ${compact(data.to, 36)}`, 0, 0));
		card.addChild(new Text(compact(data.body, expanded ? 4000 : 180), 0, 0));
		card.addChild(new Text(theme.fg("dim", `${expanded ? "Ctrl+O collapses" : "Ctrl+O expands"} · ${data.messageId}`), 0, 0));
		return card;
	});

	pi.on("session_start", async (event, ctx) => {
		stopRuntimeMailboxWatch();
		const provisionalPolicy = runtimeSessionInheritancePolicy(
			ctx.sessionManager.getBranch(),
			null,
			null,
			requestedInitialSessionMode ?? "project",
		) as SessionInheritancePolicy;
		// Resolve the requested role before touching Runtime. An initialization
		// failure must never promote an Analysis Session through the default.
		setSessionMode(provisionalPolicy, runtimeSessionProjectContext(ctx.sessionManager.getBranch(), provisionalPolicy) as ProjectContextMode);
		const activeRuntime = await getRuntime(ctx, {
			claim: provisionalPolicy === "project",
			onlyIfUnattached: true,
			reason: "first live Leader Session",
		});
		let snapshot = await readRuntimeSnapshot(activeRuntime);
		if (requestedInitialSessionMode === "analysis") {
			pi.appendEntry(RUNTIME_SESSION_POLICY_ENTRY_KIND, {
				policy: "analysis",
				projectContext: "project",
				reason: "pi --analysis",
				projectKey: activeRuntime.projectKey,
			});
			setSessionMode("analysis");
			requestedInitialSessionMode = undefined;
		} else {
			const policy = runtimeSessionInheritancePolicy(
				ctx.sessionManager.getBranch(),
				snapshot,
				ctx.sessionManager.getSessionId(),
			) as SessionInheritancePolicy;
			setSessionMode(policy, runtimeSessionProjectContext(ctx.sessionManager.getBranch(), policy) as ProjectContextMode);
		}
		persistedProjectView = isProjectAwareSession()
			? latestProjectViewReceipt(ctx.sessionManager.getBranch())
			: undefined;
		let view: Awaited<ReturnType<typeof refreshProjectView>>["view"] | null = null;
		consumedMessageIds.clear();
		supersededMessageIds.clear();
		materializedMessages.clear();
		if (event.reason === "new") {
			const currentSessionId = ctx.sessionManager.getSessionId();
			const pendingInheritance = [...(snapshot.pendingInheritanceRequests ?? [])].reverse().find((request) => {
				if (event.previousSessionFile && request.fromSessionFile) return event.previousSessionFile === request.fromSessionFile;
				return !event.previousSessionFile && !request.fromSessionFile && request.fromSessionId !== currentSessionId;
			});
			if (pendingInheritance) {
				setSessionMode(pendingInheritance.policy as SessionInheritancePolicy);
				await settleRuntimeSessionInheritance(activeRuntime, pendingInheritance.id, "applied", {
					toSessionId: currentSessionId,
					toSessionFile: ctx.sessionManager.getSessionFile(),
				});
				snapshot = await readRuntimeSnapshot(activeRuntime);
			}
			if (isProjectAwareSession()) {
				const refreshed = await refreshProjectView(ctx, snapshot);
				snapshot = refreshed.snapshot;
				view = refreshed.view;
			} else {
				projectViewText = "";
				projectViewHash = "";
				projectViewSnapshotHash = projectViewRefreshFingerprint(snapshot);
				projectViewDirty = false;
			}
			const pendingRotation = [...(snapshot.pendingRotations ?? [])].reverse().find((rotation) => {
				if (rotation.fromSessionId === currentSessionId) return false;
				if (event.previousSessionFile && rotation.fromSessionFile) {
					return event.previousSessionFile === rotation.fromSessionFile;
				}
				return !event.previousSessionFile || !rotation.fromSessionFile;
			});
			if (pendingRotation && view) {
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
		} else if (isProjectAwareSession()) {
			const refreshed = await refreshProjectView(ctx, snapshot);
			snapshot = refreshed.snapshot;
			view = refreshed.view;
		} else {
			projectViewText = "";
			projectViewHash = "";
			projectViewSnapshotHash = projectViewRefreshFingerprint(snapshot);
			projectViewDirty = false;
		}
		for (const message of snapshot.messages) {
			if (message.status === "consumed") consumedMessageIds.add(message.id);
			if (message.status === "superseded") supersededMessageIds.add(message.id);
		}
		if (sessionInheritancePolicy === "analysis") {
			if (await isRuntimeActorAttached(activeRuntime, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId())) {
				await detachRuntimeActor(activeRuntime, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId(), localAttachmentEpoch);
				localAttachmentEpoch = undefined;
			}
			await ensureAnalysisSessionActor(activeRuntime, ctx);
		} else if (sessionInheritancePolicy === "project") {
			if (await isRuntimeActorAttached(activeRuntime, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId())) {
				startRuntimeMailboxWatch(activeRuntime, ctx);
			}
			await deliverOpenLeaderMessages(activeRuntime, snapshot, ctx, { triggerTurn: false });
		} else if (ctx.hasUI) {
			ctx.ui.notify("Clean Runtime Session: ProjectView and mailbox injection are paused. Use /runtime inherit to restore them.", "info");
		}
		await refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopRuntimeMailboxWatch();
		runtimeDockClock.stop();
		runtimeDockTui = undefined;
		if (!runtime || !localSessionId) return;
		if (activeActivationId) {
			await settleRuntimeActorActivation(runtime, activeActivationId, { reason: "session shutdown" });
			activeActivationId = undefined;
		}
		await detachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, localSessionId, localAttachmentEpoch);
		if (ctx.hasUI) {
			ctx.ui.setStatus("research_runtime", undefined);
			if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(RUNTIME_DOCK_KEY, undefined);
		}
		runtime = undefined;
		runtimeInputCwd = undefined;
		localSessionId = undefined;
		localAttachmentEpoch = undefined;
		consumedMessageIds.clear();
		supersededMessageIds.clear();
		projectViewSnapshotHash = "";
		projectViewDirty = true;
		persistedProjectView = undefined;
		latestProjectView = undefined;
		latestCodexJobs = [];
		toolExecutionInputs.clear();
		setSessionMode("project");
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		lastUserPrompt = event.text.trim();
		if (/^\/runtime\s+analysis(?:\s|$)/.test(event.text.trim())) return;
		try {
			const activeRuntime = await getRuntime(ctx, { claim: sessionInheritancePolicy === "project" });
			attachmentLossNotified = false;
			if (isAnalysisSession()) {
				if (isProjectAwareSession()) await refreshProjectView(ctx);
			} else if (sessionInheritancePolicy === "project") {
				startRuntimeMailboxWatch(activeRuntime, ctx);
				const { snapshot } = await refreshProjectView(ctx);
				if (await deliverOpenLeaderMessages(activeRuntime, snapshot, ctx, { triggerTurn: false })) {
					await refreshProjectView(ctx);
				}
			}
		} catch (error) {
			if (!(error instanceof RuntimeLeaderBusyError)) throw error;
			if (ctx.hasUI) {
				ctx.ui.setEditorText(event.text);
				ctx.ui.notify(error.message, "warning");
			}
			return { action: "handled" as const };
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isProjectAwareSession()) return;
		const activeRuntime = await getRuntime(ctx);
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		if (!isAnalysisSession() && !runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId())) return;
		if (projectViewDirty || projectViewRefreshFingerprint(snapshot) !== projectViewSnapshotHash) {
			await refreshProjectView(ctx, snapshot);
		}
		const view = latestProjectView ?? (await refreshProjectView(ctx, snapshot)).view;
		// Re-read receipts after compaction/tree changes. A receipt before the
		// latest compaction is no longer present in provider context.
		persistedProjectView = latestProjectViewReceipt(ctx.sessionManager.getBranch());
		const previous = persistedProjectView;
		const mode = projectViewPersistenceMode(view, previous);
		if (!mode) return;
		const rawContent = mode === "snapshot"
			? isAnalysisSession()
				? renderProjectView(view, { includeDirectedMessages: false })
				: projectViewText
			: renderProjectViewDelta(view, previous);
		const content = sessionRoleContext(isAnalysisSession() ? "analysis" : "leader", rawContent);
		persistedProjectView = projectViewReceipt(view, mode);
		return {
			message: {
				customType: PROJECT_VIEW_KIND,
				content,
				display: false,
				details: persistedProjectView,
			},
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		projectWorkThisRun = false;
		projectToolsThisRun.clear();
		if (isAnalysisSession()) return;
		const activeRuntime = await getRuntime(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		const attachment = runtimeActorAttachment(await readRuntimeSnapshot(activeRuntime), RESEARCH_LEADER_ACTOR_ID, sessionId);
		if (!attachment) {
			ctx.abort();
			if (ctx.hasUI) ctx.ui.notify("This is no longer the Leader Session; the agent run was stopped before further model work.", "warning");
			return;
		}
		try {
			const activation = await startRuntimeActorActivation(activeRuntime, RESEARCH_LEADER_ACTOR_ID, {
				sessionId,
				attachmentEpoch: attachment.epoch,
			});
			activeActivationId = activation.id;
		} catch (error) {
			if (!(error instanceof RuntimeAttachmentChangedError)) throw error;
			ctx.abort();
			if (ctx.hasUI) ctx.ui.notify("Leader Session ownership changed while this run was starting; no model work was allowed to begin.", "warning");
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!runtime || !activeActivationId) return;
		const activationId = activeActivationId;
		try {
			if (!isAnalysisSession() && projectWorkThisRun) {
				const summary = latestAssistantText(event.messages);
				if (summary) {
					await recordRuntimeHandoff(runtime, {
						id: activationId,
						kind: handoffKind(projectToolsThisRun),
						task: lastUserPrompt,
						summary,
						sessionId: ctx.sessionManager.getSessionId(),
						actorId: RESEARCH_LEADER_ACTOR_ID,
						toolNames: [...projectToolsThisRun],
						git: await getGitSnapshot(ctx.cwd),
					});
					projectViewDirty = true;
				}
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not record ProjectView task handoff: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			await settleRuntimeActorActivation(runtime, activationId, { reason: "agent end" });
			activeActivationId = undefined;
		}
	});

	pi.on("tool_call", (event) => {
		const reason = analysisSessionToolBlockReason(
			sessionInheritancePolicy,
			event.toolName,
			(event.input ?? {}) as Record<string, unknown>,
		);
		return reason ? { block: true, reason, terminate: false } : undefined;
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName === "codex_delegate") {
			toolExecutionInputs.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
		}
	});

	pi.on("tool_execution_end", (event) => {
		const input = toolExecutionInputs.get(event.toolCallId) ?? {};
		toolExecutionInputs.delete(event.toolCallId);
		// Refresh only after tools that can change project evidence, Git, files,
		// or Runtime delegation state. The next context hook performs one
		// deterministic rebuild; pure Codex status/result reads preserve the
		// exact prompt suffix and cannot manufacture another ProjectView delta.
		if (isAnalysisSession() && event.toolName === "bash") return;
		if (projectViewToolMutates(event.toolName, input)) {
			projectViewDirty = true;
			const codexStatus = event.toolName === "codex_delegate" ? String(event.result?.details?.status ?? "") : "";
			const codexTurnSettled = !codexStatus || ["completed", "failed", "cancelled", "outcome_unknown"].includes(codexStatus);
			if (!event.isError && codexTurnSettled) {
				projectWorkThisRun = true;
				projectToolsThisRun.add(event.toolName);
			}
		}
	});

	pi.on("context", async (event, ctx) => {
		const activeRuntime = await getRuntime(ctx);
		const snapshot = await readRuntimeSnapshot(activeRuntime);
		for (const message of snapshot.messages) {
			if (message.status === "superseded") supersededMessageIds.add(message.id);
		}
		const sessionId = ctx.sessionManager.getSessionId();
		if (!isAnalysisSession() && !runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, sessionId)) {
			ctx.abort();
			if (ctx.hasUI && !attachmentLossNotified) {
				attachmentLossNotified = true;
				ctx.ui.notify("Leader Session ownership moved to another Session; this run stopped at the next model boundary.", "warning");
			}
			return { messages: event.messages };
		}
		if (!isProjectAwareSession()) {
			return {
				messages: event.messages.filter((message) =>
					message.customType !== PROJECT_VIEW_KIND
					&& message.customType !== PROJECT_VIEW_DELTA_KIND
					&& message.customType !== RUNTIME_MESSAGE_KIND,
				),
			};
		}
		const snapshotHash = projectViewRefreshFingerprint(snapshot);
		if (projectViewDirty || snapshotHash !== projectViewSnapshotHash) await refreshProjectView(ctx, snapshot);
		const runtimeMessagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
		const messages = event.messages.filter((message) => {
			if (isAnalysisSession() && message.role === "custom" && message.customType === RUNTIME_MESSAGE_KIND) return false;
			if (message.role !== "custom" || message.customType !== RUNTIME_MESSAGE_KIND) return true;
			const messageId = String(message.details?.messageId ?? "");
			if (!messageId) return true;
			if (consumedMessageIds.has(messageId)) return false;
			const runtimeMessage = runtimeMessagesById.get(messageId);
			if (runtimeMessage?.status === "consumed" || runtimeMessage?.status === "superseded") {
				consumedMessageIds.add(messageId);
				return false;
			}
			materializedMessages.set(messageId, {
				attachmentEpoch: String(message.details?.attachmentEpoch ?? "") || null,
				requestId: String(message.details?.requestId ?? "") || null,
				type: String(message.details?.type ?? "") || null,
			});
			return true;
		});
		const view = latestProjectView ?? (await refreshProjectView(ctx, snapshot)).view;
		const hasPersistentView = messages.some((message) =>
			message.role === "custom" && message.customType === PROJECT_VIEW_KIND && message.details?.persistent === true,
		);
		let updateText = "";
		if (!hasPersistentView) {
			updateText = isAnalysisSession()
				? renderProjectView(view, { includeDirectedMessages: false })
				: projectViewText;
		} else if (
			!persistedProjectView
			|| view.projectRevision !== persistedProjectView.projectRevision
			|| projectViewGitFingerprint(view) !== persistedProjectView.gitFingerprint
			|| projectViewFingerprint(view) !== persistedProjectView.fingerprint
		) {
			updateText = renderProjectViewDelta(view, persistedProjectView);
		}
		if (updateText) updateText = sessionRoleContext(isAnalysisSession() ? "analysis" : "leader", updateText);
		return {
			messages: materializeProjectViewDelta(messages, updateText, {
				fingerprint: projectViewHash,
				projectRevision: view.projectRevision,
			}),
		};
	});

	pi.on("session_compact", async (event, ctx) => {
		if (sessionInheritancePolicy === "clean") {
			if (ctx.hasUI) ctx.ui.notify("Clean Session compaction remains session-local and did not replace Project State.", "info");
			return;
		}
		if (sessionInheritancePolicy === "analysis") {
			if (ctx.hasUI) ctx.ui.notify("Analysis Session compaction remains local and did not replace Project State.", "info");
			return;
		}
		const activeRuntime = await getRuntime(ctx, { claim: true });
		const sessionId = ctx.sessionManager.getSessionId();
		const attachment = runtimeActorAttachment(await readRuntimeSnapshot(activeRuntime), RESEARCH_LEADER_ACTOR_ID, sessionId);
		if (!attachment?.epoch) {
			if (ctx.hasUI) ctx.ui.notify("Research compact remained Session-local because Leader ownership changed before Project State commit.", "warning");
			return;
		}
		const result = await commitProjectState(activeRuntime, {
			compactionEntry: event.compactionEntry,
			sessionId,
			attachmentEpoch: attachment.epoch,
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
		if (result?.status === "stale_attachment" && ctx.hasUI) {
			ctx.ui.notify("Research compact remained Session-local because Leader ownership changed during Project State commit.", "warning");
		}
		await refreshProjectView(ctx);
		await refreshStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		let activeRuntime: RuntimeContext | undefined;
		let runtimeChanged = false;
		if (materializedMessages.size) {
			activeRuntime = await getRuntime(ctx);
			const sessionId = ctx.sessionManager.getSessionId();
			const consumableIds = [...materializedMessages].flatMap(([messageId, materialized]) => {
				// A blocking Codex ask is only settled when a response/approval is
				// actually queued. Merely showing it to the Leader must not make the
				// Runtime inbox look empty while the underlying job still waits.
				return materialized.type === "ask" && materialized.requestId ? [] : [messageId];
			});
			if (consumableIds.length) {
				const results = await consumeRuntimeMessagesForAttachment(activeRuntime, consumableIds, {
					sessionId,
					actorId: RESEARCH_LEADER_ACTOR_ID,
				});
				for (const result of results) {
					if (result.status === "consumed") consumedMessageIds.add(result.messageId);
				}
			}
			materializedMessages.clear();
			runtimeChanged = true;
		}
		if (sessionInheritancePolicy === "project") {
			activeRuntime ??= await getRuntime(ctx);
			const delivered = await drainLeaderMailboxIfAttached(activeRuntime, ctx, {
				triggerTurn: true,
				deferWhenBusy: true,
			});
			if (delivered) runtimeChanged = true;
		}
		if (runtimeChanged) {
			await refreshProjectView(ctx);
			await refreshStatus(ctx);
		}
	});

	const queueAnalysisForLeader = async (body: string, ctx: ExtensionContext) => {
		if (!isAnalysisSession()) throw new Error("This command is available only in an Analysis Session.");
		const activeRuntime = await getRuntime(ctx);
		const actorId = await ensureAnalysisSessionActor(activeRuntime, ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		const message = await createRuntimeMessage(activeRuntime, {
			type: "notify",
			from: actorId,
			to: RESEARCH_LEADER_ACTOR_ID,
			body: `[Analysis Session handoff ${String(sessionId).slice(-8)}]\n${body.trim()}`,
			metadata: { kind: "analysis_handoff", sourceSessionId: sessionId },
		});
		await refreshStatus(ctx);
		return message;
	};

	pi.registerTool({
		name: "analysis_send_to_leader",
		label: "Send Analysis to Leader",
		description: "Send a concise discussion synthesis or recommendation from this read-only Analysis Session to the durable mailbox of the current Leader Session. This does not update Project State or count as evidence.",
		promptSnippet: "Send a concise candidate analysis to the working Leader without changing Project State",
		promptGuidelines: [
			"Use only when the user wants the working Leader to receive a useful synthesis, competing explanation, question, or recommendation.",
			"Separate observations already present in ProjectView from your new interpretation. The message is a proposal, not experimental evidence.",
		],
		parameters: Type.Object({
			message: Type.String({ minLength: 1, maxLength: 12_000, description: "Concise analysis to queue for the Leader Session" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const message = await queueAnalysisForLeader(params.message, ctx);
				return {
					content: [{ type: "text", text: `Queued ${message.id} for the Leader Session. It remains a proposal until the Leader or user promotes it into Project State.` }],
					details: { messageId: message.id, status: message.status },
				};
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
		},
	});

	pi.registerCommand("analysis", {
		description: "Send a discussion synthesis to the Leader (/analysis send <message>)",
		handler: async (args, ctx) => {
			try {
				const match = args.trim().match(/^send\s+([\s\S]+)$/);
				if (!match) throw new Error("Usage: /analysis send <message>");
				const message = await queueAnalysisForLeader(match[1], ctx);
				ctx.ui.notify(`${message.id} queued for the Leader Session; Project State was not changed.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("runtime", {
		description: "Open Project Runtime, enter Analysis Session mode, or explicitly hand off the Leader Session",
		handler: async (args, ctx) => {
			try {
				const [mode = "board", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (!["board", "health", "recommend", "view", "rotate", "takeover", "analysis", "context", "promote", "new", "inherit"].includes(mode)) {
					throw new Error("Usage: /runtime [board|health|recommend|view|analysis [reason]|context <on|off>|promote <reason>|rotate [reason]|takeover <reason>|new <clean|analysis> [reason]|inherit [reason]]");
				}
				if (mode === "board") {
					await showRuntimeBoard(ctx);
					await refreshStatus(ctx);
					return;
				}
				if (mode === "context") {
					if (!isAnalysisSession()) throw new Error("/runtime context is for Analysis Sessions; Leader Sessions always use Project context.");
					const requested = rest[0];
					if (requested !== "on" && requested !== "off") throw new Error("Usage: /runtime context <on|off>");
					const activeRuntime = await getRuntime(ctx);
					projectContextMode = requested === "on" ? "project" : "none";
					pi.appendEntry(RUNTIME_SESSION_POLICY_ENTRY_KIND, {
						policy: "analysis",
						projectContext: projectContextMode,
						reason: `Analysis ProjectView ${requested}`,
						projectKey: activeRuntime.projectKey,
					});
					persistedProjectView = undefined;
					if (projectContextMode === "project") {
						await refreshProjectView(ctx);
					} else {
						projectViewText = "";
						projectViewHash = "";
						latestProjectView = undefined;
					}
					ctx.ui.notify(`Analysis ProjectView is now ${requested === "on" ? "enabled" : "disabled"}; the Analysis role and capability policy did not change.`, "info");
					await refreshStatus(ctx);
					return;
				}
				if (mode === "takeover") {
					if (isAnalysisSession()) throw new Error("Analysis Session promotion must be explicit: use /runtime promote <reason>.");
					const reason = rest.join(" ").trim();
					if (!reason) throw new Error("Usage: /runtime takeover <reason>");
					const activeRuntime = await getRuntime(ctx, { claim: true, force: true, reason });
					attachmentLossNotified = false;
					if (sessionInheritancePolicy === "project") {
						startRuntimeMailboxWatch(activeRuntime, ctx);
						const { snapshot } = await refreshProjectView(ctx);
						if (await deliverOpenLeaderMessages(activeRuntime, snapshot, ctx, { triggerTurn: true })) {
							await refreshProjectView(ctx);
						}
					}
					ctx.ui.notify(
						`This ${sessionInheritancePolicy === "clean" ? "clean " : ""}Session is now the Leader Session. A previous active Session will stop at its next model boundary.`,
						"warning",
					);
					await refreshStatus(ctx);
					return;
				}
				if (mode === "analysis") {
					const reason = rest.join(" ").trim() || "read-only discussion and analysis";
					const activeRuntime = await getRuntime(ctx);
					if (await isRuntimeActorAttached(activeRuntime, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId())) {
						await detachRuntimeActor(activeRuntime, RESEARCH_LEADER_ACTOR_ID, ctx.sessionManager.getSessionId(), localAttachmentEpoch);
						localAttachmentEpoch = undefined;
					}
					pi.appendEntry(RUNTIME_SESSION_POLICY_ENTRY_KIND, {
						policy: "analysis",
						projectContext: "project",
						reason,
						projectKey: activeRuntime.projectKey,
					});
					setSessionMode("analysis");
					stopRuntimeMailboxWatch();
					persistedProjectView = undefined;
					await ensureAnalysisSessionActor(activeRuntime, ctx);
					await refreshProjectView(ctx);
					ctx.ui.notify("This is now an Analysis Session: local and approved remote evidence are readable, but execution and Project State writes are blocked. The Leader mailbox remains with the Leader Session.", "info");
					await refreshStatus(ctx);
					return;
				}
				if (mode === "promote") {
					if (!isAnalysisSession()) throw new Error("Only an Analysis Session needs promotion; this Session is already a Leader or clean Session.");
					const reason = rest.join(" ").trim();
					if (!reason) throw new Error("Usage: /runtime promote <reason>");
					const activeRuntime = await getRuntime(ctx, { claim: true, force: true, reason });
					pi.appendEntry(RUNTIME_SESSION_POLICY_ENTRY_KIND, {
						policy: "project",
						projectContext: "project",
						reason,
						projectKey: activeRuntime.projectKey,
					});
					setSessionMode("project");
					startRuntimeMailboxWatch(activeRuntime, ctx);
					persistedProjectView = undefined;
					attachmentLossNotified = false;
					const { snapshot } = await refreshProjectView(ctx);
					await deliverOpenLeaderMessages(activeRuntime, snapshot, ctx, { triggerTurn: false });
					ctx.ui.notify("This Session is now the Leader Session. Execution tools and the durable Leader mailbox are active; a previous Leader will stop at its next model boundary.", "warning");
					await refreshStatus(ctx);
					return;
				}
				if (mode === "new") {
					if (!["clean", "analysis"].includes(rest[0] ?? "")) throw new Error("Usage: /runtime new <clean|analysis> [reason]");
					await ctx.waitForIdle();
					const policy = rest[0] as "clean" | "analysis";
					const activeRuntime = await getRuntime(ctx, { claim: sessionInheritancePolicy === "project" });
					const reason = rest.slice(1).join(" ").trim() || (policy === "analysis" ? "fresh read-only Analysis Session" : "explicit clean-context Session");
					const request = await requestRuntimeSessionInheritance(activeRuntime, {
						policy,
						fromSessionId: ctx.sessionManager.getSessionId(),
						fromSessionFile: ctx.sessionManager.getSessionFile(),
						reason,
					});
					let result;
					try {
						result = await ctx.newSession({
							setup: async (sessionManager) => {
								sessionManager.appendCustomEntry(RUNTIME_SESSION_POLICY_ENTRY_KIND, {
									policy,
									projectContext: policy === "clean" ? "none" : "project",
									requestId: request.id,
									reason,
									projectKey: activeRuntime.projectKey,
								});
							},
						});
					} catch (error) {
						await settleRuntimeSessionInheritance(activeRuntime, request.id, "cancelled", {
							reason: `Session replacement failed: ${error instanceof Error ? error.message : String(error)}`,
						});
						throw error;
					}
					if (result.cancelled) {
						await settleRuntimeSessionInheritance(activeRuntime, request.id, "cancelled", {
							reason: "Pi session replacement was cancelled",
						});
						ctx.ui.notify(`${policy === "analysis" ? "Analysis" : "Clean"} Session creation was cancelled; the current Session remains unchanged.`, "info");
					}
					return;
				}
				if (mode === "inherit") {
					await ctx.waitForIdle();
					if (isAnalysisSession()) throw new Error("Use /runtime promote <reason> to turn an Analysis Session into the Leader Session.");
					const activeRuntime = await getRuntime(ctx, { claim: true });
					if (sessionInheritancePolicy === "project") {
						ctx.ui.notify("This Session already inherits ProjectView and Runtime mailbox.", "info");
						return;
					}
					const reason = rest.join(" ").trim() || "explicitly restore Project inheritance";
					pi.appendEntry(RUNTIME_SESSION_POLICY_ENTRY_KIND, {
						policy: "project",
						projectContext: "project",
						reason,
						projectKey: activeRuntime.projectKey,
					});
					setSessionMode("project");
					startRuntimeMailboxWatch(activeRuntime, ctx);
					const { snapshot } = await refreshProjectView(ctx);
					await deliverOpenLeaderMessages(activeRuntime, snapshot, ctx, { triggerTurn: false });
					ctx.ui.notify("Project inheritance restored. ProjectView and open mailbox messages will enter subsequent turns.", "info");
					await refreshStatus(ctx);
					return;
				}
				if (mode === "rotate") {
					if (isAnalysisSession()) throw new Error("Analysis Session cannot rotate the Leader. Use /runtime promote <reason>, or continue analysis without taking execution ownership.");
					if (sessionInheritancePolicy === "clean") {
						throw new Error("/runtime rotate is a Project-aware handoff. Use /runtime inherit first, or continue the clean Session without Project inheritance.");
					}
					await ctx.waitForIdle();
				}
				const activeRuntime = await getRuntime(ctx, { claim: mode === "rotate" });
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
					const health = runtimeHealth(snapshot, ctx.getContextUsage(), ctx.sessionManager.getBranch(), sessionInheritancePolicy);
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
				const activeRuntime = await getRuntime(ctx);
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
				const activeRuntime = await getRuntime(ctx);
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
				if (isAnalysisSession()) throw new Error("Analysis Session cannot send operational Actor messages. Use /analysis send <message> to hand a proposal to the Leader Session.");
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
				if (result.status === "delivered" && !result.settledByDelivery) await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
					actorId: actor.id,
					...(actor.id === RESEARCH_LEADER_ACTOR_ID ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
					...(actor.id === RESEARCH_LEADER_ACTOR_ID ? { attachmentEpoch: result.attachmentEpoch } : {}),
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
				if (isAnalysisSession()) throw new Error("Analysis Session cannot steer project Actors. Send analysis to the Leader or use /runtime promote <reason> first.");
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
				if (result.status === "delivered" && !result.settledByDelivery) await settleRuntimeMessage(activeRuntime, message.id, "delivered", {
					actorId: actor.id,
					...(actor.id === RESEARCH_LEADER_ACTOR_ID ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
					...(actor.id === RESEARCH_LEADER_ACTOR_ID ? { attachmentEpoch: result.attachmentEpoch } : {}),
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
