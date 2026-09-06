import assert from "node:assert/strict";
import test from "node:test";
import { installCacheTransportAudit, numericCacheUsage } from "../.pi/lib/cache-transport-audit.mjs";
import { opencodeGoProvider } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.js";

test("raw usage preserves missing vs explicit-zero cache fields and strips arbitrary data", () => {
	assert.deepEqual(numericCacheUsage({ prompt_tokens: 100, secret: "credential" }), { prompt_tokens: 100 });
	assert.deepEqual(numericCacheUsage({ cached_tokens: 0, prompt_tokens_details: { cached_tokens: 90, secret: "credential" } }), { cached_tokens: 0, prompt_tokens_details: { cached_tokens: 90 } });
	assert.equal(numericCacheUsage(undefined), undefined);
});

test("observer sees the pinned Pi adapter's real fetch path and detects unsupported flat cached_tokens", async () => {
	const original = globalThis.fetch;
	const reports = [];
	globalThis.fetch = async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1,"cached_tokens":90}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
	const observer = installCacheTransportAudit((_url, init) => ({ requestObserved: typeof init.body === "string" }), (r) => reports.push(r));
	try {
		const provider = opencodeGoProvider();
		const model = provider.getModels().find((m) => m.id === "glm-5.3");
		const result = await provider.streamSimple(model, { systemPrompt: "synthetic", messages: [{ role: "user", content: "OK", timestamp: 0 }] }, { apiKey: "synthetic-only", maxTokens: 32, maxRetries: 0 }).result();
		await observer.settled();
		assert.equal(result.stopReason, "stop");
		assert.equal(reports[0].requestObserved, true);
		assert.equal(reports[0].usageUpdates[0].usage.cached_tokens, 90);
		assert.equal(result.usage.cacheRead, 0, "known pinned-adapter blind spot, not yet attributed to the real Session");
	} finally { observer.restore(); globalThis.fetch = original; }
});

test("HTTP observer forwards original arguments and Response, observes split SSE usage without retaining text", async () => {
	const wire = 'data: {"choices":[{"delta":{"content":"private response"}}]}\n\ndata: {"usage":{"prompt_tokens":100,"cached_tokens":90,"secret":"credential"}}\n\ndata: {"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n\n';
	const encoder = new TextEncoder();
	const response = new Response(new ReadableStream({ start(controller) {
		controller.enqueue(encoder.encode(wire.slice(0, 83)));
		controller.enqueue(encoder.encode(wire.slice(83)));
		controller.close();
	} }), { headers: { "content-type": "text/event-stream" } });
	const init = { body: "private request", headers: { Authorization: "credential" } };
	const original = async (url, options) => { assert.equal(url, "https://synthetic.invalid"); assert.equal(options, init); return response; };
	const target = { fetch: original }, reports = [];
	const observer = installCacheTransportAudit(() => ({ sequence: 1 }), (r) => reports.push(r), target);
	assert.equal(await target.fetch("https://synthetic.invalid", init), response);
	assert.equal(await response.text(), wire);
	await observer.settled();
	assert.equal(reports[0].doneMarker, true);
	assert.equal(reports[0].usageUpdates.length, 2, "keep all usage updates so a later overwrite is visible");
	assert.deepEqual(reports[0].usageUpdates[0].usage, { prompt_tokens: 100, cached_tokens: 90 });
	assert.doesNotMatch(JSON.stringify(reports), /private|credential|Authorization/);
	observer.restore();
	assert.equal(target.fetch, original);
});
