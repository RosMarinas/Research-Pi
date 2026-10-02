import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
export async function inspectWebTailnet({ httpsPort = 8443, chooseAvailable = false, run = runFile } = {}) {
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
	const endpoints = [config, ...Object.values(config.Foreground ?? {})];
	const occupied = (port) => endpoints.some((entry) => entry.TCP?.[String(port)] || entry.Web?.[hostname + ":" + port] || entry.AllowFunnel?.[hostname + ":" + port]);
	if (chooseAvailable) while (httpsPort <= 65535 && occupied(httpsPort)) httpsPort++;
	if (httpsPort > 65535 || occupied(httpsPort)) {
		throw new Error("Tailscale port " + httpsPort + " already has a Serve/Funnel configuration. Choose --web-https-port; existing routes will not be changed.");
	}
	return { origin: "https://" + hostname + (httpsPort === 443 ? "" : ":" + httpsPort), login, httpsPort };
}

// Foreground Serve owns only this new endpoint and removes it on termination.
// Never run login/up, switch accounts, reset Serve, or enable Funnel.
export function startWebTailnet({ httpsPort, localPort, spawnProcess = spawn, onError = () => {} }) {
	const child = spawnProcess("tailscale", ["serve", "--https=" + httpsPort, "http://127.0.0.1:" + localPort], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	let readyResolve, readyReject;
	const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
	const timer = setTimeout(() => readyReject(new Error("Tailscale Serve did not become ready within 15 seconds")), 15_000);
	ready.finally(() => clearTimeout(timer)).catch(() => {});
	child.stdout.on("data", (data) => { output = (output + data).slice(-4000); });
	child.stderr.on("data", (data) => { output = (output + data).slice(-4000); });
	const inspectOutput = () => { if (/https:\/\/[^\s]+/.test(output) && /available|ctrl\+c/i.test(output)) readyResolve(); };
	child.stdout.on("data", inspectOutput); child.stderr.on("data", inspectOutput);
	child.on("error", (error) => { readyReject(error); onError(error); });
	child.on("exit", (code) => { const error = new Error("Tailscale Serve exited: " + output.trim()); readyReject(error); if (code) onError(error); });
	return { ready, async stop() {
		if (!child.pid || child.exitCode !== null || child.signalCode) return;
		await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
	} };
}
