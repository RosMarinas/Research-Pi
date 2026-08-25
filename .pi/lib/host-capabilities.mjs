import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { getWslVersion } from "@anthropic-ai/sandbox-runtime";
import {
	isProtectedProjectMutation,
	isWithinRoot,
	resolveBoundaryPath,
	resolveProjectRoot,
	sanitizeWslInteropEnvironment,
	secretEnvironmentNames,
} from "./project-boundary.mjs";

const LEDGER_VERSION = 2;
const SESSION_GRANT_MS = 24 * 60 * 60 * 1000;
const MAX_READ_BYTES = 128 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_SECRET_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);

function now() {
	return new Date().toISOString();
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function normalizeScope(scope) {
	if (scope !== "once" && scope !== "session" && scope !== "project") {
		throw new Error(`Unsupported capability scope: ${scope}`);
	}
	return scope;
}

function normalizeArgs(args) {
	if (!Array.isArray(args)) return [];
	if (args.length > 128) throw new Error("A host command accepts at most 128 arguments");
	return args.map((value) => {
		const text = String(value);
		if (text.includes("\0") || text.length > 4096) throw new Error("Invalid host-command argument");
		return text;
	});
}

function sameArray(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function startsWithArray(values, prefix) {
	return prefix.length > 0 && prefix.length <= values.length && prefix.every((value, index) => values[index] === value);
}

function commandGrantMatchesArgv(grant, argv) {
	if (grant?.kind !== "host-command") return false;
	return grant.match === "prefix"
		? startsWithArray(argv ?? [], grant.argv ?? [])
		: sameArray(grant.argv ?? [], argv ?? []);
}

function normalizeGrantId(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const id = String(value).trim();
	if (!/^grant-[A-Za-z0-9]{8}$/.test(id)) throw new Error("Host capability grantId must be an exact grant-XXXXXXXX id");
	return id;
}

function recommendedCommandPrefix(argv) {
	const executable = basename(argv[0]).toLowerCase();
	if (executable === "uv" && argv[1] === "run" && argv[2]) {
		const runner = basename(argv[2]).toLowerCase();
		if (["python", "python3"].includes(runner) && argv[3] === "-m" && argv[4]) return argv.slice(0, 5);
		if (["python", "python3"].includes(runner) && argv[3] && !argv[3].startsWith("-")) return argv.slice(0, 4);
		if (["python", "python3"].includes(runner) && argv[3] === "-c") return [...argv];
		return argv.slice(0, 3);
	}
	if (["python", "python3"].includes(executable)) {
		if (argv[1] === "-c") return [...argv];
		if (argv[1] === "-m" && argv[2]) return argv.slice(0, 3);
		if (argv[1] && !argv[1].startsWith("-")) return argv.slice(0, 2);
	}
	if (["node", "bash", "sh", "zsh"].includes(executable)) {
		if (["-c", "-lc", "-e", "--eval"].includes(argv[1])) return [...argv];
		if (argv[1] && !argv[1].startsWith("-")) return argv.slice(0, 2);
	}
	return argv.slice(0, 1);
}

function displayArgv(argv) {
	return argv.map((value) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value))).join(" ");
}

function stateRootForProject(projectRoot, explicitStateRoot) {
	if (explicitStateRoot) return resolve(explicitStateRoot);
	if (process.env.PI_RESEARCH_CAPABILITY_DIR) return resolve(process.env.PI_RESEARCH_CAPABILITY_DIR);
	if (process.env.PI_CODING_AGENT_DIR) return resolve(dirname(process.env.PI_CODING_AGENT_DIR), "capabilities");
	if (process.platform === "win32") {
		return resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Research-Pi", "state", "capabilities");
	}
	return resolve(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "research-pi", "capabilities");
}

function resolveWslVersion(options = {}) {
	return Object.prototype.hasOwnProperty.call(options, "wslVersion") ? options.wslVersion : getWslVersion();
}

function isWslHostExecutable(value) {
	const executable = basename(String(value ?? "").replaceAll("\\", "/")).toLowerCase();
	return executable.endsWith(".exe") || ["powershell", "pwsh", "wsl", "explorer"].includes(executable);
}

