import assert from "node:assert/strict";
import test from "node:test";
import researchCompactionExtension, { researchCompactionThresholds } from "../.pi/extensions/research-compaction.ts";
import {
	applyResearchStatePatch,
	buildResearchCompactionDetails,
	buildResearchCompactionPrompt,
	RESEARCH_COMPACTION_SYSTEM_PROMPT,
	collectResearchEvidence,
	mergeProjectRuntimeEvidence,
	normalizeResearchState,
	parseResearchCompactionResponse,
	parseResearchState,
	parseResearchStateWithDiagnostics,
	RESEARCH_HARD_COMPACT_TOKENS,
	RESEARCH_SOFT_COMPACT_TOKENS,
	RESEARCH_STATE_TOOL,
	RESEARCH_SUMMARY_MAX_TOKENS,
	RESEARCH_SUMMARY_TARGET_TOKENS,
	renderResearchSummary,
	selectResearchCompactionPolicy,
} from "../.pi/lib/research-compact.mjs";

test("explicit Project State patches preserve omitted fields and replace arrays deliberately", () => {
	const current = {
		projectBrief: {
			overview: "A mechanism-identification project.",
			finalGoal: "Identify the causal mechanism.",
			overallApproach: "Use discriminating interventions.",
			userPriorities: ["Keep evidence boundaries explicit."],
			previousPhases: [],
		},
		researchQuestion: "Which mechanism explains the gain?",
		currentClaim: "No supported claim yet.",
		hypotheses: [{ id: "H1", statement: "The gain is causal", status: "active", predictions: [], rationale: "", evidenceRefs: [] }],
		observations: [],
		decisions: [],
		unresolvedConfounders: ["seed variance"],
		openQuestions: ["Does the oracle close the gap?"],
		nextExperiment: {
			question: "Run the oracle",
			intervention: "Bypass the learned module",
			distinguishingOutcomes: ["gap closes"],
			validityChecks: ["bypass is active"],
		},
		criticalContext: ["test split remains unopened"],
	};
	const patched = applyResearchStatePatch(current, {
		currentClaim: "The pilot is a screen, not proof.",
		openQuestions: [],
		nextExperiment: { question: "Run the frozen assay" },
	});
	assert.equal(patched.currentClaim, "The pilot is a screen, not proof.");
	assert.deepEqual(patched.openQuestions, []);
	assert.deepEqual(patched.hypotheses, current.hypotheses);
	assert.equal(patched.nextExperiment.question, "Run the frozen assay");
	assert.equal(patched.nextExperiment.intervention, "Bypass the learned module");
	assert.notEqual(patched, current);
	assert.equal(current.currentClaim, "No supported claim yet.");
	assert.throws(
		() => applyResearchStatePatch(current, { projectBrief: { overview: "A live rewrite must not enter the stable Brief." } }),
		/Unknown Project State amendment field.*projectBrief/,
	);
	assert.throws(
		() => applyResearchStatePatch(current, {
			hypotheses: [{ id: "H1", statement: "The gain is causal", status: "supported", evidenceRefs: [] }],
		}),
		/without an evidence reference/,
	);
});

