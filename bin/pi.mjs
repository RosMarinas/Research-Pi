#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBoundaryDoctor, runBoundaryDoctor } from "../.pi/lib/boundary-doctor.mjs";
import { resolveResearchPiPaths } from "../.pi/lib/runtime-paths.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveResearchPiPaths({ harnessRoot: packageRoot });

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

function ensureRuntimeLayout() {
	for (const path of [paths.configRoot, paths.stateRoot, paths.agentDir, paths.sessionDir]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	for (const name of ["models.json", "settings.json"]) {
		const source = join(packageRoot, ".pi", "agent", name);
		const destination = join(paths.agentDir, name);
		if (resolve(source) !== resolve(destination)) {
			copyFileSync(source, destination);
			chmodSync(destination, 0o600);
		}
	}
}

function setup() {
	ensureRuntimeLayout();
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
}

function loadConfigurationEnvironment() {
	const credentials = parseCredentialFile(paths.credentialsPath);
	for (const [name, value] of Object.entries(credentials)) {
		if (process.env[name] === undefined) process.env[name] = value;
	}
}

function takeWorkspace(argv) {
	const args = [...argv];
	let workspace = process.env.PI_RESEARCH_WORKSPACE ?? process.cwd();
	const index = args.indexOf("--workspace");
	if (index >= 0) {
		if (!args[index + 1]) throw new Error("Usage: pi --workspace <project-directory> [pi options...]");
		workspace = args[index + 1];
		args.splice(index, 2);
	}
	return { workspace: resolve(workspace), args };
}

async function spawnCore(argv) {
	ensureRuntimeLayout();
	const { workspace, args: userArgs } = takeWorkspace(argv);
	if (!existsSync(workspace)) throw new Error(`Research workspace does not exist: ${workspace}`);
	loadConfigurationEnvironment();
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
	for (const skill of [
		join(homedir(), ".codex", "skills", "remote-workspace"),
		join(homedir(), ".agents", "skills", "cognitive-knowledge-network"),
	]) {
		if (existsSync(join(skill, "SKILL.md"))) args.push("--skill", skill);
	}
	args.push(
		"--provider", "deepseek",
		"--model", "deepseek-v4-flash",
		"--thinking", "max",
		"--session-dir", paths.sessionDir,
		"--append-system-prompt", join(packageRoot, ".pi", "APPEND_SYSTEM.md"),
	);
	for (const name of [
		"project-boundary.ts",
		"tool-activity.ts",
		"research-mode.ts",
		"record-experiment.ts",
		"research-checkpoint.ts",
		"research-memory.ts",
		"research-compaction.ts",
		"research-side.ts",
		"deepseek-web-search.ts",
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
	if (argv[0] === "paths") {
		process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
		return;
	}
	if (argv[0] === "doctor") {
		ensureRuntimeLayout();
		loadConfigurationEnvironment();
		const { workspace } = takeWorkspace(argv.slice(1));
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