function obviousWslHostPathReference(value) {
	const normalized = String(value ?? "").replaceAll("\\", "/").toLowerCase();
	return (
		normalized === "/mnt" ||
		normalized.startsWith("/mnt/") ||
		normalized.includes(" /mnt/") ||
		normalized.includes("'/mnt/") ||
		normalized.includes('"/mnt/') ||
		normalized.includes("/run/wsl/") ||
		normalized.includes("/run/desktop/mnt/host/") ||
		normalized.includes("//wsl$/")
	);
}

function obviousWslInteropReference(value) {
	const normalized = String(value ?? "").replaceAll("\\", "/").toLowerCase();
	return obviousWslHostPathReference(normalized) ||
		/(?:^|[\s'"/])(?:cmd|powershell|pwsh|wsl|explorer)(?:\.exe)?(?:$|[\s'"/])/.test(normalized);
}

export function assertWslHostCommand(argv, wslVersion = getWslVersion()) {
	if (wslVersion === undefined) return;
	if (isWslHostExecutable(argv[0])) {
		throw new Error("WSL host-command cannot launch Windows or PowerShell executables; run Windows-native operations manually in PowerShell");
	}
	const executable = basename(argv[0]).toLowerCase();
	const codeArgument = ["sh", "bash", "zsh"].includes(executable) && ["-c", "-lc"].includes(argv[1])
		? argv[2]
		: ["python", "python3"].includes(executable) && argv[1] === "-c"
			? argv[2]
			: executable === "node" && ["-e", "--eval"].includes(argv[1])
				? argv[2]
				: undefined;
	if (argv.some(obviousWslHostPathReference) || (codeArgument && obviousWslInteropReference(codeArgument))) {
		throw new Error("WSL host-command cannot address /mnt or Windows host interop; run that exact Windows-native operation manually");
	}
}

export async function resolveCapabilityContext(cwd, sessionId, options = {}) {
	if (!SESSION_ID_PATTERN.test(String(sessionId ?? ""))) throw new Error("Invalid Pi session id for capability ledger");
	const projectRoot = await resolveProjectRoot(cwd);
	const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 24);
	const stateRoot = stateRootForProject(projectRoot, options.stateRoot);
	return {
		version: LEDGER_VERSION,
		projectRoot,
		sessionId,
		wslVersion: resolveWslVersion(options),
		ledgerPath: join(stateRoot, projectHash, "sessions", `${sessionId}.json`),
		legacyLedgerPath: join(stateRoot, projectHash, `${sessionId}.json`),
		projectLedgerPath: join(stateRoot, projectHash, "project.json"),
	};
}

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

function emptyLedger(context, ledgerKind) {
	return {
		version: LEDGER_VERSION,
		ledgerKind,
		projectRoot: context.projectRoot,
		...(ledgerKind === "session" ? { sessionId: context.sessionId } : {}),
		updatedAt: now(),
		grants: [],
	};
}

function ledgerPath(context, ledgerKind) {
	return ledgerKind === "project" ? context.projectLedgerPath : context.ledgerPath;
}

async function readLedger(context, ledgerKind = "session") {
	const path = ledgerPath(context, ledgerKind);
	let ledger;
	try {
		ledger = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT" && ledgerKind === "session" && context.legacyLedgerPath) {
			try {
				ledger = JSON.parse(await readFile(context.legacyLedgerPath, "utf8"));
			} catch (legacyError) {
				if (legacyError?.code === "ENOENT") return emptyLedger(context, ledgerKind);
				throw legacyError;
			}
		} else if (error?.code === "ENOENT") {
			return emptyLedger(context, ledgerKind);
		} else {
			throw error;
		}
	}
	const legacySessionLedger = ledgerKind === "session" && ledger.version === 1;
	const identityMatches =
		ledger.projectRoot === context.projectRoot &&
		(ledgerKind === "project" || ledger.sessionId === context.sessionId);
	if ((!legacySessionLedger && ledger.version !== LEDGER_VERSION) || !identityMatches) {
		throw new Error("Capability ledger identity mismatch");
	}
	ledger.version = LEDGER_VERSION;
	ledger.ledgerKind = ledgerKind;
	const currentTime = Date.now();
	ledger.grants = Array.isArray(ledger.grants)
		? ledger.grants.filter((grant) => !grant.expiresAt || Date.parse(grant.expiresAt) > currentTime)
		: [];
	return ledger;
}

