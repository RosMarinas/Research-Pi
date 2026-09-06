import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compareProviderPrefixes, fingerprintProviderPayload, inspectCacheHeaders, summarizeCacheAudit } from "../lib/cache-audit.mjs";
import { installCacheTransportAudit } from "../lib/cache-transport-audit.mjs";

export default function cacheAuditExtension(pi: ExtensionAPI) {
	pi.registerFlag("cache-audit", { description: "Record redacted provider-prefix diagnostics in the Session (no prompt/header bodies)", type: "boolean", default: false });
	let enabled = false;
	let sequence = 0;
	let previous: ReturnType<typeof fingerprintProviderPayload>;
	let pending: any;
	let latest: any;
	let headers: ReturnType<typeof inspectCacheHeaders> | undefined;
	let previousResponseEndedAt: number | undefined;
	let transport: ReturnType<typeof installCacheTransportAudit> | undefined;
	let previousWire: ReturnType<typeof fingerprintProviderPayload>;
	let activeContext: any;
	const reset = () => { previous = undefined; previousWire = undefined; pending = undefined; latest = undefined; headers = undefined; previousResponseEndedAt = undefined; sequence = 0; };
	const observeTransport = () => {
		transport?.restore();
		transport = enabled ? installCacheTransportAudit((input, init) => {
			if (!pending || activeContext?.model?.provider !== "opencode-go") return;
			const url = new URL(input instanceof Request ? input.url : String(input));
			const base = new URL(activeContext.model.baseUrl);
			if (url.origin !== base.origin || !url.pathname.endsWith("/chat/completions")) return;
			if (typeof init?.body !== "string") return;
			const payload = JSON.parse(init.body);
			if (payload.model !== activeContext.model.id) return;
			const wire = fingerprintProviderPayload(payload, activeContext.model);
			if (!wire) return;
			const actualHeaders = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
			const sessionId = activeContext.sessionManager.getSessionId();
			const goSession = actualHeaders.get("x-opencode-session");
			const matchesPayloadHook = compareProviderPrefixes(previous, wire)?.appendOnly === true && previous?.messages.length === wire.messages.length;
			// Side calls can share a provider while the Leader is running. Do not
			// attribute another Session's request to the pending Leader response.
			if (goSession ? goSession !== sessionId : !matchesPayloadHook) return;
			const result = {
				version: 1, sequence: pending.sequence, attempt: (pending.httpAttempts ?? 0) + 1,
				requestStartedAt: Date.now(), requestBytes: wire.bytes,
				toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
				maxTokens: typeof payload.max_tokens === "number" ? payload.max_tokens : undefined,
				maxCompletionTokens: typeof payload.max_completion_tokens === "number" ? payload.max_completion_tokens : undefined,
				cacheKeyPresent: typeof payload.prompt_cache_key === "string",
				prefix: compareProviderPrefixes(previousWire, wire),
				matchesPayloadHook,
				headers: inspectCacheHeaders(Object.fromEntries(actualHeaders), sessionId),
			};
			pending.httpAttempts = result.attempt;
			previousWire = wire;
			return result;
		}, (report) => { if (enabled) pi.appendEntry("research-cache-transport", report); }) : undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		reset(); activeContext = ctx;
		const preference = ctx?.sessionManager.getBranch().filter((entry: any) => entry.customType === "research-cache-audit-config").at(-1)?.data.enabled;
		enabled = preference ?? pi.getFlag("cache-audit") === true;
		observeTransport();
	});
	pi.on("session_shutdown", () => { enabled = false; transport?.restore(); });
	pi.registerCommand("cache-audit", {
		description: "Enable/disable redacted request-prefix diagnostics, or show the last result",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "on" || command === "off") {
				enabled = command === "on";
				reset();
				activeContext = ctx;
				pi.appendEntry("research-cache-audit-config", { enabled });
				observeTransport();
				ctx.ui.notify(`Cache audit ${command}. Diagnostics contain counts, change locations, and usage only; no prompt text or credentials.`, "info");
			} else if (command === "status") {
				ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"}. ${summarizeCacheAudit(latest)}`, "info");
			} else ctx.ui.notify("Usage: /cache-audit [on|off|status]", "warning");
		},
	});
	pi.on("before_provider_headers", (event, ctx) => {
		if (enabled) headers = inspectCacheHeaders(event.headers, ctx.sessionManager.getSessionId());
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return;
		activeContext = ctx;
		const requestStartedAt = Date.now();
		const current = fingerprintProviderPayload(event.payload, ctx.model);
		pending = current ? {
			version: 2, sequence: ++sequence,
			requestStartedAt,
			idleMs: previousResponseEndedAt === undefined ? undefined : requestStartedAt - previousResponseEndedAt,
			provider: ctx.model?.provider, model: ctx.model?.id,
			requestBytes: current.bytes, messages: current.messages.length,
			prefix: compareProviderPrefixes(previous, current), headers,
		} : undefined;
		previous = current;
		// Observe only: never replace or edit the outgoing payload.
	});
	pi.on("after_provider_response", (event) => {
		if (pending) pending.httpStatus = event.status;
	});
	pi.on("message_end", (event) => {
		if (!enabled || !pending || event.message.role !== "assistant") return;
		const { input, output, cacheRead, cacheWrite } = event.message.usage;
		const responseEndedAt = Date.now();
		latest = { ...pending, responseEndedAt, durationMs: responseEndedAt - pending.requestStartedAt, usage: { input, output, cacheRead, cacheWrite }, stopReason: event.message.stopReason };
		previousResponseEndedAt = responseEndedAt;
		pi.appendEntry("research-cache-audit", latest);
		pending = undefined;
	});
}
