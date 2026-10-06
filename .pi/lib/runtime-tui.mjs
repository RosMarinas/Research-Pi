import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FooterDataProvider } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js";
import { setRegisteredThemes, loadThemeFromPath, setThemeJsonValidator } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { validateThemeJson } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js";
import { RuntimeTranscript, RuntimeFooter } from "./runtime-tui-renderers.mjs";
import { RuntimeDockComponent, runtimeDockVisible } from "./runtime-dock-ui.mjs";
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
	setThemeJsonValidator(validateThemeJson);
	const themeDir = fileURLToPath(new URL("../themes/", import.meta.url));
	setRegisteredThemes((await readdir(themeDir)).filter(p => p.endsWith(".json")).map(p => loadThemeFromPath(join(themeDir, p))));
	initTheme(client.state.uiTheme ?? "research-pi", false);
	const tui = new TuiAltScreen(new ProcessTerminal());
	const transcript = new RuntimeTranscript(tui), footerData = new FooterDataProvider(client.state.cwd);
	void client.call("models").then(models => { footerData.setAvailableProviderCount(new Set(models.map(m => m.provider)).size); tui.requestRender(); }).catch(() => {});
	footerData.onBranchChange(() => tui.requestRender());
	const footer = new RuntimeFooter(() => client.state, footerData);
	let dockModel, dockJobs = [], refreshingDock = false;
	const refreshDock = async () => {
		if (refreshingDock || client.socket.destroyed) return; refreshingDock = true;
		const epoch = client.state.sessionEpoch;
		try { const model = await client.call("runtime"), actors = await client.call("actors"); if (epoch !== client.state.sessionEpoch) return; dockModel = model; dockJobs = actors.map(a => ({ ...a.metadata, ...a.action?.metadata, ...a.action, backend: a.backend ?? a.metadata?.backend, role: a.role ?? a.metadata?.role, model: a.model ?? a.metadata?.model, thinking: a.thinking ?? a.metadata?.thinking })); tui.requestRender(); }
		catch { dockModel = undefined; } finally { refreshingDock = false; }
	};
	const dockTimer = setInterval(() => void refreshDock(), 1500); dockTimer.unref(); void refreshDock();
	let ended = false, finish;
	const done = new Promise((resolve) => { finish = resolve; });
	const editor = new CustomEditor(tui, { borderColor: (s) => theme.fg("borderMuted", s), selectList: getSelectListTheme() }, getKeybindings(), { paddingX: 1, embedWorkingStatus: true });
	let offset = 0, panel, notice = "Ctrl+] detach · Ctrl+C interrupt · /help", hiddenThinking = client.state.hideThinking ?? false, dialog, input, select, query = "";
	let nativeHideThinking = hiddenThinking;
	let older = [], loadingOlder = false;
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
	const stop = () => { if (ended) return; ended = true; clearInterval(presence); clearInterval(dockTimer); footerData.dispose(); void client.call("ui.draft", { hasDraft: false }).catch(() => {}); panel?.close?.(); tui.stop(); client.close(); finish(); };
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
		invalidate() { transcript.invalidate(); editor.invalidate(); panel?.invalidate?.(); },
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
			else if (getKeybindings().matches(data, "app.tools.expand")) void call("ui.toolsExpanded", { expanded: !client.state.toolsExpanded });
			else if (getKeybindings().matches(data, "app.thinking.toggle")) { hiddenThinking = !hiddenThinking; transcript.clear(); }
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
			const s = client.state;
			const lines = transcript.render([...older, ...(s.entries ?? [])], s, width, hiddenThinking);
			editor.borderColor = theme.getThinkingBorderColor(s.thinking ?? "off");
			footerData.setCwd(s.cwd); footerData.clearExtensionStatuses();
			for (const [key, value] of Object.entries(s.statuses ?? {})) if (value) footerData.setExtensionStatus(key, value);
			const inputRows = editor.render(width), footerRows = footer.render(width);
			let dock = dockModel && runtimeDockVisible(dockModel, process.env.RESEARCH_PI_UI_RUNTIME_STRIP ?? "auto") ? new RuntimeDockComponent(dockModel, dockJobs, theme, { density: process.env.RESEARCH_PI_UI_DENSITY }).render(width) : [];
			// Keep the editor reachable when the terminal is shortened.
			if (inputRows.length + footerRows.length + dock.length + 3 > tui.terminal.rows) dock = [];
			const hint = notice === "Ctrl+] detach · Ctrl+C interrupt · /help" ? [] : [theme.fg("muted", truncateToWidth(notice, width))];
			const height = Math.max(0, tui.terminal.rows - inputRows.length - footerRows.length - dock.length - hint.length - 1);
			offset = Math.min(offset, Math.max(0, lines.length - height)); const end = Math.max(0, lines.length - offset), body = lines.slice(Math.max(0, end - height), end);
			while (body.length < height) body.unshift("");
			return [...body, ...hint, ...dock, ...inputRows, "", ...footerRows];
		},
	};
	client.on("event", (event) => {
		if (event.type === "state") { if (client.state.sessionEpoch !== epoch) { epoch = client.state.sessionEpoch; older = []; dockModel = undefined; transcript.clear(); closePanel(); void refreshDock(); } syncDialog(); }
		if (event.type === "agent_event" && event.event.type === "message_update") client.state.activeMessage = event.event.message;
		if (event.type === "agent_event" && ["message_end", "agent_end"].includes(event.event.type)) client.state.activeMessage = undefined;
		if (event.type === "view") void openView(event.view, event.params);
		if (event.type === "dialog" || event.type === "dialog_closed") void client.call("state").then((s) => { client.state = s; syncDialog(); tui.requestRender(); });
		if (event.type === "notice") { notice = event.message.split("\n")[0]; if (event.message.includes("\n") || event.message.length > 120) showText("Research Pi", event.message); }
		if (event.type === "auth_event") { notice = event.event.message ?? "Authentication"; showText("Provider authentication", JSON.stringify(event.event, null, 2)); }
		if (event.type === "tools_expanded") { client.state.toolsExpanded = event.expanded; transcript.clear(); }
		if (event.type === "copy") { process.stdout.write("\x1b]52;c;" + Buffer.from(event.text).toString("base64") + "\x07"); notice = "Response copied (if supported by terminal)"; }
		if (event.type === "draft") { editor.setText(event.text); reportDraft(); }
		if (event.type === "state" && client.state.hideThinking !== nativeHideThinking) { nativeHideThinking = client.state.hideThinking; hiddenThinking = nativeHideThinking; transcript.clear(); }
		if (event.type === "theme") { initTheme(event.name, false); transcript.clear(); }
		tui.requestRender();
	});
	client.on("disconnect", () => { client.state = { ...client.state, ready: false, idle: false }; notice = "Runtime disconnected; status unknown · Ctrl+R reconnect · Ctrl+] detach"; tui.requestRender(); });
	let epoch = client.state.sessionEpoch; syncDialog();
	if (client.state.authInfo) showText("Provider authentication", JSON.stringify(client.state.authInfo, null, 2));
	tui.addChild(root); tui.setFocus(root); tui.start();
	process.once("SIGHUP", stop); process.once("SIGTERM", stop);
	try { await done; } finally { process.off("SIGHUP", stop); process.off("SIGTERM", stop); }
}
