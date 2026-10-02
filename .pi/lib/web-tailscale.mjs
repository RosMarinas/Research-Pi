import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
export async function inspectWebTailnet({ httpsPort = 8443, run = runFile } = {}) {
	const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
	const state = JSON.parse(stdout);
	if (state.BackendState !== "Running") throw new Error("Tailscale is not connected. Connect the existing account in the Tailscale app first.");
	const hostname = String(state.Self?.DNSName ?? "").replace(/\.$/, "");
	if (!/^[a-zA-Z0-9.-]+\.ts\.net$/.test(hostname)) throw new Error("The current Tailscale device has no usable HTTPS hostname");
	const login = state.User?.[state.Self?.UserID]?.LoginName;
	if (!login) throw new Error("The current Tailscale user identity could not be resolved");
	if (!state.CertDomains?.includes(hostname)) throw new Error("HTTPS is not enabled for this device. Enable it in the existing tailnet before using --web-tailscale.");
	const { stdout: serveOutput } = await run("tailscale", ["serve", "status", "--json"], { timeout: 10_000 });
	const config = JSON.parse(serveOutput);
	const endpoint = hostname + ":" + httpsPort;
	const endpoints = [config, ...Object.values(config.Foreground ?? {})];
	if (endpoints.some((entry) => entry.TCP?.[String(httpsPort)] || entry.Web?.[endpoint] || entry.AllowFunnel?.[endpoint])) {
		throw new Error("Tailscale port " + httpsPort + " already has a Serve/Funnel configuration. Choose --web-https-port; existing routes will not be changed.");
	}
	return { origin: "https://" + hostname + (httpsPort === 443 ? "" : ":" + httpsPort), login, httpsPort };
}

// Foreground Serve owns only this new endpoint and removes it on termination.
// Never run login/up, switch accounts, reset Serve, or enable Funnel.
export function startWebTailnet({ httpsPort, localPort, spawnProcess = spawn, onError = () => {} }) {
	const child = spawnProcess("tailscale", ["serve", "--https=" + httpsPort, "http://127.0.0.1:" + localPort], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (data) => { output = (output + data).slice(-4000); });
	child.stderr.on("data", (data) => { output = (output + data).slice(-4000); });
	child.on("error", onError);
	child.on("exit", (code) => { if (code) onError(new Error("Tailscale Serve exited: " + output.trim())); });
	return { async stop() {
		if (!child.pid || child.exitCode !== null || child.signalCode) return;
		await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
	} };
}
