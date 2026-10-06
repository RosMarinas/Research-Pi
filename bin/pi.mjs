#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBoundaryDoctor, runBoundaryDoctor } from "../.pi/lib/boundary-doctor.mjs";
import {
	ensureResearchPiConfig,
	researchPiCredentialEnvironmentNames,
	researchPiConfigSummary,
	researchPiDeepSeekSearchEnabled,
	researchPiEnvironment,
	RESEARCH_PI_THEME_CHOICES,
	writeResearchPiAgentConfig,
	writeResearchPiConfig,
} from "../.pi/lib/research-config.mjs";
import {
	CODEX_ANALYSIS_HANDOFF_MAX_CHARS,
	queueCodexAnalysisHandoff,
	readCodexAnalysisContext,
} from "../.pi/lib/research-analysis-bridge.mjs";
import { resolveResearchPiPaths } from "../.pi/lib/runtime-paths.mjs";
import { parseWebOptions } from "../.pi/lib/web-launcher.mjs";
import { researchPiExtensions } from "../.pi/lib/research-extensions.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveResearchPiPaths({ harnessRoot: packageRoot });
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const coreVersion = String(packageJson.dependencies?.["@earendil-works/pi-coding-agent"] ?? "").replace(/^[^0-9]*/, "");

// Conversations, traces, memory indexes, and capability receipts are private
// even in development mode. The child Pi process inherits this umask.
process.umask(0o077);

function parseCredentialFile(path) {
	if (!existsSync(path)) return {};
	const result = {};
	for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		result[match[1]] = value;
	}
	return result;
}

function ensureRuntimeLayout(config) {
	for (const path of [
		...(paths.development ? [] : [paths.configRoot]),
		paths.stateRoot,
		paths.agentDir,
		paths.sessionDir,
		paths.memoryDir,
		paths.runtimeDir,
		paths.codexDir,
		paths.capabilityDir,
		paths.traceDir,
	]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, 0o700);
	}
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion });
}

function prepareConfig() {
	const config = ensureResearchPiConfig(paths.configPath);
	ensureRuntimeLayout(config);
	return config;
}

function setup() {
	const config = prepareConfig();
	const credentialNames = researchPiCredentialEnvironmentNames(config);
	if (!existsSync(paths.credentialsPath)) {
		mkdirSync(dirname(paths.credentialsPath), { recursive: true, mode: 0o700 });
		writeFileSync(paths.credentialsPath, `# Research Pi credentials; never commit this file.\n${credentialNames.map((name) => `${name}=`).join("\n")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		process.stdout.write(`Created ${paths.credentialsPath}\n`);
	} else {
		const current = readFileSync(paths.credentialsPath, "utf8");
		const missing = credentialNames.filter((name) => !new RegExp(`^(?:export\\s+)?${name}=`, "m").test(current));
		if (missing.length) {
			const prefix = current && !current.endsWith("\n") ? "\n" : "";
			writeFileSync(paths.credentialsPath, `${current}${prefix}${missing.map((name) => `${name}=`).join("\n")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			process.stdout.write(`Added credential placeholders: ${missing.join(", ")}\n`);
		} else {
			process.stdout.write(`Credentials file already contains all provider entries: ${paths.credentialsPath}\n`);
		}
	}
	process.stdout.write(`State directory: ${paths.stateRoot}\n`);
	process.stdout.write(`Config file: ${paths.configPath}\n`);
	process.stdout.write("GPT subscription: start pi, then /login openai (Sign in with ChatGPT), or /login openai-codex for the existing Codex provider; select the model with /model.\n");
	process.stdout.write("Codex subagents use the Codex CLI's separate login: codex login. No provider API key is required for either subscription path.\n");
	process.stdout.write("Antigravity subagents use the local agy session; launch agy interactively once for first-time sign-in. Pi subagents reuse Pi's native provider authentication.\n");
}

function loadConfigurationEnvironment() {
	const credentials = parseCredentialFile(paths.credentialsPath);
	for (const [name, value] of Object.entries(credentials)) {
		if (process.env[name] === undefined) process.env[name] = value;
	}
}

function takeResearchOptions(argv, config) {
	const args = [...argv];
	let sessionMode;
	let fullAccess = process.env.RESEARCH_PI_FULL_ACCESS === "1";
	const fullAccessIndex = args.indexOf("--full-access");
	if (fullAccessIndex >= 0) {
		fullAccess = true;
		args.splice(fullAccessIndex, 1);
	}
	const analysisIndex = args.indexOf("--analysis");
	if (analysisIndex >= 0) {
		sessionMode = "analysis";
		args.splice(analysisIndex, 1);
	}
	let workspace = process.env.PI_RESEARCH_WORKSPACE ?? process.cwd();
	const index = args.indexOf("--workspace");
	if (index >= 0) {
		if (!args[index + 1]) throw new Error("Usage: pi --workspace <project-directory> [pi options...]");
		workspace = args[index + 1];
		args.splice(index, 2);
	}
	return { workspace: resolve(workspace), args, config, sessionMode, fullAccess };
}

function applyConfigurationEnvironment(config) {
	for (const [name, value] of Object.entries(researchPiEnvironment(config))) {
		if (process.env[name] === undefined) process.env[name] = value;
	}
	process.env.RESEARCH_PI_CONFIG_FILE = paths.configPath;
}

function expandUserPath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(path);
}

