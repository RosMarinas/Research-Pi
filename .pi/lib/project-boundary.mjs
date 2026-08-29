import { execFile } from "node:child_process";
import { constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { access, appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { normalizeSystemRuntimePolicy } from "./security-policy.mjs";

const execFileAsync = promisify(execFile);

export const PROJECT_BOUNDARY_PROFILE = "research_pi_project";
export const CODEX_EXECUTOR_PROFILE = "research_pi_executor";
export const CODEX_ADVISOR_PROFILE = "research_pi_advisor";
export const CODEX_FULL_ACCESS_PROFILE = "research_pi_full_access";

export function researchPiFullAccessEnabled(environment = process.env) {
	return environment.RESEARCH_PI_FULL_ACCESS === "1";
}

export function codexPermissionProfile(mode, options = {}) {
	if (mode !== "advisor" && options.fullAccess === true) return CODEX_FULL_ACCESS_PROFILE;
	return mode === "advisor" ? CODEX_ADVISOR_PROFILE : CODEX_EXECUTOR_PROFILE;
}

const SECRET_ENVIRONMENT_PATTERN = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;
const DIRECT_PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const ANALYSIS_REMOTE_READ_COMMANDS = new Set([
	"cat", "head", "tail", "grep", "rg", "find", "ls", "stat", "wc", "du", "df", "file",
	"readlink", "realpath", "pwd", "hostname", "uname", "date", "uptime", "whoami", "id", "ps",
	"pgrep", "jq", "sort", "uniq", "cut", "tr", "column", "journalctl", "squeue", "sacct", "sstat",
]);
const ANALYSIS_GIT_READ_SUBCOMMANDS = new Set([
	"status", "log", "show", "diff", "rev-parse", "ls-files", "ls-tree", "cat-file", "describe", "name-rev",
]);
export const CREDENTIAL_BASENAMES = Object.freeze([
	".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", "credentials.env",
]);
export const CREDENTIAL_RELATIVE_PATHS = Object.freeze([
	".pi/agent/auth.json", ".codex/auth.json", ".config/gh/hosts.yml",
	".config/research-pi/credentials.env", ".aws/credentials", ".docker/config.json",
]);
const REMOTE_CREDENTIAL_PATH_PATTERN = /(?:^|[\s'"/])(?:\.ssh|\.gnupg|\.aws|\.config\/gcloud|\.config\/gh|\.config\/research-pi|\.codex|\.docker|\.kube)(?:[\s'"/]|$)|(?:^|[\s'"/])(?:id_rsa|id_ed25519|auth\.json|credentials(?:\.json|\.env)?|\.env(?:\.[^\s/'"]*)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|hosts\.yml|[^\s/'"]+\.(?:pem|key|p12|pfx))(?:[\s'"/]|$)|\/proc\/(?:self|\d+)\/environ|\/etc\/(?:shadow|gshadow)/i;

function parseAnalysisShellWords(input) {
	const words = [];
	let current = "";
	let quote;
	let escaped = false;
	for (const character of String(input ?? "").trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (escaped || quote) return null;
	if (current) words.push(current);
	return words;
}

function splitAnalysisPipeline(input) {
	const parts = [];
	let current = "";
	let quote;
	let escaped = false;
	for (const character of String(input ?? "").trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			current += character;
			continue;
		}
		if (character === "|") {
			if (!current.trim()) return null;
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	if (escaped || quote || !current.trim()) return null;
	parts.push(current.trim());
	return parts;
}

function analysisGitReadOnly(words) {
	if (words.some((word) => word === "-o" || word === "--output" || word.startsWith("--output=") || word === "--ext-diff" || word === "--textconv")) return false;
	let index = 1;
	while (index < words.length) {
		const word = words[index];
		if (word === "-C") {
			index += 2;
			continue;
		}
		if (word === "--no-pager" || word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) {
			index += 1;
			continue;
		}
		if (word.startsWith("-")) return false;
		return ANALYSIS_GIT_READ_SUBCOMMANDS.has(word);
	}
	return false;
}

function analysisNvidiaSmiReadOnly(words) {
	if (words.length === 1) return true;
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index];
		if (word === "-L" || word === "--list-gpus" || word.startsWith("--query-") || word.startsWith("--format=")) continue;
		if (word === "-i" || word === "--id") {
			index += 1;
			if (index < words.length && /^[0-9,]+$/.test(words[index])) continue;
		}
		return false;
	}
	return true;
}

function isAnalysisReadOnlySshGrammar(command) {
	const text = String(command ?? "").trim();
	if (!text || text.length > 12_000) return false;
	if (/[\r\n;&<>`$(){}]/.test(text) || text.includes("||")) return false;
	const pipeline = splitAnalysisPipeline(text);
	if (!pipeline?.length) return false;
	return pipeline.every((part) => {
		const words = parseAnalysisShellWords(part);
		if (!words?.length) return false;
		// Auto-approval applies to the remote system command, not an arbitrary
		// project-local executable that happens to share an allow-listed basename.
		if (words[0].includes("/") || words[0].includes("\\")) return false;
		const commandName = basename(words[0]);
		if (commandName === "git") return analysisGitReadOnly(words);
		if (commandName === "nvidia-smi") return analysisNvidiaSmiReadOnly(words);
		if (commandName === "systemctl") return ["status", "show", "is-active", "is-enabled"].includes(words[1]);
		if (commandName === "journalctl" && words.some((word) => word === "--rotate" || word === "--flush" || word === "--sync" || word === "--relinquish-var" || word.startsWith("--vacuum-"))) return false;
		if (!ANALYSIS_REMOTE_READ_COMMANDS.has(commandName)) return false;
		if (commandName === "find" && words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(word))) return false;
		if (commandName === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre=") || word.startsWith("--pre-glob"))) return false;
		if (commandName === "sort" && words.some((word) => word === "-o" || word === "--output" || word.startsWith("--output="))) return false;
		return true;
	});
}

export function analysisSshCommandPolicy(command) {
	const text = String(command ?? "").trim();
	if (!text || text.length > 32_768 || text.includes("\0")) return "denied";
	if (REMOTE_CREDENTIAL_PATH_PATTERN.test(text)) return "denied";
	return isAnalysisReadOnlySshGrammar(text) ? "safe" : "approval_required";
}

export function isAnalysisReadOnlySshCommand(command) {
	return analysisSshCommandPolicy(command) === "safe";
}

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
	return path;
}

export function stripAtPrefix(path) {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function isWithinRoot(root, candidate) {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolveThroughExistingAncestor(path) {
	let cursor = path;
	const missing = [];
	while (true) {
		try {
			const existing = await realpath(cursor);
			return resolve(existing, ...missing.reverse());
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			missing.push(basename(cursor));
			cursor = parent;
		}
	}
}

export async function resolveBoundaryPath(root, input) {
	const canonicalRoot = await realpath(resolve(root));
	const cleaned = stripAtPrefix(String(input ?? "").trim());
	const lexicalPath = resolve(canonicalRoot, expandHome(cleaned || "."));
	const resolvedPath = await resolveThroughExistingAncestor(lexicalPath);
	return {
		input: String(input ?? ""),
		root: canonicalRoot,
		lexicalPath,
		resolvedPath,
		inside: isWithinRoot(canonicalRoot, resolvedPath),
		sensitive: isSensitiveProjectPath(canonicalRoot, resolvedPath),
	};
}

export function isSensitiveProjectPath(root, candidate) {
	if (!isWithinRoot(root, candidate)) return false;
	const rel = relative(root, candidate).split(sep).join("/");
	const name = basename(candidate);
	return (
		name === ".env"
		|| name.startsWith(".env.")
		|| CREDENTIAL_BASENAMES.includes(name.toLowerCase())
		|| CREDENTIAL_RELATIVE_PATHS.includes(rel)
	);
}

export function isProtectedProjectMutation(root, candidate) {
	if (!isWithinRoot(root, candidate)) return false;
	const rel = relative(root, candidate).split(sep).join("/");
	return rel === ".git/hooks" || rel.startsWith(".git/hooks/");
}

export function directToolPath(toolName, input) {
	if (!DIRECT_PATH_TOOLS.has(toolName)) return undefined;
	if (toolName === "grep" || toolName === "find" || toolName === "ls") return input?.path ?? ".";
	return input?.path;
}

export function boundaryWarning(info, operation, kindOverride) {
	const kind = kindOverride ?? (info.sensitive ? "受保护的项目凭据文件" : "项目边界外路径");
	return [
		`Research Pi 检测到 ${kind}，正在突破限制区。`,
		`操作：${operation}`,
		`请求路径：${info.lexicalPath}`,
		info.resolvedPath !== info.lexicalPath ? `真实路径：${info.resolvedPath}` : undefined,
		"只有本次明确操作可由人工批准；不要把批准扩展为持续权限。",
	]
		.filter(Boolean)
		.join("\n");
}

export function secretEnvironmentNames(source = process.env) {
	return Object.keys(source).filter(
		(name) =>
			SECRET_ENVIRONMENT_PATTERN.test(name) ||
			name === "DEEPSEEK_API_KEY" ||
			name === "PI_DEEPSEEK_API_KEY" ||
			name === "SSH_AUTH_SOCK" ||
			name === "PI_SESSION_FILE",
	);
}

export function sanitizeBoundaryEnvironment(source = process.env) {
	const env = { ...source };
	for (const name of secretEnvironmentNames(env)) delete env[name];
	return env;
}

function executableCandidates(command, environment, platform) {
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return [command];
	const pathEntries = String(environment.PATH ?? "").split(delimiter).filter(Boolean);
	if (platform !== "win32") return pathEntries.map((entry) => join(entry, command));
	const extensions = command.includes(".")
		? [""]
		: String(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	return pathEntries.flatMap((entry) => extensions.map((extension) => join(entry, `${command}${extension.toLowerCase()}`)));
}

export async function resolveExecutablePath(command, options = {}) {
	const requested = String(command ?? "").trim();
	if (!requested || requested.includes("\0")) throw new Error("Codex executable is empty or invalid");
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const cwd = options.cwd ?? process.cwd();
	for (const candidate of executableCandidates(requested, environment, platform)) {
		const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
		try {
			await access(absolute, platform === "win32" ? constants.F_OK : constants.X_OK);
			const canonical = await realpath(absolute);
			if (!(await stat(canonical)).isFile()) continue;
			return canonical;
		} catch {
			// Continue PATH resolution. The final error names the requested command
			// without leaking unrelated PATH entries into model-visible output.
		}
	}
	throw new Error(`Codex executable is unavailable or not executable: ${requested}`);
}

export async function readGitIdentity(cwd) {
	const readValue = async (key) => {
		try {
			const { stdout } = await execFileAsync("git", ["config", "--global", "--get", key], {
				cwd,
				env: sanitizeBoundaryEnvironment(process.env),
				timeout: 2000,
				maxBuffer: 2048,
			});
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	};
	const [name, email] = await Promise.all([readValue("user.name"), readValue("user.email")]);
	return name && email ? { name, email } : undefined;
}

function workspaceRules(access) {
	return [
		`"." = "${access}"`,
		'".env" = "deny"',
		'".env.*" = "deny"',
		'"**/.env" = "deny"',
		'"**/.env.*" = "deny"',
		...CREDENTIAL_BASENAMES.flatMap((name) => [`${JSON.stringify(name)} = "deny"`, `${JSON.stringify(`**/${name}`)} = "deny"`]),
		...CREDENTIAL_RELATIVE_PATHS.map((path) => `${JSON.stringify(path)} = "deny"`),
		'".git/hooks" = "read"',
	].join(", ");
}

function temporaryDenyRules() {
	const paths = new Set(["/tmp", "/private/tmp", tmpdir()]);
	if (tmpdir().startsWith("/var/")) paths.add(`/private${tmpdir()}`);
	return [...paths].map((path) => `${JSON.stringify(path)} = "deny"`).join(", ");
}

function gitMetadataRoots(workspaceRoot) {
	if (!workspaceRoot) return [];
	const gitPath = join(workspaceRoot, ".git");
	try {
		if (!existsSync(gitPath)) return [];
		if (statSync(gitPath).isDirectory()) return [gitPath];
		const pointer = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/im)?.[1];
		if (!pointer) return [];
		const gitDir = resolve(workspaceRoot, pointer);
		let commonDir = gitDir;
		const commonPointer = join(gitDir, "commondir");
		if (existsSync(commonPointer)) {
			const relativeCommon = readFileSync(commonPointer, "utf8").trim();
			if (relativeCommon) commonDir = resolve(gitDir, relativeCommon);
		}
		return [...new Set([gitDir, commonDir])];
	} catch {
		// A malformed or concurrently changing .git pointer must not prevent the
		// boundary extension from initializing; normal workspace rules still apply.
		return [];
	}
}

function gitRules(workspaceRoot, access) {
	const roots = gitMetadataRoots(workspaceRoot);
	if (!roots.length) return "";
	const writableGitPaths = roots.flatMap((gitPath) => [
		gitPath,
		...[
			"COMMIT_EDITMSG", "FETCH_HEAD", "HEAD", "HEAD.lock", "MERGE_HEAD", "ORIG_HEAD", "config", "config.lock",
			"index", "index.lock", "logs", "modules", "objects", "packed-refs", "packed-refs.lock", "refs", "research-pi", "rr-cache", "worktrees",
		].map((name) => join(gitPath, name)),
	]);
	return [
		...writableGitPaths.map((path) => `${JSON.stringify(path)} = "${access}"`),
		...roots.map((gitPath) => `${JSON.stringify(join(gitPath, "hooks"))} = "read"`),
	].join(", ");
}

function filesystemBaseRules(workspaceRoot, access, runtimePolicy) {
	const normalizedRuntime = normalizeSystemRuntimePolicy(runtimePolicy);
	const runtimeRules = [...new Set([...normalizedRuntime.readRoots, ...normalizedRuntime.instructionRoots])].map(
		(path) => `${JSON.stringify(path)} = "read"`,
	);
	return [
		"glob_scan_max_depth = 4",
		'":root" = "deny"',
		'":minimal" = "read"',
		...runtimeRules,
		temporaryDenyRules(),
		gitRules(workspaceRoot, access),
	]
		.filter(Boolean)
		.join(", ");
}

export function permissionProfileDefinition({ access = "write", workspaceRoot, runtimePolicy } = {}) {
	if (access !== "read" && access !== "write") throw new Error(`Unsupported project access: ${access}`);
	return [
		"{",
		`description = "Research Pi project ${access} access boundary",`,
		workspaceRoot ? `workspace_roots = { ${JSON.stringify(workspaceRoot)} = true },` : undefined,
		"filesystem = {",
		`${filesystemBaseRules(workspaceRoot, access, runtimePolicy)},`,
		`":workspace_roots" = { ${workspaceRules(access)} }`,
		"},",
		'network = { enabled = true, allow_local_binding = true, domains = { "*" = "allow" } }',
		"}",
	]
		.filter(Boolean)
		.join(" ");
}

export function fullAccessPermissionProfileDefinition() {
	return [
		"{",
		'description = "Research Pi explicit full host access",',
		'filesystem = { ":root" = "write" },',
		'network = { enabled = true, allow_local_binding = true, domains = { "*" = "allow" } }',
		"}",
	].join(" ");
}

export function codexPermissionConfigArguments(mode, workspaceRoot, runtimeTmp, gitIdentity, runtimePolicy, options = {}) {
	const advisor = mode === "advisor";
	const fullAccess = !advisor && options.fullAccess === true;
	const profile = codexPermissionProfile(mode, { fullAccess });
	const access = advisor ? "read" : "write";
	const normalizedRuntime = normalizeSystemRuntimePolicy(runtimePolicy);
	const shellEnvironment = {
		...normalizedRuntime.environment,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		...(runtimeTmp
			? {
					TMPDIR: runtimeTmp,
					TMP: runtimeTmp,
					TEMP: runtimeTmp,
					...(gitIdentity
						? {
								GIT_AUTHOR_NAME: gitIdentity.name,
								GIT_AUTHOR_EMAIL: gitIdentity.email,
								GIT_COMMITTER_NAME: gitIdentity.name,
								GIT_COMMITTER_EMAIL: gitIdentity.email,
							}
						: {}),
				}
			: {}),
	};
	const shellEnvironmentToml = Object.entries(shellEnvironment)
		.map(([name, value]) => `${name}=${JSON.stringify(value)}`)
		.join(", ");
	return [
		"-c",
		`default_permissions=${JSON.stringify(profile)}`,
		"-c",
		`permissions.${profile}=${fullAccess ? fullAccessPermissionProfileDefinition() : permissionProfileDefinition({ access, workspaceRoot, runtimePolicy: normalizedRuntime })}`,
		"-c",
		'shell_environment_policy.inherit="core"',
		"-c",
		"shell_environment_policy.ignore_default_excludes=false",
		...(shellEnvironmentToml
			? [
					"-c",
					`shell_environment_policy.set={ ${shellEnvironmentToml} }`,
				]
			: []),
	];
}

export async function runCodexSandboxPreflight(options) {
	const mode = options.mode === "advisor" ? "advisor" : "executor";
	const fullAccess = mode !== "advisor" && options.fullAccess === true;
	const profile = codexPermissionProfile(mode, { fullAccess });
	const cwd = resolve(options.cwd);
	const runtimePolicy = normalizeSystemRuntimePolicy(options.runtimePolicy);
	const permissionArgs = codexPermissionConfigArguments(
		mode,
		cwd,
		options.runtimeTmp,
		options.gitIdentity,
		runtimePolicy,
		{ fullAccess },
	);
	const commands = ["git --version >/dev/null"];
	if (existsSync(join(cwd, ".git"))) {
		commands.push("git status --porcelain=v1 --untracked-files=no >/dev/null");
	}
	if (!fullAccess && existsSync(join(cwd, ".env"))) {
		commands.push('if dd if=.env of=/dev/null bs=1 count=1 2>/dev/null; then echo "project .env became readable" >&2; exit 91; fi');
	}
	if (mode === "executor" && options.runtimeTmp) {
		commands.push(
			'probe="$TMPDIR/codex-permission-preflight-$$"',
			'trap \'rm -rf "$probe"\' EXIT',
			'mkdir -p "$probe"',
			'git init -q "$probe"',
			'printf "permission probe\\n" > "$probe/probe.txt"',
			'git -C "$probe" add probe.txt',
			'git -C "$probe" -c user.name="Research Pi Doctor" -c user.email="doctor@research-pi.invalid" commit -q -m "permission probe"',
		);
	}
	commands.push('if command -v python3 >/dev/null 2>&1; then python3 --version >/dev/null; fi');
	commands.push('printf "research-pi-codex-preflight=ok\\n"');
	const environment = {
		...sanitizeBoundaryEnvironment(options.environment ?? process.env),
		...runtimePolicy.environment,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
	};
	try {
		const codexBin = await resolveExecutablePath(options.codexBin ?? "codex", {
			cwd,
			environment,
		});
		const selfProbe = await execFileAsync(
			codexBin,
			[
				...permissionArgs,
				"sandbox",
				"-P",
				profile,
				"-C",
				cwd,
				codexBin,
				"--version",
			],
			{
				cwd,
				env: environment,
				timeout: options.timeoutMs ?? 20_000,
				maxBuffer: 64 * 1024,
			},
		);
		const { stdout, stderr } = await execFileAsync(
			codexBin,
			[
				...permissionArgs,
				"sandbox",
				"-P",
				profile,
				"-C",
				cwd,
				"/bin/sh",
				"-c",
				commands.join("\n"),
			],
			{
				cwd,
				env: environment,
				timeout: options.timeoutMs ?? 20_000,
				maxBuffer: 64 * 1024,
			},
		);
		return {
			ok: true,
			mode,
			profile,
			codexBin,
			codexVersion: selfProbe.stdout.trim(),
			stdout: stdout.trim(),
			stderr: [selfProbe.stderr, stderr].filter(Boolean).join("\n").trim(),
			runtimePolicy,
		};
	} catch (error) {
		const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n").slice(-12_000);
		throw new Error(`Codex ${mode} sandbox preflight failed before model execution:\n${detail}`, { cause: error });
	}
}

function canonicalTemporaryPaths() {
	const paths = new Set(["/tmp", "/private/tmp", "/var/tmp", tmpdir()]);
	if (tmpdir().startsWith("/var/")) paths.add(`/private${tmpdir()}`);
	return [...paths];
}

function macOSXcrunCachePaths() {
	if (process.platform !== "darwin") return [];
	const paths = new Set([`${tmpdir()}/xcrun_db`, `${tmpdir()}/xcrun_db-*`]);
	if (tmpdir().startsWith("/var/")) {
		paths.add(`/private${tmpdir()}/xcrun_db`);
		paths.add(`/private${tmpdir()}/xcrun_db-*`);
	}
	return [...paths];
}

function discoverSensitiveProjectPaths(root, maxDepth = 4) {
	const found = new Set();
	const visit = (directory, depth) => {
		if (depth > maxDepth) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isFile() && isSensitiveProjectPath(root, path)) found.add(path);
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if ([".git", "node_modules", ".pi/sessions", "data", "datasets"].includes(entry.name)) continue;
			visit(path, depth + 1);
		}
	};
	visit(root, 0);
	const agentAuth = join(root, ".pi", "agent", "auth.json");
	if (existsSync(agentAuth)) found.add(agentAuth);
	return [...found];
}

export function buildSandboxRuntimeConfig(root, environment = process.env, runtimePolicy, options = {}) {
	const normalizedRuntime = normalizeSystemRuntimePolicy(runtimePolicy);
	const access = options.access === "read" ? "read" : "write";
	const trustedReadRoots = [...new Set([...normalizedRuntime.readRoots, ...normalizedRuntime.instructionRoots])];
	const userParent = dirname(homedir());
	const deniedRegions = new Set([userParent, ...canonicalTemporaryPaths()]);
	if (process.platform === "darwin") deniedRegions.add("/Volumes");
	if (process.platform === "linux") {
		deniedRegions.add("/mnt");
		deniedRegions.add("/media");
	}
	const sensitive = [
		join(root, ".env"),
		join(root, ".env.*"),
		join(root, "**", ".env"),
		join(root, "**", ".env.*"),
		...CREDENTIAL_BASENAMES.flatMap((name) => [join(root, name), join(root, "**", name)]),
		...CREDENTIAL_RELATIVE_PATHS.map((path) => join(root, ...path.split("/"))),
		...discoverSensitiveProjectPaths(root),
	];
	const externalDefaultWrites = [
		"/tmp/claude",
		"/private/tmp/claude",
		join(homedir(), ".npm", "_logs"),
		join(homedir(), ".claude", "debug"),
	];
	return {
			network: {
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: access === "read",
			allowLocalBinding: true,
		},
		filesystem: {
			denyRead: [...deniedRegions, ...sensitive],
			allowRead: [root, ...trustedReadRoots, ...macOSXcrunCachePaths()],
			allowWrite: [
				...(access === "write" ? [root] : []),
				...(options.runtimeTmp ? [options.runtimeTmp] : []),
				...macOSXcrunCachePaths(),
			],
			denyWrite: [...externalDefaultWrites, ...sensitive],
			allowGitConfig: true,
		},
		credentials: {
			envVars: secretEnvironmentNames(environment).map((name) => ({ mode: "deny", name })),
		},
	};
}

async function usableRuntimeCandidate(root, candidate) {
	const info = await resolveBoundaryPath(root, candidate);
	if (!info.inside) return undefined;
	await mkdir(info.lexicalPath, { recursive: true, mode: 0o700 });
	const finalPath = await realpath(info.lexicalPath);
	return isWithinRoot(root, finalPath) ? finalPath : undefined;
}

export async function resolveProjectRoot(root) {
	let canonicalRoot = await realpath(resolve(root));
	let cursor = canonicalRoot;
	while (true) {
		try {
			await stat(join(cursor, ".git"));
			canonicalRoot = cursor;
			break;
		} catch {
			const parent = dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	}
	return canonicalRoot;
}

export async function prepareBoundaryRuntime(root) {
	const canonicalRoot = await resolveProjectRoot(root);
	let runtimeTmp;
	try {
		const gitDir = join(canonicalRoot, ".git");
		if ((await stat(gitDir)).isDirectory()) {
			runtimeTmp = await usableRuntimeCandidate(canonicalRoot, join(gitDir, "research-pi", "tmp"));
		}
	} catch {
		// Non-Git repositories use a project-local fallback below.
	}
	if (!runtimeTmp) {
		runtimeTmp = await usableRuntimeCandidate(canonicalRoot, join(canonicalRoot, ".pi", "research-pi-runtime", "tmp"));
	}
	if (!runtimeTmp) throw new Error("Could not create a project-local runtime directory without crossing the project boundary");

	return { root: canonicalRoot, runtimeTmp };
}

export function likelySandboxDenial(output) {
	return /(?:operation not permitted|permission denied|file-(?:read-data|write[^ ]*)|network-outbound)/i.test(output);
}

export async function ensureProjectLocalStateExcluded(root, options = {}) {
	const cwd = resolve(root);
	const environment = sanitizeBoundaryEnvironment(options.environment ?? process.env);
	try {
		await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			env: environment,
			timeout: 5000,
			maxBuffer: 4096,
		});
	} catch {
		return { status: "not-git", changed: false, path: null };
	}

	try {
		await execFileAsync("git", ["check-ignore", "-q", "--no-index", ".pi/research/experiments.jsonl"], {
			cwd,
			env: environment,
			timeout: 5000,
			maxBuffer: 4096,
		});
		return { status: "already-ignored", changed: false, path: null };
	} catch (error) {
		if (error?.code !== 1) throw error;
	}

	const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], {
		cwd,
		env: environment,
		timeout: 5000,
		maxBuffer: 4096,
	});
	const reportedPath = stdout.trim();
	if (!reportedPath) throw new Error("Git did not report an info/exclude path");
	const excludePath = isAbsolute(reportedPath) ? reportedPath : resolve(cwd, reportedPath);
	await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
	const current = await readFile(excludePath, "utf8").catch((error) => {
		if (error?.code === "ENOENT") return "";
		throw error;
	});
	if (current.split(/\r?\n/).some((line) => ["/.pi/", ".pi/", "/.pi", ".pi"].includes(line.trim()))) {
		return { status: "already-excluded", changed: false, path: excludePath };
	}
	const prefix = current && !current.endsWith("\n") ? "\n" : "";
	await appendFile(excludePath, `${prefix}# Research Pi local runtime state\n/.pi/\n`, { encoding: "utf8", mode: 0o600 });
	return { status: "added", changed: true, path: excludePath };
}
