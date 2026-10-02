import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createSubagentSessionManager, formatSubagentSessionJob } from "../lib/subagent-sessions.mjs";
import {
	getRuntimeUiAdapter,
	registerSubagentRuntimeAdapter,
	registerSubagentWatchAdapter,
} from "../lib/research-runtime-adapters.mjs";
import {
	recordSubagentRuntimeEvent,
	registerSubagentRuntimeJob,
	resolveResearchRuntime,
	subagentActorId,
} from "../lib/research-runtime.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "input_required"]);

function compact(value: unknown, limit = 240): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function elapsed(value: unknown, currentTime = Date.now()): string {
	const started = Date.parse(String(value ?? ""));
	if (!Number.isFinite(started)) return "?";
	const seconds = Math.max(0, Math.floor((currentTime - started) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function statusIcon(status: string): string {
	if (status === "completed") return "✓";
	if (status === "input_required") return "?";
	if (status === "failed") return "✗";
	if (status === "cancelled") return "■";
	return "●";
}

class ProcessSubagentWatchOverlay {
	private timer: NodeJS.Timeout | undefined;
	private closed = false;
	private index: number;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private manager: ReturnType<typeof createSubagentSessionManager>,
		private backend: string,
		private jobs: any[],
		selected: number,
	) {
		this.index = Math.max(0, Math.min(selected, jobs.length - 1));
		this.timer = setInterval(() => this.refresh(), 1000);
		this.timer.unref();
	}

	private refresh() {
		if (this.closed) return;
		const selectedId = this.jobs[this.index]?.id;
		this.jobs = this.manager.list(this.backend);
		const next = this.jobs.findIndex((job: any) => job.id === selectedId);
		if (next >= 0) this.index = next;
		this.tui.requestRender();
	}

	private close() {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.done();
	}

	handleInput(data: string) {
		if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
		else if (matchesKey(data, "left") && this.jobs.length) {
			this.index = (this.index - 1 + this.jobs.length) % this.jobs.length;
			this.tui.requestRender();
		} else if (matchesKey(data, "right") && this.jobs.length) {
			this.index = (this.index + 1) % this.jobs.length;
			this.tui.requestRender();
		} else if (data === "r") this.refresh();
	}

	render(width: number): string[] {
		const job = this.jobs[this.index];
		if (!job) return ["No subagent Action exists."];
		const th = this.theme;
		const inner = Math.max(20, width - 2);
		const color = job.status === "completed" ? "success" : job.status === "failed" ? "error" : job.status === "input_required" ? "warning" : "accent";
		const rows = [
			` ${th.fg(color as any, `${statusIcon(job.status)} ${job.status}`)} · ${job.backend} · ${job.role} · ${elapsed(job.startedAt ?? job.createdAt)}`,
			` ${th.fg("dim", `${job.model} · thinking ${job.thinking} · ${job.id}`)}`,
			job.mission ? ` ${th.fg("accent", job.mission)}` : "",
			` ${th.fg("dim", compact(job.progress, 500))}`,
			"",
			` ${th.fg("dim", "Recent activity")}`,
			...job.events.slice(-10).map((event: any) => ` ${th.fg("muted", String(event.type ?? "event").padEnd(14))}${compact(event.summary, 500)}`),
			...(job.events.length ? [] : [` ${th.fg("dim", "No activity has been recorded yet.")}`]),
			"",
			` ${th.fg("dim", "←/→ Action · r refresh · q/Esc close")}`,
		].filter((line) => line !== "");
		const title = ` SUBAGENT WATCH ${this.index + 1}/${this.jobs.length} `;
		const titleText = truncateToWidth(title, inner);
		const pad = (line: string) => {
			const clipped = truncateToWidth(line, inner, "…", true);
			return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		};
		return [
			th.fg("borderMuted", `╭${titleText}${"─".repeat(Math.max(0, inner - visibleWidth(titleText)))}╮`),
			...rows.map((line) => `${th.fg("borderMuted", "│")}${pad(line)}${th.fg("borderMuted", "│")}`),
			th.fg("borderMuted", `╰${"─".repeat(inner)}╯`),
		];
	}

	invalidate() {}
	dispose() { this.close(); }
}

export default function subagentRunnersExtension(pi: ExtensionAPI) {
	const contexts = new Map<string, ExtensionContext>();
	const deliveredTurns = new Set<string>();
	const stateRoot = resolve(process.env.RESEARCH_PI_STATE_DIR ?? ".pi");
	const manager = createSubagentSessionManager({
		coreCli: process.env.RESEARCH_PI_CORE_CLI,
		stateRoot,
		boundaryExtension: process.env.RESEARCH_PI_HARNESS_ROOT
			? join(process.env.RESEARCH_PI_HARNESS_ROOT, ".pi", "extensions", "project-boundary.ts")
			: undefined,
		onUpdate: async (job: any) => {
			const ctx = contexts.get(job.id);
			if (!ctx) return;
			const runtime = await resolveResearchRuntime(ctx.cwd);
			await registerSubagentRuntimeJob(runtime, job);
			await getRuntimeUiAdapter()?.refresh(ctx, { backend: job.backend, jobs: manager.list(job.backend) });
			if (!TERMINAL.has(job.status)) return;
			const turnKey = `${job.id}:${job.turn}:${job.status}`;
			if (deliveredTurns.has(turnKey)) return;
			deliveredTurns.add(turnKey);
			const message = await recordSubagentRuntimeEvent(runtime, job, formatSubagentSessionJob(job));
			if (message) await getRuntimeUiAdapter()?.deliver(ctx, { messageId: message.id });
		},
	});

	const start = async (input: any) => {
		const backend = String(input.backend).toLowerCase();
		const id = `${backend}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const actorId = input.actorId ?? subagentActorId({ backend, mission: input.mission, jobId: id, role: input.role });
		contexts.set(id, input.ctx);
		const job = await manager.start({ ...input, id, actorId });
		await registerSubagentRuntimeJob(input.runtime ?? await resolveResearchRuntime(input.ctx.cwd), job);
		return job;
	};

	for (const backend of ["pi", "antigravity"]) {
		registerSubagentRuntimeAdapter(backend, {
			start,
			status: async ({ jobId }: any) => manager.get(jobId),
			result: async ({ jobId }: any) => manager.get(jobId),
			wait: async ({ jobId, signal }: any) => await manager.wait(jobId, signal),
			cancel: async ({ jobId }: any) => await manager.cancel(jobId),
			list: () => manager.list(backend),
			dispatch: async ({ actor, message }: any) => await manager.send(actor.id, message),
		});
		registerSubagentWatchAdapter(backend, {
			open: async (ctx: ExtensionCommandContext, selector = "") => {
				const jobs = manager.list(backend);
				if (!jobs.length) {
					ctx.ui.notify(`No ${backend} subagent Action exists in this Research Pi session.`, "info");
					return;
				}
				const normalized = selector.replace(/^@/, "").toLowerCase();
				const selected = Math.max(0, jobs.findIndex((job: any) => [job.id, job.actorId, job.id.slice(-8)].some((value) => String(value).toLowerCase().includes(normalized))));
				await ctx.ui.custom<void>(
					(tui, theme, _keys, done) => new ProcessSubagentWatchOverlay(tui, theme, done, manager, backend, jobs, selected),
					{ overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%", margin: 1 } },
				);
			},
		});
	}

	pi.on("session_shutdown", async () => {
		await manager.dispose();
		contexts.clear();
	});
}
