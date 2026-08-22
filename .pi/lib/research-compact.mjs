import { createHash } from "node:crypto";

export const RESEARCH_COMPACTION_KIND = "research-pi-compaction";
export const RESEARCH_COMPACTION_VERSION = 1;
export const RESEARCH_COMPACTION_POLICY_VERSION = 1;
export const RESEARCH_STATE_TOOL_NAME = "submit_research_state";

const STRING_ARRAY_SCHEMA = Object.freeze({
	type: "array",
	items: { type: "string" },
});

export const RESEARCH_STATE_TOOL = Object.freeze({
	name: RESEARCH_STATE_TOOL_NAME,
	description: "Submit the final structured research state exactly once after synthesizing the compaction evidence.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: [
			"researchQuestion",
			"currentClaim",
			"hypotheses",
			"observations",
			"decisions",
			"unresolvedConfounders",
			"openQuestions",
			"nextExperiment",
			"criticalContext",
		],
		properties: {
			researchQuestion: { type: "string" },
			currentClaim: { type: "string" },
			hypotheses: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["id", "statement", "status", "predictions", "rationale", "evidenceRefs"],
					properties: {
						id: { type: "string" },
						statement: { type: "string" },
						status: { type: "string", enum: ["active", "supported", "weakened", "rejected", "inconclusive"] },
						predictions: STRING_ARRAY_SCHEMA,
						rationale: { type: "string" },
						evidenceRefs: STRING_ARRAY_SCHEMA,
					},
				},
			},
			observations: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["statement", "interpretation", "validity", "evidenceRefs"],
					properties: {
						statement: { type: "string" },
						interpretation: { type: "string" },
						validity: { type: "string", enum: ["valid", "invalid", "inconclusive", "unverified"] },
						evidenceRefs: STRING_ARRAY_SCHEMA,
					},
				},
			},
			decisions: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["decision", "rationale", "reversible", "evidenceRefs"],
					properties: {
						decision: { type: "string" },
						rationale: { type: "string" },
						reversible: { type: "boolean" },
						evidenceRefs: STRING_ARRAY_SCHEMA,
					},
				},
			},
			unresolvedConfounders: STRING_ARRAY_SCHEMA,
			openQuestions: STRING_ARRAY_SCHEMA,
			nextExperiment: {
				type: "object",
				additionalProperties: false,
				required: ["question", "intervention", "distinguishingOutcomes", "validityChecks"],
				properties: {
					question: { type: "string" },
					intervention: { type: "string" },
					distinguishingOutcomes: STRING_ARRAY_SCHEMA,
					validityChecks: STRING_ARRAY_SCHEMA,
				},
			},
			criticalContext: STRING_ARRAY_SCHEMA,
		},
	},
	constrainedSampling: { type: "json_schema", strict: "prefer" },
});

function configuredPositiveInteger(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function configuredTailSchedule() {
	const values = String(process.env.RESEARCH_PI_COMPACT_RECENT_TAIL_TOKENS ?? "")
		.split(",")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isInteger(value) && value > 0);
	return values.length ? values : [32 * 1024, 40 * 1024, 48 * 1024];
}

export const RESEARCH_SOFT_COMPACT_TOKENS = configuredPositiveInteger("RESEARCH_PI_COMPACT_SOFT_TOKENS", 272 * 1024);
export const RESEARCH_HARD_COMPACT_TOKENS = configuredPositiveInteger("RESEARCH_PI_COMPACT_HARD_TOKENS", 384 * 1024);
export const RESEARCH_RECENT_TAIL_SCHEDULE = Object.freeze(configuredTailSchedule());

const MAX_HYPOTHESES = 24;
const MAX_OBSERVATIONS = 32;
const MAX_DECISIONS = 24;
const RESEARCH_STATE_KEYS = new Set([
	"researchQuestion",
	"currentClaim",
	"hypotheses",
	"observations",
	"decisions",
	"unresolvedConfounders",
	"openQuestions",
	"nextExperiment",
	"criticalContext",
]);

