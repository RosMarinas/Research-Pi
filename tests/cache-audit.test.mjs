import assert from "node:assert/strict";
import test from "node:test";
import cacheAuditExtension from "../.pi/extensions/cache-audit.ts";
import { fingerprintProviderPayload, compareProviderPrefixes, inspectCacheHeaders } from "../.pi/lib/cache-audit.mjs";
import { mergeProviderAttributionHeaders } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-attribution.js";

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

test("audit is opt-in, does not mutate requests, and never persists message or credential bodies", async () => {
	const handlers = new Map(), commands = new Map(), entries = [];
	cacheAuditExtension({
		on: (name, handler) => handlers.set(name, handler),
		registerFlag() {}, getFlag: () => false,
		registerCommand: (name, command) => commands.set(name, command),
		appendEntry: (customType, data) => entries.push({ customType, data }),
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
	handlers.get("message_end")(result);
	assert.equal(JSON.stringify(event), original);
	assert.equal(entries[0].data.httpStatus, 200);
	assert.equal(entries[0].data.headers.opencodeSessionMatches, true);
	handlers.get("before_provider_request")(event, ctx);
	handlers.get("message_end")({ message: { ...result.message, usage: { ...result.message.usage, cacheRead: 0 } } });
	assert.equal(entries[1].data.prefix.appendOnly, true, "a backend-reported miss does not imply a changed prefix");
	assert.doesNotMatch(JSON.stringify(entries), /private research text|secret-key|session-a/);
});
