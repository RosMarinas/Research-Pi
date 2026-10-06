import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { createResearchSessionRuntime } from "./runtime-factory.mjs";
import { createRuntimeHost } from "./runtime-host.mjs";
import { writeRuntimeRecord } from "./runtime-resident.mjs";

let host;
try {
	let input = ""; for await (const data of process.stdin) input += data;
	const options = JSON.parse(input);
	// Startup is serialized by the registry; stale sockets only belong to dead hosts.
	await unlink(options.socketPath).catch((e) => { if (e.code !== "ENOENT") throw e; });
	const runtime = await createResearchSessionRuntime(options);
	host = await createRuntimeHost({ ...options, runtime, onShutdown: async () => {
		await unlink(join(options.directory, "runtime.json")).catch((e) => { if (e.code !== "ENOENT") throw e; });
		setImmediate(() => process.exit(0));
	} });
	const stop = () => void host.close().then(() => process.exit(0));
	process.once("SIGTERM", stop); process.once("SIGINT", stop);
	await writeRuntimeRecord(options.directory, { pid: process.pid, socketPath: options.socketPath, cwd: options.cwd, hostEpoch: host.state().hostEpoch });
	if (runtime.startupInput.initialMessage || runtime.startupInput.initialImages?.length) await host.command({ method: "prompt", params: { message: runtime.startupInput.initialMessage, images: runtime.startupInput.initialImages }, sessionId: host.state().sessionId, sessionEpoch: host.state().sessionEpoch });
	for (const message of runtime.startupMessages ?? []) await host.command({ method: "prompt", params: { message }, sessionId: host.state().sessionId, sessionEpoch: host.state().sessionEpoch });

} catch (e) { console.error("Runtime startup: " + e.message); await host?.close(); process.exitCode = 1; }
