import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getGitSnapshot } from "../lib/codex-jobs.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	readRuntimeSnapshot,
	recordResearchTransition,
	resolveResearchRuntime,
	runtimeActorAttachment,
} from "../lib/research-runtime.mjs";

export default function researchTransitionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "record_research_transition",
		label: "Record Research Transition",
		description:
			"Record a rare project-level change of active research direction so later Sessions do not treat the previous route as current. This is not for ordinary next steps, implementation changes, or minor hypothesis updates.",
		promptSnippet: "Record a decision-changing research route transition in Project Runtime",
		promptGuidelines: [
			"Use this only when the user explicitly redirects the research question, or when accepted evidence makes a previous route archived, superseded, or intentionally parallel.",
			"Do not infer a transition merely because files changed or a Codex job completed. State why the old route is no longer the active default and cite the user decision, experiment, run, or authority document that justifies it.",
			"A transition changes Project working memory, not the validity of old evidence. Preserve the old route as contract-bound history rather than rewriting its results.",
			"After a parallel split, set fromTrackRef only when continuing a non-primary live route; copy the exact ref from ProjectView rather than inventing one.",
		],
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Previous research track or question, if named", maxLength: 240 })),
			fromTrackRef: Type.Optional(Type.String({ description: "Exact current/parallel Runtime track ref when transitioning a non-primary route", maxLength: 300 })),
			to: Type.String({ description: "New active research track or question", minLength: 1, maxLength: 240 }),
			reason: Type.String({ description: "Why this changes the active route rather than merely adding a next step", minLength: 1, maxLength: 3000 }),
			oldDisposition: Type.Union(
				[Type.Literal("archived"), Type.Literal("superseded"), Type.Literal("parallel")],
				{ description: "How the previous route should appear in future ProjectView" },
			),
			nextDecision: Type.Optional(Type.String({ description: "Next decision or discriminating experiment on the new route", maxLength: 2000 })),
			authorityRefs: Type.Array(Type.String({ maxLength: 1000 }), {
				description: "Small list of experiment IDs, run IDs, document paths, commits, or explicit user decisions supporting the transition",
				maxItems: 16,
				minItems: 1,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = `transition-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
			const runtime = await resolveResearchRuntime(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId();
			const snapshot = await readRuntimeSnapshot(runtime);
			const attachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, sessionId);
			if (!attachment?.epoch) throw new Error("This is no longer the Leader Session; explicitly promote or take over before changing the research route.");
			const git = await getGitSnapshot(ctx.cwd);
			const transition = await recordResearchTransition(runtime, {
				id,
				...params,
				sessionId,
				attachmentEpoch: attachment.epoch,
				workspaceRoot: ctx.cwd,
				git: { root: git.root, branch: git.branch, commit: git.commit, dirty: git.dirty },
			});
			pi.appendEntry("research-transition", transition);
			return {
				content: [{
					type: "text",
					text: `Recorded Project research transition ${id}: ${transition.from ?? "previous route"} -> ${transition.to}.`,
				}],
				details: transition,
			};
		},
	});
}
