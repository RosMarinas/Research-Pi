import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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
import {
	getHostCapabilityUiAdapter,
	getRuntimeUiAdapter,
	registerCodexRuntimeAdapter,
} from "../lib/research-runtime-adapters.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_MESSAGE_KIND,
	codexActorId,
	consumeRuntimeMessageForAttachment,
	readRuntimeSnapshot,
	reconcileCodexRuntimeAsks,
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

const ACTIVE_JOB_STATUSES = new Set(["starting", "running", "cancelling"]);

function jobActivityText(job: any): string {
	if (job.currentActivity?.summary) return `now: ${boundedProgress(job.currentActivity.summary)}`;
	if (job.lastActivity?.summary) return `last: ${boundedProgress(job.lastActivity.summary)}`;
	const progress = boundedProgress(job.progress);
	const completedLeaf = ACTIVE_JOB_STATUSES.has(job.status) && (
		/\s·\s(?:completed|failed)$/i.test(progress)
		|| /^(?:command|file changes)\s+(?:completed|failed):/i.test(progress)
	);
	return `${completedLeaf ? "last" : "phase"}: ${progress}`;
}

export function formatCodexJob(job: ReturnType<typeof publicJobView>): string {
	if (job.status === "completed" && job.result) {
		const outcome = job.result.outcome ? ` Delegation outcome=${job.result.outcome}; goal_satisfied=${job.result.goal_satisfied === true}.` : "";
		return `Codex turn ${job.id} completed.${outcome}\n${JSON.stringify(job.result, null, 2)}`;
	}
	if (job.status === "failed" || job.status === "cancelled") {
		return `Codex job ${job.id} ${job.status}: ${job.error ?? job.progress}`;
	}
	if (job.status === "outcome_unknown") {
		return `Codex job ${job.id} has outcome_unknown: side effects may have occurred. Inspect Git and external run state, then use action=reconcile with outcome and an evidence note before starting another executor in this workspace.`;
	}
	if (job.status === "input_required" && job.pendingRequest) {
		const pending = job.pendingRequest;
		return [
			`Codex job ${job.id} paused for input; its worker and current turn remain alive.`,
			`Request id: ${pending.id}`,
			`Question: ${pending.question}`,
			pending.whyBlocking ? `${job.mode === "advisor" ? "Why this matters" : "Why it blocks progress"}: ${pending.whyBlocking}` : undefined,
			pending.options?.length ? `Options: ${pending.options.join(" | ")}` : undefined,
			pending.audience === "user"
				? "This requires a user-owned choice. Ask the user, then answer this exact request; do not cancel or restart the Codex job."
				: `Respond now with codex_delegate action=respond, jobId=${job.id}, requestId=${pending.id}. Do not cancel, restart, or replace this advisor turn.`,
		].filter(Boolean).join("\n");
	}
	return [
		`Codex job ${job.id} is ${job.status}; ${jobActivityText(job)}.`,
		"The Runtime mailbox will deliver its next blocking or terminal event automatically.",
		"Do not call status/result again in this Leader run; end the run and wait for that event.",
	].join(" ");
}

export function codexRuntimeDeliveryDecision({ messageStatus, isIdle, editorHasDraft }: {
	messageStatus: string;
	isIdle: boolean;
	editorHasDraft: boolean;
}): "deliver" | "defer" | "handled" {
	if (messageStatus !== "queued") return "handled";
	return isIdle && !editorHasDraft ? "deliver" : "defer";
}

function inlineCode(value: unknown): string {
	return `\`${String(value ?? "").replaceAll("`", "'")}\``;
}

