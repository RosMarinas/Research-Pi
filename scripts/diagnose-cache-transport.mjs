// Four bounded synthetic requests through the pinned Pi adapter. No Session or
// project content is uploaded. Compare actual HTTP bodies and raw SSE usage
// against Pi's parsed usage; do not infer a cache hit from timings alone.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { opencodeGoProvider } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.js";
import { mergeProviderAttributionHeaders } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-attribution.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live: four billed synthetic requests. --native-output-budget tests the 131072 reservation with a streamed-output cancellation guard.");
const maxTokens = process.argv.includes("--native-output-budget") ? 131072 : 128;
let apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) {
	try { apiKey = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^\s*(?:export\s+)?OPENCODE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(['"])(.*)\1$/, "$2"); } catch {}
}
if (!apiKey) {
	try { const auth = JSON.parse(readFileSync(new URL("../.pi/agent/auth.json", import.meta.url), "utf8")); apiKey = auth["opencode-go"]?.key ?? auth.opencode?.key; } catch {}
}
if (!apiKey) throw new Error("Credential unavailable; no requests sent.");
const provider = opencodeGoProvider();
// The active Session uses this Go alias, which is absent from the installed
// static catalog. Use GLM's Chat Completions transport metadata, but send the
// exact observed alias; do not silently substitute a different served model.
const model = { ...provider.getModels().find((m) => m.id === "glm-5.3"), id: "glm-5.3-flash" };
const sessionId = randomUUID();
const headers = mergeProviderAttributionHeaders(model, { getEnableInstallTelemetry: () => false }, sessionId);
const context = {
	systemPrompt: `Synthetic transport experiment ${sessionId}. The tool history below is test data. Reply only OK.`,
	messages: [{ role: "user", content: "Read the synthetic records, then reply OK.", timestamp: 0 }],
	tools: [{ name: "probe", description: "Read synthetic records", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } }],
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function appendTool(index, repeats) {
	context.messages.push(
		{ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "toolUse", usage, content: [{ type: "toolCall", id: `probe_${index}`, name: "probe", arguments: { index } }] },
		{ role: "toolResult", toolCallId: `probe_${index}`, toolName: "probe", timestamp: 0, isError: false, content: [{ type: "text", text: `Record ${index}:` + " alpha beta gamma delta epsilon zeta eta theta".repeat(repeats) }] },
	);
}
for (let i = 0; i < 40; i++) appendTool(i, 520);
let previousBody;
for (let index = 0; index < 4; index++) {
	if (index === 3) appendTool(40, 40);
	let rawTask, bodyComparison, status;
	const controller = new AbortController();
	const started = Date.now();
	const stream = provider.streamSimple(model, context, {
		apiKey, headers, sessionId, maxTokens, reasoning: "max", maxRetries: 0,
		signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
		fetch: async (url, init) => {
			const body = String(init.body);
			let commonBytes = 0;
			if (previousBody) while (commonBytes < previousBody.length && previousBody[commonBytes] === body[commonBytes]) commonBytes++;
			bodyComparison = { identical: previousBody === undefined ? null : previousBody === body, commonChars: commonBytes, chars: body.length };
			previousBody = body;
			const response = await fetch(url, init);
			status = response.status;
			rawTask = response.clone().text().then((wire) => wire.split(/\r?\n/).flatMap((line) => {
				if (!line.startsWith("data:")) return [];
				try { const chunk = JSON.parse(line.slice(5).trim()); return [{ usage: chunk.usage, choiceUsage: chunk.choices?.[0]?.usage, model: chunk.model, error: Boolean(chunk.error) }]; } catch { return []; }
			}));
			return response;
		},
	});
	let outputChars = 0;
	for await (const event of stream) {
		if (typeof event.delta === "string") outputChars += event.delta.length;
		if (outputChars > 8192) controller.abort();
	}
	const result = await stream.result();
	const raw = await rawTask ?? [];
	console.log(JSON.stringify({ index, maxTokens, status, seconds: (Date.now() - started) / 1000, bodyComparison,
		rawUsage: raw.filter((r) => r.usage || r.choiceUsage), responseModels: [...new Set(raw.map((r) => r.model).filter(Boolean))],
		parsedUsage: { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite }, stopReason: result.stopReason, streamError: raw.some((r) => r.error) }));
	if (status !== 200 || result.stopReason === "error" || result.stopReason === "aborted" || !raw.some((r) => r.usage || r.choiceUsage)) {
		process.exitCode = 1;
		break;
	}
}
