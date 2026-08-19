import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RESEARCH_COMPACTION_KIND, RESEARCH_COMPACTION_VERSION } from "./research-compact.mjs";

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
	const source = {
		sessionId: String(input.sessionId),
		entryId: String(entry.id),
		contentHash: fingerprint(entry.details.researchState),
		warnings: Array.isArray(entry.details.warnings) ? entry.details.warnings.slice(0, 20) : [],
	};
	return await input.appendRuntimeEvent(runtime, "project.state.committed", {
		state: entry.details.researchState,
		source,
	}, { id: `project-state:${source.sessionId}:${source.entryId}` });
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

export async function migrateLatestProjectState({ runtime, sessionDir, cwd, appendRuntimeEvent }) {
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
	const queued = snapshot.messages.filter((message) => message.status === "queued");
	const actions = snapshot.actions.filter((action) =>
		["starting", "running", "input_required", "cancelling", "outcome_unknown"].includes(action.status),
	).slice(-8);
	return {
		version: PROJECT_VIEW_VERSION,
		projectKey: runtime.projectKey,
		workspaceRoot: runtime.workspaceRoot,
		git: { branch: git.branch ?? null, commit: git.commit?.slice(0, 12) ?? null, dirty: git.dirty ?? null },
		state: snapshot.projectState?.state ?? null,
		stateSource: snapshot.projectState?.source ?? null,
		experiments: experiments.slice(-6),
		actions,
		queuedMessages: queued.slice(-8).map((message) => ({ id: message.id, type: message.type, from: message.from, body: compact(message.body, 240) })),
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
	];
	if (state) {
		lines.push(
			`State provenance: S:${view.stateSource?.sessionId}/E:${view.stateSource?.entryId} hash=${view.stateSource?.contentHash ?? "unknown"}`,
			`Research question: ${compact(state.researchQuestion, 900) || "unknown"}`,
			`Current claim: ${compact(state.currentClaim, 900) || "no supported claim recorded"}`,
			"Competing hypotheses:",
			...bullets(list(state.hypotheses, 8), (item) => `${item.id} [${item.status}] ${compact(item.statement, 700)}${item.evidenceRefs?.length ? ` refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Research decisions:",
			...bullets(list(state.decisions, 4), (item) => `${compact(item.decision, 600)} (${item.reversible === false ? "frozen" : "reversible"})${item.evidenceRefs?.length ? ` refs=${item.evidenceRefs.join(",")}` : ""}`, "none recorded"),
			"Unresolved confounders/open questions:",
			...bullets([...list(state.unresolvedConfounders, 4), ...list(state.openQuestions, 4)], (item) => compact(item, 600), "none recorded"),
			`Next experiment: ${compact(state.nextExperiment?.question, 700) || "not determined"} | intervention=${compact(state.nextExperiment?.intervention, 900) || "not determined"}`,
		);
	} else {
		lines.push("Structured project state: unavailable; do not infer continuity from absence. A later research compaction can establish it.");
	}
	lines.push(
		"Recent experiment records:",
		...bullets(view.experiments, (item) => `${item.id} [${item.validityJudgment ?? "inconclusive"}] ${compact(item.question, 500)} | observation=${compact(item.observation, 500)} | conclusion=${compact(item.conclusion, 500)}${item.runId ? ` | run=${compact(item.runId, 160)}` : ""}`, "none recorded"),
		"Live/unresolved Runtime actions:",
		...bullets(view.actions, (item) => `${item.id} [${item.status}] ${compact(item.label, 300)} external=${item.externalId ?? "none"}`, "none"),
		"Queued Runtime messages:",
		...bullets(view.queuedMessages, (item) => `${item.id} ${item.type} from=${item.from}: ${item.body}`, "none"),
		"</research_project_view>",
	);
	const rendered = lines.join("\n");
	return rendered.length <= 16_000 ? rendered : `${rendered.slice(0, 15_950)}\n[ProjectView truncated]\n</research_project_view>`;
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
