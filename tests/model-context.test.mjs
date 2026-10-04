import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseContextWindow, setModelContextWindow } from "../.pi/lib/model-context.mjs";
import { selectModel } from "../.pi/lib/model-picker.mjs";
import { ModelRuntime } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
import { fauxProvider } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { getKeybindings } from "@earendil-works/pi-tui";

test("native context overrides preserve provider configuration and reach the actual Pi registry", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-"));
	try {
		const modelsPath = join(root, "models.json");
		await writeFile(modelsPath, '// Native JSONC\n{"providers":{"context-demo":{"modelOverrides":{"demo":{"promptCache":{"short":300},}}},"other":{"api":"openai-completions","apiKey":"keep-private","baseUrl":"https://example.test","models":[{"id":"other"}]}}}');
		await setModelContextWindow(root, "context-demo", "demo", parseContextWindow("872k"));
		const saved = JSON.parse(await readFile(modelsPath, "utf8"));
		assert.equal(saved.providers.other.apiKey, "keep-private");
		assert.deepEqual(saved.providers["context-demo"].modelOverrides.demo.promptCache, { short: 300 });
		const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json"), modelsStorePath: join(root, "store.json"), refreshOnCreate: false });
		runtime.registerNativeProvider(fauxProvider({ provider: "context-demo", models: [{ id: "demo", contextWindow: 272000 }] }).provider);
		await runtime.refresh({ allowNetwork: false });
		assert.equal(runtime.getModel("context-demo", "demo").contextWindow, 872000);
		await setModelContextWindow(root, "context-demo", "demo", null);
		await runtime.refresh({ allowNetwork: false });
		assert.equal(runtime.getModel("context-demo", "demo").contextWindow, 272000);
		assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")).providers["context-demo"].modelOverrides.demo.promptCache, { short: 300 });
		assert.equal(parseContextWindow("1.05m"), 1050000);
		for (const input of ["0", "-1", "oops", "1.2"]) assert.throws(() => parseContextWindow(input), /positive token count/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("large model picker keeps keyboard selection visible and supports filtering and cancel", { timeout: 5000 }, async () => {
	const values = Array.from({ length: 80 }, (_, i) => "provider/model-" + String(i).padStart(2, "0"));
	let component;
	const ctx = { ui: { custom: (factory) => new Promise((resolve) => {
		component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_style, text) => text }, getKeybindings(), resolve);
	}) } };
	const pending = selectModel(ctx, "Pi models", values, values[0]);
	for (let i = 0; i < 79; i++) component.handleInput("\x1b[B");
	const rendered = component.render(80);
	assert.ok(rendered.length < 16);
	assert.ok(rendered.some((line) => line.includes("model-79")));
	component.handleInput("\r"); assert.equal(await pending, values[79]);
	const filtered = selectModel(ctx, "Pi models", values);
	for (const key of "model-42") component.handleInput(key);
	component.handleInput("\r");
	assert.equal(await filtered, values[42]);
	const cancelled = selectModel(ctx, "Pi models", values);
	component.handleInput("\x1b"); assert.equal(await cancelled, undefined);
});