export function selectResearchCompactionPolicy(branchEntries) {
	const previousResearchCompactions = branchEntries.filter(
		(entry) =>
			entry?.type === "compaction" &&
			entry.details?.kind === RESEARCH_COMPACTION_KIND &&
			entry.details?.version === RESEARCH_COMPACTION_VERSION,
	).length;
	const ordinal = previousResearchCompactions + 1;
	const scheduleIndex = Math.min(ordinal - 1, RESEARCH_RECENT_TAIL_SCHEDULE.length - 1);
	return {
		version: RESEARCH_COMPACTION_POLICY_VERSION,
		ordinal,
		softTriggerTokens: RESEARCH_SOFT_COMPACT_TOKENS,
		hardTriggerTokens: RESEARCH_HARD_COMPACT_TOKENS,
		keepRecentTokens: RESEARCH_RECENT_TAIL_SCHEDULE[scheduleIndex],
	};
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function text(value, maxChars = 2_000) {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\r\n/g, "\n").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

function list(value, maxItems = 20, maxChars = 1_000) {
	if (!Array.isArray(value)) return [];
	return value.map((item) => text(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

function messageText(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function refFor(sessionId, entryId) {
	return `S:${sessionId}/E:${entryId}`;
}

function normalizeExperiment(data, ref, entryId) {
	return {
		ref,
		entryId,
		id: text(data?.id, 180),
		timestamp: text(data?.timestamp, 80),
		question: text(data?.question),
		hypothesis: text(data?.hypothesis),
		intervention: text(data?.intervention),
		prediction: text(data?.prediction),
		validityChecks: list(data?.validityChecks, 20, 700),
		observation: text(data?.observation, 4_000),
		validityJudgment: ["valid", "invalid", "inconclusive"].includes(data?.validityJudgment)
			? data.validityJudgment
			: "inconclusive",
		conclusion: text(data?.conclusion, 4_000),
		nextStep: text(data?.nextStep, 2_000),
		runId: text(data?.runId, 300) || undefined,
		artifacts: list(data?.artifacts, 20, 1_000),
		contentHash: hash(JSON.stringify(data ?? {})),
	};
}

function normalizeCheckpoint(data, ref, entryId) {
	return {
		ref,
		entryId,
		id: text(data?.id, 180),
		timestamp: text(data?.timestamp, 80),
		label: text(data?.label, 500),
		rationale: text(data?.rationale, 2_000),
		repository: text(data?.repository, 2_000),
		refName: text(data?.ref, 1_000),
		commit: text(data?.commit, 160),
		hadTrackedChanges: Boolean(data?.hadTrackedChanges),
		untrackedFiles: list(data?.untrackedFiles, 40, 1_000),
		contentHash: hash(JSON.stringify(data ?? {})),
	};
}

export function collectResearchEvidence(branchEntries, sessionId, firstKeptEntryId, options = {}) {
	const experiments = [];
	const checkpoints = [];
	let previousState;
	let previousCompactionEntryId;
	let previousProjectRevision;

	for (const entry of branchEntries) {
		const ref = entry?.id ? refFor(sessionId, entry.id) : undefined;
		if (entry?.type === "custom" && entry.customType === "research-experiment" && ref) {
			experiments.push(normalizeExperiment(entry.data ?? {}, ref, entry.id));
		} else if (entry?.type === "custom" && entry.customType === "research-checkpoint" && ref) {
			checkpoints.push(normalizeCheckpoint(entry.data ?? {}, ref, entry.id));
		} else if (
			entry?.type === "compaction" &&
			entry.details?.kind === RESEARCH_COMPACTION_KIND &&
			entry.details?.version === RESEARCH_COMPACTION_VERSION &&
			entry.details?.researchState &&
			(
				options.inheritancePolicy === "clean"
					? entry.details.inheritancePolicy === "clean"
					: entry.details.inheritancePolicy !== "clean"
			)
		) {
			previousState = entry.details.researchState;
			previousCompactionEntryId = entry.id;
			previousProjectRevision = Number.isInteger(entry.details.projectRevision)
				? entry.details.projectRevision
				: undefined;
		}
	}

	const cutIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	const discardedEntries = cutIndex >= 0 ? branchEntries.slice(0, cutIndex) : branchEntries;
	const catalogCandidates = discardedEntries
		.filter((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role))
		.map((entry) => ({
			ref: refFor(sessionId, entry.id),
			role: entry.message.role,
			timestamp: entry.timestamp,
			text: text(messageText(entry), 600),
		}))
		.filter((entry) => entry.text);
	const sourceCatalog = catalogCandidates.slice(-140);
	const validRefs = new Set([
		...experiments.map((entry) => entry.ref),
		...checkpoints.map((entry) => entry.ref),
		...sourceCatalog.map((entry) => entry.ref),
	]);

	return {
		experiments,
		checkpoints,
		previousState,
		previousCompactionEntryId,
		previousProjectRevision,
		sourceCatalog,
		validRefs,
	};
}

export function mergeProjectRuntimeEvidence(evidence, runtimeSnapshot) {
	if (
		runtimeSnapshot?.projectState?.state
		&& (!evidence.previousState || (runtimeSnapshot.projectState.revision ?? 0) > (evidence.previousProjectRevision ?? -1))
	) {
		evidence.previousState = runtimeSnapshot.projectState.state;
		evidence.previousProjectRevision = runtimeSnapshot.projectState.revision ?? 0;
		evidence.previousProjectStateEntryId = runtimeSnapshot.projectState.source?.entryId ?? evidence.previousProjectStateEntryId;
	}
	const seen = new Set(evidence.experiments.map((item) => item.id));
	for (const record of runtimeSnapshot?.evidence ?? []) {
		if (!record?.id || seen.has(record.id)) continue;
		const sessionId = text(record.source?.sessionId, 200) || "project-runtime";
		const ref = refFor(sessionId, record.id);
		evidence.experiments.push({
			ref,
			entryId: record.id,
			id: record.id,
			timestamp: text(record.timestamp, 80),
			question: text(record.question),
			hypothesis: "",
			intervention: "",
			prediction: "",
			validityChecks: [],
			observation: "",
			validityJudgment: ["valid", "invalid", "inconclusive"].includes(record.validityJudgment)
				? record.validityJudgment
				: "inconclusive",
			conclusion: text(record.conclusion, 4_000),
			nextStep: text(record.nextStep, 2_000),
			runId: text(record.runId, 300) || undefined,
			artifacts: list(record.artifacts, 12, 1_000),
			trackRef: text(record.trackRef, 300) || "project:initial",
			trackLabel: text(record.trackLabel, 600) || "initial project track",
			contentHash: hash(JSON.stringify(record)),
			projectRuntimeSource: true,
		});
		evidence.validRefs.add(ref);
		seen.add(record.id);
	}
	const transition = runtimeSnapshot?.activeTransition;
	evidence.activeTransition = transition ?? null;
	evidence.preservePreviousHypotheses = !(
		transition
		&& transition.revision > (runtimeSnapshot?.projectState?.revision ?? 0)
		&& ["archived", "superseded"].includes(transition.oldDisposition)
	);
	return evidence;
}

function extractFirstJsonObject(value) {
	const raw = String(value ?? "").trim();
	const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = unfenced.indexOf("{");
	if (start < 0) throw new Error("Compaction model did not return a JSON object.");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < unfenced.length; index += 1) {
		const char = unfenced[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return unfenced.slice(start, index + 1);
		}
	}
	throw new Error("Compaction model returned an unterminated JSON object.");
}

function escapeRawStringControls(value) {
	let result = "";
	let inString = false;
	let escaped = false;
	let repaired = 0;
	for (const char of value) {
		if (!inString) {
			result += char;
			if (char === '"') inString = true;
			continue;
		}
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			result += char;
			escaped = true;
			continue;
		}
		if (char === '"') {
			result += char;
			inString = false;
			continue;
		}
		const code = char.codePointAt(0);
		if (code < 0x20) {
			result += char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
			repaired += 1;
		} else {
			result += char;
		}
	}
	return { value: result, repaired };
}

function removeTrailingCommas(value) {
	let result = "";
	let inString = false;
	let escaped = false;
	let repaired = 0;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (/\s/.test(value[next] ?? "")) next += 1;
			if (value[next] === "]" || value[next] === "}") {
				repaired += 1;
				continue;
			}
		}
		result += char;
	}
	return { value: result, repaired };
}

function missingCommaPosition(error) {
	if (!(error instanceof SyntaxError)) return undefined;
	const match = error.message.match(/^Expected ',' or '.+' after (?:array element|property value) in JSON at position (\d+)/);
	return match ? Number(match[1]) : undefined;
}

export function parseResearchStateWithDiagnostics(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return { state: value, repairs: [] };
	}
	const extracted = extractFirstJsonObject(value);
	try {
		return { state: JSON.parse(extracted), repairs: [] };
	} catch (strictError) {
		const repairs = [];
		const controls = escapeRawStringControls(extracted);
		let candidate = controls.value;
		if (controls.repaired) repairs.push(`escaped ${controls.repaired} raw control character(s) inside JSON strings`);
		const trailing = removeTrailingCommas(candidate);
		candidate = trailing.value;
		if (trailing.repaired) repairs.push(`removed ${trailing.repaired} trailing comma(s)`);

		let insertedCommas = 0;
		for (let attempt = 0; attempt < 16; attempt += 1) {
			try {
				const state = JSON.parse(candidate);
				if (insertedCommas) repairs.push(`inserted ${insertedCommas} missing comma(s)`);
				return { state, repairs };
			} catch (error) {
				const position = missingCommaPosition(error);
				const next = position === undefined ? "" : candidate[position];
				if (position === undefined || !/["{\[\d\-tfn]/.test(next)) {
					throw strictError;
				}
				candidate = `${candidate.slice(0, position)},${candidate.slice(position)}`;
				insertedCommas += 1;
			}
		}
		throw strictError;
	}
}

export function parseResearchState(value) {
	return parseResearchStateWithDiagnostics(value).state;
}

export function parseResearchCompactionResponse(content) {
	const parts = Array.isArray(content) ? content : [];
	const toolCalls = parts.filter((part) => part?.type === "toolCall" && part.name === RESEARCH_STATE_TOOL_NAME);
	if (toolCalls.length > 1) throw new Error(`Compaction model called ${RESEARCH_STATE_TOOL_NAME} more than once.`);
	if (toolCalls.length === 1) {
		const parsed = parseResearchStateWithDiagnostics(toolCalls[0].arguments);
		return { ...parsed, source: "tool" };
	}
	const raw = parts
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	if (!raw.trim()) throw new Error("Compaction model returned neither structured state nor text JSON.");
	return { ...parseResearchStateWithDiagnostics(raw), source: "text" };
}

function refs(value, validRefs, maxItems = 16) {
	const raw = list(value, maxItems * 2, 300);
	return [...new Set(raw.filter((ref) => validRefs.has(ref)))].slice(0, maxItems);
}

function hypothesisId(value, index) {
	const normalized = text(value, 80).replace(/[^A-Za-z0-9_.-]/g, "");
	return normalized || `H${index + 1}`;
}

function normalizeNextExperiment(value) {
	const source = value && typeof value === "object" ? value : {};
	return {
		question: text(source.question),
		intervention: text(source.intervention, 3_000),
		distinguishingOutcomes: list(source.distinguishingOutcomes, 10, 1_500),
		validityChecks: list(source.validityChecks, 12, 1_000),
	};
}

function requireArray(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function amendmentRefs(value, maxItems = 16) {
	return [...new Set(list(requireArray(value ?? [], "evidenceRefs"), maxItems * 2, 1_000))].slice(0, maxItems);
}

function amendmentHypotheses(value) {
	const allowedStatuses = new Set(["active", "supported", "weakened", "rejected", "inconclusive"]);
	const result = [];
	const seenIds = new Set();
	for (const [index, item] of requireArray(value, "hypotheses").entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`hypotheses[${index}] must be an object`);
		if (result.length >= MAX_HYPOTHESES) break;
		const id = hypothesisId(item.id, index);
		if (seenIds.has(id)) throw new Error(`Duplicate hypothesis id in Project State amendment: ${id}`);
		const statement = text(item.statement, 3_000);
		if (!statement) throw new Error(`hypotheses[${index}].statement is required`);
		const status = allowedStatuses.has(item.status) ? item.status : "inconclusive";
		const evidenceRefs = amendmentRefs(item.evidenceRefs);
		if (["supported", "weakened", "rejected"].includes(status) && !evidenceRefs.length) {
			throw new Error(`Hypothesis ${id} cannot be ${status} without an evidence reference`);
		}
		result.push({
			id,
			statement,
			status,
			predictions: list(item.predictions, 8, 1_000),
			rationale: text(item.rationale, 2_000),
			evidenceRefs,
		});
		seenIds.add(id);
	}
	return result;
}

function amendmentObservations(value) {
	const allowedValidity = new Set(["valid", "invalid", "inconclusive", "unverified"]);
	const result = [];
	for (const [index, item] of requireArray(value, "observations").entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`observations[${index}] must be an object`);
		if (result.length >= MAX_OBSERVATIONS) break;
		const statement = text(item.statement, 3_000);
		if (!statement) throw new Error(`observations[${index}].statement is required`);
		const validity = allowedValidity.has(item.validity) ? item.validity : "unverified";
		const evidenceRefs = amendmentRefs(item.evidenceRefs);
		if (validity === "valid" && !evidenceRefs.length) {
			throw new Error(`observations[${index}] cannot be valid without an evidence reference`);
		}
		result.push({
			statement,
			interpretation: text(item.interpretation, 3_000),
			validity,
			evidenceRefs,
		});
	}
	return result;
}

