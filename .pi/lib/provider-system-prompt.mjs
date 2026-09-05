// Pi Core 0.84.2 serializes its system prompt differently across adapters.
// Touch only instruction fields, never user/assistant/tool history. Keep block
// boundaries and cache metadata intact. lastTextOnly is for appending a suffix.
export function mapProviderSystemPrompt(payload, transform, { lastTextOnly = false } = {}) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const mapText = (value) => {
		if (typeof value === "string") return transform(value);
		if (!Array.isArray(value)) return value;
		const last = value.findLastIndex((block) => typeof block?.text === "string");
		return value.map((block, index) => typeof block?.text === "string" && (!lastTextOnly || index === last)
			? { ...block, text: transform(block.text) } : block);
	};
	const result = { ...payload };
	for (const key of ["system", "instructions"]) {
		if (key in result) result[key] = mapText(result[key]);
	}
	for (const key of ["messages", "input"]) {
		if (!Array.isArray(result[key])) continue;
		const isInstruction = (message) => message?.role === "system" || message?.role === "developer";
		const last = result[key].findLastIndex(isInstruction);
		result[key] = result[key].map((message, index) => isInstruction(message) && (!lastTextOnly || index === last)
			? { ...message, content: mapText(message.content) } : message);
	}
	// Gemini and Vertex use a config.systemInstruction string (or Content parts).
	if (result.config?.systemInstruction !== undefined) {
		const instruction = result.config.systemInstruction;
		result.config = { ...result.config, systemInstruction: typeof instruction === "string"
			? transform(instruction) : { ...instruction, parts: mapText(instruction.parts) } };
	}
	// Pi's native messages transport sends the unconverted Context.
	if (typeof result.context?.systemPrompt === "string") {
		result.context = { ...result.context, systemPrompt: transform(result.context.systemPrompt) };
	}
	return result;
}