async function configCommand(argv) {
	const config = prepareConfig();
	loadConfigurationEnvironment();
	const action = argv[0] ?? "show";
	if (action === "path") {
		process.stdout.write(`${paths.configPath}\n`);
		return;
	}
	if (action === "show") {
		process.stdout.write(`${researchPiConfigSummary(config, paths.configPath)}\n\n${JSON.stringify(config, null, 2)}\n`);
		return;
	}
	if (action === "themes") {
		const active = config.pi.settings.theme;
		for (const theme of RESEARCH_PI_THEME_CHOICES) {
			process.stdout.write(`${theme.name === active ? "*" : " "} ${theme.name}\t${theme.label}\t${theme.description}\n`);
		}
		return;
	}
	if (action === "web") {
		const mode = argv[1];
		if (mode === undefined) { process.stdout.write(JSON.stringify(config.ui.web, null, 2) + "\n"); return; }
		if (!["off", "local", "tailscale"].includes(mode)) throw new Error("Usage: pi config web [off|local|tailscale]");
		writeResearchPiConfig(paths.configPath, { ...config, ui: { ...config.ui, web: { ...config.ui.web, mode } } });
		process.stdout.write("Web default: " + mode + ". Applies when starting pi; --no-web disables it for one launch.\n");
		return;
	}
	if (action === "context") {
		const [id, value] = argv.slice(1);
		const split = id?.indexOf("/") ?? -1;
		if (split < 1 || split === id.length - 1 || value === undefined || argv.length !== 3) throw new Error("Usage: pi config context <provider/model> <tokens|872k|1m|inherit>");
		const { parseContextWindow, setModelContextWindow } = await import("../.pi/lib/model-context.mjs");
		const tokens = parseContextWindow(value);
		await setModelContextWindow(paths.agentDir, id.slice(0, split), id.slice(split + 1), tokens);
		process.stdout.write(`${id}: context ${tokens ?? "catalog default"}. Saved in native models.json; refresh /model or start a new Pi to apply.\n`);
		return;
	}
	if (action === "theme") {
		const name = argv[1];
		if (!name || !RESEARCH_PI_THEME_CHOICES.some((theme) => theme.name === name)) {
			throw new Error(`Usage: pi config theme <${RESEARCH_PI_THEME_CHOICES.map((theme) => theme.name).join("|")}>`);
		}
		const next = writeResearchPiConfig(paths.configPath, {
			...config,
			pi: { ...config.pi, settings: { ...config.pi.settings, theme: name } },
		});
		writeResearchPiAgentConfig(paths.agentDir, next, { coreVersion, environment: process.env });
		process.stdout.write(`${researchPiConfigSummary(next, paths.configPath)}\n`);
		return;
	}
	throw new Error("Usage: pi config [show|path|themes|theme <name>|web [off|local|tailscale]|context <provider/model> <tokens|inherit>]");
}

async function readStandardInput() {
	let text = "";
	for await (const chunk of process.stdin) text += chunk.toString();
	return text;
}

async function analysisCommand(argv) {
	const action = argv[0] ?? "context";
	const workspace = resolve(process.env.PI_RESEARCH_WORKSPACE ?? process.cwd());
	if (action === "context" || action === "view") {
		process.stdout.write(`${await readCodexAnalysisContext(workspace)}\n`);
		return;
	}
	if (action === "send") {
		const inline = argv.slice(1).join(" ").trim();
		const input = inline || (process.stdin.isTTY ? "" : await readStandardInput());
		if (!input) {
			throw new Error(`Usage: pi analysis send <message>, or pipe a handoff of at most ${CODEX_ANALYSIS_HANDOFF_MAX_CHARS} characters to pi analysis send`);
		}
		const message = await queueCodexAnalysisHandoff(workspace, input);
		process.stdout.write(`${message.id} queued for the Research Pi Leader; no transcript or Project State was written.\n`);
		return;
	}
	throw new Error("Usage: pi analysis [context|send <message>]");
}

