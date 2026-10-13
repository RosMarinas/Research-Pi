import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ACTIVE = new Set(["starting", "running", "cancelling"]);
export const RUNTIME_HEARTBEAT_MS = 1_000;
const HEARTBEAT_FRAMES = ["◐", "◓", "◑", "◒"];

function shortId(value, length = 8) {
	const text = String(value ?? "");
	return text.length <= length ? text : text.slice(-length);
}

function inline(value, limit = 100) {
	const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function elapsed(value, currentTime) {
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

export function runtimeHeartbeatNeeded(jobs = []) {
	return jobs.some((job) => ACTIVE.has(job.status));
}

export function createRuntimeHeartbeatClock(tick, options = {}) {
	const schedule = options.setInterval ?? setInterval;
	const cancel = options.clearInterval ?? clearInterval;
	const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
		? options.intervalMs
		: RUNTIME_HEARTBEAT_MS;
	let timer;
	return {
		setActive(active) {
			if (!active) {
				if (timer !== undefined) cancel(timer);
				timer = undefined;
				return;
			}
			if (timer !== undefined) return;
			timer = schedule(() => tick(), intervalMs);
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

function ageLabel(ageMs) {
	const seconds = Math.max(0, Math.floor(ageMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m`;
}

export function formatRuntimeHeartbeat(jobs = [], options = {}) {
	const currentTime = Number.isFinite(options.currentTime) ? options.currentTime : Date.now();
	const freshMs = Number.isFinite(options.freshMs) ? options.freshMs : 15_000;
	const working = jobs.filter((job) => ACTIVE.has(job.status));
	if (!working.length) return "";

	let live = 0;
	let starting = 0;
	const staleAges = [];
	let latestActivity = Number.NEGATIVE_INFINITY;
	for (const job of working) {
		const heartbeat = Date.parse(String(job.workerHeartbeatAt ?? ""));
		if (Number.isFinite(heartbeat)) {
			const age = Math.max(0, currentTime - heartbeat);
			if (age <= freshMs) live += 1;
			else staleAges.push(age);
		} else if (job.workerAlive === true) {
			live += 1;
		} else if (job.status === "starting") {
			starting += 1;
		} else {
			staleAges.push(Number.POSITIVE_INFINITY);
		}
		for (const value of [job.lastActivityAt, job.currentActivity?.at, job.lastActivity?.at]) {
			const at = Date.parse(String(value ?? ""));
			if (Number.isFinite(at)) latestActivity = Math.max(latestActivity, at);
		}
	}

	const frame = HEARTBEAT_FRAMES[Math.abs(Number(options.frame) || 0) % HEARTBEAT_FRAMES.length];
	const parts = [];
	if (staleAges.length === 1 && Number.isFinite(staleAges[0])) parts.push(`heartbeat ${ageLabel(staleAges[0])} stale`);
	else if (staleAges.length) parts.push(`${staleAges.length} stale`);
	if (live) parts.push(live === 1 ? "live" : `${live} live`);
	if (starting) parts.push(starting === 1 ? "starting" : `${starting} starting`);
	if (Number.isFinite(latestActivity)) parts.push(`event ${ageLabel(currentTime - latestActivity)}`);
	return `${staleAges.length ? "!" : frame} ${parts.join(" · ")}`;
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

function jobLine(job, th, currentTime) {
	const jobElapsed = elapsed(job.startedAt ?? job.createdAt, currentTime);
	const jobDetail = jobActivityLabel(job);
	const backend = job.backend ?? "codex";
	const role = job.role ?? job.mode ?? "general";
	const model = job.model ?? "inherit";
	const thinking = job.thinking ?? job.reasoningEffort ?? "inherit";
	return `${th.fg(job.status === "input_required" ? "warning" : "accent", job.status === "input_required" ? "?" : "●")} ${backend}/${role} ${shortId(job.id)} · ${jobStateLabel(job.status)} · ${model}/${thinking}${jobElapsed ? ` · ${jobElapsed}` : ""}${jobDetail ? ` · ${jobDetail}` : ""}`;
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
		this.currentTime = Number.isFinite(options.currentTime) ? options.currentTime : Date.now();
		this.fingerprint = runtimeDockFingerprint(this.model, this.jobs, this.density);
	}

	update(model, jobs, options = {}) {
		const density = options.density === undefined
			? this.density
			: options.density === "compact" ? "compact" : "balanced";
		const fingerprint = runtimeDockFingerprint(model, jobs, density);
		if (fingerprint === this.fingerprint) return false;
		this.model = model;
		this.jobs = jobs ?? [];
		this.density = density;
		this.currentTime = Number.isFinite(options.currentTime) ? options.currentTime : Date.now();
		this.fingerprint = fingerprint;
		return true;
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
		const jobLines = visibleJobs.map((job) => jobLine(job, th, this.currentTime));
		if (jobs.length > visibleJobs.length) {
			jobLines.push(th.fg("dim", `… +${jobs.length - visibleJobs.length} more subagent actions · /watch`));
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

function activityProjection(activity) {
	if (!activity || typeof activity !== "object") return null;
	return {
		id: activity.id ?? null,
		threadId: activity.threadId ?? null,
		category: activity.category ?? null,
		status: activity.status ?? null,
		summary: activity.summary ?? null,
	};
}

export function runtimeDockFingerprint(model, jobs = [], density = "balanced") {
	return JSON.stringify({
		density,
		project: {
			name: model?.project?.name ?? null,
			freshness: model?.project?.freshness ?? null,
			branch: model?.project?.git?.branch ?? null,
		},
		research: {
			activeTrack: model?.research?.activeTrack ?? null,
			question: model?.research?.question ?? null,
		},
		leader: {
			inheritancePolicy: model?.leader?.inheritancePolicy ?? null,
			isCurrentSessionAttached: model?.leader?.isCurrentSessionAttached ?? null,
		},
		counts: model?.counts ?? {},
		jobs: liveJobs(jobs).map((job) => ({
			id: job.id,
			backend: job.backend ?? null,
			status: job.status ?? null,
			role: job.role ?? job.mode ?? null,
			model: job.model ?? null,
			thinking: job.thinking ?? job.reasoningEffort ?? null,
			mission: job.mission ?? null,
			progress: job.progress ?? null,
			startedAt: job.startedAt ?? job.createdAt ?? null,
			currentActivity: activityProjection(job.currentActivity),
			activeActivities: Array.isArray(job.activeActivities) ? job.activeActivities.map(activityProjection) : [],
			activeActivityCount: job.activeActivityCount ?? null,
			lastActivity: activityProjection(job.lastActivity),
			pendingRequest: job.pendingRequest?.id ?? job.pendingRequest ?? null,
		})),
	});
}
