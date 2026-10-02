import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import researchMode, { applyResearchIdentity } from "../.pi/extensions/research-mode.ts";
import { mapProviderSystemPrompt } from "../.pi/lib/provider-system-prompt.mjs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { getCurrentSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

test("Pi 1.0 research identity stays stable through a real Session mailbox wake and tool continuation", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-identity-"));
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage("user turn done"),
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe-1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("mailbox turn done"),
		fauxAssistantMessage("next user turn done"),
	]);
	const sent = [];
	const errors = [];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		appendSystemPrompt: ["Keep this guardrail unchanged."],
		extensionFactories: [researchMode, (pi) => pi.registerProvider(faux.provider)],
	});
	let session;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root, agentDir, model: faux.getModel(), resourceLoader: loader, settingsManager,
			sessionManager: SessionManager.inMemory(root), tools: ["probe"],
			customTools: [{ name: "probe", label: "Probe", description: "Synthetic only", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }],
		}));
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		const stream = session.agent.streamFunction;
		session.agent.streamFunction = (model, context, options) => {
			sent.push(getCurrentSystemPrompt(context.messages));
			return stream(model, context, options);
		};
		await session.prompt("start");
		await session.sendCustomMessage({ customType: "research-runtime-message", content: "synthetic result", display: false }, { triggerTurn: true });
		await session.agent.waitForIdle();
		await session.prompt("continue");
		assert.deepEqual(errors, []);
		assert.equal(sent.length, 4);
		assert.match(sent[0], /^You are a computational research agent/);
		assert.ok(sent.every((prompt) => prompt === sent[0]), "mailbox tool continuation must not revert to the native coding identity");
		assert.match(sent[2], /Keep this guardrail unchanged/);
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

const native = buildSystemPrompt({ cwd: "/synthetic-project", selectedTools: [], appendSystemPrompt: "Keep current guardrails." });
const research = applyResearchIdentity(native);
const cacheControl = { type: "ephemeral" };
test("research identity preserves structured sections and full-access prompt overrides", () => {
	const handlers = new Map();
	researchMode({ on: (event, handler) => handlers.set(event, handler) });
	const options = { forceSystemPrompt: native + "\nFull-access authority explanation" };
	handlers.get("before_agent_start")({ systemPromptOptions: options });
	assert.equal(options.forceSystemPrompt, research + "\nFull-access authority explanation");
	const input = [{ role: "system", content: "", sections: { preamble: native, evidence: "Keep evidence", retired: null }, toolsAdded: [{ name: "probe" }], timestamp: 0 }];
	const output = handlers.get("context_with_system")({ messages: input }).messages;
	assert.equal(output[0].sections.preamble, research);
	assert.equal(output[0].sections.evidence, "Keep evidence");
	assert.equal(output[0].sections.retired, null);
	assert.deepEqual(output[0].toolsAdded, input[0].toolsAdded);
	assert.equal(input[0].sections.preamble, native);
});
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
