import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RESEARCH_COMPACTION_KIND, RESEARCH_COMPACTION_VERSION } from "./research-compact.mjs";
import { RESEARCH_LEADER_ACTOR_ID, runtimeResearchTrack, runtimeTrackStatus } from "./research-runtime.mjs";

export const PROJECT_VIEW_KIND = "research-project-view";
export const PROJECT_VIEW_DELTA_KIND = "research-project-view-delta";
export const PROJECT_VIEW_VERSION = 5;
const MAX_SESSION_FILES = 24;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

function compact(value, limit = 500) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function list(value, limit) {
	return Array.isArray(value) ? value.slice(0, limit) : [];
}

function fingerprint(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

const LIVE_ACTION_STATUSES = new Set(["starting", "running", "input_required", "cancelling", "outcome_unknown"]);
const TERMINAL_ACTION_STATUSES = new Set(["completed", "failed", "cancelled"]);

// The Runtime ledger also contains UI/session lifecycle events. Those events
// must not churn the model-facing ProjectView or its prompt-cache suffix.
// Research revisions, live Actions, and durable work handoffs are the only
// snapshot fields that can change the rendered Delta between explicit refreshes.
export function projectViewRefreshFingerprint(snapshot = {}) {
	return fingerprint({
		projectRevision: snapshot.revision ?? 0,
		actions: (snapshot.actions ?? [])
			.filter((action) => LIVE_ACTION_STATUSES.has(action.status))
			.map((action) => ({
				id: action.id,
				status: action.status,
				label: action.label ?? null,
				externalId: action.externalId ?? null,
				trackRef: action.trackRef ?? null,
			})),
		handoffs: (snapshot.handoffs ?? []).slice(-4).map((handoff) => ({
			id: handoff.id,
			task: handoff.task,
			summary: handoff.summary,
			trackRef: handoff.trackRef ?? null,
			recordedAt: handoff.recordedAt ?? null,
		})),
	});
}

export async function commitProjectState(runtime, input) {
	const entry = input.compactionEntry;
	if (
		entry?.type !== "compaction"
		|| entry.details?.kind !== RESEARCH_COMPACTION_KIND
		|| entry.details?.version !== RESEARCH_COMPACTION_VERSION
		|| !entry.details?.researchState
	) return null;
	if (!input.attachmentEpoch) throw new Error("Project State commit requires the current Leader attachment");
	const snapshot = await input.readRuntimeSnapshot(runtime);
	const track = runtimeResearchTrack(snapshot);
	const basedOnRevision = Number.isInteger(entry.details.projectRevision)
		? entry.details.projectRevision
		: snapshot.revision;
	const source = {
		sessionId: String(input.sessionId),
		entryId: String(entry.id),
		contentHash: fingerprint(entry.details.researchState),
		generatedAt: entry.details.generatedAt ?? null,
		basedOnRevision,
		git: input.git ? {
			root: input.git.root ?? null,
			branch: input.git.branch ?? null,
			commit: input.git.commit ?? null,
			dirty: input.git.dirty ?? null,
		} : null,
		warnings: Array.isArray(entry.details.validationWarnings) ? entry.details.validationWarnings.slice(0, 20) : [],
		trackRef: track.ref,
		trackLabel: track.label,
	};
	const leaderSessionId = String(input.leaderSessionId ?? input.sessionId);
	const result = await input.appendRuntimeEventAtRevision(runtime, "project.state.committed", {
		state: entry.details.researchState,
		source,
	}, basedOnRevision, {
		id: `project-state:${source.sessionId}:${source.entryId}`,
		expectedAttachment: {
			actorId: RESEARCH_LEADER_ACTOR_ID,
			sessionId: leaderSessionId,
			attachmentEpoch: input.attachmentEpoch,
		},
	});
	if (result.status === "stale_attachment") return result;
	if (result.status !== "conflict") return result;
	await input.appendRuntimeEvent(runtime, "project.state.rejected", {
		source,
		reason: `Compaction was based on Project revision ${basedOnRevision}, but current revision is ${result.revision}`,
		currentRevision: result.revision,
	}, { id: `project-state-rejected:${source.sessionId}:${source.entryId}` });
	return result;
}

function activeBranch(entries) {
	const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
	let current = [...entries].reverse().find((entry) => entry?.id);
	const branch = [];
	const seen = new Set();
	while (current?.id && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

async function sessionCandidates(sessionDir) {
	let names;
	try {
		names = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const described = await Promise.all(names.map(async (name) => {
		const path = join(sessionDir, name);
		const info = await stat(path).catch(() => null);
		return info ? { path, mtimeMs: info.mtimeMs, size: info.size } : null;
	}));
	return described.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSION_FILES);
}

export async function migrateLatestProjectState({ runtime, sessionDir, cwd, leaderSessionId, attachmentEpoch, appendRuntimeEvent, appendRuntimeEventAtRevision, readRuntimeSnapshot }) {
	let bytes = 0;
	for (const candidate of await sessionCandidates(sessionDir)) {
		if (bytes + candidate.size > MAX_SESSION_BYTES) break;
		bytes += candidate.size;
		let records;
		try {
			records = (await readFile(candidate.path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
		} catch {
			continue;
		}
		const header = records[0];
		if (header?.type !== "session" || resolve(header.cwd) !== resolve(cwd)) continue;
		const compaction = [...activeBranch(records)].reverse().find((entry) =>
			entry?.type === "compaction"
			&& entry.details?.kind === RESEARCH_COMPACTION_KIND
			&& entry.details?.version === RESEARCH_COMPACTION_VERSION
			&& entry.details?.researchState,
		);
		if (!compaction) continue;
		return await commitProjectState(runtime, {
			compactionEntry: compaction,
			sessionId: header.id,
			leaderSessionId,
			attachmentEpoch,
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
	}
	return null;
}

export async function readRecentExperiments(path, maxRecords = 6) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const records = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (record?.id && record?.question) records.push(record);
		} catch {
			// A partial final append must not erase older valid research records.
		}
	}
	return records.slice(-maxRecords);
}

export function buildProjectView({ runtime, snapshot, git = {}, experiments = [] }) {
	const currentTrack = runtimeResearchTrack(snapshot);
	const briefState = snapshot.projectBrief?.state ?? snapshot.projectState?.state ?? null;
	const actions = snapshot.actions.filter((action) =>
		LIVE_ACTION_STATUSES.has(action.status),
	).slice(-8).map((action) => ({ ...action, routeStatus: runtimeTrackStatus(snapshot, action.trackRef) }));
	const handoffs = [...(snapshot.handoffs ?? [])]
		.sort((left, right) => Date.parse(left.recordedAt ?? "") - Date.parse(right.recordedAt ?? ""))
		.slice(-6)
		.map((handoff) => ({ ...handoff, routeStatus: runtimeTrackStatus(snapshot, handoff.trackRef) }));
	const terminalActions = snapshot.actions
		.filter((action) => TERMINAL_ACTION_STATUSES.has(action.status) && action.metadata?.summary)
		.sort((left, right) => Date.parse(left.updatedAt ?? left.createdAt ?? "") - Date.parse(right.updatedAt ?? right.createdAt ?? ""))
		.slice(-4)
		.map((action) => ({
			id: action.id,
			kind: action.kind ?? "runtime-action",
			task: action.label,
			summary: action.metadata.summary,
			toolNames: [],
			git: null,
			trackRef: action.trackRef ?? null,
			trackLabel: action.trackLabel ?? null,
			routeStatus: runtimeTrackStatus(snapshot, action.trackRef),
			recordedAt: action.updatedAt ?? action.createdAt ?? null,
			action: action,
		}));
	const completedTasks = handoffs.length ? handoffs : terminalActions;
	const stateRevision = snapshot.projectState?.revision ?? 0;
	const stateTrackRef = snapshot.projectState?.source?.trackRef ?? "project:initial";
	const stateTrackLabel = snapshot.projectState?.source?.trackLabel ?? snapshot.projectState?.state?.researchQuestion ?? "initial project track";
	const stateRouteStatus = runtimeTrackStatus(snapshot, stateTrackRef);
	const transitionAfterState = snapshot.transitions?.find((transition) => transition.revision > stateRevision);
	const evidenceById = new Map();
	for (const item of experiments) if (item?.id) evidenceById.set(item.id, item);
	for (const item of snapshot.evidence ?? []) if (item?.id) evidenceById.set(item.id, { ...evidenceById.get(item.id), ...item });
	const recentEvidence = [...evidenceById.values()]
		.sort((left, right) => Date.parse(left.timestamp ?? left.recordedAt ?? "") - Date.parse(right.timestamp ?? right.recordedAt ?? ""))
		.slice(-6)
		.map((item) => ({ ...item, routeStatus: runtimeTrackStatus(snapshot, item.trackRef) }));
	const stateUpdatedAt = Date.parse(snapshot.projectState?.updatedAt ?? snapshot.projectState?.committedAt ?? "");
	const evidenceAfterState = recentEvidence.filter((item) => {
		if (!snapshot.projectState) return true;
		if (Number.isInteger(item.revision)) return item.revision > stateRevision;
		const recordedAt = Date.parse(item.timestamp ?? item.recordedAt ?? "");
		return Number.isFinite(recordedAt) && Number.isFinite(stateUpdatedAt) && recordedAt > stateUpdatedAt;
	});
	const pendingEvidenceIds = new Set(evidenceAfterState.map((item) => item.id));
	for (const item of snapshot.evidence ?? []) {
		if (!snapshot.projectState || (Number.isInteger(item.revision) && item.revision > stateRevision)) pendingEvidenceIds.add(item.id);
	}
	const pendingEvidenceCount = pendingEvidenceIds.size;
	const actionAfterState = snapshot.projectState
		? actions.some((action) => Date.parse(action.updatedAt ?? action.createdAt ?? "") > Date.parse(snapshot.projectState.updatedAt ?? snapshot.projectState.committedAt ?? ""))
		: actions.length > 0;
	const sourceGit = snapshot.projectState?.source?.git;
	const gitChanged = Boolean(
		snapshot.projectState
		&& sourceGit
		&& ((sourceGit.commit && git.commit && sourceGit.commit !== git.commit) || (sourceGit.branch && git.branch && sourceGit.branch !== git.branch)),
	);
	let freshness = "current";
	const freshnessReasons = [];
	if (!snapshot.projectState) {
		freshness = snapshot.activeTransition || pendingEvidenceCount > 0 ? "transitioning" : "missing";
		if (snapshot.activeTransition) freshnessReasons.push("No compacted state has incorporated the active transition yet.");
		if (pendingEvidenceCount) freshnessReasons.push(`${pendingEvidenceCount} project experiment record(s) have not yet been synthesized into structured state.`);
		if (!snapshot.activeTransition && !pendingEvidenceCount) freshnessReasons.push("No structured Project State exists yet.");
	} else if (transitionAfterState || pendingEvidenceCount) {
		freshness = "stale";
		if (transitionAfterState) freshnessReasons.push(`Research transition to ${transitionAfterState.to} occurred after the last compacted state.`);
		if (pendingEvidenceCount) freshnessReasons.push(`${pendingEvidenceCount} experiment record(s) are newer than the last compacted state.`);
	} else if (actionAfterState || gitChanged) {
		freshness = "unconfirmed";
		if (actionAfterState) freshnessReasons.push("Runtime activity is newer than the last compacted state.");
		if (gitChanged) freshnessReasons.push("The Git branch or commit changed after the last compacted state.");
	}
	return {
		version: PROJECT_VIEW_VERSION,
		projectKey: runtime.projectKey,
		workspaceRoot: runtime.workspaceRoot,
		briefState,
		briefRevision: snapshot.projectBrief?.revision ?? stateRevision,
		git: { branch: git.branch ?? null, commit: git.commit?.slice(0, 12) ?? null, dirty: git.dirty ?? null },
		state: snapshot.projectState?.state ?? null,
		stateAmendment: snapshot.projectState?.amendment ?? null,
		stateRevision,
		projectRevision: snapshot.revision ?? 0,
		freshness,
		freshnessReasons,
		currentTrack,
		stateTrackRef,
		stateTrackLabel,
		stateRouteStatus,
		activeTransition: snapshot.activeTransition ?? null,
		latestCompletedTask: completedTasks.at(-1) ?? null,
		pendingEvidenceCount,
		pendingEvidence: evidenceAfterState.slice(-4),
		transitionSupersedesState: Boolean(
			snapshot.projectState
			&& stateRouteStatus === "retired",
		),
		experiments: recentEvidence,
		actions,
		generatedFrom: {
			actors: snapshot.actors.length,
			actions: snapshot.actions.length,
			messages: snapshot.messages.length,
		},
	};
}

function bullets(items, formatter, empty) {
	return items.length ? items.map((item) => `- ${formatter(item)}`) : [`- ${empty}`];
}

function evidenceBrief(item) {
	const checks = list(item.validityChecks, 2).map((check) => compact(check, 180)).join(" | ");
	return [
		`- ${item.id} [${item.validityJudgment ?? "inconclusive"}] [${item.evidenceMode ?? "unspecified"}] [route=${item.routeStatus}] ${compact(item.question, 280)}`,
		`  intervention: ${compact(item.intervention, 340) || "not recorded"}`,
		`  observation: ${compact(item.observation, 440) || "not available in the bounded record"}`,
		`  validity: ${checks || "no checks recorded"}`,
		`  interpretation: ${compact(item.conclusion, 440) || "no conclusion recorded"}`,
		item.nextStep ? `  next: ${compact(item.nextStep, 300)}` : undefined,
		item.runId ? `  run: ${compact(item.runId, 180)}${item.runGitCommit ? ` @ ${compact(item.runGitCommit, 100)}` : ""}` : undefined,
	].filter(Boolean);
}

function truncateSection(text, limit, marker) {
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - marker.length - 1)).trimEnd()}\n${marker}`;
}

export function renderProjectBrief(view) {
	const state = view.briefState;
	const brief = state?.projectBrief;
	const lines = [
		"<research_project_view>",
		"Stable Project Brief captured at the latest successful research compaction. It orients a new Agent or user; it intentionally excludes the newest work. The Project Delta at the prompt tail is newer and controls current progress.",
		`Project: ${view.projectKey} · ${view.workspaceRoot}`,
		`Brief boundary: Project revision ${view.briefRevision || "none"}`,
		"=== PROJECT OVERVIEW AND FINAL GOAL ===",
	];
	if (state) {
		lines.push(
			`Overview: ${compact(brief?.overview, 1_200) || compact(state.researchQuestion, 1_200) || "not established"}`,
			`Final goal: ${compact(brief?.finalGoal, 1_200) || compact(state.researchQuestion, 1_200) || "not established"}`,
		);
		lines.push(
			"=== OVERALL DIRECTION AND APPROACH ===",
			compact(brief?.overallApproach, 1_500) || "No enduring overall approach is recorded.",
			"=== USER PRIORITIES AND GUARDRAILS ===",
			...bullets(list(brief?.userPriorities, 6), (item) => compact(item, 520), "No enduring user priority or guardrail is recorded."),
		);
	} else {
		lines.push(
			"No compact-boundary Project State exists yet. Establish the project overview, final goal, and user priorities before allowing the latest task to define the project.",
			"=== OVERALL DIRECTION AND APPROACH ===",
			"- Not established.",
			"=== USER PRIORITIES AND GUARDRAILS ===",
			"- Not established.",
		);
	}
	const explicitPhases = list(brief?.previousPhases, 6);
	const phaseLines = bullets(
		explicitPhases,
		(phase) => `${compact(phase.goal, 320) || "previous phase"} -> ${compact(phase.approach, 420) || "approach not recorded"} -> ${compact(phase.result, 520) || "result not recorded"}`,
		"No closed previous phase is recorded in the latest compact.",
	);
	lines.push(
		"=== PREVIOUS PHASES (goal -> approach/result, compressed) ===",
		...phaseLines,
		"This Brief stays byte-stable until the next successful /compact. Read the Project Delta after the Session history for current work, evidence, and next decisions.",
		"</research_project_view>",
	);
	return truncateSection(lines.filter(Boolean).join("\n"), 5_200, "[Project Brief truncated; use /runtime view for the stored compact-boundary orientation.]\n</research_project_view>");
}

export function renderProjectView(view, options = {}) {
	return `${renderProjectBrief(view)}\n\n${renderProjectViewDelta(view, options)}`;
}

export function renderProjectViewDelta(view, options = {}) {
	const includeDirectedMessages = options.includeDirectedMessages !== false;
	const state = view.state;
	const evidence = [...view.pendingEvidence].reverse().slice(0, 2);
	const header = [
		"<research_project_delta>",
		"Current Project Delta rebuilt at the model boundary. It is the only model-visible live ProjectView suffix and supersedes older progress, plans, and route interpretations.",
		`Stable Brief boundary: Project revision ${view.briefRevision || "none"}`,
		`Project revision: ${view.projectRevision} · structured state revision: ${view.stateRevision || "none"} · memory freshness: ${view.freshness}`,
		`Git: branch=${view.git.branch ?? "unknown"} commit=${view.git.commit ?? "unknown"} dirty=${view.git.dirty ?? "unknown"}`,
		`Current research track: ${view.currentTrack?.ref ?? "project:initial"} · ${compact(view.currentTrack?.label, 500) || "unnamed"}`,
		view.freshness !== "current"
			? "Do not report an earlier baseline claim as current or execute its planned next experiment until this delta is reconciled."
			: "The latest structured baseline remains current.",
		...view.freshnessReasons.map((reason) => `- ${reason}`),
	];
	if (view.activeTransition) {
		const transition = view.activeTransition;
		header.push(
			`Research transition: ${compact(transition.from, 300) || "previous route"} -> ${compact(transition.to, 420)} (${transition.oldDisposition})`,
			`Reason: ${compact(transition.reason, 800)}`,
			transition.nextDecision ? `Next decision: ${compact(transition.nextDecision, 600)}` : undefined,
		);
	}
	if (view.stateAmendment) {
		header.push(
			`Latest structured-state amendment: ${compact(view.stateAmendment.reason, 700) || "reason not recorded"}`,
			view.stateAmendment.authorityRefs?.length
				? `Authority: ${view.stateAmendment.authorityRefs.slice(0, 6).map((item) => compact(item, 180)).join(", ")}`
				: undefined,
		);
	}

	// Latest observations precede the compacted frontier deliberately. If the
	// Delta reaches its bound, old/detail-heavy baseline fields are truncated
	// before the evidence that made the Delta necessary.
	const progress = ["=== LATEST MEANINGFUL PROGRESS ==="];
	if (view.latestCompletedTask) {
		const handoff = view.latestCompletedTask;
		progress.push(
			"Latest completed work handoff (context, not an automatic next task):",
			`Task: ${compact(handoff.task, 700) || handoff.id}`,
			`Reported result: ${compact(handoff.summary, 1_400)}`,
			`Route: ${handoff.routeStatus} · source=${handoff.id}`,
		);
	} else {
		progress.push("No durable completed-work handoff is available.");
	}
	if (evidence.length) {
		progress.push(
			`New evidence after structured state (${view.pendingEvidenceCount} total record(s); newest two shown):`,
			...evidence.flatMap(evidenceBrief),
		);
	}
	progress.push(
		"Live Runtime actions:",
		...bullets(view.actions.slice(-4), (item) => `${item.id} [${item.status}] [route=${item.routeStatus}] ${compact(item.label, 240)} external=${item.externalId ?? "none"}`, "none"),
	);

	const frontier = ["=== CURRENT RESEARCH FRONTIER ==="];
	if (state && !view.transitionSupersedesState) {
		frontier.push(
			`Current question: ${compact(state.researchQuestion, 900) || "not established"}`,
			`Evidence-bounded position: ${compact(state.currentClaim, 900) || "no supported claim recorded"}`,
			"Competing hypotheses:",
			...bullets(list(state.hypotheses, 4), (item) => `${item.id} [${item.status}] ${compact(item.statement, 460)}${item.evidenceRefs?.length ? ` | refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Open questions and confounders:",
			...bullets([...list(state.unresolvedConfounders, 2), ...list(state.openQuestions, 3)], (item) => compact(item, 460), "none recorded"),
			`Candidate next experiment: ${compact(state.nextExperiment?.question, 560) || "not determined"}`,
			state.nextExperiment?.intervention ? `  intervention: ${compact(state.nextExperiment.intervention, 680)}` : undefined,
		);
	} else if (state) {
		frontier.push("The structured frontier belongs to a retired route. Use the active transition and newer evidence; do not carry its claim or next experiment forward.");
	} else {
		frontier.push("No structured current frontier is available yet.");
	}
	const footer = [
		includeDirectedMessages
			? "Runtime mailbox bodies use the separate single-delivery channel; inspect /inbox only when routing needs attention."
			: "Directed Runtime message contents belong only to the addressed Leader Session.",
		"The current user request selects the immediate task. This Delta is current context, not an instruction to continue the previous task.",
		"</research_project_delta>",
	];
	const fixed = [...header, ...progress].filter(Boolean).join("\n");
	const ending = footer.filter(Boolean).join("\n");
	const availableFrontier = Math.max(900, 6_400 - fixed.length - ending.length - 2);
	const boundedFrontier = truncateSection(
		frontier.filter(Boolean).join("\n"),
		availableFrontier,
		"[Current frontier truncated; latest progress above is preserved. Use /runtime view for the full bounded view.]",
	);
	return `${fixed}\n${boundedFrontier}\n${ending}`;
}

export function materializeProjectViewContext(messages, briefText, deltaText, details = {}) {
	let hasPersistentBrief = false;
	const filtered = messages.filter((message) => {
		if (message.role !== "custom") return true;
		if (message.customType === PROJECT_VIEW_DELTA_KIND) return false;
		if (message.customType !== PROJECT_VIEW_KIND) return true;
		if (message.details?.transient === true) return false;
		const isCurrentBrief = message.details?.persistent === true
			&& message.details?.version === PROJECT_VIEW_VERSION
			&& message.details?.mode === "brief";
		if (!isCurrentBrief) return false;
		if (hasPersistentBrief) return false;
		hasPersistentBrief = true;
		return true;
	});
	const result = [...filtered];
	if (!hasPersistentBrief && briefText) {
		result.push({
			role: "custom",
			customType: PROJECT_VIEW_KIND,
			content: briefText,
			display: false,
			details: { version: PROJECT_VIEW_VERSION, mode: "brief", transient: true, ...details },
			timestamp: 0,
		});
	}
	if (deltaText) {
		result.push({
			role: "custom",
			customType: PROJECT_VIEW_DELTA_KIND,
			content: deltaText,
			display: false,
			details: { version: PROJECT_VIEW_VERSION, mode: "delta", transient: true, ...details },
			timestamp: 0,
		});
	}
	return result;
}

export function projectViewFingerprint(view) {
	// Only the compact-boundary Brief owns this fingerprint. Live progress is a
	// replaceable prompt-tail Delta and must never churn the stable prefix.
	return fingerprint(renderProjectBrief(view));
}

export function projectViewDeltaFingerprint(view, options = {}) {
	return fingerprint(renderProjectViewDelta(view, options));
}
