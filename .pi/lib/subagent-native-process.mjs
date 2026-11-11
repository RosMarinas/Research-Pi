// One actual AgentSessionRuntime and the same InteractiveMode used by the Leader.
// stdin/stdout carry only the owner's small control/event protocol; terminal I/O
// travels over a private socket. Attaching never creates or replays a model run.
import { runtimePerformance } from "./runtime-performance.mjs";
import { createOwnerEventWriter } from "./subagent-owner-events.mjs";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { createResearchSessionRuntime } from "./native-runtime-factory.mjs";
import { createNativeRuntimeHost } from "./native-runtime-host.mjs";
import { subagentConversationExtension } from "./subagent-conversation-extension.mjs";
import { registerHostCapabilityRequestAdapter } from "./research-runtime-adapters.mjs";
import { SYSTEM_TMPDIR } from "./project-boundary.mjs";

process.umask(0o077);
const options = JSON.parse(process.env.RESEARCH_PI_SUBAGENT);
const output = event => {
 const line = JSON.stringify(event) + "\n";
 runtimePerformance.count("ownerEvents");
 if (runtimePerformance.enabled) runtimePerformance.count("ownerBytes", Buffer.byteLength(line));
 process.stdout.write(line);
};
const ownerEvents = createOwnerEventWriter(output);
const approvals = new Map();
registerHostCapabilityRequestAdapter({ request: (pendingRequest, { signal } = {}) => {
 signal?.throwIfAborted();
 return new Promise((resolve, reject) => {
  const id = randomUUID();
  const finish = (decision, error) => {
   approvals.delete(id); signal?.removeEventListener("abort", abort);
   error ? reject(error) : resolve(decision);
  };
  const abort = () => { output({ type: "extension_ui_cancel", id }); finish(undefined, new Error("Capability request cancelled")); };
  approvals.set(id, { finish, abort });
  signal?.addEventListener("abort", abort, { once: true });
  output({ type: "extension_ui_request", id, method: "host_capability", pendingRequest: { ...pendingRequest, id } });
 });
} });
let host, runtime, directory, unsubscribe, closing = false, turnSource = null, preparedSleep;
const controls = createInterface({ input: process.stdin });
const queued = [];
controls.on("line", line => { if (runtime && host) void dispatch(line); else queued.push(line); });
controls.on("close", () => void close());
async function close() {
 if (closing) return; closing = true;
 for (const request of approvals.values()) request.finish(undefined, new Error("Owning Leader disconnected"));
 unsubscribe?.(); ownerEvents.flush(); await host?.close();
 if (directory) await rm(directory, { recursive: true, force: true });
 await new Promise(resolve => process.stdout.write("", () => resolve()));
 process.exit(0);
}
async function dispatch(line) {
 let command;
 try {
  command = JSON.parse(line);
  const session = runtime.session;
  let data;
  switch (command.type) {
   case "extension_ui_response": approvals.get(command.id)?.finish(command.decision, command.error ? new Error(command.error) : undefined); return;
   case "performance": runtimePerformance.setEnabled(command.enabled); output({ type: "performance_sample", sample: runtimePerformance.snapshot() }); return;
   case "prompt": preparedSleep = null; turnSource = command.source ?? "research-leader"; await session.prompt(command.message, { source: "rpc" }); break;
   case "steer": preparedSleep = null; if (command.source && command.source !== "user") turnSource = command.source; await session.steer(command.message, undefined, { source: "rpc" }); break;
   case "follow_up": await session.followUp(command.message, undefined, { source: "rpc" }); break;
   case "abort": for (const request of approvals.values()) request.abort(); await session.abort(); break;
   case "get_state": data = { model: session.model, thinkingLevel: session.thinkingLevel }; break;
   case "hibernate": {
    const accepted = host.canHibernate() && approvals.size === 0 && command.sessionId === session.sessionId && Boolean(session.sessionFile);
    preparedSleep = accepted ? command.id : null;
    output({ type: "hibernate_response", id: command.id, accepted, sessionFile: accepted ? session.sessionFile : null });
    return;
   }
   case "hibernate_commit": {
    const accepted = preparedSleep === command.id && host.canHibernate() && approvals.size === 0 && command.sessionId === session.sessionId;
    preparedSleep = null;
    output({ type: "hibernate_committed", id: command.id, accepted });
    if (accepted) await close();
    return;
   }
   case "set_model": {
    const model = session.modelRuntime.getAvailableSnapshot().find(m => m.provider === command.provider && m.id === command.modelId);
    if (!model) throw new Error("Model not found");
    await session.setModel(model); data = model; break;
   }
   case "set_thinking_level": session.setThinkingLevel(command.level); break;
   default: throw new Error(`Unsupported owner command: ${command.type}`);
  }
  output({ type: "response", command: command.type, id: command.id, success: true, data });
 } catch (error) { output({ type: "response", command: command?.type, id: command?.id, success: false, error: error.message }); }
}
try {
 directory = await mkdtemp(join(SYSTEM_TMPDIR, "pi-agent-"));
 const terminalSocket = join(directory, "terminal.sock"), instance = randomUUID();
 let navigate;
 runtime = await createResearchSessionRuntime({ args: process.argv.slice(2), cwd: process.cwd(), agentDir: getAgentDir(),
  extensionFactories: [pi => subagentConversationExtension(pi, { ...options, navigate: target => navigate?.(target), output, isObserved: () => host?.observed === true, isUserDiscussion: () => !turnSource || turnSource === "user" })] });
 host = await createNativeRuntimeHost({ runtime, terminalSocket, instance, tuiMode: "fullscreen", suspendUnobserved: true,
  configureMode({ mode, terminal, navigate: route }) {
   const reportStatus = terminal.setProgramStatus.bind(terminal);
   terminal.setProgramStatus = status => { reportStatus(status); output({ type: "native_status", ...status }); };
   navigate = route;
   const subscribe = mode.subscribeToAgent.bind(mode);
   mode.subscribeToAgent = () => { subscribe(); unsubscribe?.(); unsubscribe = runtime.session.subscribe(event => {
    ownerEvents.append(event);
    if (event.type === "agent_settled") turnSource = null;
    if (["agent_start", "agent_settled"].includes(event.type)) output({ type: "response", command: "get_state", success: true, data: { model: runtime.session.model, thinkingLevel: runtime.session.thinkingLevel } });
   }); };
  }, onShutdown: async () => { if (!closing) await close(); } });
 output({ type: "subagent_ready", nativeTerminal: { terminalSocket, instance } });
 for (const line of queued.splice(0)) void dispatch(line);
 process.once("SIGTERM", () => void close()); process.once("SIGINT", () => void close());
} catch (error) { console.error(error.stack); await host?.close(); if (directory) await rm(directory, { recursive: true, force: true }); process.exit(1); }
