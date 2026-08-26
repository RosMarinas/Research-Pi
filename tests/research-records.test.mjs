import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
	runtimeActorAttachment,
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
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-evidence" });
		const attachment = runtimeActorAttachment(await readRuntimeSnapshot(runtime), "research-leader", "session-evidence");
		await recordResearchTransition(runtime, {
			sessionId: "session-evidence",
			attachmentEpoch: attachment.epoch,
			id: "new-current-route",
			to: "new current route",
			reason: "exercise explicit provenance for a delayed old-route result",
			oldDisposition: "superseded",
			authorityRefs: ["user-decision:test"],
		});
		const tool = toolFrom(recordExperimentExtension, {
			exec: async (_command, args) => {
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${workspace}\n`, stderr: "" };
				if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "record-time-head\n", stderr: "" };
				if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
				return { code: 1, stdout: "", stderr: "" };
			},
		});
		assert.equal(tool.parameters.required.includes("prediction"), false);
		assert.equal(tool.parameters.required.includes("hypothesis"), false);
		assert.equal(tool.parameters.required.includes("validityChecks"), false);
		const result = await tool.execute("call-1", {
			question: "Does the parameterized contract remove lookup leakage?",
			hypothesis: "Continuous action holdout distinguishes learning from lookup.",
			intervention: "Run the held-out action-region assay.",
			prediction: "Shared continuous model recovers while codeword lookup fails.",
			predictionStatus: "preregistered",
			evidenceMode: "confirmatory",
			registrationRef: "experiments/frozen-r4.yaml#decision-line",
			validityChecks: ["held-out region remained unopened during training"],
			observation: "Recovery remained high on the development holdout.",
			validityJudgment: "valid",
			conclusion: "The parameterized route merits a formal frozen test.",
			nextStep: "Freeze decision lines after family3 hardening.",
			runGitCommit: "run-producing-head",
			artifacts: [],
			trackRef: "project:initial",
		}, undefined, undefined, {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-evidence", getSessionFile: () => join(root, "session.jsonl") },
			model: null,
		});
		assert.equal(result.details.runtimeMirrored, true);
		assert.equal(result.details.predictionStatus, "preregistered");
		assert.equal(result.details.evidenceMode, "confirmatory");
		assert.equal(result.details.runGitCommit, "run-producing-head");
		assert.equal(result.details.recordedAtGit.commit, "record-time-head");
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.evidence.length, 1);
		assert.equal(snapshot.evidence[0].validityJudgment, "valid");
		assert.equal(snapshot.evidence[0].trackRef, "project:initial");
		assert.equal(snapshot.evidence[0].trackLabel, "initial project track");
		assert.equal(snapshot.evidence[0].registrationRef, "experiments/frozen-r4.yaml#decision-line");
		assert.equal(snapshot.evidence[0].runGitCommit, "run-producing-head");
		assert.equal(snapshot.evidence[0].recordedAtGit.commit, "record-time-head");
		assert.equal(snapshot.revision, 2);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("record_experiment preserves an omitted ex-ante prediction without inventing one", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-record-no-prediction-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const tool = toolFrom(recordExperimentExtension, {
			exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		});
		const result = await tool.execute("call-no-prediction", {
			question: "What did the exploratory diagnostic reveal?",
			intervention: "Inspect the completed diagnostic panel.",
			evidenceMode: "exploratory",
			validityChecks: ["the intended panel completed"],
			observation: "One unplanned contrast was informative.",
			validityJudgment: "valid",
			conclusion: "Treat the contrast as exploratory.",
			nextStep: "Register a powered confirmation.",
		}, undefined, undefined, {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-no-prediction", getSessionFile: () => join(root, "session.jsonl") },
			model: null,
		});
		assert.equal(result.details.prediction, "");
		assert.equal(result.details.predictionStatus, "not_recorded");
		assert.equal(result.details.hypothesis, "");
		assert.equal(result.details.evidenceMode, "exploratory");
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("record_experiment validates route provenance before durable persistence", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-record-route-preflight-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		let appendCount = 0;
		const tool = toolFrom(recordExperimentExtension, {
			exec: async () => ({ code: 1, stdout: "", stderr: "" }),
			appendEntry() { appendCount += 1; },
		});
		await assert.rejects(() => tool.execute("call-invalid-track", {
			question: "Which route produced this result?",
			intervention: "Inspect a delayed result.",
			evidenceMode: "validity_failure",
			observation: "The requested route does not exist.",
			validityJudgment: "invalid",
			conclusion: "Do not persist under a fabricated route.",
			trackRef: "transition:missing",
		}, undefined, undefined, {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-invalid-route", getSessionFile: () => join(root, "session.jsonl") },
			model: null,
		}), /Unknown research track provenance/);
		assert.equal(appendCount, 0);
		assert.equal(existsSync(join(workspace, ".pi", "research", "experiments.jsonl")), false);
		assert.equal((await readRuntimeSnapshot(await resolveResearchRuntime(workspace))).evidence.length, 0);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("record_experiment retries are idempotent across new tool call ids", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-record-idempotent-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		let appendCount = 0;
		const tool = toolFrom(recordExperimentExtension, {
			exec: async () => ({ code: 1, stdout: "", stderr: "" }),
			appendEntry() { appendCount += 1; },
		});
		const params = {
			question: "Did the diagnostic path execute?",
			intervention: "Run the path marker.",
			evidenceMode: "diagnostic",
			predictionStatus: "not_applicable",
			validityChecks: ["marker emitted once"],
			observation: "The marker was emitted.",
			validityJudgment: "valid",
			conclusion: "The path executed.",
		};
		const ctx = {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-idempotent", getSessionFile: () => join(root, "session.jsonl") },
			model: null,
		};
		const first = await tool.execute("call-first", params, undefined, undefined, ctx);
		const second = await tool.execute("call-retry", params, undefined, undefined, ctx);
		assert.equal(second.details.id, first.details.id);
		assert.equal(second.details.duplicateSkipped, true);
		assert.equal(appendCount, 1);
		assert.equal(readFileSync(join(workspace, ".pi", "research", "experiments.jsonl"), "utf8").trim().split("\n").length, 1);
		assert.equal((await readRuntimeSnapshot(await resolveResearchRuntime(workspace))).evidence.length, 1);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("record_experiment rejects contradictory prediction and evidence semantics", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-record-semantics-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const tool = toolFrom(recordExperimentExtension, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
		const ctx = {
			cwd: workspace,
			sessionManager: { getSessionId: () => "session-semantics", getSessionFile: () => join(root, "session.jsonl") },
			model: null,
		};
		const base = {
			question: "Can this record update the claim?",
			intervention: "Run one assay.",
			observation: "One result arrived.",
			validityJudgment: "valid",
			conclusion: "Interpret according to provenance.",
			validityChecks: ["assay completed"],
		};
		await assert.rejects(() => tool.execute("call-missing-registration", {
			...base,
			hypothesis: "The route works.",
			prediction: "The gate passes.",
			predictionStatus: "preregistered",
			evidenceMode: "confirmatory",
		}, undefined, undefined, ctx), /registrationRef is required/);
		await assert.rejects(() => tool.execute("call-contradictory-prediction", {
			...base,
			prediction: "The gate passes.",
			predictionStatus: "not_recorded",
		}, undefined, undefined, ctx), /prediction must be omitted/);
		await assert.rejects(() => tool.execute("call-no-validity-check", {
			...base,
			validityChecks: [],
		}, undefined, undefined, ctx), /at least one actual validity check/);
		await assert.rejects(() => tool.execute("call-valid-failure", {
			...base,
			evidenceMode: "validity_failure",
		}, undefined, undefined, ctx), /cannot have validityJudgment=valid/);
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
		await initializeResearchRuntime(workspace, { sessionId: "session-transition" });
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