function amendmentDecisions(value) {
	const result = [];
	for (const [index, item] of requireArray(value, "decisions").entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`decisions[${index}] must be an object`);
		if (result.length >= MAX_DECISIONS) break;
		const decision = text(item.decision, 3_000);
		if (!decision) throw new Error(`decisions[${index}].decision is required`);
		result.push({
			decision,
			rationale: text(item.rationale, 3_000),
			reversible: item.reversible !== false,
			evidenceRefs: amendmentRefs(item.evidenceRefs),
		});
	}
	return result;
}

/**
 * Apply one explicit, bounded Project State correction without re-summarizing
 * the whole project. Omitted top-level fields are preserved. Array fields are
 * complete replacements; nextExperiment merges only its supplied sub-fields.
 */
export function applyResearchStatePatch(current, patch) {
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		throw new Error("A structured Project State is required before it can be amended");
	}
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		throw new Error("Project State amendment patch must be an object");
	}
	const keys = Object.keys(patch);
	if (!keys.length) throw new Error("Project State amendment patch must change at least one field");
	const unknown = keys.filter((key) => !RESEARCH_STATE_KEYS.has(key));
	if (unknown.length) throw new Error(`Unknown Project State amendment field(s): ${unknown.join(", ")}`);

	const state = JSON.parse(JSON.stringify(current));
	if (Object.hasOwn(patch, "researchQuestion")) state.researchQuestion = text(patch.researchQuestion, 3_000);
	if (Object.hasOwn(patch, "currentClaim")) state.currentClaim = text(patch.currentClaim, 3_000);
	if (Object.hasOwn(patch, "hypotheses")) state.hypotheses = amendmentHypotheses(patch.hypotheses);
	if (Object.hasOwn(patch, "observations")) state.observations = amendmentObservations(patch.observations);
	if (Object.hasOwn(patch, "decisions")) state.decisions = amendmentDecisions(patch.decisions);
	if (Object.hasOwn(patch, "unresolvedConfounders")) {
		state.unresolvedConfounders = list(requireArray(patch.unresolvedConfounders, "unresolvedConfounders"), 24, 1_500);
	}
	if (Object.hasOwn(patch, "openQuestions")) state.openQuestions = list(requireArray(patch.openQuestions, "openQuestions"), 24, 1_500);
	if (Object.hasOwn(patch, "criticalContext")) state.criticalContext = list(requireArray(patch.criticalContext, "criticalContext"), 24, 1_500);
	if (Object.hasOwn(patch, "nextExperiment")) {
		if (!patch.nextExperiment || typeof patch.nextExperiment !== "object" || Array.isArray(patch.nextExperiment)) {
			throw new Error("nextExperiment must be an object");
		}
		state.nextExperiment = normalizeNextExperiment({ ...(state.nextExperiment ?? {}), ...patch.nextExperiment });
	}
	return state;
}

