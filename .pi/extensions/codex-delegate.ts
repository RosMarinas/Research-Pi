import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	defaultCodexModel,
	defaultCodexReasoningEffort,
	cancelCodexJob,
	findReusableCodexJob,
	isCodexJobOwnerError,
	listCodexJobs,
	listCodexMissions,
	publicJobView,
	readCodexJob,
	reconcileCodexJobOutcome,
	respondToCodexJob,
	resumeCodexJob,
	startCodexJob,
	steerCodexJob,
	waitForCodexJob,
} from "../lib/codex-jobs.mjs";
import { getRuntimeUiAdapter, registerCodexRuntimeAdapter } from "../lib/research-runtime-adapters.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_MESSAGE_KIND,
	codexActorId,
	readRuntimeSnapshot,
	recordCodexRuntimeEvent,
	registerCodexRuntimeJob,
	resolveResearchRuntime,
	runtimeResearchTrack,
	runtimeMessageText,
	runtimeActorAttachment,
	runtimeSessionInheritancePolicy,
	settleRuntimeMessage,
	withRuntimeActorAttachment,
} from "../lib/research-runtime.mjs";

const ActionSchema = Type.Union(
	[
		Type.Literal("start"),
		Type.Literal("status"),
		Type.Literal("result"),
		Type.Literal("cancel"),
		Type.Literal("resume"),
		Type.Literal("respond"),
		Type.Literal("steer"),
		Type.Literal("reconcile"),
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
	{ description: "Codex reasoning effort; advisor and executor defaults are configured separately" },
);

const ReuseSchema = Type.Union([Type.Literal("auto"), Type.Literal("never")], {
	description: "auto resumes the latest Actor thread with the same explicit mission, mode, and research track in this exact project workspace; never always starts a fresh thread",
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
			description: "Stable research subtask label used for deterministic Actor/thread reuse across Pi sessions in this exact workspace",
			minLength: 1,
			maxLength: 160,
		}),
	),
	reuse: Type.Optional(ReuseSchema),
	model: Type.Optional(
		Type.String({
			description: `Codex model override; configured defaults advisor=${defaultCodexModel("advisor")}, executor=${defaultCodexModel("executor")}`,
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
			description: "Existing job id for status, result, cancel, resume, respond, steer, or reconcile",
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
	outcome: Type.Optional(
		Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")], {
			description: "Observed terminal outcome for action=reconcile",
		}),
	),
	note: Type.Optional(
		Type.String({ description: "Evidence from inspecting Git and external run state; required for action=reconcile", minLength: 1, maxLength: 8000 }),
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
	if (job.status === "outcome_unknown") {
		return `Codex job ${job.id} has outcome_unknown: side effects may have occurred. Inspect Git and external run state, then use action=reconcile with outcome and an evidence note before starting another executor in this workspace.`;
	}
	if (job.status === "input_required" && job.pendingRequest) {
		return `Codex job ${job.id} needs input (${job.pendingRequest.id}): ${job.pendingRequest.question}`;
	}
	return `Codex job ${job.id} is ${job.status}: ${job.progress}. Use action=result later to retrieve its structured result.`;
}

function formatMissions(missions: Awaited<ReturnType<typeof listCodexMissions>>): string {
	if (missions.length === 0) return "No Codex missions exist in the current project workspace.";
	return [
		"Codex Actor missions in the current project workspace:",
		...missions.map((mission) => {
			const label = mission.mission ?? "(unlabelled standalone jobs)";
			return `- ${label} · ${mission.mode} · ${mission.status} · track=${mission.researchTrackRef} · ${mission.latestJobId} · ${mission.jobCount} job${mission.jobCount === 1 ? "" : "s"}${mission.reusable ? " · resumable" : ""}`;
		}),
	].join("\n");
}

type CodexJobView = ReturnType<typeof publicJobView>;

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "outcome_unknown"]);

function shortJobId(jobId: string): string {
	return jobId.slice(-8);
}

function boundedProgress(progress: string | null | undefined): string {
	const compact = String(progress ?? "waiting for progress").replace(/\s+/g, " ").trim();
	return compact.length <= 72 ? compact : `${compact.slice(0, 69)}...`;
}

