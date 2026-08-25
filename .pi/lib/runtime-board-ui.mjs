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

function joinColumns(left, right, width, gap = 3) {
	const leftWidth = Math.max(28, Math.floor((width - gap) * 0.54));
	const rightWidth = Math.max(24, width - gap - leftWidth);
	const count = Math.max(left.length, right.length);
	const rows = [];
	for (let index = 0; index < count; index += 1) {
		const leftLine = truncateToWidth(left[index] ?? "", leftWidth, "…", true);
		const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "…", true);
		rows.push(`${leftLine}${" ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)))}${" ".repeat(gap)}${rightLine}`);
	}
	return rows;
}

export class RuntimeBoardOverlay {
	constructor(tui, theme, done, initialModel, reload) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.model = initialModel;
		this.reload = reload;
		this.sectionIndex = 0;
		this.actorIndex = 0;
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

	changeActor(delta) {
		const visibleCount = Math.min(5, this.model.actors.length);
		if (!visibleCount) return;
		this.actorIndex = (this.actorIndex + delta + visibleCount) % visibleCount;
		this.tui.requestRender();
	}

	watchTarget() {
		const selected = RUNTIME_BOARD_SECTIONS[this.sectionIndex] === "actors" ? this.model.actors[this.actorIndex] : null;
		const actor = selected?.kind === "codex"
			? selected
			: this.model.actors.find((candidate) => candidate.kind === "codex" && ["starting", "running", "waiting for input", "cancelling"].includes(candidate.state))
				?? this.model.actors.find((candidate) => candidate.kind === "codex");
		return actor?.target ?? "";
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
		else if (RUNTIME_BOARD_SECTIONS[this.sectionIndex] === "actors" && matchesKey(data, "down")) this.changeActor(1);
		else if (RUNTIME_BOARD_SECTIONS[this.sectionIndex] === "actors" && matchesKey(data, "up")) this.changeActor(-1);
		else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.changeSection(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.changeSection(-1);
		else if (data === "r") void this.refresh();
		else if (data === "v") this.close("view");
		else if (data === "w" || (RUNTIME_BOARD_SECTIONS[this.sectionIndex] === "actors" && matchesKey(data, "enter"))) {
			const selector = this.watchTarget();
			if (selector) this.close({ action: "watch", selector });
		}
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
			th.fg("borderMuted", `╭${"─".repeat(leftWidth)}`) + th.fg("customMessageLabel", th.bold(cleanTitle)) + th.fg("borderMuted", `${"─".repeat(rightWidth)}╮`),
			...lines.map((line) => th.fg("borderMuted", "│") + pad(line) + th.fg("borderMuted", "│")),
			th.fg("borderMuted", `╰${"─".repeat(inner)}╯`),
		];
	}

	field(label, value, color = "text") {
		const th = this.theme;
		return ` ${th.fg("dim", `${label.padEnd(12)} `)}${th.fg(color, value || "not recorded")}`;
	}

	overviewLines(width = 80) {
		const th = this.theme;
		const { project, research, counts, health } = this.model;
		const context = health.tokens === null || health.tokens === undefined
			? "context unknown"
			: `${tokenCount(health.tokens)}/${tokenCount(health.contextWindow)}${health.percent === null ? "" : ` · ${health.percent.toFixed(1)}%`}`;
		const operational = [
			` ${th.fg("dim", "Control")}  ${counts.active} active · ${counts.waiting} waiting · ${counts.openMessages} open · ${counts.unknown} unknown`,
			` ${th.fg("dim", "Context")}  ${context} · ${health.compactions} compact${health.compactions === 1 ? "" : "s"}`,
		];
		const researchRows = [
			this.field(research.activeTrack ? "Active track" : "Question", research.activeTrack || research.question, "accent"),
		];
		if (research.activeTrack && research.question && research.question !== research.activeTrack) researchRows.push(this.field("Question", research.question));
		if (research.claim) researchRows.push(this.field("Claim", research.claim, "success"));
		if (research.previousClaim) researchRows.push(this.field("Prior claim", research.previousClaim, "muted"));
		researchRows.push(this.field("Next", research.nextStep, "accent"));
		if (project.freshness !== "current") {
			researchRows.push(
				` ${th.fg(stateColor(project.freshness), `${stateIcon(project.freshness)} memory ${project.freshness}`)} · ${project.freshnessReasons[0] || "structured state needs attention"}`,
			);
		}
		operational.push(
			` ${th.fg(stateColor(health.recommendation === "reconcile" ? "outcome_unknown" : "running"), `→ ${health.recommendation}`)} · ${health.reason}`,
			` ${health.ready ? th.fg("success", "✓ rotation ready") : th.fg("warning", `■ rotation blocked · ${health.blockers[0] || "Project state is not recoverable"}`)}`,
		);
		if (width >= 108) {
			return [
				` ${th.fg("dim", "PROJECT / MEMORY")}${" ".repeat(Math.max(1, Math.floor(width * 0.54) - 18))}${th.fg("dim", "RUNTIME / CONTROL")}`,
				...joinColumns(researchRows, operational, width),
			];
		}
		return [...operational.slice(0, 2), "", ...researchRows, "", ...operational.slice(2)];
	}

