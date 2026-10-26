import performanceExtension from "../extensions/runtime-performance.ts";
import { createSubagentWatchClient } from "./subagent-watch.mjs";
import { Type } from "typebox";
import { join } from "node:path";
import { resolveResearchRuntime, createRuntimeMessage, RESEARCH_LEADER_ACTOR_ID, USER_ACTOR_ID } from "./research-runtime.mjs";

export function subagentConversationExtension(pi, options) {
 performanceExtension(pi);
 let runtime, client, timer, lastStatus;
 const seen = new Map();
 const identity = `Subagent · ${options.mission ?? options.role} · User → this agent`;
 const send = async (body, from, type = "ask") => createRuntimeMessage(runtime, {
  from, to: RESEARCH_LEADER_ACTOR_ID, type, body,
  metadata: { workspaceKey: runtime.workspaceKey, sourceActorId: options.actorId },
 });
 pi.registerCommand("leader", { description: "Return to Leader, or /leader <message> to ask it", handler: async (body, ctx) => {
  if (!body.trim()) return options.navigate("leader");
  const receipt = await send(body, USER_ACTOR_ID);
  ctx.ui.notify(`User → Leader queued (${receipt.id})`, "info");
 }});
 pi.registerCommand("agents", { description: "Search and switch conversations", handler: async () => options.navigate("agents") });
 pi.registerTool({ name: "message_leader", label: "Message Leader", description: "Ask the Leader a question or report progress without ending your work. A reply arrives as a subsequent directed message.",
  parameters: Type.Object({ message: Type.String(), type: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("notify")])) }),
  async execute(_id, args) { const receipt = await send(args.message, options.actorId, args.type ?? "ask"); return { content: [{ type: "text", text: `Queued to Leader: ${receipt.id}` }], details: { messageId: receipt.id } }; }
 });
 pi.on("session_start", async (_event, ctx) => {
  runtime = await resolveResearchRuntime(ctx.cwd, { runtimeRoot: join(options.stateRoot, "runtime", "projects") });
  client = await createSubagentWatchClient({ cwd: ctx.cwd, stateRoot: options.stateRoot });
  ctx.ui.setStatus("conversation", `${identity} · /leader · /agents · Ctrl+] back`);
  let busy = false;
  const refresh = async () => {
   if (busy || (options.isObserved && !options.isObserved())) return; busy = true;
   try {
    const latest = new Map(); for (const actor of await client.list()) if (actor.action) latest.set(actor.id, actor.action);
    const others = [...latest.values()].filter(a => a.actorId !== options.actorId && ["input_required", "failed", "completed"].includes(a.status));
    const changed = others.filter(a => seen.has(a.actorId) && seen.get(a.actorId) !== `${a.id}:${a.status}`);
    for (const a of latest.values()) seen.set(a.actorId, `${a.id}:${a.status}`);
    if (changed.length) ctx.ui.notify(changed.map(a => `${a.label ?? a.actorId}: ${a.status}`).join("\n"), "info");
    const status = others.length ? `${others.length} other agents finished / need attention · /agents` : undefined;
    if (status !== lastStatus) { lastStatus = status; ctx.ui.setStatus("other-agents", status); }
   } catch { ctx.ui.setStatus("other-agents", "Other agents: unknown"); } finally { busy = false; }
  };
  clearInterval(timer); timer = setInterval(() => void refresh(), 2000); timer.unref(); void refresh();
 });
 pi.on("model_select", async (_event, ctx) => {
  options.output({ type: "response", command: "get_state", success: true, data: { model: ctx.model, thinkingLevel: pi.getThinkingLevel() } });
  ctx.ui.notify("Model changed for subsequent calls; an in-flight call keeps its original model.", "info");
 });
 pi.on("session_shutdown", async () => clearInterval(timer));
}
