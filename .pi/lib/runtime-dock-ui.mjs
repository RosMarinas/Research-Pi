import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ACTIVE = new Set(["starting", "running", "cancelling"]);
export const RUNTIME_DOCK_CLOCK_MS = 1_000;

function shortId(value, length = 8) {
	const text = String(value ?? "");
	return text.length <= length ? text : text.slice(-length);
}

function inline(value, limit = 100) {
	const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function elapsed(value, currentTime = Date.now()) {
	const started = Date.parse(String(value ?? ""));
	if (!Number.isFinite(started)) return "";
	const seconds = Math.max(0, Math.floor((currentTime - started) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function pad(line, width) {
	const clipped = truncateToWidth(line, width, "…", true);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function liveJobs(jobs = []) {
	return [...jobs]
		.filter((job) => ACTIVE.has(job.status) || job.status === "input_required")
		.sort((left, right) => {
			const leftStarted = String(left.startedAt ?? left.createdAt ?? "");
			const rightStarted = String(right.startedAt ?? right.createdAt ?? "");
			return leftStarted.localeCompare(rightStarted) || String(left.id).localeCompare(String(right.id));
		});
}

export function runtimeDockNeedsClock(jobs = []) {
	return liveJobs(jobs).length > 0;
}

export function createRuntimeDockClock(requestRender, options = {}) {
	const schedule = options.setInterval ?? setInterval;
	const cancel = options.clearInterval ?? clearInterval;
	const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
		? options.intervalMs
		: RUNTIME_DOCK_CLOCK_MS;
	let timer;
	return {
		setActive(active) {
			if (!active) {
				if (timer !== undefined) cancel(timer);
				timer = undefined;
				return;
			}
			if (timer !== undefined) return;
			timer = schedule(() => requestRender(), intervalMs);
			timer?.unref?.();
		},
		isActive() {
			return timer !== undefined;
		},
		stop() {
			this.setActive(false);
		},
	};
}

function jobStateLabel(status) {
	return String(status ?? "unknown").replaceAll("_", " ").toUpperCase();
}

function jobActivityLabel(job) {
	const parallel = Number(job.activeActivityCount ?? job.activeActivities?.length ?? 0);
	if (parallel > 1) return `parallel: ${parallel} active activities`;
	if (job.currentActivity?.summary) return `now: ${inline(job.currentActivity.summary, 92)}`;
	if (job.lastActivity?.summary) return `last: ${inline(job.lastActivity.summary, 92)}`;
	const progress = inline(job.progress || job.mission, 92);
	if (!progress) return "";
	const looksLikeCompletedLeaf = ACTIVE.has(job.status) && (
		/\s·\s(?:completed|failed)$/i.test(progress)
		|| /^(?:command|file changes)\s+(?:completed|failed):/i.test(progress)
	);
	return `${looksLikeCompletedLeaf ? "last" : "phase"}: ${progress}`;
}

function jobLine(job, th) {
	const jobElapsed = elapsed(job.startedAt ?? job.createdAt);
	const jobDetail = jobActivityLabel(job);
	return `${th.fg(job.status === "input_required" ? "warning" : "accent", job.status === "input_required" ? "?" : "●")} ${job.mode ?? "codex"} ${shortId(job.id)} · ${jobStateLabel(job.status)}${jobElapsed ? ` ${jobElapsed}` : ""}${jobDetail ? ` · ${jobDetail}` : ""}`;
}

function activityLines(jobs, th, limit = 4) {
	const lines = [];
	let hidden = 0;
	for (const job of jobs) {
		const activities = Array.isArray(job.activeActivities) ? job.activeActivities : [];
		const total = Number(job.activeActivityCount ?? activities.length);
		if (total <= 1) continue;
		for (const activity of activities) {
			if (lines.length >= limit) {
				hidden += 1;
				continue;
			}
			const owner = activity.threadId ? ` ${shortId(activity.threadId, 6)}` : "";
			const category = inline(activity.category || "activity", 16);
			const summary = inline(activity.summary || activity.status || "running", 84);
			lines.push(th.fg("dim", `  ↳ ${category}${owner} · ${summary}`));
		}
		hidden += Math.max(0, total - activities.length);
	}
	if (hidden > 0) lines.push(th.fg("dim", `  ↳ +${hidden} more active activities · /watch`));
	return lines;
}

export function runtimeDockVisible(model, mode = "auto") {
	if (mode === "off") return false;
	if (mode === "always") return true;
	return Boolean(
		model.counts.active
		|| model.counts.waiting
		|| model.counts.unknown
		|| model.counts.openMessages
		|| model.project.freshness !== "current"
		|| !model.leader.isCurrentSessionAttached
		|| model.leader.inheritancePolicy === "clean"
		|| model.leader.inheritancePolicy === "analysis",
	);
}

export class RuntimeDockComponent {
	constructor(model, jobs, theme, options = {}) {
		this.model = model;
		this.jobs = jobs ?? [];
		this.theme = theme;
		this.density = options.density === "compact" ? "compact" : "balanced";
	}

	render(width) {
		const th = this.theme;
		const usable = Math.max(1, Math.floor(Number(width) || 1));
		const jobs = liveJobs(this.jobs);
		const active = this.model.counts.active;
		const waiting = this.model.counts.waiting;
		const unknown = this.model.counts.unknown;
		const open = this.model.counts.openMessages;
		const freshness = this.model.project.freshness;
		const stateColor = freshness === "current" ? "success" : freshness === "missing" || freshness === "stale" ? "warning" : "accent";
		const leader = this.model.leader.inheritancePolicy === "analysis"
			? th.fg("accent", "Analysis Session")
			: this.model.leader.inheritancePolicy === "clean"
			? th.fg("warning", "clean context")
			: this.model.leader.isCurrentSessionAttached
				? th.fg("success", "Leader here")
				: th.fg("warning", "Leader elsewhere");
		const route = inline(this.model.research.activeTrack || this.model.research.question || this.model.project.git.branch || "project context", 72);
		const headline = `${th.fg("customMessageLabel", th.bold("◈ RESEARCH"))}  ${th.fg("accent", th.bold(this.model.project.name))} · ${route}`;
		const counters = [
			active ? `${active} active` : "",
			waiting ? `${waiting} waiting` : "",
			unknown ? `${unknown} unknown` : "",
			open ? `${open} open` : "",
		].filter(Boolean).join(" · ") || "idle";
		const state = `${leader} · ${th.fg(stateColor, `memory ${freshness}`)} · ${counters}`;
		const visibleJobLimit = usable < 64 || this.density === "compact" ? 3 : 4;
		const visibleJobs = jobs.slice(0, visibleJobLimit);
		const jobLines = visibleJobs.map((job) => jobLine(job, th));
		if (jobs.length > visibleJobs.length) {
			jobLines.push(th.fg("dim", `… +${jobs.length - visibleJobs.length} more Codex actions · /watch`));
		}

		if (usable < 64 || this.density === "compact") {
			const lines = [truncateToWidth(`${headline} · ${state}`, usable, "…", true)];
			for (const line of jobLines) lines.push(truncateToWidth(line, usable, "…", true));
			return lines;
		}

		const inner = usable - 2;
		const border = (text) => th.fg("borderMuted", text);
		const rows = [
			headline,
			state,
			...jobLines,
			...activityLines(visibleJobs, th),
			th.fg("dim", jobLines.length ? "/runtime board · /watch <actor>" : "/runtime board · /runtime health"),
		];
		return [
			border(`╭${"─".repeat(inner)}╮`),
			...rows.map((line) => `${border("│")}${pad(` ${line}`, inner)}${border("│")}`),
			border(`╰${"─".repeat(inner)}╯`),
		];
	}

	invalidate() {}
}
