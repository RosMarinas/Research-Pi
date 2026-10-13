import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export function parseContextWindow(value) {
	if (value === "inherit") return null;
	const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/i);
	const tokens = match ? Number(match[1]) * ({ "": 1, k: 1000, m: 1_000_000 }[match[2].toLowerCase()]) : NaN;
	if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error("Context window must be a positive token count (e.g. 872000, 872k, 1m), or inherit");
	return tokens;
}

export async function setModelContextWindow(agentDir, provider, modelId, tokens) {
	const { stripJsonComments } = await import(new URL("./utils/json.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	if (!provider || !modelId || provider === "__proto__" || modelId === "__proto__") throw new Error("A provider/model ID is required");
	const path = join(agentDir, "models.json");
	let config;
	try { config = JSON.parse(stripJsonComments((await readFile(path, "utf8")).replace(/^\uFEFF/, ""))); }
	catch (error) { if (error.code !== "ENOENT") throw error; config = { providers: {} }; }
	config.providers ??= {};
	if (tokens !== null) {
		if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error("Invalid context window");
		const entry = config.providers[provider] ??= {};
		entry.modelOverrides ??= {};
		entry.modelOverrides[modelId] = { ...entry.modelOverrides[modelId], contextWindow: tokens };
	} else {
		const override = config.providers[provider]?.modelOverrides?.[modelId];
		if (override) {
			delete override.contextWindow;
			if (!Object.keys(override).length) delete config.providers[provider].modelOverrides[modelId];
			if (!Object.keys(config.providers[provider].modelOverrides).length) delete config.providers[provider].modelOverrides;
			if (!Object.keys(config.providers[provider]).length) delete config.providers[provider];
		}
	}
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	return path;
}
