import webDemo from "./web-demo.ts";
import { resolveResearchRuntime, registerSubagentRuntimeJob } from "../../.pi/lib/research-runtime.mjs";
export default function runtimeDemo(pi: any) {
	webDemo(pi, { rich: true });
	pi.registerTool({ name: "demo_subagent", label: "Offline subagent", description: "Offline tool rendering fixture", parameters: { type: "object", properties: { action: { type: "string" }, role: { type: "string" }, task: { type: "string" } } },
		async execute() { return { content: [{ type: "text", text: "已接入现有离线 Actor。这里展示原生 tool call/result 的结构化渲染，没有运行外部 Agent。" }], details: { id: "pi-web-demo", actorId: "pi:web-demo", backend: "pi", role: "advisor", mission: "UI / Runtime 一致性检查", model: "web-demo/demo", thinking: "high", status: "input_required", progress: "phase: 等待用户消息（离线演示）" } }; }
	});
	pi.on("session_start", async (_event: any, ctx: any) => {
		const runtime = await resolveResearchRuntime(ctx.cwd);
		for (let i = 0; i < 31; i++) await registerSubagentRuntimeJob(runtime, {
			id: `demo-history-${i}`, actorId: `pi:demo-history-${i}`, backend: "pi", role: "advisor", model: "web-demo/demo", thinking: "low",
			mission: `delta-conditional-value-posttraining / 手机与本机协同界面检查 ${i}`, status: i % 7 === 0 ? "cancelled" : "completed",
			cwd: ctx.cwd, workspaceKey: runtime.workspaceKey, turn: 1,
		});
	});
}
