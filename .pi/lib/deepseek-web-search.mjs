const configuredMaxSources = Number(process.env.RESEARCH_PI_SEARCH_MAX_SOURCES);
const MAX_SOURCES = Number.isInteger(configuredMaxSources) && configuredMaxSources > 0 ? configuredMaxSources : 12;

function clean(value) {
	return String(value ?? "").trim();
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
						title: clean(result.title || result.url),
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
	const allSources = [...sourceMap.values()];
	return {
		answer: clean(answers.join("\n")),
		sources: allSources.slice(0, MAX_SOURCES),
		sourceCount: allSources.length,
		omittedSources: allSources.slice(MAX_SOURCES),
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
		const sourceCount = Number.isInteger(result.sourceCount) ? result.sourceCount : result.sources.length;
		sections.push(
			`Sources returned by DeepSeek${result.sources.length < sourceCount ? ` (showing ${result.sources.length} of ${sourceCount}; remaining source records are in tool details)` : ""}:\n${result.sources
				.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}${source.pageAge ? ` · ${source.pageAge}` : ""}`)
				.join("\n\n")}`,
		);
	} else {
		sections.push("Warning: the API returned no structured web sources; treat the answer as unverified model synthesis.");
	}
	if (result.errors.length) sections.push(`Search errors: ${[...new Set(result.errors)].join(", ")}`);
	return sections.join("\n\n");
}