async function spawnCore(argv, { background = false } = {}) {
	const legacyUi = argv.includes("--legacy-ui");
	argv = argv.filter((arg) => arg !== "--legacy-ui" && arg !== "--runtime");
	const baseConfig = prepareConfig();
	if (background && baseConfig.ui.web.mode === "off" && !argv.includes("--no-web") && !argv.includes("--web-tailscale") && !argv.includes("--web")) argv = [...argv, "--web"];
	const web = parseWebOptions(argv, baseConfig.ui.web, { interactive: background || Boolean(process.stdin.isTTY && process.stdout.isTTY) });
	const { workspace, args: userArgs, config, sessionMode, fullAccess } = takeResearchOptions(web.args, baseConfig);
	if (web.enabled && userArgs.some((arg) => ["--mode", "--print", "-p"].includes(arg) || arg.startsWith("--mode="))) throw new Error("--web requires interactive TUI mode");
	if (legacyUi && background && !web.enabled) throw new Error("pi web start requires Web mode");
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion });
	if (!existsSync(workspace)) throw new Error(`Research workspace does not exist: ${workspace}`);
	loadConfigurationEnvironment();
	applyConfigurationEnvironment(config);
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion, environment: process.env });
	const informational = userArgs.some((arg) => ["--version", "--help", "-h", "--list-models"].includes(arg));
	const deepSeekSearchEnabled = informational ? false : researchPiDeepSeekSearchEnabled(config, process.env);
	const coreCli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(coreCli)) throw new Error(`Pinned Pi core is missing: ${coreCli}`);

	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	process.env.RESEARCH_PI_CONFIG_DIR = paths.configRoot;
	process.env.RESEARCH_PI_STATE_DIR = paths.stateRoot;
	process.env.RESEARCH_PI_SESSION_DIR = paths.sessionDir;
	process.env.RESEARCH_PI_HARNESS_ROOT = packageRoot;
	process.env.RESEARCH_PI_CORE_CLI = coreCli;
	if (sessionMode === "analysis") process.env.RESEARCH_PI_INITIAL_SESSION_MODE = "analysis";
	if (fullAccess) process.env.RESEARCH_PI_FULL_ACCESS = "1";
	if (process.env.RESEARCH_PI_TRACE === "1") process.env.PI_TRACE_DIR = paths.traceDir;

	const args = ["--no-skills", "--no-extensions", "--no-themes"];
	// A shared, resizable terminal needs an application-owned scroll viewport.
	if (web.enabled && !userArgs.includes("--tui-mode")) args.push("--tui-mode", "fullscreen");
	const skillPaths = [
		join(packageRoot, ".pi", "skills", "research-briefing"),
		...config.resources.skills.map((configuredPath) => expandUserPath(configuredPath)),
	];
	for (const skill of new Set(skillPaths)) {
		if (existsSync(join(skill, "SKILL.md"))) args.push("--skill", skill);
	}
	args.push(
		"--theme", join(packageRoot, ".pi", "themes"),
		"--session-dir", paths.sessionDir,
		"--append-system-prompt", join(packageRoot, ".pi", "APPEND_SYSTEM.md"),
	);
	for (const extension of researchPiExtensions(packageRoot, {
		web: web.enabled,
		search: deepSeekSearchEnabled,
		anchor: process.env.RESEARCH_PI_DEEPSEEK_ANCHOR === "1" || userArgs.some((arg) => arg === "--v4-pro-anchor" || arg.startsWith("--v4-pro-anchor=")),
		trace: process.env.RESEARCH_PI_TRACE === "1",
	})) args.push("--extension", extension);
	args.push(...userArgs);
	const headless = userArgs.some((arg) => ["--mode", "--print", "-p", "--export"].includes(arg) || arg.startsWith("--mode="));
	if (!legacyUi && !informational && !headless && (background || process.stdin.isTTY && process.stdout.isTTY)) {
		const { launchRuntime } = await import("../.pi/lib/runtime-launcher.mjs");
		const runtimeArgs = args.filter((arg, index) => arg !== "--tui-mode" && args[index - 1] !== "--tui-mode");
		// Web interaction is now owned by the Host, not injected into a TUI process.
		const webExtension = join(packageRoot, ".pi/extensions/research-web.ts");
		const index = runtimeArgs.indexOf(webExtension); if (index >= 0) runtimeArgs.splice(index - 1, 2);
		await launchRuntime({ stateRoot: paths.stateRoot, cwd: workspace, env: process.env, packageRoot, args: runtimeArgs,
			agentDir: paths.agentDir, sessionDir: paths.sessionDir, background, analysis: sessionMode === "analysis",
			hasSessionOptions: userArgs.length > 0 || argv.includes("--full-access"),
			web: { ...web, enabled: web.enabled, port: argv.includes("--web-port") ? web.port : 0 } });
		return;
	}

	if (web.enabled && !informational) {
		if (web.persistent || background) {
			if (!background && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Use pi web start to launch a resident Pi without an interactive terminal");
			const { ensureResidentWeb } = await import("../.pi/lib/web-resident.mjs");
			const record = await ensureResidentWeb({ stateRoot: paths.stateRoot, cwd: workspace, env: process.env, packageRoot,
				executable: process.execPath, args: [coreCli, ...args], options: web,
				hasSessionOptions: userArgs.length > 0 || argv.includes("--analysis") || argv.includes("--full-access") });
			printWebRecord(record);
			if (!background) {
				process.stderr.write("Ctrl+] detaches this terminal; Pi and Web stay running. Use pi web stop to stop the service.\n");
				const { attachResidentTerminal } = await import("../.pi/lib/web-terminal.mjs");
				await attachResidentTerminal(record);
			}
			return;
		}
		const { launchResearchWeb } = await import("../.pi/lib/web-launcher.mjs");
		process.exitCode = await launchResearchWeb({ executable: process.execPath, args: [coreCli, ...args], cwd: workspace, env: process.env, packageRoot, options: web });
		return;
	}

	await new Promise((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, [coreCli, ...args], {
			cwd: workspace,
			env: process.env,
			stdio: "inherit",
		});
		child.on("error", rejectRun);
		child.on("exit", (code, signal) => {
			if (signal) return rejectRun(new Error(`Pi terminated by ${signal}`));
			process.exitCode = code ?? 1;
			resolveRun();
		});
	});
}

