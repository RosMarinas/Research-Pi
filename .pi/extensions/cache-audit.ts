import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compareProviderPrefixes, fingerprintProviderPayload, inspectCacheHeaders, summarizeCacheAudit } from "../lib/cache-audit.mjs";

export default function cacheAuditExtension(pi: ExtensionAPI) {
	pi.registerFlag("cache-audit", { description: "Record redacted provider-prefix diagnostics in the Session (no prompt/header bodies)", type: "boolean", default: false });
	let enabled = false;
	let sequence = 0;
	let previous: ReturnType<typeof fingerprintProviderPayload>;
	let pending: any;
	let latest: any;
	let headers: ReturnType<typeof inspectCacheHeaders> | undefined;
	const reset = () => { previous = undefined; pending = undefined; latest = undefined; headers = undefined; sequence = 0; };
	pi.on("session_start", () => { reset(); enabled = pi.getFlag("cache-audit") === true; });
	pi.registerCommand("cache-audit", {
		description: "Enable/disable redacted request-prefix diagnostics, or show the last result",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "on" || command === "off") {
				enabled = command === "on";
				reset();
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
		const current = fingerprintProviderPayload(event.payload, ctx.model);
		pending = current ? {
			version: 1, sequence: ++sequence,
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
		latest = { ...pending, usage: { input, output, cacheRead, cacheWrite }, stopReason: event.message.stopReason };
		pi.appendEntry("research-cache-audit", latest);
		pending = undefined;
	});
}
