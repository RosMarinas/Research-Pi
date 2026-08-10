import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface GitIdentity {
	root?: string;
	commit?: string;
	dirty?: boolean;
}

interface ExperimentRecord {
	id: string;
	timestamp: string;
	question: string;
	hypothesis: string;
	intervention: string;
	prediction: string;
	validityChecks: string[];
	observation: string;
	validityJudgment: "valid" | "invalid" | "inconclusive";
	conclusion: string;
	nextStep: string;
	runId?: string;
	artifacts: string[];
	sessionId: string;
	sessionFile?: string;
	model?: string;
	git: GitIdentity;
}

export default function (pi: ExtensionAPI) {
	async function getGitIdentity(cwd: string, signal?: AbortSignal): Promise<GitIdentity> {
		const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 5000 });
		if (root.code !== 0) return {};

		const repoRoot = root.stdout.trim();
		const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], {
			cwd: repoRoot,
			signal,
			timeout: 5000,
		});
		const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
			cwd: repoRoot,
			signal,
			timeout: 5000,
		});

		return {
			root: repoRoot,
			commit: head.code === 0 ? head.stdout.trim() : undefined,
			dirty: status.code === 0 ? status.stdout.trim().length > 0 : undefined,
		};
	}

	pi.registerTool({
		name: "record_experiment",
		label: "Record Experiment",
		description:
			"Persist one lightweight research memo when an observation changes a research judgment. Do not use for ordinary probes, routine commands, or plans without results.",
		promptSnippet: "Record a decision-changing experiment result in the project research ledger",
		promptGuidelines: [
			"Use record_experiment only after a result materially supports, weakens, or leaves unresolved a research hypothesis; do not record routine probes or plans.",
			"Before record_experiment, verify that the intervention actually occurred and that the stated validity checks justify interpreting the observation.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Research question or concrete design uncertainty" }),
			hypothesis: Type.String({ description: "Hypothesis evaluated by this run" }),
			intervention: Type.String({ description: "What was changed, compared, or inspected" }),
			prediction: Type.String({ description: "Observation that would distinguish the important alternatives" }),
			validityChecks: Type.Array(Type.String(), {
				minItems: 1,
				description: "Checks establishing that the observation is interpretable",
			}),
			observation: Type.String({ description: "Observed evidence, separated from interpretation" }),
			validityJudgment: Type.Union(
				[Type.Literal("valid"), Type.Literal("invalid"), Type.Literal("inconclusive")],
				{ description: "Whether the run can update the research hypothesis" },
			),
			conclusion: Type.String({ description: "How the observation updates the hypothesis or decision" }),
			nextStep: Type.String({ description: "Next highest-information action" }),
			runId: Type.Optional(Type.String({ description: "External training/evaluation run identifier, if any" })),
			artifacts: Type.Optional(Type.Array(Type.String(), { description: "Relevant artifact paths or URLs" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const timestamp = new Date().toISOString();
			const id = `exp-${timestamp.replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
			const ledgerDir = join(ctx.cwd, CONFIG_DIR_NAME, "research");
			const ledgerPath = join(ledgerDir, "experiments.jsonl");
			const git = await getGitIdentity(ctx.cwd, signal);
			const record: ExperimentRecord = {
				id,
				timestamp,
				question: params.question,
				hypothesis: params.hypothesis,
				intervention: params.intervention,
				prediction: params.prediction,
				validityChecks: params.validityChecks,
				observation: params.observation,
				validityJudgment: params.validityJudgment,
				conclusion: params.conclusion,
				nextStep: params.nextStep,
				runId: params.runId,
				artifacts: params.artifacts ?? [],
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				git,
			};

			await mkdir(ledgerDir, { recursive: true });
			await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
			pi.appendEntry<ExperimentRecord>("research-experiment", record);

			return {
				content: [
					{
						type: "text",
						text: `Recorded ${id} in ${join(CONFIG_DIR_NAME, "research", "experiments.jsonl")}.`,
					},
				],
				details: record,
			};
		},
	});
}
