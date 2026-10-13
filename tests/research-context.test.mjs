import assert from "node:assert/strict";
import test from "node:test";
import {
	projectResearchContextMessages,
	runtimeMessageContextText,
} from "../.pi/lib/research-context.mjs";
import { RUNTIME_MESSAGE_KIND } from "../.pi/lib/research-runtime.mjs";
import { subagentModelCard, subagentResultSection } from "../.pi/lib/subagent-message.mjs";

function runtimeCustom(messageId, content = "persisted session card", details = {}) {
	return {
		role: "custom",
		customType: RUNTIME_MESSAGE_KIND,
		content,
		display: true,
		details: { messageId, transient: true, ...details },
		timestamp: 1,
	};
}

test("Runtime result cards remain byte-stable after consumption", () => {
	const job = {
		id: "codex-result",
		actionId: "action:codex-result",
		status: "completed",
		mission: "inspect the implementation",
		result: {
			outcome: "succeeded",
			goal_satisfied: true,
			completion_basis: "The focused check passed.",
			summary: "The implementation passed the targeted check.",
			evidence: ["tests/probe.test.mjs:42 passed"],
		},
	};
	const message = {
		id: "msg-result",
		type: "result",
		body: subagentModelCard(job, { messageId: "msg-result" }),
		status: "delivered",
		relatesTo: job.actionId,
		metadata: { jobId: job.id, status: job.status, modelCardVersion: 1 },
	};
	const snapshot = { messages: [message], actions: [{ id: job.actionId, status: "completed" }] };
	const custom = runtimeCustom(message.id, runtimeMessageContextText(message));
	const first = projectResearchContextMessages([custom], snapshot);
	assert.equal(first.length, 1);
	assert.equal(first[0].content, message.body);
	assert.match(first[0].content, /Result: The implementation passed/);
	assert.match(first[0].content, /tests\/probe\.test\.mjs:42/);

	message.status = "consumed";
	assert.deepEqual(projectResearchContextMessages([custom], snapshot), first);
});

test("an outcome_unknown card remains as history after its Action is terminal", () => {
	const job = {
		id: "codex-unknown",
		actionId: "action:codex-unknown",
		status: "outcome_unknown",
		mission: "supervise the remote run",
		writeScope: ["research/campaign"],
		sideEffect: { state: "unknown" },
	};
	const message = {
		id: "msg-unknown",
		type: "result",
		body: subagentModelCard(job, { messageId: "msg-unknown" }),
		status: "consumed",
		relatesTo: job.actionId,
		metadata: { jobId: job.id, status: job.status, modelCardVersion: 1 },
	};
	const action = { id: job.actionId, externalId: job.id, status: "outcome_unknown" };
	const custom = runtimeCustom(message.id, runtimeMessageContextText(message));
	const first = projectResearchContextMessages([custom], { messages: [message], actions: [action] });
	assert.match(first[0].content, /RUNTIME RECONCILIATION/);
	action.status = "failed";
	assert.deepEqual(projectResearchContextMessages([custom], { messages: [message], actions: [action] }), first);
});

test("a consumed ASK remains in history when the same job has a new request", () => {
	const ask = (id, requestId, status) => ({
		id,
		type: "ask",
		body: `RUNTIME REQUEST\nMessage: ${id}.\nRequest: ${requestId}.`,
		status,
		relatesTo: requestId,
		metadata: { jobId: "codex-ask", requestId, status: "input_required", modelCardVersion: 1 },
	});
	const oldAsk = ask("msg-old", "request-old", "consumed");
	const newAsk = ask("msg-new", "request-new", "delivered");
	const projected = projectResearchContextMessages(
		[runtimeCustom(oldAsk.id, oldAsk.body), runtimeCustom(newAsk.id, newAsk.body)],
		{ messages: [oldAsk, newAsk], actions: [{ externalId: "codex-ask", status: "input_required" }] },
	);
	assert.equal(projected.length, 2);
	assert.match(projected[0].content, /request-old/);
	assert.match(projected[1].content, /request-new/);
});

