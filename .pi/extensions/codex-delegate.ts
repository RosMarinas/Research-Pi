import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_CODEX_MODEL,
	DEFAULT_CODEX_REASONING_EFFORT,
	cancelCodexJob,
	findReusableCodexJob,
	isCodexJobOwnerError,
	listCodexJobs,
	listCodexMissions,
	publicJobView,
	readCodexJob,
	respondToCodexJob,
	resumeCodexJob,
	startCodexJob,
	steerCodexJob,
	waitForCodexJob,
} from "../lib/codex-jobs.mjs";

const ActionSchema = Type.Union(
	[
		Type.Literal("start"),
		Type.Literal("status"),
		Type.Literal("result"),
		Type.Literal("cancel"),
		Type.Literal("resume"),
		Type.Literal("respond"),
		Type.Literal("steer"),
		Type.Literal("missions"),
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

const ReuseSchema = Type.Union([Type.Literal("auto"), Type.Literal("never")], {
	description: "auto resumes the latest thread with the same explicit mission and mode on this Pi session branch; never always starts a fresh thread",
});

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
	mission: Type.Optional(
		Type.String({
			description: "Stable research subtask label used for deterministic thread reuse within this workspace and Pi session branch",
			minLength: 1,
			maxLength: 160,
		}),
	),
	reuse: Type.Optional(ReuseSchema),
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
	requestId: Type.Optional(
		Type.String({ description: "Pending request id for action=respond", minLength: 1 }),
	),
	response: Type.Optional(
		Type.String({ description: "Plain-text answer for action=respond; never put credentials or secrets here", minLength: 1 }),
	),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.Array(Type.String()), {
			description: "Optional request_user_input answers keyed by question id",
		}),
	),
	message: Type.Optional(
		Type.String({ description: "Instruction to inject into the active Codex turn for action=steer", minLength: 1 }),
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
	if (job.status === "input_required" && job.pendingRequest) {
		return `Codex job ${job.id} needs input (${job.pendingRequest.id}): ${job.pendingRequest.question}`;
	}
	return `Codex job ${job.id} is ${job.status}: ${job.progress}. Use action=result later to retrieve its structured result.`;
}