async function withLedgerLock(context, ledgerKind, action) {
	const path = ledgerPath(context, ledgerKind);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	let handle;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid} ${now()}\n`, "utf8");
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockPath);
			} catch (lockError) {
				if (lockError?.code !== "ENOENT") throw lockError;
			}
			await delay(25);
		}
	}
	if (!handle) throw new Error("Timed out waiting for the capability ledger lock");
	try {
		return await action(await readLedger(context, ledgerKind), path);
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(lockPath).catch(() => undefined);
	}
}

function extension(path) {
	const name = path.slice(path.lastIndexOf(sep) + 1).toLowerCase();
	const index = name.lastIndexOf(".");
	return index >= 0 ? name.slice(index) : "";
}

export function isForbiddenCredentialRead(path) {
	const candidate = resolve(path);
	const name = candidate.slice(candidate.lastIndexOf(sep) + 1);
	const lower = name.toLowerCase();
	if (lower === ".env" || lower.startsWith(".env.")) return true;
	if (FORBIDDEN_SECRET_EXTENSIONS.has(extension(candidate))) return true;
	const home = resolve(homedir());
	const rel = relative(home, candidate).split(sep).join("/");
	if (rel === ".ssh" || rel.startsWith(".ssh/")) {
		return !(
			rel === ".ssh/config" ||
			rel === ".ssh/known_hosts" ||
			rel === ".ssh/known_hosts.old" ||
			rel.endsWith(".pub")
		);
	}
	return (
		rel === ".aws/credentials" ||
		rel.startsWith(".gnupg/") ||
		rel.startsWith(".config/gcloud/") ||
		rel === ".kube/config" ||
		rel.startsWith("Library/Keychains/")
	);
}

export function normalizeSshTarget(input, explicitPort) {
	const raw = String(input ?? "").trim();
	if (!raw || raw.length > 255 || raw.startsWith("-") || /[\s\0/\\'"`;|&$()<>]/.test(raw)) {
		throw new Error("SSH target must be a plain [user@]host alias or address");
	}
	let destination = raw;
	let port = explicitPort === undefined || explicitPort === null ? undefined : Number(explicitPort);
	const portMatch = raw.match(/^(.*):([0-9]{1,5})$/);
	if (port === undefined && portMatch && !portMatch[1].includes(":")) {
		destination = portMatch[1];
		port = Number(portMatch[2]);
	}
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid SSH port");
	if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(destination)) {
		throw new Error("Unsupported SSH target syntax");
	}
	return {
		destination,
		port,
		canonical: `${destination.toLowerCase()}${port ? `:${port}` : ""}`,
	};
}

export async function sha256File(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileContainsPrivateKey(path) {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(buffer.subarray(0, bytesRead).toString("utf8"));
	} finally {
		await handle.close();
	}
}

