#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBoundaryDoctor, runBoundaryDoctor } from "../.pi/lib/boundary-doctor.mjs";
import {
	ensureResearchPiConfig,
	researchPiConfigSummary,
	researchPiEnvironment,
	researchPiProfile,
	resolveResearchPiConfig,
	writeResearchPiAgentConfig,
	writeResearchPiConfig,
} from "../.pi/lib/research-config.mjs";
import { resolveResearchPiPaths } from "../.pi/lib/runtime-paths.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveResearchPiPaths({ harnessRoot: packageRoot });
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const coreVersion = String(packageJson.dependencies?.["@earendil-works/pi-coding-agent"] ?? "").replace(/^[^0-9]*/, "");

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
	for (const path of [paths.configRoot, paths.stateRoot, paths.agentDir, paths.sessionDir]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion });
}

function prepareConfig() {
	const config = ensureResearchPiConfig(paths.configPath);
	ensureRuntimeLayout(config);
	return config;
}

function setup() {
	prepareConfig();
	if (!existsSync(paths.credentialsPath)) {
		mkdirSync(dirname(paths.credentialsPath), { recursive: true, mode: 0o700 });
		writeFileSync(paths.credentialsPath, "# Research Pi credentials; never commit this file.\nDEEPSEEK_API_KEY=\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		process.stdout.write(`Created ${paths.credentialsPath}\n`);
	} else {
		process.stdout.write(`Credentials file already exists: ${paths.credentialsPath}\n`);
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
	let workspace = process.env.PI_RESEARCH_WORKSPACE ?? process.cwd();
	const index = args.indexOf("--workspace");
	if (index >= 0) {
		if (!args[index + 1]) throw new Error("Usage: pi --workspace <project-directory> [pi options...]");
		workspace = args[index + 1];
		args.splice(index, 2);
	}
	let effectiveConfig = config;
	const profileIndex = args.indexOf("--profile");
	if (profileIndex >= 0) {
		if (!args[profileIndex + 1]) throw new Error("Usage: pi --profile <name> [pi options...]");
		const profile = args[profileIndex + 1];
		if (!config.profiles[profile]) throw new Error(`Unknown Research Pi model profile: ${profile}`);
		effectiveConfig = resolveResearchPiConfig({ ...config, activeProfile: profile });
		args.splice(profileIndex, 2);
	}
	return { workspace: resolve(workspace), args, config: effectiveConfig };
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
	const action = argv[0] ?? "show";
	if (action === "path") {
		process.stdout.write(`${paths.configPath}\n`);
		return;
	}
	if (action === "show") {
		process.stdout.write(`${researchPiConfigSummary(config, paths.configPath)}\n\n${JSON.stringify(config, null, 2)}\n`);
		return;
	}
	if (action === "list") {
		for (const name of Object.keys(config.profiles)) {
			const profile = researchPiProfile(config, name);
			process.stdout.write(`${name === config.activeProfile ? "*" : " "} ${name}\t${profile.provider}/${profile.model}\t${profile.thinking}\n`);
		}
		return;
	}
	if (action === "use") {
		const name = argv[1];
		if (!name || !config.profiles[name]) throw new Error(`Usage: pi config use <${Object.keys(config.profiles).join("|")}>`);
		const next = writeResearchPiConfig(paths.configPath, { ...config, activeProfile: name });
		writeResearchPiAgentConfig(paths.agentDir, next, { coreVersion });
		process.stdout.write(`${researchPiConfigSummary(next, paths.configPath)}\n`);
		return;
	}
	throw new Error("Usage: pi config [show|path|list|use <profile>]");
}

async function spawnCore(argv) {
	const baseConfig = prepareConfig();
	const { workspace, args: userArgs, config } = takeResearchOptions(argv, baseConfig);
	writeResearchPiAgentConfig(paths.agentDir, config, { coreVersion });
	if (!existsSync(workspace)) throw new Error(`Research workspace does not exist: ${workspace}`);
	loadConfigurationEnvironment();
	applyConfigurationEnvironment(config);
	const informational = userArgs.some((arg) => ["--version", "--help", "-h"].includes(arg));
	if (!informational && !process.env.DEEPSEEK_API_KEY?.trim()) {
		throw new Error(`DEEPSEEK_API_KEY is missing. Run 'pi setup', then edit ${paths.credentialsPath}.`);
	}

	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	process.env.RESEARCH_PI_CONFIG_DIR = paths.configRoot;
	process.env.RESEARCH_PI_STATE_DIR = paths.stateRoot;
	if (process.env.RESEARCH_PI_TRACE === "1") process.env.PI_TRACE_DIR = paths.traceDir;

	const coreCli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(coreCli)) throw new Error(`Pinned Pi core is missing: ${coreCli}`);
	const args = ["--no-skills", "--no-extensions"];
	for (const configuredPath of config.resources.skills) {
		const skill = expandUserPath(configuredPath);
		if (existsSync(join(skill, "SKILL.md"))) args.push("--skill", skill);
	}
	const profile = researchPiProfile(config);
	args.push(
		"--provider", profile.provider,
		"--model", profile.model,
		"--thinking", profile.thinking,
		"--session-dir", paths.sessionDir,
		"--append-system-prompt", join(packageRoot, ".pi", "APPEND_SYSTEM.md"),
	);
	for (const name of [
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
		"deepseek-web-search.ts",
		"deepseek-v4-pro-anchor.ts",
		"codex-watch.ts",
		"codex-delegate.ts",
	]) args.push("--extension", join(packageRoot, ".pi", "extensions", name));
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