	actorLines() {
		const th = this.theme;
		const rows = [` ${th.fg("dim", "Stable Project Actors · active work first")}`, ""];
		// Keep the dashboard usable in the common 24-row terminal. `/actors all`
		// remains the detailed, unbounded history view.
		for (const [index, actor] of this.model.actors.slice(0, 5).entries()) {
			const color = stateColor(actor.action?.status || actor.state);
			const cursor = index === this.actorIndex ? th.fg("accent", "›") : " ";
			rows.push(`${cursor} ${th.fg(color, `${stateIcon(actor.action?.status || actor.state)} ${actor.target}`)} · ${actor.label} · ${actor.state}`);
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
		const sessionRole = leader.inheritancePolicy === "analysis"
			? th.fg("accent", "analysis · project read-only")
			: leader.inheritancePolicy === "clean"
				? th.fg("warning", "clean context")
				: th.fg("success", "Leader Session · project context");
		const ownership = leader.inheritancePolicy === "analysis"
			? th.fg("accent", `✓ current TUI is an Analysis Session; Leader remains ${leader.sessionSuffix || "detached"}`)
			: leader.isCurrentSessionAttached
				? th.fg("success", "✓ current TUI owns the Leader Session")
				: th.fg("warning", "! Leader Session is attached elsewhere");
		const sessionDetail = leader.inheritancePolicy === "analysis"
			? `   current session ${shortId(leader.currentSessionId, 8) || "unknown"} · ${sessionRole}\n   Leader attachment ${leader.sessionSuffix || "detached"}${leader.branchAnchorId ? ` · branch anchor ${shortId(leader.branchAnchorId, 10)}` : ""}`
			: `   session ${leader.sessionSuffix || "none"}${leader.branchAnchorId ? ` · branch anchor ${shortId(leader.branchAnchorId, 10)}` : ""} · ${sessionRole}`;
		const rows = [
			` ${th.fg("dim", "Session role and Leader attachment")}`,
			"",
			` ${ownership}`,
			...sessionDetail.split("\n"),
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
			` ${th.fg("customMessageLabel", th.bold("◈ RESEARCH RUNTIME"))}  ${th.fg("accent", th.bold(project.name))} · project ${project.shortKey}`,
			` ${memory} · r${project.revision}/state ${project.stateRevision || "—"} · ${leader.inheritancePolicy === "analysis" ? `analysis · leader ${leader.sessionSuffix || "detached"}` : `leader ${leader.sessionSuffix || "detached"}${leader.inheritancePolicy === "clean" ? " · clean" : ""}`}`,
			` ${th.fg("dim", `${project.git.branch ?? "no branch"} @ ${project.git.commit ?? "unknown"}`)} · ${dirty}`,
			` ${tabs}`,
			"",
		];
		let body;
		if (section === "actors") body = this.actorLines();
		else if (section === "messages") body = this.messageLines();
		else if (section === "sessions") body = this.sessionLines();
		else body = this.overviewLines(Math.max(1, width - 2));
		const updated = clock(this.model.generatedAt);
		const footer = [
			"",
			...(this.error ? [` ${th.fg("error", this.error)}`] : []),
			` ${th.fg("dim", `${this.refreshing ? "refreshing…" : `snapshot ${updated}`} · ←/→ tabs${section === "actors" ? " · ↑/↓ select · Enter watch" : ""} · r refresh · v view · w watch · q close`)}`,
		];
		// This is a dashboard, not a transcript: one logical row stays one
		// terminal row so the overlay does not push its footer below maxHeight.
		// Full text remains available through `/runtime view`, `/inbox`, and
		// `/actors all`.
		const innerWidth = Math.max(1, width - 2);
		const rows = [...header, ...body, ...footer].map((line) =>
			line ? truncateToWidth(line, innerWidth, "...", true) : "",
		);
		return this.box(rows, width, "Research Runtime / Project Board");
	}

	invalidate() {}

	dispose() {
		this.closed = true;
	}
}
