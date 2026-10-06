import { join } from "node:path";
import { resolveResearchRuntime, registerSubagentRuntimeJob } from "../../.pi/lib/research-runtime.mjs";
import { registerSubagentRuntimeAdapter, getSubagentRuntimeAdapter } from "../../.pi/lib/research-runtime-adapters.mjs";
import { createSubagentActivityWriter } from "../../.pi/lib/subagent-activity.mjs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
export default function(pi: any, { rich = false } = {}) {
	const faux = fauxProvider({ provider: "web-demo", models: [{ id: "demo", name: "Offline test model", reasoning: true, input: ["text", "image"] }, ...Array.from({ length: 40 }, (_, i) => ({ id: `demo-${String(i).padStart(2, "0")}`, name: `Picker test ${i}`, contextWindow: 272000 }))], tokensPerSecond: 25 });
	const reply = "手机与电脑正在使用同一个 Research Pi 会话。\n\n这是一条 **离线测试回复**，没有调用模型服务。\n\n- 会话保持一致\n- 工具与权限保留在电脑\n- 关闭网页后 Pi 继续运行";
	faux.setResponses(Array.from({ length: 30 }, () => rich ? [fauxAssistantMessage(fauxToolCall("demo_subagent", { action: "resume", role: "advisor", task: "继续检查工具卡片、消息投递与运行状态；此为离线演示" }), { stopReason: "toolUse" }), fauxAssistantMessage(reply)] : [fauxAssistantMessage(reply)]).flat());
	pi.registerProvider(faux.provider);
	pi.on("session_start", async (_event: any, ctx: any) => {
		const runtime = await resolveResearchRuntime(ctx.cwd);
		const job: any = { id: "pi-web-demo", actorId: "pi:web-demo", backend: "pi", role: "general", model: "offline-demo", thinking: "low",
			mission: "离线消息回环测试", status: "input_required", cwd: ctx.cwd, workspaceKey: runtime.workspaceKey, turn: 1 };
		const writer = createSubagentActivityWriter(join(process.env.RESEARCH_PI_STATE_DIR!, "subagents", job.id, "events.jsonl"));
		writer.append(job, { type: "assistant", text: "这是离线 transport fixture。向我发送消息可验证 Runtime 投递与回执。" });
		await writer.flush();
		await registerSubagentRuntimeJob(runtime, job);
		const original = getSubagentRuntimeAdapter("pi");
		registerSubagentRuntimeAdapter("pi", { ...original, dispatch: async (input: any) => {
			if (input.actor.id !== job.actorId) return original?.dispatch(input);
			writer.append(job, { type: "assistant", text: "已通过 Runtime 收到：" + input.message.body });
			await writer.flush();
			return { status: "delivered", detail: "Offline transport fixture received the message" };
		} });
	});
	pi.registerCommand("web-test-dialog", { description: "Offline Web dialog test", handler: async (_args: string, ctx: any) => {
		const approved = await ctx.ui.confirm("测试：允许本次操作？", "这是离线 UI 测试，不会执行外部命令。");
		const scope = await ctx.ui.select("测试：授权范围", ["仅本次", "拒绝"]);
		const input = await ctx.ui.input("测试：输入回答", "手机或电脑均可回答");
		pi.sendMessage({ customType: "web-test", content: JSON.stringify({ approved, scope, input }), display: true }, { triggerTurn: false });
	} });
}
