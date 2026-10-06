#!/usr/bin/env node
// Review only: this private pointer is written by runtime-demo.mjs.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { RuntimeClient } from "../.pi/lib/runtime-client.mjs";
import { findRuntime } from "../.pi/lib/runtime-resident.mjs";
import { attachRuntimeTui } from "../.pi/lib/runtime-tui.mjs";
const access = JSON.parse(await readFile(new URL("../output/runtime-review/access.json", import.meta.url), "utf8"));
const action = process.argv[2] ?? "status";
if (action === "open") {
	const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", access.gateway.localUrl] : [access.gateway.localUrl];
	await new Promise((resolve, reject) => { const child = spawn(executable, args, { stdio: "ignore" }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Browser open failed"))); });
} else if (action === "tui") await attachRuntimeTui(access.record);
else if (action === "status" || action === "stop") {
	const client = await new RuntimeClient(access.record.socketPath).connect();
	try {
		if (action === "stop") { await client.call("runtime.stop"); for (const record of access.records ?? []) { if (record.pid === access.record.pid) continue; const current = await findRuntime(access.stateRoot, record.cwd); if (!current) continue; const other = await new RuntimeClient(current.socketPath).connect(); try { await other.call("runtime.stop"); } finally { other.close(); } } process.kill(access.gateway.pid, "SIGTERM"); console.log("Stopped the isolated review Host and Gateway."); }
		else console.log(JSON.stringify({ origin: new URL(access.gateway.localUrl).origin, workspace: access.workspace, hostPid: access.record.pid, gatewayPid: access.gateway.pid, ready: client.state.ready, idle: client.state.idle, sessionId: client.state.sessionId }, null, 2));
	} finally { client.close(); }
} else throw new Error("Usage: node scripts/runtime-review.mjs [open|tui|status|stop]");
