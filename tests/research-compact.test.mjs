import assert from "node:assert/strict";
import test from "node:test";
import researchCompactionExtension from "../.pi/extensions/research-compaction.ts";
import {
	buildResearchCompactionDetails,
	collectResearchEvidence,
	mergeProjectRuntimeEvidence,
	normalizeResearchState,
	parseResearchState,
	RESEARCH_HARD_COMPACT_TOKENS,
	RESEARCH_SOFT_COMPACT_TOKENS,
	renderResearchSummary,
	selectResearchCompactionPolicy,
} from "../.pi/lib/research-compact.mjs";

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
	assert.match(summary, /S:session-x\/E:e2 \[valid\]/);
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
		keepRecentTokens: 32 * 1024,
	});
	assert.equal(selectResearchCompactionPolicy([compact("c1")]).keepRecentTokens, 40 * 1024);
	assert.equal(selectResearchCompactionPolicy([compact("c1"), compact("c2")]).keepRecentTokens, 48 * 1024);
	assert.equal(selectResearchCompactionPolicy([compact("c1"), compact("c2"), compact("c3")]).keepRecentTokens, 48 * 1024);
	assert.equal(RESEARCH_SOFT_COMPACT_TOKENS, 272 * 1024);
	assert.equal(RESEARCH_HARD_COMPACT_TOKENS, 384 * 1024);
});
