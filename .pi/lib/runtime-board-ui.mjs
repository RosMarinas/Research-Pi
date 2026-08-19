import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { RUNTIME_BOARD_SECTIONS } from "./runtime-board.mjs";

function shortId(value, length = 10) {
	const text = String(value ?? "");
	return text.length <= length ? text : text.slice(-length);
}

function clock(value) {
	const date = new Date(String(value ?? ""));
	if (!Number.isFinite(date.getTime())) return "--:--";
	return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function tokenCount(value) {
	if (!Number.isFinite(value)) return "?";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function stateColor(status) {
	if (["failed", "outcome_unknown", "outcome unknown"].includes(status)) return "error";
	if (["input_required", "waiting for input", "queued", "pending", "stale", "missing"].includes(status)) return "warning";
	if (["completed", "current"].includes(status)) return "success";
	return "accent";
}

function stateIcon(status) {
	if (["failed", "outcome_unknown", "outcome unknown"].includes(status)) return "!";
	if (["input_required", "waiting for input"].includes(status)) return "?";
	if (["completed", "current"].includes(status)) return "✓";
	if (["cancelled", "cancelling"].includes(status)) return "■";
	return "●";
}

export class RuntimeBoardOverlay {
	constructor(tui, theme, done, initialModel, reload) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.model = initialModel;
		this.reload = reload;
		this.sectionIndex = 0;
		this.refreshing = false;
		this.closed = false;
		this.error = undefined;
	}

	close(result = "close") {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}

	changeSection(delta) {
		this.sectionIndex = (this.sectionIndex + delta + RUNTIME_BOARD_SECTIONS.length) % RUNTIME_BOARD_SECTIONS.length;
		this.tui.requestRender();
	}

	async refresh() {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		this.error = undefined;
		this.tui.requestRender();
		try {
			this.model = await this.reload();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			this.tui.requestRender();
		}
	}

	handleInput(data) {
		if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
		else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.changeSection(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.changeSection(-1);
		else if (data === "r") void this.refresh();
		else if (data === "v") this.close("view");
		else if (data === "w") this.close("watch");
		else if (/^[1-4]$/.test(data)) {
			this.sectionIndex = Number(data) - 1;
			this.tui.requestRender();
		}
	}

	box(lines, width, title) {
		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const cleanTitle = truncateToWidth(` ${title} `, inner);
		const titleWidth = visibleWidth(cleanTitle);
		const leftWidth = Math.max(0, Math.floor((inner - titleWidth) / 2));
		const rightWidth = Math.max(0, inner - titleWidth - leftWidth);
		const pad = (line) => {
			const clipped = truncateToWidth(line, inner, "...", true);
			return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		};
		return [
			th.fg("border", `╭${"─".repeat(leftWidth)}`) + th.fg("accent", cleanTitle) + th.fg("border", `${"─".repeat(rightWidth)}╮`),
			...lines.map((line) => th.fg("border", "│") + pad(line) + th.fg("border", "│")),
			th.fg("border", `╰${"─".repeat(inner)}╯`),
		];
	}

	field(label, value, color = "text") {
		const th = this.theme;
		return ` ${th.fg("dim", label.padEnd(11))}${th.fg(color, value || "not recorded")}`;
	}

	overviewLines() {
		const th = this.theme;
		const { project, research, counts, health } = this.model;
		const context = health.tokens === null || health.tokens === undefined
			? "context unknown"
			: `${tokenCount(health.tokens)}/${tokenCount(health.contextWindow)}${health.percent === null ? "" : ` · ${health.percent.toFixed(1)}%`}`;
		const result = [
			` ${th.fg("dim", "Control")}  ${counts.active} active · ${counts.waiting} waiting · ${counts.openMessages} open · ${counts.unknown} unknown`,
			` ${th.fg("dim", "Context")}  ${context} · ${health.compactions} compact${health.compactions === 1 ? "" : "s"}`,
			"",
			this.field(research.activeTrack ? "Active track" : "Question", research.activeTrack || research.question, "accent"),
		];
		if (research.activeTrack && research.question && research.question !== research.activeTrack) result.push(this.field("Question", research.question));
		if (research.claim) result.push(this.field("Claim", research.claim, "success"));
		if (research.previousClaim) result.push(this.field("Prior claim", research.previousClaim, "muted"));
		result.push(this.field("Next", research.nextStep, "accent"));
		if (project.freshness !== "current") {
			result.push(
				"",
				` ${th.fg(stateColor(project.freshness), `${stateIcon(project.freshness)} memory ${project.freshness}`)} · ${project.freshnessReasons[0] || "structured state needs attention"}`,
			);
		}
		result.push(
			"",
			` ${th.fg(stateColor(health.recommendation === "reconcile" ? "outcome_unknown" : "running"), `→ ${health.recommendation}`)} · ${health.reason}`,
			` ${health.ready ? th.fg("success", "✓ rotation ready") : th.fg("warning", `■ rotation blocked · ${health.blockers[0] || "Project state is not recoverable"}`)}`,
		);
		return result;
	}

	actorLines() {
		const th = this.theme;
		const rows = [` ${th.fg("dim", "Stable Project Actors · active work first")}`, ""];
		// Keep the dashboard usable in the common 24-row terminal. `/actors all`
		// remains the detailed, unbounded history view.
		for (const actor of this.model.actors.slice(0, 5)) {
			const color = stateColor(actor.action?.status || actor.state);
			rows.push(` ${th.fg(color, `${stateIcon(actor.action?.status || actor.state)} ${actor.target}`)} · ${actor.label} · ${actor.state}`);
			if (actor.action) rows.push(`   ${th.fg("dim", `${shortId(actor.action.id, 12)} · ${actor.action.label}${actor.action.externalId ? ` · external ${shortId(actor.action.externalId, 12)}` : ""}`)}`);
		}
		if (!this.model.actors.length) rows.push(` ${th.fg("dim", "No Actor is registered.")}`);
		if (this.model.actors.length > 5) rows.push(` ${th.fg("dim", `… ${this.model.actors.length - 5} more · use /actors all`)}`);
		return rows;
	}

	messageLines() {
		const th = this.theme;
		const rows = [` ${th.fg("dim", "Durable mailbox · open messages only")}`, ""];
		for (const message of this.model.openMessages.slice(0, 5)) {
			rows.push(` ${th.fg(stateColor(message.status), `${stateIcon(message.status)} ${message.type}`)} · ${message.from} → ${message.to} · ${message.status} · ${clock(message.at)}`);
			rows.push(`   ${message.body || th.fg("dim", "empty message")} ${th.fg("dim", `· ${shortId(message.id, 12)}`)}`);
		}
		if (!this.model.openMessages.length) rows.push(` ${th.fg("success", "✓ No queued or unconsumed message.")}`);
		else if (this.model.counts.openMessages > 5) rows.push(` ${th.fg("dim", `… ${this.model.counts.openMessages - 5} more · use /inbox`)}`);
		return rows;
	}

	sessionLines() {
		const th = this.theme;
		const { leader, rotations, health } = this.model;
		const rows = [
			` ${th.fg("dim", "Research Leader attachment")}`,
			"",
			` ${leader.isCurrentSessionAttached ? th.fg("success", "✓ current TUI owns Research Leader") : th.fg("warning", "! Research Leader is attached elsewhere")}`,
			`   session ${leader.sessionSuffix || "none"}${leader.branchAnchorId ? ` · branch anchor ${shortId(leader.branchAnchorId, 10)}` : ""} · ${leader.inheritancePolicy === "clean" ? th.fg("warning", "clean context") : th.fg("success", "project context")}`,
			`   ${leader.activation ? th.fg("warning", `active agent run · ${shortId(leader.activation.id, 12)} · since ${clock(leader.activation.startedAt)}`) : th.fg("dim", "no active agent run")}`,
			"",
			` ${th.fg("dim", "Recent explicit handoffs")}`,
		];
		for (const rotation of rotations.slice(0, 3)) {
			rows.push(` ${th.fg(stateColor(rotation.status), `${stateIcon(rotation.status)} ${rotation.status}`)} · ${shortId(rotation.fromSessionId, 8)} → ${shortId(rotation.toSessionId, 8) || "pending"} · ${clock(rotation.at)}${rotation.reason ? ` · ${th.fg("dim", rotation.reason)}` : ""}`);
		}
		if (!rotations.length) rows.push(` ${th.fg("dim", "No explicit Runtime rotation has been recorded.")}`);
		else if (this.model.counts.rotations > 3) rows.push(` ${th.fg("dim", `… ${this.model.counts.rotations - 3} earlier · use the Runtime ledger for provenance`)}`);
		rows.push("", ` ${health.ready ? th.fg("success", "Ready for /runtime rotate") : th.fg("warning", `Rotation blocked · ${health.blockers[0] || "Project state unavailable"}`)}`);
		return rows;
	}

	render(width) {
		const th = this.theme;
		const { project, leader } = this.model;
		const section = RUNTIME_BOARD_SECTIONS[this.sectionIndex];
		const tabs = RUNTIME_BOARD_SECTIONS.map((candidate, index) => {
			const label = `${index + 1} ${candidate}`;
			return candidate === section ? th.fg("accent", th.bold(`[${label}]`)) : th.fg("dim", label);
		}).join("  ");
		const dirty = project.git.dirty === null || project.git.dirty === undefined
			? th.fg("dim", "worktree unknown")
			: project.git.dirty ? th.fg("warning", "dirty") : th.fg("success", "clean");
		const memory = th.fg(stateColor(project.freshness), project.freshness);
		const header = [
			` ${th.fg("accent", th.bold(project.name))} · project ${project.shortKey}`,
			` ${memory} · r${project.revision}/state ${project.stateRevision || "—"} · leader ${leader.sessionSuffix || "detached"}${leader.inheritancePolicy === "clean" ? " · clean" : ""}`,
			` ${th.fg("dim", `${project.git.branch ?? "no branch"} @ ${project.git.commit ?? "unknown"}`)} · ${dirty}`,
			` ${tabs}`,
			"",
		];
		let body;
		if (section === "actors") body = this.actorLines();
		else if (section === "messages") body = this.messageLines();
		else if (section === "sessions") body = this.sessionLines();
		else body = this.overviewLines();
		const updated = clock(this.model.generatedAt);
		const footer = [
			"",
			...(this.error ? [` ${th.fg("error", this.error)}`] : []),
			` ${th.fg("dim", `${this.refreshing ? "refreshing…" : `snapshot ${updated}`} · ←/→/Tab · r refresh · v view · w watch · q/Esc close`)}`,
		];
		// This is a dashboard, not a transcript: one logical row stays one
		// terminal row so the overlay does not push its footer below maxHeight.
		// Full text remains available through `/runtime view`, `/inbox`, and
		// `/actors all`.
		const innerWidth = Math.max(1, width - 2);
		const rows = [...header, ...body, ...footer].map((line) =>
			line ? truncateToWidth(line, innerWidth, "...", true) : "",
		);
		return this.box(rows, width, "Research Runtime · Project Board");
	}

	invalidate() {}

	dispose() {
		this.closed = true;
	}
}
