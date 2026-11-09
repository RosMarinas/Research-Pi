import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveResearchRuntime } from "../lib/research-runtime.mjs";
import { selectResearchBranch } from "../lib/research-branches.mjs";
import { importResearchEvidence, inspectResearchCheckpoint, researchBranchHistory } from "../lib/research-branch-history.mjs";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "research_branch_history", label: "Research Branch History",
		description: "Read a branch's checkpoint history or inspect its frozen research state. Observation does not switch branches or transfer Leader ownership.",
		parameters: Type.Object({ branch: Type.Optional(Type.String()), checkpointId: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const current = await resolveResearchRuntime(ctx.cwd);
			const runtime = params.branch ? await selectResearchBranch(current, params.branch) : current;
			const result = params.checkpointId ? await inspectResearchCheckpoint(runtime, params.checkpointId) : await researchBranchHistory(runtime);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerTool({
		name: "import_research_evidence", label: "Adopt Branch Evidence",
		description: "Explicitly adopt one evidence record from another branch in this project, preserving its source, code identity and limitations. Adds evidence for the current Leader to synthesize; does not replace Project State or copy artifacts.",
		parameters: Type.Object({ branch: Type.String(), evidenceId: Type.String(), reason: Type.String({ maxLength: 3000 }),
			checkpointId: Type.Optional(Type.String()), interpretation: Type.Optional(Type.String({ maxLength: 3000 })) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const target = await resolveResearchRuntime(ctx.cwd);
			const source = await selectResearchBranch(target, params.branch);
			const result = await importResearchEvidence(target, source, { ...params, sessionId: ctx.sessionManager.getSessionId() });
			return { content: [{ type: "text", text: `Adopted evidence ${result.id}; source ${source.branchName}/${params.evidenceId}. Current research claims still require synthesis.` }], details: result };
		},
	});
}
