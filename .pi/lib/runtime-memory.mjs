import { runtimeMemoryPolicy } from "./runtime-memory-policy.mjs";

// Feature-detect the installed provider's session-close API. Never close the
// shared runtime or clear its saved conversation records/account state.
export function createProviderIdleReclaimer({ idleMs, idle, sessionId, provider = () => globalThis[Symbol.for("pi-antigravity-acp:runtime")]?.runtime, clock = Date.now }) {
	let lastActivity = clock(), pending, stopped = false, releases = 0;
	return {
		get pending() { return pending; },
		get releases() { return releases; },
		async beforeRun() { lastActivity = clock(); await pending?.catch(() => undefined); lastActivity = clock(); },
		touch() { lastActivity = clock(); },
		async sweep() {
			if (stopped || !idleMs || pending || clock() - lastActivity < idleMs || !idle()) return false;
			const runtime = provider(), id = sessionId();
			if (!id || typeof runtime?.closeSession !== "function") return false;
			// before_agent_start waits for this gate before making any new model call.
			pending = Promise.resolve().then(() => runtime.closeSession(id));
			try { await pending; releases++; return true; }
			finally { pending = undefined; lastActivity = clock(); }
		},
		async stop() { stopped = true; await pending?.catch(() => undefined); },
	};
}

export function installPresentationWindow(mode, { entries = runtimeMemoryPolicy().historyEntries, components = 800 } = {}) {
	let limit = entries, omitted = 0;
	const render = mode.renderSessionEntries.bind(mode), handle = mode.handleEvent.bind(mode);
	const prune = () => {
		if (!limit || !mode.chatContainer?.children) return;
		const children = mode.chatContainer.children;
		let remove = Math.max(0, children.length - Math.max(components, limit * 4));
		for (const protectedComponent of [mode.streamingComponent, mode.bashComponent, ...mode.pendingTools.values()]) {
			const index = children.indexOf(protectedComponent);
			if (index >= 0) remove = Math.min(remove, index);
		}
		if (remove) { children.splice(0, remove); omitted += remove; mode.renderer?.resetTextSelection?.(); }
	};
	mode.renderSessionEntries = (items, options) => {
		const start = limit ? Math.max(0, items.length - limit) : 0;
		omitted = start;
		render(items.slice(start), options);
		prune();
	};
	mode.handleEvent = async event => { const result = await handle(event); prune(); return result; };
	return {
		get limit() { return limit; }, get omitted() { return omitted; },
		set(value) {
			if (!Number.isSafeInteger(value) || value < 0) throw new Error("History window must be a non-negative integer");
			limit = value;
			// Rebuild only a settled presentation; never discard active tool widgets.
			if (mode.session.isIdle) mode.rebuildChatFromMessages();
			return { limit, omitted };
		},
	};
}

export function runtimeMemoryExtension(pi, control) {
	const policy = control.policy ?? runtimeMemoryPolicy();
	let ctx, timer;
	const reclaimer = createProviderIdleReclaimer({ idleMs: policy.providerIdleMs,
		idle: () => Boolean(ctx?.isIdle() && !control.observed() && !control.blocked?.()),
		sessionId: () => ctx?.sessionManager.getSessionId(),
	});
	pi.on("session_start", (_event, context) => {
		ctx = context;
		clearInterval(timer);
		if (policy.providerIdleMs) { timer = setInterval(() => void reclaimer.sweep().catch(() => undefined), Math.min(15_000, policy.providerIdleMs)); timer.unref(); }
	});
	pi.on("before_agent_start", async () => { await reclaimer.beforeRun(); });
	pi.on("agent_settled", () => reclaimer.touch());
	pi.on("session_shutdown", async () => { clearInterval(timer); await reclaimer.stop(); });
	pi.registerCommand("history-window", {
		description: "Show recent history, or /history-window <count|all> to change the display without changing model context",
		handler: async (args, context) => {
			const value = args.trim();
			if (!control.presentation) return context.ui.notify("History window is available in the native terminal.", "info");
			if (value) control.presentation.set(value === "all" ? 0 : Number(value));
			context.ui.notify(`History display: ${control.presentation.limit || "all"} entries; older entries remain in the Session. Model context is unchanged.`, "info");
		},
	});
	pi.registerCommand("memory", {
		description: "Inspect this Host's memory and cache limits without forcing GC or changing jobs",
		handler: async (_args, context) => {
			const memory = process.memoryUsage();
			context.ui.notify(`Host RSS ${(memory.rss / 1048576).toFixed(1)} MiB · JS heap ${(memory.heapUsed / 1048576).toFixed(1)} MiB\nProvider idle releases: ${reclaimer.releases}\nHistory cache: ${JSON.stringify(context.sessionManager.historyCache?.stats() ?? "native")}\nLimits: ${JSON.stringify(policy)}`, "info");
		},
	});
}
