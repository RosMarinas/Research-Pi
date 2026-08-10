import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDeepSeekWebSearchResult,
	parseDeepSeekWebSearchResponse,
} from "../.pi/lib/deepseek-web-search.mjs";

test("extracts bounded sources without persisting encrypted search payloads", () => {
	const parsed = parseDeepSeekWebSearchResponse({
		model: "deepseek-v4-flash",
		stop_reason: "end_turn",
		content: [
			{ type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "DeepSeek docs" } },
			{
				type: "web_search_tool_result",
				content: [
					{
						type: "web_search_result",
						title: "DeepSeek API Docs",
						url: "https://api-docs.deepseek.com/",
						page_age: "today",
						encrypted_content: "must-not-survive",
					},
				],
			},
			{ type: "text", text: "DeepSeek provides official API documentation." },
		],
		usage: { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
	});
	assert.equal(parsed.sources.length, 1);
	assert.equal(parsed.usage.webSearchRequests, 1);
	assert.doesNotMatch(JSON.stringify(parsed), /must-not-survive/);
	assert.match(formatDeepSeekWebSearchResult(parsed), /https:\/\/api-docs\.deepseek\.com/);
});

test("bounds a small research pass to twelve structured sources", () => {
	const parsed = parseDeepSeekWebSearchResponse({
		content: [
			{
				type: "web_search_tool_result",
				content: Array.from({ length: 15 }, (_, index) => ({
					type: "web_search_result",
					title: `Source ${index}`,
					url: `https://example.com/${index}`,
					encrypted_content: "ignored",
				})),
			},
		],
	});
	assert.equal(parsed.sources.length, 12);
});

test("marks synthesis without structured sources as unverified", () => {
	const parsed = parseDeepSeekWebSearchResponse({ content: [{ type: "text", text: "Maybe." }] });
	assert.match(formatDeepSeekWebSearchResult(parsed), /unverified model synthesis/);
});
