import { Text, ProcessTerminal, TuiAltScreen, matchesKey, truncateToWidth, getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, UserMessageComponent, CustomEditor, ToolExecutionComponent, getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { createSubagentWatchClient, openSubagentTerminal, subagentWatchLabel, subagentWatchTranscript } from "./subagent-watch.mjs";
import { HARNESS_ROOT } from "./codex-jobs.mjs";
import { resolveResearchPiPaths } from "./runtime-paths.mjs";
import { attachNativeTerminal } from "./native-terminal-client.mjs";
import { selectModel } from "./model-picker.mjs";

// Short, human-readable actor name for the header.
function actorDisplayName(actor) {
	const name = actor.metadata?.mission ?? actor.label ?? actor.role ?? actor.metadata?.role ?? "Subagent";
	return name;
}

export class SubagentWatchView {
	constructor(tui, client, selector, done, keys = getKeybindings(), theme) {
		this.tui = tui; this.client = client; this.selector = selector; this.done = done; this.theme = theme;
		this.offset = 0; this.closed = false;
		this.notice = "Connecting…"; this.noticeExpiry = 0;
		this.components = new Map();
		this.editor = new CustomEditor(tui, { borderColor: (s) => theme ? theme.fg("borderMuted", s) : getMarkdownTheme().hr(s), selectList: getSelectListTheme() }, keys, { paddingX: 1, embedWorkingStatus: true });
		this.editor.onEscape = () => { if (!this.editor.getText()) this.close(); else { this.editor.setText(""); this.tui.requestRender(); } };
		this.editor.onCtrlD = () => this.close();
		this.editor.onAction("app.clear", () => { this.editor.setText(""); this.tui.requestRender(); });
		this.editor.onSubmit = (text) => { void this.submit(text); };
		this.timer = setInterval(() => { void this.refresh(); }, 750);
		this.timer.unref();
		void this.refresh();
	}
	get focused() { return this.editor.focused; }
	set focused(value) { this.editor.focused = value; }
	// Transient notice: shown for a few seconds, then disappears to reclaim space.
	setNotice(text, durationMs = 5000) {
		this.notice = text;
		this.noticeExpiry = Date.now() + durationMs;
	}
	get activeNotice() {
		if (!this.notice) return null;
		if (this.noticeExpiry && Date.now() > this.noticeExpiry) { this.notice = null; return null; }
		return this.notice;
	}
	async refresh() {
		if (this.closed || this.refreshing) return;
		this.refreshing = true;
		const selector = this.selector;
		try {
			const view = await this.client.read(selector);
			if (this.closed || selector !== this.selector) return;
			this.view = view;
			this.selector = this.view.actor.id;
			if (this.notice === "Connecting…") this.setNotice("Legacy journal · new Pi agents have native conversations.", 6000);
			this.error = null;
		} catch (error) { this.error = error.message; }
		finally { this.refreshing = false; if (!this.closed) { this.tui.requestRender(); if (selector !== this.selector) void this.refresh(); } }
	}
	async submit(text) {
		if (!text.trim() || !this.view || this.sending) return;
		if (text.trim() === "/back" || text.trim() === "/quit") { this.close(); return; }
		this.sending = true;
		try {
			const match = text.trim().match(/^\/(ask|reply|steer)\s+([\s\S]+)$/);
			if (text.trim().startsWith("/") && !match) throw new Error("Enter a message, /ask, /reply, /steer, or /back");
			const receipt = await this.client.send(this.view.actor, match ? match[2] : text, match?.[1] ?? (this.view.job.status === "input_required" ? "reply" : "notify"));
			this.setNotice(`Queued ${receipt.id}`, 8000);
			this.editor.addToHistory(text); this.editor.setText(""); this.offset = 0;
			await this.refresh();
		} catch (error) { this.setNotice(error.message, 10000); }
		finally { this.sending = false; this.tui.requestRender(); }
	}
	handleInput(data) {
		if (matchesKey(data, "ctrl+d") && !this.editor.getText() || matchesKey(data, "escape") && !this.editor.getText()) return this.close();
		if (matchesKey(data, "ctrl+c")) { this.editor.setText(""); this.tui.requestRender(); return; }
		if (matchesKey(data, "ctrl+o")) { this.expanded = !this.expanded; this.components.clear(); }
		else if (matchesKey(data, "pageUp")) this.offset += Math.max(5, this.tui.terminal.rows - 12);
		else if (matchesKey(data, "pageDown")) this.offset = Math.max(0, this.offset - Math.max(5, this.tui.terminal.rows - 12));
		else if (matchesKey(data, "tab") && this.view?.actors.length > 1) {
			const index = this.view.actors.findIndex((actor) => actor.id === this.selector);
			this.selector = this.view.actors[(index + 1) % this.view.actors.length].id;
			this.offset = 0; this.previousLines = undefined; void this.refresh();
		} else this.editor.handleInput(data);
		this.tui.requestRender();
	}
	handleMouse(event) {
		if (event.type === "wheel") {
			this.offset = Math.max(0, this.offset - (event.wheelDelta ?? 0)); this.tui.requestRender();
			return { handled: true };
		}
		if (this.editorRow !== undefined && event.y >= this.editorRow && event.y < this.editorRow + this.editorHeight) {
			return this.editor.handleMouse({ ...event, y: event.y - this.editorRow, height: this.editorHeight });
		}
	}
	render(width) {
		const theme = getMarkdownTheme();
		const muted = (text) => this.theme ? this.theme.fg("muted", text) : theme.codeBlockBorder(text);
		const transcriptTheme = {
			...theme,
			heading: (text) => /^#{1,6}\s+$/.test(stripTerminalSequences(text)) ? "" : theme.heading(text),
			codeBlockBorder: (text) => theme.codeBlockBorder(text.replace(/^```(.*)$/, (_all, language) => `──${language ? ` ${language}` : ""}`)),
		};
		const view = this.view;

		// ── Header: compact, readable actor identification ──
		const backend = view?.actor.backend ?? view?.actor.provider ?? "";
		const role = view ? (view.actor.role ?? view.actor.metadata?.role ?? "") : "";
		const name = view ? actorDisplayName(view.actor) : "Research Pi · Subagent";
		const header = name;

		// ── Status line: model · thinking · status (no raw actor ID) ──
		const model = view?.job.model ?? view?.actor.model ?? "inherit";
		const thinking = view?.job.thinking ?? view?.job.reasoningEffort ?? "inherit";
		const status = view?.job.status ?? "connecting";
		const agentCount = view?.actors.length ?? 0;
		const position = agentCount > 1 ? ` · ${view.actors.findIndex((actor) => actor.id === view.actor.id) + 1}/${agentCount}` : "";
		const stateLine = view ? `${status.replaceAll("_", " ")} · ${backend} · ${role}${position}` : (this.activeNotice ?? "Connecting…");
		const detail = view
			? `${model} · ${width >= 64 ? "thinking " : ""}${thinking}`
			: (this.activeNotice ?? "");

		// ── Editor ──
		const editor = this.editor.render(width);

		// ── Transcript body ──
		const lines = [], components = new Map();
		for (const row of view ? subagentWatchTranscript(view) : []) {
			if (row.label) lines.push(theme.quote(row.label));
			const key = JSON.stringify(row);
			let component = this.components.get(key);
			if (!component) {
				if (row.kind === "user") component = new UserMessageComponent(row.text, transcriptTheme);
				else if (row.kind === "thinking") component = new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: row.text }], stopReason: "stop" }, false, transcriptTheme);
				else if (row.kind === "assistant") component = new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: row.text }], stopReason: "stop" }, true, transcriptTheme);
				else if (row.tool) {
					component = new ToolExecutionComponent(row.tool, row.toolCallId, row.args ?? {}, { showImages: false }, undefined, this.tui, this.client.runtime?.cwd ?? process.cwd());
					if (row.result) component.updateResult({ ...row.result, isError: row.isError === true }, row.phase !== "completed");
					component.setExpanded(this.expanded === true);
				} else component = new Text(muted(row.text), 1, 0);
			}
			components.set(key, component);
			lines.push(...component.render(width), "");
		}
		this.components = components;

		// ── Scroll anchor ──
		if (this.offset && this.previousWidth === width && this.previousLines !== undefined) this.offset += Math.max(0, lines.length - this.previousLines);
		this.previousLines = lines.length; this.previousWidth = width;

		const budget = this.tui.terminal.rows - editor.length;
		const top = budget >= 4 ? [theme.bold(header), muted(stateLine)] : [];
		const persistentNotice = view && !view.leaderConnected ? "Leader disconnected; messages remain queued." : null;
		const displayNotice = this.error ?? persistentNotice ?? this.activeNotice;
		const noticeLine = budget >= 6 && displayNotice ? [displayNotice] : [];
		const shortcuts = budget >= 4 ? [width < 64
			? `Enter send · ${agentCount > 1 ? "Tab agent · " : ""}Esc back`
			: `Enter send · /ask /reply /steer · ${agentCount > 1 ? "Tab switch · " : ""}PgUp/Dn · Esc back`] : [];
		const height = Math.max(0, budget - top.length - noticeLine.length - shortcuts.length - 1);
		this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
		const end = Math.max(0, lines.length - this.offset);
		const body = lines.slice(Math.max(0, end - height), end);
		while (body.length < height) body.unshift("");

		this.editorRow = top.length + body.length + noticeLine.length; this.editorHeight = editor.length;
		return [...top, ...body, ...noticeLine, ...editor, budget < 4 ? stateLine : detail, ...shortcuts]
			.map((line) => truncateToWidth(line, width));
	}
	invalidate() { this.editor.invalidate(); for (const component of this.components.values()) component.invalidate(); }
	close() { if (this.closed) return; this.dispose(); this.done(); }
	dispose() { this.closed = true; clearInterval(this.timer); }
}

export async function chooseSubagentConversation(ctx, client) {
 const actors = await client.list();
 const leader = "Leader · return to main conversation";
 const labels = actors.map(actor => `${actor.action?.status ?? "unknown"} · ${subagentWatchLabel(actor)}`);
 const chosen = await selectModel(ctx, "Conversations — search by name, role, or model", [leader, ...labels]);
 return !chosen || chosen === leader ? undefined : actors[labels.indexOf(chosen)].id;
}

// Suspend only the Leader presentation. Its model, mailbox, editor and scroll
// state remain owned by the original InteractiveMode while another terminal is attached.
export async function attachSubagentInUi(ctx, record) {
 return await ctx.ui.custom((tui, _theme, _keys, done) => {
  setImmediate(async () => {
   tui.stop();
   try {
    const target = await attachNativeTerminal(record, { terminal: tui.terminal,
     ...(tui.terminal.requestAction ? { onAction: event => tui.terminal.requestAction(event.action, event.params) } : {}) });
    tui.start(); done({ target });
   } catch (error) { tui.start(); done({ error }); }
  });
  return { render: () => [], invalidate() {} };
 });
}

export async function openSubagentWatch(ctx, selector = "") {
 try {
  const paths = resolveResearchPiPaths({ harnessRoot: HARNESS_ROOT });
  const client = await createSubagentWatchClient({ cwd: ctx.cwd, stateRoot: paths.stateRoot });
  if (!(await client.list()).length) { ctx.ui.notify("No subagent is registered in this workspace.", "info"); return; }
  selector ||= await chooseSubagentConversation(ctx, client);
  if (!selector) return;
  const mode = await ctx.ui.select("Subagent terminal", ["Switch in this terminal", "Open a new terminal"]);
  if (!mode) return;
  if (mode === "Open a new terminal") {
   const { actor } = await client.read(selector);
   const result = await openSubagentTerminal({ launcher: join(HARNESS_ROOT, "bin", "pi.mjs"), cwd: ctx.cwd, stateRoot: paths.stateRoot, actorId: actor.id });
   ctx.ui.notify(result.opened ? "Subagent terminal opened. The Leader continues here."
    : `Could not open a terminal automatically. Run this in another shell:\n${result.command}`, result.opened ? "info" : "warning");
   return;
  }
  while (selector) {
   const view = await client.read(selector);
   const record = view.job.nativeTerminal ?? view.actor.metadata?.nativeTerminal;
   if (record) {
    const result = await attachSubagentInUi(ctx, record);
    if (result.error) throw result.error;
    if (result.target !== "agents") return;
    selector = await chooseSubagentConversation(ctx, client);
   } else {
    await ctx.ui.custom((tui, theme, keys, done) => new SubagentWatchView(tui, client, view.actor.id, done, keys, theme), {
     overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
    });
    return;
   }
  }
 } catch (error) { ctx.ui.notify(error.message, "error"); }
}

export async function runSubagentWatch(argv, paths) {
	let cwd = process.cwd(), stateRoot = paths.stateRoot, selector;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--workspace" || argv[i] === "--state-dir") {
			const flag = argv[i], value = argv[++i];
			if (!value) throw new Error(`${flag} needs a path`);
			if (flag === "--workspace") cwd = resolve(value); else stateRoot = resolve(value);
		} else if (!selector && !argv[i].startsWith("--")) selector = argv[i];
		else throw new Error("Usage: pi watch [@actor] [--workspace path] [--state-dir path]");
	}
	const client = await createSubagentWatchClient({ cwd, stateRoot });
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		for (const actor of await client.list()) process.stdout.write(subagentWatchLabel(actor) + "\n");
		return;
	}
	const initial = await client.read(selector);
	if (initial.job.nativeTerminal ?? initial.actor.metadata?.nativeTerminal) {
		const { theme } = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
		initTheme();
		const ctx = { ui: { custom: factory => new Promise(done => {
			const picker = new TuiAltScreen(new ProcessTerminal());
			const component = factory(picker, theme, getKeybindings(), value => { picker.stop(); done(value); });
			picker.addChild(component); picker.setFocus(component); picker.start();
		}) } };
		let view = initial;
		while (view) {
			const record = view.job.nativeTerminal ?? view.actor.metadata?.nativeTerminal;
			if (!record) { selector = view.actor.id; break; }
			const target = await attachNativeTerminal(record);
			if (target !== "agents") return;
			selector = await chooseSubagentConversation(ctx, client);
			if (!selector) return;
			view = await client.read(selector);
		}
	}
	initTheme();
	const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const keys = KeybindingsManager.create(paths.agentDir);
	const tui = new TuiAltScreen(new ProcessTerminal());
	await new Promise((done) => {
		const view = new SubagentWatchView(tui, client, selector, () => { tui.stop(); done(); }, keys);
		tui.addChild(view); tui.setFocus(view); tui.start();
	});
}
