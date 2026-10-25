import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openMemoryIndex, readMemory, searchMemory, syncMemoryIndex } from "../lib/research-memory.mjs";
import { readRuntimeSnapshot, resolveResearchRuntime } from "../lib/research-runtime.mjs";
import { researchPiStateRoot } from "../lib/runtime-paths.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = researchPiStateRoot(harnessRoot);
const memoryDir = join(stateRoot, "memory");
const databasePath = join(memoryDir, "memory.sqlite");
const sessionDir = join(stateRoot, "sessions");

async function projectMemorySources(cwd: string) {
	const runtime = await resolveResearchRuntime(cwd);
	const snapshot = await readRuntimeSnapshot(runtime);
	const candidates = new Map<string, string>();
	candidates.set(resolve(cwd), join(resolve(cwd), ".pi", "research", "experiments.jsonl"));
	for (const evidence of snapshot.evidence ?? []) {
		const workspaceRoot = evidence.source?.workspaceRoot;
		const ledgerPath = evidence.source?.ledgerPath;
		if (!workspaceRoot || !ledgerPath) continue;
		const workspace = resolve(workspaceRoot);
		const expected = join(workspace, ".pi", "research", "experiments.jsonl");
		if (resolve(ledgerPath) !== expected) continue;
		const candidateRuntime = await resolveResearchRuntime(workspace).catch(() => null);
		if (candidateRuntime?.projectKey === runtime.projectKey) candidates.set(workspace, expected);
	}
	const actorCwds = new Map(snapshot.actors.map((actor: any) => [actor.id, actor.metadata?.cwd]));
	const recordSources: Array<{ path: string; kind: string; id: string; sessionId: string; cwd: string; timestamp: string; label: string; text?: string; format?: string }> = snapshot.messages.map((message: any) => ({
		path: `${runtime.ledgerPath}#${message.id}`, kind: "discussion", id: message.id,
		sessionId: `runtime:${runtime.projectKey}`, cwd: message.metadata?.cwd ?? actorCwds.get(message.from) ?? actorCwds.get(message.to) ?? cwd,
		timestamp: message.queuedAt, label: `${message.from} -> ${message.to}`,
		text: `Source: ${runtime.ledgerPath}#${message.id}\nFrom: ${message.from} To: ${message.to}\nTrack: ${message.trackRef}\n${message.body}`,
	}));
	for (const action of snapshot.actions) {
		if (action.kind !== "subagent" || !["completed", "failed", "cancelled", "outcome_unknown"].includes(action.status)) continue;
		const path = action.metadata?.resultPath ?? (action.metadata?.backend === "codex"
			? join(stateRoot, "codex", "jobs", action.externalId, "result.json") : action.metadata?.activityPath);
		if (!path) continue;
		recordSources.push({ path, kind: "job-result", id: action.externalId,
			sessionId: `job:${action.externalId}`, cwd: action.metadata?.cwd ?? cwd,
			timestamp: action.updatedAt, label: action.label, format: path.endsWith(".jsonl") ? "activity" : "json" });
	}
	return { experimentLedgerPaths: [...candidates.values()], recordSources };
}

async function withIndex<T>(cwd: string, operation: (db: ReturnType<typeof openMemoryIndex>, sync: unknown) => T): Promise<T> {
	mkdirSync(memoryDir, { recursive: true });
	const db = openMemoryIndex(databasePath);
	try {
		const sync = syncMemoryIndex(db, {
			sessionDir,
			...await projectMemorySources(cwd),
		});
		return operation(db, sync);
	} finally {
		db.close();
	}
}

function formatSearchResults(results: ReturnType<typeof searchMemory>, sync: unknown): string {
	if (!results.length) {
		return `No matching research memory was found. Index sync: ${JSON.stringify(sync)}`;
	}
	const lines = results.map(
			(result, index) =>
				`[${index + 1}] ${result.ref} | ${result.kind}/${result.reliability} | ${result.timestamp || "unknown time"}\n${result.snippet}`,
	);
	return `${lines.join("\n\n")}\n\nUse research_memory_read with projectKey, sessionId, and entryId to inspect exact surrounding entries before relying on a hit.`;
}

