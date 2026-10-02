import { join } from "node:path";

// An explicit loadout: --no-extensions also disables Pi 1.0's built-ins.
export function researchPiExtensions(root, { search = false, anchor = false, trace = false, web = false } = {}) {
	const extensions = [
		"project-boundary", "tool-activity", "research-config", "research-mode",
		"record-experiment", "research-transition", "amend-project-state",
		"research-checkpoint", "research-memory", "research-compaction",
		"research-runtime", "research-side", "subagent-runners", "subagent-watch", "codex-delegate", "cache-audit",
	];
	if (search) extensions.push("deepseek-web-search");
	if (anchor) extensions.push("deepseek-v4-pro-anchor");
	return [
		...(web ? [join(root, ".pi", "extensions", "research-web.ts")] : []),
		"builtin:codemode", "builtin:tool-search",
		...extensions.map((name) => join(root, ".pi", "extensions", `${name}.ts`)),
		...(trace ? [join(root, ".pi", "vendor", "pi-trace-extension-0.1.14", "trace", "index.ts")] : []),
	];
}