function mergePreviousHypotheses(current, previous, warnings, validRefs, validExperimentRefs) {
	if (!Array.isArray(previous?.hypotheses)) return current;
	const ids = new Set(current.map((item) => item.id));
	for (const old of previous.hypotheses) {
		const id = text(old?.id, 80);
		if (!id || ids.has(id) || current.length >= MAX_HYPOTHESES) continue;
		const statement = text(old?.statement, 3_000);
		if (!statement) continue;
		const evidenceRefs = refs(old?.evidenceRefs, validRefs);
		let status = ["active", "supported", "weakened", "rejected", "inconclusive"].includes(old?.status)
			? old.status
			: "inconclusive";
		if (["supported", "weakened", "rejected"].includes(status) && !evidenceRefs.some((ref) => validExperimentRefs.has(ref))) {
			warnings.push(`Downgraded preserved hypothesis ${id} from ${status}: its valid experiment provenance is no longer available.`);
			status = "inconclusive";
		}
		current.push({
			id,
			statement,
			status,
			predictions: list(old?.predictions, 8, 1_000),
			rationale: text(old?.rationale, 2_000),
			evidenceRefs,
		});
		ids.add(id);
		warnings.push(`Preserved previous hypothesis ${id} because the new synthesis omitted it.`);
	}
	return current;
}

