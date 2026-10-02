// An isolated real Pi TUI with a synthetic provider. No credentials or running
// project state are loaded; useful for mobile browser acceptance checks.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "research-pi-web-demo-"));
const workspace = join(temporary, "project");
await mkdir(workspace);
await writeFile(join(workspace, "RESEARCH.md"), "# Mobile Research\n\nQuestion: Can phone and desktop share one agent without changing research state?\n");
const cleanEnv = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const env = { ...cleanEnv, RESEARCH_PI_DEV_MODE: "0", RESEARCH_PI_CONFIG_DIR: join(temporary, "config"),
	RESEARCH_PI_STATE_DIR: join(temporary, "state") };
delete env.RESEARCH_PI_CONFIG_FILE;
delete env.PI_CODING_AGENT_DIR;
const child = spawn(process.execPath, [join(root, "bin/pi.mjs"), "--workspace", workspace, process.argv.includes("--tailscale") ? "--web-tailscale" : "--web", "--web-foreground", "--web-port", process.env.WEB_DEMO_PORT ?? "8791",
	"--provider", "web-demo", "--model", "demo", "--thinking", "low",
	"-e", join(root, "tests/fixtures/web-demo.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", () => {});
child.stderr.on("data", async (data) => {
	output += data.toString();
	const match = output.match(/Access details: ([^\r\n]+)/);
	if (match && !process.env.WEB_DEMO_REPORTED) {
		process.env.WEB_DEMO_REPORTED = "1";
		await mkdir(join(root, "output/playwright"), { recursive: true });
		await writeFile(join(root, "output/playwright/demo.json"), JSON.stringify({ accessFile: match[1], workspace, pid: child.pid, temporary }), { mode: 0o600 });
		console.log("Offline Pi browser fixture ready on port " + (process.env.WEB_DEMO_PORT ?? "8791") + ". Access-file pointer: output/playwright/demo.json");
	}
});
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop); process.on("SIGTERM", stop);
child.on("exit", async (code) => {
	process.off("SIGINT", stop); process.off("SIGTERM", stop);
	if (code) console.error(output.replace(/#token=[^\s]+/g, "#token=[redacted]"));
	await rm(temporary, { recursive: true, force: true });
	process.exitCode = code ?? 0;
});