function printWebRecord(record) {
	process.stdout.write(`Research Pi Web: ${record.url}\nWorkspace: ${record.state?.cwd ?? record.cwd}\nProcess: ${record.pid}\nState: ${record.state?.ready ? record.state.idle ? "idle" : "running" : "starting"}\n`);
}

async function webCommand(argv) {
	const action = argv[0] ?? "status";
	if (action === "start") return await spawnCore(argv.slice(1), { background: true });
	if (!["status", "stop"].includes(action)) throw new Error("Usage: pi web [start|status|stop] [--workspace <path>]");
	const { workspace, args, sessionMode } = takeResearchOptions(argv.slice(1), {});
	if (args.some((arg) => arg !== "--json")) throw new Error("Usage: pi web [status|stop] [--workspace <path>] [--json]");
	const { findRuntime } = await import("../.pi/lib/runtime-resident.mjs");
	const runtime = await findRuntime(paths.stateRoot, workspace, sessionMode === "analysis");
	if (runtime) {
		const { findRuntimeGateway } = await import("../.pi/lib/runtime-launcher.mjs");
		const gateway = await findRuntimeGateway(runtime);
		if (action === "stop") { if (gateway) process.kill(gateway.pid, "SIGTERM"); process.stdout.write("Stopped Web gateway; Runtime continues running.\n"); return; }
		if (args.includes("--json")) process.stdout.write(JSON.stringify({ runtime: { pid: runtime.pid, cwd: runtime.cwd }, gateway }, null, 2) + "\n");
		else if (gateway) process.stdout.write(`Local Web: ${gateway.localUrl}\nWeb: ${gateway.url}\nRuntime: ${runtime.pid}\n`);
		else process.stdout.write("Runtime is running; no Web gateway. Use pi web start.\n");
		return;
	}
	const { findRuntimeGateway } = await import("../.pi/lib/runtime-launcher.mjs");
	const shared = await findRuntimeGateway({ stateRoot: paths.stateRoot });
	if (shared) {
		if (action === "stop") { process.kill(shared.pid, "SIGTERM"); process.stdout.write("Stopped Harness gateway; all project Runtimes continue running.\n"); }
		else if (args.includes("--json")) process.stdout.write(JSON.stringify(shared, null, 2) + "\n");
		else process.stdout.write(`Harness: ${shared.url}\nLocal: ${shared.localUrl}\n`);
		return;
	}
	const { findResidentWeb, stopResidentWeb } = await import("../.pi/lib/web-resident.mjs");
	const record = await findResidentWeb(paths.stateRoot, workspace);
	if (action === "stop" && record) { await stopResidentWeb(record); process.stdout.write("Stopped resident Pi for " + workspace + "\n"); return; }
	if (args.includes("--json")) process.stdout.write(JSON.stringify(record, null, 2) + "\n");
	else if (record) printWebRecord(record);
	else process.stdout.write("No resident Pi for " + workspace + "\n");
}

