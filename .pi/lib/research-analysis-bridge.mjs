import { join } from "node:path";
import { getGitSnapshot } from "./codex-jobs.mjs";
import { buildProjectView, readRecentExperiments, renderProjectView } from "./project-view.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	createRuntimeMessage,
	ensureRuntimeActor,
	readRuntimeSnapshot,
	resolveResearchRuntime,
} from "./research-runtime.mjs";

export const CODEX_ANALYSIS_ACTOR_ID = "analysis:codex";
export const CODEX_ANALYSIS_HANDOFF_MAX_CHARS = 1_200;

export function normalizeCodexAnalysisHandoff(value) {
	const text = String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/[\t ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!text) throw new Error("A concise Codex discussion handoff is required");
	if (text.length > CODEX_ANALYSIS_HANDOFF_MAX_CHARS) {
		throw new Error(
			`Codex discussion handoff is ${text.length} characters; condense it to at most ${CODEX_ANALYSIS_HANDOFF_MAX_CHARS} characters. Send only the judgment, its strongest basis, and the suggested next step—not the transcript.`,
		);
	}
	return text;
}

export async function readCodexAnalysisContext(cwd, options = {}) {
	const runtime = await resolveResearchRuntime(cwd, options);
	const [snapshot, git, experiments] = await Promise.all([
		readRuntimeSnapshot(runtime),
		getGitSnapshot(cwd),
		readRecentExperiments(join(cwd, ".pi", "research", "experiments.jsonl")),
	]);
	const view = buildProjectView({ runtime, snapshot, git, experiments });
	return [
		"<research_pi_codex_analysis>",
		"Independent discussion context. Discuss and inspect without taking over the Research Pi Leader or treating new interpretations as evidence.",
		"Do not send anything automatically. Only when the user explicitly asks to deliver it, send one synthesis of at most 1200 characters with judgment, strongest basis, and suggested next step via `pi analysis send`.",
		renderProjectView(view, { includeDirectedMessages: false }),
		"</research_pi_codex_analysis>",
	].join("\n\n");
}

export async function queueCodexAnalysisHandoff(cwd, value, options = {}) {
	const body = normalizeCodexAnalysisHandoff(value);
	const runtime = await resolveResearchRuntime(cwd, options);
	await ensureRuntimeActor(runtime, {
		id: CODEX_ANALYSIS_ACTOR_ID,
		kind: "analysis",
		label: "Codex Discussion",
		provider: "codex",
		metadata: { interface: "pi-analysis" },
	});
	return await createRuntimeMessage(runtime, {
		type: "notify",
		from: CODEX_ANALYSIS_ACTOR_ID,
		to: RESEARCH_LEADER_ACTOR_ID,
		body: `[Codex discussion handoff]\n${body}`,
		metadata: { kind: "analysis_handoff", source: "codex_discussion" },
	});
}
