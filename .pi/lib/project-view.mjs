import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RESEARCH_COMPACTION_KIND, RESEARCH_COMPACTION_VERSION } from "./research-compact.mjs";
import { runtimeResearchTrack, runtimeTrackStatus } from "./research-runtime.mjs";

export const PROJECT_VIEW_KIND = "research-project-view";
export const PROJECT_VIEW_VERSION = 1;
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
		["starting", "running", "input_required", "cancelling", "outcome_unknown"].includes(action.status),
	).slice(-8).map((action) => ({ ...action, routeStatus: runtimeTrackStatus(snapshot, action.trackRef) }));
	const stateRevision = snapshot.projectState?.revision ?? 0;
	const stateTrackRef = snapshot.projectState?.source?.trackRef ?? "project:initial";
	const stateTrackLabel = snapshot.projectState?.source?.trackLabel ?? snapshot.projectState?.state?.researchQuestion ?? "initial project track";
	const stateRouteStatus = runtimeTrackStatus(snapshot, stateTrackRef);
	const transitionAfterState = snapshot.transitions?.find((transition) => transition.revision > stateRevision);
	const evidenceAfterState = snapshot.evidence?.filter((item) => item.revision > stateRevision) ?? [];
	const actionAfterState = snapshot.projectState
		? actions.some((action) => Date.parse(action.updatedAt ?? action.createdAt ?? "") > Date.parse(snapshot.projectState.committedAt ?? ""))
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
		freshness = snapshot.activeTransition || (snapshot.evidence?.length ?? 0) > 0 ? "transitioning" : "missing";
		if (snapshot.activeTransition) freshnessReasons.push("No compacted state has incorporated the active transition yet.");
		if (snapshot.evidence?.length) freshnessReasons.push(`${snapshot.evidence.length} project experiment record(s) have not yet been synthesized into structured state.`);
		if (!snapshot.activeTransition && !snapshot.evidence?.length) freshnessReasons.push("No structured Project State exists yet.");
	} else if (transitionAfterState || evidenceAfterState.length) {
		freshness = "stale";
		if (transitionAfterState) freshnessReasons.push(`Research transition to ${transitionAfterState.to} occurred after the last compacted state.`);
		if (evidenceAfterState.length) freshnessReasons.push(`${evidenceAfterState.length} experiment record(s) are newer than the last compacted state.`);
	} else if (actionAfterState || gitChanged) {
		freshness = "unconfirmed";
		if (actionAfterState) freshnessReasons.push("Runtime activity is newer than the last compacted state.");
		if (gitChanged) freshnessReasons.push("The Git branch or commit changed after the last compacted state.");
	}
	const evidenceById = new Map();
	for (const item of experiments) if (item?.id) evidenceById.set(item.id, item);
	for (const item of snapshot.evidence ?? []) if (item?.id) evidenceById.set(item.id, { ...evidenceById.get(item.id), ...item });
	const recentEvidence = [...evidenceById.values()]
		.sort((left, right) => Date.parse(left.timestamp ?? left.recordedAt ?? "") - Date.parse(right.timestamp ?? right.recordedAt ?? ""))
		.slice(-6)
		.map((item) => ({ ...item, routeStatus: runtimeTrackStatus(snapshot, item.trackRef) }));
	return {
		version: PROJECT_VIEW_VERSION,
		projectKey: runtime.projectKey,
		workspaceRoot: runtime.workspaceRoot,
		git: { branch: git.branch ?? null, commit: git.commit?.slice(0, 12) ?? null, dirty: git.dirty ?? null },
		state: snapshot.projectState?.state ?? null,
		stateSource: snapshot.projectState?.source ?? null,
		stateRevision,
		projectRevision: snapshot.revision ?? 0,
		freshness,
		freshnessReasons,
		currentTrack,
		stateTrackRef,
		stateTrackLabel,
		stateRouteStatus,
		activeTransition: snapshot.activeTransition ?? null,
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

export function renderProjectView(view) {
	const state = view.state;
	const lines = [
		"<research_project_view>",
		"Deterministic project-level working view. Compaction-derived claims are fallible; validate important claims against the cited experiment/run/artifact before acting.",
		`Project: ${view.projectKey} · ${view.workspaceRoot}`,
		`Git: branch=${view.git.branch ?? "unknown"} commit=${view.git.commit ?? "unknown"} dirty=${view.git.dirty ?? "unknown"}`,
		`Project revision: ${view.projectRevision} · compacted state revision: ${view.stateRevision || "none"} · memory freshness: ${view.freshness}`,
		`Current research track: ${view.currentTrack?.ref ?? "project:initial"} · ${compact(view.currentTrack?.label, 600) || "unnamed"}`,
	];
	if (view.freshness !== "current") {
		lines.push(
			"MEMORY FRESHNESS WARNING: do not execute the compacted nextExperiment as current until the active research direction is confirmed.",
			...view.freshnessReasons.map((reason) => `- ${reason}`),
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
	if (state) {
		lines.push(`Compacted state track: ${view.stateTrackRef} [${view.stateRouteStatus}] · ${compact(view.stateTrackLabel, 600)}`);
		if (view.transitionSupersedesState) {
			lines.push(
				`Previous compacted state (not current): S:${view.stateSource?.sessionId}/E:${view.stateSource?.entryId} hash=${view.stateSource?.contentHash ?? "unknown"}`,
				`Previous research question: ${compact(state.researchQuestion, 700) || "unknown"}`,
				`Previous claim: ${compact(state.currentClaim, 700) || "none recorded"}`,
				"Previous hypotheses and experiment details remain retrievable through research_memory_search/read; they are not expanded into the active context.",
			);
		} else lines.push(
			`State provenance: S:${view.stateSource?.sessionId}/E:${view.stateSource?.entryId} hash=${view.stateSource?.contentHash ?? "unknown"}`,
			`${view.freshness === "current" ? "Research question" : "Last compacted research question"}: ${compact(state.researchQuestion, 900) || "unknown"}`,
			`${view.freshness === "current" ? "Current claim" : "Last compacted claim (verify freshness)"}: ${compact(state.currentClaim, 900) || "no supported claim recorded"}`,
			`${view.freshness === "current" ? "Competing hypotheses" : "Last compacted hypotheses"}:`,
			...bullets(list(state.hypotheses, 6), (item) => `${item.id} [${item.status}] ${compact(item.statement, 600)}${item.evidenceRefs?.length ? ` refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Research decisions:",
			...bullets(list(state.decisions, 4), (item) => `${compact(item.decision, 500)} (${item.reversible === false ? "frozen" : "reversible"})${item.evidenceRefs?.length ? ` refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Decision-critical context:",
			...bullets(list(state.criticalContext, 4), (item) => compact(item, 500), "none recorded"),
			"Unresolved confounders/open questions:",
			...bullets([...list(state.unresolvedConfounders, 3), ...list(state.openQuestions, 3)], (item) => compact(item, 500), "none recorded"),
			`${view.freshness === "current" ? "Next experiment" : "Previous next experiment (not authoritative while memory is not current)"}: ${compact(state.nextExperiment?.question, 600) || "not determined"} | intervention=${compact(state.nextExperiment?.intervention, 700) || "not determined"}`,
		);
	} else {
		lines.push("Structured project state: unavailable; do not infer continuity from absence. A later research compaction can establish it.");
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
	const rendered = lines.filter(Boolean).join("\n");
	return rendered.length <= 12_000 ? rendered : `${rendered.slice(0, 11_950)}\n[ProjectView truncated]\n</research_project_view>`;
}

export function materializeProjectView(messages, text, details = {}) {
	const filtered = messages.filter((message) => message.role !== "custom" || message.customType !== PROJECT_VIEW_KIND);
	if (!text) return filtered;
	let insertAt = filtered.length;
	for (let index = filtered.length - 1; index >= 0; index -= 1) {
		if (filtered[index]?.role === "user") {
			insertAt = index;
			break;
		}
	}
	const message = {
		role: "custom",
		customType: PROJECT_VIEW_KIND,
		content: text,
		display: false,
		details: { version: PROJECT_VIEW_VERSION, ...details },
		timestamp: 0,
	};
	return [...filtered.slice(0, insertAt), message, ...filtered.slice(insertAt)];
}

export function projectViewFingerprint(view) {
	return fingerprint(view);
}
