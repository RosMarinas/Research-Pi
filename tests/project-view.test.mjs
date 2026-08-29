import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	PROJECT_VIEW_DELTA_KIND,
	PROJECT_VIEW_KIND,
	PROJECT_VIEW_VERSION,
	buildProjectView,
	commitProjectState,
	materializeProjectViewContext,
	migrateLatestProjectState,
	projectViewDeltaFingerprint,
	projectViewFingerprint,
	projectViewRefreshFingerprint,
	renderProjectBrief,
	renderProjectView,
	renderProjectViewDelta,
} from "../.pi/lib/project-view.mjs";
import { RESEARCH_COMPACTION_KIND, RESEARCH_COMPACTION_VERSION } from "../.pi/lib/research-compact.mjs";
import {
	amendRuntimeProjectState,
	appendRuntimeEvent,
	appendRuntimeEventAtRevision,
	initializeResearchRuntime,
	readRuntimeSnapshot,
	recordRuntimeEvidence,
	recordRuntimeHandoff,
	recordResearchTransition,
	runtimeActorAttachment,
	runtimeTrackStatus,
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
				projectBrief: {
					overview: "A computational research project that tests whether intervention A changes the target mechanism.",
					finalGoal: "Identify a mechanism that survives the registered validity checks.",
					overallApproach: "Use discriminating interventions and oracle bypasses before retaining an implementation.",
					userPriorities: ["Prefer valid evidence over polished experimental code."],
					previousPhases: [{ goal: "Establish the assay", approach: "Build a diagnostic baseline", result: "The assay is usable but does not yet discriminate H1 from H2." }],
				},
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

async function leaderCredentials(runtime, sessionId = "session-a") {
	const attachment = runtimeActorAttachment(await readRuntimeSnapshot(runtime), "research-leader", sessionId);
	assert.ok(attachment?.epoch, `missing Leader attachment for ${sessionId}`);
	return { sessionId, attachmentEpoch: attachment.epoch };
}

test("Project state commit is idempotent and folds into the Runtime snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-view-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const input = { compactionEntry: compaction(), ...await leaderCredentials(runtime), appendRuntimeEvent, appendRuntimeEventAtRevision, readRuntimeSnapshot };
		await Promise.all([commitProjectState(runtime, input), commitProjectState(runtime, input)]);
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.projectState.state.researchQuestion, "Does intervention A distinguish H1 from H2?");
		assert.equal(snapshot.projectState.source.entryId, "compact-1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a stale Leader cannot commit canonical Project State after takeover", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-stale-leader-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const staleLeader = await leaderCredentials(runtime, "session-a");
		await initializeResearchRuntime(workspace, { sessionId: "session-b" }, { runtimeRoot: join(root, "runtime") });
		const result = await commitProjectState(runtime, {
			compactionEntry: compaction("stale-leader-state"),
			...staleLeader,
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		assert.equal(result.status, "stale_attachment");
		assert.equal((await readRuntimeSnapshot(runtime)).projectState, null);
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
		await migrateLatestProjectState({ runtime, sessionDir, cwd: workspace, leaderSessionId: "session-new", ...(await leaderCredentials(runtime, "session-new")), appendRuntimeEvent, appendRuntimeEventAtRevision, readRuntimeSnapshot });
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
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
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
			...await leaderCredentials(runtime),
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
		assert.match(text, /Current research track: .*CSB-Parameterized-v0 Q1/);
		assert.match(text, /structured frontier belongs to a retired route/);
		assert.doesNotMatch(text, /Candidate next experiment:/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a parallel research transition keeps the previous route current while adding explicit lineage", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-parallel-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await commitProjectState(runtime, {
			compactionEntry: compaction("route-a-state"),
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		const transition = await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
			id: "transition-parallel-b",
			from: "route A",
			to: "route B",
			reason: "both interventions remain independently informative",
			oldDisposition: "parallel",
			authorityRefs: ["user-decision:parallel"],
		});
		const snapshot = await readRuntimeSnapshot(runtime);
		const view = buildProjectView({ runtime, snapshot, git: {}, experiments: [] });
		const text = renderProjectView(view);
		assert.equal(transition.fromTrackRef, "project:initial");
		assert.equal(view.transitionSupersedesState, false);
		assert.match(text, /Current research track: .*route B/);
		assert.match(text, /Current question: Does intervention A/);
		assert.doesNotMatch(text, /structured frontier belongs to a retired route/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parallel route lineage survives a later transition of the primary route", async () => {
	const snapshot = {
		transitions: [
			{
				id: "transition-b",
				trackRef: "transition:transition-b",
				fromTrackRef: "project:initial",
				to: "route B",
				oldDisposition: "parallel",
			},
			{
				id: "transition-c",
				trackRef: "transition:transition-c",
				fromTrackRef: "transition:transition-b",
				to: "route C",
				oldDisposition: "superseded",
			},
		],
		activeTransition: {
			id: "transition-c",
			trackRef: "transition:transition-c",
			fromTrackRef: "transition:transition-b",
			to: "route C",
			oldDisposition: "superseded",
		},
	};
	assert.equal(runtimeTrackStatus(snapshot, "project:initial"), "parallel");
	assert.equal(runtimeTrackStatus(snapshot, "transition:transition-b"), "retired");
	assert.equal(runtimeTrackStatus(snapshot, "transition:transition-c"), "current");
});

test("a superseded state stays retired when the latest transition is parallel", () => {
	const state = compaction().details.researchState;
	const snapshot = {
		projectState: { state, source: { trackRef: "project:initial" }, revision: 1 },
		actors: [],
		actions: [],
		messages: [],
		evidence: [],
		transitions: [
			{ id: "route-a", trackRef: "transition:route-a", fromTrackRef: "project:initial", to: "route A", oldDisposition: "superseded", revision: 2 },
			{ id: "route-b", trackRef: "transition:route-b", fromTrackRef: "transition:route-a", to: "route B", oldDisposition: "parallel", revision: 3 },
		],
		activeTransition: { id: "route-b", trackRef: "transition:route-b", fromTrackRef: "transition:route-a", to: "route B", oldDisposition: "parallel", revision: 3 },
		revision: 3,
	};
	const view = buildProjectView({ runtime: { projectKey: "project-routes", workspaceRoot: "/workspace" }, snapshot, git: {}, experiments: [] });
	assert.equal(view.stateRouteStatus, "retired");
	assert.equal(view.transitionSupersedesState, true);
	assert.match(renderProjectView(view), /structured frontier belongs to a retired route/);
});

test("Project State amendments are partial, provenance-labelled, and revision guarded", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-amendment-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await commitProjectState(runtime, {
			compactionEntry: compaction("base-state"),
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		let snapshot = await readRuntimeSnapshot(runtime);
		const attachment = runtimeActorAttachment(snapshot, "research-leader", "session-a");
		const originalHypotheses = snapshot.projectState.state.hypotheses;
		const amendment = await amendRuntimeProjectState(runtime, {
			id: "correct-current-claim",
			sessionId: "session-a",
			attachmentEpoch: attachment.epoch,
			basedOnRevision: 1,
			reason: "The user corrected the accepted interpretation after reviewing the run.",
			authorityRefs: ["user-decision:2026-08-20", "run:R2a-v2"],
			patch: {
				currentClaim: "R2a-v2 is only a valid screen, not a frozen qualification.",
				openQuestions: ["Does the result survive the formal frozen assay?"],
				nextExperiment: { question: "Run the frozen assay" },
			},
		});
		assert.equal(amendment.revision, 2);
		snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.projectState.state.currentClaim, "R2a-v2 is only a valid screen, not a frozen qualification.");
		assert.equal(snapshot.projectState.state.nextExperiment.question, "Run the frozen assay");
		assert.equal(snapshot.projectState.state.nextExperiment.intervention, "bypass the learned module");
		assert.deepEqual(snapshot.projectState.state.hypotheses, originalHypotheses);
		assert.equal(snapshot.projectState.source.kind, "amendment");
		assert.deepEqual(snapshot.projectState.amendment.authorityRefs, ["user-decision:2026-08-20", "run:R2a-v2"]);
		const rendered = renderProjectView(buildProjectView({ runtime, snapshot, git: {}, experiments: [] }));
		assert.match(rendered, /Latest structured-state amendment:/);
		assert.match(rendered, /user-decision:2026-08-20/);

		await assert.rejects(
			amendRuntimeProjectState(runtime, {
				id: "stale-correction",
				sessionId: "session-a",
				attachmentEpoch: attachment.epoch,
				basedOnRevision: 1,
				reason: "stale competing correction",
				authorityRefs: ["user-decision:stale"],
				patch: { currentClaim: "must not win" },
			}),
			/refresh ProjectView/,
		);
		await assert.rejects(
			amendRuntimeProjectState(runtime, {
				id: "wrong-owner",
				sessionId: "session-a",
				attachmentEpoch: "stale-epoch",
				basedOnRevision: 2,
				reason: "must not bypass ownership",
				authorityRefs: ["user-decision:owner"],
				patch: { currentClaim: "must not win" },
			}),
			/attachment changed/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Project State amendment refuses to rewrite a retired research route", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-amendment-retired-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await commitProjectState(runtime, {
			compactionEntry: compaction("retired-state"),
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
			id: "retire-old-state",
			to: "replacement route",
			reason: "accepted evidence changes the active route",
			oldDisposition: "superseded",
			authorityRefs: ["experiment:replacement"],
		});
		const snapshot = await readRuntimeSnapshot(runtime);
		const attachment = runtimeActorAttachment(snapshot, "research-leader", "session-a");
		await assert.rejects(
			amendRuntimeProjectState(runtime, {
				id: "rewrite-retired",
				sessionId: "session-a",
				attachmentEpoch: attachment.epoch,
				basedOnRevision: 2,
				reason: "attempt to patch obsolete memory",
				authorityRefs: ["user-decision:bad-target"],
				patch: { currentClaim: "obsolete" },
			}),
			/retired research track/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a transition can continue an explicit live parallel route", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-parallel-source-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
			id: "route-b",
			to: "route B",
			reason: "keep the initial route alive",
			oldDisposition: "parallel",
			authorityRefs: ["user-decision:parallel"],
		});
		const routeC = await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
			id: "route-c",
			fromTrackRef: "project:initial",
			to: "route C",
			reason: "continue and replace only the initial route",
			oldDisposition: "superseded",
			authorityRefs: ["experiment:route-c"],
		});
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(routeC.fromTrackRef, "project:initial");
		assert.equal(runtimeTrackStatus(snapshot, "transition:route-b"), "parallel");
		assert.equal(runtimeTrackStatus(snapshot, "transition:route-c"), "current");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("research transitions use Project revision compare-and-append", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-transition-cas-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
			id: "transition-first",
			to: "route B",
			reason: "first accepted transition",
			oldDisposition: "superseded",
			authorityRefs: ["user-decision:first"],
			basedOnRevision: 0,
		});
		await assert.rejects(
				recordResearchTransition(runtime, {
					...await leaderCredentials(runtime),
				id: "transition-stale",
				to: "route C",
				reason: "stale competing transition",
				oldDisposition: "superseded",
				authorityRefs: ["user-decision:stale"],
				basedOnRevision: 0,
			}),
			/refresh ProjectView/,
		);
		assert.deepEqual((await readRuntimeSnapshot(runtime)).transitions.map((item) => item.id), ["transition-first"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ProjectView materializes one stable Brief and one live Delta at the prompt tail", () => {
	const view = buildProjectView({
		runtime: { projectKey: "project-fixture", workspaceRoot: "/workspace" },
			snapshot: {
			projectState: { state: compaction().details.researchState, source: { sessionId: "s1", entryId: "e1", contentHash: "abc" }, revision: 1 },
			projectBrief: { state: compaction().details.researchState, source: { sessionId: "s1", entryId: "e1", contentHash: "abc" }, revision: 1, transitions: [], handoffs: [] },
			actors: [],
			actions: [{ id: "a1", status: "outcome_unknown", label: "executor", externalId: "j1" }],
			messages: [],
			evidence: [{
				id: "exp-1",
				revision: 2,
				timestamp: "2026-08-21T00:00:00Z",
				question: "Did A work?",
				validityJudgment: "invalid",
				observation: "metric moved",
				conclusion: "cannot update H1",
			}],
			transitions: [],
			revision: 1,
		},
		git: { branch: "main", commit: "a".repeat(40), dirty: true },
		experiments: [],
	});
	const brief = renderProjectBrief(view);
	const delta = renderProjectViewDelta(view);
	assert.match(brief, /PROJECT OVERVIEW AND FINAL GOAL/);
	assert.doesNotMatch(brief, /outcome_unknown|metric moved|branch=main/);
	assert.match(delta, /outcome_unknown/);
	assert.match(delta, /observation: metric moved/);
	const messages = materializeProjectViewContext([
		{ role: "assistant", content: "old" },
		{ role: "custom", content: "obsolete", customType: PROJECT_VIEW_DELTA_KIND, details: { transient: true } },
		{ role: "user", content: "new question" },
	], brief, delta, { fingerprint: "fixture" });
	assert.equal(messages.filter((message) => message.customType === PROJECT_VIEW_KIND).length, 1);
	assert.equal(messages.filter((message) => message.customType === PROJECT_VIEW_DELTA_KIND).length, 1);
	assert.equal(messages.at(-1).customType, PROJECT_VIEW_DELTA_KIND);
	assert.equal(messages.at(-1).details.transient, true);
	assert.equal(messages.find((message) => message.customType === PROJECT_VIEW_KIND).details.version, PROJECT_VIEW_VERSION);
});

