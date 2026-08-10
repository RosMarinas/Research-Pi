const MAX_ANSWER_CHARS = 16_000;
const MAX_SOURCES = 12;

function bounded(value, maxChars) {
	const text = String(value ?? "").trim();
	return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
}

export function parseDeepSeekWebSearchResponse(message) {
	const answers = [];
	const sourceMap = new Map();
	const errors = [];
	const searches = [];

	for (const block of Array.isArray(message?.content) ? message.content : []) {
		if (block?.type === "text" && typeof block.text === "string") {
			answers.push(block.text);
			continue;
		}
		if (block?.type === "server_tool_use" && block.name === "web_search") {
			searches.push({ id: block.id, query: block.input?.query });
			continue;
		}
		if (block?.type !== "web_search_tool_result") continue;
		if (Array.isArray(block.content)) {
			for (const result of block.content) {
				if (result?.type !== "web_search_result" || typeof result.url !== "string") continue;
				if (!sourceMap.has(result.url)) {
					sourceMap.set(result.url, {
						title: bounded(result.title || result.url, 300),
						url: result.url,
						pageAge: result.page_age || null,
					});
				}
			}
		} else if (block.content?.type === "web_search_tool_result_error") {
			errors.push(String(block.content.error_code || "unknown_search_error"));
		}
	}

	const usage = message?.usage ?? {};
	return {
		answer: bounded(answers.join("\n").trim(), MAX_ANSWER_CHARS),
		sources: [...sourceMap.values()].slice(0, MAX_SOURCES),
		errors,
		searches,
		stopReason: message?.stop_reason ?? null,
		model: message?.model ?? null,
		usage: {
			inputTokens: Number(usage.input_tokens) || 0,
			outputTokens: Number(usage.output_tokens) || 0,
			cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
			cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
			webSearchRequests: Number(usage.server_tool_use?.web_search_requests) || searches.length,
		},
	};
}

export function formatDeepSeekWebSearchResult(result) {
	const sections = [];
	sections.push(result.answer || "DeepSeek returned no synthesized answer.");
	if (result.sources.length) {
		sections.push(
			`Sources returned by DeepSeek:\n${result.sources
				.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}${source.pageAge ? ` · ${source.pageAge}` : ""}`)
				.join("\n\n")}`,
		);
	} else {
		sections.push("Warning: the API returned no structured web sources; treat the answer as unverified model synthesis.");
	}
	if (result.errors.length) sections.push(`Search errors: ${[...new Set(result.errors)].join(", ")}`);
	return sections.join("\n\n");
}
