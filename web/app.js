import { renderTimeline } from "/timeline.js";
import { marked } from "/vendor/marked.js";
const $ = (id) => document.getElementById(id);
const uiClientId = sessionStorage.getItem("rpi_ui_client") ?? crypto.randomUUID(); sessionStorage.setItem("rpi_ui_client", uiClientId);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (value) => DOMPurify.sanitize(marked.parse(String(value ?? ""), { breaks: true }));
let state = { ready: false }, socket, reconnectTimer, activeTab = "chat", selectedActor, activeDialog, images = [], models = [], stream = "", olderEntries = [], sessionsEpoch, navigating = false;
let ctrlLatch = false, streamTimer, pendingSend, pendingActorSend, lastActorReceipt, lastActors = "";
let terminal, fit, terminalSeq = 0, paired = false, toastTimer, lastMessages = "", busySending = false, terminalFitTimer;
let lastEventSeq = 0, lastHostEpoch, draftRevision = 0;
let harness = false, projects = [], activeProject, projectSelection = 0, lastProjects = "";
const projectDrafts = new Map();
const unreadDialogs = new Map();
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, 5500); }
async function jsonFetch(path, options = {}) {
	const response = await fetch(path, { credentials: "same-origin", ...options });
	const data = await response.json();
	if (!response.ok || !data.ok) {
		if (response.status === 401 && path !== "/api/login") showPair();
		throw Object.assign(new Error(data.error || "连接失败"), { responded: true });
	}
	return data.result ?? data;
}
async function command(method, params = {}, id = crypto.randomUUID()) {
	const project = activeProject;
	const result = await jsonFetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, method, params, projectId: project, sessionId: state.sessionId, sessionEpoch: state.sessionEpoch, uiClientId }) });
	if (harness && !["projects", "project.add"].includes(method) && project !== activeProject) throw Object.assign(new Error("项目已切换；操作仍属于原项目"), { responded: true, superseded: true });
	return result;
}
function showPair() { paired = false; clearTimeout(reconnectTimer); socket?.close(); $("pair").hidden = false; $("app").hidden = true; }
async function login(token) {
	await jsonFetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	$("token").value = "";
	history.replaceState(null, "", location.pathname + location.search);
	await enter();
}
async function enter() {
	paired = true; $("pair").hidden = true; $("app").hidden = false;
	const initial = await jsonFetch("/api/session");
	if (initial.harness) {
		harness = true; renderProjects(initial.projects ?? []);
		const requested = new URLSearchParams(location.search).get("project") ?? sessionStorage.getItem("rpi_project");
		await selectProject(projects.some((p) => p.id === requested) ? requested : undefined);
	} else updateState(initial);
	connect();
}
function updateConnection(connected) { $("send").disabled = !connected || !state.ready || busySending; $("connection").classList.toggle("live", connected); $("connection").querySelector("span").textContent = connected ? "已连接" : "正在重连"; }
function connect() {
	clearTimeout(reconnectTimer);
	if (!paired) return;
	socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
	socket.onopen = async () => { updateConnection(true); try { updateState(await jsonFetch(sessionEndpoint())); } catch (error) { toast(error.message); } };
	socket.onclose = () => {
		updateConnection(false);
		if (paired) reconnectTimer = setTimeout(async () => {
			try { updateState(await jsonFetch(sessionEndpoint())); if (paired) connect(); }
			catch { if (paired) reconnectTimer = setTimeout(connect, 3000); }
		}, 1800);
	};
	socket.onerror = () => socket.close();
	socket.onmessage = ({ data }) => {
		const event = JSON.parse(data);
		if (event.type === "projects") { renderProjects(event.projects); return; }
		if (harness && !event.projectId && event.type === "state") { renderProjects(event.state.projects ?? projects); return; }
		if (harness && event.projectId !== activeProject) return;
		if (event.hostEpoch && event.hostEpoch !== lastHostEpoch) { lastHostEpoch = event.hostEpoch; lastEventSeq = 0; }
		if (event.seq != null) lastEventSeq = Math.max(lastEventSeq, event.seq);
		if (event.targetClientId && event.targetClientId !== uiClientId) return;
		if (event.type === "state") updateState({ ...event.state, ...(event.seq != null ? { seq: event.seq } : {}), ...(harness ? { harness: true, projectId: event.projectId } : {}) });
		if (event.type === "terminal_snapshot") { initTerminal(); terminal.reset(); terminal.resize(event.cols, event.rows); terminal.write(event.data); terminalSeq = event.seq; }
		if (event.type === "terminal" && event.seq > terminalSeq) { terminalSeq = event.seq; terminal?.write(event.data); }
		if (event.type === "terminal_resize") terminal?.resize(event.cols, event.rows);
		if (event.type === "dialog") { unreadDialogs.set(event.request.id, event.request); showPending(); }
		if (event.type === "dialog_closed") { unreadDialogs.delete(event.id); if (activeDialog?.id === event.id) { $("approval").close(); activeDialog = null; } showPending(); }
		if (event.type === "notice") toast(event.message);
		if (event.type === "status") { state.statuses ??= {}; state.statuses[event.key] = event.value; renderRunState(); }
		if (event.type === "agent_event") agentEvent(event.event);
		if (event.type === "view") {
			if (event.view === "runtime") switchTab("project");
			else if (event.view === "actor") { selectedActor = event.params.actorId; switchTab("agents").then(loadActor); }
			else if (["tree", "fork"].includes(event.view)) openTree(event.view);
		}
		if (event.type === "shell") appendOperation(event.text);
		if (event.type === "notice") appendOperation(event.message);
		if (event.type === "auth_event") renderAuth(event.event);
		if (event.type === "tools_expanded") { state.toolsExpanded = event.expanded; lastMessages = ""; renderMessages(); }
		if (event.type === "draft") { draftRevision++; $("message").value = event.text; reportDraft(); }
		if (event.type === "copy") navigator.clipboard?.writeText(event.text).then(() => toast("已复制"), () => appendOperation(event.text));
	};
}
function renderRunState() {
	const status = !state.ready ? "等待 Pi" : (state.nativePrompt || state.dialogs?.length || unreadDialogs.size) ? "等待操作" : state.idle ? "就绪" : "处理中";
	$("run-state").textContent = status + (state.statuses?.boundary ? " · " + state.statuses.boundary : "");
}
function updateState(next) {
	if (harness && next.projectId !== activeProject) return;
	if (next.hostEpoch && next.hostEpoch !== lastHostEpoch) { lastHostEpoch = next.hostEpoch; lastEventSeq = 0; }
	if (next.seq != null && next.seq < lastEventSeq) return;
	if (next.seq != null) lastEventSeq = next.seq;
	if (next.hostEpoch === state.hostEpoch && next.seq != null && next.seq < (state.seq ?? 0)) return;
	if (next.sessionId && (next.sessionId !== state.sessionId || next.sessionEpoch !== state.sessionEpoch)) { stream = ""; lastMessages = ""; olderEntries = []; selectedActor = null; $("actor-detail").hidden = true; $("agents-view").classList.remove("watching"); }
	state = next;
	$("app").classList.toggle("runtime-layout", next.detachedRuntime === true || harness);
	if (next.detachedRuntime) {
		$("session-sidebar").hidden = false;
		$("runtime-controls").hidden = false;
		for (const selector of [".terminal-actions", "#terminal", ".keybar", ".terminal-input", ".terminal-note"]) document.querySelector(selector).hidden = true;
		$("terminal-tab").hidden = true; $("chat-command-buttons").hidden = false;
		if (next.ready && sessionsEpoch !== next.sessionEpoch) { sessionsEpoch = next.sessionEpoch; loadSessions().catch((e) => toast(e.message)); }
		stream = next.activeMessage?.content?.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
		renderAuth(next.authInfo);
	}
	$("workspace").textContent = harness && !activeProject ? "所有研究项目" : next.cwd?.split("/").filter(Boolean).slice(-2).join(" / ") ?? "Pi 正在切换会话";
	$("model-label").textContent = next.model ? next.model.provider + " / " + (next.model.name || next.model.id) + " · " + next.thinking : "等待 Pi";
	renderRunState(); updateNavigation(); $("settings-button").disabled = harness && !next.ready; $("stop-project").hidden = !harness || !next.ready;
	$("workspace-stopped").hidden = !harness || !activeProject || next.ready || !next.stopped;
	renderUsage();
	$("abort").hidden = !next.ready || next.idle;
	$("send").disabled = !next.ready || busySending;
	if (next.idle) { stream = ""; $("activity").hidden = true; }
	unreadDialogs.clear(); for (const request of next.dialogs ?? []) unreadDialogs.set(request.id, request);
	if (activeDialog && !unreadDialogs.has(activeDialog.id)) { $("approval").close(); activeDialog = null; }
	showPending(); renderMessages();
}
function contentHtml(message) {
	if (typeof message.content === "string") return md(message.content);
	return (message.content ?? []).map((part) => {
		if (part.type === "text") return md(part.text);
		if ((part.type === "thinking" || part.type === "reasoning") && state.hideThinking) return "";
		if (part.type === "thinking" || part.type === "reasoning") return "<details><summary>思考过程</summary><div>" + md(part.thinking ?? part.text) + "</div></details>";
		if (part.type === "toolCall" || part.type === "tool_call") return "<details><summary>" + escape(part.name) + "</summary><pre>" + escape(JSON.stringify(part.arguments, null, 2)) + "</pre></details>";
		if (part.type === "image" && part.data && /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType)) return '<img alt="对话图片" src="data:' + part.mimeType + ";base64," + escape(part.data) + '">';
		return "";
	}).join("");
}
function renderMessages() {
	const entries = [...olderEntries, ...(state.entries ?? [])];
	const messages = entries.filter((entry) => (entry.type === "message" && !["system", "developer"].includes(entry.message?.role)) || (entry.type === "custom_message" && entry.display !== false)).map((entry) => entry.message ?? entry);
	const signature = JSON.stringify(messages) + JSON.stringify(state.liveTools) + JSON.stringify(state.activeMessage) + stream + Boolean(state.hideThinking) + Boolean(state.toolsExpanded);
	if (signature === lastMessages) return;
	lastMessages = signature;
	const el = $("messages"), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
	const expandedIds = [...el.querySelectorAll("[data-tool-call] details[open]")].map((node) => node.closest("[data-tool-call]").dataset.toolCall);
	el.innerHTML = (state.detachedRuntime && entries.length < state.historyCount ? '<button id="older-history" class="quiet">加载更早的对话</button>' : "") + renderTimeline(entries, { escape, md, activeMessage: state.activeMessage, liveTools: state.liveTools, hiddenThinking: state.hideThinking, expanded: state.toolsExpanded });
	for (const card of el.querySelectorAll("[data-tool-call]")) if (expandedIds.includes(card.dataset.toolCall)) card.querySelector("details").open = true;
	el.querySelectorAll("[data-watch]").forEach((button) => button.onclick = () => { selectedActor = button.dataset.watch; switchTab("agents").then(loadActor).catch((e) => toast(e.message)); });
	if (!el.innerHTML) el.innerHTML = '<div class="empty"><h2>把研究继续下去。</h2><p>同一个项目，同一个 Pi。</p></div>';
	el.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
	const older = $("older-history"); if (older) older.onclick = async () => {
		const remaining = state.historyCount - entries.length, start = Math.max(0, remaining - 100);
		try { olderEntries = [...await command("history", { offset: start, limit: remaining - start }), ...olderEntries]; lastMessages = ""; renderMessages(); }
		catch (e) { toast(e.message); }
	};
	if (atBottom) el.scrollTop = el.scrollHeight;
}
function renderStream() {
	if (state.detachedRuntime) { renderMessages(); return; }
	if (!stream) return;
	const el = $("messages"), bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
	let row = document.getElementById("stream-message");
	if (!row) { row = document.createElement("article"); row.id = "stream-message"; row.className = "message assistant"; el.append(row); }
	row.innerHTML = '<div class="message-label">Pi · 正在回复</div>' + md(stream);
	if (bottom) el.scrollTop = el.scrollHeight;
}
function agentEvent(event) {
	if (state.detachedRuntime && event.type === "message_update") state.activeMessage = event.message;
	if (state.detachedRuntime && event.type === "agent_settled") loadSessions().catch((error) => toast(error.message));
	if (event.type === "message_end") { stream = ""; clearTimeout(streamTimer); document.getElementById("stream-message")?.remove(); }
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update?.type === "text_delta") { stream = event.message?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? (stream + update.delta); clearTimeout(streamTimer); streamTimer = setTimeout(renderStream, 60); }
	}
	if (event.type === "tool_execution_start") { $("activity").textContent = "正在执行 · " + event.toolName; $("activity").hidden = false; }
	if (event.type === "tool_execution_end") $("activity").textContent = event.isError ? "工具返回错误" : "工具执行完成";
}
function showPending() {
	const count = unreadDialogs.size;
	renderRunState();
	$("pending-banner").hidden = !count && (!state.nativePrompt || activeTab === "terminal");
	$("pending-banner").querySelector("span").textContent = count ? "有 " + count + " 项等待你回答" : "Pi 正在等待终端操作";
	if (count && !activeDialog && !$("settings").open) openPending();
}
function openPending() {
	const request = unreadDialogs.values().next().value;
	if (!request) { switchTab(state.detachedRuntime ? "chat" : "terminal"); return; }
	activeDialog = request;
	$("approval-title").textContent = request.title;
	$("approval-message").textContent = request.message ?? "";
	$("approval-fields").replaceChildren();
	if (request.kind === "select") {
		const select = document.createElement("select"); select.id = "approval-value"; select.setAttribute("aria-label", "选择");
		for (const value of request.options) { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); }
		$("approval-fields").append(select);
		if (request.searchable) {
			const search = document.createElement("input"); search.placeholder = "搜索选项…"; search.setAttribute("aria-label", "搜索选项");
			search.oninput = () => { select.replaceChildren(); for (const value of request.options.filter((v) => v.toLowerCase().includes(search.value.toLowerCase()))) { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); } };
			$("approval-fields").prepend(search);
		}
	} else if (request.kind === "input" || request.kind === "editor") {
		const input = document.createElement(request.kind === "editor" ? "textarea" : "input"); input.id = "approval-value"; input.placeholder = request.placeholder ?? ""; if (request.kind === "editor") input.value = request.placeholder ?? ""; if (request.secret) input.type = "password"; input.autocomplete = "off"; input.setAttribute("aria-label", "回答"); $("approval-fields").append(input);
	}
	$("approval-submit").textContent = request.kind === "confirm" ? "允许" : "提交";
	$("approval-cancel").textContent = request.kind === "confirm" ? "拒绝" : "取消";
	if (!$("approval").open) $("approval").showModal();
}
async function answer(cancelled) {
	if (!activeDialog) return;
	const id = activeDialog.id, value = activeDialog.kind === "confirm" ? !cancelled : $("approval-value")?.value;
	try { await command("dialog.answer", { id, value, cancelled }); }
	catch (error) { toast(error.message); }
}
async function switchTab(tab) {
	activeTab = tab;
	showPending();
	for (const button of $("tabs").children) button.classList.toggle("active", button.dataset.tab === tab);
	for (const id of ["chat", "agents", "project", "terminal"]) $(id + "-view").hidden = id !== tab;
	try {
		if (tab === "agents") await loadActors();
		if (tab === "project") await loadProject();
		if (tab === "terminal" && !state.detachedRuntime) { initTerminal(); terminal.refresh(0, terminal.rows - 1); requestAnimationFrame(fitTerminal); }
	} catch (error) { toast(error.message); }
}
async function nativeCommand(value) {
	if (!value) return;
	if (state.detachedRuntime) { try { await command("prompt", { message: value }); return true; } catch (e) { toast(e.message); return false; } }
	try { await command("terminal.command", { command: value }); await switchTab("terminal"); return true; }
	catch (error) { toast(error.message); await switchTab("terminal"); }
}
async function loadActors() {
	const actors = await command("actors");
	const signature = JSON.stringify(actors);
	if (signature !== lastActors) {
	lastActors = signature;
	$("actors").innerHTML = actors.length ? actors.map((actor, index) => {
		const status = actor.action?.status ?? "registered";
		const role = actor.role ?? actor.metadata?.role ?? "";
		const model = actor.model ?? "inherit";
		const backend = actor.backend ?? actor.provider ?? "";
		return '<button class="actor-card" data-index="' + index + '"><span class="tag">' + escape(status) + "</span><strong>" + escape(actor.label) + "</strong><small>" + escape([role, backend, model, actor.thinking ?? "inherit"].filter(Boolean).join(" · ")) + "</small></button>";
	}).join("") : '<div class="empty">当前项目还没有 subagent。</div>';
	$("actors").querySelectorAll("button").forEach((button) => button.onclick = async () => { selectedActor = actors[button.dataset.index].id; await loadActor(); });
	}
	if (selectedActor) await loadActor(); else $("agents-view").classList.remove("watching");
}
async function loadActor() {
	const view = await command("actor.read", { actorId: selectedActor });
	const receipt = view.messages?.find((message) => message.id === lastActorReceipt);
	if (receipt) $("actor-receipt").textContent = receipt.status + " · " + receipt.id;
	$("agents-view").classList.add("watching"); $("agents-view").scrollTop = 0;
	$("actor-detail").hidden = false; $("actor-title").textContent = view.actor.label;
	const el = $("actor-messages"), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
	const kindLabel = { user: "You", assistant: view.actor.backend ?? view.actor.provider ?? "Agent", tool: "Activity" };
	const html = view.rows.map((row) => {
		const label = row.label ?? kindLabel[row.kind] ?? row.kind;
		const cls = row.kind === "user" ? " user" : row.kind === "assistant" ? " assistant" : "";
		return '<article class="message' + cls + '"><div class="message-label">' + escape(label) + "</div>" + md(row.text) + "</article>";
	}).join("");
	if (el.innerHTML !== html) el.innerHTML = html;
	if (atBottom) el.scrollTop = el.scrollHeight;
}
async function loadProject() {
	const view = await command("runtime");
	if (!view) { $("project-content").textContent = "Runtime 尚未就绪。"; return; }
	const card = (title, content) => '<section class="project-card"><h3>' + escape(title) + '</h3>' + content + '</section>';
	const line = (label, value) => '<p><small>' + escape(label) + '</small><br>' + escape(value || '尚未记录') + '</p>';
	const html =
		card(view.project.name, '<small>' + escape(view.project.root) + '</small>' + line('研究问题', view.research.question) + line('当前判断', view.research.claim) + line('下一步', view.research.nextStep)) +
		card('运行状态', '<p>' + escape(view.counts.active) + ' 个活跃任务 · ' + escape(view.counts.waiting) + ' 个等待输入 · ' + escape(view.counts.openMessages) + ' 条待处理消息</p>' + line('Leader', view.leader.isCurrentSessionAttached ? '当前会话' : '其他会话 / 未连接') + line('建议', view.health.reason) + line('上下文', view.health.percent == null ? '未知' : Math.round(view.health.percent) + '%')) +
		card('近期证据', view.research.recentEvidence.length ? view.research.recentEvidence.map((item) => line(item.validity + ' · ' + item.question, item.conclusion)).join('') : '<small>尚未记录实验结果</small>') +
		card('待处理消息', view.openMessages.length ? view.openMessages.map((item) => line(item.from + ' → ' + item.to + ' · ' + item.status, item.body)).join('') : '<small>没有待处理消息</small>');
	if ($("project-content").innerHTML !== html) $("project-content").innerHTML = html;

}
function initTerminal() {
	if (terminal) return;
	terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "Menlo, Consolas, monospace", theme: { background: "#18201d", foreground: "#e0e8df", cursor: "#91c9ac" }, scrollback: 2000, convertEol: false });
	fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open($("terminal"));
	terminal.onData((data) => terminalInput(data));
	new ResizeObserver(() => { clearTimeout(terminalFitTimer); terminalFitTimer = setTimeout(fitTerminal, 100); }).observe($("terminal"));
}
function terminalInput(data) { if (ctrlLatch && data.length === 1) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); ctrlLatch = false; document.querySelector('[data-key="ctrl"]').classList.remove("active"); } if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ type: "input", data })); return true; } toast("连接断开，按键未发送"); return false; }
function fitTerminal() {
	if (!terminal || activeTab !== "terminal") return;
	const size = fit.proposeDimensions();
	if (size && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: Math.max(20, Math.min(300, size.cols)), rows: Math.max(8, Math.min(150, size.rows)) }));
}
$("pair-form").onsubmit = async (event) => { event.preventDefault(); try { await login($("token").value.trim()); } catch (error) { $("pair-error").textContent = error.message; } };
$("tabs").onclick = (event) => { if (event.target.dataset.tab) switchTab(event.target.dataset.tab); };
$("composer").onsubmit = async (event) => {
	event.preventDefault();
	if (busySending) return;
	const message = $("message").value.trim(), originalDraftRevision = draftRevision;
	if (!message && !images.length) return;
	if (message.startsWith("/") || message.startsWith("!")) { if (await nativeCommand(message) && draftRevision === originalDraftRevision) $("message").value = ""; return; }
	busySending = true; $("send").disabled = true;
	try {
		const params = { message, behavior: $("send-mode").value, images };
		const signature = JSON.stringify({ params, sessionId: state.sessionId });
		if (pendingSend?.signature !== signature) pendingSend = { id: crypto.randomUUID(), signature };
		await command("prompt", params, pendingSend.id);
		pendingSend = null;
		if (draftRevision === originalDraftRevision) $("message").value = ""; reportDraft(); images = []; renderAttachments(); $("composer-status").textContent = "已提交给当前 Pi";
	} catch (error) { if (error.responded) pendingSend = null; toast(error.message); }
	finally { busySending = false; $("send").disabled = !state.ready; }
};
const reportDraft = () => { if (paired && state.detachedRuntime && state.ready) void command("ui.draft", { hasDraft: Boolean($("message").value.trim()) }).catch(() => {}); };
let hadDraft = false;
$("message").oninput = () => { const value = Boolean($("message").value.trim()); if (value !== hadDraft) { hadDraft = value; reportDraft(); } };
setInterval(reportDraft, 15000);
$("message").onkeydown = (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); } };
$("abort").onclick = () => command("abort").catch((error) => toast(error.message));
$("pending-open").onclick = openPending;
$("approval-form").onsubmit = (event) => { event.preventDefault(); answer(false); };
$("approval-cancel").onclick = () => answer(true);
$("approval").oncancel = (event) => { event.preventDefault(); answer(true); };
$("refresh-agents").onclick = () => loadActors().catch((error) => toast(error.message));
$("close-actor").onclick = () => { selectedActor = null; $("actor-detail").hidden = true; $("agents-view").classList.remove("watching"); };
$("actor-form").onsubmit = async (event) => {
	event.preventDefault();
	const button = $("actor-form").querySelector("button"); button.disabled = true;
	try {
		const params = { actorId: selectedActor, body: $("actor-input").value, kind: $("actor-kind").value };
		const signature = JSON.stringify({ params, sessionId: state.sessionId });
		if (pendingActorSend?.signature !== signature) pendingActorSend = { id: crypto.randomUUID(), signature };
		const receipt = await command("actor.send", params, pendingActorSend.id);
		pendingActorSend = null; lastActorReceipt = receipt.id;
		$("actor-input").value = ""; $("actor-receipt").textContent = receipt.status + " · " + receipt.id;
		await loadActor();
	} catch (error) { if (error.responded) pendingActorSend = null; toast(error.message); } finally { button.disabled = false; }
};
$("runtime-terminal").onclick = () => nativeCommand("/runtime");
$("terminal-command").onchange = async (event) => { const value = event.target.value; event.target.value = ""; await nativeCommand(value); };
$("fit-terminal").onclick = fitTerminal;
const keys = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", pageup: "\x1b[5~", pagedown: "\x1b[6~", altenter: "\x1b\r", ctrlc: "\x03", enter: "\r" };
document.querySelector(".keybar").onclick = (event) => { if (event.target.dataset.key === "ctrl") { ctrlLatch = !ctrlLatch; event.target.classList.toggle("active", ctrlLatch); terminal?.focus(); return; } const data = keys[event.target.dataset.key]; if (data) terminalInput(data); };
$("terminal-input-form").onsubmit = (event) => { event.preventDefault(); if (terminalInput("\x1b[200~" + $("terminal-input").value + "\x1b[201~\r")) $("terminal-input").value = ""; };
$("settings-button").onclick = async () => {
	try {
		models = await command("models");
		$("model-select").replaceChildren(...models.map((model, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = model.provider + " / " + (model.name || model.id); option.selected = model.id === state.model?.id && model.provider === state.model?.provider; return option; }));
		$("thinking-select").value = state.thinking ?? "off"; $("settings").showModal();
	} catch (error) { toast(error.message); }
};
$("save-model").onclick = async () => {
	try {
		const model = models[Number($("model-select").value)]; if (model) await command("model.set", { provider: model.provider, id: model.id });
		await command("thinking.set", { level: $("thinking-select").value }); $("settings").close();
	} catch (error) { toast(error.message); }
};
$("settings-close").onclick = () => { $("settings").close(); showPending(); };
$("full-config").onclick = () => { $("settings").close(); nativeCommand("/config"); };
$("logout").onclick = async () => { await jsonFetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); $("settings").close(); showPair(); };
function renderAttachments() {
	$("attachments").innerHTML = images.map((image, index) => '<div class="attachment"><img alt="附件" src="data:' + image.mimeType + ";base64," + image.data + '"><button type="button" data-remove="' + index + '" aria-label="移除图片">×</button></div>').join("");
}
$("attachments").onclick = (event) => { if (event.target.dataset.remove !== undefined) { images.splice(Number(event.target.dataset.remove), 1); renderAttachments(); } };
$("image-input").onchange = async (event) => {
	for (const file of event.target.files) {
		if (images.length >= 4 || file.size > 3_500_000) { toast("最多 4 张图片，每张小于 3.5 MB"); break; }
		if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) continue;
		if (images.reduce((size, image) => size + image.data.length, 0) + Math.ceil(file.size / 3) * 4 > 6_000_000) { toast("图片总大小需小于 4.5 MB"); break; }
		const data = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.readAsDataURL(file); });
		images.push({ mimeType: file.type, data });
	}
	event.target.value = ""; renderAttachments();
};
function appendOperation(message) {
	const row = document.createElement("details"); row.className = "operation-entry"; const summary = document.createElement("summary"); summary.textContent = String(message).split("\n")[0].slice(0, 120); const body = document.createElement("div"); body.innerHTML = md(message); row.append(summary, body); const target = state.detachedRuntime ? $("chat-events") : $("operation-log"); target.hidden = false; target.append(row); while (target.children.length > 30) target.firstChild.remove();

}
function renderAuth(info) {
	const el = $("auth-info"); el.hidden = !info; el.replaceChildren(); if (!info) return;
	const text = document.createElement("p"); text.textContent = [info.message, info.instructions, info.userCode].filter(Boolean).join("\n"); el.append(text);
	for (const target of [info.url, info.verificationUri, ...(info.links ?? []).map((l) => l.url)].filter(Boolean)) {
		if (!/^https?:\/\//.test(target)) continue;
		const link = document.createElement("a"); link.href = target; link.textContent = "打开授权页面"; link.target = "_blank"; link.rel = "noopener noreferrer"; el.append(link);
	}
}
async function loadSessions() {
	if (!state.detachedRuntime || !state.ready) return;
	const sessions = await command("sessions"), el = $("session-list"); el.replaceChildren();
	for (const item of sessions) {
		const button = document.createElement("button"); button.className = "session-card" + (item.id === state.sessionId ? " selected" : "");
		const label = document.createElement("strong"); label.textContent = item.name || item.firstMessage || "新会话";
		const date = document.createElement("small"); date.textContent = new Date(item.modified ?? item.timestamp ?? item.created).toLocaleString();
		button.append(label, date); button.onclick = () => navigateSession("session.resume", { id: item.id }); el.append(button);
	}
	updateNavigation();
}
function updateNavigation() { for (const button of document.querySelectorAll("#session-list button, #new-session")) button.disabled = navigating || !state.ready; }
async function navigateSession(method, params = {}) {
	if (navigating || !state.ready) return; navigating = true; updateNavigation();
	try { const result = await command(method, params); updateState(await jsonFetch(sessionEndpoint())); return result; }
	catch (e) { toast(e.message); } finally { navigating = false; updateNavigation(); }
}
async function openTree(mode) {
	try {
		const tree = await command("tree"), rows = [];
		const visit = (nodes, depth = 0) => { for (const node of nodes) { if (mode !== "fork" || node.entry.message?.role === "user") rows.push({ id: node.entry.id, label: "  ".repeat(depth) + node.entry.type + " · " + (node.entry.message?.role ?? "") }); visit(node.children ?? [], depth + 1); } }; visit(tree);
		await switchTab(state.detachedRuntime ? "chat" : "terminal"); const el = $("chat-events"); el.hidden = false; el.replaceChildren();
		for (const row of rows) { const button = document.createElement("button"); button.textContent = row.label; button.onclick = () => navigateSession(mode === "fork" ? "session.fork" : "session.tree", { entryId: row.id }).then((result) => { if (result?.selectedText) { $("message").value = result.selectedText; reportDraft(); } switchTab("chat"); }).catch((e) => toast(e.message)); el.append(button); }
	} catch (e) { toast(e.message); }
}
$("new-session").onclick = () => navigateSession("session.new");
$("refresh-sessions").onclick = () => loadSessions().catch((e) => toast(e.message));
$("runtime-command-form").onsubmit = async (event) => { event.preventDefault(); const input = $("runtime-command"); if (await nativeCommand(input.value.trim())) input.value = ""; };
for (const value of ["/resume", "/model", "/thinking", "/config", "/models", "/runtime", "/watch", "/tree", "/compact", "/queue", "/queue clear", "/login", "/settings", "/help"]) {
	const button = document.createElement("button"); button.textContent = value; button.onclick = () => nativeCommand(value); $("command-buttons").append(button); if (["/model", "/config", "/resume", "/watch", "/runtime", "/queue"].includes(value)) { const chatButton = button.cloneNode(true); chatButton.onclick = button.onclick; $("chat-command-buttons").append(chatButton); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && paired) jsonFetch(sessionEndpoint()).then(updateState).catch((error) => toast(error.message)); });
