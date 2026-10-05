import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";

const runFile = promisify(execFile);

export async function residentControlDirectory(directory) {
	// macOS Unix socket paths have a short limit; state directories can be long.
	const root = join("/tmp", "rpi-web-" + (process.getuid?.() ?? "user"));
	const path = join(root, createHash("sha256").update(directory).digest("hex").slice(0, 24));
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700); await chmod(path, 0o700);
	return path;
}

export async function residentTmux({ directory, executable, args, cwd, env, cols, rows, hasSessionOptions = false }) {
	const socket = join(await residentControlDirectory(directory), "tmux.sock");
	const environment = { ...env }; delete environment.TMUX; delete environment.TMUX_PANE;
	const run = (args) => runFile("tmux", ["-S", socket, ...args], { env: environment, timeout: 5000 });
	try { await runFile("tmux", ["-V"], { env: environment, timeout: 5000 }); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
	const alive = async () => {
		try { await run(["has-session", "-t", "pi"]); return true; }
		catch (error) { if (error.code === 1) return false; throw error; }
	};
	const recovered = await alive();
	if (recovered && hasSessionOptions) throw new Error("The tmux Pi is still running. Attach without startup options; change its model or Session there.");
	if (!recovered) {
		await run(["-f", "/dev/null", "new-session", "-d", "-s", "pi", "-c", cwd, "-x", String(cols), "-y", String(rows), executable, ...args]);
		await run(["set-option", "-g", "status", "off"]);
		await run(["set-option", "-g", "prefix", "None"]);
		await run(["set-option", "-g", "history-limit", "10000"]);
	}
	return { socket, recovered, executable: "tmux", args: ["-S", socket, "attach-session", "-t", "pi"], env: environment,
		async stop() { if (await alive()) await run(["kill-session", "-t", "pi"]); } };
}