function resultList(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

export function codexResultPreview(result: any, limit = 420): string {
	const text = String(result?.summary ?? result?.working_synthesis ?? result?.shared_understanding ?? "Codex returned no summary.").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

export function codexResultMarkdown(result: any): string {
	if (!result || typeof result !== "object") return "Codex returned no structured result.";
	const sections: string[] = [];
	const outcome = String(result.outcome ?? "").trim();
	const completionBasis = String(result.completion_basis ?? "").trim();
	if (outcome || completionBasis) {
		sections.push([
			"## Delegation outcome",
			"",
			outcome ? `**${outcome}** · goal satisfied: ${result.goal_satisfied === true ? "yes" : "no"}` : "",
			completionBasis,
		].filter(Boolean).join("\n\n"));
	}
	const summary = String(result.summary ?? "").trim();
	if (summary) sections.push(`## Summary\n\n${summary}`);
	const sharedUnderstanding = String(result.shared_understanding ?? "").trim();
	if (sharedUnderstanding) sections.push(`## Shared understanding\n\n${sharedUnderstanding}`);

	const appendList = (title: string, values: unknown) => {
		const items = resultList(values);
		if (items.length) sections.push(`## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`);
	};
	appendList("Points of agreement", result.points_of_agreement);
	appendList("Candidate explanations", result.candidate_explanations);
	appendList("Evidence", result.evidence);
	appendList("Questions to resolve", result.questions_to_resolve);
	appendList("Actions taken", result.actions_taken);

	const changedFiles = resultList(result.changed_files);
	if (changedFiles.length) sections.push(`## Changed files\n\n${changedFiles.map((path) => `- ${inlineCode(path)}`).join("\n")}`);

	if (Array.isArray(result.checks) && result.checks.length) {
		sections.push([
			"## Checks",
			"",
			...result.checks.map((check: any) => `- ${inlineCode(check?.command)} — ${String(check?.result ?? "").trim()}`),
		].join("\n"));
	}

	if (Array.isArray(result.external_effects) && result.external_effects.length) {
		sections.push([
			"## External effects",
			"",
			...result.external_effects.map((effect: any) => {
				const identity = [effect?.kind, effect?.target, effect?.identifier].filter(Boolean).join(" · ");
				const detail = String(effect?.detail ?? "").trim();
				return `- **${identity || "effect"}**${detail ? ` — ${detail}` : ""}`;
			}),
		].join("\n"));
	}

	appendList("Uncertainties", result.uncertainties);
	appendList("Remaining delegated work", result.remaining_work);
	const workingSynthesis = String(result.working_synthesis ?? "").trim();
	if (workingSynthesis) sections.push(`## Working synthesis\n\n${workingSynthesis}`);
	const next = String(result.recommended_next_step ?? "").trim();
	if (next) sections.push(`## Recommended next step\n\n${next}`);
	const nextExchange = String(result.suggested_next_exchange ?? "").trim();
	if (nextExchange) sections.push(`## Suggested next exchange\n\n${nextExchange}`);
	return sections.join("\n\n") || "Codex returned an empty structured result.";
}

function codexResultCounts(result: any): string {
	return [
		resultList(result?.evidence).length ? `${result.evidence.length} evidence` : "",
		resultList(result?.candidate_explanations).length ? `${result.candidate_explanations.length} candidates` : "",
		resultList(result?.questions_to_resolve).length ? `${result.questions_to_resolve.length} questions` : "",
		Array.isArray(result?.checks) && result.checks.length ? `${result.checks.length} checks` : "",
		resultList(result?.changed_files).length ? `${result.changed_files.length} files` : "",
		resultList(result?.uncertainties).length ? `${result.uncertainties.length} uncertainties` : "",
		resultList(result?.remaining_work).length ? `${result.remaining_work.length} remaining` : "",
	].filter(Boolean).join(" · ");
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
		throw new Error("This Pi Session is no longer the Leader Session; stop this run or explicitly take over before changing Codex work.");
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
	const outcome = job.status === "completed" ? String(job.result?.outcome ?? "") : "";
	const semanticIncomplete = Boolean(outcome && outcome !== "succeeded");
	const icon = job.status === "completed" ? semanticIncomplete ? "!" : "✓" : job.status === "outcome_unknown" ? "!" : job.status === "failed" || job.status === "cancelled" ? "✗" : job.status === "input_required" ? "?" : "⚙";
	const count = activeCount > 1 && !TERMINAL_JOB_STATUSES.has(job.status) ? `${activeCount} running · ` : "";
	const mission = job.mission ? ` · ${boundedProgress(job.mission).slice(0, 36)}` : "";
	const parallel = Number(job.activeActivityCount ?? job.activeActivities?.length ?? 0);
	const activity = parallel > 1 ? `${parallel} parallel activities · /watch` : jobActivityText(job);
	return `${icon} Codex ${count}${job.mode} ${shortJobId(job.id)}${mission} · ${job.status}${outcome ? `/${outcome}` : ""} · ${activity}`;
}

function stableCodexJobs(jobs: CodexJobView[]): CodexJobView[] {
	return [...jobs].sort((left, right) => {
		const leftStarted = String(left.startedAt ?? left.createdAt ?? "");
		const rightStarted = String(right.startedAt ?? right.createdAt ?? "");
		return leftStarted.localeCompare(rightStarted) || String(left.id).localeCompare(String(right.id));
	});
}

export function formatCodexJobsStatus(jobs: CodexJobView[]): string | undefined {
	const active = stableCodexJobs(jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status)));
	if (!active.length) return undefined;
	if (active.length === 1) return formatCodexStatus(active[0]);
	const waiting = active.filter((job) => job.status === "input_required").length;
	const cancelling = active.filter((job) => job.status === "cancelling").length;
	const detail = [waiting ? `${waiting} waiting` : "", cancelling ? `${cancelling} cancelling` : ""].filter(Boolean).join(" · ");
	return `${waiting ? "?" : "⚙"} Codex ${active.length} active${detail ? ` · ${detail}` : ""} · details above editor`;
}