export function normalizeResearchState(candidate, evidence) {
	const source = candidate && typeof candidate === "object" ? candidate : {};
	const warnings = [];
	const validExperimentRefs = new Set(
		evidence.experiments.filter((item) => item.validityJudgment === "valid").map((item) => item.ref),
	);
	const allowedStatuses = new Set(["active", "supported", "weakened", "rejected", "inconclusive"]);
	const seenIds = new Set();
	const hypotheses = [];
	for (const [index, item] of (Array.isArray(source.hypotheses) ? source.hypotheses : []).entries()) {
		if (!item || typeof item !== "object" || hypotheses.length >= MAX_HYPOTHESES) continue;
		const statement = text(item.statement, 3_000);
		if (!statement) continue;
		let id = hypothesisId(item.id, index);
		while (seenIds.has(id)) id = `${id}-${index + 1}`;
		seenIds.add(id);
		const evidenceRefs = refs(item.evidenceRefs, evidence.validRefs);
		let status = allowedStatuses.has(item.status) ? item.status : "inconclusive";
		if (["supported", "weakened", "rejected"].includes(status) && !evidenceRefs.some((ref) => validExperimentRefs.has(ref))) {
			warnings.push(`Downgraded ${id} from ${status}: no cited valid experiment record supports a strong update.`);
			status = "inconclusive";
		}
		hypotheses.push({
			id,
			statement,
			status,
			predictions: list(item.predictions, 8, 1_000),
			rationale: text(item.rationale, 2_000),
			evidenceRefs,
		});
	}
	if (evidence.preservePreviousHypotheses === false) {
		warnings.push("Did not carry previous hypotheses into the active state because a superseding research transition was recorded.");
	} else {
		mergePreviousHypotheses(hypotheses, evidence.previousState, warnings, evidence.validRefs, validExperimentRefs);
	}

	const observations = [];
	for (const item of Array.isArray(source.observations) ? source.observations : []) {
		if (!item || typeof item !== "object" || observations.length >= MAX_OBSERVATIONS) continue;
		const statement = text(item.statement, 3_000);
		if (!statement) continue;
		const evidenceRefs = refs(item.evidenceRefs, evidence.validRefs);
		let validity = ["valid", "invalid", "inconclusive", "unverified"].includes(item.validity)
			? item.validity
			: "unverified";
		if (validity === "valid" && !evidenceRefs.some((ref) => validExperimentRefs.has(ref))) {
			validity = "unverified";
			warnings.push("Downgraded an observation from valid to unverified because it lacked a valid experiment reference.");
		}
		observations.push({
			statement,
			interpretation: text(item.interpretation, 3_000),
			validity,
			evidenceRefs,
		});
	}

	const decisions = [];
	for (const item of Array.isArray(source.decisions) ? source.decisions : []) {
		if (!item || typeof item !== "object" || decisions.length >= MAX_DECISIONS) continue;
		const decision = text(item.decision, 3_000);
		if (!decision) continue;
		decisions.push({
			decision,
			rationale: text(item.rationale, 3_000),
			reversible: item.reversible !== false,
			evidenceRefs: refs(item.evidenceRefs, evidence.validRefs),
		});
	}

	return {
		state: {
			researchQuestion: text(source.researchQuestion, 3_000),
			currentClaim: text(source.currentClaim, 3_000),
			hypotheses,
			observations,
			decisions,
			unresolvedConfounders: list(source.unresolvedConfounders, 24, 1_500),
			openQuestions: list(source.openQuestions, 24, 1_500),
			nextExperiment: normalizeNextExperiment(source.nextExperiment),
			criticalContext: list(source.criticalContext, 24, 1_500),
		},
		warnings,
	};
}