function formatMissions(missions: Awaited<ReturnType<typeof listCodexMissions>>): string {
	if (missions.length === 0) return "No Codex missions exist in the current workspace and Pi session branch.";
	return [
		"Codex missions in the current workspace and Pi session branch:",
		...missions.map((mission) => {
			const label = mission.mission ?? "(unlabelled standalone jobs)";
			return `- ${label} · ${mission.mode} · ${mission.status} · ${mission.latestJobId} · ${mission.jobCount} job${mission.jobCount === 1 ? "" : "s"}${mission.reusable ? " · resumable" : ""}`;
		}),
	].join("\n");
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

function leaderScope(ctx: ExtensionContext) {
	return {
		leaderSessionId: ctx.sessionManager.getSessionId(),
		leaderBranchAnchorId: ctx.sessionManager.getLeafId(),
		branchEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
	};
}

function jobManagementScope(ctx: ExtensionContext) {
	const scope = leaderScope(ctx);
	return {
		expectedCwd: ctx.cwd,
		expectedLeaderSessionId: scope.leaderSessionId,
		expectedBranchEntryIds: scope.branchEntryIds,
	};
}

export function formatCodexStatus(job: CodexJobView, activeCount = 1): string {
	const icon = job.status === "completed" ? "✓" : job.status === "failed" || job.status === "cancelled" ? "✗" : job.status === "input_required" ? "?" : "⚙";
	const count = activeCount > 1 && !TERMINAL_JOB_STATUSES.has(job.status) ? `${activeCount} running · ` : "";
	const mission = job.mission ? ` · ${boundedProgress(job.mission).slice(0, 36)}` : "";
	return `${icon} Codex ${count}${job.mode} ${shortJobId(job.id)}${mission} · ${job.status} · ${boundedProgress(job.progress)}`;
}

export default function codexDelegateExtension(pi: ExtensionAPI) {
	const EVENT_KIND = "codex-delegation-event";
	const activeJobs = new Map<string, CodexJobView>();
	const monitorTimers = new Map<string, NodeJS.Timeout>();
	const deliveredEvents = new Set<string>();
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

	const eventId = (job: CodexJobView): string | undefined => {
		if (job.status === "input_required" && job.pendingRequest?.id) return `${job.id}:request:${job.pendingRequest.id}`;
		if (TERMINAL_JOB_STATUSES.has(job.status)) return `${job.id}:terminal:${job.status}`;
		return undefined;
	};

	const boundedList = (values: unknown, limit = 8): string[] =>
		Array.isArray(values) ? values.slice(0, limit).map((value) => boundedProgress(String(value))) : [];

	const eventContent = (job: CodexJobView): string => {
		if (job.status === "input_required" && job.pendingRequest) {
			const pending = job.pendingRequest;
			return [
				`Codex delegation ${job.id} is waiting for ${pending.audience === "user" ? "the user" : "Research Pi"}.`,
				`Request id: ${pending.id}`,
				`Question: ${pending.question}`,
				pending.whyBlocking ? `Why it blocks progress: ${pending.whyBlocking}` : undefined,
				pending.options?.length ? `Options: ${pending.options.join(" | ")}` : undefined,
				pending.secret
					? "This request is marked secret. Do not ask for or transmit the secret through Pi, model context, codex_delegate, or job files. Ask the user to configure it directly, then continue without echoing it."
					: `Answer with codex_delegate action=respond, jobId=${job.id}, requestId=${pending.id}. Use action=steer only for unsolicited corrections to the active turn.`,
			]
				.filter(Boolean)
				.join("\n");
		}
		const result = job.result ?? {};
		return [
			`Codex delegation ${job.id} ${job.status}. Pi must inspect this result and decide the next research action; completion alone is not scientific evidence.`,
			`Mode/model: ${job.mode} · ${job.model} · ${job.reasoningEffort}`,
			job.mission ? `Mission: ${job.mission}` : undefined,
			result.summary ? `Summary: ${String(result.summary).slice(0, 5000)}` : undefined,
			boundedList(result.evidence).length ? `Evidence:\n- ${boundedList(result.evidence).join("\n- ")}` : undefined,
			boundedList(result.uncertainties).length ? `Uncertainties:\n- ${boundedList(result.uncertainties).join("\n- ")}` : undefined,
			result.recommended_next_step ? `Recommended next step: ${String(result.recommended_next_step).slice(0, 3000)}` : undefined,
			job.error ? `Error: ${String(job.error).slice(0, 3000)}` : undefined,
			`Use codex_delegate action=result with jobId=${job.id} if the full structured result is needed.`,
		]
			.filter(Boolean)
			.join("\n");
	};

	const deliverJobEvent = (job: CodexJobView, ctx: ExtensionContext) => {
		const id = eventId(job);
		if (!id || deliveredEvents.has(id)) return;
		const editorHasDraft = ctx.hasUI && Boolean(ctx.ui.getEditorText?.().trim());
		try {
			pi.sendMessage(
				{
					customType: EVENT_KIND,
					content: eventContent(job),
					display: true,
					details: { eventId: id, jobId: job.id, status: job.status, requestId: job.pendingRequest?.id ?? null },
				},
				{
					deliverAs: editorHasDraft ? "nextTurn" : "followUp",
					triggerTurn: !editorHasDraft,
				},
			);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not deliver Codex event: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		deliveredEvents.add(id);
		if (editorHasDraft && ctx.hasUI) {
			ctx.ui.notify(`Codex ${shortJobId(job.id)} ${job.status}; the event is queued behind your editor draft.`, "info");
		}
	};

	const monitorJob = (initial: CodexJobView, ctx: ExtensionContext) => {
		rememberJob(initial, ctx);
		deliverJobEvent(initial, ctx);
		if (TERMINAL_JOB_STATUSES.has(initial.status) || monitorTimers.has(initial.id)) return;

		const poll = async () => {
			if (shuttingDown) return;
			try {
				const current = publicJobView(await readCodexJob(initial.id, jobManagementScope(ctx)));
				rememberJob(current, ctx);
				deliverJobEvent(current, ctx);
				if (TERMINAL_JOB_STATUSES.has(current.status)) {
					monitorTimers.delete(current.id);
					return;
				}
			} catch (error) {
				if (isCodexJobOwnerError(error)) {
					monitorTimers.delete(initial.id);
					activeJobs.delete(initial.id);
					refreshFooter(ctx);
					return;
				}
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

	const resetMonitors = (ctx: ExtensionContext) => {
		for (const timer of monitorTimers.values()) clearTimeout(timer);
		monitorTimers.clear();
		activeJobs.clear();
		latestTerminal = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("codex_delegate", undefined);
	};

	const reattachBranchJobs = async (ctx: ExtensionContext) => {
		resetMonitors(ctx);
		deliveredEvents.clear();
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "custom_message" && entry.customType === EVENT_KIND && entry.details?.eventId) {
				deliveredEvents.add(String(entry.details.eventId));
			}
		}
		try {
			const jobs = await listCodexJobs({
				leaderSessionId: ctx.sessionManager.getSessionId(),
				branchEntryIds: new Set(branch.map((entry) => entry.id)),
				cwd: ctx.cwd,
			});
			for (const job of jobs) {
				if (TERMINAL_JOB_STATUSES.has(job.status) && job.autoNotify === false) continue;
				monitorJob(publicJobView(job), ctx);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not reattach Codex jobs: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		await reattachBranchJobs(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await reattachBranchJobs(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		resetMonitors(ctx);
	});

	pi.registerCommand("codex", {
		description: "Inspect Codex mission threads on this Pi session branch (/codex missions)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = args.trim() || "missions";
			if (action !== "missions" && action !== "list") {
				ctx.ui.notify("Usage: /codex missions", "warning");
				return;
			}
			try {
				const scope = leaderScope(ctx);
				ctx.ui.notify(formatMissions(await listCodexMissions({
					cwd: ctx.cwd,
					leaderSessionId: scope.leaderSessionId,
					branchEntryIds: scope.branchEntryIds,
				})), "info");
			} catch (error) {
				ctx.ui.notify(`Could not list Codex missions: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "codex_delegate",
		label: "Codex Delegate",
		description: [
			"Delegate bounded operational work to a context-isolated local Codex executor, or obtain a read-only Codex second opinion.",
			`Both modes default to ${DEFAULT_CODEX_MODEL}/${DEFAULT_CODEX_REASONING_EFFORT}.`,
			"Executor jobs run automatically inside the current project boundary. They may edit/delete files, freely commit, use public network, and run expensive experiments. Exact user-approved external-read, SSH-target, or fixed-script capabilities are available through an opaque host broker; raw credentials never enter Codex.",
			"Pi remains responsible for framing the research question, judging evidence, and choosing the next research action.",
			"Give related work a stable mission label and use reuse=auto to continue its exact Codex thread on the active Pi branch; use action=missions to inspect branch-local mission threads.",
			"Use action=status/result/cancel/resume/respond/steer with the returned job id; jobs from another workspace, Pi session, or sibling branch cannot be managed or resumed.",
			"Background completion and blocking requests are delivered only into the originating Pi session branch. respond answers an explicit request; steer corrects an active turn without restarting it.",
		].join(" "),
		promptSnippet: "Delegate long operational work or a bounded second opinion to local Codex",
		promptGuidelines: [
			"Use codex_delegate when a bounded execution task would require many tools or produce enough intermediate output to pollute the research context; delegation is for context isolation, not automatic parallelism.",
			"Before starting Codex, state the objective and success criteria. Send only relevant research context; do not copy the full conversation or ask Codex to decide the research objective.",
			"Use a stable mission label for consecutive work on one research subtask and reuse=auto. Reuse is restricted to the active Pi session branch. Start a fresh mission for an independent critique, a different research route, a different workspace, or substantially stale assumptions.",
			"Use mode=executor when Codex should actually complete the work. It has standing authority for destructive, long-running, and expensive steps inside the current project and should not be micromanaged command by command.",
			"If Codex needs an unapproved outside path, SSH target, or host script, review the exact request and ask the user for the returned /boundary grant. After approval, respond so Codex can retry the same turn. Do not disguise the operation as a new delegation.",
			"Use mode=advisor only for a genuinely useful independent proposal or critique. Advisor is read-only but still uses max reasoning by default.",
			"After retrieving a result, inspect its evidence and validity limitations. Codex completion does not by itself establish a scientific conclusion.",
			"When a Codex request arrives, answer it promptly with action=respond if Pi can decide. Ask the user only for user-owned choices or direct credential setup. Never place secrets in a response.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requestedMode = params.mode;
			const startMode = requestedMode ?? "executor";
			const owner = leaderScope(ctx);
			const ownerCheck = {
				expectedCwd: ctx.cwd,
				expectedLeaderSessionId: owner.leaderSessionId,
				expectedBranchEntryIds: owner.branchEntryIds,
			};
			let effectiveBackground = params.background ?? (startMode === "executor");
			let job;
			let commandReceipt: string | undefined;
			if (ctx.hasUI && (params.action === "start" || params.action === "resume")) {
				ctx.ui.setWorkingMessage(params.action === "start" ? "Starting Codex delegation..." : "Resuming Codex delegation...");
				ctx.ui.setStatus("codex_delegate", `⚙ Codex ${startMode} · ${params.action === "start" ? "starting" : "resuming"}`);
			}

			try {
				switch (params.action) {
					case "start": {
						const task = requireText(params.task, "task");
						const reuse = params.reuse ?? (params.mission ? "auto" : "never");
						const common = {
							cwd: ctx.cwd,
							mode: startMode,
							successCriteria: params.successCriteria ?? [],
							context: params.context ?? "",
							mission: params.mission,
							model: params.model,
							reasoningEffort: params.reasoningEffort,
							timeoutMinutes: params.timeoutMinutes ?? null,
							leaderSessionId: owner.leaderSessionId,
							leaderBranchAnchorId: owner.leaderBranchAnchorId,
							background: effectiveBackground,
						};
						const reusable = reuse === "auto"
							? await findReusableCodexJob({
								cwd: ctx.cwd,
								mission: params.mission,
								mode: startMode,
								leaderSessionId: owner.leaderSessionId,
								branchEntryIds: owner.branchEntryIds,
							})
							: null;
						if (reusable && !TERMINAL_JOB_STATUSES.has(reusable.status)) {
							job = reusable;
							commandReceipt = `Codex mission "${reusable.mission}" already has active job ${reusable.id}; attached to it instead of starting a duplicate.`;
						} else if (reusable?.threadId) {
							job = await resumeCodexJob(reusable.id, {
								...common,
								...ownerCheck,
								followUp: task,
							});
							commandReceipt = `Resumed Codex mission "${reusable.mission}" from job ${reusable.id} as ${job.id}.`;
						} else {
							job = await startCodexJob({ ...common, task });
						}
						break;
					}
					case "resume":
						job = await resumeCodexJob(requireText(params.jobId, "jobId"), {
							followUp: requireText(params.followUp, "followUp"),
							mode: params.mode,
							model: params.model,
							reasoningEffort: params.reasoningEffort,
							successCriteria: params.successCriteria ?? [],
							context: params.context ?? "",
							mission: params.mission,
							timeoutMinutes: params.timeoutMinutes ?? null,
							leaderSessionId: owner.leaderSessionId,
							leaderBranchAnchorId: owner.leaderBranchAnchorId,
							background: params.background,
							...ownerCheck,
						});
						effectiveBackground = params.background ?? job.autoNotify ?? (job.mode === "executor");
						break;
					case "respond": {
						const queued = await respondToCodexJob(requireText(params.jobId, "jobId"), {
							requestId: requireText(params.requestId, "requestId"),
							response: params.response,
							answers: params.answers,
							...ownerCheck,
						});
						job = queued.job;
						commandReceipt = `Response queued for Codex request ${params.requestId} in job ${job.id}.`;
						break;
					}
					case "steer": {
						const queued = await steerCodexJob(requireText(params.jobId, "jobId"), {
							message: requireText(params.message, "message"),
							...ownerCheck,
						});
						job = queued.job;
						commandReceipt = `Steering message queued for active Codex job ${job.id}.`;
						break;
					}
					case "status":
					case "result":
						job = await readCodexJob(requireText(params.jobId, "jobId"), ownerCheck);
						break;
					case "cancel":
						job = await cancelCodexJob(requireText(params.jobId, "jobId"), ownerCheck);
						break;
					case "missions": {
						const missions = await listCodexMissions({
							cwd: ctx.cwd,
							leaderSessionId: owner.leaderSessionId,
							branchEntryIds: owner.branchEntryIds,
						});
						return {
							content: [{ type: "text", text: formatMissions(missions) }],
							details: { missions },
						};
					}
					default:
						throw new Error(`Unsupported Codex action: ${params.action}`);
				}

				let view = publicJobView(job);
				rememberJob(view, ctx);
				if ((params.action === "start" || params.action === "resume") && !effectiveBackground) {
					job = await waitForCodexJob(job.id, {
						signal,
						...ownerCheck,
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
					content: [{
						type: "text",
						text: commandReceipt && TERMINAL_JOB_STATUSES.has(view.status)
							? `${commandReceipt}\n${formatJob(view)}`
							: commandReceipt ?? formatJob(view),
					}],
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
