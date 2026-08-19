import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { CodexActivityCursor, projectCodexAgents } from "../lib/codex-activity.mjs";
import {
	DEFAULT_CODEX_JOB_ROOT,
	isCodexJobOwnerError,
	listCodexJobs,
	publicJobView,
	readCodexJob,
} from "../lib/codex-jobs.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	resolveResearchRuntime,
	runtimeActorTarget,
} from "../lib/research-runtime.mjs";
import { registerCodexWatchAdapter } from "../lib/research-runtime-adapters.mjs";

const ACTIVE_STATUSES = new Set(["starting", "running", "input_required", "cancelling"]);
const VIEW_MODES = ["overview", "activity", "agents"] as const;
const REFRESH_MS = 1000;

type CodexJobView = ReturnType<typeof publicJobView>;
type ViewMode = (typeof VIEW_MODES)[number];

function compact(value: unknown, limit = 220): string {
	const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	if (!text) return "";
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function shortId(value: unknown, length = 8): string {
	const text = String(value ?? "");
	return text.length <= length ? text : text.slice(-length);
}

function actorTarget(job: CodexJobView): string {
	if (!job.actorId) return `job:${shortId(job.id)}`;
	return runtimeActorTarget({ id: job.actorId, kind: "codex" });
}

function elapsed(job: CodexJobView, currentTime = Date.now()): string {
	const started = Date.parse(job.startedAt ?? job.createdAt ?? "");
	const finished = job.finishedAt ? Date.parse(job.finishedAt) : currentTime;
	if (!Number.isFinite(started) || !Number.isFinite(finished)) return "?";
	const seconds = Math.max(0, Math.floor((finished - started) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m${String(remainder).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function eventTime(value: unknown): string {
	const date = new Date(String(value ?? ""));
	if (!Number.isFinite(date.getTime())) return "--:--:--";
	return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusIcon(status: unknown): string {
	if (["completed", "success"].includes(String(status))) return "✓";
	if (status === "outcome_unknown") return "!";
	if (["failed", "errored", "declined"].includes(String(status))) return "✗";
	if (["cancelled", "interrupted", "cancelling"].includes(String(status))) return "■";
	if (status === "input_required") return "?";
	return "●";
}

function activityIcon(category: unknown): string {
	switch (category) {
		case "command": return "$";
		case "file": return "Δ";
		case "tool": return "◆";
		case "search": return "⌕";
		case "subagent": return "◇";
		case "error": return "!";
		default: return "·";
	}
}

function activityOutputLine(event: any): string | null {
	if (!event?.outputTail) return null;
	const lines = String(event.outputTail).split(/\r?\n/).map((line) => compact(line, 260)).filter(Boolean);
	const tail = lines.at(-1);
	if (!tail) return null;
	return `             ↳ ${event.exitCode === null || event.exitCode === undefined ? "" : `exit ${event.exitCode} · `}${tail}`;
}

function eventLines(events: any[], maxLines: number): string[] {
	const lines: string[] = [];
	for (const event of [...events].reverse()) {
		const block = [`${eventTime(event.timestamp)}  ${activityIcon(event.category)}  ${compact(event.summary, 300)}`];
		const output = activityOutputLine(event);
		if (output) block.push(output);
		if (lines.length + block.length > maxLines) {
			if (lines.length === 0) lines.unshift(block[0]!);
			break;
		}
		lines.unshift(...block);
	}
	return lines;
}

function findInitialJobIndex(jobs: CodexJobView[], selector: string): number {
	const normalized = selector.trim().replace(/^@/, "").toLowerCase();
	if (normalized) {
		const match = jobs.findIndex((job) => {
			const labels = [job.id, shortId(job.id), job.mission, actorTarget(job), `@${actorTarget(job)}`]
				.filter(Boolean)
				.map((value) => String(value).toLowerCase());
			return labels.some((value) => value === normalized || value.includes(normalized));
		});
		if (match >= 0) return match;
	}
	const active = jobs.findIndex((job) => ACTIVE_STATUSES.has(job.status));
	return active >= 0 ? active : 0;
}

function sortJobs(jobs: CodexJobView[]): CodexJobView[] {
	return [...jobs].sort((left, right) => {
		const activeOrder = Number(ACTIVE_STATUSES.has(right.status)) - Number(ACTIVE_STATUSES.has(left.status));
		if (activeOrder !== 0) return activeOrder;
		return Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "");
	});
}

async function visibleCodexJobs(ctx: ExtensionCommandContext): Promise<CodexJobView[]> {
	const runtime = await resolveResearchRuntime(ctx.cwd);
	const sessionId = ctx.sessionManager.getSessionId();
	const branchEntryIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
	const [projectJobs, legacyJobs] = await Promise.all([
		listCodexJobs({ cwd: ctx.cwd, projectKey: runtime.projectKey, leaderActorId: RESEARCH_LEADER_ACTOR_ID }),
		listCodexJobs({ cwd: ctx.cwd, leaderSessionId: sessionId, branchEntryIds, legacyOnly: true }),
	]);
	return sortJobs(
		[...new Map([...projectJobs, ...legacyJobs].map((job) => [job.id, publicJobView(job)])).values()],
	);
}

function jobOwnerCheck(ctx: ExtensionCommandContext, runtime: Awaited<ReturnType<typeof resolveResearchRuntime>>, job: CodexJobView) {
	if (job.leaderActorId) {
		return {
			expectedCwd: ctx.cwd,
			expectedProjectKey: runtime.projectKey,
			expectedLeaderActorId: RESEARCH_LEADER_ACTOR_ID,
		};
	}
	return {
		expectedCwd: ctx.cwd,
		expectedLeaderSessionId: ctx.sessionManager.getSessionId(),
		expectedBranchEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
	};
}

class CodexWatchOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private ctx: ExtensionCommandContext;
	private runtime: Awaited<ReturnType<typeof resolveResearchRuntime>>;
	private jobs: CodexJobView[];
	private selected: number;
	private modeIndex = 0;
	private eventsByJob = new Map<string, any[]>();
	private cursors = new Map<string, CodexActivityCursor>();
	private refreshTimer: NodeJS.Timeout | undefined;
	private refreshing = false;
	private closed = false;
	private error: string | undefined;
	private renderFingerprint = "";

	constructor(
		tui: TUI,
		theme: Theme,
		done: () => void,
		ctx: ExtensionCommandContext,
		runtime: Awaited<ReturnType<typeof resolveResearchRuntime>>,
		jobs: CodexJobView[],
		selected: number,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.ctx = ctx;
		this.runtime = runtime;
		this.jobs = jobs;
		this.selected = Math.max(0, Math.min(selected, jobs.length - 1));
		void this.refresh();
		this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
		this.refreshTimer.unref();
	}

	private currentJob(): CodexJobView {
		return this.jobs[this.selected]!;
	}

	private cursor(jobId: string): CodexActivityCursor {
		let cursor = this.cursors.get(jobId);
		if (!cursor) {
			cursor = new CodexActivityCursor(join(DEFAULT_CODEX_JOB_ROOT, jobId, "events.jsonl"));
			this.cursors.set(jobId, cursor);
		}
		return cursor;
	}

	private async refresh() {
		if (this.closed || this.refreshing || this.jobs.length === 0) return;
		this.refreshing = true;
		try {
			const existing = this.currentJob();
			const current = publicJobView(await readCodexJob(existing.id, jobOwnerCheck(this.ctx, this.runtime, existing)));
			const currentIndex = this.jobs.findIndex((job) => job.id === existing.id);
			if (currentIndex >= 0) this.jobs[currentIndex] = current;
			const events = await this.cursor(current.id).poll();
			this.eventsByJob.set(current.id, events);
			const last = events.at(-1);
			const fingerprint = JSON.stringify([
				current.id,
				current.status,
				current.progress,
				current.lastActivityAt,
				current.pendingRequest?.id ?? null,
				events.length,
				last?.timestamp ?? null,
				last?.summary ?? null,
			]);
			const changed = fingerprint !== this.renderFingerprint || this.error !== undefined;
			this.renderFingerprint = fingerprint;
			this.error = undefined;
			if (changed) this.tui.requestRender();
		} catch (error) {
			if (isCodexJobOwnerError(error)) this.close();
			else {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.error) {
					this.error = message;
					this.tui.requestRender();
				}
			}
		} finally {
			this.refreshing = false;
		}
	}

	private changeJob(delta: number) {
		if (this.jobs.length <= 1) return;
		this.selected = (this.selected + delta + this.jobs.length) % this.jobs.length;
		void this.refresh();
		this.tui.requestRender();
	}

	private changeMode(delta = 1) {
		this.modeIndex = (this.modeIndex + delta + VIEW_MODES.length) % VIEW_MODES.length;
		this.tui.requestRender();
	}

	private close() {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
		this.done();
	}

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
		else if (matchesKey(data, "tab") || matchesKey(data, "down")) this.changeMode(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "up")) this.changeMode(-1);
		else if (matchesKey(data, "left")) this.changeJob(-1);
		else if (matchesKey(data, "right")) this.changeJob(1);
		else if (data === "r") void this.refresh();
	}

	private box(lines: string[], width: number, title: string): string[] {
		const th = this.theme;
		const inner = Math.max(20, width - 2);
		const cleanTitle = truncateToWidth(` ${title} `, inner);
		const titleWidth = visibleWidth(cleanTitle);
		const left = "─".repeat(Math.max(0, Math.floor((inner - titleWidth) / 2)));
		const right = "─".repeat(Math.max(0, inner - titleWidth - left.length));
		const pad = (line: string) => {
			const clipped = truncateToWidth(line, inner, "...", true);
			return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		};
		return [
			th.fg("borderMuted", `╭${left}`) + th.fg("customMessageLabel", th.bold(cleanTitle)) + th.fg("borderMuted", `${right}╮`),
			...lines.map((line) => th.fg("borderMuted", "│") + pad(line) + th.fg("borderMuted", "│")),
			th.fg("borderMuted", `╰${"─".repeat(inner)}╯`),
		];
	}

	private overviewLines(job: CodexJobView, events: any[]): string[] {
		const th = this.theme;
		const agents = projectCodexAgents(events);
		const counts = new Map<string, number>();
		for (const event of events) counts.set(event.category, (counts.get(event.category) ?? 0) + 1);
		return [
			` ${th.fg("dim", "Progress")}  ${compact(job.progress, 500) || "waiting for the first App Server event"}`,
			` ${th.fg("dim", "Observed")}  ${events.length} events · ${counts.get("command") ?? 0} commands · ${counts.get("file") ?? 0} file changes · ${agents.length} subagents`,
			"",
			` ${th.fg("dim", "Recent objective activity")}`,
			...eventLines(events, 6).map((line) => ` ${line}`),
			...(events.length ? [] : [` ${th.fg("dim", "No objective execution event has been recorded yet.")}`]),
		];
	}

	private activityLines(events: any[]): string[] {
		const th = this.theme;
		return [
			` ${th.fg("dim", "Command, file, tool, search, lifecycle and subagent events")}`,
			"",
			...eventLines(events, 9).map((line) => ` ${line}`),
			...(events.length ? [] : [` ${th.fg("dim", "No objective execution event has been recorded yet.")}`]),
		];
	}

	private agentLines(events: any[]): string[] {
		const th = this.theme;
		const agents = projectCodexAgents(events);
		const lines = [` ${th.fg("dim", "Codex-internal subagents observed for this Action")}`, ""];
		for (const agent of agents.slice(0, 5)) {
			const model = [agent.model, agent.reasoningEffort].filter(Boolean).join("/");
			lines.push(` ${statusIcon(agent.status)} ${shortId(agent.threadId, 12)} · ${agent.path ?? "subagent"} · ${agent.status ?? agent.activity ?? "observed"}${model ? ` · ${model}` : ""}`);
			if (agent.message) lines.push(`     ${th.fg("dim", compact(agent.message, 300))}`);
			else if (agent.prompt) lines.push(`     ${th.fg("dim", compact(agent.prompt, 300))}`);
		}
		if (!agents.length) lines.push(` ${th.fg("dim", "No internal subagent has been observed.")}`);
		return lines;
	}

	render(width: number): string[] {
		const th = this.theme;
		const job = this.currentJob();
		const events = this.eventsByJob.get(job.id) ?? [];
		const mode: ViewMode = VIEW_MODES[this.modeIndex]!;
		const selectedMode = VIEW_MODES.map((candidate) => candidate === mode ? th.fg("accent", th.bold(`[${candidate}]`)) : th.fg("dim", candidate)).join("  ");
		const stateColor = ["failed", "cancelled"].includes(job.status) ? "error" : job.status === "completed" ? "success" : ["input_required", "outcome_unknown"].includes(job.status) ? "warning" : "accent";
		const title = `◈ CODEX WATCH ${this.selected + 1}/${this.jobs.length}`;
		const mission = compact(job.mission ?? "unlabelled", 90);
		const header = [
			` ${th.fg(stateColor as any, `${statusIcon(job.status)} ${job.status}`)} · ${th.fg("accent", mission)} · ${job.mode} · ${elapsed(job)}`,
			` ${th.fg("dim", `@${actorTarget(job)} · job ${shortId(job.id)} · ${job.model}/${job.reasoningEffort}`)}`,
			` ${selectedMode}`,
			"",
		];
		const body = mode === "overview" ? this.overviewLines(job, events) : mode === "activity" ? this.activityLines(events) : this.agentLines(events);
		const footer = [
			"",
			...(this.error ? [` ${th.fg("error", compact(this.error, 300))}`] : []),
			` ${th.fg("dim", "←/→ Action · Tab/↑/↓ view · r refresh · q/Esc close")}`,
		];
		return this.box([...header, ...body, ...footer], width, title);
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}

export async function openCodexWatch(ctx: ExtensionCommandContext, selector = ""): Promise<void> {
	try {
		const jobs = await visibleCodexJobs(ctx);
		if (!jobs.length) {
			ctx.ui.notify("No Codex Action exists in this project workspace.", "info");
			return;
		}
		const runtime = await resolveResearchRuntime(ctx.cwd);
		const selected = findInitialJobIndex(jobs, selector);
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => new CodexWatchOverlay(tui, theme, done, ctx, runtime, jobs, selected),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%", margin: 1 },
			},
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function codexWatchExtension(pi: ExtensionAPI) {
	registerCodexWatchAdapter({ open: openCodexWatch });
	pi.registerCommand("watch", {
		description: "Watch objective Codex execution; switch Actions with arrows and views with Tab",
		handler: async (args, ctx) => openCodexWatch(ctx, args),
	});
}