export function buildResearchCompactionPrompt({
	conversationText,
	previousState,
	legacyPreviousSummary,
	independentSessionSummary,
	experiments,
	checkpoints,
	sourceCatalog,
	projectTransitions = [],
	customInstructions,
}) {
	return `You maintain working state for computational AI/communications research. Submit the result by calling ${RESEARCH_STATE_TOOL_NAME} exactly once. Do not emit the state as prose. If tool calling is unavailable, return one JSON object only.

This is not a software-development progress summary. Preserve competing hypotheses, distinguishing predictions, observations versus interpretations, negative-result validity, unresolved confounders, reversibility, and the next highest-information experiment. Exploratory code is disposable unless it affects interpretation or continuation.

Rules:
1. Never turn an invalid or inconclusive experiment into evidence against a hypothesis.
2. A strong hypothesis status (supported, weakened, rejected) must cite at least one recorded experiment whose validityJudgment is valid.
3. Use only provenance references present below. Do not invent run IDs, paths, results, or references.
4. Preserve previous hypothesis IDs. If a previous hypothesis changed, include it with the new status and evidence; do not silently omit it.
5. Separate what was observed from how it was interpreted.
6. Match the dominant language of the conversation.
7. A recorded project transition with archived/superseded disposition changes the active research route. Keep the old route as retrievable history, but do not present its claim or next experiment as current. A parallel disposition does not retire it.
8. Experiment trackRef/trackLabel identify route provenance. Evidence from a retired route may remain scientifically relevant, but do not silently use it as evidence that the current route's intervention occurred.
9. An independent clean-Session summary is a candidate synthesis, not Project authority or experimental evidence. Retain useful hypotheses, but require normal provenance before making strong updates.

Required schema:
{
  "researchQuestion": "string",
  "currentClaim": "string",
  "hypotheses": [{
    "id": "H1",
    "statement": "string",
    "status": "active|supported|weakened|rejected|inconclusive",
    "predictions": ["string"],
    "rationale": "string",
    "evidenceRefs": ["S:<session>/E:<entry>"]
  }],
  "observations": [{
    "statement": "string",
    "interpretation": "string",
    "validity": "valid|invalid|inconclusive|unverified",
    "evidenceRefs": ["S:<session>/E:<entry>"]
  }],
  "decisions": [{
    "decision": "string",
    "rationale": "string",
    "reversible": true,
    "evidenceRefs": ["S:<session>/E:<entry>"]
  }],
  "unresolvedConfounders": ["string"],
  "openQuestions": ["string"],
  "nextExperiment": {
    "question": "string",
    "intervention": "string",
    "distinguishingOutcomes": ["string"],
    "validityChecks": ["string"]
  },
  "criticalContext": ["string"]
}

Previous structured research state:
${JSON.stringify(previousState ?? null)}

Legacy Pi summary (fallible migration input; present only when no structured research state exists):
${text(legacyPreviousSummary, 40_000) || "None"}

Independent clean-Session summary (fallible session-local input, never Project authority by itself):
${text(independentSessionSummary, 40_000) || "None"}

Recorded experiments (authoritative for their exact fields, but interpret according to validityJudgment):
${JSON.stringify(experiments)}

Recorded project research transitions (authoritative for active-route selection, not for experimental truth):
${JSON.stringify(projectTransitions)}

Research checkpoints:
${JSON.stringify(checkpoints)}

Allowed conversational provenance catalog:
${JSON.stringify(sourceCatalog)}

User compaction focus, if any:
${text(customInstructions, 4_000) || "None"}

Conversation being compacted:
<conversation>
${conversationText}
</conversation>`;
}

