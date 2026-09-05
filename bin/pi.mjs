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

function configCommand(argv) {
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
	throw new Error("Usage: pi config [show|path|themes|theme <name>]");
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

async function spawnCore(argv) {
	const baseConfig = prepareConfig();
	const { workspace, args: userArgs, config, sessionMode, fullAccess } = takeResearchOptions(argv, baseConfig);
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion });
	if (!existsSync(workspace)) throw new Error(`Research workspace does not exist: ${workspace}`);
	loadConfigurationEnvironment();
	applyConfigurationEnvironment(config);
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion, environment: process.env });
	const informational = userArgs.some((arg) => ["--version", "--help", "-h"].includes(arg));
	const deepSeekSearchEnabled = informational ? false : researchPiDeepSeekSearchEnabled(config, process.env);

	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	process.env.RESEARCH_PI_CONFIG_DIR = paths.configRoot;
	process.env.RESEARCH_PI_STATE_DIR = paths.stateRoot;
	if (sessionMode === "analysis") process.env.RESEARCH_PI_INITIAL_SESSION_MODE = "analysis";
	if (fullAccess) process.env.RESEARCH_PI_FULL_ACCESS = "1";
	if (process.env.RESEARCH_PI_TRACE === "1") process.env.PI_TRACE_DIR = paths.traceDir;

	const coreCli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(coreCli)) throw new Error(`Pinned Pi core is missing: ${coreCli}`);
	const args = ["--no-skills", "--no-extensions", "--no-themes"];
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
	const extensions = [
		"project-boundary.ts",
		"tool-activity.ts",
		"research-config.ts",
		"research-mode.ts",
		"record-experiment.ts",
		"research-transition.ts",
		"amend-project-state.ts",
		"research-checkpoint.ts",
		"research-memory.ts",
		"research-compaction.ts",
		"research-runtime.ts",
		"research-side.ts",
		"deepseek-v4-pro-anchor.ts",
		"codex-watch.ts",
		"codex-delegate.ts",
		"cache-audit.ts",
	];
	if (deepSeekSearchEnabled) extensions.splice(extensions.indexOf("deepseek-v4-pro-anchor.ts"), 0, "deepseek-web-search.ts");
	for (const name of extensions) args.push("--extension", join(packageRoot, ".pi", "extensions", name));
	if (process.env.RESEARCH_PI_TRACE === "1") {
		args.push("--extension", join(packageRoot, ".pi", "vendor", "pi-trace-extension-0.1.14", "trace", "index.ts"));
	}
	args.push(...userArgs);

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

async function main() {
	const argv = process.argv.slice(2);
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
