import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");

// Keep only fingerprints in memory. Neither prompt text nor credentials leave
// this function; persisted reports contain counts and change locations only.
export function fingerprintProviderPayload(payload, model = {}) {
	if (!payload || typeof payload !== "object") return undefined;
	const { messages, input, system, instructions, tools, ...settings } = payload;
	const history = Array.isArray(messages) ? messages : Array.isArray(input) ? input : undefined;
	if (!history) return undefined;
	return {
		route: hash([model.provider, model.id, model.api, model.baseUrl]),
		messages: history.map(hash),
		system: hash([system, instructions]),
		tools: hash(tools),
		settings: hash(settings),
		bytes: Buffer.byteLength(JSON.stringify(payload)),
	};
}

export function compareProviderPrefixes(previous, current) {
	if (!previous || !current) return undefined;
	let commonMessages = 0;
	while (commonMessages < previous.messages.length && previous.messages[commonMessages] === current.messages[commonMessages]) commonMessages++;
	const changed = ["route", "system", "tools", "settings"].filter((key) => previous[key] !== current[key]);
	const firstChangedMessage = commonMessages < previous.messages.length ? commonMessages : null;
	return {
		previousMessages: previous.messages.length,
		commonMessages,
		firstChangedMessage,
		changed,
		appendOnly: firstChangedMessage === null && changed.length === 0,
	};
}

export function inspectCacheHeaders(headers, sessionId) {
	const value = (name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
	const goSession = value("x-opencode-session");
	return {
		opencodeSessionPresent: typeof goSession === "string" && goSession.length > 0,
		opencodeSessionMatches: goSession === sessionId,
		affinityPresent: typeof value("x-session-affinity") === "string",
	};
}

export function summarizeCacheAudit(report) {
	if (!report) return "Cache audit has no completed request yet.";
	const comparison = report.prefix;
	const prefix = !comparison ? "first request / no comparison"
		: comparison.appendOnly ? "observed request prefix unchanged"
			: `request changed: ${[...comparison.changed, ...(comparison.firstChangedMessage === null ? [] : [`message[${comparison.firstChangedMessage}]`])].join(", ")}`;
	return `Cache audit #${report.sequence}: ${prefix}; cached=${report.usage.cacheRead}, input=${report.usage.input}. This checks request structure, not backend cache residency or billing.`;
}
