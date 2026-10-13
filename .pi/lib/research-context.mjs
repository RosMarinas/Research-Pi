import { legacyRuntimeMessageCard } from "./subagent-message.mjs";

export function runtimeMessageContextText(message) {
	if (message?.metadata?.modelCardVersion === 1) return String(message.body ?? "").trim();
	return legacyRuntimeMessageCard(message);
}

export function projectResearchContextMessages(messages) {
	// Shape Runtime and tool output before its first model exposure. Once a
	// message is visible, keep the serialized history stable until an explicit
	// compaction replaces it. Runtime consumption controls redelivery only.
	return messages;
}
