// Isolated, credential-free review service. Host and Web Gateway are separate
// detached processes; closing this launcher or a screen does not stop either.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRuntime } from "../.pi/lib/runtime-resident.mjs";
import { findRuntimeGateway } from "../.pi/lib/runtime-launcher.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "rpi-runtime-review-"));
const workspace = join(temporary, "project"), stateRoot = join(temporary, "state"), configRoot = join(temporary, "config"); await mkdir(workspace);
await writeFile(join(workspace, "RESEARCH.md"), "# UI 与运行时分离\n\n验证同一个 Runtime 可以连接 TUI、手机和本机网页。此项目使用离线合成 provider，不调用模型服务。\n");
const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM"].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
Object.assign(env, { RESEARCH_PI_DEV_MODE: "0", RESEARCH_PI_CONFIG_DIR: configRoot, RESEARCH_PI_STATE_DIR: stateRoot });
const args = [join(root, "bin/pi.mjs"), "runtime", "start", "--workspace", workspace, "--provider", "web-demo", "--model", "demo", "--thinking", "low", "-e", join(root, "tests/fixtures/runtime-demo.ts")];
await new Promise((resolveRun, reject) => {
	const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
	child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; }); child.on("error", reject);
	child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(output.replace(/#token=[^\s]+/g, "#token=[redacted]"))));
});
const record = await findRuntime(stateRoot, workspace), gateway = await findRuntimeGateway(record);
const secondWorkspace = join(temporary, "second-project"); await mkdir(secondWorkspace);
await writeFile(join(secondWorkspace, "RESEARCH.md"), "# 第二个离线研究项目\n\n验证单入口、独立 Runtime 和会话路由。\n");
await new Promise((resolveRun, reject) => {
	const child = spawn(process.execPath, [join(root, "bin/pi.mjs"), "runtime", "start", "--no-web", "--workspace", secondWorkspace, "--provider", "web-demo", "--model", "demo", "-e", join(root, "tests/fixtures/runtime-demo.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
	child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(output.replace(/#token=[^\s]+/g, "#token=[redacted]"))));
});
const secondRecord = await findRuntime(stateRoot, secondWorkspace);
await mkdir(join(root, "output/runtime-review"), { recursive: true });
await writeFile(join(root, "output/runtime-review/access.json"), JSON.stringify({ temporary, workspace, stateRoot, configRoot, record, records: [record, secondRecord], gateway }), { mode: 0o600 });
console.log("Offline Runtime + desktop/mobile Web ready. Private access details: output/runtime-review/access.json");
console.log("Host PID: " + record.pid + "; Gateway PID: " + gateway.pid);
