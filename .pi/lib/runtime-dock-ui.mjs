import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ACTIVE = new Set(["starting", "running", "cancelling"]);

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

function latestLiveJob(jobs = []) {
	return [...jobs]
		.filter((job) => ACTIVE.has(job.status) || job.status === "input_required")
		.sort((left, right) => Date.parse(right.lastActivityAt ?? right.startedAt ?? right.createdAt ?? "") - Date.parse(left.lastActivityAt ?? left.startedAt ?? left.createdAt ?? ""))[0] ?? null;
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
		|| model.leader.inheritancePolicy === "clean",
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
		const job = latestLiveJob(this.jobs);
		const active = this.model.counts.active;
		const waiting = this.model.counts.waiting;
		const unknown = this.model.counts.unknown;
		const open = this.model.counts.openMessages;
		const freshness = this.model.project.freshness;
		const stateColor = freshness === "current" ? "success" : freshness === "missing" || freshness === "stale" ? "warning" : "accent";
		const leader = this.model.leader.inheritancePolicy === "clean"
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
		const jobLine = job
			? `${th.fg(job.status === "input_required" ? "warning" : "accent", job.status === "input_required" ? "?" : "●")} ${job.mode ?? "codex"} ${shortId(job.id)}${elapsed(job.startedAt ?? job.createdAt) ? ` · ${elapsed(job.startedAt ?? job.createdAt)}` : ""} · ${inline(job.progress || job.mission || job.status, 110)}`
			: "";

		if (usable < 64 || this.density === "compact") {
			const lines = [truncateToWidth(`${headline} · ${state}`, usable, "…", true)];
			if (jobLine) lines.push(truncateToWidth(`${jobLine} · /watch`, usable, "…", true));
			return lines;
		}

		const inner = usable - 2;
		const border = (text) => th.fg("borderMuted", text);
		const rows = [
			headline,
			state,
			...(jobLine ? [jobLine] : []),
			th.fg("dim", jobLine ? "/runtime board · /watch <actor>" : "/runtime board · /runtime health"),
		];
		return [
			border(`╭${"─".repeat(inner)}╮`),
			...rows.map((line) => `${border("│")}${pad(` ${line}`, inner)}${border("│")}`),
			border(`╰${"─".repeat(inner)}╯`),
		];
	}

	invalidate() {}
}