export async function prepareCapabilityRequest(context, input) {
	if (!context?.projectRoot || !context?.sessionId || !context?.ledgerPath || !context?.projectLedgerPath) {
		throw new Error("Capability context is unavailable");
	}
	const kind = input?.kind;
	if (kind === "external-read") {
		const info = await resolveBoundaryPath(context.projectRoot, input.path);
		if (info.inside) throw new Error("Project files do not need an external-read capability");
		if (isForbiddenCredentialRead(info.lexicalPath) || isForbiddenCredentialRead(info.resolvedPath)) {
			throw new Error("Credential material cannot be made model-readable; use an opaque SSH or project-script capability instead");
		}
		const targetStat = await stat(info.resolvedPath);
		if (!targetStat.isFile() && !targetStat.isDirectory()) throw new Error("External-read supports regular files and directories only");
		if (targetStat.isFile() && await fileContainsPrivateKey(info.resolvedPath)) {
			throw new Error("Private-key content cannot be made model-readable; use an opaque SSH capability instead");
		}
		return {
			kind,
			target: info.resolvedPath,
			directory: targetStat.isDirectory(),
		};
	}
	if (kind === "ssh-target") {
		const target = normalizeSshTarget(input.target, input.port);
		return { kind, target: target.canonical, destination: target.destination, port: target.port };
	}
	if (kind === "host-command") {
		const argv = normalizeArgs(input.argv);
		if (argv.length === 0 || !argv[0].trim() || argv[0].startsWith("-")) {
			throw new Error("A host-command capability requires an executable argv[0]");
		}
		assertWslHostCommand(argv, context.wslVersion);
		const workingDirectory = await resolveBoundaryPath(context.projectRoot, input.cwd ?? context.projectRoot);
		if (!workingDirectory.inside) throw new Error("A host-command working directory must stay inside the current project");
		const workingDirectoryStat = await stat(workingDirectory.resolvedPath);
		if (!workingDirectoryStat.isDirectory()) throw new Error("A host-command working directory must be a directory");
		return {
			kind,
			target: displayArgv(argv),
			cwd: workingDirectory.resolvedPath,
			argv,
			match: "exact",
			suggestedPrefix: recommendedCommandPrefix(argv),
		};
	}
	if (kind === "project-script") {
		const info = await resolveBoundaryPath(context.projectRoot, input.path);
		if (!info.inside) throw new Error("A project-script capability must point inside the current project");
		if (isProtectedProjectMutation(info.root, info.resolvedPath)) throw new Error("Git hooks cannot be approved as host scripts");
		const targetStat = await stat(info.resolvedPath);
		if (!targetStat.isFile()) throw new Error("Project-script target must be a regular file");
		await access(info.resolvedPath);
		const args = normalizeArgs(input.args);
		const scriptContent = await readFile(info.resolvedPath);
		const approvalPreview = scriptContent.includes(0)
			? "[binary executable; no text preview]"
			: scriptContent.toString("utf8").split("\n").slice(0, 20).join("\n").slice(0, 3000);
		return {
			kind,
			target: info.resolvedPath,
			sha256: createHash("sha256").update(scriptContent).digest("hex"),
			args,
			approvalPreview,
		};
	}
	throw new Error(`Unsupported host capability kind: ${kind}`);
}

function grantMatches(grant, request) {
	if (grant.kind !== request.kind) return false;
	if (grant.kind === "external-read") {
		return grant.directory ? isWithinRoot(grant.target, request.target) : grant.target === request.target;
	}
	if (grant.kind === "ssh-target") return grant.target === request.target;
	if (grant.kind === "host-command") {
		return grant.cwd === request.cwd && (
			grant.match === "prefix"
				? startsWithArray(request.argv ?? [], grant.argv ?? [])
				: sameArray(grant.argv ?? [], request.argv ?? [])
		);
	}
	if (grant.kind === "project-script") {
		return grant.target === request.target && grant.sha256 === request.sha256 && sameArray(grant.args ?? [], request.args ?? []);
	}
	return false;
}

function grantAllowedForContext(context, grant) {
	if (context.wslVersion === undefined) return true;
	if (grant.kind !== "host-command" && grant.kind !== "project-script") return true;
	return grant.scope === "once";
}

export function capabilityGrantSummary(grant) {
	if (grant.kind === "host-command") {
		return `${grant.id} · host-command ${grant.match ?? "exact"} · cwd=${grant.cwd} · ${displayArgv(grant.argv ?? [])} · ${grant.scope}`;
	}
	if (grant.kind === "project-script") {
		return `${grant.id} · project-script · ${grant.target} ${(grant.args ?? []).join(" ")} · ${grant.scope}`.trim();
	}
	return `${grant.id} · ${grant.kind} · ${grant.target} · ${grant.scope}`;
}

export async function listCapabilityGrants(context) {
	const [projectLedger, sessionLedger] = await Promise.all([
		readLedger(context, "project"),
		readLedger(context, "session"),
	]);
	return [...projectLedger.grants, ...sessionLedger.grants].filter((grant) => grantAllowedForContext(context, grant));
}

export async function findCapabilityGrant(context, request) {
	return (await listCapabilityGrants(context)).find((grant) => grantMatches(grant, request));
}

