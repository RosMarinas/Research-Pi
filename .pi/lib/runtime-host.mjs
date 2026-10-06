import { createServer } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRuntimeInteractions } from "./runtime-interactions.mjs";
import { publicWebEntries } from "../extensions/research-web.ts";
import { createSubagentWatchClient, subagentWatchTranscript } from "./subagent-watch.mjs";
import { getRuntimeUiAdapter } from "./research-runtime-adapters.mjs";
import { theme, getAvailableThemesWithPaths, getThemeByName, setTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ProjectTrustStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js";

const publicModel = (m) => m && { id: m.id, provider: m.provider, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow };
const strip = (text) => String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");

export async function createRuntimeHost({ runtime, socketPath, sessionDir, stateRoot, onShutdown = () => {} }) {
	sessionDir = runtime.session.sessionManager.getSessionDir();
	const clients = new Set(), calls = new Map();
	const events = []; let eventBytes = 0;
	const commandScope = new AsyncLocalStorage();
	const hostEpoch = randomUUID(); let epoch = randomUUID(), seq = 0, context, unsubscribe, watch;
	let activeMessage, stateTimer, closing = false, switching = false, promptStarting = false, commandRunning = false, toolsExpanded = false, authInfo;
	const statuses = {}, actorEvents = new Map(), drafts = new Map(), liveTools = new Map();
	const send = (socket, value) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); };
	const publish = (event) => {
		const value = { ...event, hostEpoch, sessionEpoch: epoch, sessionId: runtime.session.sessionId, seq: ++seq };
		const serialized = JSON.stringify(value) + "\n", bytes = Buffer.byteLength(serialized);
		events.push({ seq, epoch, serialized, bytes }); eventBytes += bytes;
		while (events.length > 256 || eventBytes > 2 * 1024 * 1024) eventBytes -= events.shift().bytes;
		for (const socket of clients) { if (socket.writableLength > 2 * 1024 * 1024) socket.destroy(); else if (!socket.destroyed) socket.write(serialized); }
	};
	const interactions = createRuntimeInteractions(publish, () => epoch);
	const state = () => ({ ready: !closing && !switching, hostEpoch, sessionEpoch: epoch, seq,
		sessionId: runtime.session.sessionId, name: runtime.session.sessionName ?? "Research Pi", sessionName: runtime.session.sessionName, cwd: runtime.cwd,
		footer: { autoCompactEnabled: runtime.session.autoCompactionEnabled, subscription: runtime.session.model ? runtime.session.modelRuntime.isUsingSubscription(runtime.session.model.provider) : false },
		idle: runtime.session.isIdle, model: publicModel(runtime.session.model), thinking: runtime.session.thinkingLevel,
		usage: runtime.session.getContextUsage(), stats: { tokens: runtime.session.getSessionStats().tokens, cost: runtime.session.getSessionStats().cost }, liveTools: [...liveTools.values()], entries: publicWebEntries(runtime.session.sessionManager.getBranch()),
		historyCount: publicWebEntries(runtime.session.sessionManager.getBranch(), Infinity).length,
		activeMessage, authInfo, toolsExpanded, hideThinking: runtime.services.settingsManager.getHideThinkingBlock(), uiTheme: runtime.services.settingsManager.getTheme(), statuses: { ...statuses }, dialogs: interactions.list(), detachedRuntime: true,
		projectTrusted: runtime.services.settingsManager.isProjectTrusted(), queue: runtime.session.pendingMessageCount });
	const update = () => { clearTimeout(stateTimer); stateTimer = setTimeout(() => publish({ type: "state", state: state() }), 35); };
	const ui = {
		confirm: (title, message, opts) => interactions.request("confirm", title, message, opts),
		select: (title, options, opts) => interactions.request("select", title, options, opts),
		selectModel: (title, options) => interactions.request("select", title, options),
		input: (title, placeholder, opts) => interactions.request("input", title, placeholder, opts),
		editor: (title, prefill) => interactions.request("editor", title, prefill),
		notify: (message, kind = "info") => publish({ type: "notice", message: strip(message), kind }),
		setStatus(key, value) { value === undefined ? delete statuses[key] : statuses[key] = strip(value); publish({ type: "status", key, value: value === undefined ? null : strip(value) }); },
		setWidget() {}, setFooter() {}, setHeader() {}, setWorkingVisible() {}, setWorkingIndicator() {}, setHiddenThinkingLabel() {},
		setWorkingMessage(message) { publish({ type: "working", message: strip(message) }); },
		setTitle(title) { publish({ type: "title", title }); },
		setEditorText(text) { publish({ type: "draft", text, targetClientId: commandScope.getStore()?.uiClientId }); }, getEditorText: () => [...drafts.values()].some((until) => until > Date.now()) ? "unsent UI draft" : "", pasteToEditor(text) { publish({ type: "draft", text, targetClientId: commandScope.getStore()?.uiClientId }); },
		onTerminalInput: () => () => {},
		openView(view, params = {}) { publish({ type: "view", view, params, targetClientId: commandScope.getStore()?.uiClientId }); },
		custom() { throw new Error("This extension uses a terminal-only view. It needs a structured Runtime view adapter."); },
		get theme() { return theme; }, getAllThemes: () => getAvailableThemesWithPaths(), getTheme: (name) => getThemeByName(name),
		getToolsExpanded: () => toolsExpanded, setToolsExpanded(value) { toolsExpanded = Boolean(value); publish({ type: "tools_expanded", expanded: toolsExpanded }); update(); },
		addAutocompleteProvider() { throw new Error("Terminal autocomplete factories need a client-side adapter"); },
		setEditorComponent(factory) { if (factory) throw new Error("Terminal editor factories need a client-side adapter"); }, getEditorComponent: () => undefined,
		setTheme(name) { const result = setTheme(name); if (result.success) publish({ type: "theme", name }); return result; },
	};
	async function bind() {
		unsubscribe?.(); interactions.cancelAll(); activeMessage = undefined; drafts.clear(); liveTools.clear();
		watch = await createSubagentWatchClient({ cwd: runtime.cwd, stateRoot }); actorEvents.clear();
		unsubscribe = runtime.session.subscribe((event) => {
			if (event.type === "tool_execution_start") liveTools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, arguments: event.args, status: "running", startedAt: Date.now() });
			if (event.type === "tool_execution_update") { const tool = liveTools.get(event.toolCallId); if (tool) tool.result = event.partialResult; }
			if (event.type === "tool_execution_end") liveTools.delete(event.toolCallId);
			if (event.type === "message_update") activeMessage = event.message;
			if (event.type === "message_end" || event.type === "agent_end") activeMessage = undefined;
			publish({ type: "agent_event", event }); update();
		});
		await runtime.session.bindExtensions({ mode: "rpc", uiContext: ui, commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (opts) => replace(() => runtime.newSession(opts)),
			fork: (id) => replace(() => runtime.fork(id)),
			navigateTree: (id, opts) => replace(() => runtime.session.navigateTree(id, opts)),
			switchSession: (path, opts) => replace(() => runtime.switchSession(path, opts)),
			reload: () => reload(),
		}, shutdownHandler: () => { void close(); }, onError: (err) => ui.notify(`${err.event}: ${err.error}`, "error") });
		context = runtime.session.extensionRunner?.createContext();
		update();
	}
	async function reload() {
		if (!runtime.session.isIdle || promptStarting || interactions.list().length) throw new Error("Finish the current turn and interaction before reload");
		epoch = randomUUID(); interactions.cancelAll();
		await runtime.session.reload(); context = runtime.session.extensionRunner.createContext(); update();
	}

	async function replace(operation) {
		if (switching || (commandRunning && commandScope.getStore()?.method !== "prompt") || !runtime.session.isIdle || promptStarting || interactions.list().length) throw new Error("Finish or interrupt the current turn and interaction first");
		switching = true; update();
		const previousEpoch = epoch;
		try { const result = await operation(); if (!result?.cancelled && epoch === previousEpoch) { epoch = randomUUID(); interactions.cancelAll(); } return result; }
		finally { switching = false; update(); }
	}
	runtime.setBeforeSessionInvalidate(() => { interactions.cancelAll(); epoch = randomUUID(); });
	runtime.setRebindSession(bind);
	async function submit(text, params) {
		const s = runtime.session;
		if (text.startsWith("!")) {
			const command = text.replace(/^!!?/, ""), excludeFromContext = text.startsWith("!!");
			const result = await s.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd: runtime.cwd });
			if (result?.result) s.recordBashResult(command, result.result, { excludeFromContext });
			else await s.executeBash(command, (chunk) => publish({ type: "shell", text: chunk }), { excludeFromContext, operations: result?.operations }); return;
		}
		const match = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/), name = match?.[1], arg = match?.[2]?.trim() ?? "";
		if (name && !s.extensionRunner?.getCommand(name) && !s.resourceLoader.getPrompts().prompts.some((p) => p.name === name)) {
			if ((!s.isIdle || promptStarting) && !["help", "session", "queue"].includes(name)) throw new Error("Wait for the current turn, or interrupt it first");
			if (name === "model" || name === "scoped-models") {
				const models = s.modelRuntime.getAvailableSnapshot();
				const choices = models.map((m) => `${m.provider}/${m.id}`).filter((x) => !arg || x.includes(arg));
				const selected = choices.length === 1 ? choices[0] : await ui.select("Leader model", choices);
				if (selected) await s.setModel(models.find((m) => `${m.provider}/${m.id}` === selected)); return;
			}
			if (name === "thinking") { const value = arg || await ui.select("Thinking", ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]); if (value) s.setThinkingLevel(value); return; }
			if (name === "new") { await replace(() => runtime.newSession()); return; }
			if (name === "clone") { await replace(() => runtime.fork(s.sessionManager.getLeafId(), { position: "at" })); return; }
			if (name === "import") { if (!arg) throw new Error("Usage: /import /absolute/path/session.jsonl"); await replace(() => runtime.importFromJsonl(arg)); return; }
			if (name === "reload") { await reload(); return; }
			if (name === "trust") {
				if (await ui.confirm("Trust project-local Pi resources?", `Allow local settings and extensions for ${runtime.cwd}`)) {
					new ProjectTrustStore(runtime.services.agentDir).set(runtime.cwd, true);
					runtime.services.settingsManager.setProjectTrusted(true); await reload();
				} return;
			}
			if (name === "resume") {
				const sessions = await SessionManager.list(runtime.cwd, sessionDir);
				const labels = sessions.map((x) => `${x.id} · ${x.name || x.firstMessage || "Untitled"}`);
				const label = arg ? labels.find((x) => x.startsWith(arg)) : await ui.select("Resume Session", labels);
				if (label) await replace(() => runtime.switchSession(sessions[labels.indexOf(label)].path)); return;
			}
			if (name === "tree" || name === "fork") { ui.openView(name, {}); return; }
			if (name === "compact") { await s.compact(arg || undefined); return; }
			if (name === "export") { ui.notify(await s.exportToHtml(arg || undefined)); return; }
			if (name === "name") { const value = arg || await ui.input("Session name", s.sessionName); if (value) s.setSessionName(value); return; }
			if (name === "session") { ui.notify(JSON.stringify({ id: s.sessionId, model: publicModel(s.model), usage: s.getContextUsage(), queued: s.pendingMessageCount }, null, 2)); return; }
			if (name === "queue") { if (arg === "clear") s.clearQueue(); else ui.notify(JSON.stringify({ steering: s.getSteeringMessages(), followUp: s.getFollowUpMessages() }, null, 2)); return; }
			if (name === "copy") { publish({ type: "copy", text: s.getLastAssistantText() ?? "", targetClientId: commandScope.getStore()?.uiClientId }); return; }
			if (name === "settings") {
				const settings = runtime.services.settingsManager;
				const selected = await ui.select("Native settings", ["Model", "Thinking", "Auto compaction", "Auto retry", "Steering mode", "Follow-up mode", "Transport", "Cache warming", "Theme", "Hide thinking", "Show cache miss notices", "Image auto resize", "Block images", "Skill commands"]);
				if (selected === "Model") return submit("/model", {}); if (selected === "Thinking") return submit("/thinking", {});
				if (selected === "Auto compaction") s.setAutoCompactionEnabled(!settings.getCompactionEnabled());
				if (selected === "Auto retry") s.setAutoRetryEnabled(!settings.getRetryEnabled());
				if (selected === "Steering mode") { const value = await ui.select("Steering mode", ["all", "one-at-a-time"]); if (value) s.setSteeringMode(value); }
				if (selected === "Follow-up mode") { const value = await ui.select("Follow-up mode", ["all", "one-at-a-time"]); if (value) s.setFollowUpMode(value); }
				if (selected === "Transport") { const value = await ui.select("Transport", ["auto", "sse", "websocket"]); if (value) settings.setTransport(value); }
				if (selected === "Cache warming") { const value = await ui.select("Cache warming", ["off", "streaming", "idle"]); if (value) s.setCacheWarmingMode(value); }
				if (selected === "Theme") { const value = await ui.select("Theme", getAvailableThemesWithPaths().map((t) => t.name)); if (value) { settings.setTheme(value); ui.setTheme(value); } }
				for (const [label, key] of [["Hide thinking", "HideThinkingBlock"], ["Show cache miss notices", "ShowCacheMissNotices"], ["Image auto resize", "ImageAutoResize"], ["Block images", "BlockImages"], ["Skill commands", "EnableSkillCommands"]]) if (selected === label) settings["set" + key](!settings["get" + key]());
				update(); return;
			}
			if (name === "login") {
				const providers = s.modelRuntime.getProviders().filter((p) => p.auth);
				const selected = arg || await ui.select("Login provider", providers.map((p) => p.id)); if (!selected) return;
				const provider = providers.find((p) => p.id === selected); if (!provider) throw new Error("Unknown provider");
				const types = [provider.auth.oauth && "oauth", provider.auth.apiKey && "api_key"].filter(Boolean);
				const type = types.length === 1 ? types[0] : await ui.select("Authentication", types); if (!type) return;
				try { await s.modelRuntime.login(selected, type, {
					prompt: async (p) => {
						if (p.type === "select") { const labels = p.options.map((x) => x.label); const chosen = await ui.select(p.message, labels, { signal: p.signal }); return p.options[labels.indexOf(chosen)]?.id; }
						return ui.input(p.message, p.placeholder, { signal: p.signal, secret: p.type === "secret" });
					},
					notify: (e) => { authInfo = e; publish({ type: "auth_event", event: e }); update(); },
				}); ui.notify("Provider login completed"); } finally { authInfo = undefined; update(); } return;
			}
			if (name === "logout") { const chosen = arg || await ui.select("Logout provider", s.modelRuntime.getProviders().map((p) => p.id)); if (chosen) await s.modelRuntime.logout(chosen); return; }
			if (name === "help") { ui.notify("/model /thinking /resume /new /tree /fork /compact /login /logout /settings /session /name /export /copy /runtime /watch /config /models\n" + (s.extensionRunner?.getRegisteredCommands() ?? []).map((c) => `/${c.name} — ${c.description ?? ""}`).join("\n")); return; }
			// Skills and prompt templates still belong to native Pi expansion.
			if (!name.startsWith("skill:") && !s.resourceLoader.getPrompts().prompts.some((p) => p.name === name)) throw new Error(`Unknown command /${name}; use /help`);
		}
		await s.prompt(text, { images: params.images, streamingBehavior: params.behavior === "steer" ? "steer" : "followUp", source: "rpc", preflightResult: params.preflightResult });
	}
	async function actorRead(selector) {
		const view = await watch.read(selector), events = actorEvents.get(view.actor.id) ?? new Map();
		for (const e of view.events) events.set(e.id ?? JSON.stringify(e), e);
		while (events.size > 400) events.delete(events.keys().next().value);
		actorEvents.set(view.actor.id, events); const result = { ...view, events: [...events.values()] }; return { ...result, rows: subagentWatchTranscript(result) };
	}
	async function execute({ method, params = {}, sessionId, sessionEpoch }) {
		const s = runtime.session;
		if (!["state", "events", "models", "commands", "runtime", "actors", "actor.read", "sessions", "tree", "history", "providers", "queue", "dialog.answer", "ui.draft"].includes(method)) {
			if (sessionId !== s.sessionId || sessionEpoch !== epoch) throw new Error("The session changed; refresh before submitting another operation");
		}
		if (switching && !["state", "dialog.answer", "abort", "ui.draft"].includes(method)) throw new Error("Session is switching");
		switch (method) {
			case "state": return state();
			case "events": {
				const since = params.since ?? 0;
				if (!Number.isInteger(since) || since < 0) throw new Error("Invalid event cursor");
				const rows = events.filter((row) => row.seq > since);
				if (params.hostEpoch !== hostEpoch || since > seq || (since < seq && (!rows.length || rows[0].seq !== since + 1 || rows.some((row) => row.epoch !== epoch)))) return { resyncRequired: true, state: state() };
				return { resyncRequired: false, events: rows.map((row) => JSON.parse(row.serialized)), seq };
			}
			case "models": return s.modelRuntime.getAvailableSnapshot().map(publicModel);
			case "commands": return (s.extensionRunner?.getRegisteredCommands() ?? []).map(({ name, description }) => ({ name, description }));
			case "providers": return s.modelRuntime.getProviders().map((p) => ({ id: p.id, name: p.name, auth: p.auth && Object.keys(p.auth) }));
			case "prompt": {
				if (interactions.list().length) throw new Error("Answer the pending interaction first");
				const text = String(params.message ?? "").trim();
				if (!text && !params.images?.length) throw new Error("Enter a message");
				if (text.length > 100000) throw new Error("Message too long");
				if (params.images !== undefined && !Array.isArray(params.images)) throw new Error("Invalid images");
				if ((params.images?.length ?? 0) > 4) throw new Error("Too many images");
				for (const image of params.images ?? []) if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) || typeof image.data !== "string" || image.data.length > 5_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.data)) throw new Error("Invalid image");
				if (promptStarting) throw new Error("The previous input is being prepared; submit again after it starts");
				// Commands acknowledge completion; ordinary messages acknowledge native
				// preflight (started/queued/handled), while the turn runs independently.
				if (commandRunning) throw new Error("Finish or interrupt the pending command first");
				const expansion = text.startsWith("/skill:") || s.resourceLoader.getPrompts().prompts.some((p) => text.split(/\s/, 1)[0] === "/" + p.name);
				if (/^[/!]/.test(text) && !expansion) {
					commandRunning = true;
					try { await submit(text, params); return { accepted: true, disposition: "handled" }; }
					finally { commandRunning = false; update(); }
				}
				promptStarting = true;
				return new Promise((resolve, reject) => {
					void submit(text, { ...params, preflightResult: (disposition) => { promptStarting = false; resolve({ accepted: true, disposition }); } })
						.then(() => { promptStarting = false; resolve({ accepted: true, disposition: "handled" }); }, (error) => { promptStarting = false; reject(error); ui.notify(error.message, "error"); }).finally(update);
				});
			}
			case "abort": s.abortBash(); interactions.cancelAll(); await s.abort(); update(); return { accepted: true };
			case "dialog.answer": { const result = interactions.answer(params.id, params.value, params.cancelled === true); update(); return result; }
			case "model.set": { if (!s.isIdle || promptStarting || commandRunning || interactions.list().length) throw new Error("Wait for the turn and interaction to finish"); const model = s.modelRuntime.getModel(params.provider, params.id); if (!model) throw new Error("Unknown model"); await s.setModel(model); update(); return { changed: true }; }
			case "ui.draft": { const id = commandScope.getStore()?.uiClientId; if (id) params.hasDraft ? drafts.set(id, Date.now() + 30000) : drafts.delete(id); return { updated: true }; }
			case "ui.toolsExpanded": ui.setToolsExpanded(params.expanded); return { changed: true };
			case "thinking.set": if (!s.isIdle || promptStarting || commandRunning || interactions.list().length) throw new Error("Wait for the current turn"); if (!["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(params.level)) throw new Error("Invalid thinking level"); s.setThinkingLevel(params.level); update(); return { changed: true };
			case "runtime": return getRuntimeUiAdapter()?.snapshot?.(context) ?? null;
			case "actors": return watch.list();
			case "actor.read": return actorRead(params.actorId);
			case "actor.send":
			case "actor.message": {
				const board = await getRuntimeUiAdapter()?.snapshot?.(context);
				if (board?.leader?.inheritancePolicy === "analysis") throw new Error("Analysis Session cannot send operational Actor messages; use /analysis send");
				if (!board?.leader?.isCurrentSessionAttached) throw new Error("This is not the owning Leader session");
				const view = await watch.read(params.actorId); return watch.send(view.actor, String(params.message ?? params.body ?? ""), params.kind ?? "notify");
			}
			case "sessions": return SessionManager.list(runtime.cwd, sessionDir);
			case "queue": return { steering: s.getSteeringMessages(), followUp: s.getFollowUpMessages() };
			case "queue.clear": { const result = s.clearQueue(); update(); return result; }
			case "history": return publicWebEntries(s.sessionManager.getBranch(), Infinity).slice(params.offset ?? 0, (params.offset ?? 0) + Math.min(params.limit ?? 100, 160));
			case "tree": {
				const project = (nodes) => nodes.map((node) => ({ entry: { id: node.entry.id, type: node.entry.type, timestamp: node.entry.timestamp,
					...(node.entry.type === "message" && ["user", "assistant", "toolResult"].includes(node.entry.message.role) ? { message: node.entry.message } : {}) }, children: project(node.children ?? []) }));
				return project(s.sessionManager.getTree());
			}
			case "session.new": return replace(() => runtime.newSession());
			case "session.resume": { const sessions = await SessionManager.list(runtime.cwd, sessionDir); const target = sessions.find((item) => item.id === params.id); if (!target) throw new Error("Unknown workspace session"); return replace(() => runtime.switchSession(target.path)); }
			case "session.fork": return replace(() => runtime.fork(params.entryId));
			case "session.tree": return replace(() => s.navigateTree(params.entryId, { summarize: params.summarize === true }));
			case "session.compact": { if (!s.isIdle || promptStarting || commandRunning || interactions.list().length) throw new Error("Wait for the turn to finish"); const result = await s.compact(params.instructions); update(); return result; }
			case "session.export": return s.exportToHtml(params.path);
			case "runtime.stop": setTimeout(() => void close(), 20); return { stopping: true };
			default: throw new Error(`Unsupported operation: ${method}`);
		}
	}
	async function command(input) {
		if (!input.id || input.method === "state") return execute(input);
		const serialized = JSON.stringify({ method: input.method, params: input.params, sessionId: input.sessionId, sessionEpoch: input.sessionEpoch }); const old = calls.get(input.id);
		if (old) { if (old.serialized !== serialized) throw new Error("Request ID reused for another operation"); return old.promise; }
		const promise = Promise.resolve().then(() => commandScope.run({ uiClientId: input.uiClientId, method: input.method }, () => execute(input))); calls.set(input.id, { serialized, promise });
		promise.finally(() => { const row = calls.get(input.id); if (row) row.settled = true; if (calls.size > 512) for (const [id, row] of calls) { if (row.settled) calls.delete(id); if (calls.size <= 384) break; } }).catch(() => {});
		return promise;
	}
	const server = createServer((socket) => {
		clients.add(socket); let buffer = "";
		send(socket, { type: "state", state: state() });
		socket.on("data", (data) => {
			buffer += data.toString(); if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { socket.destroy(); return; }
			let end; while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let input;
				try { input = JSON.parse(line); } catch { socket.destroy(); return; }
				command(input).then((result) => send(socket, { type: "response", id: input.id, result }), (error) => send(socket, { type: "response", id: input.id, error: error.message }));
			}
		});
		socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
	});
	async function close() {
		if (closing) return; closing = true; clearTimeout(stateTimer); interactions.cancelAll(); unsubscribe?.();
		await runtime.session.abort(); await runtime.dispose();
		for (const client of clients) client.destroy();
		await new Promise((resolve) => server.close(resolve)); await unlink(socketPath).catch((e) => { if (e.code !== "ENOENT") throw e; }); await onShutdown();
	}
	await bind();
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); await chmod(socketPath, 0o600);
	return { command, state, publish, close, ui, interactions };
}
