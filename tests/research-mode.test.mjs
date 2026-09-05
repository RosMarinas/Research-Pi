import assert from "node:assert/strict";
import test from "node:test";
import researchMode, { applyResearchIdentity } from "../.pi/extensions/research-mode.ts";
import { mapProviderSystemPrompt } from "../.pi/lib/provider-system-prompt.mjs";
import { Agent } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js";
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

test("research identity stays byte-stable through a mailbox wake and its tool continuation", async () => {
	const handlers = new Map();
	researchMode({ on: (event, handler) => handlers.set(event, handler) });
	const base = buildSystemPrompt({ cwd: "/synthetic-project", selectedTools: ["probe"], toolSnippets: { probe: "Return synthetic data" }, appendSystemPrompt: "Keep this guardrail unchanged." });
	const faux = createFauxCore({});
	faux.setResponses([
		fauxAssistantMessage("user turn done"),
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe-1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("mailbox turn done"),
		fauxAssistantMessage("next user turn done"),
	]);
	const sent = [];
	const agent = new Agent({
		initialState: { model: faux.getModel(), systemPrompt: base, tools: [{ name: "probe", label: "Probe", description: "Synthetic only", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }] },
		streamFn: async (model, context, options) => {
			const payload = { messages: [{ role: "system", content: context.systemPrompt }] };
			const result = await handlers.get("before_provider_request")?.({ payload });
			sent.push((result ?? payload).messages[0].content);
			return faux.streamSimple(model, context, options);
		},
	});
	// Use Core's real run/finally and next-turn refresh paths, without creating
	// a filesystem-backed Session, loading user resources, or making API calls.
	const session = Object.create(AgentSession.prototype);
	Object.assign(session, {
		agent, _baseSystemPrompt: base,
		_handlePostAgentRun: async () => false,
		_flushPendingBashMessages() {}, async _emitAgentSettled() { this._isAgentRunActive = false; },
	});
	session._installAgentNextTurnRefresh();
	const userTurn = async (text) => {
		const result = handlers.get("before_agent_start")({ systemPrompt: base });
		session._systemPromptOverride = result?.systemPrompt;
		agent.state.systemPrompt = result?.systemPrompt ?? base;
		await session._runAgentPrompt({ role: "user", content: text, timestamp: 0 });
	};
	await userTurn("start");
	assert.equal(session._systemPromptOverride, undefined, "Core clears the override when a user run settles");
	await session.sendCustomMessage({ customType: "research-runtime-message", content: "synthetic result", display: false }, { triggerTurn: true });
	await userTurn("continue");
	assert.equal(sent.length, 4, JSON.stringify(agent.state.messages.map((m) => ({ role: m.role, stop: m.stopReason, error: m.errorMessage }))));
	assert.match(sent[0], /^You are a computational research agent/);
	assert.ok(sent.every((prompt) => prompt === sent[0]), "mailbox tool continuation must not revert to the native coding identity");
	assert.match(sent[2], /Keep this guardrail unchanged/);
});

const native = buildSystemPrompt({ cwd: "/synthetic-project", selectedTools: [], appendSystemPrompt: "Keep current guardrails." });
const research = applyResearchIdentity(native);
const cacheControl = { type: "ephemeral" };
for (const [name, makePayload] of Object.entries({
	"Chat Completions": (text) => ({ messages: [{ role: "system", content: text }] }),
	"developer message": (text) => ({ messages: [{ role: "developer", content: [{ type: "text", text }] }] }),
	"Responses input": (text) => ({ input: [{ role: "developer", content: [{ type: "input_text", text }] }] }),
	"Codex instructions": (text) => ({ instructions: text, input: [] }),
	"Anthropic blocks": (text) => ({ system: [{ type: "text", text: "Provider-owned identity", cache_control: cacheControl }, { type: "text", text, cache_control: cacheControl }] }),
	"Anthropic string": (text) => ({ system: text }),
	"Bedrock blocks": (text) => ({ system: [{ text }, { cachePoint: { type: "default" } }] }),
	"Gemini config": (text) => ({ config: { systemInstruction: text, temperature: 0.5 } }),
	"Gemini parts": (text) => ({ config: { systemInstruction: { parts: [{ text }] } } }),
	"Pi messages context": (text) => ({ context: { systemPrompt: text, messages: [{ role: "user", content: native }] } }),
})) {
	test(`research identity normalizes ${name} without changing payload metadata or history`, () => {
		const payload = { model: "synthetic", tools: [{ name: "probe" }], ...makePayload(native) };
		const history = [{ role: "user", content: native }, { role: "assistant", content: native }, { role: "tool", content: native }];
		if (payload.messages) payload.messages.push(...history);
		else if (payload.input) payload.input.push(...history);
		else payload.messages = history;
		const original = structuredClone(payload);
		const expected = { ...payload, ...makePayload(research) };
		if (expected.input) expected.input.push(...history);
		else if (makePayload(research).messages) expected.messages.push(...history);
		const rewritten = mapProviderSystemPrompt(payload, applyResearchIdentity);
		assert.deepEqual(rewritten, expected);
		assert.deepEqual(payload, original, "the stored source must not be mutated");
		assert.deepEqual(mapProviderSystemPrompt(rewritten, applyResearchIdentity), rewritten, "idempotent after normal user turns");
	});
}

test("custom system roles and deliberate instruction changes are not replaced by a saved prompt", () => {
	const custom = { messages: [{ role: "system", content: "Custom analysis role with new restrictions" }] };
	assert.deepEqual(mapProviderSystemPrompt(custom, applyResearchIdentity), custom);
	assert.equal(mapProviderSystemPrompt(null, applyResearchIdentity), null);
	const updated = { instructions: native + "\nNew resource or tool policy." };
	assert.equal(mapProviderSystemPrompt(updated, applyResearchIdentity).instructions, research + "\nNew resource or tool policy.");
});