function distinctCommandCwds(grants) {
	return [...new Map(grants.filter((grant) => grant.cwd).map((grant) => [grant.cwd, grant])).values()];
}

function commandGrantChoices(grants) {
	return distinctCommandCwds(grants)
		.slice(0, 6)
		.map((grant) => `${grant.id} (cwd=${grant.cwd})`)
		.join(", ");
}

/**
 * Resolve an invocation against active grants without consuming a one-shot grant.
 * If cwd is omitted, a unique already-approved cwd may be adopted. This narrows
 * execution to prior authority; it never creates or broadens a grant.
 */
export async function inspectCapabilityAuthorization(context, input) {
	const grants = await listCapabilityGrants(context);
	const grantId = normalizeGrantId(input?.grantId);
	const selectedGrant = grantId ? grants.find((grant) => grant.id === grantId) : undefined;
	if (grantId && !selectedGrant) throw new Error(`Unknown or inactive host capability grantId: ${grantId}`);
	if (selectedGrant && selectedGrant.kind !== input?.kind) {
		throw new Error(`Host capability ${grantId} is ${selectedGrant.kind}, not ${input?.kind ?? "an unspecified kind"}`);
	}

	let effectiveInput = input;
	let commandCandidates = [];
	if (input?.kind === "host-command") {
		const preliminary = await prepareCapabilityRequest(context, { ...input, cwd: input.cwd ?? context.projectRoot });
		commandCandidates = grants.filter((grant) => commandGrantMatchesArgv(grant, preliminary.argv));
		if (selectedGrant) {
			if (!commandGrantMatchesArgv(selectedGrant, preliminary.argv)) {
				throw new Error(`Host capability ${grantId} does not authorize argv: ${displayArgv(preliminary.argv)}`);
			}
			if (input.cwd === undefined || input.cwd === null || input.cwd === "") {
				effectiveInput = { ...input, cwd: selectedGrant.cwd };
			}
		} else if (input.cwd === undefined || input.cwd === null || input.cwd === "") {
			const choices = distinctCommandCwds(commandCandidates);
			if (choices.length === 1) effectiveInput = { ...input, cwd: choices[0].cwd };
			else if (choices.length > 1) {
				throw new Error(
					`Multiple approved host-command capabilities match this argv at different working directories. ` +
					`Retry the same command with an exact grantId; do not create a shell-wrapper grant. Candidates: ${commandGrantChoices(commandCandidates)}`,
				);
			}
		}
	}

	const request = await prepareCapabilityRequest(context, effectiveInput);
	if (selectedGrant && !grantMatches(selectedGrant, request)) {
		throw new Error(
			`Host capability ${grantId} is bound to cwd=${selectedGrant.cwd ?? "(not applicable)"} and does not authorize this invocation`,
		);
	}
	const grant = selectedGrant ?? grants.find((candidate) => grantMatches(candidate, request));
	const alternatives = request.kind === "host-command"
		? commandCandidates.filter((candidate) => !grantMatches(candidate, request))
		: [];
	return { request, grant, alternatives, selectedGrantId: selectedGrant?.id };
}

export async function createCapabilityGrant(context, request, scope = "session") {
	const normalizedScope = normalizeScope(scope);
	if (
		context.wslVersion !== undefined &&
		(request.kind === "host-command" || request.kind === "project-script") &&
		normalizedScope !== "once"
	) {
		throw new Error("WSL host commands and project scripts require one-shot approval; persistent trust is limited to opaque SSH targets");
	}
	const ledgerKind = normalizedScope === "project" ? "project" : "session";
	const persistedRequest = { ...request };
	delete persistedRequest.approvalPreview;
	if (persistedRequest.kind === "host-command") {
		persistedRequest.argv = normalizedScope === "project"
			? [...(persistedRequest.suggestedPrefix ?? persistedRequest.argv)]
			: [...persistedRequest.argv];
		persistedRequest.target = displayArgv(persistedRequest.argv);
		persistedRequest.match = normalizedScope === "project" ? "prefix" : "exact";
	}
	delete persistedRequest.suggestedPrefix;
	return await withLedgerLock(context, ledgerKind, async (ledger, path) => {
		const existing = ledger.grants.find((grant) => grantMatches(grant, persistedRequest) && grant.scope === normalizedScope);
		if (existing) return existing;
		const createdAt = now();
		const grant = {
			version: LEDGER_VERSION,
			id: `grant-${randomUUID().slice(0, 8)}`,
			...persistedRequest,
			scope: normalizedScope,
			createdAt,
			...(normalizedScope === "project" ? {} : { expiresAt: new Date(Date.now() + SESSION_GRANT_MS).toISOString() }),
		};
		ledger.grants.push(grant);
		ledger.updatedAt = createdAt;
		await writeJsonAtomic(path, ledger);
		return grant;
	});
}