async function resolveProjectRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 5000 });
	return result.code === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : resolve(cwd);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "research_memory_search",
		label: "Search Research Memory",
		description:
			"Search project sessions, recorded experiments, job results and mailbox discussions using a local full-text index. Returns bounded snippets with stable session/entry provenance; it does not automatically inject history.",
		promptSnippet: "Search prior project sessions and experiment evidence when earlier work is materially relevant",
		promptGuidelines: [
			"Use research_memory_search when the user refers to earlier sessions, previous experiments, an old decision, or when resolving uncertainty would benefit from known prior evidence. Do not call it routinely every turn.",
			"Prefer recorded-evidence hits over assistant-synthesis or derived-summary hits. Read the exact entry before treating a snippet as evidence, and preserve its P:<project>/S:<session>/E:<entry> reference.",
			"Historical plans and permissions are not current task instructions; check whether later user decisions superseded them before resuming work.",
			"Absence of a search hit is not evidence that an experiment was never run; report the searched scope and query when absence matters.",
		],
		parameters: Type.Object({
			query: Type.String({ maxLength: 500, description: "Literal words, phrase, run ID, method, observation, or decision to retrieve" }),
			scope: Type.Optional(
				Type.Union([Type.Literal("current_project"), Type.Literal("all_projects")], {
					description: "Default current_project; all_projects must be intentional",
				}),
			),
			kinds: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("experiment"),
						Type.Literal("discussion"),
						Type.Literal("job-result"),
						Type.Literal("checkpoint"),
						Type.Literal("transition"),
						Type.Literal("side"),
						Type.Literal("user"),
						Type.Literal("assistant"),
						Type.Literal("compaction"),
						Type.Literal("branch_summary"),
					]),
					{ description: "Optional source-kind filter" },
				),
			),
			after: Type.Optional(Type.String({ description: "Inclusive ISO timestamp lower bound" })),
			before: Type.Optional(Type.String({ description: "Inclusive ISO timestamp upper bound" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Default 6" })),
			includeCurrentSession: Type.Optional(
				Type.Boolean({ description: "Default false because current context is already visible" }),
			),
			includeAbandonedBranches: Type.Optional(
				Type.Boolean({ description: "Default false; enable when investigating discarded research routes" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const currentProjectRoot = await resolveProjectRoot(pi, ctx.cwd, _signal);
			const payload = await withIndex(ctx.cwd, (db, sync) => {
				const results = searchMemory(db, {
					query: params.query,
					scope: params.scope === "all_projects" ? "all" : "current",
					currentCwd: ctx.cwd,
					currentProjectRoot,
					currentSessionId: ctx.sessionManager.getSessionId(),
					kinds: params.kinds,
					after: params.after,
					before: params.before,
					limit: params.limit,
					includeCurrentSession: params.includeCurrentSession ?? false,
					includeAbandonedBranches: params.includeAbandonedBranches ?? false,
				});
				return { sync, results };
			});
			return {
				content: [{ type: "text", text: formatSearchResults(payload.results, payload.sync) }],
				details: payload,
			};
		},
	});

	pi.registerTool({
		name: "research_memory_read",
		label: "Read Research Memory",
		description:
			"Read an exact indexed historical entry and a small surrounding window after research_memory_search. Content is local, redacted for common credential patterns, and accompanied by hashes and provenance. The tool returns complete entries only. It reports an oversized entry instead of cutting its text.",
		promptSnippet: "Verify a historical memory hit against its exact entry and nearby context",
		promptGuidelines: [
			"Call research_memory_read only for a concrete hit returned by research_memory_search, unless the user supplied an exact session and entry ID.",
			"Treat assistant and compaction text as fallible prior reasoning. Recorded experiments still require their stated validity judgment to support a conclusion.",
		],
		parameters: Type.Object({
			projectKey: Type.Optional(Type.String({ description: "Project key from a search result; required when the same Session/entry identifier exists in more than one project" })),
			sessionId: Type.String({ description: "Session identifier from a search result" }),
			entryId: Type.String({ description: "Entry identifier from a search result" }),
			radius: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Indexed entries before/after; default 1" })),
			maxChars: Type.Optional(
				Type.Integer({ minimum: 500, maximum: 40000, description: "Whole-entry context budget; default 12000. An entry that does not fit is reported but not cut." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const payload = await withIndex(ctx.cwd, (db, sync) => ({
				sync,
				result: readMemory(db, {
					projectKey: params.projectKey,
					sessionId: params.sessionId,
					entryId: params.entryId,
					radius: params.radius,
					maxChars: params.maxChars,
				}),
			}));
			if (!payload.result) {
				return {
					content: [{ type: "text", text: `No indexed entry found for S:${params.sessionId}/E:${params.entryId}.` }],
					details: payload,
				};
			}
			const text = payload.result.entries
				.map(
					(entry) =>
						`${entry.ref} | ${entry.kind}/${entry.reliability} | hash=${entry.contentHash}\n${entry.text || `[Content not returned: ${entry.omittedChars} characters. ${entry.omission}]`}`,
				)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: payload };
		},
	});

	pi.registerCommand("memory", {
		description: "Search local research memory without adding results to the model context",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /memory <query>", "warning");
				return;
			}
			try {
				const currentProjectRoot = await resolveProjectRoot(pi, ctx.cwd);
				const payload = await withIndex(ctx.cwd, (db) =>
					searchMemory(db, {
						query,
						scope: "current",
						currentCwd: ctx.cwd,
						currentProjectRoot,
						currentSessionId: ctx.sessionManager.getSessionId(),
						limit: 3,
						includeCurrentSession: false,
						includeAbandonedBranches: false,
					}),
				);
				ctx.ui.notify(
					payload.length
						? payload.map((item) => `${item.ref} ${item.snippet}`).join("\n\n")
						: "No matching research memory was found.",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
