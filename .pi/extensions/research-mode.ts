import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mapProviderSystemPrompt } from "../lib/provider-system-prompt.mjs";

const NATIVE_IDENTITY =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const RESEARCH_IDENTITY =
	"You are a computational research agent operating inside Pi, an agent harness for scientific work. You investigate research questions through code, experiments, diagnostic probes, evidence analysis, and reversible implementation changes. Code is primarily an experimental instrument until a method earns convergence.";

export function applyResearchIdentity(systemPrompt: string): string {
	if (!systemPrompt.startsWith(NATIVE_IDENTITY)) return systemPrompt;
	return `${RESEARCH_IDENTITY}${systemPrompt.slice(NATIVE_IDENTITY.length)}`;
}

export default function (pi: ExtensionAPI) {
	// An earlier extension (e.g. full-access boundary messaging) may force a
	// complete prompt, which Core applies after context hooks. Normalize it too.
	pi.on("before_agent_start", (event) => {
		const forced = event.systemPromptOptions.forceSystemPrompt;
		if (typeof forced === "string") event.systemPromptOptions.forceSystemPrompt = applyResearchIdentity(forced);
	});
	// Pi 1.0 exposes the full transcript before provider serialization. This
	// also covers mailbox wakes and preserves mid-conversation prompt sections
	// and tool changes, without patching each provider's HTTP payload.
	pi.on("context_with_system", (event) => ({
		messages: mapProviderSystemPrompt({ messages: event.messages }, applyResearchIdentity).messages.map((message: any) => {
			if (message.role !== "system" || !message.sections) return message;
			return { ...message, sections: Object.fromEntries(Object.entries(message.sections).map(([name, value]) =>
				[name, typeof value === "string" ? applyResearchIdentity(value) : value])) };
		}),
	}));
}
