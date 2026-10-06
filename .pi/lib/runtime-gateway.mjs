import { createWebGateway } from "./web-server.mjs";
import { RuntimeClient } from "./runtime-client.mjs";
import { persistentWebToken } from "./web-token.mjs";

export async function createRuntimeGateway({ record, stateRoot, assetsRoot, port = 0, publicOrigin, tailscaleLogin }) {
	const client = await new RuntimeClient(record.socketPath, { forwardAllViews: true }).connect();
	let gateway, retryTimer, closing = false, reconnectDelay = 300;
	const reconnect = async () => {
		if (closing) return;
		try { await client.connect(); reconnectDelay = 300; gateway.broadcast({ type: "state", state: client.state }); }
		catch { if (!closing) { clearTimeout(retryTimer); reconnectDelay = Math.min(3000, reconnectDelay * 2); retryTimer = setTimeout(reconnect, reconnectDelay); retryTimer.unref(); } }
	};
	try { gateway = await createWebGateway({ port, publicOrigin, tailscaleLogin, assetsRoot,
		token: await persistentWebToken(stateRoot),
		command: (input) => client.call(input.method, input.params, { id: input.id, sessionId: input.sessionId, sessionEpoch: input.sessionEpoch, uiClientId: input.uiClientId }),
	}); } catch (e) { client.close(); throw e; }
	client.on("event", (event) => gateway.broadcast(event));
	client.on("disconnect", () => {
		if (closing) return;
		gateway.broadcast({ type: "state", state: { ...client.state, ready: false, idle: false, executionUnknown: true } });
		gateway.broadcast({ type: "notice", message: "Runtime disconnected; execution status is unknown. Waiting for the Runtime to reconnect.", kind: "error" });
		clearTimeout(retryTimer); retryTimer = setTimeout(reconnect, reconnectDelay); retryTimer.unref();
	});
	return { ...gateway, async close() { closing = true; clearTimeout(retryTimer); client.close(); await gateway.close(); } };
}
