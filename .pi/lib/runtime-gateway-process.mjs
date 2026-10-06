import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimeGateway } from "./runtime-gateway.mjs";
import { inspectWebTailnet, startWebTailnet } from "./web-tailscale.mjs";

let gateway, serving;
try {
	let input = ""; for await (const data of process.stdin) input += data;
	const options = JSON.parse(input);
	const tailnet = options.web.tailscale ? await inspectWebTailnet({ httpsPort: options.web.httpsPort, chooseAvailable: options.web.autoHttpsPort }) : null;
	gateway = await createRuntimeGateway({ ...options, port: options.web.port, publicOrigin: tailnet?.origin, tailscaleLogin: tailnet?.login });
	if (tailnet) { serving = startWebTailnet({ httpsPort: tailnet.httpsPort, localPort: gateway.port }); await serving.ready; }
	const path = join(options.record.directory, "gateway.json");
	await writeFile(path, JSON.stringify({ pid: process.pid, url: gateway.accessUrl, localUrl: gateway.localAccessUrl, port: gateway.port }), { mode: 0o600 });
	let closing = false;
	const stop = async () => { if (closing) return; closing = true; await serving?.stop(); await gateway.close(); await unlink(path); process.exit(0); };
	process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
} catch (e) { console.error("Runtime Web: " + e.message); await serving?.stop(); await gateway?.close(); process.exitCode = 1; }