function bulletRefs(value) {
	return value?.length ? ` [${value.join(", ")}]` : "";
}

export function renderResearchSummary(state, evidence, fileOps = {}) {
	const lines = ["# Research working state"];
	lines.push("", "## Research question", state.researchQuestion || "尚未可靠确定。");
	lines.push("", "## Current claim", state.currentClaim || "尚无足够证据形成当前主张。");
	lines.push("", "## Competing hypotheses");
	if (!state.hypotheses.length) lines.push("- 尚未可靠提取竞争假设。");
	for (const item of state.hypotheses) {
		lines.push(`- ${item.id} [${item.status}] ${item.statement}${bulletRefs(item.evidenceRefs)}`);
		if (item.predictions.length) lines.push(`  Distinguishing predictions: ${item.predictions.join(" | ")}`);
		if (item.rationale) lines.push(`  Rationale: ${item.rationale}`);
	}

	lines.push("", "## Observations and validity");
	if (!state.observations.length) lines.push("- 尚无可保留的结构化观察。");
	for (const item of state.observations) {
		lines.push(`- [${item.validity}] ${item.statement}${bulletRefs(item.evidenceRefs)}`);
		if (item.interpretation) lines.push(`  Interpretation: ${item.interpretation}`);
	}

	lines.push("", "## Decisions");
	if (!state.decisions.length) lines.push("- 尚无明确研究决策。");
	for (const item of state.decisions) {
		lines.push(`- ${item.decision} (${item.reversible ? "reversible" : "frozen"})${bulletRefs(item.evidenceRefs)}`);
		if (item.rationale) lines.push(`  Rationale: ${item.rationale}`);
	}

	lines.push("", "## Unresolved confounders");
	lines.push(...(state.unresolvedConfounders.length ? state.unresolvedConfounders.map((item) => `- ${item}`) : ["- 无已记录项。"]))
	lines.push("", "## Open questions");
	lines.push(...(state.openQuestions.length ? state.openQuestions.map((item) => `- ${item}`) : ["- 无已记录项。"]))

	lines.push("", "## Next highest-information experiment");
	lines.push(`- Question: ${state.nextExperiment.question || "尚未确定。"}`);
	lines.push(`- Intervention: ${state.nextExperiment.intervention || "尚未确定。"}`);
	if (state.nextExperiment.distinguishingOutcomes.length) {
		lines.push(`- Distinguishing outcomes: ${state.nextExperiment.distinguishingOutcomes.join(" | ")}`);
	}
	if (state.nextExperiment.validityChecks.length) {
		lines.push(`- Validity checks: ${state.nextExperiment.validityChecks.join(" | ")}`);
	}

	lines.push("", "## Critical continuation context");
	lines.push(...(state.criticalContext.length ? state.criticalContext.map((item) => `- ${item}`) : ["- 无已记录项。"]))

	const recentExperiments = evidence.experiments.slice(-30);
	lines.push("", "## Recorded evidence ledger");
	if (evidence.experiments.length > recentExperiments.length) {
		lines.push(`- Earlier ${evidence.experiments.length - recentExperiments.length} experiment record(s) remain retrievable through research_memory_search/read.`);
	}
	if (!recentExperiments.length) lines.push("- 当前分支没有 record_experiment 记录。");
	for (const item of recentExperiments) {
		lines.push(
			`- ${item.ref} [${item.validityJudgment}] track=${item.trackRef ?? "project:initial"}${item.runId ? ` run=${item.runId}` : ""}: ${item.conclusion || item.observation || item.hypothesis}`,
		);
	}
	for (const item of evidence.checkpoints.slice(-12)) {
		lines.push(`- ${item.ref} [checkpoint] ${item.label}: ${item.refName || item.commit}`);
	}

	const readFiles = list(fileOps.read, 30, 1_500);
	const modifiedFiles = list(fileOps.modified, 30, 1_500);
	if (readFiles.length || modifiedFiles.length) {
		lines.push("", "## File continuity");
		if (readFiles.length) lines.push(`- Read: ${readFiles.join(", ")}`);
		if (modifiedFiles.length) lines.push(`- Modified: ${modifiedFiles.join(", ")}`);
	}
	lines.push("", "关键历史结论应使用 research_memory_read 回到原 entry 校验；本摘要不是事实源。");
	return lines.join("\n");
}