test("compaction owns the complete stable Project Brief and preserves omitted prior fields", () => {
	assert.ok(RESEARCH_STATE_TOOL.parameters.required.includes("projectBrief"));
	assert.deepEqual(RESEARCH_STATE_TOOL.parameters.properties.projectBrief.required, [
		"overview",
		"finalGoal",
		"overallApproach",
		"userPriorities",
		"previousPhases",
	]);
	const previousBrief = {
		overview: "A stable project introduction.",
		finalGoal: "Reach the final registered qualification.",
		overallApproach: "Advance through discriminating mechanism tests.",
		userPriorities: ["Do not confuse screens with qualification."],
		previousPhases: [{ goal: "Qualify the assay", approach: "Use an oracle probe", result: "The assay became interpretable." }],
	};
	const normalized = normalizeResearchState({
		projectBrief: { finalGoal: "Reach the final registered qualification." },
		researchQuestion: "Which current route should run next?",
		currentClaim: "The latest run remains unresolved.",
		hypotheses: [],
		observations: [],
		decisions: [],
		unresolvedConfounders: [],
		openQuestions: [],
		nextExperiment: {},
		criticalContext: [],
	}, {
		experiments: [],
		checkpoints: [],
		previousState: { projectBrief: previousBrief },
		validRefs: new Set(),
		sourceCatalog: [],
	});
	assert.deepEqual(normalized.state.projectBrief, previousBrief);
	const summary = renderResearchSummary(normalized.state, { experiments: [], checkpoints: [] });
	assert.match(summary, /## Stable Project Brief/);
	assert.match(summary, /A stable project introduction/);
	assert.match(summary, /Qualify the assay -> Use an oracle probe -> The assay became interpretable/);
	assert.doesNotMatch(summary.split("## Research question")[0], /Which current route should run next/);
});

test("Runtime Project State becomes the next compaction's prior state when it is newer", () => {
	const evidence = {
		experiments: [],
		checkpoints: [],
		previousState: { currentClaim: "older Session state" },
		previousProjectRevision: 3,
		previousCompactionEntryId: "compact-old",
		validRefs: new Set(),
		sourceCatalog: [],
	};
	mergeProjectRuntimeEvidence(evidence, {
		projectState: {
			revision: 4,
			state: { currentClaim: "explicitly amended Project State" },
			source: { entryId: "amendment-new" },
		},
		evidence: [],
	});
	assert.equal(evidence.previousState.currentClaim, "explicitly amended Project State");
	assert.equal(evidence.previousProjectRevision, 4);
	assert.equal(evidence.previousCompactionEntryId, "compact-old");
	assert.equal(evidence.previousProjectStateEntryId, "amendment-new");
});

test("clean compaction state stays local when the Session later restores Project inheritance", () => {
	const branch = [
		{
			type: "compaction",
			id: "project-compact",
			details: {
				kind: "research-pi-compaction",
				version: 1,
				inheritancePolicy: "project",
				projectRevision: 3,
				researchState: { currentClaim: "canonical Project claim" },
			},
		},
		{
			type: "compaction",
			id: "clean-compact",
			details: {
				kind: "research-pi-compaction",
				version: 1,
				inheritancePolicy: "clean",
				projectRevision: 3,
				researchState: { currentClaim: "independent clean-session synthesis" },
			},
		},
		{
			type: "compaction",
			id: "analysis-compact",
			details: {
				kind: "research-pi-compaction",
				version: 1,
				inheritancePolicy: "analysis",
				projectRevision: 3,
				researchState: { currentClaim: "independent analysis-session synthesis" },
			},
		},
	];
	assert.equal(
		collectResearchEvidence(branch, "session-clean", undefined, { inheritancePolicy: "clean" }).previousState.currentClaim,
		"independent clean-session synthesis",
	);
	assert.equal(
		collectResearchEvidence(branch, "session-clean", undefined, { inheritancePolicy: "project" }).previousState.currentClaim,
		"canonical Project claim",
	);
	assert.equal(
		collectResearchEvidence(branch, "session-analysis", undefined, { inheritancePolicy: "analysis" }).previousState.currentClaim,
		"independent analysis-session synthesis",
	);
});

test("research threshold compaction waits until the agent run settles", () => {
	const handlers = new Map();
	const notices = [];
	let compactOptions;
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand() {},
	};
	researchCompactionExtension(pi);
	const ctx = {
		hasUI: true,
		ui: {
			notify(message, level) {
				notices.push({ message, level });
			},
		},
		getContextUsage() {
			return { tokens: RESEARCH_SOFT_COMPACT_TOKENS + 1 };
		},
		compact(options) {
			compactOptions = options;
		},
	};

	handlers.get("turn_end")({ type: "turn_end" }, ctx);
	assert.equal(compactOptions, undefined, "turn_end may still be an intermediate tool-call turn and must not abort it");
	assert.match(notices[0].message, /scheduled after the current run settles/);

	handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.match(compactOptions.customInstructions, /Automatic research soft compaction/);

	const firstOptions = compactOptions;
	handlers.get("turn_end")({ type: "turn_end" }, ctx);
	handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal(compactOptions, firstOptions, "a running compaction must not be duplicated");
});

test("short-context Leader models compact before their model window", () => {
	assert.deepEqual(researchCompactionThresholds({ contextWindow: 1_000_000 }), {
		softTokens: RESEARCH_SOFT_COMPACT_TOKENS,
		hardTokens: RESEARCH_HARD_COMPACT_TOKENS,
	});
	const hy3 = researchCompactionThresholds({ contextWindow: 256_000 });
	assert.equal(hy3.hardTokens, 256_000 - 32 * 1024);
	assert.equal(hy3.softTokens, Math.floor(hy3.hardTokens * 0.75));
	assert.ok(hy3.softTokens < hy3.hardTokens);
});