async function harnessCommand(argv) {
	const action = argv[0] ?? "status";
	const { findRuntimeGateway, ensureRuntimeGateway } = await import("../.pi/lib/runtime-launcher.mjs");
	const record = { stateRoot: paths.stateRoot };
	if (action === "start") {
		const config = prepareConfig(); loadConfigurationEnvironment(); applyConfigurationEnvironment(config);
		let args = argv.slice(1); if (config.ui.web.mode === "off" && !args.includes("--web") && !args.includes("--web-tailscale")) args = [...args, "--web"];
		const web = parseWebOptions(args, config.ui.web, { interactive: true });
		if (web.args.length || !web.enabled) throw new Error("Usage: pi harness start [--web|--web-tailscale] [--web-port port]");
		Object.assign(process.env, { RESEARCH_PI_STATE_DIR: paths.stateRoot, RESEARCH_PI_CONFIG_DIR: paths.configRoot, PI_CODING_AGENT_DIR: paths.agentDir });
		const gateway = await ensureRuntimeGateway({ stateRoot: paths.stateRoot, packageRoot, env: process.env, web });
		process.stdout.write(`Research Pi Harness: ${gateway.url}\nLocal: ${gateway.localUrl}\n`); return;
	}
	if (!["status", "stop"].includes(action)) throw new Error("Usage: pi harness [start|status|stop]");
	const gateway = await findRuntimeGateway(record);
	if (!gateway) { process.stdout.write("No Harness gateway running\n"); return; }
	if (action === "stop") { process.kill(gateway.pid, "SIGTERM"); process.stdout.write("Stopped Harness gateway; project Runtimes continue running\n"); }
	else process.stdout.write(`Research Pi Harness: ${gateway.url}\nLocal: ${gateway.localUrl}\n`);
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "harness") return harnessCommand(argv.slice(1));
	if (argv[0] === "runtime") {
		const action = argv[1] ?? "status";
		if (action === "start") return spawnCore(argv.slice(2), { background: true });
		const { workspace, args, sessionMode } = takeResearchOptions(argv.slice(2), {});
		if (!["status", "stop"].includes(action) || args.some((x) => x !== "--json")) throw new Error("Usage: pi runtime [start|status|stop] [--workspace path] [--analysis]");
		const { findRuntime } = await import("../.pi/lib/runtime-resident.mjs");
		const record = await findRuntime(paths.stateRoot, workspace, sessionMode === "analysis");
		if (!record) { process.stdout.write("No Runtime for this workspace\n"); return; }
		if (action === "stop") { const { stopRuntime } = await import("../.pi/lib/runtime-launcher.mjs"); await stopRuntime(record); process.stdout.write("Runtime stop requested\n"); }
		else process.stdout.write(JSON.stringify({ pid: record.pid, cwd: record.cwd, state: { ready: record.state.ready, idle: record.state.idle, sessionId: record.state.sessionId } }, null, 2) + "\n");
		return;
	}
	if (argv[0] === "web") return await webCommand(argv.slice(1));
	if (argv[0] === "watch") {
		const { runSubagentWatch } = await import("../.pi/lib/subagent-watch-ui.mjs");
		return await runSubagentWatch(argv.slice(1), paths);
	}
	if (argv[0] === "setup") return setup();
	if (argv[0] === "config") return configCommand(argv.slice(1));
	if (argv[0] === "analysis") return analysisCommand(argv.slice(1));
	if (argv[0] === "paths") {
		process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
		return;
	}
	if (argv[0] === "doctor") {
		const config = prepareConfig();
		loadConfigurationEnvironment();
		applyConfigurationEnvironment(config);
		const { workspace } = takeResearchOptions(argv.slice(1), config);
		const result = await runBoundaryDoctor({ cwd: workspace, environment: process.env });
		process.stdout.write(`${formatBoundaryDoctor(result)}\n`);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	await spawnCore(argv);
}

main().catch((error) => {
	process.stderr.write(`Research Pi: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
