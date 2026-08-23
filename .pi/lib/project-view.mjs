import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RESEARCH_COMPACTION_KIND, RESEARCH_COMPACTION_VERSION } from "./research-compact.mjs";
import { runtimeResearchTrack, runtimeTrackStatus } from "./research-runtime.mjs";

export const PROJECT_VIEW_KIND = "research-project-view";
export const PROJECT_VIEW_DELTA_KIND = "research-project-view-delta";
export const PROJECT_VIEW_VERSION = 2;
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

// The Runtime ledger also contains UI/session lifecycle events. Those events
// must not churn the model-facing ProjectView or its prompt-cache suffix.
// Research revisions, live Actions, and open mailbox messages are the only
// snapshot fields that can change the rendered view between explicit refreshes.
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
		messages: (snapshot.messages ?? [])
			.filter((message) => message.status === "queued" || message.status === "delivered")
			.map((message) => ({
				id: message.id,
				type: message.type,
				from: message.from,
				status: message.status,
				body: message.body,
				trackRef: message.trackRef ?? null,
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
	const result = await input.appendRuntimeEventAtRevision(runtime, "project.state.committed", {
		state: entry.details.researchState,
		source,
	}, basedOnRevision, { id: `project-state:${source.sessionId}:${source.entryId}` });
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

export async function migrateLatestProjectState({ runtime, sessionDir, cwd, appendRuntimeEvent, appendRuntimeEventAtRevision, readRuntimeSnapshot }) {
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
	const openMessages = snapshot.messages.filter((message) => message.status === "queued" || message.status === "delivered");
	const currentTrack = runtimeResearchTrack(snapshot);
	const actions = snapshot.actions.filter((action) =>
		LIVE_ACTION_STATUSES.has(action.status),
	).slice(-8).map((action) => ({ ...action, routeStatus: runtimeTrackStatus(snapshot, action.trackRef) }));
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
		git: { branch: git.branch ?? null, commit: git.commit?.slice(0, 12) ?? null, dirty: git.dirty ?? null },
		state: snapshot.projectState?.state ?? null,
		stateSource: snapshot.projectState?.source ?? null,
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
		pendingEvidenceCount,
		pendingEvidence: evidenceAfterState.slice(-4),
		transitionSupersedesState: Boolean(
			snapshot.projectState
			&& stateRouteStatus === "retired",
		),
		experiments: recentEvidence,
		actions,
		openMessages: openMessages.slice(-8).map((message) => ({
			id: message.id,
			type: message.type,
			from: message.from,
			status: message.status,
			body: compact(message.body, 240),
			trackRef: message.trackRef ?? null,
			routeStatus: runtimeTrackStatus(snapshot, message.trackRef),
		})),
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

export function renderProjectView(view) {
	const state = view.state;
	const lines = [
		"<research_project_view>",
		"Deterministic project-level working view. The structured-state baseline is a fallible index; the live delta below determines whether it is still current. Validate consequential claims against cited experiment/run/artifact evidence.",
		`Project: ${view.projectKey} · ${view.workspaceRoot}`,
		"Structured-state baseline (stable prefix; treat it as current only when the live delta says memory freshness=current):",
	];
	if (state) {
		lines.push(
			`State provenance: ${view.stateSource?.kind === "amendment" ? "amendment " : "compaction "}S:${view.stateSource?.sessionId}/E:${view.stateSource?.entryId} hash=${view.stateSource?.contentHash ?? "unknown"}`,
			view.stateAmendment ? `Latest state amendment: ${compact(view.stateAmendment.reason, 1_000)} | authority=${compact(view.stateAmendment.authorityRefs?.join(" | "), 1_800) || "missing"}` : undefined,
			`Baseline research track: ${view.stateTrackRef} · ${compact(view.stateTrackLabel, 600)}`,
			`Baseline research question: ${compact(state.researchQuestion, 900) || "unknown"}`,
			`Baseline claim: ${compact(state.currentClaim, 900) || "no supported claim recorded"}`,
			"Baseline competing hypotheses:",
			...bullets(list(state.hypotheses, 6), (item) => `${item.id} [${item.status}] ${compact(item.statement, 600)}${item.evidenceRefs?.length ? ` refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Baseline research decisions:",
			...bullets(list(state.decisions, 4), (item) => `${compact(item.decision, 500)} (${item.reversible === false ? "frozen" : "reversible"})${item.evidenceRefs?.length ? ` refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Baseline decision-critical context:",
			...bullets(list(state.criticalContext, 4), (item) => compact(item, 500), "none recorded"),
			"Baseline unresolved confounders/open questions:",
			...bullets([...list(state.unresolvedConfounders, 3), ...list(state.openQuestions, 3)], (item) => compact(item, 500), "none recorded"),
			`Baseline planned next experiment: ${compact(state.nextExperiment?.question, 600) || "not determined"} | intervention=${compact(state.nextExperiment?.intervention, 700) || "not determined"}`,
		);
	} else {
		lines.push("Structured project state: unavailable; do not infer continuity from absence. A later research compaction can establish it.");
	}
	lines.push(
		"--- live project delta (dynamic suffix) ---",
		`Git: branch=${view.git.branch ?? "unknown"} commit=${view.git.commit ?? "unknown"} dirty=${view.git.dirty ?? "unknown"}`,
		`Project revision: ${view.projectRevision} · structured state revision: ${view.stateRevision || "none"} · memory freshness: ${view.freshness}`,
		`Current research track: ${view.currentTrack?.ref ?? "project:initial"} · ${compact(view.currentTrack?.label, 600) || "unnamed"}`,
		state ? `Structured-state route status now: ${view.stateRouteStatus}` : undefined,
	);
	if (view.freshness === "current") {
		lines.push("Baseline status: CURRENT. It may be used as the working research state, subject to its cited evidence boundaries.");
	} else {
		lines.push(
			"MEMORY FRESHNESS WARNING: the baseline is historical or unconfirmed. Do not report its claim as the current conclusion or execute its planned next experiment without reconciling the live delta.",
			...view.freshnessReasons.map((reason) => `- ${reason}`),
		);
	}
	if (view.transitionSupersedesState) {
		lines.push(
			`Previous structured state (not current): S:${view.stateSource?.sessionId}/E:${view.stateSource?.entryId} hash=${view.stateSource?.contentHash ?? "unknown"}`,
			"Its hypotheses and experiment details remain retrievable through research_memory_search/read; do not silently carry them into the active route.",
		);
	}
	if (view.activeTransition) {
		const transition = view.activeTransition;
		lines.push(
			`Active research track: ${compact(transition.to, 600)}`,
			transition.from ? `Previous track: ${compact(transition.from, 500)} (${transition.oldDisposition})` : undefined,
			`Transition reason: ${compact(transition.reason, 1200)}`,
			transition.nextDecision ? `Current next decision: ${compact(transition.nextDecision, 1000)}` : undefined,
			transition.authorityRefs?.length ? `Transition authority: ${transition.authorityRefs.join(" | ")}` : undefined,
		);
	}
	if (view.pendingEvidence.length) {
		lines.push(
			`Pending evidence delta (${view.pendingEvidenceCount} record(s) newer than the structured baseline; authoritative as records but not yet synthesized into a current claim):`,
			"Reconcile at this semantic boundary: use amend_project_state for a narrow evidence-backed state correction, record_research_transition for a real route change, or compact at a genuine checkpoint. Do not run model compaction after every experiment.",
			...[...view.pendingEvidence].reverse().flatMap(evidenceBrief),
		);
	} else if (view.experiments.length) {
		lines.push(
			"Latest evidence briefs (already at or before the structured-state boundary; use for concise provenance, not as a replacement for exact records):",
			...view.experiments.slice(-2).flatMap(evidenceBrief),
		);
	}
	lines.push(
		"Recent project evidence index (read exact records on demand):",
		...bullets(view.experiments, (item) => `${item.id} [${item.validityJudgment ?? "inconclusive"}] [route=${item.routeStatus}] ${compact(item.question, 300)} -> ${compact(item.conclusion, 380)}${item.runId ? ` | run=${compact(item.runId, 140)}` : ""}`, "none recorded"),
		"Live/unresolved Runtime actions:",
		...bullets(view.actions, (item) => `${item.id} [${item.status}] [route=${item.routeStatus}] ${compact(item.label, 300)} external=${item.externalId ?? "none"}`, "none"),
		"Open Runtime messages (queued or delivered but not consumed):",
		...bullets(view.openMessages, (item) => `${item.id} [${item.status}] [route=${item.routeStatus}] ${item.type} from=${item.from}: ${item.body}`, "none"),
		"</research_project_view>",
	);
	const renderedLines = lines.filter(Boolean);
	const rendered = renderedLines.join("\n");
	if (rendered.length <= 12_000) return rendered;
	const deltaIndex = renderedLines.indexOf("--- live project delta (dynamic suffix) ---");
	const baseline = renderedLines.slice(1, deltaIndex).join("\n");
	const delta = renderedLines.slice(deltaIndex, -1).join("\n");
	return [
		"<research_project_view>",
		truncateSection(baseline, 5_700, "[Structured baseline truncated; use /runtime view or research_memory_read for exact history.]"),
		truncateSection(delta, 5_900, "[Live delta truncated; inspect /runtime, /inbox, or exact experiment records.]"),
		"</research_project_view>",
	].join("\n");
}

export function renderProjectViewDelta(view, sinceRevision = 0) {
	const evidence = [...view.pendingEvidence]
		.filter((item) => !Number.isInteger(item.revision) || item.revision > sinceRevision)
		.reverse();
	const transition = view.activeTransition && (!Number.isInteger(view.activeTransition.revision) || view.activeTransition.revision > sinceRevision)
		? view.activeTransition
		: null;
	const lines = [
		"<research_project_delta>",
		"Append-only ProjectView update. Earlier ProjectView messages are historical baselines; this newer revision controls freshness and current-route interpretation.",
		`Project revision: ${view.projectRevision} · structured state revision: ${view.stateRevision || "none"} · memory freshness: ${view.freshness}`,
		`Git: branch=${view.git.branch ?? "unknown"} commit=${view.git.commit ?? "unknown"} dirty=${view.git.dirty ?? "unknown"}`,
		`Current research track: ${view.currentTrack?.ref ?? "project:initial"} · ${compact(view.currentTrack?.label, 500) || "unnamed"}`,
		view.freshness !== "current"
			? "Do not report an earlier baseline claim as current or execute its planned next experiment until this delta is reconciled."
			: "The latest structured baseline remains current.",
		...view.freshnessReasons.map((reason) => `- ${reason}`),
	];
	if (transition) {
		lines.push(
			`Research transition: ${compact(transition.from, 300) || "previous route"} -> ${compact(transition.to, 420)} (${transition.oldDisposition})`,
			`Reason: ${compact(transition.reason, 800)}`,
			transition.nextDecision ? `Next decision: ${compact(transition.nextDecision, 600)}` : undefined,
		);
	}
	if (evidence.length) {
		lines.push(
			`New evidence since Project revision ${sinceRevision} (${view.pendingEvidenceCount} total record(s) still newer than structured state):`,
			"Treat each record's intervention, observation, validity, and interpretation separately. Reconcile with amend_project_state, record_research_transition, or a real checkpoint compact; do not compact mechanically after every experiment.",
			...evidence.flatMap(evidenceBrief),
		);
	}
	if (!transition && !evidence.length) {
		lines.push("No new scientific evidence is embedded in this update; the change is environment or freshness metadata only.");
	}
	lines.push("</research_project_delta>");
	const rendered = lines.filter(Boolean).join("\n");
	return rendered.length <= 5_800
		? rendered
		: `${rendered.slice(0, 5_700).trimEnd()}\n[Project delta truncated; read exact experiment records.]\n</research_project_delta>`;
}

export function materializeProjectViewDelta(messages, text, details = {}) {
	const filtered = messages.filter((message) =>
		message.role !== "custom"
		|| (message.customType !== PROJECT_VIEW_DELTA_KIND
			&& !(message.customType === PROJECT_VIEW_KIND && message.details?.transient === true)),
	);
	if (!text) return filtered;
	const hasPersistentSnapshot = filtered.some((message) =>
		message.role === "custom" && message.customType === PROJECT_VIEW_KIND,
	);
	return [...filtered, {
		role: "custom",
		customType: hasPersistentSnapshot ? PROJECT_VIEW_DELTA_KIND : PROJECT_VIEW_KIND,
		content: text,
		display: false,
		details: { version: PROJECT_VIEW_VERSION, transient: true, ...details },
		timestamp: 0,
	}];
}

export function projectViewFingerprint(view) {
	// Hash the exact model-facing bytes, not incidental Runtime timestamps or
	// metadata that are absent from the prompt. This keeps repeated materialized
	// messages byte-stable for provider-side prefix/KV caching.
	return fingerprint(renderProjectView(view));
}