export async function revokeCapabilityGrant(context, selector) {
	let removed = 0;
	for (const ledgerKind of ["session", "project"]) {
		removed += await withLedgerLock(context, ledgerKind, async (ledger, path) => {
			const before = ledger.grants.length;
			ledger.grants = selector === "all"
				? []
				: ledger.grants.filter((grant) => grant.id !== selector && !grant.id.startsWith(selector));
			const count = before - ledger.grants.length;
			if (count > 0) {
				ledger.updatedAt = now();
				await writeJsonAtomic(path, ledger);
			}
			return count;
		});
	}
	return removed;
}

async function consumeCapabilityGrant(context, request, grantId) {
	const sessionGrant = await withLedgerLock(context, "session", async (ledger, path) => {
		const index = ledger.grants.findIndex(
			(grant) => grantAllowedForContext(context, grant) && (!grantId || grant.id === grantId) && grantMatches(grant, request),
		);
		if (index < 0) return undefined;
		const grant = ledger.grants[index];
		if (grant.scope === "once") {
			ledger.grants.splice(index, 1);
			ledger.updatedAt = now();
			await writeJsonAtomic(path, ledger);
		}
		return grant;
	});
	if (sessionGrant) return sessionGrant;
	return (await readLedger(context, "project")).grants.find(
		(grant) => grantAllowedForContext(context, grant) && (!grantId || grant.id === grantId) && grantMatches(grant, request),
	);
}

export async function authorizeCapabilityRequest(context, input) {
	const inspected = await inspectCapabilityAuthorization(context, input);
	return {
		...inspected,
		grant: inspected.grant ? await consumeCapabilityGrant(context, inspected.request, inspected.selectedGrantId) : undefined,
	};
}

export function hostBridgeEnvironment(source = process.env, options = {}) {
	const allowed = new Set([
		"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "SSH_AUTH_SOCK",
		"VIRTUAL_ENV", "PYTHONPATH", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
	]);
	const allowedPrefixes = ["LC_", "UV_", "PIP_", "CONDA_", "XDG_"];
	const env = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (allowed.has(name) || allowedPrefixes.some((prefix) => name.startsWith(prefix))) env[name] = value;
	}
	for (const name of secretEnvironmentNames(env)) {
		if (name !== "SSH_AUTH_SOCK") delete env[name];
	}
	return sanitizeWslInteropEnvironment(env, resolveWslVersion(options));
}

function terminateProcess(child) {
	if (!child?.pid || child.exitCode !== null) return;
	try {
		if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

async function runBoundedProcess(executable, args, options = {}) {
	const timeoutSeconds = Math.min(Math.max(Number(options.timeoutSeconds ?? 3600), 1), 86400);
	return await new Promise((resolveRun, rejectRun) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			detached: true,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: hostBridgeEnvironment(options.env, { wslVersion: options.wslVersion }),
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let outputTruncated = false;
		let timedOut = false;
		const capture = (kind, chunk) => {
			options.onData?.(chunk);
			const current = kind === "stdout" ? stdout : stderr;
			const remaining = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - current.length);
			if (remaining === 0) outputTruncated = true;
			else {
				const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
				if (kind === "stdout") stdout = next;
				else stderr = next;
				if (chunk.length > remaining) outputTruncated = true;
			}
		};
		child.stdout.on("data", (chunk) => capture("stdout", chunk));
		child.stderr.on("data", (chunk) => capture("stderr", chunk));
		const timer = setTimeout(() => {
			timedOut = true;
			terminateProcess(child);
		}, timeoutSeconds * 1000);
		const abort = () => terminateProcess(child);
		options.signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			rejectRun(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolveRun({
				exitCode: code,
				signal,
				timedOut,
				aborted: Boolean(options.signal?.aborted),
				outputTruncated,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
			});
		});
	});
}

