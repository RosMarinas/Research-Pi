import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extractSessionUnits,
	openMemoryIndex,
	readMemory,
	searchMemory,
	syncMemoryIndex,
} from "../.pi/lib/research-memory.mjs";

function writeJsonl(path, entries) {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

test("indexes Chinese text, short IDs, provenance, branch state, and redacts credentials", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-memory-"));
	try {
		const project = join(root, "project");
		const sessions = join(root, "sessions");
		const memory = join(root, "memory");
		mkdirSync(project, { recursive: true });
		mkdirSync(sessions, { recursive: true });
		mkdirSync(memory, { recursive: true });
		const sessionPath = join(sessions, "session-1.jsonl");
		writeJsonl(sessionPath, [
			{ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: project },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user", content: [{ type: "text", text: "科研压缩探针 V4；API_KEY=super-secret-value" }] },
			},
			{
				type: "message",
				id: "abandoned",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02Z",
				message: { role: "assistant", content: [{ type: "text", text: "zebra abandoned route" }] },
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:03Z",
				message: { role: "user", content: [{ type: "text", text: "选择中文科研压缩路线" }] },
			},
			{
				type: "custom",
				customType: "research-experiment",
				id: "exp-entry",
				parentId: "u2",
				timestamp: "2026-01-01T00:00:04Z",
				data: {
					id: "exp-1",
					question: "中文检索是否命中",
					hypothesis: "trigram 支持连续中文",
					intervention: "查询科研压缩",
					prediction: "返回 u1 或 u2",
					validityChecks: ["索引完成"],
					observation: "命中",
					validityJudgment: "valid",
					conclusion: "中文检索可用",
					nextStep: "测试真实会话",
				},
			},
			{
				type: "custom",
				customType: "research-transition",
				id: "transition-entry",
				parentId: "exp-entry",
				timestamp: "2026-01-01T00:00:05Z",
				data: {
					id: "transition-1",
					from: "旧离散契约",
					to: "参数化连续契约",
					oldDisposition: "archived",
					reason: "旧任务可能退化为查表记忆",
					nextDecision: "运行连续动作 holdout",
					authorityRefs: ["exp-1"],
				},
			},
			{
				type: "custom",
				customType: "research-side",
				id: "side-entry",
				parentId: "transition-entry",
				timestamp: "2026-01-01T00:00:06Z",
				data: {
					id: "side-1",
					question: "另一条隔离思路是什么",
					answer: "可以尝试 oracle 对照实验",
					model: { provider: "deepseek", id: "deepseek-v4-flash" },
				},
			},
		]);

		const extracted = extractSessionUnits(sessionPath);
		assert.equal(extracted.units.find((unit) => unit.entryId === "abandoned").activeBranch, 0);
		assert.match(extracted.units.find((unit) => unit.entryId === "u1").text, /API_KEY=\[REDACTED\]/);
		assert.doesNotMatch(extracted.units.find((unit) => unit.entryId === "u1").text, /super-secret-value/);

		const db = openMemoryIndex(join(memory, "memory.sqlite"));
		try {
			const firstSync = syncMemoryIndex(db, { sessionDir: sessions });
			assert.equal(firstSync.rebuiltSources, 1);
			assert.equal(syncMemoryIndex(db, { sessionDir: sessions }).rebuiltSources, 0);

			const base = {
				scope: "current",
				currentCwd: project,
				currentSessionId: "another-session",
				includeCurrentSession: false,
				includeAbandonedBranches: false,
			};
			const chinese = searchMemory(db, { ...base, query: "科研压缩", limit: 6 });
			assert.ok(chinese.length >= 1);
			assert.ok(chinese.every((result) => result.ref.includes("/S:session-1/E:")));
			assert.ok(chinese.every((result) => result.projectKey.startsWith("project-")));

			const shortId = searchMemory(db, { ...base, query: "V4", limit: 6 });
			assert.equal(shortId[0].entryId, "u1");

			const side = searchMemory(db, { ...base, query: "oracle 对照", kinds: ["side"] });
			assert.equal(side[0].entryId, "side-entry");
			assert.equal(side[0].reliability, "assistant-synthesis");
			const transition = searchMemory(db, { ...base, query: "参数化连续契约", kinds: ["transition"] });
			assert.equal(transition[0].entryId, "transition-entry");
			assert.equal(transition[0].reliability, "recorded-state");

			assert.equal(searchMemory(db, { ...base, query: "zebra" }).length, 0);
			const abandoned = searchMemory(db, { ...base, query: "zebra", includeAbandonedBranches: true });
			assert.equal(abandoned[0].entryId, "abandoned");

			const read = readMemory(db, { projectKey: chinese[0].projectKey, sessionId: "session-1", entryId: "exp-entry", radius: 1 });
			const experimentEntry = read.entries.find((entry) => entry.entryId === "exp-entry");
			assert.equal(experimentEntry.kind, "experiment");
			assert.match(experimentEntry.text, /中文检索可用/);
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("exact memory reads are project-qualified when Session identifiers collide", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-memory-project-scope-"));
	try {
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		for (const [name, project, text] of [["a", "project-a", "alpha project result"], ["b", "project-b", "beta project result"]]) {
			writeJsonl(join(sessions, `${name}.jsonl`), [
				{ type: "session", id: "shared-session", cwd: join(root, project) },
				{ type: "message", id: "shared-entry", parentId: null, message: { role: "user", content: text } },
			]);
		}
		const db = openMemoryIndex(join(root, "memory.sqlite"));
		try {
			syncMemoryIndex(db, { sessionDir: sessions });
			assert.throws(
				() => readMemory(db, { sessionId: "shared-session", entryId: "shared-entry" }),
				/ambiguous across projects/,
			);
			const hit = searchMemory(db, {
				query: "alpha", scope: "all", currentCwd: root, currentSessionId: "other", includeCurrentSession: false, includeAbandonedBranches: false,
			})[0];
			const exact = readMemory(db, { projectKey: hit.projectKey, sessionId: hit.sessionId, entryId: hit.entryId });
			assert.match(exact.entries[0].text, /alpha project result/);
			assert.doesNotMatch(exact.entries[0].text, /beta project result/);
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
