import assert from "node:assert/strict";
import test from "node:test";
import cacheAuditExtension from "../.pi/extensions/cache-audit.ts";
import { fingerprintProviderPayload, compareProviderPrefixes, inspectCacheHeaders } from "../.pi/lib/cache-audit.mjs";
import { mergeProviderAttributionHeaders } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-attribution.js";
import { opencodeGoProvider } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.js";

test("wire audit distinguishes append-only history from changes to old messages and schemas", () => {
	const payload = { model: "model-a", messages: [{ role: "system", content: "rules" }, { role: "user", content: "secret-text" }], tools: [{ name: "read" }], max_tokens: 100 };
	const before = fingerprintProviderPayload(payload);
	const after = fingerprintProviderPayload({ ...payload, messages: [...payload.messages, { role: "assistant", content: "tool call" }] });
	assert.equal(compareProviderPrefixes(before, after).appendOnly, true);
	assert.doesNotMatch(JSON.stringify(before), /secret-text|rules/);
	const moving = fingerprintProviderPayload({ ...payload, messages: [{ role: "system", content: "different" }, payload.messages[1]] });
	assert.equal(compareProviderPrefixes(before, moving).firstChangedMessage, 0);
	assert.deepEqual(compareProviderPrefixes(before, fingerprintProviderPayload({ ...payload, tools: [] })).changed, ["tools"]);
	assert.deepEqual(compareProviderPrefixes(before, fingerprintProviderPayload({ ...payload, max_tokens: 200 })).changed, ["settings"]);
	assert.deepEqual(compareProviderPrefixes(before, fingerprintProviderPayload(payload, { provider: "another-provider" })).changed, ["route"]);
	assert.equal(fingerprintProviderPayload({ model: "unsupported-shape" }), undefined);
});

test("Pi SDK already supplies Go session headers without generic affinity enabled", () => {
	const model = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" };
	const headers = mergeProviderAttributionHeaders(model, { getEnableInstallTelemetry: () => false }, "session-a");
	assert.equal(headers["x-opencode-session"], "session-a");
	assert.deepEqual(inspectCacheHeaders(headers, "session-a"), { opencodeSessionPresent: true, opencodeSessionMatches: true, affinityPresent: false });
	assert.equal(inspectCacheHeaders({ "X-OpenCode-Session": "wrong-session", Authorization: "secret-key" }, "session-a").opencodeSessionMatches, false);
});

test("audit is opt-in, does not mutate requests, and never persists message or credential bodies", async (t) => {
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const handlers = new Map(), commands = new Map(), entries = [];
	cacheAuditExtension({
		on: (name, handler) => handlers.set(name, handler),
		registerFlag() {}, getFlag: () => false,
		registerCommand: (name, command) => commands.set(name, command),
		appendEntry: (customType, data) => { if (customType === "research-cache-audit") entries.push({ customType, data }); },
	});
	const ctx = { model: { provider: "opencode-go", id: "glm-5.3-flash" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
	const event = { payload: { messages: [{ role: "user", content: "private research text" }], tools: [], max_tokens: 32 } };
	const result = { message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }, stopReason: "stop" } };
	handlers.get("session_start")();
	handlers.get("before_provider_request")(event, ctx);
	handlers.get("message_end")(result);
	assert.equal(entries.length, 0);
	await commands.get("cache-audit").handler("on", ctx);
	handlers.get("before_provider_headers")({ headers: { Authorization: "secret-key", "x-opencode-session": "session-a" } }, ctx);
	const original = JSON.stringify(event);
	assert.equal(handlers.get("before_provider_request")(event, ctx), undefined);
	handlers.get("after_provider_response")({ status: 200 });
	now += 7 * 60 * 1000;
	handlers.get("message_end")(result);
	assert.equal(JSON.stringify(event), original);
	assert.equal(entries[0].data.httpStatus, 200);
	assert.equal(entries[0].data.headers.opencodeSessionMatches, true);
	assert.equal(entries[0].data.idleMs, undefined);
	assert.equal(entries[0].data.durationMs, 7 * 60 * 1000);
	now += 39;
	handlers.get("before_provider_request")(event, ctx);
	handlers.get("message_end")({ message: { ...result.message, usage: { ...result.message.usage, cacheRead: 0 } } });
	assert.equal(entries[1].data.prefix.appendOnly, true, "a backend-reported miss does not imply a changed prefix");
	assert.equal(entries[1].data.idleMs, 39, "previous generation time is not idle time");
	assert.doesNotMatch(JSON.stringify(entries), /private research text|secret-key|session-a/);
	handlers.get("session_shutdown")();
});

test("explicit audit preference survives reload within the Session and off restores fetch", async () => {
	const originalFetch = globalThis.fetch;
	const branch = [];
	const ctx = { sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
	function load() {
		const handlers = new Map(), commands = new Map();
		cacheAuditExtension({ on: (n, h) => handlers.set(n, h), registerFlag() {}, getFlag: () => false,
			registerCommand: (n, c) => commands.set(n, c), appendEntry: (customType, data) => branch.push({ customType, data }) });
		handlers.get("session_start")({}, ctx);
		return { handlers, command: commands.get("cache-audit") };
	}
	const first = load();
	assert.equal(globalThis.fetch, originalFetch);
	await first.command.handler("on", ctx);
	assert.notEqual(globalThis.fetch, originalFetch);
	first.handlers.get("session_shutdown")();
	assert.equal(globalThis.fetch, originalFetch);
	const reloaded = load();
	assert.notEqual(globalThis.fetch, originalFetch);
	await reloaded.command.handler("off", ctx);
	assert.equal(globalThis.fetch, originalFetch);
	reloaded.handlers.get("session_shutdown")();
});

test("full audit correlates final HTTP with the payload hook and excludes another Session", { timeout: 5000 }, async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":90}}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
	const handlers = new Map(), reports = [];
	let resolveTransport;
	cacheAuditExtension({ on: (n, h) => handlers.set(n, h), registerFlag() {}, getFlag: () => true, registerCommand() {},
		appendEntry: (kind, data) => { if (kind === "research-cache-transport") { reports.push(data); resolveTransport?.(data); } } });
	const provider = opencodeGoProvider();
	const model = provider.getModels().find((m) => m.id === "glm-5.3");
	const ctx = { model, sessionManager: { getBranch: () => [], getSessionId: () => "leader" } };
	handlers.get("session_start")({}, ctx);
	try {
		const send = (sessionId, changeAfterHook = false) => provider.streamSimple(model, { systemPrompt: "synthetic", messages: [{ role: "user", content: "private synthetic input", timestamp: 0 }] }, {
			apiKey: "synthetic-only", maxTokens: 32, maxRetries: 0,
			headers: { "x-opencode-session": sessionId },
			onPayload: (payload) => { handlers.get("before_provider_request")({ payload }, ctx); return changeAfterHook ? { ...payload, temperature: 0.3 } : payload; },
		}).result();
		for (const change of [false, true]) {
			const completed = new Promise((resolve) => { resolveTransport = resolve; });
			const result = await send("leader", change);
			const report = await completed;
			assert.equal(report.matchesPayloadHook, !change);
			assert.equal(report.headers.opencodeSessionMatches, true);
			assert.equal(report.usageUpdates[0].usage.prompt_tokens_details.cached_tokens, result.usage.cacheRead);
		}
		assert.deepEqual(reports[1].prefix.changed, ["settings"]);
		await send("another-session");
		assert.equal(reports.length, 2);
		assert.doesNotMatch(JSON.stringify(reports), /private synthetic|synthetic-only/);
	} finally { handlers.get("session_shutdown")(); globalThis.fetch = original; }
});