function experimentEntry(id, parentId, validityJudgment) {
	return {
		type: "custom",
		customType: "research-experiment",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:0${id.at(-1)}Z`,
		data: {
			id: `record-${id}`,
			question: "哪个假设成立",
			hypothesis: id === "e1" ? "无效运行不应拒绝 H1" : "有效运行支持 H2",
			intervention: "运行探针",
			prediction: "观察区分结果",
			predictionStatus: "preregistered",
			evidenceMode: "confirmatory",
			registrationRef: `registration.yaml#${id}`,
			validityChecks: ["确认介入"],
			observation: id === "e1" ? "环境失败" : "结果符合预测",
			validityJudgment,
			conclusion: id === "e1" ? "不可解释" : "支持 H2",
			nextStep: "继续消融",
		},
	};
}

test("structured compaction preserves prior hypotheses and downgrades unsupported strong claims", () => {
	const branch = [
		{
			type: "compaction",
			id: "old-compact",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			details: {
				kind: "research-pi-compaction",
				version: 1,
				researchState: {
					hypotheses: [{ id: "H3", statement: "保留的旧假设", status: "active", predictions: [], rationale: "", evidenceRefs: [] }],
				},
			},
		},
		experimentEntry("e1", "old-compact", "invalid"),
		experimentEntry("e2", "e1", "valid"),
		{
			type: "message",
			id: "u1",
			parentId: "e2",
			timestamp: "2026-01-01T00:00:03Z",
			message: { role: "user", content: [{ type: "text", text: "继续比较 H1 与 H2" }] },
		},
		{
			type: "message",
			id: "kept",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:04Z",
			message: { role: "assistant", content: [{ type: "text", text: "recent tail" }] },
		},
	];
	const evidence = collectResearchEvidence(branch, "session-x", "kept");
	const invalidRef = "S:session-x/E:e1";
	const validRef = "S:session-x/E:e2";
	const normalized = normalizeResearchState(
		{
			researchQuestion: "比较假设",
			currentClaim: "H2 较强",
			hypotheses: [
				{ id: "H1", statement: "假设一", status: "rejected", evidenceRefs: [invalidRef], predictions: [] },
				{ id: "H2", statement: "假设二", status: "supported", evidenceRefs: [validRef, "invented"], predictions: [] },
			],
			observations: [{ statement: "一个无来源观察", validity: "valid", evidenceRefs: [] }],
			decisions: [],
			unresolvedConfounders: ["随机种子"],
			openQuestions: [],
			nextExperiment: { question: "做消融", intervention: "移除模块", distinguishingOutcomes: ["差异消失"], validityChecks: ["同 seed"] },
			criticalContext: [],
		},
		evidence,
	);

	assert.equal(normalized.state.hypotheses.find((item) => item.id === "H1").status, "inconclusive");
	assert.equal(normalized.state.hypotheses.find((item) => item.id === "H2").status, "supported");
	assert.deepEqual(normalized.state.hypotheses.find((item) => item.id === "H2").evidenceRefs, [validRef]);
	assert.ok(normalized.state.hypotheses.some((item) => item.id === "H3"));
	assert.equal(normalized.state.observations[0].validity, "unverified");

	const summary = renderResearchSummary(normalized.state, evidence, { read: ["a.py"], modified: ["b.py"] });
	assert.match(summary, /H1 \[inconclusive\]/);
	assert.match(summary, /S:session-x\/E:e2 \[valid; confirmatory; prediction=preregistered\]/);
	assert.match(summary, /本摘要不是事实源/);

	const details = buildResearchCompactionDetails({
		state: normalized.state,
		evidence,
		warnings: normalized.warnings,
		sessionId: "session-x",
		reason: "manual",
		tokensBefore: 100,
		fileOps: { read: ["a.py"], modified: ["b.py"] },
	});
	assert.equal(details.kind, "research-pi-compaction");
	assert.equal(details.evidenceLedger.experiments.length, 2);
	assert.ok(details.validationWarnings.length >= 2);
});

test("Runtime merge restores route provenance for an experiment already present in the Session", () => {
	const evidence = collectResearchEvidence([{
		type: "custom",
		customType: "research-experiment",
		id: "entry-route",
		data: {
			id: "record-route",
			question: "Which route produced the delayed result?",
			intervention: "Read the delayed assay.",
			evidenceMode: "diagnostic",
			predictionStatus: "not_applicable",
			validityChecks: ["run identity matched"],
			observation: "The old-route assay completed.",
			validityJudgment: "valid",
			conclusion: "Attribute it to the old route.",
			trackRef: "transition:old-route",
		},
	}], "session-route");
	mergeProjectRuntimeEvidence(evidence, {
		evidence: [{
			id: "record-route",
			trackRef: "transition:old-route",
			trackLabel: "old contract route",
			evidenceMode: "diagnostic",
			predictionStatus: "not_applicable",
		}],
	});
	assert.equal(evidence.experiments.length, 1);
	assert.equal(evidence.experiments[0].trackRef, "transition:old-route");
	assert.equal(evidence.experiments[0].trackLabel, "old contract route");
});

