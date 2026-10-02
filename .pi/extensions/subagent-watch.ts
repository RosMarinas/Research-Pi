import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openSubagentWatch } from "../lib/subagent-watch-ui.mjs";

export default function subagentWatchExtension(pi: ExtensionAPI) {
	pi.registerCommand("watch", {
		description: "Open a subagent conversation in this terminal or a new terminal; message it directly",
		handler: async (args, ctx) => await openSubagentWatch(ctx, args.trim()),
	});
}
