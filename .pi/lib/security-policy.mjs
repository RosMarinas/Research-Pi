import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isWithin(root, candidate) {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalDirectory(path) {
	if (!path || !existsSync(path)) return undefined;
	try {
		return await realpath(resolve(path));
	} catch {
		return undefined;
	}
}

async function activeDeveloperDirectory(environment, run = execFileAsync) {
	const configured = await canonicalDirectory(environment.DEVELOPER_DIR);
	if (configured) return configured;
	try {
		const { stdout } = await run("xcode-select", ["-p"], {
			env: environment,
			timeout: 3000,
			maxBuffer: 4096,
		});
		return await canonicalDirectory(stdout.trim());
	} catch {
		return undefined;
	}
}

async function configuredRuntimeRoots(environment) {
	const roots = [];
	const home = resolve(homedir());
	for (const value of String(environment.RESEARCH_PI_RUNTIME_ROOTS ?? "").split(delimiter)) {
		const root = await canonicalDirectory(value.trim());
		if (!root) continue;
		if (root === parse(root).root) throw new Error(`Refusing filesystem-root runtime grant: ${root}`);
		if ((isWithin(home, root) || isWithin(root, home)) && environment.RESEARCH_PI_ALLOW_HOME_RUNTIME_ROOTS !== "1") {
			throw new Error(
				`Refusing home-directory runtime root without RESEARCH_PI_ALLOW_HOME_RUNTIME_ROOTS=1: ${root}`,
			);
		}
		roots.push(root);
	}
	return roots;
}

async function trustedInstructionRoots(environment, homeDirectory) {
	const home = await canonicalDirectory(homeDirectory) ?? resolve(homeDirectory);
	const codexHome = resolve(environment.CODEX_HOME ?? join(home, ".codex"));
	const candidates = [join(codexHome, "skills"), join(home, ".agents", "skills")];
	const roots = [];
	for (const candidate of candidates) {
		const root = await canonicalDirectory(candidate);
		if (!root || root === home || root === parse(root).root || !isWithin(home, root)) continue;
		roots.push(root);
	}
	return [...new Set(roots)];
}

export async function resolveSystemRuntimePolicy(options = {}) {
	const platform = options.platform ?? process.platform;
	const environment = options.environment ?? process.env;
	const homeDirectory = options.homeDirectory ?? homedir();
	const readRoots = new Set();
	const instructionRoots = new Set();
	const injectedEnvironment = {};
	const diagnostics = [];

	if (platform === "darwin") {
		const developerDirectory = await activeDeveloperDirectory(environment, options.execFile ?? execFileAsync);
		if (developerDirectory) {
			const home = resolve(homedir());
			if (
				(isWithin(home, developerDirectory) || isWithin(developerDirectory, home)) &&
				environment.RESEARCH_PI_ALLOW_HOME_RUNTIME_ROOTS !== "1"
			) {
				throw new Error(
					`Refusing home-directory macOS developer runtime without RESEARCH_PI_ALLOW_HOME_RUNTIME_ROOTS=1: ${developerDirectory}`,
				);
			}
			readRoots.add(developerDirectory);
			injectedEnvironment.DEVELOPER_DIR = developerDirectory;
			diagnostics.push(`macOS developer runtime: ${developerDirectory}`);
		} else {
			diagnostics.push("macOS developer runtime: unavailable");
		}
	}

	for (const root of await configuredRuntimeRoots(environment)) {
		readRoots.add(root);
		diagnostics.push(`configured runtime root: ${root}`);
	}
	for (const root of await trustedInstructionRoots(environment, homeDirectory)) {
		instructionRoots.add(root);
		diagnostics.push(`trusted instruction root: ${root}`);
	}

	return {
		version: 1,
		platform,
		readRoots: [...readRoots],
		instructionRoots: [...instructionRoots],
		environment: injectedEnvironment,
		diagnostics,
	};
}

export function normalizeSystemRuntimePolicy(policy) {
	return {
		version: 1,
		platform: policy?.platform ?? process.platform,
		readRoots: [...new Set((policy?.readRoots ?? []).map((path) => resolve(path)))],
		instructionRoots: [...new Set((policy?.instructionRoots ?? []).map((path) => resolve(path)))],
		environment: { ...(policy?.environment ?? {}) },
		diagnostics: [...(policy?.diagnostics ?? [])],
	};
}