async function leaderScope(ctx: ExtensionContext, options: { requireAttached?: boolean } = {}) {
	const runtime = await resolveResearchRuntime(ctx.cwd);
	const snapshot = await readRuntimeSnapshot(runtime);
	const track = runtimeResearchTrack(snapshot);
	const leaderSessionId = ctx.sessionManager.getSessionId();
	const attachment = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID, leaderSessionId);
	if (options.requireAttached && !attachment) {
		throw new Error("This Pi Session no longer owns the Research Leader; stop this run or explicitly take over before changing Codex work.");
	}
	return {
		runtime,
		projectKey: runtime.projectKey,
		projectRevision: snapshot.revision,
		researchTrackRef: track.ref,
		researchTrackLabel: track.label,
		leaderActorId: RESEARCH_LEADER_ACTOR_ID,
		leaderSessionId,
		attachmentEpoch: attachment?.epoch ?? null,
		leaderBranchAnchorId: ctx.sessionManager.getLeafId(),
		branchEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
		inheritancePolicy: runtimeSessionInheritancePolicy(ctx.sessionManager.getBranch(), snapshot, leaderSessionId),
	};
}

function projectJobManagementScope(ctx: ExtensionContext, scope: Awaited<ReturnType<typeof leaderScope>>) {
	return {
		expectedCwd: ctx.cwd,
		expectedProjectKey: scope.projectKey,
		expectedLeaderActorId: scope.leaderActorId,
	};
}

async function jobManagementScope(ctx: ExtensionContext, jobId: string) {
	const scope = await leaderScope(ctx);
	const job = await readCodexJob(jobId, { expectedCwd: ctx.cwd });
	if (job.leaderActorId) return projectJobManagementScope(ctx, scope);
	return {
		expectedCwd: ctx.cwd,
		expectedLeaderSessionId: scope.leaderSessionId,
		expectedBranchEntryIds: scope.branchEntryIds,
	};
}

async function listOwnedCodexJobs(ctx: ExtensionContext) {
	const scope = await leaderScope(ctx);
	const [projectJobs, legacyJobs] = await Promise.all([
		listCodexJobs({ cwd: ctx.cwd, projectKey: scope.projectKey, leaderActorId: scope.leaderActorId }),
		listCodexJobs({ cwd: ctx.cwd, leaderSessionId: scope.leaderSessionId, branchEntryIds: scope.branchEntryIds, legacyOnly: true }),
	]);
	return [...new Map([...projectJobs, ...legacyJobs].map((job) => [job.id, job])).values()];
}

async function listOwnedCodexMissions(ctx: ExtensionContext) {
	const scope = await leaderScope(ctx);
	const [projectMissions, legacyMissions] = await Promise.all([
		listCodexMissions({ cwd: ctx.cwd, projectKey: scope.projectKey, leaderActorId: scope.leaderActorId }),
		listCodexMissions({ cwd: ctx.cwd, leaderSessionId: scope.leaderSessionId, branchEntryIds: scope.branchEntryIds, legacyOnly: true }),
	]);
	return [...projectMissions, ...legacyMissions];
}