test("Runtime-only evidence preserves its observation and downgrades missing observations", () => {
	const evidence = mergeProjectRuntimeEvidence({
		experiments: [], checkpoints: [], previousState: null, validRefs: new Set(), sourceCatalog: [],
	}, {
		evidence: [
			{ id: "observed", observation: "The registered margin increased to 0.31.", validityJudgment: "valid", conclusion: "The diagnostic passed." },
			{ id: "missing", observation: "", validityJudgment: "valid", conclusion: "A legacy conclusion without its observation." },
		],
	});
	assert.equal(evidence.experiments.find((item) => item.id === "observed").observation, "The registered margin increased to 0.31.");
	assert.equal(evidence.experiments.find((item) => item.id === "observed").validityJudgment, "valid");
	assert.equal(evidence.experiments.find((item) => item.id === "missing").validityJudgment, "inconclusive");
});

test("compact claim strength respects confirmatory, exploratory, and diagnostic evidence modes", () => {
	const makeEntry = (id, evidenceMode, predictionStatus, prediction = "") => ({
		type: "custom",
		customType: "research-experiment",
		id,
		data: {
			id: `record-${id}`,
			question: "Which claim update is licensed?",
			hypothesis: evidenceMode === "confirmatory" ? "The intervention succeeds." : "",
			intervention: "Run one discriminating assay.",
			prediction,
			predictionStatus,
			evidenceMode,
			registrationRef: predictionStatus === "preregistered" ? `registration.yaml#${id}` : undefined,
			validityChecks: ["the intended intervention occurred"],
			observation: "The assay produced interpretable evidence.",
			validityJudgment: "valid",
			conclusion: "Update only to the strength licensed by provenance.",
		},
	});
	const evidence = collectResearchEvidence([
		makeEntry("exploratory", "exploratory", "not_recorded"),
		makeEntry("diagnostic", "diagnostic", "not_applicable"),
		makeEntry("confirmatory", "confirmatory", "preregistered", "The registered gate passes."),
	], "session-modes");
	const ref = (id) => `S:session-modes/E:${id}`;
	const normalized = normalizeResearchState({
		researchQuestion: "Which claim update is licensed?",
		currentClaim: "Use evidence provenance, not validity alone.",
		hypotheses: [
			{ id: "H-explore", statement: "Exploratory support", status: "supported", evidenceRefs: [ref("exploratory")] },
			{ id: "H-diag-support", statement: "Diagnostic positive support", status: "supported", evidenceRefs: [ref("diagnostic")] },
			{ id: "H-diag-reject", statement: "Diagnostic challenge", status: "rejected", evidenceRefs: [ref("diagnostic")] },
			{ id: "H-confirm", statement: "Confirmatory support", status: "supported", evidenceRefs: [ref("confirmatory")] },
		],
		observations: [],
		decisions: [],
		unresolvedConfounders: [],
		openQuestions: [],
		nextExperiment: {},
		criticalContext: [],
	}, evidence);
	const status = Object.fromEntries(normalized.state.hypotheses.map((item) => [item.id, item.status]));
	assert.equal(status["H-explore"], "inconclusive");
	assert.equal(status["H-diag-support"], "inconclusive");
	assert.equal(status["H-diag-reject"], "rejected");
	assert.equal(status["H-confirm"], "supported");
});

test("a superseding Project transition retires automatic carry-over of old hypotheses", () => {
	const evidence = mergeProjectRuntimeEvidence(
		{
			experiments: [],
			checkpoints: [],
			previousState: { hypotheses: [{ id: "H-old", statement: "旧离散契约路线", status: "active", evidenceRefs: [] }] },
			validRefs: new Set(),
			sourceCatalog: [],
		},
		{
			projectState: { revision: 1 },
			evidence: [],
			activeTransition: { revision: 2, to: "参数化契约", oldDisposition: "archived" },
		},
	);
	const normalized = normalizeResearchState({
		researchQuestion: "参数化契约能否区分连续学习与查表",
		currentClaim: "待验证",
		hypotheses: [{ id: "H-new", statement: "共享连续模型可以学习", status: "active", evidenceRefs: [] }],
		observations: [],
		decisions: [],
		unresolvedConfounders: [],
		openQuestions: [],
		nextExperiment: {},
		criticalContext: [],
	}, evidence);
	assert.deepEqual(normalized.state.hypotheses.map((item) => item.id), ["H-new"]);
	assert.match(normalized.warnings.join("\n"), /superseding research transition/);
});

