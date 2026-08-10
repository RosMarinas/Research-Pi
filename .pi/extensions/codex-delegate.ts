import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	description: "advisor is project-read-only; executor can fully modify the current project",
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

type CodexJobView = ReturnType<typeof publicJobView>;

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

function shortJobId(jobId: string): string {
	return jobId.slice(-8);
}

function boundedProgress(progress: string | null | undefined): string {
	const compact = String(progress ?? "waiting for progress").replace(/\s+/g, " ").trim();
	return compact.length <= 72 ? compact : `${compact.slice(0, 69)}...`;
}

export function formatCodexStatus(job: CodexJobView, activeCount = 1): string {
	const icon = job.status === "completed" ? "✓" : job.status === "failed" || job.status === "cancelled" ? "✗" : "⚙";
	const count = activeCount > 1 && !TERMINAL_JOB_STATUSES.has(job.status) ? `${activeCount} running · ` : "";
	return `${icon} Codex ${count}${job.mode} ${shortJobId(job.id)} · ${job.status} · ${boundedProgress(job.progress)}`;
}

export default function codexDelegateExtension(pi: ExtensionAPI) {
	const activeJobs = new Map<string, CodexJobView>();
	const monitorTimers = new Map<string, NodeJS.Timeout>();
	let latestTerminal: CodexJobView | undefined;
	let shuttingDown = false;

	const refreshFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const active = [...activeJobs.values()];
		const latest = active.at(-1);
		ctx.ui.setStatus("codex_delegate", latest ? formatCodexStatus(latest, active.length) : latestTerminal ? formatCodexStatus(latestTerminal) : undefined);
	};

	const rememberJob = (job: CodexJobView, ctx: ExtensionContext) => {
		if (TERMINAL_JOB_STATUSES.has(job.status)) {
			activeJobs.delete(job.id);
			latestTerminal = job;
		} else {
			activeJobs.delete(job.id);
			activeJobs.set(job.id, job);
		}
		refreshFooter(ctx);
	};

	const monitorJob = (initial: CodexJobView, ctx: ExtensionContext) => {
		rememberJob(initial, ctx);
		if (TERMINAL_JOB_STATUSES.has(initial.status) || monitorTimers.has(initial.id)) return;

		const poll = async () => {
			if (shuttingDown) return;
			try {
				const current = publicJobView(await readCodexJob(initial.id));
				rememberJob(current, ctx);
				if (TERMINAL_JOB_STATUSES.has(current.status)) {
					monitorTimers.delete(current.id);
					return;
				}
			} catch (error) {
				const previous = activeJobs.get(initial.id) ?? initial;
				rememberJob(
					{
						...previous,
						progress: `status monitor retry: ${error instanceof Error ? error.message : String(error)}`,
					},
					ctx,
				);
			}

			const timer = setTimeout(poll, 750);
			timer.unref();
			monitorTimers.set(initial.id, timer);
		};

		const timer = setTimeout(poll, 250);
		timer.unref();
		monitorTimers.set(initial.id, timer);
	};

	pi.on("session_start", () => {
		shuttingDown = false;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		for (const timer of monitorTimers.values()) clearTimeout(timer);
		monitorTimers.clear();
		activeJobs.clear();
		latestTerminal = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("codex_delegate", undefined);
	});

	pi.registerTool({
		name: "codex_delegate",
		label: "Codex Delegate",
		description: [
			"Delegate bounded operational work to a context-isolated local Codex executor, or obtain a read-only Codex second opinion.",
			`Both modes default to ${DEFAULT_CODEX_MODEL}/${DEFAULT_CODEX_REASONING_EFFORT}.`,
			"Executor jobs run automatically inside the current project boundary. They may edit/delete files, freely commit, use public network, and run expensive experiments, but cannot inherit host credentials or access other directories.",
			"Pi remains responsible for framing the research question, judging evidence, and choosing the next research action.",
			"Use action=status/result/cancel/resume with the returned job id; do not start duplicate jobs merely because a background job is still running.",
		].join(" "),
		promptSnippet: "Delegate long operational work or a bounded second opinion to local Codex",
		promptGuidelines: [
			"Use codex_delegate when a bounded execution task would require many tools or produce enough intermediate output to pollute the research context; delegation is for context isolation, not automatic parallelism.",
			"Before starting Codex, state the objective and success criteria. Send only relevant research context; do not copy the full conversation or ask Codex to decide the research objective.",
			"Use mode=executor when Codex should actually complete the work. It has standing authority for destructive, long-running, and expensive steps inside the current project and should not be micromanaged command by command.",
			"If Codex reports that an outside-project path or host credential is required, review the exact request and hand it to the user. Do not disguise the same operation as a new delegation.",
			"Use mode=advisor only for a genuinely useful independent proposal or critique. Advisor is read-only but still uses max reasoning by default.",
			"After retrieving a result, inspect its evidence and validity limitations. Codex completion does not by itself establish a scientific conclusion.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requestedMode = params.mode;
			const startMode = requestedMode ?? "executor";
			let job;
			if (ctx.hasUI && (params.action === "start" || params.action === "resume")) {
				ctx.ui.setWorkingMessage(params.action === "start" ? "Starting Codex delegation..." : "Resuming Codex delegation...");
				ctx.ui.setStatus("codex_delegate", `⚙ Codex ${startMode} · ${params.action === "start" ? "starting" : "resuming"}`);
			}

			try {
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

				let view = publicJobView(job);
				rememberJob(view, ctx);
				const background = params.background ?? job.mode === "executor";
				if ((params.action === "start" || params.action === "resume") && !background) {
					job = await waitForCodexJob(job.id, {
						signal,
						onUpdate: (current) => {
							const currentView = publicJobView(current);
							rememberJob(currentView, ctx);
							if (ctx.hasUI) ctx.ui.setWorkingMessage(formatCodexStatus(currentView));
							onUpdate?.({
								content: [{ type: "text", text: `Codex ${current.status}: ${current.progress}` }],
								details: currentView,
							});
						},
					});
					view = publicJobView(job);
					rememberJob(view, ctx);
				} else if (!TERMINAL_JOB_STATUSES.has(view.status)) {
					monitorJob(view, ctx);
				}

				return {
					content: [{ type: "text", text: formatJob(view) }],
					details: view,
				};
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.setStatus("codex_delegate", `✗ Codex ${startMode} · call failed`);
				}
				throw error;
			} finally {
				if (ctx.hasUI) ctx.ui.setWorkingMessage();
			}
		},
	});
}
