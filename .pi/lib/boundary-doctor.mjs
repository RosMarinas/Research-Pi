import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getWslVersion, SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
	assertWslSandboxDependencies,
	buildSandboxRuntimeConfig,
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

export async function runWslSandboxProbe(runtime, environment, systemRuntime, options = {}) {
	const wslVersion = Object.prototype.hasOwnProperty.call(options, "wslVersion")
		? options.wslVersion
		: getWslVersion();
	if (wslVersion === undefined) return { applicable: false, ok: true };
	const manager = options.sandboxManager ?? SandboxManager;
	try {
		const dependencies = await manager.checkDependenciesAsync();
		assertWslSandboxDependencies(dependencies, wslVersion);
		if (dependencies.errors.length > 0) {
			throw new Error(`WSL sandbox dependencies unavailable: ${dependencies.errors.join("; ")}`);
		}
		await manager.initialize(
			buildSandboxRuntimeConfig(runtime.root, environment, systemRuntime),
			async () => true,
			false,
		);
		const command = [
			"set -eu",
			"if [ -e /mnt/c ] && ls /mnt/c >/dev/null 2>&1; then echo 'wsl-host-mount-readable' >&2; exit 91; fi",
			"if cmd.exe /d /c exit 0 >/dev/null 2>&1; then echo 'wsl-host-interop-executable' >&2; exit 92; fi",
			"printf 'research-pi-wsl-preflight=ok\\n'",
		].join("\n");
		const wrapped = await manager.wrapWithSandboxArgv(command, "/bin/sh", undefined, undefined, runtime.root, {
			commandId: `research-pi-doctor-${process.pid}`,
			commandText: command,
		});
		const result = await hostCommand(wrapped.argv[0], wrapped.argv.slice(1), runtime.root, {
			...sanitizeBoundaryEnvironment({ ...environment, ...wrapped.env }, wslVersion),
			...systemRuntime.environment,
			TMPDIR: runtime.runtimeTmp,
			TMP: runtime.runtimeTmp,
			TEMP: runtime.runtimeTmp,
		});
		if (!result.ok || result.stdout !== "research-pi-wsl-preflight=ok") {
			throw new Error(result.error || result.stderr || result.stdout || "WSL sandbox probe failed");
		}
		return {
			applicable: true,
			ok: true,
			version: wslVersion,
			stdout: result.stdout,
			warnings: dependencies.warnings,
		};
	} catch (error) {
		return {
			applicable: true,
			ok: false,
			version: wslVersion,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await manager.reset().catch(() => undefined);
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
	const wsl = await runWslSandboxProbe(runtime, environment, systemRuntime, options);
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
		ok: hostGit.ok && wsl.ok && codexAdvisor.ok && codexExecutor.ok,
		projectRoot: runtime.root,
		runtimeTmp: runtime.runtimeTmp,
		systemRuntime,
		hostGit,
		hostPython,
		wsl,
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
		result.wsl?.applicable
			? `WSL${result.wsl.version} boundary: ${result.wsl.ok ? result.wsl.stdout || "ok" : result.wsl.error}`
			: undefined,
		`Codex advisor: ${codexProbe(result.codexAdvisor)}`,
		`Codex executor: ${codexProbe(result.codexExecutor)}`,
		...result.systemRuntime.diagnostics,
	].filter(Boolean).join("\n");
}