test("ProjectView never duplicates Runtime mailbox bodies", () => {
	const view = buildProjectView({
		runtime: { projectKey: "project-analysis-view", workspaceRoot: "/workspace" },
		snapshot: {
			actors: [], actions: [], evidence: [], transitions: [], handoffs: [], revision: 0,
			messages: [{ id: "leader-only", type: "notify", from: "analysis:one", to: "research-leader", status: "queued", body: "PRIVATE_LEADER_MAILBOX_BODY" }],
		},
		git: {}, experiments: [],
	});
	const analysisText = renderProjectView(view, { includeDirectedMessages: false });
	assert.match(analysisText, /Directed Runtime message contents belong only to the addressed Leader Session/);
	assert.doesNotMatch(analysisText, /PRIVATE_LEADER_MAILBOX_BODY|leader-only|analysis:one/);
	const leaderText = renderProjectView(view);
	assert.match(leaderText, /separate single-delivery channel/);
	assert.doesNotMatch(leaderText, /PRIVATE_LEADER_MAILBOX_BODY|leader-only|analysis:one/);
});

test("ProjectView Delta is self-contained and always carries the latest completed handoff", () => {
	const view = buildProjectView({
		runtime: { projectKey: "project-handoff-delta", workspaceRoot: "/workspace" },
		snapshot: {
			actors: [], actions: [], messages: [], evidence: [], transitions: [], revision: 0,
			handoffs: [{ id: "handoff-1", task: "Inspect the route", summary: "HANDOFF_RESULT_ONCE", recordedAt: "2026-08-27T00:00:00Z" }],
		},
		git: {}, experiments: [],
	});
	const first = renderProjectViewDelta(view);
	assert.match(first, /HANDOFF_RESULT_ONCE/);
	const repeated = renderProjectViewDelta(view);
	assert.equal(repeated, first);
	assert.equal(projectViewDeltaFingerprint(view), projectViewDeltaFingerprint(view));
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
	assert.match(text, /Do not report an earlier baseline claim as current/);
	assert.match(text, /Candidate next experiment: Run the oracle/);
	assert.match(text, /csb-param-v0-q1/);
});

