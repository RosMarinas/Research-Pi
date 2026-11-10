import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
	buildSandboxRuntimeConfig,
	prepareBoundaryRuntime,
	projectSandboxSpawn,
	projectTemporaryEnvironment,
	readGitIdentity,
	resolveSandboxDependencies,
	runCodexSandboxPreflight,
	sanitizeBoundaryEnvironment,
	SYSTEM_TMPDIR,
} from "./project-boundary.mjs";
import { resolveSystemRuntimePolicy } from "./security-policy.mjs";

const execFileAsync = promisify(execFile);

async function probePiSandbox(runtime, systemRuntime, environment, access) {
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	const saved = Object.fromEntries(["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"].map(name => [name, process.env[name]]));
	try {
		Object.assign(process.env, { TMPDIR: SYSTEM_TMPDIR, TMP: SYSTEM_TMPDIR, TEMP: SYSTEM_TMPDIR, CLAUDE_CODE_TMPDIR: runtime.runtimeTmp });
		const dependencies = await resolveSandboxDependencies();
		await SandboxManager.initialize({
			...buildSandboxRuntimeConfig(runtime.root, environment, systemRuntime, { access, runtimeTmp: runtime.runtimeTmp }),
			...dependencies,
		}, async () => true, false);
		const command = [
			"set -eu", "git --version >/dev/null",
			'probe=$(mktemp "$TMPDIR/pi-boundary-preflight.XXXXXX")',
			'trap \'rm -f "$probe"\' EXIT',
			'printf "scratch probe\\n" > "$probe"', 'cat "$probe" >/dev/null',
			'printf "research-pi-shell-preflight=ok\\n"',
		].join("\n");
		const generated = await SandboxManager.wrapWithSandboxArgv(command, "/bin/sh", undefined, undefined, runtime.root);
		const wrapped = projectSandboxSpawn(generated, runtime, {
			networkSockets: [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()],
		});
		const { stdout, stderr } = await execFileAsync(wrapped.argv[0], wrapped.argv.slice(1), {
			cwd: runtime.root, timeout: 20_000, maxBuffer: 16 * 1024,
			env: { ...sanitizeBoundaryEnvironment({ ...environment, ...wrapped.env }), ...systemRuntime.environment, ...projectTemporaryEnvironment(runtime.runtimeTmp) },
		});
		return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error) {
		// execFile's message includes proxy credentials from the generated argv.
		return { ok: false, error: String(error?.stderr || (error?.cmd ? error?.code : error?.message) || "Pi sandbox initialization failed").slice(-8000) };
	} finally {
		try {
			SandboxManager.cleanupAfterCommand();
			await SandboxManager.reset();
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name]; else process.env[name] = value;
			}
		}
	}
}

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
	const piAnalysis = await probePiSandbox(runtime, systemRuntime, environment, "read");
	const piExecutor = await probePiSandbox(runtime, systemRuntime, environment, "write");
	const probeCodex = async (mode) => {
		try {
			return await runCodexSandboxPreflight({
			codexBin: options.codexBin ?? options.environment?.PI_CODEX_BIN ?? process.env.PI_CODEX_BIN ?? "codex",
			mode,
			cwd: runtime.root,
			runtimeTmp: runtime.runtimeTmp,
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
		ok: hostGit.ok && piAnalysis.ok && piExecutor.ok && codexAdvisor.ok && codexExecutor.ok,
		projectRoot: runtime.root,
		runtimeTmp: runtime.runtimeTmp,
		systemRuntime,
		hostGit,
		hostPython,
		piAnalysis,
		piExecutor,
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
		`Pi Analysis: ${result.piAnalysis.ok ? "project read-only / scratch writable" : result.piAnalysis.error}`,
		`Pi sandboxed executor: ${result.piExecutor.ok ? "project / scratch writable" : result.piExecutor.error}`,
		`Codex advisor: ${codexProbe(result.codexAdvisor)}`,
		`Codex executor: ${codexProbe(result.codexExecutor)}`,
		...result.systemRuntime.diagnostics,
	].join("\n");
}

// A live Session owns SandboxManager's global state. Run diagnostics in a
// separate process so probing both access modes cannot reset that Session.
export async function runBoundaryDoctorProcess(options) {
	let stdout;
	try {
		({ stdout } = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), options.cwd], {
			cwd: options.cwd, env: options.environment ?? process.env, timeout: 90_000, maxBuffer: 128 * 1024,
		}));
	} catch (error) {
		if (!error?.stdout) throw error;
		stdout = error.stdout;
	}
	return JSON.parse(stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await runBoundaryDoctor({ cwd: process.argv[2] ?? process.cwd() });
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (!result.ok) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