export function buildResearchCompactionDetails({
	state,
	evidence,
	warnings,
	sessionId,
	reason,
	tokensBefore,
	fileOps,
	policy,
	projectRevision,
	inheritancePolicy = "project",
}) {
	return {
		kind: RESEARCH_COMPACTION_KIND,
		version: RESEARCH_COMPACTION_VERSION,
		generatedAt: new Date().toISOString(),
		sessionId,
		reason,
		tokensBefore,
		compactionPolicy: policy,
		projectRevision: Number.isInteger(projectRevision) ? projectRevision : 0,
		inheritancePolicy: inheritancePolicy === "clean" ? "clean" : "project",
		researchState: state,
		evidenceLedger: {
			experiments: evidence.experiments,
			checkpoints: evidence.checkpoints,
			activeTransition: evidence.activeTransition ?? null,
		},
		provenance: {
			previousCompactionEntryId: evidence.previousCompactionEntryId,
			previousProjectStateEntryId: evidence.previousProjectStateEntryId,
			sourceRefs: [...evidence.validRefs],
			sourceCatalogTruncated: evidence.sourceCatalog.length >= 140,
		},
		validationWarnings: warnings,
		fileOps: {
			read: list(fileOps?.read, 100, 2_000),
			modified: list(fileOps?.modified, 100, 2_000),
		},
	};
}