setInterval(() => { if (!paired || document.hidden || !state.ready) return; if (activeTab === "agents") loadActors().catch(() => {}); if (activeTab === "project") loadProject().catch(() => {}); }, 3500);
window.addEventListener("hashchange", () => {
	const nextToken = new URLSearchParams(location.hash.slice(1)).get("token");
	if (nextToken) login(nextToken).catch((error) => { showPair(); $("pair-error").textContent = error.message; });
});


let viewportTimer;
const viewport = () => {
	document.documentElement.style.setProperty("--viewport-height", (window.visualViewport?.height ?? window.innerHeight) + "px");
	clearTimeout(viewportTimer);
	viewportTimer = setTimeout(fitTerminal, 150);
};
window.visualViewport?.addEventListener("resize", viewport); viewport();

function sessionEndpoint() { return harness && activeProject ? "/api/session?project=" + encodeURIComponent(activeProject) : "/api/session"; }
function renderProjects(next) {
	projects = next; $("project-select").hidden = !harness; $("add-project").hidden = !harness;
	$("project-navigation").hidden = !harness;
	if (!harness) return;
	const current = next.find((p) => p.id === activeProject);
	// The directory confirms a stopped Host; this projection has no Host event sequence.
	if (current && !current.running && !current.unavailable && (state.ready || !state.stopped)) updateState({ ...state, seq: undefined, ready: false, stopped: true, executionUnknown: false, idle: true, dialogs: [] });
	const signature = JSON.stringify(next); if (signature === lastProjects) return; lastProjects = signature;
	const selector = $("project-select"); selector.replaceChildren(new Option("项目总览", ""));
	for (const project of next) selector.append(new Option(project.name + (project.analysis ? " · Analysis" : "") + (project.running ? project.idle ? " · 就绪" : " · 运行中" : " · 未启动"), project.id));
	selector.value = activeProject ?? "";
	for (const target of [$("project-list"), $("project-home-list")]) {
		target.replaceChildren();
		for (const project of next) {
			const button = document.createElement("button"); button.className = "project-link" + (project.id === activeProject ? " selected" : ""); button.dataset.project = project.id;
			const name = document.createElement("strong"); name.textContent = project.name + (project.analysis ? " · Analysis" : "");
			const status = document.createElement("small"); status.textContent = (project.unavailable ? "不可达" : project.running ? project.idle ? "就绪" : "运行中" : "未启动") + (project.pending ? ` · ${project.pending} 项待回答` : "");
			button.append(name, status); if (target.id === "project-home-list") { const path = document.createElement("span"); path.textContent = project.cwd; button.append(path); }
			button.onclick = () => selectProject(project.id).catch((e) => toast(e.message)); target.append(button);
		}
	}
}
async function selectProject(id) {
	const selection = ++projectSelection;
	if (activeProject) { projectDrafts.set(activeProject, { text: $("message").value, images }); if (state.ready) void command("ui.draft", { hasDraft: false }).catch(() => {}); }
	activeProject = id || undefined; sessionStorage.setItem("rpi_project", activeProject ?? "");
	const url = new URL(location.href); activeProject ? url.searchParams.set("project", activeProject) : url.searchParams.delete("project"); history.replaceState(null, "", url.pathname + url.search);
	lastEventSeq = 0; lastHostEpoch = undefined; sessionsEpoch = undefined; olderEntries = []; lastMessages = ""; lastActors = ""; selectedActor = undefined;
	unreadDialogs.clear(); $("approval").close(); activeDialog = undefined; $("settings").close(); navigating = false; busySending = false; pendingSend = undefined; pendingActorSend = undefined;
	$("chat-events").replaceChildren(); $("chat-events").hidden = true; $("runtime-dock").hidden = true; $("session-list").replaceChildren();
	const draft = projectDrafts.get(activeProject); $("message").value = draft?.text ?? ""; images = draft?.images ?? []; renderAttachments();
	$("project-home").hidden = Boolean(activeProject); $("tabs").hidden = !activeProject; $("chat-view").hidden = !activeProject; $("agents-view").hidden = true; $("project-view").hidden = true; $("terminal-view").hidden = true;
	activeTab = "chat"; $("tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "chat"));
	state = { harness: true, projectId: activeProject, ready: false, entries: [], dialogs: [] }; updateNavigation();
	$("project-select").value = activeProject ?? ""; lastProjects = ""; renderProjects(projects);
	const snapshot = await jsonFetch(sessionEndpoint()); if (selection !== projectSelection) return; updateState(snapshot);
	if (activeProject && snapshot.ready) { reportDraft(); await refreshDock(); }
	else if (!activeProject) { $("workspace").textContent = "所有研究项目"; $("session-sidebar").hidden = false; }
}
$("project-select").onchange = (e) => selectProject(e.target.value).catch((error) => toast(error.message));
$("project-home-button").onclick = () => selectProject().catch((e) => toast(e.message));
for (const id of ["add-project", "home-add-project"]) $(id).onclick = () => $("project-dialog").showModal();
$("project-cancel").onclick = () => $("project-dialog").close();
$("project-form").onsubmit = async (e) => {
	e.preventDefault(); try {
		const project = await command("project.add", { cwd: $("project-path").value, name: $("project-name").value, analysis: $("project-analysis").checked });
		renderProjects(await command("projects")); $("project-dialog").close(); await selectProject(project.id);
	} catch (error) { toast(error.message); }
};
$("start-project").onclick = async () => {
	const button = $("start-project"); button.disabled = true;
	try { const snapshot = await command("project.start"); updateState(snapshot); renderProjects(await command("projects")); await refreshDock(); }
	catch (e) { toast(e.message); } finally { button.disabled = false; }
};
function renderUsage() {
	const stats = state.stats, usage = state.usage, compact = (n) => Number(n ?? 0) >= 1000000 ? (n / 1000000).toFixed(1) + "M" : Number(n ?? 0) >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n ?? 0);
	$("usage-status").textContent = !stats ? "" : `↑ ${compact(stats.tokens?.input)} · ↓ ${compact(stats.tokens?.output)} · 缓存 ${compact(stats.tokens?.cacheRead)} · $${Number(stats.cost ?? 0).toFixed(3)} · 上下文 ${usage?.percent == null ? "—" : usage.percent.toFixed(1) + "%"} / ${compact(usage?.contextWindow)} · 队列 ${state.queue ?? 0}`;
}
async function refreshDock() {
	if (!state.detachedRuntime || !state.ready || activeTab !== "chat") return;
	const view = await command("runtime"); if (!view) return;
	const actors = await command("actors"), active = actors.filter((a) => ["running", "starting", "input_required", "cancelling"].includes(a.action?.status));
	const dock = $("runtime-dock"); dock.hidden = false;
	const wasOpen = dock.querySelector("details")?.open;
	dock.innerHTML = `<details${wasOpen ? " open" : ""}><summary><strong>◈ RESEARCH ${escape(view.project.name)}</strong><span>${escape(view.leader.inheritancePolicy)} · ${view.leader.isCurrentSessionAttached ? "Leader here" : "Leader elsewhere"} · ${view.counts.active} active · ${view.counts.waiting} waiting · ${view.counts.openMessages} open</span></summary><p>${escape(view.research.question ?? "")}</p>${active.slice(0, 4).map((a) => `<button class="dock-actor" data-watch="${escape(a.id)}"><strong>${escape(a.label)}</strong><small>${escape([a.action?.status, a.model, a.thinking, a.action?.metadata?.progress].filter(Boolean).join(" · "))}</small></button>`).join("")}<button id="dock-board" class="quiet">Runtime 面板</button></details>`;
	dock.querySelectorAll("[data-watch]").forEach((b) => b.onclick = () => { selectedActor = b.dataset.watch; switchTab("agents").then(loadActor).catch((e) => toast(e.message)); });
	$("dock-board").onclick = () => switchTab("project").catch((e) => toast(e.message));
}
setInterval(() => { if (paired && !document.hidden) void refreshDock().catch(() => {}); }, 3500);
const builtInCommands = ["/model", "/models", "/thinking", "/runtime", "/watch", "/config", "/resume", "/new", "/tree", "/fork", "/compact", "/login", "/logout", "/settings", "/queue", "/help"];
function suggestCommands() {
	const text = $("message").value, el = $("command-suggestions"); el.replaceChildren(); el.hidden = !text.startsWith("/") || text.includes(" "); if (el.hidden) return;
	for (const value of builtInCommands.filter((c) => c.startsWith(text))) { const button = document.createElement("button"); button.type = "button"; button.textContent = value; button.onclick = () => { $("message").value = value + " "; el.hidden = true; $("message").focus(); reportDraft(); }; el.append(button); }
}
$("message").addEventListener("input", suggestCommands);

const token = new URLSearchParams(location.hash.slice(1)).get("token");
try { if (token) await login(token); else await enter(); } catch (error) { showPair(); if (token) $("pair-error").textContent = error.message; }

$("stop-project").onclick = async () => {
	if (!window.confirm("停止当前项目 Runtime？当前轮会中止，其他项目继续运行。")) return;
	try { await command("runtime.stop"); updateState({ ...state, seq: undefined, ready: false }); $("settings").close(); } catch (e) { toast(e.message); }
};