test("parses fenced JSON output", () => {
	assert.deepEqual(parseResearchState("```json\n{\"researchQuestion\":\"q\"}\n```"), { researchQuestion: "q" });
});

test("research compaction prefers one constrained structured-state tool call", () => {
	assert.equal(RESEARCH_STATE_TOOL.name, "submit_research_state");
	assert.deepEqual(RESEARCH_STATE_TOOL.constrainedSampling, { type: "json_schema", strict: "prefer" });
	assert.ok(RESEARCH_STATE_TOOL.parameters.required.includes("nextExperiment"));
	const result = parseResearchCompactionResponse([
		{ type: "text", text: "This text must not replace the structured state." },
		{ type: "toolCall", name: RESEARCH_STATE_TOOL.name, arguments: { researchQuestion: "Which route survives?" } },
	]);
	assert.equal(result.source, "tool");
	assert.deepEqual(result.state, { researchQuestion: "Which route survives?" });
	assert.deepEqual(result.repairs, []);
	assert.throws(
		() => parseResearchCompactionResponse([
			{ type: "toolCall", name: RESEARCH_STATE_TOOL.name, arguments: {} },
			{ type: "toolCall", name: RESEARCH_STATE_TOOL.name, arguments: {} },
		]),
		/more than once/,
	);
});

test("repairs only conservative model JSON syntax failures", () => {
	const missingCommas = parseResearchStateWithDiagnostics(`{
		"hypotheses": ["H1"
		"H2"],
		"currentClaim": "screen passed"
		"openQuestions": []
	}`);
	assert.deepEqual(missingCommas.state, {
		hypotheses: ["H1", "H2"],
		currentClaim: "screen passed",
		openQuestions: [],
	});
	assert.deepEqual(missingCommas.repairs, ["inserted 2 missing comma(s)"]);

	const trailingAndControl = parseResearchStateWithDiagnostics("{\"criticalContext\":[\"line one\nline two\",],}");
	assert.deepEqual(trailingAndControl.state, { criticalContext: ["line one\nline two"] });
	assert.deepEqual(trailingAndControl.repairs, [
		"escaped 1 raw control character(s) inside JSON strings",
		"removed 2 trailing comma(s)",
	]);
	assert.throws(() => parseResearchState('{"hypotheses":["H1"'), /unterminated JSON object/);
});

test("research compaction uses bounded staged recent tails", () => {
	const compact = (id) => ({
		type: "compaction",
		id,
		details: { kind: "research-pi-compaction", version: 1 },
	});
	assert.deepEqual(selectResearchCompactionPolicy([]), {
		version: 1,
		ordinal: 1,
		softTriggerTokens: RESEARCH_SOFT_COMPACT_TOKENS,
		hardTriggerTokens: RESEARCH_HARD_COMPACT_TOKENS,
		keepRecentTokens: 24 * 1024,
	});
	assert.equal(selectResearchCompactionPolicy([compact("c1")]).keepRecentTokens, 32 * 1024);
	assert.equal(selectResearchCompactionPolicy([compact("c1"), compact("c2")]).keepRecentTokens, 40 * 1024);
	assert.equal(selectResearchCompactionPolicy([compact("c1"), compact("c2"), compact("c3")]).keepRecentTokens, 40 * 1024);
	assert.equal(RESEARCH_SOFT_COMPACT_TOKENS, 272 * 1024);
	assert.equal(RESEARCH_HARD_COMPACT_TOKENS, 384 * 1024);
	assert.equal(RESEARCH_SUMMARY_TARGET_TOKENS, 8 * 1024);
	assert.equal(RESEARCH_SUMMARY_MAX_TOKENS, 16 * 1024);
	assert.match(RESEARCH_COMPACTION_SYSTEM_PROMPT, /Target at most 8,192 output tokens/);
	assert.match(buildResearchCompactionPrompt({
		conversationText: "recent work",
		experiments: [],
		checkpoints: [],
		sourceCatalog: [],
	}), /Conversation being compacted/);
});
