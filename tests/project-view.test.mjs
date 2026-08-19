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
import {
	appendRuntimeEvent,
	appendRuntimeEventAtRevision,
	initializeResearchRuntime,
	readRuntimeSnapshot,
	recordResearchTransition,
} from "../.pi/lib/research-runtime.mjs";

function compaction(id = "compact-1") {
	return {
		type: "compaction",
		id,
		parentId: "user-1",
			details: {
			kind: RESEARCH_COMPACTION_KIND,
			version: RESEARCH_COMPACTION_VERSION,
			projectRevision: 0,
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
		const input = { compactionEntry: compaction(), sessionId: "session-a", appendRuntimeEvent, appendRuntimeEventAtRevision, readRuntimeSnapshot };
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
		await migrateLatestProjectState({ runtime, sessionDir, cwd: workspace, appendRuntimeEvent, appendRuntimeEventAtRevision, readRuntimeSnapshot });
		assert.equal((await readRuntimeSnapshot(runtime)).projectState.source.entryId, "active");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a research transition makes the old state stale and blocks a stale compact from replacing it", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-transition-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await commitProjectState(runtime, {
			compactionEntry: compaction("old-state"),
			sessionId: "session-a",
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		await recordResearchTransition(runtime, {
			id: "transition-parameterized",
			from: "v4 discrete contract",
			to: "CSB-Parameterized-v0 Q1",
			reason: "The old task may reduce to table memorization.",
			oldDisposition: "archived",
			nextDecision: "Finish family3 hardening before freezing the formal test lines.",
			authorityRefs: ["docs/research/csb-param-q1.md"],
		});
		const stale = compaction("stale-session-state");
		stale.details.projectRevision = 1;
		const result = await commitProjectState(runtime, {
			compactionEntry: stale,
			sessionId: "session-stale",
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		assert.equal(result.status, "conflict");
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.projectState.source.entryId, "old-state");
		assert.equal(snapshot.activeTransition.to, "CSB-Parameterized-v0 Q1");
		assert.equal(snapshot.rejectedStates.length, 1);

		const view = buildProjectView({ runtime, snapshot, git: {}, experiments: [] });
		const text = renderProjectView(view);
		assert.equal(view.freshness, "stale");
		assert.match(text, /Active research track: CSB-Parameterized-v0 Q1/);
		assert.match(text, /Previous compacted state \(not current\)/);
		assert.doesNotMatch(text, /^Next experiment:/m);
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
			evidence: [],
			transitions: [],
			revision: 1,
		},
		git: { branch: "main", commit: "a".repeat(40), dirty: true },
		experiments: [{ id: "exp-1", question: "Did A work?", validityJudgment: "invalid", observation: "metric moved", conclusion: "cannot update H1" }],
	});
	const text = renderProjectView(view);
	assert.match(text, /\[invalid\]/);
	assert.match(text, /outcome_unknown/);
	assert.match(text, /fallible/);
	assert.doesNotMatch(text, /observation=metric moved/);
	const messages = materializeProjectView([
		{ role: "assistant", content: "old" },
		{ role: "user", content: "new question" },
	], text, { fingerprint: "fixture" });
	assert.equal(messages.length, 3);
	assert.equal(messages[1].customType, PROJECT_VIEW_KIND);
	assert.equal(messages[2].role, "user");
	assert.equal(materializeProjectView(messages, text).filter((message) => message.customType === PROJECT_VIEW_KIND).length, 1);
});

test("newer Runtime activity prevents an old next experiment from being presented as current", () => {
	const state = compaction().details.researchState;
	const view = buildProjectView({
		runtime: { projectKey: "project-pivot", workspaceRoot: "/workspace" },
		snapshot: {
			projectState: {
				state,
				source: { sessionId: "old-session", entryId: "old-compact", contentHash: "old" },
				committedAt: "2026-08-15T00:00:00Z",
				revision: 1,
			},
			actors: [],
			actions: [{ id: "new-route", status: "running", label: "csb-param-v0-q1", updatedAt: "2026-08-19T00:00:00Z" }],
			messages: [],
			evidence: [],
			transitions: [],
			activeTransition: null,
			revision: 1,
		},
		git: {},
		experiments: [],
	});
	const text = renderProjectView(view);
	assert.equal(view.freshness, "unconfirmed");
	assert.match(text, /Runtime activity is newer/);
	assert.match(text, /Previous next experiment \(not authoritative/);
	assert.match(text, /csb-param-v0-q1/);
});