function codexUiProjection(jobs: CodexJobView[]): string {
	return JSON.stringify({
		jobs: stableCodexJobs(jobs).map((job) => ({
			id: job.id,
			status: job.status,
			mode: job.mode,
			mission: job.mission,
			progress: job.progress,
			currentActivity: job.currentActivity,
			activeActivities: job.activeActivities,
			activeActivityCount: job.activeActivityCount,
			lastActivity: job.lastActivity,
			pendingRequest: job.pendingRequest?.id ?? null,
		})),
	});
}

export default function codexDelegateExtension(pi: ExtensionAPI) {
	const EVENT_KIND = "codex-delegation-event";
	const activeJobs = new Map<string, CodexJobView>();
	const monitorTimers = new Map<string, NodeJS.Timeout>();
	const deliveredEvents = new Set<string>();
	const deliveringEvents = new Set<string>();
	const codexReadsUntilExternalEvent = new Set<string>();
	const codexReadToolCalls = new Map<string, string>();
	const capabilityApprovalRequests = new Map<string, Promise<boolean>>();
	let capabilityApprovalQueue: Promise<unknown> = Promise.resolve();
	let latestTerminal: CodexJobView | undefined;
	let shuttingDown = false;
	let lastFooterText: string | undefined;
	let lastDockProjection: string | undefined;

	const releaseCodexReadFuse = (jobId?: string) => {
		if (!jobId) {
			codexReadsUntilExternalEvent.clear();
			codexReadToolCalls.clear();
			return;
		}
		codexReadsUntilExternalEvent.delete(jobId);
		for (const [toolCallId, pendingJobId] of codexReadToolCalls) {
			if (pendingJobId === jobId) codexReadToolCalls.delete(toolCallId);
		}
	};

	const refreshFooter = (ctx: ExtensionContext) => {
		if (shuttingDown) return;
		if (!ctx.hasUI) return;
		const active = stableCodexJobs([...activeJobs.values()]);
		const text = formatCodexJobsStatus(active) ?? (latestTerminal ? formatCodexStatus(latestTerminal) : undefined);
		if (text === lastFooterText) return;
		lastFooterText = text;
		ctx.ui.setStatus("codex_delegate", text);
	};

	const refreshDock = (ctx: ExtensionContext, force = false) => {
		if (shuttingDown) return;
		const jobs = stableCodexJobs([...activeJobs.values()]);
		const projection = codexUiProjection(jobs);
		if (!force && projection === lastDockProjection) return;
		lastDockProjection = projection;
		void getRuntimeUiAdapter()?.refresh(ctx, { codexJobs: jobs }).catch(() => undefined);
	};

	const rememberJob = (job: CodexJobView, ctx: ExtensionContext) => {
		if (shuttingDown) return;
		if (TERMINAL_JOB_STATUSES.has(job.status)) {
			activeJobs.delete(job.id);
			latestTerminal = job;
		} else {
			activeJobs.set(job.id, job);
		}
		refreshFooter(ctx);
		refreshDock(ctx);
	};

	const eventId = (job: CodexJobView): string | undefined => {
		if (job.status === "input_required" && job.pendingRequest?.id) return `${job.id}:request:${job.pendingRequest.id}`;
		if (TERMINAL_JOB_STATUSES.has(job.status)) return `${job.id}:terminal:${job.status}`;
		return undefined;
	};

	const boundedList = (values: unknown, limit = 8): string[] =>
		Array.isArray(values) ? values.slice(0, limit).map((value) => boundedProgress(String(value))) : [];
	const boundedDetailList = (values: unknown, limit: number, itemLimit: number): string[] =>
		Array.isArray(values)
			? values.slice(0, limit).map((value) => {
				const text = String(value ?? "").replace(/\s+/g, " ").trim();
				return text.length <= itemLimit ? text : `${text.slice(0, itemLimit - 3)}...`;
			}).filter(Boolean)
			: [];

	const eventContent = (job: CodexJobView): string => {
		if (job.status === "input_required" && job.pendingRequest) {
			const pending = job.pendingRequest;
			return [
				`Codex delegation ${job.id} is waiting for ${pending.audience === "user" ? "the user" : "Research Pi"}.`,
				`Request id: ${pending.id}`,
				`Question: ${pending.question}`,
				pending.whyBlocking ? `${job.mode === "advisor" ? "Why this matters" : "Why it blocks progress"}: ${pending.whyBlocking}` : undefined,
				pending.options?.length ? `Options: ${pending.options.join(" | ")}` : undefined,
				pending.kind === "host_capability"
					? "Research Pi will open the exact host-capability approval dialog in the attached TUI and return the decision to this same Codex turn."
					: undefined,
				pending.secret
					? "This request is marked secret. Do not ask for or transmit the secret through Pi, model context, codex_delegate, or job files. Ask the user to configure it directly, then continue without echoing it."
					: pending.kind === "host_capability"
						? undefined
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
		const actionsTaken = boundedDetailList(result.actions_taken, 6, 360);
		const changedFiles = boundedDetailList(result.changed_files, 12, 360);
		const externalEffects = Array.isArray(result.external_effects)
			? result.external_effects.slice(0, 6).map((effect: any) => {
				const identity = [effect?.kind, effect?.target, effect?.identifier].filter(Boolean).join(" · ") || "effect";
				const detail = String(effect?.detail ?? "").replace(/\s+/g, " ").trim();
				return `${identity}${detail ? ` — ${detail.slice(0, 500)}` : ""}`;
			})
			: [];
		return [
			`Codex delegation ${job.id} ${job.status}. Pi must inspect this result and decide the next research action; completion alone is not scientific evidence.`,
			`Mode/model: ${job.mode} · ${job.model} · ${job.reasoningEffort}`,
			job.mission ? `Mission: ${job.mission}` : undefined,
			result.outcome ? `Delegation outcome: ${result.outcome} · goal_satisfied=${result.goal_satisfied === true}` : undefined,
			result.completion_basis ? `Completion basis: ${String(result.completion_basis).slice(0, 3000)}` : undefined,
			result.summary ? `Summary: ${String(result.summary).slice(0, 5000)}` : undefined,
			actionsTaken.length ? `Actions taken:\n- ${actionsTaken.join("\n- ")}` : undefined,
			changedFiles.length ? `Changed files:\n- ${changedFiles.join("\n- ")}` : undefined,
			externalEffects.length ? `External effects:\n- ${externalEffects.join("\n- ")}` : undefined,
			boundedList(result.evidence).length ? `Evidence:\n- ${boundedList(result.evidence).join("\n- ")}` : undefined,
			boundedList(result.uncertainties).length ? `Uncertainties:\n- ${boundedList(result.uncertainties).join("\n- ")}` : undefined,
			boundedList(result.remaining_work).length ? `Remaining delegated work:\n- ${boundedList(result.remaining_work).join("\n- ")}` : undefined,
			result.recommended_next_step ? `Recommended next step: ${String(result.recommended_next_step).slice(0, 3000)}` : undefined,
			job.error ? `Error: ${String(job.error).slice(0, 3000)}` : undefined,
			`Use codex_delegate action=result with jobId=${job.id} if the full structured result is needed.`,
		]
			.filter(Boolean)
			.join("\n");
	};

	const consumeCodexRequestMessages = async (
		runtime: Awaited<ReturnType<typeof resolveResearchRuntime>>,
		requestId: string,
		ctx: ExtensionContext,
		attachmentEpoch?: string | null,
	) => {
		const snapshot = await readRuntimeSnapshot(runtime);
		for (const message of snapshot.messages) {
			if (
				message.type !== "ask"
				|| message.relatesTo !== requestId
				|| (message.status !== "queued" && message.status !== "delivered")
			) continue;
			await consumeRuntimeMessageForAttachment(runtime, message.id, {
				sessionId: ctx.sessionManager.getSessionId(),
				actorId: RESEARCH_LEADER_ACTOR_ID,
				attachmentEpoch,
			});
		}
	};

	const resolveHostCapabilityRequest = async (
		job: CodexJobView,
		message: Awaited<ReturnType<typeof recordCodexRuntimeEvent>>,
		runtime: Awaited<ReturnType<typeof resolveResearchRuntime>>,
		attachment: NonNullable<ReturnType<typeof runtimeActorAttachment>>,
		ctx: ExtensionContext,
	): Promise<boolean> => {
		const pending = job.pendingRequest;
		if (!pending?.id || pending.kind !== "host_capability") return false;
		const existing = capabilityApprovalRequests.get(pending.id);
		if (existing) return await existing;

		const run = async () => {
			const adapter = getHostCapabilityUiAdapter();
			if (!adapter?.review || !ctx.hasUI) return false;
			let decision;
			try {
				decision = await adapter.review({ job, pendingRequest: pending, ctx });
			} catch (error) {
				if (!shuttingDown && ctx.hasUI) {
					ctx.ui.notify(`Could not open Codex host approval: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				return false;
			}
			if (decision?.status === "unsupported" || decision?.status === "unavailable") return false;
			if (shuttingDown) return false;
			const approved = decision?.status === "approved";
			const grantId = approved ? decision.grant?.id : undefined;
			const ownerCheck = await jobManagementScope(ctx, job.id);
			await withRuntimeActorAttachment(
				runtime,
				RESEARCH_LEADER_ACTOR_ID,
				{
					sessionId: ctx.sessionManager.getSessionId(),
					attachmentEpoch: attachment.epoch,
				},
				() => respondToCodexJob(job.id, {
					requestId: pending.id,
					response: approved
						? `Research Pi user approved host capability ${grantId}. Continue the same tool call.`
						: "Research Pi user denied the requested host capability. Do not retry or bypass it.",
					...ownerCheck,
				}),
			);
			if (message?.status === "queued") {
				await settleRuntimeMessage(runtime, message.id, "delivered", {
					sessionId: ctx.sessionManager.getSessionId(),
					actorId: RESEARCH_LEADER_ACTOR_ID,
					attachmentEpoch: attachment.epoch,
				});
			}
			await consumeCodexRequestMessages(runtime, pending.id, ctx, attachment.epoch);
			if (!shuttingDown && ctx.hasUI) {
				ctx.ui.notify(
					approved
						? `Approved ${grantId}; Codex ${shortJobId(job.id)} is resuming automatically.`
						: `Denied host capability request from Codex ${shortJobId(job.id)}; the same turn will receive the denial.`,
					approved ? "warning" : "info",
				);
			}
			return true;
		};

		const queued = capabilityApprovalQueue.then(run, run);
		capabilityApprovalQueue = queued.catch(() => undefined);
		capabilityApprovalRequests.set(pending.id, queued);
		try {
			return await queued;
		} finally {
			if (capabilityApprovalRequests.get(pending.id) === queued) capabilityApprovalRequests.delete(pending.id);
		}
	};

	const deliverJobEvent = async (job: CodexJobView, ctx: ExtensionContext): Promise<"handled" | "deferred"> => {
		if (shuttingDown) return "handled";
		const id = eventId(job);
		if (!id || deliveredEvents.has(id)) return "handled";
		if (deliveringEvents.has(id)) return "deferred";
		deliveringEvents.add(id);
		try {
			const runtime = await resolveResearchRuntime(ctx.cwd);
			if (shuttingDown) return "handled";
			await reconcileCodexRuntimeAsks(runtime, job);
			const message = await recordCodexRuntimeEvent(runtime, job, eventContent(job));
			if (shuttingDown) return "handled";
			if (!message) {
				deliveredEvents.add(id);
				return "handled";
			}
			const snapshot = await readRuntimeSnapshot(runtime);
			if (shuttingDown) return "handled";
			if (runtimeSessionInheritancePolicy(ctx.sessionManager.getBranch(), snapshot, ctx.sessionManager.getSessionId()) === "clean") {
				// The durable Runtime mailbox now owns delivery. Mark the watcher event
				// handled so a clean Session does not repeatedly re-project the same job.
				deliveredEvents.add(id);
				return "handled";
			}
			const attachment = runtimeActorAttachment(
				snapshot,
				RESEARCH_LEADER_ACTOR_ID,
				ctx.sessionManager.getSessionId(),
			);
			if (!attachment) return "handled";
			if (await resolveHostCapabilityRequest(job, message, runtime, attachment, ctx)) {
				deliveredEvents.add(id);
				return "handled";
			}
			const editorHasDraft = ctx.hasUI && Boolean(ctx.ui.getEditorText?.().trim());
			const decision = codexRuntimeDeliveryDecision({
				messageStatus: message.status,
				isIdle: ctx.isIdle(),
				editorHasDraft,
			});
			if (decision === "handled") {
				deliveredEvents.add(id);
				return "handled";
			}
			// Keep the durable mailbox entry queued while the Leader is running or
			// editing. Re-read it before delivery so an ask answered through an
			// explicit result/respond path cannot arrive later as a stale follow-up.
			if (decision === "defer") return "deferred";
			try {
				const adapter = getRuntimeUiAdapter();
				if (!adapter?.deliver) return "deferred";
				const delivered = await adapter.deliver(ctx, { messageId: message.id });
				if (delivered === "deferred") return "deferred";
				if (delivered === "delivered") {
					// A genuinely new mailbox event is the boundary that permits one
					// fresh status/result read for this job.
					releaseCodexReadFuse(job.id);
				}
			} catch (error) {
				if (!shuttingDown && ctx.hasUI) ctx.ui.notify(`Could not deliver Codex event: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return "deferred";
			}
			if (shuttingDown) return "handled";
			deliveredEvents.add(id);
			return "handled";
		} finally {
			deliveringEvents.delete(id);
		}
	};

	const monitorJob = (initial: CodexJobView, ctx: ExtensionContext) => {
		if (shuttingDown) return;
		rememberJob(initial, ctx);
		void deliverJobEvent(initial, ctx).then((disposition) => {
			if (disposition !== "deferred" || shuttingDown || monitorTimers.has(initial.id)) return;
			const timer = setTimeout(() => {
				monitorTimers.delete(initial.id);
				monitorJob(initial, ctx);
			}, 750);
			timer.unref();
			monitorTimers.set(initial.id, timer);
		}).catch((error) => {
			if (!shuttingDown && ctx.hasUI) ctx.ui.notify(`Could not persist Codex Runtime event: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
		if (TERMINAL_JOB_STATUSES.has(initial.status) || monitorTimers.has(initial.id)) return;

		const poll = async () => {
			if (shuttingDown) return;
			try {
				const current = publicJobView(await readCodexJob(initial.id, await jobManagementScope(ctx, initial.id)));
				if (shuttingDown) {
					monitorTimers.delete(initial.id);
					return;
				}
				rememberJob(current, ctx);
				const delivery = await deliverJobEvent(current, ctx);
				if (shuttingDown) {
					monitorTimers.delete(initial.id);
					return;
				}
				if (TERMINAL_JOB_STATUSES.has(current.status) && delivery === "handled") {
					monitorTimers.delete(current.id);
					return;
				}
			} catch (error) {
				if (shuttingDown) {
					monitorTimers.delete(initial.id);
					return;
				}
				if (isCodexJobOwnerError(error)) {
					monitorTimers.delete(initial.id);
					activeJobs.delete(initial.id);
					refreshFooter(ctx);
					refreshDock(ctx);
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

			if (shuttingDown) {
				monitorTimers.delete(initial.id);
				return;
			}
			const timer = setTimeout(poll, 750);
			timer.unref();
			monitorTimers.set(initial.id, timer);
		};

		const timer = setTimeout(poll, 250);
		timer.unref();
		monitorTimers.set(initial.id, timer);
	};

	const resetMonitors = (ctx: ExtensionContext, options: { refreshRuntime?: boolean } = {}) => {
		for (const timer of monitorTimers.values()) clearTimeout(timer);
		monitorTimers.clear();
		activeJobs.clear();
		latestTerminal = undefined;
		lastFooterText = undefined;
		lastDockProjection = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("codex_delegate", undefined);
		if (options.refreshRuntime !== false) {
			void getRuntimeUiAdapter()?.refresh(ctx, { codexJobs: [] }).catch(() => undefined);
		}
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
			if (!shuttingDown && ctx.hasUI) ctx.ui.notify(`Could not reattach Codex jobs: ${error instanceof Error ? error.message : String(error)}`, "warning");
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
				const requestId = latest.pendingRequest.id;
				const queued = await withLeaderLease(() => respondToCodexJob(latest.id, {
					requestId,
					response: message.body,
					...ownerCheck,
				}));
				nextJob = queued.job;
				await consumeCodexRequestMessages(owner.runtime, requestId, ctx, owner.attachmentEpoch);
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
		releaseCodexReadFuse();
		await reattachBranchJobs(ctx);
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") releaseCodexReadFuse();
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "codex_delegate") return;
		const action = String(event.input?.action ?? "");
		if (action !== "status" && action !== "result") return;
		const jobId = String(event.input?.jobId ?? "");
		if (!jobId) return;
		if (codexReadsUntilExternalEvent.has(jobId) || [...codexReadToolCalls.values()].includes(jobId)) {
			return {
				block: true,
				reason: `Repeated Codex polling suppressed for ${jobId}. Its Runtime mailbox notification is already armed; end this Leader run and wait for the next blocking or terminal event.`,
				terminate: true,
			};
		}
		codexReadToolCalls.set(event.toolCallId, jobId);
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "codex_delegate") return;
		const pendingJobId = codexReadToolCalls.get(event.toolCallId);
		codexReadToolCalls.delete(event.toolCallId);
		if (event.isError) return;
		const details = event.details as CodexJobView | undefined;
		const action = String(event.input?.action ?? "");
		if (
			details?.id
			&& (details.autoNotify !== false || action === "respond")
			&& !TERMINAL_JOB_STATUSES.has(details.status)
		) {
			codexReadsUntilExternalEvent.add(details.id);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		await reattachBranchJobs(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		resetMonitors(ctx, { refreshRuntime: false });
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
			"Delegate bounded operational work to a context-isolated local Codex executor, or open a read-only collaborative research consultation with Codex.",
			`Configured defaults: advisor ${defaultCodexModel("advisor")}/${defaultCodexReasoningEffort("advisor")}; executor ${defaultCodexModel("executor")}/${defaultCodexReasoningEffort("executor")}.`,
			"Executor jobs run automatically inside the current project boundary. They may edit/delete files, freely commit, use public network, and run expensive experiments. Exact user-approved external-read, SSH-target, or fixed-script capabilities are available through an opaque host broker; raw credentials never enter Codex.",
			"Pi remains responsible for framing the research question, judging evidence, and choosing the next research action.",
			"Give related work a stable mission label and use reuse=auto to continue its exact Codex Actor thread across Pi sessions in this project workspace; use action=missions to inspect project mission threads.",
			"Use action=status/result/cancel/resume/respond/steer with the returned job id; Actor-owned jobs remain bound to the exact project workspace but are not owned by one Pi conversation.",
			"If an executor loses its worker after execution started, it stops at outcome_unknown. Inspect Git and external run state, then use action=reconcile; the harness blocks another writer until this is resolved.",
			"Background completion and blocking requests enter the project Runtime mailbox and are delivered to the currently attached Leader Session. respond answers an explicit request; steer corrects an active turn without restarting it.",
		].join(" "),
		promptSnippet: "Delegate long operational work or collaboratively clarify a research question with Codex",
		promptGuidelines: [
			"Use codex_delegate when a bounded execution task would require many tools or produce enough intermediate output to pollute the research context; delegation is for context isolation, not automatic parallelism.",
			"For executor delegation, state a concrete objective and observable success criteria.",
			"For advisor consultation, start from the research uncertainty: provide relevant observations, current tentative understanding, and important unknowns. Task-style success criteria are not required. Send only relevant research context; do not copy the full conversation or ask Codex to decide the research objective.",
			"Treat advisor consultation as a continuation of inquiry, not an automatic review or approval gate. Let the advisor reconstruct or question the framing when useful, then clarify, expand, distinguish, synthesize, or challenge ideas in proportion to their maturity. Use explicit critique, verdict, or adjudication language only when the object is actually ready for stress-testing; do not demand premature closure or a complete judgment in one turn.",
			"Use a stable mission label for consecutive work on one research subtask and reuse=auto. The mission is a project Codex Actor and survives Pi session rotation. Continue the same advisor mission while jointly refining one question; start a fresh mission for a different research route, a different workspace, or substantially stale assumptions.",
			"Use mode=executor when Codex should actually complete the work. It has standing authority for destructive, long-running, and expensive steps inside the current project and should not be micromanaged command by command.",
			"If Codex needs an unapproved outside path, SSH target, or host command, its structured request opens the Pi TUI approval dialog automatically. Do not ask the user to manufacture or return a grant id, and do not disguise the operation as a new delegation.",
			"Use mode=advisor when the research question is immature or Pi would benefit from clarification, focused questions, competing explanations, or collaborative synthesis. Advisor is read-only, should not default to opposition or verdicts, and still uses max reasoning by default.",
			"After retrieving a result, inspect its evidence and validity limitations. Codex completion does not by itself establish a scientific conclusion.",
			"Treat job status=completed as App Server lifecycle only. For executor work, outcome=succeeded with goal_satisfied=true means the delegated objective completed; partial, blocked, or failed should be handled explicitly rather than described as success.",
			"Never guess an outcome_unknown resolution. Reconcile only after inspecting the relevant Git state, files, remote runs, or other external effects, and record that evidence in note.",
			"When a Codex request arrives, answer it promptly with action=respond if Pi can decide. Ask the user only for user-owned choices or direct credential setup. Never place secrets in a response.",
			"A synchronous advisor returns input_required instead of blocking the Leader tool call. Treat it as the same live consultation: answer the exact jobId/requestId with action=respond, never by cancelling or starting a replacement advisor.",
			"After a background job or resumed advisor returns a nonterminal state, end the current Leader run. Runtime delivers the next blocking or terminal event; repeated status/result reads are suppressed until a real external event arrives.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",
		renderCall(args, theme) {
			const mode = args.mode ?? "executor";
			const target = args.jobId ? shortJobId(args.jobId) : args.mission ?? mode;
			const task = args.task ?? args.followUp ?? args.message ?? "";
			const preview = task ? codexResultPreview({ summary: task }, 100) : "";
			return new Text([
				`${theme.fg("toolTitle", theme.bold("Codex"))} ${theme.fg("accent", args.action)} ${theme.fg("muted", `· ${target}`)}`,
				preview ? theme.fg("dim", `  ${preview}`) : "",
			].filter(Boolean).join("\n"), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as CodexJobView | { missions?: unknown[] } | undefined;
			if (!details || !("id" in details)) {
				const content = result.content.find((item) => item.type === "text");
				return new Text(content?.type === "text" ? content.text : "Codex returned no result.", 0, 0);
			}

			const job = details as CodexJobView;
			const container = new Container();
			const terminal = TERMINAL_JOB_STATUSES.has(job.status);
			const outcome = job.status === "completed" ? String(job.result?.outcome ?? "") : "";
			const semanticIncomplete = Boolean(outcome && outcome !== "succeeded");
			const icon = job.status === "completed"
				? theme.fg(semanticIncomplete ? "warning" : "success", semanticIncomplete ? "!" : "✓")
				: job.status === "input_required" || job.status === "outcome_unknown"
					? theme.fg("warning", job.status === "input_required" ? "?" : "!")
					: job.status === "failed" || job.status === "cancelled"
						? theme.fg("error", "✗")
						: theme.fg("accent", "●");
			container.addChild(new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(`Codex ${job.mode}`))} ${theme.fg("accent", shortJobId(job.id))} ${theme.fg(terminal ? "muted" : "warning", `· ${job.status}${outcome ? `/${outcome}` : ""}`)}`,
				0,
				0,
			));
			container.addChild(new Text(
				theme.fg("dim", [job.mission, job.model, job.reasoningEffort].filter(Boolean).join(" · ")),
				0,
				0,
			));

			if (job.result) {
				container.addChild(new Spacer(1));
				if (expanded) {
					container.addChild(new Markdown(codexResultMarkdown(job.result), 0, 0, getMarkdownTheme()));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "Ctrl+O collapses · /watch for objective execution events"), 0, 0));
				} else {
					container.addChild(new Text(codexResultPreview(job.result), 0, 0));
					const counts = codexResultCounts(job.result);
					if (counts) container.addChild(new Text(theme.fg("muted", counts), 0, 0));
					container.addChild(new Text(theme.fg("dim", "Ctrl+O expands the structured Codex response"), 0, 0));
				}
				return container;
			}

			const message = job.status === "failed" || job.status === "cancelled"
				? job.error ?? job.progress
				: job.status === "outcome_unknown"
					? "Side effects may have occurred; inspect external state before reconciliation."
					: job.status === "input_required" && job.pendingRequest
						? job.pendingRequest.question
						: jobActivityText(job);
			container.addChild(new Text(theme.fg(job.status === "failed" ? "error" : "muted", String(message ?? "waiting")), 0, 0));
			if (isPartial) container.addChild(new Text(theme.fg("dim", "Codex is still running..."), 0, 0));
			return container;
		},

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
							commandReceipt = job.threadRefresh
								? `Refreshed legacy Codex thread for mission "${reusable.mission}" as ${job.id}; the same Actor now has the current Research Pi tools.`
								: `Resumed Codex mission "${reusable.mission}" from job ${reusable.id} as ${job.id}.`;
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
						if (job.threadRefresh) {
							commandReceipt = `Refreshed legacy Codex thread from job ${jobId} as ${job.id}; the same mission Actor now has the current Research Pi tools.`;
						}
						ownerCheck = projectOwnerCheck;
						effectiveBackground = params.background ?? job.autoNotify ?? (job.mode === "executor");
						break;
					}
					case "respond": {
						const jobId = requireText(params.jobId, "jobId");
						const requestId = requireText(params.requestId, "requestId");
						ownerCheck = await jobManagementScope(ctx, jobId);
						const queued = await withLeaderLease(() => respondToCodexJob(jobId, {
							requestId,
							response: params.response,
							answers: params.answers,
							...ownerCheck,
						}));
						job = queued.job;
						await consumeCodexRequestMessages(owner.runtime, requestId, ctx, owner.attachmentEpoch);
						commandReceipt = `Response queued for Codex request ${requestId} in job ${job.id}.`;
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
						returnOnInputRequired: (current) => current.pendingRequest?.kind !== "host_capability" || !ctx.hasUI,
						onUpdate: (current) => {
							const currentView = publicJobView(current);
							rememberJob(currentView, ctx);
							if (currentView.status === "input_required" && currentView.pendingRequest?.kind === "host_capability") {
								void deliverJobEvent(currentView, ctx).catch((error) => {
									if (!shuttingDown && ctx.hasUI) ctx.ui.notify(`Could not deliver Codex request: ${error instanceof Error ? error.message : String(error)}`, "warning");
								});
							}
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
					if (view.status === "input_required") {
						await deliverJobEvent(view, ctx);
						monitorJob(view, ctx);
					}
				} else if (!TERMINAL_JOB_STATUSES.has(view.status)) {
					monitorJob(view, ctx);
				}

				return {
					content: [{
						type: "text",
						text: commandReceipt && TERMINAL_JOB_STATUSES.has(view.status)
							? `${commandReceipt}\n${formatCodexJob(view)}`
							: commandReceipt ?? formatCodexJob(view),
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
