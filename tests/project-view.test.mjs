import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	PROJECT_VIEW_KIND,
	buildProjectView,
	commitProjectState,
	materializeProjectView,
	migrateLatestProjectState,
	renderProjectView,
} from "../.pi/lib/project-view.mjs";
import { RESEARCH_COMPACTION_KIND, RESEARCH_COMPACTION_VERSION } from "../.pi/lib/research-compact.mjs";
import { appendRuntimeEvent, initializeResearchRuntime, readRuntimeSnapshot } from "../.pi/lib/research-runtime.mjs";

function compaction(id = "compact-1") {
	return {
		type: "compaction",
		id,
		parentId: "user-1",
		details: {
			kind: RESEARCH_COMPACTION_KIND,
			version: RESEARCH_COMPACTION_VERSION,
			researchState: {
				researchQuestion: "Does intervention A distinguish H1 from H2?",
				currentClaim: "No strong update yet.",
				hypotheses: [{ id: "H1", status: "active", statement: "A changes the measured mechanism", evidenceRefs: [] }],
				unresolvedConfounders: ["probe may not exercise A"],
				openQuestions: [],
				nextExperiment: { question: "Run the oracle", intervention: "bypass the learned module" },
			},
		},
	};
}

test("Project state commit is idempotent and folds into the Runtime snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-view-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const input = { compactionEntry: compaction(), sessionId: "session-a", appendRuntimeEvent };
		await Promise.all([commitProjectState(runtime, input), commitProjectState(runtime, input)]);
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.projectState.state.researchQuestion, "Does intervention A distinguish H1 from H2?");
		assert.equal(snapshot.projectState.source.entryId, "compact-1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bounded session migration follows the active branch and commits its latest research compaction", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-migrate-"));
	try {
		const workspace = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		mkdirSync(workspace);
		mkdirSync(sessionDir);
		const abandoned = { ...compaction("abandoned"), parentId: "user-1" };
		const active = { ...compaction("active"), parentId: "user-1" };
		writeFileSync(join(sessionDir, "session.jsonl"), [
			{ type: "session", version: 3, id: "session-old", cwd: workspace },
			{ type: "message", id: "user-1", parentId: null, message: { role: "user", content: "question" } },
			abandoned,
			active,
			{ type: "message", id: "leaf", parentId: "active", message: { role: "assistant", content: "continue" } },
		].map(JSON.stringify).join("\n") + "\n");
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-new" }, { runtimeRoot: join(root, "runtime") });
		await migrateLatestProjectState({ runtime, sessionDir, cwd: workspace, appendRuntimeEvent });
		assert.equal((await readRuntimeSnapshot(runtime)).projectState.source.entryId, "active");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ProjectView is concise, validity-labelled, and inserted before the latest user prompt", () => {
	const view = buildProjectView({
		runtime: { projectKey: "project-fixture", workspaceRoot: "/workspace" },
		snapshot: {
			projectState: { state: compaction().details.researchState, source: { sessionId: "s1", entryId: "e1", contentHash: "abc" } },
			actors: [],
			actions: [{ id: "a1", status: "outcome_unknown", label: "executor", externalId: "j1" }],
			messages: [],
		},
		git: { branch: "main", commit: "a".repeat(40), dirty: true },
		experiments: [{ id: "exp-1", question: "Did A work?", validityJudgment: "invalid", observation: "metric moved", conclusion: "cannot update H1" }],
	});
	const text = renderProjectView(view);
	assert.match(text, /\[invalid\]/);
	assert.match(text, /outcome_unknown/);
	assert.match(text, /fallible/);
	const messages = materializeProjectView([
		{ role: "assistant", content: "old" },
		{ role: "user", content: "new question" },
	], text, { fingerprint: "fixture" });
	assert.equal(messages.length, 3);
	assert.equal(messages[1].customType, PROJECT_VIEW_KIND);
	assert.equal(messages[2].role, "user");
	assert.equal(materializeProjectView(messages, text).filter((message) => message.customType === PROJECT_VIEW_KIND).length, 1);
});
