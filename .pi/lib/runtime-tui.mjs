import { ProcessTerminal, TuiAltScreen, Input, SelectList, Text, Markdown, matchesKey, truncateToWidth, getKeybindings, fuzzyFilter } from "@earendil-works/pi-tui";
import { CustomEditor, AssistantMessageComponent, UserMessageComponent, initTheme, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { RuntimeClient } from "./runtime-client.mjs";
import { SubagentWatchView } from "./subagent-watch-ui.mjs";
import { RuntimeBoardOverlay } from "./runtime-board-ui.mjs";

const plainText = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");

// A renderer and controller only. No model, extension execution, permissions,
// SessionManager or terminal dimensions are sent to the execution process.
export async function attachRuntimeTui(record) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Attach TUI from a terminal; use pi runtime start for background operation");
	const client = await new RuntimeClient(record.socketPath).connect();
	initTheme(client.state.uiTheme ?? "research-pi", false);
	const tui = new TuiAltScreen(new ProcessTerminal());
	let ended = false, finish;
	const done = new Promise((resolve) => { finish = resolve; });
	const editor = new CustomEditor(tui, { borderColor: (s) => theme.fg("borderMuted", s), selectList: getSelectListTheme() }, getKeybindings(), { paddingX: 1, embedWorkingStatus: true });
	let offset = 0, panel, notice = "Ctrl+] detach · Ctrl+C interrupt · /help", hiddenThinking = client.state.hideThinking ?? false, dialog, input, select, query = "";
	let nativeHideThinking = hiddenThinking;
	let components = new Map(), older = [], loadingOlder = false;
	const call = async (method, params) => { try { return await client.call(method, params); } catch (e) { notice = e.message; tui.requestRender(); } };
	let hasDraft = false;
	const reportDraft = () => { const value = Boolean(editor.getText().trim()); hasDraft = value; void client.call("ui.draft", { hasDraft: value }).catch(() => {}); };
	const presence = setInterval(reportDraft, 15000); presence.unref();
	const closePanel = () => { panel?.close?.(); panel = undefined; tui.requestRender(); };
	function showText(title, text) {
		let scroll = 0; const markdown = new Markdown(text, 1, 0, getMarkdownTheme());
		panel = { focused: true, invalidate: () => markdown.invalidate(),
			render(width) { const rows = markdown.render(width), height = Math.max(1, tui.terminal.rows - 3); scroll = Math.min(scroll, Math.max(0, rows.length - height)); return [theme.bold(title), ...rows.slice(scroll, scroll + height), "PgUp/PgDn scroll · Esc back"]; },
			handleInput(data) { if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { panel = undefined; return; } if (matchesKey(data, "pageDown")) scroll += Math.max(3, tui.terminal.rows - 6); if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - Math.max(3, tui.terminal.rows - 6)); },
		};
	}
	const stop = () => { if (ended) return; ended = true; clearInterval(presence); void client.call("ui.draft", { hasDraft: false }).catch(() => {}); panel?.close?.(); tui.stop(); client.close(); finish(); };
	function syncDialog() {
		const next = client.state.dialogs?.[0];
		if (next?.id === dialog?.id) return;
		dialog = next; query = ""; select = undefined; input = new Input({ prompt: "Answer: " }); input.focused = true;
		if (dialog?.kind === "editor") {
			input = new CustomEditor(tui, { borderColor: (s) => theme.fg("borderMuted", s), selectList: getSelectListTheme() }, getKeybindings());
			input.focused = true; input.setText(dialog.placeholder ?? "");
			input.onSubmit = (value) => void call("dialog.answer", { id: dialog.id, value });
		}
		if (dialog?.kind === "select" || dialog?.kind === "confirm") buildSelect();
	}
	function buildSelect() {
		const options = dialog.kind === "confirm" ? ["Allow", "Deny"] : dialog.options;
		select = new SelectList(fuzzyFilter(options.map((x) => ({ value: x, label: x })), query, (x) => x.label), 7, getSelectListTheme());
		select.onSelect = ({ value }) => void call("dialog.answer", { id: dialog.id, value: dialog.kind === "confirm" ? value === "Allow" : value });
		select.onCancel = () => void call("dialog.answer", { id: dialog.id, cancelled: true });
	}
	async function openView(view, params = {}) {
		closePanel();
		if (view === "actor") {
			const adapter = { list: () => client.call("actors"), read: (actorId) => client.call("actor.read", { actorId }), send: (actor, message, kind) => client.call("actor.message", { actorId: actor.id, message, kind }) };
			panel = new SubagentWatchView(tui, adapter, params.actorId, () => { panel = undefined; tui.requestRender(); }, getKeybindings(), theme);
		} else if (view === "runtime") {
			const model = params.model ?? await call("runtime"); if (!model) return;
			panel = new RuntimeBoardOverlay(tui, theme, (result) => { panel = undefined; if (result?.action === "watch") void openView("actor", { actorId: result.selector }); else tui.requestRender(); }, model, () => client.call("runtime"));
		} else if (view === "tree" || view === "fork") {
			const tree = await call("tree"), nodes = [];
			const visit = (rows, depth = 0) => { for (const node of rows ?? []) { const e = node.entry; if (view !== "fork" || e.message?.role === "user") nodes.push({ value: e.id, label: `${"  ".repeat(depth)}${e.type} · ${e.message?.role ?? ""} ${plainText(e.message ?? { content: [] }).slice(0, 80)}` }); visit(node.children, depth + 1); } }; visit(tree);
			const list = new SelectList(nodes, Math.max(3, tui.terminal.rows - 6), getSelectListTheme());
			list.onSelect = ({ value }) => { panel = undefined; void call(view === "fork" ? "session.fork" : "session.tree", { entryId: value }).then((result) => { if (result?.selectedText) { editor.setText(result.selectedText); reportDraft(); } }); };
			list.onCancel = () => { panel = undefined; tui.requestRender(); };
			panel = { focused: true, render: (width) => [theme.bold(view), ...list.render(width), "Esc back"], handleInput: (data) => list.handleInput(data), invalidate() {} };
		}
		tui.requestRender();
	}
	editor.onSubmit = (text) => {
		if (!text.trim()) return;
		editor.addToHistory(text); editor.setText(""); reportDraft(); offset = 0;
		void call("prompt", { message: text, behavior: "followUp" });
	};
	editor.onCtrlD = stop;
	editor.onEscape = () => { editor.setText(""); tui.requestRender(); };
	const root = {
		get focused() { return true; }, set focused(value) { editor.focused = value; },
		invalidate() { for (const c of components.values()) c.invalidate?.(); editor.invalidate(); panel?.invalidate?.(); },
		handleInput(data) {
			if (data.includes("\x1d")) { stop(); return; }
			if (matchesKey(data, "ctrl+r") && client.socket.destroyed) { void client.connect().then(() => { notice = "Runtime reconnected"; syncDialog(); tui.requestRender(); }, (e) => { notice = e.message; tui.requestRender(); }); return; }
			if (dialog) {
				if (matchesKey(data, "escape")) { void call("dialog.answer", { id: dialog.id, cancelled: true }); return; }
				if (dialog.kind === "editor") input.handleInput(data);
				else if (select && ["up", "down", "enter"].some((key) => matchesKey(data, key))) select.handleInput(data);
				else if (matchesKey(data, "enter")) void call("dialog.answer", { id: dialog.id, value: input.getValue() });
				else { input.handleInput(data); query = input.getValue(); if (["select", "confirm"].includes(dialog.kind)) buildSelect(); }
				tui.requestRender(); return;
			}
			if (panel) { panel.handleInput(data); tui.requestRender(); return; }
			if (matchesKey(data, "ctrl+c")) { if (editor.getText()) editor.setText(""); else void call("abort"); }
			else if (matchesKey(data, "alt+enter")) { const text = editor.getText(); if (text.trim()) { editor.addToHistory(text); editor.setText(""); void call("prompt", { message: text, behavior: "steer" }); } }
			else if (matchesKey(data, "ctrl+p")) void call("prompt", { message: "/model" });
			else if (matchesKey(data, "ctrl+e")) void call("ui.toolsExpanded", { expanded: !client.state.toolsExpanded });
			else if (matchesKey(data, "ctrl+o")) { hiddenThinking = !hiddenThinking; components.clear(); }
			else if (matchesKey(data, "pageUp")) { offset += Math.max(5, tui.terminal.rows - 12); if (!loadingOlder && older.length + client.state.entries.length < client.state.historyCount) {
				loadingOlder = true; const count = Math.max(0, client.state.historyCount - client.state.entries.length - older.length), start = Math.max(0, count - 100);
				void call("history", { offset: start, limit: count - start }).then((rows) => { if (rows) older = [...rows, ...older]; }).finally(() => { loadingOlder = false; tui.requestRender(); });
			} }
			else if (matchesKey(data, "pageDown")) offset = Math.max(0, offset - Math.max(5, tui.terminal.rows - 12));
			else editor.handleInput(data);
			if (Boolean(editor.getText().trim()) !== hasDraft) reportDraft();
			tui.requestRender();
		},
		handleMouse(event) { if (dialog) return { handled: false }; if (panel?.handleMouse) return panel.handleMouse(event); if (event.type === "wheel") { offset = Math.max(0, offset - (event.wheelDelta ?? 0)); tui.requestRender(); return { handled: true }; } return { handled: false }; },
		render(width) {
			if (dialog) {
				const rows = [theme.bold(dialog.title), ...(dialog.message ? new Text(dialog.message, 0, 0).render(width) : []), ""];
				rows.push(...(dialog.secret ? ["Answer: " + "•".repeat(input.getValue().length)] : input.render(width)));
				if (["select", "confirm"].includes(dialog.kind)) rows.push(...select.render(width));
				rows.push("Enter answer · Esc cancel · Ctrl+] detach (request stays pending)"); return rows;
			}
			if (panel) return panel.render(width);
			const s = client.state, lines = [], next = new Map();
			for (const entry of [...older, ...(s.entries ?? [])]) {
				const m = entry.message ?? { role: "custom", content: entry.content };
				const key = entry.id, cached = components.get(key); let component;
				if (m.role === "assistant") component = cached ?? new AssistantMessageComponent(m, hiddenThinking);
				else if (m.role === "user") component = cached ?? new UserMessageComponent(plainText(m));
				else component = cached ?? new Markdown(`${m.toolName ? `**${m.toolName}**\n\n` : ""}${(m.role === "toolResult" || entry.customType === "research-side") && !s.toolsExpanded ? plainText(m).split("\n").slice(0, 3).join("\n") : plainText(m)}`, 1, 0, getMarkdownTheme());
				next.set(key, component); lines.push(...component.render(width), "");
			}
			components = next;
			if (s.activeMessage) lines.push(...new AssistantMessageComponent(s.activeMessage, hiddenThinking).render(width));
			const inputRows = editor.render(width), head = [theme.bold("Research Pi · " + s.cwd), theme.fg("muted", `${s.model?.provider}/${s.model?.id} · ${s.thinking} · ${s.idle ? "idle" : "running"} · queued ${s.queue ?? 0}`)];
			const height = Math.max(0, tui.terminal.rows - inputRows.length - head.length - 2);
			offset = Math.min(offset, Math.max(0, lines.length - height)); const end = Math.max(0, lines.length - offset), body = lines.slice(Math.max(0, end - height), end);
			while (body.length < height) body.unshift("");
			return [...head.map((x) => truncateToWidth(x, width)), ...body, theme.fg("muted", truncateToWidth(notice, width)), ...inputRows, ""];
		},
	};
	client.on("event", (event) => {
		if (event.type === "state") { if (client.state.sessionEpoch !== epoch) { epoch = client.state.sessionEpoch; older = []; components.clear(); closePanel(); } syncDialog(); }
		if (event.type === "view") void openView(event.view, event.params);
		if (event.type === "dialog" || event.type === "dialog_closed") void client.call("state").then((s) => { client.state = s; syncDialog(); tui.requestRender(); });
		if (event.type === "notice") { notice = event.message.split("\n")[0]; if (event.message.includes("\n") || event.message.length > 120) showText("Research Pi", event.message); }
		if (event.type === "auth_event") { notice = event.event.message ?? "Authentication"; showText("Provider authentication", JSON.stringify(event.event, null, 2)); }
		if (event.type === "tools_expanded") { client.state.toolsExpanded = event.expanded; components.clear(); }
		if (event.type === "copy") { process.stdout.write("\x1b]52;c;" + Buffer.from(event.text).toString("base64") + "\x07"); notice = "Response copied (if supported by terminal)"; }
		if (event.type === "draft") { editor.setText(event.text); reportDraft(); }
		if (event.type === "state" && client.state.hideThinking !== nativeHideThinking) { nativeHideThinking = client.state.hideThinking; hiddenThinking = nativeHideThinking; components.clear(); }
		if (event.type === "theme") { initTheme(event.name, false); components.clear(); }
		tui.requestRender();
	});
	client.on("disconnect", () => { client.state = { ...client.state, ready: false, idle: false }; notice = "Runtime disconnected; status unknown · Ctrl+R reconnect · Ctrl+] detach"; tui.requestRender(); });
	let epoch = client.state.sessionEpoch; syncDialog();
	if (client.state.authInfo) showText("Provider authentication", JSON.stringify(client.state.authInfo, null, 2));
	tui.addChild(root); tui.setFocus(root); tui.start();
	process.once("SIGHUP", stop); process.once("SIGTERM", stop);
	try { await done; } finally { process.off("SIGHUP", stop); process.off("SIGTERM", stop); }
}