async function readExternal(request) {
	if (request.directory) {
		const entries = (await readdir(request.target, { withFileTypes: true })).slice(0, 200);
		return {
			exitCode: 0,
			stdout: entries.map((entry) => `${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"} ${entry.name}`).join("\n"),
			stderr: "",
			outputTruncated: entries.length === 200,
		};
	}
	const targetStat = await stat(request.target);
	if (targetStat.size > MAX_READ_BYTES) throw new Error(`External file exceeds ${MAX_READ_BYTES} byte read limit`);
	const content = await readFile(request.target);
	if (content.includes(0)) throw new Error("Binary external files are not model-readable");
	return { exitCode: 0, stdout: content.toString("utf8"), stderr: "", outputTruncated: false };
}

export async function executeGrantedCapability(context, input, options = {}) {
	const { request, grant, alternatives } = await authorizeCapabilityRequest(context, input);
	if (!grant) {
		if (request.kind === "host-command" && alternatives.length > 0) {
			throw new Error(
				`An approved host-command prefix exists, but cwd=${request.cwd} does not match it. ` +
				`Retry action=command with one of the existing grantId values so its approved cwd is reused; ` +
				`do not switch to action=script or create a shell-wrapper grant. Candidates: ${commandGrantChoices(alternatives)}`,
			);
		}
		const hint = request.kind === "external-read"
			? `/boundary grant-read ${JSON.stringify(input.path)}`
			: request.kind === "ssh-target"
				? `/boundary trust-ssh ${request.target}`
				: request.kind === "host-command"
					? `/boundary ${context.wslVersion !== undefined ? "grant-command" : "trust-command"} ${(request.suggestedPrefix ?? request.argv).map((arg) => JSON.stringify(arg)).join(" ")}`
					: `/boundary grant-script ${JSON.stringify(input.path)} ${(request.args ?? []).map((arg) => JSON.stringify(arg)).join(" ")}`.trim();
		throw new Error(`Missing approved ${request.kind} capability. Ask the user to run: ${hint}`);
	}
	let result;
	if (request.kind === "external-read") {
		result = await readExternal(request);
	} else if (request.kind === "ssh-target") {
		const remoteCommand = String(input.remoteCommand ?? "").trim();
		if (!remoteCommand || remoteCommand.length > 32768 || remoteCommand.includes("\0")) throw new Error("SSH remoteCommand is required and must be bounded");
		const args = [
			"-o", "BatchMode=yes",
			"-o", "StrictHostKeyChecking=yes",
			"-o", "ConnectTimeout=15",
			...(request.port ? ["-p", String(request.port)] : []),
			request.destination,
			remoteCommand,
		];
		result = await runBoundedProcess(options.sshBin ?? process.env.PI_RESEARCH_SSH_BIN ?? "ssh", args, {
			cwd: context.projectRoot,
			timeoutSeconds: input.timeoutSeconds,
			signal: options.signal,
			onData: options.onData,
			env: options.env,
			wslVersion: context.wslVersion,
		});
	} else if (request.kind === "host-command") {
		result = await runBoundedProcess(request.argv[0], request.argv.slice(1), {
			cwd: request.cwd,
			timeoutSeconds: input.timeoutSeconds,
			signal: options.signal,
			onData: options.onData,
			env: options.env,
			wslVersion: context.wslVersion,
		});
	} else {
		if ((await sha256File(request.target)) !== grant.sha256) throw new Error("Approved project script changed; grant revoked by hash mismatch");
		result = await runBoundedProcess(request.target, request.args, {
			cwd: context.projectRoot,
			timeoutSeconds: input.timeoutSeconds,
			signal: options.signal,
			onData: options.onData,
			env: options.env,
			wslVersion: context.wslVersion,
		});
	}
	return { grantId: grant.id, kind: request.kind, target: request.target, ...result };
}
