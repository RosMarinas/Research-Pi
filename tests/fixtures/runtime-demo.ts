import webDemo from "./web-demo.ts";
import { resolveResearchRuntime, registerSubagentRuntimeJob } from "../../.pi/lib/research-runtime.mjs";
export default function runtimeDemo(pi: any) {
	webDemo(pi);
	pi.on("session_start", async (_event: any, ctx: any) => {
		const runtime = await resolveResearchRuntime(ctx.cwd);
		for (let i = 0; i < 31; i++) await registerSubagentRuntimeJob(runtime, {
			id: `demo-history-${i}`, actorId: `pi:demo-history-${i}`, backend: "pi", role: "advisor", model: "web-demo/demo", thinking: "low",
			mission: `delta-conditional-value-posttraining / 手机与本机协同界面检查 ${i}`, status: i % 7 === 0 ? "cancelled" : "completed",
			cwd: ctx.cwd, workspaceKey: runtime.workspaceKey, turn: 1,
		});
	});
}
