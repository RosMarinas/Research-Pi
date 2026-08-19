import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import amendProjectStateExtension from "../.pi/extensions/amend-project-state.ts";
import recordExperimentExtension from "../.pi/extensions/record-experiment.ts";
import researchTransitionExtension from "../.pi/extensions/research-transition.ts";
import {
	RUNTIME_SESSION_POLICY_ENTRY_KIND,
	appendRuntimeEventAtRevision,
	initializeResearchRuntime,
	readRuntimeSnapshot,
	recordResearchTransition,
	resolveResearchRuntime,
} from "../.pi/lib/research-runtime.mjs";

function toolFrom(extension, extra = {}) {
	let tool;
	extension({
		registerTool(value) {
			tool = value;
		},
		appendEntry() {},
		...extra,
	});
	return tool;
}

test("record_experiment mirrors concise evidence into Project Runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-record-evidence-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await resolveResearchRuntime(workspace);
		await recordResearchTransition(runtime, {
			id: "new-current-route",
			to: "new current route",
			reason: "exercise explicit provenance for a delayed old-route result",
			oldDisposition: "superseded",
			authorityRefs: ["user-decision:test"],
		});
		const tool = toolFrom(recordExperimentExtension, {
			exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		});
		const result = await tool.execute("call-1", {
			question: "Does the parameterized contract remove lookup leakage?",
			hypothesis: "Continuous action holdout distinguishes learning from lookup.",
			intervention: "Run the held-out action-region assay.",
			prediction: "Shared continuous model recovers while codeword lookup fails.",
			validityChecks: ["held-out region remained unopened during training"],
			observation: "Recovery remained high on the development holdout.",
			validityJudgment: "valid",
			conclusion: "The parameterized route merits a formal frozen test.",
			nextStep: "Freeze decision lines after family3 hardening.",
			artifacts: [],
			trackRef: "project:initial",
		}, undefined, undefined, {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-evidence", getSessionFile: () => join(root, "session.jsonl") },
			model: null,
		});
		assert.equal(result.details.runtimeMirrored, true);
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.evidence.length, 1);
		assert.equal(snapshot.evidence[0].validityJudgment, "valid");
		assert.equal(snapshot.evidence[0].trackRef, "project:initial");
		assert.equal(snapshot.evidence[0].trackLabel, "initial project track");
		assert.equal(snapshot.revision, 2);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("record_research_transition is a narrow explicit project-memory operation", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-record-transition-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const tool = toolFrom(researchTransitionExtension);
		assert.equal(tool.name, "record_research_transition");
		assert.match(tool.description, /rare project-level change/);
		await tool.execute("call-2", {
			from: "v4 discrete contract",
			to: "CSB-Parameterized-v0 Q1",
			reason: "The old benchmark may collapse to finite table lookup.",
			oldDisposition: "archived",
			nextDecision: "Complete family3 hardening.",
			authorityRefs: ["user decision 2026-08-19"],
		}, undefined, undefined, {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-transition" },
		});
		const snapshot = await readRuntimeSnapshot(await resolveResearchRuntime(workspace));
		assert.equal(snapshot.activeTransition.to, "CSB-Parameterized-v0 Q1");
		assert.equal(snapshot.activeTransition.oldDisposition, "archived");
		assert.equal(snapshot.revision, 1);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("amend_project_state is a Leader-owned narrow correction and is disabled in clean Sessions", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-amend-state-tool-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-amend" });
		await appendRuntimeEventAtRevision(runtime, "project.state.committed", {
			state: {
				researchQuestion: "Which route is current?",
				currentClaim: "old wording",
				hypotheses: [],
				observations: [],
				decisions: [],
				unresolvedConfounders: [],
				openQuestions: [],
				nextExperiment: { question: "old question", intervention: "old intervention", distinguishingOutcomes: [], validityChecks: [] },
				criticalContext: [],
			},
			source: { sessionId: "session-amend", entryId: "base", trackRef: "project:initial" },
		}, 0, { id: "project-state:amend-tool-base" });

		const appended = [];
		const tool = toolFrom(amendProjectStateExtension, {
			appendEntry(kind, data) { appended.push({ kind, data }); },
		});
		assert.equal(tool.name, "amend_project_state");
		assert.match(tool.description, /append-only/);
		const projectContext = {
			cwd: workspace,
			sessionManager: {
				getSessionId: () => "session-amend",
				getBranch: () => [],
			},
		};
		const result = await tool.execute("call-3", {
			basedOnRevision: 1,
			reason: "The user clarified the intended claim boundary.",
			authorityRefs: ["user-decision:current-turn"],
			patch: { currentClaim: "screen only, not proof" },
		}, undefined, undefined, projectContext);
		assert.equal(result.details.revision, 2);
		assert.equal((await readRuntimeSnapshot(runtime)).projectState.state.currentClaim, "screen only, not proof");
		assert.equal(appended[0].kind, "research-project-state-amendment");

		await assert.rejects(
			tool.execute("call-4", {
				basedOnRevision: 2,
				reason: "must remain isolated",
				authorityRefs: ["user-decision:clean"],
				patch: { currentClaim: "must not be written" },
			}, undefined, undefined, {
				...projectContext,
				sessionManager: {
					...projectContext.sessionManager,
					getBranch: () => [{ type: "custom", customType: RUNTIME_SESSION_POLICY_ENTRY_KIND, data: { policy: "clean" } }],
				},
			}),
			/Clean Sessions cannot mutate Project State/,
		);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