test("secret and host-capability requests keep their required channels", () => {
	const base = {
		id: "codex-request",
		actionId: "action:codex-request",
		status: "input_required",
		pendingRequest: {
			id: "request-1",
			question: "Configure the required credential.",
			audience: "user",
		},
	};
	const secret = subagentModelCard({
		...base,
		pendingRequest: { ...base.pendingRequest, kind: "secret", secret: true },
	});
	assert.match(secret, /Do not put the secret in a message/);
	assert.match(secret, /send only a confirmation/);

	const capability = subagentModelCard({
		...base,
		pendingRequest: { ...base.pendingRequest, kind: "host_capability", audience: "leader" },
	});
	assert.match(capability, /Use the host approval dialog/);
	assert.doesNotMatch(capability, /action=respond/);
});

test("historical tool results remain byte-stable across a new turn", () => {
	const output = `START\n${"diagnostic evidence\n".repeat(400)}END`;
	const image = { type: "image", data: "encoded-image", mimeType: "image/png" };
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "inspect-state" } }],
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: output }, image],
			isError: false,
		},
		{ role: "user", content: "continue", timestamp: 2 },
	];
	const projected = projectResearchContextMessages(messages, { messages: [], actions: [] });
	assert.deepEqual(projected, messages);
	assert.equal(projected[1].content[0].text, output);
});

test("historical thinking and current-turn tool results are not rewritten", () => {
	const currentOutput = `START\n${"current evidence\n".repeat(400)}END`;
	const messages = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "old private reasoning" }, { type: "text", text: "old answer" }] },
		{ role: "user", content: "inspect now", timestamp: 1 },
		{ role: "assistant", content: [{ type: "thinking", thinking: "current reasoning" }, { type: "toolCall", id: "call-current", name: "bash", arguments: {} }] },
		{ role: "toolResult", toolCallId: "call-current", toolName: "bash", content: [{ type: "text", text: currentOutput }], isError: false },
	];
	const projected = projectResearchContextMessages(messages, { messages: [], actions: [] });
	assert.deepEqual(projected, messages);
});

test("appending a turn preserves every serialized message in the previous prefix", () => {
	const runtime = runtimeCustom("msg-stable", "RUNTIME RESULT\nMessage: msg-stable.\nResult: complete.");
	const initial = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }] },
		{ role: "toolResult", toolCallId: "call-stable", toolName: "bash", content: [{ type: "text", text: "evidence\n".repeat(600) }], isError: false },
		runtime,
	];
	const first = projectResearchContextMessages(initial, {
		messages: [{ id: "msg-stable", status: "delivered" }],
		actions: [],
	});
	const next = projectResearchContextMessages([...initial, { role: "user", content: "continue" }], {
		messages: [{ id: "msg-stable", status: "consumed" }],
		actions: [],
	});
	assert.deepEqual(next.slice(0, first.length).map(JSON.stringify), first.map(JSON.stringify));
});

test("legacy Runtime results use a trace card instead of a cut body", () => {
	const text = runtimeMessageContextText({
		id: "msg-legacy",
		type: "result",
		body: "legacy detail ".repeat(1_000),
		metadata: { jobId: "codex-legacy", status: "completed" },
	});
	assert.match(text, /RUNTIME RESULT/);
	assert.match(text, /Job: codex-legacy/);
	assert.match(text, /action=result/);
	assert.doesNotMatch(text, /legacy detail/);
});

test("ordinary Runtime messages use a traceable plain message card", () => {
	const text = runtimeMessageContextText({
		id: "msg-analysis",
		type: "notify",
		from: "analysis:session-1",
		body: "Result: the second explanation fits the recorded evidence.",
		metadata: { kind: "analysis_handoff" },
	});
	assert.match(text, /^RUNTIME MESSAGE/);
	assert.match(text, /Message: msg-analysis/);
	assert.match(text, /Purpose: analysis_handoff/);
	assert.match(text, /Content:\nResult:/);
	assert.doesNotMatch(text, /\[Research Runtime/);
});

test("explicit result sections preserve complete semantic items and redact credentials", () => {
	const longObservation = `Observation ${"x".repeat(5_000)} END`;
	const text = subagentResultSection({
		id: "codex-detail",
		status: "completed",
		result: {
			evidence: [longObservation, "Authorization: Bearer SECRET_TOKEN_123456"],
		},
	}, "evidence");
	assert.match(text, /END/);
	assert.match(text, /Bearer \[REDACTED\]/);
	assert.doesNotMatch(text, /SECRET_TOKEN_123456/);
});
