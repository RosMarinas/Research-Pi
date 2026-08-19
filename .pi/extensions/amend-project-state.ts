import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { getGitSnapshot } from "../lib/codex-jobs.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	amendRuntimeProjectState,
	readRuntimeSnapshot,
	resolveResearchRuntime,
	runtimeActorAttachment,
	runtimeSessionInheritancePolicy,
} from "../lib/research-runtime.mjs";

const EvidenceRefs = Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 16 });

const Hypothesis = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 80 }),
	statement: Type.String({ minLength: 1, maxLength: 3_000 }),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("supported"),
		Type.Literal("weakened"),
		Type.Literal("rejected"),
		Type.Literal("inconclusive"),
	]),
	predictions: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 8 })),
	rationale: Type.Optional(Type.String({ maxLength: 2_000 })),
	evidenceRefs: Type.Optional(EvidenceRefs),
}, { additionalProperties: false });

const Observation = Type.Object({
	statement: Type.String({ minLength: 1, maxLength: 3_000 }),
	interpretation: Type.Optional(Type.String({ maxLength: 3_000 })),
	validity: Type.Union([
		Type.Literal("valid"),
		Type.Literal("invalid"),
		Type.Literal("inconclusive"),
		Type.Literal("unverified"),
	]),
	evidenceRefs: Type.Optional(EvidenceRefs),
}, { additionalProperties: false });

const Decision = Type.Object({
	decision: Type.String({ minLength: 1, maxLength: 3_000 }),
	rationale: Type.Optional(Type.String({ maxLength: 3_000 })),
	reversible: Type.Optional(Type.Boolean()),
	evidenceRefs: Type.Optional(EvidenceRefs),
}, { additionalProperties: false });

const NextExperimentPatch = Type.Object({
	question: Type.Optional(Type.String({ maxLength: 2_000 })),
	intervention: Type.Optional(Type.String({ maxLength: 3_000 })),
	distinguishingOutcomes: Type.Optional(Type.Array(Type.String({ maxLength: 1_500 }), { maxItems: 10 })),
	validityChecks: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 12 })),
}, { additionalProperties: false, minProperties: 1 });

const ProjectStatePatch = Type.Object({
	researchQuestion: Type.Optional(Type.String({ maxLength: 3_000 })),
	currentClaim: Type.Optional(Type.String({ maxLength: 3_000 })),
	hypotheses: Type.Optional(Type.Array(Hypothesis, { maxItems: 24 })),
	observations: Type.Optional(Type.Array(Observation, { maxItems: 32 })),
	decisions: Type.Optional(Type.Array(Decision, { maxItems: 24 })),
	unresolvedConfounders: Type.Optional(Type.Array(Type.String({ maxLength: 1_500 }), { maxItems: 24 })),
	openQuestions: Type.Optional(Type.Array(Type.String({ maxLength: 1_500 }), { maxItems: 24 })),
	nextExperiment: Type.Optional(NextExperimentPatch),
	criticalContext: Type.Optional(Type.Array(Type.String({ maxLength: 1_500 }), { maxItems: 24 })),
}, { additionalProperties: false, minProperties: 1 });

export default function amendProjectStateExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "amend_project_state",
		label: "Amend Project State",
		description:
			"Apply a narrow, explicit correction to the current structured Project State without waiting for compaction. The amendment is append-only, source-labelled, and rejected if Project revision or Leader ownership changed.",
		promptSnippet: "Correct a bounded part of current Project State with authority and revision provenance",
		promptGuidelines: [
			"Use amend_project_state only when the existing ProjectView is narrowly wrong, incomplete, or out of date and the correction is supported by an explicit user decision, experiment, run, or authority document.",
			"Do not use it to create initial Project State or to change the active research route; use /compact for initial synthesis and record_research_transition for route changes.",
			"Copy basedOnRevision from the latest ProjectView, provide why the correction is justified, and omit every unchanged field. Array fields replace that entire array; nextExperiment merges only supplied sub-fields.",
			"If ProjectView is stale, account for every listed freshness reason before amending: omitted fields are an explicit decision to retain them at the current Project revision.",
			"Never manufacture evidenceRefs. Strong hypothesis updates and valid observations need actual evidence references. Clean Sessions must use /runtime inherit before amending Project State.",
		],
		parameters: Type.Object({
			basedOnRevision: Type.Integer({
				description: "Exact Project revision shown by the latest ProjectView; stale revisions are rejected",
				minimum: 0,
			}),
			reason: Type.String({
				description: "Why this is a justified narrow correction rather than a route transition or fresh synthesis",
				minLength: 1,
				maxLength: 3_000,
			}),
			authorityRefs: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
				description: "Experiment IDs, run IDs, document paths, commits, or explicit user decisions authorizing the correction",
				minItems: 1,
				maxItems: 16,
			}),
			patch: ProjectStatePatch,
		}, { additionalProperties: false }),

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await resolveResearchRuntime(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId();
			const snapshot = await readRuntimeSnapshot(runtime);
			if (runtimeSessionInheritancePolicy(ctx.sessionManager.getBranch(), snapshot, sessionId) === "clean") {
				throw new Error("Clean Sessions cannot mutate Project State. Use /runtime inherit, inspect the current ProjectView, then apply the amendment.");
			}
			const attachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, sessionId);
			if (!attachment) {
				throw new Error("This Session does not own the Research Leader; use /runtime takeover <reason> only if replacing the current owner is intentional.");
			}
			const git = await getGitSnapshot(ctx.cwd);
			const amendmentId = `amend-${createHash("sha256").update(String(toolCallId)).digest("hex").slice(0, 24)}`;
			const amendment = await amendRuntimeProjectState(runtime, {
				id: amendmentId,
				...params,
				sessionId,
				attachmentEpoch: attachment.epoch,
				git,
			});
			pi.appendEntry("research-project-state-amendment", {
				id: amendment.amendment.id,
				revision: amendment.revision,
				reason: amendment.amendment.reason,
				authorityRefs: amendment.amendment.authorityRefs,
				patchKeys: amendment.amendment.patchKeys,
				contentHash: amendment.source.contentHash,
			});
			return {
				content: [{
					type: "text",
					text: `Amended Project State at revision ${amendment.revision}: ${amendment.amendment.patchKeys.join(", ")}. The prior state remains in Runtime history.`,
				}],
				details: amendment,
			};
		},
	});
}
