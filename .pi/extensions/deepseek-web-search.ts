import Anthropic from "@anthropic-ai/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatDeepSeekWebSearchResult,
	parseDeepSeekWebSearchResponse,
} from "../lib/deepseek-web-search.mjs";

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_SEARCH_MODEL = process.env.RESEARCH_PI_SEARCH_MODEL?.trim() || "deepseek-v4-flash";
const configuredThinkingBudget = Number(process.env.RESEARCH_PI_SEARCH_THINKING_BUDGET_TOKENS);
const DEEPSEEK_SEARCH_THINKING_BUDGET = Number.isInteger(configuredThinkingBudget) && configuredThinkingBudget > 0
	? configuredThinkingBudget
	: 1_024;
const configuredDefaultMaxUses = Number(process.env.RESEARCH_PI_SEARCH_DEFAULT_MAX_USES);
const DEEPSEEK_SEARCH_DEFAULT_MAX_USES = Number.isInteger(configuredDefaultMaxUses)
	? Math.max(1, Math.min(configuredDefaultMaxUses, 5))
	: 3;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "DeepSeek Web Search",
		description:
			"Run one bounded web lookup or small research pass through DeepSeek's native Anthropic-compatible Web Search. Use for current facts, direct sources, and limited cross-checking; use Codex when search and synthesis become substantial.",
		promptSnippet: "Search the current web directly for a bounded factual lookup",
		promptGuidelines: [
			"Use web_search for a simple current lookup or to locate a few direct sources. State what claim the search is meant to verify.",
			"Pi may complete a bounded small research pass directly. Delegate to Codex when the user asks, or when the task genuinely needs many searches, substantial cross-checking, or enough intermediate organization to pollute the main context.",
			"Cite the returned URLs near claims. If the tool reports no structured sources, do not present its synthesis as web-verified evidence.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 2_000, description: "One precise web search question" }),
			maxUses: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 5, description: "Maximum native searches in this request; default 3" }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate) {
			const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
			if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured for DeepSeek Web Search.");
			const maxUses = Math.max(1, Math.min(params.maxUses ?? DEEPSEEK_SEARCH_DEFAULT_MAX_USES, 5));
			onUpdate?.({
				content: [{ type: "text", text: `Searching the web with DeepSeek (max ${maxUses} search use${maxUses === 1 ? "" : "s"})…` }],
				details: { query: params.query, maxUses, status: "searching" },
			});

			const client = new Anthropic({ apiKey, baseURL: DEEPSEEK_ANTHROPIC_BASE_URL, maxRetries: 2 });
			const message = await client.messages.create(
				{
					model: DEEPSEEK_SEARCH_MODEL,
					max_tokens: 8_192,
					thinking: { type: "enabled", budget_tokens: DEEPSEEK_SEARCH_THINKING_BUDGET },
					output_config: { effort: "max" },
					system: [
						{
							type: "text",
							text: [
								"Answer one bounded lookup using the native web_search tool.",
								"Prefer primary and authoritative sources. Distinguish sourced facts from inference.",
								"Keep the synthesis concise; the caller will receive the structured source URLs separately.",
							].join(" "),
						},
					],
					messages: [{ role: "user", content: [{ type: "text", text: params.query }] }],
					tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }],
				},
				{ signal },
			);
			const parsed = parseDeepSeekWebSearchResponse(message);
			return {
				content: [{ type: "text", text: formatDeepSeekWebSearchResult(parsed) }],
				details: {
					query: params.query,
					maxUses,
					provider: "deepseek-anthropic",
					...parsed,
				},
			};
		},
	});
}
