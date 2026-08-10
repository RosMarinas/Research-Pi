import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openMemoryIndex, readMemory, searchMemory, syncMemoryIndex } from "../lib/research-memory.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const memoryDir = join(harnessRoot, ".pi", "memory");
const databasePath = join(memoryDir, "memory.sqlite");
const sessionDir = join(harnessRoot, ".pi", "sessions");

function withIndex<T>(cwd: string, operation: (db: ReturnType<typeof openMemoryIndex>, sync: unknown) => T): T {
	mkdirSync(memoryDir, { recursive: true });
	const db = openMemoryIndex(databasePath);
	try {
		const sync = syncMemoryIndex(db, {
			sessionDir,
			experimentLedgerPaths: [join(cwd, ".pi", "research", "experiments.jsonl")],
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
	return `${lines.join("\n\n")}\n\nUse research_memory_read with sessionId and entryId to inspect exact surrounding entries before relying on a hit.`;
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
			"Search prior Pi sessions and recorded experiments using a local, non-vector full-text index. Returns bounded snippets with stable session/entry provenance; it does not automatically inject history.",
		promptSnippet: "Search prior project sessions and experiment evidence when earlier work is materially relevant",
		promptGuidelines: [
			"Use research_memory_search when the user refers to earlier sessions, previous experiments, an old decision, or when resolving uncertainty would benefit from known prior evidence. Do not call it routinely every turn.",
			"Prefer recorded-evidence hits over assistant-synthesis or derived-summary hits. Read the exact entry before treating a snippet as evidence, and preserve its S:<session>/E:<entry> reference.",
			"Absence of a search hit is not evidence that an experiment was never run; report the searched scope and query when absence matters.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Literal words, phrase, run ID, method, observation, or decision to retrieve" }),
			scope: Type.Optional(
				Type.Union([Type.Literal("current_project"), Type.Literal("all_projects")], {
					description: "Default current_project; all_projects must be intentional",
				}),
			),
			kinds: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("experiment"),
						Type.Literal("checkpoint"),
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
			const payload = withIndex(ctx.cwd, (db, sync) => {
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
			"Read an exact indexed historical entry and a small surrounding window after research_memory_search. Content is local, bounded, redacted for common credential patterns, and accompanied by hashes and provenance.",
		promptSnippet: "Verify a historical memory hit against its exact entry and nearby context",
		promptGuidelines: [
			"Call research_memory_read only for a concrete hit returned by research_memory_search, unless the user supplied an exact session and entry ID.",
			"Treat assistant and compaction text as fallible prior reasoning. Recorded experiments still require their stated validity judgment to support a conclusion.",
		],
		parameters: Type.Object({
			sessionId: Type.String({ description: "Session identifier from a search result" }),
			entryId: Type.String({ description: "Entry identifier from a search result" }),
			radius: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Indexed entries before/after; default 1" })),
			maxChars: Type.Optional(
				Type.Integer({ minimum: 500, maximum: 40000, description: "Maximum returned characters; default 12000" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const payload = withIndex(ctx.cwd, (db, sync) => ({
				sync,
				result: readMemory(db, {
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
						`${entry.ref} | ${entry.kind}/${entry.reliability} | hash=${entry.contentHash}\n${entry.text}`,
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
				const payload = withIndex(ctx.cwd, (db) =>
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
