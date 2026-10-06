import { marked } from "/vendor/marked.js";
const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (value) => DOMPurify.sanitize(marked.parse(String(value ?? ""), { breaks: true }));
let state = { ready: false }, socket, reconnectTimer, activeTab = "chat", selectedActor, activeDialog, images = [], models = [], stream = "";
let ctrlLatch = false, streamTimer, pendingSend, pendingActorSend, lastActorReceipt, lastActors = "";
let terminal, fit, terminalSeq = 0, paired = false, toastTimer, lastMessages = "", busySending = false, terminalFitTimer;
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
	return await jsonFetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, method, params, sessionId: state.sessionId }) });
}
function showPair() { paired = false; clearTimeout(reconnectTimer); socket?.close(); $("pair").hidden = false; $("app").hidden = true; }
async function login(token) {
	await jsonFetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	$("token").value = "";
	history.replaceState(null, "", location.pathname);
	await enter();
}
async function enter() {
	paired = true; $("pair").hidden = true; $("app").hidden = false;
	updateState(await jsonFetch("/api/session"));
	connect();
}
function updateConnection(connected) { $("send").disabled = !connected || !state.ready || busySending; $("connection").classList.toggle("live", connected); $("connection").querySelector("span").textContent = connected ? "已连接" : "正在重连"; }
function connect() {
	clearTimeout(reconnectTimer);
	if (!paired) return;
	socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
	socket.onopen = async () => { updateConnection(true); try { updateState(await jsonFetch("/api/session")); } catch (error) { toast(error.message); } };
	socket.onclose = () => {
		updateConnection(false);
		if (paired) reconnectTimer = setTimeout(async () => {
			try { updateState(await jsonFetch("/api/session")); if (paired) connect(); }
			catch { if (paired) reconnectTimer = setTimeout(connect, 3000); }
		}, 1800);
	};
	socket.onerror = () => socket.close();
	socket.onmessage = ({ data }) => {
		const event = JSON.parse(data);
		if (event.type === "state") updateState(event.state);
		if (event.type === "terminal_snapshot") { initTerminal(); terminal.reset(); terminal.resize(event.cols, event.rows); terminal.write(event.data); terminalSeq = event.seq; }
		if (event.type === "terminal" && event.seq > terminalSeq) { terminalSeq = event.seq; terminal?.write(event.data); }
		if (event.type === "terminal_resize") terminal?.resize(event.cols, event.rows);
		if (event.type === "dialog") { unreadDialogs.set(event.request.id, event.request); showPending(); }
		if (event.type === "dialog_closed") { unreadDialogs.delete(event.id); if (activeDialog?.id === event.id) { $("approval").close(); activeDialog = null; } showPending(); }
		if (event.type === "notice") toast(event.message);
		if (event.type === "status") { state.statuses ??= {}; state.statuses[event.key] = event.value; renderRunState(); }
		if (event.type === "agent_event") agentEvent(event.event);
	};
}
function renderRunState() {
	const status = !state.ready ? "等待 Pi" : state.nativePrompt ? "等待操作" : state.idle ? "就绪" : "处理中";
	$("run-state").textContent = status + (state.statuses?.boundary ? " · " + state.statuses.boundary : "");
}
function updateState(next) {
	if (next.sessionId && next.sessionId !== state.sessionId) { stream = ""; lastMessages = ""; selectedActor = null; $("actor-detail").hidden = true; }
	state = next;
	$("workspace").textContent = next.cwd?.split("/").filter(Boolean).slice(-2).join(" / ") ?? "Pi 正在切换会话";
	$("model-label").textContent = next.model ? next.model.provider + " / " + (next.model.name || next.model.id) + " · " + next.thinking : "等待 Pi";
	renderRunState();
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
		if (part.type === "thinking" || part.type === "reasoning") return "<details><summary>思考过程</summary><div>" + md(part.thinking ?? part.text) + "</div></details>";
		if (part.type === "toolCall" || part.type === "tool_call") return "<details><summary>" + escape(part.name) + "</summary><pre>" + escape(JSON.stringify(part.arguments, null, 2)) + "</pre></details>";
		if (part.type === "image" && part.data && /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType)) return '<img alt="对话图片" src="data:' + part.mimeType + ";base64," + escape(part.data) + '">';
		return "";
	}).join("");
}
function renderMessages() {
	const entries = state.entries ?? [];
	const messages = entries.filter((entry) => (entry.type === "message" && !["system", "developer"].includes(entry.message?.role)) || (entry.type === "custom_message" && entry.display !== false)).map((entry) => entry.message ?? entry);
	const signature = JSON.stringify(messages) + stream;
	if (signature === lastMessages) return;
	lastMessages = signature;
	const el = $("messages"), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
	el.innerHTML = messages.map((message) => {
		const role = message.role ?? "runtime";
		const content = contentHtml(message);
		if (!content) return "";
		if (role === "toolResult") return '<details class="tool-result"><summary>' + escape(message.toolName ?? "工具结果") + (message.isError ? " · 失败" : "") + "</summary><div>" + content + "</div></details>";
		return '<article class="message ' + (role === "user" ? "user" : "assistant") + '"><div class="message-label">' + escape(role === "user" ? "You" : role === "assistant" ? "Pi" : "Runtime") + "</div>" + content + "</article>";
	}).join("") + (stream ? '<article id="stream-message" class="message assistant"><div class="message-label">Pi · 正在回复</div>' + md(stream) + "</article>" : "");
	if (!el.innerHTML) el.innerHTML = '<div class="empty"><h2>把研究继续下去。</h2><p>同一个项目，同一个 Pi。</p></div>';
	el.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
	if (atBottom) el.scrollTop = el.scrollHeight;
}
function renderStream() {
	if (!stream) return;
	const el = $("messages"), bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
	let row = document.getElementById("stream-message");
	if (!row) { row = document.createElement("article"); row.id = "stream-message"; row.className = "message assistant"; el.append(row); }
	row.innerHTML = '<div class="message-label">Pi · 正在回复</div>' + md(stream);
	if (bottom) el.scrollTop = el.scrollHeight;
}
function agentEvent(event) {
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
	$("pending-banner").hidden = !count && (!state.nativePrompt || activeTab === "terminal");
	$("pending-banner").querySelector("span").textContent = count ? "有 " + count + " 项等待你回答" : "Pi 正在等待终端操作";
	if (count && !activeDialog && !$("settings").open) openPending();
}
function openPending() {
	const request = unreadDialogs.values().next().value;
	if (!request) { switchTab("terminal"); return; }
	activeDialog = request;
	$("approval-title").textContent = request.title;
	$("approval-message").textContent = request.message ?? "";
	$("approval-fields").replaceChildren();
	if (request.kind === "select") {
		const select = document.createElement("select"); select.id = "approval-value"; select.setAttribute("aria-label", "选择");
		for (const value of request.options) { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); }
		$("approval-fields").append(select);
	} else if (request.kind === "input") {
		const input = document.createElement("input"); input.id = "approval-value"; input.placeholder = request.placeholder ?? ""; input.autocomplete = "off"; input.setAttribute("aria-label", "回答"); $("approval-fields").append(input);
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
		if (tab === "terminal") { initTerminal(); terminal.refresh(0, terminal.rows - 1); requestAnimationFrame(fitTerminal); }
	} catch (error) { toast(error.message); }
}
async function nativeCommand(value) {
	if (!value) return;
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
	if (selectedActor) await loadActor();
}
async function loadActor() {
	const view = await command("actor.read", { actorId: selectedActor });
	const receipt = view.messages?.find((message) => message.id === lastActorReceipt);
	if (receipt) $("actor-receipt").textContent = receipt.status + " · " + receipt.id;
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
	const message = $("message").value.trim();
	if (!message && !images.length) return;
	if (message.startsWith("/") || message.startsWith("!")) { if (await nativeCommand(message)) $("message").value = ""; return; }
	busySending = true; $("send").disabled = true;
	try {
		const params = { message, behavior: $("send-mode").value, images };
		const signature = JSON.stringify({ params, sessionId: state.sessionId });
		if (pendingSend?.signature !== signature) pendingSend = { id: crypto.randomUUID(), signature };
		await command("prompt", params, pendingSend.id);
		pendingSend = null;
		$("message").value = ""; images = []; renderAttachments(); $("composer-status").textContent = "已提交给当前 Pi";
	} catch (error) { if (error.responded) pendingSend = null; toast(error.message); }
	finally { busySending = false; $("send").disabled = !state.ready; }
};
$("message").onkeydown = (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); } };
$("abort").onclick = () => command("abort").catch((error) => toast(error.message));
$("pending-open").onclick = openPending;
$("approval-form").onsubmit = (event) => { event.preventDefault(); answer(false); };
$("approval-cancel").onclick = () => answer(true);
$("approval").oncancel = (event) => { event.preventDefault(); answer(true); };
$("refresh-agents").onclick = () => loadActors().catch((error) => toast(error.message));
$("close-actor").onclick = () => { selectedActor = null; $("actor-detail").hidden = true; };
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
document.addEventListener("visibilitychange", () => { if (!document.hidden && paired) jsonFetch("/api/session").then(updateState).catch((error) => toast(error.message)); });
setInterval(() => { if (!paired || document.hidden || !state.ready) return; if (activeTab === "agents") loadActors().catch(() => {}); if (activeTab === "project") loadProject().catch(() => {}); }, 3500);
window.addEventListener("hashchange", () => {
	const nextToken = new URLSearchParams(location.hash.slice(1)).get("token");
	if (nextToken) login(nextToken).catch((error) => { showPair(); $("pair-error").textContent = error.message; });
});
const token = new URLSearchParams(location.hash.slice(1)).get("token");
try { if (token) await login(token); else await enter(); } catch (error) { showPair(); if (token) $("pair-error").textContent = error.message; }

let viewportTimer;
const viewport = () => {
	document.documentElement.style.setProperty("--viewport-height", (window.visualViewport?.height ?? window.innerHeight) + "px");
	clearTimeout(viewportTimer);
	viewportTimer = setTimeout(fitTerminal, 150);
};
window.visualViewport?.addEventListener("resize", viewport); viewport();
