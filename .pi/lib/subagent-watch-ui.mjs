import { Editor, ProcessTerminal, TuiAltScreen, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { createSubagentWatchClient, openSubagentTerminal, subagentWatchLabel, subagentWatchTranscript } from "./subagent-watch.mjs";
import { HARNESS_ROOT } from "./codex-jobs.mjs";
import { resolveResearchPiPaths } from "./runtime-paths.mjs";

export class SubagentWatchView {
	constructor(tui, client, selector, done) {
		this.tui = tui; this.client = client; this.selector = selector; this.done = done;
		this.offset = 0; this.notice = "Connecting to the existing subagent…"; this.closed = false;
		this.components = new Map();
		this.editor = new Editor(tui, { borderColor: getMarkdownTheme().hr, selectList: getSelectListTheme() }, { paddingX: 1 });
		this.editor.onSubmit = (text) => { void this.submit(text); };
		this.timer = setInterval(() => { void this.refresh(); }, 750);
		this.timer.unref();
		void this.refresh();
	}
	get focused() { return this.editor.focused; }
	set focused(value) { this.editor.focused = value; }
	async refresh() {
		if (this.closed || this.refreshing) return;
		this.refreshing = true;
		try {
			this.view = await this.client.read(this.selector);
			this.selector = this.view.actor.id;
			if (this.notice === "Connecting to the existing subagent…") this.notice = "Watching the existing subagent; messages are sent as User, not as Leader.";
			this.error = null;
		} catch (error) { this.error = error.message; }
		finally { this.refreshing = false; if (!this.closed) this.tui.requestRender(); }
	}
	async submit(text) {
		if (!text.trim() || !this.view || this.sending) return;
		if (text.trim() === "/back" || text.trim() === "/quit") { this.close(); return; }
		this.sending = true;
		try {
			const match = text.trim().match(/^\/(ask|reply|steer)\s+([\s\S]+)$/);
			if (text.trim().startsWith("/") && !match) throw new Error("Enter a message, /ask, /reply, /steer, or /back");
			const receipt = await this.client.send(this.view.actor, match ? match[2] : text, match?.[1] ?? (this.view.job.status === "input_required" ? "reply" : "notify"));
			this.notice = `Queued ${receipt.id}; receipt updates when the backend accepts it.`;
			this.editor.setText(""); this.offset = 0;
			await this.refresh();
		} catch (error) { this.notice = error.message; }
		finally { this.sending = false; this.tui.requestRender(); }
	}
	handleInput(data) {
		if (matchesKey(data, "ctrl+d") || (matchesKey(data, "escape") && !this.editor.getText())) return this.close();
		if (matchesKey(data, "pageUp")) this.offset += Math.max(5, this.tui.terminal.rows - 12);
		else if (matchesKey(data, "pageDown")) this.offset = Math.max(0, this.offset - Math.max(5, this.tui.terminal.rows - 12));
		else if (matchesKey(data, "tab") && this.view?.actors.length > 1) {
			const index = this.view.actors.findIndex((actor) => actor.id === this.selector);
			this.selector = this.view.actors[(index + 1) % this.view.actors.length].id;
			this.offset = 0; void this.refresh();
		} else this.editor.handleInput(data);
		this.tui.requestRender();
	}
	render(width) {
		const theme = getMarkdownTheme();
		const view = this.view;
		const header = view ? `[${view.actor.backend ?? view.actor.provider} · ${view.actor.role ?? view.actor.metadata?.role}] ${view.actor.metadata?.mission ?? view.actor.label}` : "Research Pi · Subagent";
		const detail = view ? `${view.job.model ?? view.actor.model ?? "inherit"} · thinking ${view.job.thinking ?? view.job.reasoningEffort ?? "inherit"} · ${view.job.status} · ${view.actor.id}` : this.notice;
		const editor = this.editor.render(width);
		const lines = [], components = new Map();
		for (const row of view ? subagentWatchTranscript(view) : []) {
			if (row.label) lines.push(theme.quote(row.label));
			const key = `${row.kind}:${row.text}`;
			const component = this.components.get(key) ?? (row.kind === "user" ? new UserMessageComponent(row.text)
				: row.kind === "assistant" ? new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: row.text }], stopReason: "stop" }, true)
					: new UserMessageComponent(`**Tool / activity**\n\n${row.text}`));
			components.set(key, component);
			lines.push(...component.render(width), "");
		}
		this.components = components;
		const height = Math.max(1, this.tui.terminal.rows - editor.length - 6);
		this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
		const end = Math.max(0, lines.length - this.offset);
		const body = lines.slice(Math.max(0, end - height), end);
		while (body.length < height) body.unshift("");
		return [theme.bold(header), detail, theme.hr("─".repeat(Math.max(1, width))), ...body,
			this.error ?? (view?.leaderConnected ? this.notice : "Owning Leader disconnected; messages remain queued. No model is started by this viewer."),
			"Enter send · /ask /reply /steer · Tab agent · PgUp/Dn · Esc back", ...editor,
		].map((line) => truncateToWidth(line, width));
	}
	invalidate() { this.editor.invalidate(); for (const component of this.components.values()) component.invalidate(); }
	close() { if (this.closed) return; this.dispose(); this.done(); }
	dispose() { this.closed = true; clearInterval(this.timer); }
}

export async function openSubagentWatch(ctx, selector = "") {
	try {
		const paths = resolveResearchPiPaths({ harnessRoot: HARNESS_ROOT });
		const client = await createSubagentWatchClient({ cwd: ctx.cwd, stateRoot: paths.stateRoot });
		const actors = await client.list();
		if (!actors.length) { ctx.ui.notify("No subagent is registered in this workspace.", "info"); return; }
		if (!selector) {
			const labels = actors.map(subagentWatchLabel);
			const chosen = await ctx.ui.select("Subagents — choose a conversation", labels);
			if (!chosen) return;
			selector = actors[labels.indexOf(chosen)].id;
		}
		const { actor } = await client.read(selector);
		const mode = await ctx.ui.select("Subagent terminal", ["Switch in this terminal", "Open a new terminal"]);
		if (!mode) return;
		if (mode === "Open a new terminal") {
			const result = await openSubagentTerminal({ launcher: join(HARNESS_ROOT, "bin", "pi.mjs"), cwd: ctx.cwd, stateRoot: paths.stateRoot, actorId: actor.id });
			ctx.ui.notify(result.opened ? "Subagent terminal opened. The Leader continues here."
				: `Could not open a terminal automatically. Run this in another shell:\n${result.command}`, result.opened ? "info" : "warning");
		} else await ctx.ui.custom((tui, _theme, _keys, done) => new SubagentWatchView(tui, client, actor.id, done));
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
	await client.read(selector); // Surface an invalid workspace/selector before taking the terminal.
	initTheme();
	const tui = new TuiAltScreen(new ProcessTerminal());
	await new Promise((done) => {
		const view = new SubagentWatchView(tui, client, selector, () => { tui.stop(); done(); });
		tui.addChild(view); tui.setFocus(view); tui.start();
	});
}
