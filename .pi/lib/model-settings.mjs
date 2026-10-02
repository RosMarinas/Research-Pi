import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sanitizeBoundaryEnvironment } from "./project-boundary.mjs";
export { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

export function validateServiceTier(value) {
	if (!["inherit", "standard", "fast"].includes(value)) throw new Error(`Unsupported speed: ${value}`);
	return value;
}

export function supportsLeaderSpeed(model) {
	return ["openai", "openai-codex"].includes(model?.provider)
		&& ["openai-responses", "openai-codex-responses"].includes(model?.api)
		&& /^gpt-/.test(model?.id ?? "");
}

export function leaderServiceTierPayload(payload, model, tiers) {
	if (!supportsLeaderSpeed(model) || !payload || typeof payload !== "object") return undefined;
	const tier = tiers[`${model.provider}/${model.id}`] ?? "inherit";
	if (tier === "inherit") return undefined;
	return { ...payload, service_tier: tier === "fast" ? "priority" : "default" };
}

export function codexModelConfigArgs(request) {
	// Search is a native Codex capability. Keep it available for every Research Pi
	// Codex Actor instead of routing ordinary search through another provider.
	const args = ["-c", 'web_search="live"'];
	if (request.serviceTier && request.serviceTier !== "inherit") {
		args.push("-c", `service_tier=${JSON.stringify(request.serviceTier === "fast" ? "fast" : "default")}`);
		if (request.serviceTier === "fast") args.push("-c", "features.fast_mode=true");
	}
	const subagent = request.subagent ?? {};
	for (const [field, key] of [["model", "default_subagent_model"], ["reasoningEffort", "default_subagent_reasoning_effort"]]) {
		if (subagent[field] && subagent[field] !== "inherit") {
			args.push("-c", `agents.${key}=${JSON.stringify(subagent[field])}`);
		}
	}
	return args;
}

export function codexServiceTierParams(tier) {
	return !tier || tier === "inherit" ? {} : { serviceTier: tier === "fast" ? "priority" : "default" };
}

export function codexSupportsFast(model) {
	return Boolean(model?.serviceTiers?.some((tier) => tier.id === "priority" || tier.id === "fast"));
}

export function codexReasoningChoices(config, models, modelId) {
	const ids = modelId === "inherit" ? [config.subagents.advisor.model, config.subagents.executor.model] : [modelId];
	const capabilities = ids.map((id) => models.find((model) => model.model === id)?.supportedReasoningEfforts.map((item) => item.reasoningEffort) ?? []);
	return capabilities.reduce((common, supported) => common.filter((effort) => supported.includes(effort)));
}

export function parseAntigravityModels(output) {
	return String(output ?? "").split(/\r?\n/).map((line) => {
		if (!line.includes("\t")) return null;
		const [model, ...label] = line.trim().split(/\t+/);
		return model && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model) ? { model, label: label.join(" ") || model } : null;
	}).filter(Boolean);
}

export function listAntigravityModels({ cwd, agyBin = process.env.PI_ANTIGRAVITY_BIN ?? "agy", timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(agyBin, ["models"], { cwd, env: sanitizeBoundaryEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(parseAntigravityModels(stdout));
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error("Antigravity model catalog timed out; authenticate agy and retry /models"));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", finish);
		child.on("exit", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `agy models exited (${code})`)));
	});
}

// Read the signed-in Codex client's catalog, including supported efforts and tiers.
// No thread or model turn is created; only this short-lived catalog process is closed.
export function listCodexModels({ cwd, codexBin = process.env.PI_CODEX_BIN ?? "codex", timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(codexBin, ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: false });
		const lines = createInterface({ input: child.stdout });
		const models = [];
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			lines.close();
			child.stdin.end();
			child.kill();
			if (error) reject(error); else resolve(models.filter((model) => !model.hidden));
		};
		const timer = setTimeout(() => finish(new Error("Codex model catalog timed out; check codex login and retry /models")), timeoutMs);
		const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
		child.on("error", (error) => finish(error));
		child.stdin.on("error", (error) => finish(error));
		child.on("exit", (code) => finish(new Error(`Codex model catalog exited (${code}); check codex login`)));
		lines.on("line", (line) => {
			let message;
			try { message = JSON.parse(line); } catch { return; }
			if (![1, 2].includes(message.id)) return;
			if (message.error) return finish(new Error(message.error.message));
			if (message.id === 1) {
				send({ method: "initialized", params: {} });
				send({ id: 2, method: "model/list", params: { limit: 100 } });
			} else {
				models.push(...(message.result?.data ?? []));
				if (message.result?.nextCursor) send({ id: 2, method: "model/list", params: { limit: 100, cursor: message.result.nextCursor } });
				else finish();
			}
		});
		send({ id: 1, method: "initialize", params: { clientInfo: { name: "research_pi_models", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
	});
}
