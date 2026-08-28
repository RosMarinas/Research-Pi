import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	prepareBoundaryRuntime,
	readGitIdentity,
	runCodexSandboxPreflight,
	sanitizeBoundaryEnvironment,
} from "./project-boundary.mjs";
import { resolveSystemRuntimePolicy } from "./security-policy.mjs";

const execFileAsync = promisify(execFile);

async function hostCommand(command, args, cwd, environment) {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd,
			env: environment,
			timeout: 10_000,
			maxBuffer: 64 * 1024,
		});
		return { ok: true, command: [command, ...args].join(" "), stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error) {
		return {
			ok: false,
			command: [command, ...args].join(" "),
			error: [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n").slice(-8000),
		};
	}
}

export async function runBoundaryDoctor(options) {
	const cwd = options.cwd;
	const runtime = await prepareBoundaryRuntime(cwd);
	const systemRuntime = await resolveSystemRuntimePolicy({ environment: options.environment ?? process.env });
	const environment = {
		...sanitizeBoundaryEnvironment(options.environment ?? process.env),
		...systemRuntime.environment,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
	};
	const hostGit = await hostCommand("git", ["status", "--porcelain=v1", "--untracked-files=no"], runtime.root, environment);
	const hostPython = await hostCommand("python3", ["--version"], runtime.root, environment);
	const gitIdentity = await readGitIdentity(runtime.root);
	const probeCodex = async (mode) => {
		try {
			return await runCodexSandboxPreflight({
			codexBin: options.codexBin ?? options.environment?.PI_CODEX_BIN ?? process.env.PI_CODEX_BIN ?? "codex",
			mode,
			cwd: runtime.root,
			runtimeTmp: mode === "executor" ? runtime.runtimeTmp : undefined,
			gitIdentity,
			runtimePolicy: systemRuntime,
			environment,
			});
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	const [codexAdvisor, codexExecutor] = await Promise.all([probeCodex("advisor"), probeCodex("executor")]);
	return {
		ok: hostGit.ok && codexAdvisor.ok && codexExecutor.ok,
		projectRoot: runtime.root,
		runtimeTmp: runtime.runtimeTmp,
		systemRuntime,
		hostGit,
		hostPython,
		codexAdvisor,
		codexExecutor,
	};
}

export function formatBoundaryDoctor(result) {
	const codexProbe = (probe) => probe.ok
		? `${probe.codexVersion || "ok"}${probe.codexBin ? ` · ${probe.codexBin}` : ""}`
		: probe.error;
	return [
		`Research Pi boundary doctor: ${result.ok ? "PASS" : "FAIL"}`,
		`Project: ${result.projectRoot}`,
		`Host Git: ${result.hostGit.ok ? "ok" : result.hostGit.error}`,
		`Host Python: ${result.hostPython.ok ? result.hostPython.stdout || "ok" : `optional/unavailable: ${result.hostPython.error}`}`,
		`Codex advisor: ${codexProbe(result.codexAdvisor)}`,
		`Codex executor: ${codexProbe(result.codexExecutor)}`,
		...result.systemRuntime.diagnostics,
	].join("\n");
}