export function formatCodexStatus(job: CodexJobView, activeCount = 1): string {
	const icon = job.status === "completed" ? "✓" : job.status === "outcome_unknown" ? "!" : job.status === "failed" || job.status === "cancelled" ? "✗" : job.status === "input_required" ? "?" : "⚙";
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
		void getRuntimeUiAdapter()?.refresh(ctx, { codexJobs: [...activeJobs.values()] }).catch(() => undefined);
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
		if (job.status === "outcome_unknown") {
			return [
				`Codex delegation ${job.id} lost its worker after executor side effects may have started.`,
				"Do not infer success or failure from the missing terminal record.",
				"Inspect Git, files, remote jobs, and other external effects relevant to this delegation.",
				`Then use codex_delegate action=reconcile, jobId=${job.id}, outcome=<completed|failed|cancelled>, note=<inspection evidence>.`,
				"Another Codex executor in this workspace is blocked until reconciliation; advisor mode remains available.",
			].join("\n");
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

	const deliverJobEvent = async (job: CodexJobView, ctx: ExtensionContext) => {
		const id = eventId(job);
		if (!id || deliveredEvents.has(id)) return;
		const runtime = await resolveResearchRuntime(ctx.cwd);
		const message = await recordCodexRuntimeEvent(runtime, job, eventContent(job));
		if (!message || message.status !== "queued") {
			deliveredEvents.add(id);
			return;
		}
		const snapshot = await readRuntimeSnapshot(runtime);
		if (runtimeSessionInheritancePolicy(ctx.sessionManager.getBranch(), snapshot, ctx.sessionManager.getSessionId()) === "clean") {
			// The durable Runtime mailbox now owns delivery. Mark the watcher event
			// handled so a clean Session does not repeatedly re-project the same job.
			deliveredEvents.add(id);
			return;
		}
		const attachment = runtimeActorAttachment(
			snapshot,
			RESEARCH_LEADER_ACTOR_ID,
			ctx.sessionManager.getSessionId(),
		);
		if (!attachment) return;
		const editorHasDraft = ctx.hasUI && Boolean(ctx.ui.getEditorText?.().trim());
		try {
			pi.sendMessage(
				{
					customType: RUNTIME_MESSAGE_KIND,
					content: runtimeMessageText(message),
					display: true,
					details: {
						eventId: id,
						messageId: message.id,
						type: message.type,
						from: message.from,
						to: message.to,
						jobId: job.id,
						status: job.status,
						requestId: job.pendingRequest?.id ?? null,
						transient: true,
						attachmentEpoch: attachment.epoch ?? null,
					},
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
		await settleRuntimeMessage(runtime, message.id, "delivered", {
			sessionId: ctx.sessionManager.getSessionId(),
			actorId: RESEARCH_LEADER_ACTOR_ID,
			attachmentEpoch: attachment.epoch ?? null,
		});
		deliveredEvents.add(id);
		if (editorHasDraft && ctx.hasUI) {
			ctx.ui.notify(`Codex ${shortJobId(job.id)} ${job.status}; the event is queued behind your editor draft.`, "info");
		}
	};

	const monitorJob = (initial: CodexJobView, ctx: ExtensionContext) => {
		rememberJob(initial, ctx);
		void deliverJobEvent(initial, ctx).catch((error) => {
			if (ctx.hasUI) ctx.ui.notify(`Could not persist Codex Runtime event: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
		if (TERMINAL_JOB_STATUSES.has(initial.status) || monitorTimers.has(initial.id)) return;

		const poll = async () => {
			if (shuttingDown) return;
			try {
				const current = publicJobView(await readCodexJob(initial.id, await jobManagementScope(ctx, initial.id)));
				rememberJob(current, ctx);
				await deliverJobEvent(current, ctx);
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
		void getRuntimeUiAdapter()?.refresh(ctx, { codexJobs: [] }).catch(() => undefined);
	};

	const reattachBranchJobs = async (ctx: ExtensionContext) => {
		resetMonitors(ctx);
		deliveredEvents.clear();
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "custom_message" && [EVENT_KIND, RUNTIME_MESSAGE_KIND].includes(entry.customType) && entry.details?.eventId) {
				deliveredEvents.add(String(entry.details.eventId));
			}
		}
		try {
			const runtime = await resolveResearchRuntime(ctx.cwd);
			const jobs = await listOwnedCodexJobs(ctx);
			for (const job of jobs) {
				if (job.leaderActorId) await registerCodexRuntimeJob(runtime, publicJobView(job));
				if (TERMINAL_JOB_STATUSES.has(job.status) && job.autoNotify === false) continue;
				monitorJob(publicJobView(job), ctx);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not reattach Codex jobs: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	registerCodexRuntimeAdapter({
		dispatch: async ({ runtime, actor, message, preempt, ctx }) => {
			const owner = await leaderScope(ctx, { requireAttached: true });
			const withLeaderLease = <T>(operation: () => Promise<T>) => withRuntimeActorAttachment(
				owner.runtime,
				RESEARCH_LEADER_ACTOR_ID,
				{ sessionId: owner.leaderSessionId, attachmentEpoch: owner.attachmentEpoch },
				operation,
			);
			const jobs = await listCodexJobs({
				cwd: ctx.cwd,
				projectKey: owner.projectKey,
				leaderActorId: owner.leaderActorId,
				actorId: actor.id,
			});
			const latest = jobs.at(-1);
			if (!latest) return { status: "queued", detail: `${actor.label} has no resumable Codex thread yet` };
			const ownerCheck = projectJobManagementScope(ctx, owner);
			const live = !TERMINAL_JOB_STATUSES.has(latest.status);
			const instruction = runtimeMessageText(message, (await readRuntimeSnapshot(runtime)).actors);
			let nextJob = latest;

			if (message.type === "reply" && live && latest.pendingRequest?.id) {
				const queued = await withLeaderLease(() => respondToCodexJob(latest.id, {
					requestId: latest.pendingRequest.id,
					response: message.body,
					...ownerCheck,
				}));
				nextJob = queued.job;
			} else if (live && !preempt) {
				const queued = await withLeaderLease(() => steerCodexJob(latest.id, { message: instruction, ...ownerCheck }));
				nextJob = queued.job;
			} else {
				nextJob = await withLeaderLease(async () => {
					if (live) await cancelCodexJob(latest.id, ownerCheck);
					if (!latest.threadId) return null;
					return await resumeCodexJob(latest.id, {
						followUp: instruction,
						leaderSessionId: owner.leaderSessionId,
						leaderBranchAnchorId: owner.leaderBranchAnchorId,
						leaderActorId: owner.leaderActorId,
						actorId: actor.id,
						projectRevision: owner.projectRevision,
						researchTrackRef: owner.researchTrackRef,
						researchTrackLabel: owner.researchTrackLabel,
						background: true,
						...ownerCheck,
					});
				});
				if (!nextJob) return { status: "queued", detail: `${actor.label} has no resumable Codex thread` };
			}

			const view = publicJobView(nextJob);
			await registerCodexRuntimeJob(runtime, view);
			monitorJob(view, ctx);
			return {
				status: "delivered",
				detail: preempt && live
					? `interrupted ${shortJobId(latest.id)} and resumed ${shortJobId(view.id)}`
					: live
						? `delivered to active Codex job ${shortJobId(view.id)}`
						: `resumed Codex job ${shortJobId(view.id)}`,
			};
		},
	});

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
		description: "Inspect project Codex Actor mission threads (/codex missions)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = args.trim() || "missions";
			if (action !== "missions" && action !== "list") {
				ctx.ui.notify("Usage: /codex missions", "warning");
				return;
			}
			try {
				ctx.ui.notify(formatMissions(await listOwnedCodexMissions(ctx)), "info");
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
			`Configured defaults: advisor ${defaultCodexModel("advisor")}/${defaultCodexReasoningEffort("advisor")}; executor ${defaultCodexModel("executor")}/${defaultCodexReasoningEffort("executor")}.`,
			"Executor jobs run automatically inside the current project boundary. They may edit/delete files, freely commit, use public network, and run expensive experiments. Exact user-approved external-read, SSH-target, or fixed-script capabilities are available through an opaque host broker; raw credentials never enter Codex.",
			"Pi remains responsible for framing the research question, judging evidence, and choosing the next research action.",
			"Give related work a stable mission label and use reuse=auto to continue its exact Codex Actor thread across Pi sessions in this project workspace; use action=missions to inspect project mission threads.",
			"Use action=status/result/cancel/resume/respond/steer with the returned job id; Actor-owned jobs remain bound to the exact project workspace but are not owned by one Pi conversation.",
			"If an executor loses its worker after execution started, it stops at outcome_unknown. Inspect Git and external run state, then use action=reconcile; the harness blocks another writer until this is resolved.",
			"Background completion and blocking requests enter the project Runtime mailbox and are delivered to the currently attached Research Leader session. respond answers an explicit request; steer corrects an active turn without restarting it.",
		].join(" "),
		promptSnippet: "Delegate long operational work or a bounded second opinion to local Codex",
		promptGuidelines: [
			"Use codex_delegate when a bounded execution task would require many tools or produce enough intermediate output to pollute the research context; delegation is for context isolation, not automatic parallelism.",
			"Before starting Codex, state the objective and success criteria. Send only relevant research context; do not copy the full conversation or ask Codex to decide the research objective.",
			"Use a stable mission label for consecutive work on one research subtask and reuse=auto. The mission is a project Codex Actor and survives Pi session rotation. Start a fresh mission for an independent critique, a different research route, a different workspace, or substantially stale assumptions.",
			"Use mode=executor when Codex should actually complete the work. It has standing authority for destructive, long-running, and expensive steps inside the current project and should not be micromanaged command by command.",
			"If Codex needs an unapproved outside path, SSH target, or host script, review the exact request and ask the user for the returned /boundary grant. After approval, respond so Codex can retry the same turn. Do not disguise the operation as a new delegation.",
			"Use mode=advisor only for a genuinely useful independent proposal or critique. Advisor is read-only but still uses max reasoning by default.",
			"After retrieving a result, inspect its evidence and validity limitations. Codex completion does not by itself establish a scientific conclusion.",
			"Never guess an outcome_unknown resolution. Reconcile only after inspecting the relevant Git state, files, remote runs, or other external effects, and record that evidence in note.",
			"When a Codex request arrives, answer it promptly with action=respond if Pi can decide. Ask the user only for user-owned choices or direct credential setup. Never place secrets in a response.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const requestedMode = params.mode;
			const startMode = requestedMode ?? "executor";
			const mutatesCodex = !["status", "result", "missions"].includes(params.action);
			const owner = await leaderScope(ctx, { requireAttached: mutatesCodex });
			const withLeaderLease = <T>(operation: () => Promise<T>) => withRuntimeActorAttachment(
				owner.runtime,
				RESEARCH_LEADER_ACTOR_ID,
				{ sessionId: owner.leaderSessionId, attachmentEpoch: owner.attachmentEpoch },
				operation,
			);
			const projectOwnerCheck = projectJobManagementScope(ctx, owner);
			let ownerCheck = projectOwnerCheck;
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
						const requestedReuse = params.reuse ?? (params.mission ? "auto" : "never");
						const reuse = owner.inheritancePolicy === "clean" && requestedReuse === "auto" ? "never" : requestedReuse;
						const actorId = params.mission ? codexActorId({ mission: params.mission, mode: startMode }) : undefined;
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
							leaderActorId: owner.leaderActorId,
							leaderBranchAnchorId: owner.leaderBranchAnchorId,
							actorId,
							projectRevision: owner.projectRevision,
							researchTrackRef: owner.researchTrackRef,
							researchTrackLabel: owner.researchTrackLabel,
							background: effectiveBackground,
						};
						const reusable = reuse === "auto"
							? await findReusableCodexJob({
								cwd: ctx.cwd,
								mission: params.mission,
								mode: startMode,
								projectKey: owner.projectKey,
								leaderActorId: owner.leaderActorId,
								actorId,
								researchTrackRef: owner.researchTrackRef,
							})
							: null;
						if (reusable && !TERMINAL_JOB_STATUSES.has(reusable.status)) {
							job = reusable;
							commandReceipt = `Codex mission "${reusable.mission}" already has active job ${reusable.id}; attached to it instead of starting a duplicate.`;
						} else if (reusable?.threadId) {
							job = await withLeaderLease(() => resumeCodexJob(reusable.id, {
								...common,
								...ownerCheck,
								followUp: task,
							}));
							commandReceipt = `Resumed Codex mission "${reusable.mission}" from job ${reusable.id} as ${job.id}.`;
						} else {
							job = await withLeaderLease(() => startCodexJob({ ...common, task }));
						}
						break;
					}
					case "resume": {
						const jobId = requireText(params.jobId, "jobId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						job = await withLeaderLease(() => resumeCodexJob(jobId, {
							followUp: requireText(params.followUp, "followUp"),
							mode: params.mode,
							model: params.model,
							reasoningEffort: params.reasoningEffort,
							successCriteria: params.successCriteria ?? [],
							context: params.context ?? "",
							mission: params.mission,
							timeoutMinutes: params.timeoutMinutes ?? null,
							leaderSessionId: owner.leaderSessionId,
							leaderActorId: owner.leaderActorId,
							leaderBranchAnchorId: owner.leaderBranchAnchorId,
							projectRevision: owner.projectRevision,
							researchTrackRef: owner.researchTrackRef,
							researchTrackLabel: owner.researchTrackLabel,
							background: params.background,
							...ownerCheck,
						}));
						ownerCheck = projectOwnerCheck;
						effectiveBackground = params.background ?? job.autoNotify ?? (job.mode === "executor");
						break;
					}
					case "respond": {
						const jobId = requireText(params.jobId, "jobId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						const queued = await withLeaderLease(() => respondToCodexJob(jobId, {
							requestId: requireText(params.requestId, "requestId"),
							response: params.response,
							answers: params.answers,
							...ownerCheck,
						}));
						job = queued.job;
						commandReceipt = `Response queued for Codex request ${params.requestId} in job ${job.id}.`;
						break;
					}
					case "steer": {
						const jobId = requireText(params.jobId, "jobId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						const queued = await withLeaderLease(() => steerCodexJob(jobId, {
							message: requireText(params.message, "message"),
							...ownerCheck,
						}));
						job = queued.job;
						commandReceipt = `Steering message queued for active Codex job ${job.id}.`;
						break;
					}
					case "status":
					case "result": {
						const jobId = requireText(params.jobId, "jobId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						job = await readCodexJob(jobId, ownerCheck);
						break;
					}
					case "cancel": {
						const jobId = requireText(params.jobId, "jobId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						job = await withLeaderLease(() => cancelCodexJob(jobId, ownerCheck));
						break;
					}
					case "reconcile": {
						const jobId = requireText(params.jobId, "jobId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						job = await withLeaderLease(() => reconcileCodexJobOutcome(jobId, {
							outcome: params.outcome,
							note: requireText(params.note, "note"),
							...ownerCheck,
						}));
						commandReceipt = `Reconciled Codex job ${job.id} as ${job.status}.`;
						break;
					}
					case "missions": {
						const missions = await listOwnedCodexMissions(ctx);
						return {
							content: [{ type: "text", text: formatMissions(missions) }],
							details: { missions },
						};
					}
					default:
						throw new Error(`Unsupported Codex action: ${params.action}`);
				}

				let view = publicJobView(job);
				await registerCodexRuntimeJob(owner.runtime, view);
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
					await registerCodexRuntimeJob(owner.runtime, view);
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
