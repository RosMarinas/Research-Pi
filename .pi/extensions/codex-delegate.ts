import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_CODEX_MODEL,
	DEFAULT_CODEX_REASONING_EFFORT,
	cancelCodexJob,
	publicJobView,
	readCodexJob,
	resumeCodexJob,
	startCodexJob,
	waitForCodexJob,
} from "../lib/codex-jobs.mjs";

const ActionSchema = Type.Union(
	[
		Type.Literal("start"),
		Type.Literal("status"),
		Type.Literal("result"),
		Type.Literal("cancel"),
		Type.Literal("resume"),
	],
	{ description: "Start or manage one Codex delegation job" },
);

const ModeSchema = Type.Union([Type.Literal("advisor"), Type.Literal("executor")], {
	description: "advisor is read-only; executor has automatic danger-full-access",
});

const EffortSchema = Type.Union(
	[
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
		Type.Literal("ultra"),
	],
	{ description: `Codex reasoning effort; default ${DEFAULT_CODEX_REASONING_EFFORT}` },
);

const ParamsSchema = Type.Object({
	action: ActionSchema,
	mode: Type.Optional(ModeSchema),
	task: Type.Optional(
		Type.String({
			description: "Bounded task for a new delegation. Required for action=start.",
			minLength: 1,
		}),
	),
	successCriteria: Type.Optional(
		Type.Array(Type.String(), {
			description: "Observable conditions Codex should satisfy before returning",
		}),
	),
	context: Type.Optional(
		Type.String({
			description: "Only the research context needed for this task; do not copy the full Pi transcript",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: `Codex model override; default ${DEFAULT_CODEX_MODEL}`,
			minLength: 1,
		}),
	),
	reasoningEffort: Type.Optional(EffortSchema),
	background: Type.Optional(
		Type.Boolean({
			description: "Return a job id immediately. Defaults to true for executor and false for advisor.",
		}),
	),
	timeoutMinutes: Type.Optional(
		Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
			description: "Optional wall-clock timeout. Omit or null for no harness timeout.",
		}),
	),
	jobId: Type.Optional(
		Type.String({
			description: "Existing job id for status, result, cancel, or resume",
		}),
	),
	followUp: Type.Optional(
		Type.String({
			description: "Follow-up instruction for action=resume; continues the exact captured Codex thread",
			minLength: 1,
		}),
	),
});

function requireText(value: string | undefined, label: string): string {
	if (!value?.trim()) throw new Error(`${label} is required`);
	return value.trim();
}

function formatJob(job: ReturnType<typeof publicJobView>): string {
	if (job.status === "completed" && job.result) {
		return `Codex job ${job.id} completed.\n${JSON.stringify(job.result, null, 2)}`;
	}
	if (job.status === "failed" || job.status === "cancelled") {
		return `Codex job ${job.id} ${job.status}: ${job.error ?? job.progress}`;
	}
	return `Codex job ${job.id} is ${job.status}: ${job.progress}. Use action=result later to retrieve its structured result.`;
}

export default function codexDelegateExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex_delegate",
		label: "Codex Delegate",
		description: [
			"Delegate bounded operational work to a context-isolated local Codex executor, or obtain a read-only Codex second opinion.",
			`Both modes default to ${DEFAULT_CODEX_MODEL}/${DEFAULT_CODEX_REASONING_EFFORT}.`,
			"Executor jobs run automatically with danger-full-access and may edit/delete files, commit/push, change remote resources, and run expensive experiments when needed for the delegated task.",
			"Pi remains responsible for framing the research question, judging evidence, and choosing the next research action.",
			"Use action=status/result/cancel/resume with the returned job id; do not start duplicate jobs merely because a background job is still running.",
		].join(" "),
		promptSnippet: "Delegate long operational work or a bounded second opinion to local Codex",
		promptGuidelines: [
			"Use codex_delegate when a bounded execution task would require many tools or produce enough intermediate output to pollute the research context; delegation is for context isolation, not automatic parallelism.",
			"Before starting Codex, state the objective and success criteria. Send only relevant research context; do not copy the full conversation or ask Codex to decide the research objective.",
			"Use mode=executor when Codex should actually complete the work. It has standing authority for in-scope destructive, external, long-running, and expensive operational steps and should not be micromanaged command by command.",
			"Use mode=advisor only for a genuinely useful independent proposal or critique. Advisor is read-only but still uses max reasoning by default.",
			"After retrieving a result, inspect its evidence and validity limitations. Codex completion does not by itself establish a scientific conclusion.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requestedMode = params.mode;
			const startMode = requestedMode ?? "executor";
			let job;

			switch (params.action) {
				case "start":
					job = await startCodexJob({
						cwd: ctx.cwd,
						mode: startMode,
						task: requireText(params.task, "task"),
						successCriteria: params.successCriteria ?? [],
						context: params.context ?? "",
						model: params.model,
						reasoningEffort: params.reasoningEffort,
						timeoutMinutes: params.timeoutMinutes ?? null,
					});
					break;
				case "resume":
					job = await resumeCodexJob(requireText(params.jobId, "jobId"), {
						followUp: requireText(params.followUp, "followUp"),
						mode: params.mode,
						model: params.model,
						reasoningEffort: params.reasoningEffort,
						successCriteria: params.successCriteria ?? [],
						context: params.context ?? "",
						timeoutMinutes: params.timeoutMinutes ?? null,
					});
					break;
				case "status":
				case "result":
					job = await readCodexJob(requireText(params.jobId, "jobId"));
					break;
				case "cancel":
					job = await cancelCodexJob(requireText(params.jobId, "jobId"));
					break;
				default:
					throw new Error(`Unsupported Codex action: ${params.action}`);
			}

			const background = params.background ?? job.mode === "executor";
			if ((params.action === "start" || params.action === "resume") && !background) {
				job = await waitForCodexJob(job.id, {
						signal,
						onUpdate: (current) => {
							onUpdate?.({
								content: [{ type: "text", text: `Codex ${current.status}: ${current.progress}` }],
								details: publicJobView(current),
							});
						},
					});
			}

			const view = publicJobView(job);
			return {
				content: [{ type: "text", text: formatJob(view) }],
				details: view,
			};
		},
	});
}