test("new evidence becomes an immediate semantic delta while the old claim stays a labelled baseline", () => {
	const state = compaction().details.researchState;
	const view = buildProjectView({
		runtime: { projectKey: "project-delta", workspaceRoot: "/workspace" },
		snapshot: {
			projectState: {
				state,
				source: { sessionId: "s1", entryId: "compact-1", contentHash: "baseline" },
				committedAt: "2026-08-20T00:00:00Z",
				updatedAt: "2026-08-20T00:00:00Z",
				revision: 1,
			},
			actors: [],
			actions: [],
			messages: [],
			transitions: [],
			activeTransition: null,
			evidence: [{
				id: "exp-new",
				revision: 2,
				timestamp: "2026-08-21T00:00:00Z",
				question: "Did the oracle expose the mechanism?",
				intervention: "Bypassed the learned encoder.",
				observation: "The action margin recovered from 0.01 to 0.42.",
				validityChecks: ["The bypass path was active."],
				validityJudgment: "valid",
				evidenceMode: "diagnostic",
				conclusion: "The learned encoder, not the decoder, loses the signal.",
				nextStep: "Test whether staged training preserves the margin.",
				trackRef: "project:initial",
			}],
			revision: 2,
		},
		git: {},
		experiments: [],
	});
	const text = renderProjectView(view);
	assert.equal(view.freshness, "stale");
	assert.equal(view.pendingEvidenceCount, 1);
	assert.match(text, /Evidence-bounded position: No strong update yet/);
	assert.match(text, /New evidence after structured state \(1 total record/);
	assert.match(text, /observation: The action margin recovered from 0.01 to 0.42/);
	assert.match(text, /interpretation: The learned encoder, not the decoder/);
	assert.match(text, /Do not report an earlier baseline claim as current/);
});

test("ProjectView refresh and prompt fingerprints ignore lifecycle-only churn", () => {
	const base = {
		revision: 4,
		actions: [{ id: "a1", status: "running", label: "probe", externalId: "job-1", trackRef: "project:initial" }],
		messages: [],
	};
	assert.equal(
		projectViewRefreshFingerprint({ ...base, activations: [{ id: "activation-1", status: "active" }], ledgerEventCount: 10 }),
		projectViewRefreshFingerprint({ ...base, activations: [{ id: "activation-2", status: "settled" }], ledgerEventCount: 12 }),
	);
	assert.equal(
		projectViewRefreshFingerprint(base),
		projectViewRefreshFingerprint({ ...base, messages: [{ id: "m1", status: "queued", type: "result", from: "codex", body: "done" }] }),
	);

	const first = buildProjectView({
		runtime: { projectKey: "cache", workspaceRoot: "/workspace" },
		snapshot: { projectState: null, actors: [], actions: [], messages: [], evidence: [], transitions: [], revision: 0 },
		git: {},
		experiments: [],
	});
	const second = { ...first, generatedFrom: { actors: 99, actions: 99, messages: 99 } };
	assert.equal(projectViewFingerprint(first), projectViewFingerprint(second));
});

test("Project Brief bytes survive live evidence and route changes, then change only at the next compact", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-brief-boundary-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await commitProjectState(runtime, {
			compactionEntry: compaction("brief-v1"),
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		const initialView = buildProjectView({ runtime, snapshot: await readRuntimeSnapshot(runtime), git: {}, experiments: [] });
		const initialBrief = renderProjectBrief(initialView);
		const initialFingerprint = projectViewFingerprint(initialView);

		await recordRuntimeEvidence(runtime, {
			id: "evidence-after-brief",
			question: "Did the route survive?",
			intervention: "Run a discriminating probe.",
			observation: "The route failed its validity gate.",
			validityChecks: ["The intended route executed."],
			validityJudgment: "valid",
			conclusion: "Replace the route.",
		});
		await recordRuntimeHandoff(runtime, { id: "handoff-after-brief", task: "Inspect the failure", summary: "The failure is interpretable." });
		await recordResearchTransition(runtime, {
			...await leaderCredentials(runtime),
			id: "transition-after-brief",
			from: "route A",
			to: "route B",
			reason: "The valid probe retired route A.",
			oldDisposition: "superseded",
			authorityRefs: ["experiment:evidence-after-brief"],
		});
		const liveView = buildProjectView({ runtime, snapshot: await readRuntimeSnapshot(runtime), git: { branch: "route-b" }, experiments: [] });
		assert.equal(renderProjectBrief(liveView), initialBrief);
		assert.equal(projectViewFingerprint(liveView), initialFingerprint);
		assert.match(renderProjectViewDelta(liveView), /route B|failure is interpretable|route failed its validity gate/);

		const successor = compaction("brief-v2");
		successor.details.projectRevision = (await readRuntimeSnapshot(runtime)).revision;
		successor.details.researchState.projectBrief = {
			...successor.details.researchState.projectBrief,
			overallApproach: "Use route B and retain route A as a closed negative result.",
			previousPhases: [{ goal: "Test route A", approach: "Run the discriminating probe", result: "Route A failed a valid gate and was retired." }],
		};
		await commitProjectState(runtime, {
			compactionEntry: successor,
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		const nextView = buildProjectView({ runtime, snapshot: await readRuntimeSnapshot(runtime), git: {}, experiments: [] });
		assert.notEqual(renderProjectBrief(nextView), initialBrief);
		assert.match(renderProjectBrief(nextView), /Route A failed a valid gate and was retired/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ProjectView keeps the newest live evidence when a large baseline must be truncated", () => {
	const repeated = "decision-critical detail ".repeat(80);
	const state = {
		...compaction().details.researchState,
		researchQuestion: repeated,
		currentClaim: repeated,
		hypotheses: Array.from({ length: 6 }, (_, index) => ({ id: `H${index}`, status: "active", statement: repeated })),
		decisions: Array.from({ length: 4 }, () => ({ decision: repeated, reversible: true })),
		criticalContext: Array.from({ length: 4 }, () => repeated),
		unresolvedConfounders: Array.from({ length: 4 }, () => repeated),
		openQuestions: Array.from({ length: 4 }, () => repeated),
	};
	const evidence = Array.from({ length: 4 }, (_, index) => ({
		id: `exp-${index}`,
		revision: index + 2,
		timestamp: `2026-08-2${index + 1}T00:00:00Z`,
		question: repeated,
		intervention: repeated,
		observation: index === 3 ? "NEWEST_OBSERVATION_MUST_SURVIVE" : repeated,
		validityChecks: [repeated, repeated],
		validityJudgment: "valid",
		conclusion: repeated,
		trackRef: "project:initial",
	}));
	const view = buildProjectView({
		runtime: { projectKey: "large", workspaceRoot: "/workspace" },
		snapshot: {
			projectState: { state, source: { sessionId: "s", entryId: "e" }, revision: 1, updatedAt: "2026-08-20T00:00:00Z" },
			actors: [], actions: [], messages: [], transitions: [], evidence, revision: 5,
		},
		git: {},
		experiments: [],
	});
	const text = renderProjectView(view);
	assert.ok(text.length <= 12_000);
	assert.match(text, /Current frontier truncated; latest progress above is preserved/);
	assert.match(text, /=== LATEST MEANINGFUL PROGRESS ===/);
	assert.match(text, /NEWEST_OBSERVATION_MUST_SURVIVE/);
});

test("ProjectView compresses earlier work but expands the latest handoff under project direction", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-project-handoff-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		await commitProjectState(runtime, {
			compactionEntry: compaction("direction-state"),
			...await leaderCredentials(runtime),
			appendRuntimeEvent,
			appendRuntimeEventAtRevision,
			readRuntimeSnapshot,
		});
		await recordRuntimeHandoff(runtime, {
			id: "handoff-earlier",
			task: "Repair the experiment launcher",
			summary: "The launcher now preserves the registered run identity.",
			sessionId: "session-a",
			toolNames: ["edit"],
		});
		await recordRuntimeHandoff(runtime, {
			id: "handoff-latest",
			kind: "research-evidence",
			task: "Run the oracle bypass diagnostic",
			summary: "The action margin recovered from 0.02 to 0.31.\n\nThis localizes the loss before the decoder but does not qualify the full route.",
			sessionId: "session-b",
			toolNames: ["record_experiment"],
			git: { branch: "main", commit: "b".repeat(40), dirty: false },
		});
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.revision, 1, "operational handoffs must not advance scientific Project revision");
		const view = buildProjectView({ runtime, snapshot, git: {}, experiments: [] });
		const text = renderProjectView(view);
		assert.ok(text.indexOf("=== PROJECT OVERVIEW AND FINAL GOAL ===") < text.indexOf("=== LATEST MEANINGFUL PROGRESS ==="));
		assert.doesNotMatch(renderProjectBrief(view), /Repair the experiment launcher|Run the oracle bypass diagnostic/);
		assert.match(text, /Task: Run the oracle bypass diagnostic/);
		assert.match(text, /The action margin recovered from 0.02 to 0.31/);
		assert.match(text, /context, not an automatic next task/);
		assert.match(text, /The current user request selects the immediate task/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
