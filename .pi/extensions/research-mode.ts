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
	pi.on("before_agent_start", (event) => {
		const systemPrompt = applyResearchIdentity(event.systemPrompt);
		if (systemPrompt === event.systemPrompt) return undefined;
		return { systemPrompt };
	});
	// Core clears the before_agent_start override when a run settles. A Runtime
	// custom-message wake bypasses that hook, and its tool continuation refreshes
	// from the native base prompt. Normalize the fixed identity at the wire edge
	// too; do not replay a saved whole prompt over new instructions or tools.
	pi.on("before_provider_request", (event) => mapProviderSystemPrompt(event.payload, applyResearchIdentity));
}
