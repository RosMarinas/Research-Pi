import assert from "node:assert/strict";
import test from "node:test";
import toolActivityExtension, {
	formatToolActivity,
	formatToolTerminal,
	summarizeToolCall,
} from "../.pi/extensions/tool-activity.ts";

test("tool activity summaries are bounded and hide credential-like text", () => {
	assert.equal(summarizeToolCall("read", { path: "src/model.ts" }), "src/model.ts");
	assert.equal(summarizeToolCall("web_search", { query: "DeepSeek context limits" }), "DeepSeek context limits");
	assert.equal(summarizeToolCall("read", { path: ".env.local" }), "[protected]");
	assert.equal(summarizeToolCall("bash", { command: "export API_KEY=synthetic-secret" }), "[protected]");
	assert.equal(summarizeToolCall("bash", { command: "curl -H 'Bearer synthetic-value' example.invalid" }), "[protected]");
	assert.equal(summarizeToolCall("unknown", { token: "do-not-render" }), "");
});

test("tool activity formats running, parallel, and terminal states", () => {
	const first = { id: "one", name: "read", summary: "README.md", startedAt: 1000 };
	const second = { id: "two", name: "web_search", summary: "current docs", startedAt: 1500 };
	assert.equal(formatToolActivity([first], 2250), "⚙ read · README.md · 1.3s");
	assert.equal(formatToolActivity([first, second], 2500), "⚙ 2 tools · latest web_search · current docs · 1.0s");
	assert.equal(formatToolTerminal(first, false, 3000), "✓ read · README.md · 2.0s");
	assert.equal(formatToolTerminal(second, true, 3000), "✗ web_search · current docs · failed · 1.5s");
});

test("tool activity extension follows Pi lifecycle events", () => {
	const handlers = {};
	const statuses = [];
	toolActivityExtension({
		on(event, handler) {
			handlers[event] = handler;
		},
	});
	const ctx = {
		hasUI: true,
		ui: {
			setStatus(key, value) {
				statuses.push({ key, value });
			},
		},
	};
	const start = { toolCallId: "call-1", toolName: "read", args: { path: "README.md" } };
	handlers.tool_execution_start(start, ctx);
	assert.match(statuses.at(-1).value, /^⚙ read · README\.md/);
	handlers.tool_execution_end({ toolCallId: "call-1", toolName: "read", isError: false }, ctx);
	assert.match(statuses.at(-1).value, /^✓ read · README\.md/);
	handlers.session_shutdown({}, ctx);
	assert.equal(statuses.at(-1).value, undefined);
});
