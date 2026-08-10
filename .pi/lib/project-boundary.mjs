import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROJECT_BOUNDARY_PROFILE = "research_pi_project";
export const CODEX_EXECUTOR_PROFILE = "research_pi_executor";
export const CODEX_ADVISOR_PROFILE = "research_pi_advisor";

const SECRET_ENVIRONMENT_PATTERN = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;
const DIRECT_PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

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
	return name === ".env" || name.startsWith(".env.") || rel === ".pi/agent/auth.json";
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
		'".pi/agent/auth.json" = "deny"',
		'".git/hooks" = "read"',
	].join(", ");
}

function temporaryDenyRules() {
	const paths = new Set(["/tmp", "/private/tmp", tmpdir()]);
	if (tmpdir().startsWith("/var/")) paths.add(`/private${tmpdir()}`);
	return [...paths].map((path) => `${JSON.stringify(path)} = "deny"`).join(", ");
}

function gitRules(workspaceRoot, access) {
	if (!workspaceRoot) return "";
	const gitPath = join(workspaceRoot, ".git");
	if (!existsSync(gitPath)) return "";
	const writableGitPaths = [
		gitPath,
		join(gitPath, "COMMIT_EDITMSG"),
		join(gitPath, "FETCH_HEAD"),
		join(gitPath, "HEAD"),
		join(gitPath, "HEAD.lock"),
		join(gitPath, "MERGE_HEAD"),
		join(gitPath, "ORIG_HEAD"),
		join(gitPath, "config"),
		join(gitPath, "config.lock"),
		join(gitPath, "index"),
		join(gitPath, "index.lock"),
		join(gitPath, "logs"),
		join(gitPath, "modules"),
		join(gitPath, "objects"),
		join(gitPath, "packed-refs"),
		join(gitPath, "packed-refs.lock"),
		join(gitPath, "refs"),
		join(gitPath, "research-pi"),
		join(gitPath, "rr-cache"),
		join(gitPath, "worktrees"),
	];
	return [
		...writableGitPaths.map((path) => `${JSON.stringify(path)} = "${access}"`),
		`${JSON.stringify(join(gitPath, "hooks"))} = "read"`,
	].join(", ");
}

function filesystemBaseRules(workspaceRoot, access) {
	return [
		"glob_scan_max_depth = 4",
		'":root" = "deny"',
		'":minimal" = "read"',
		temporaryDenyRules(),
		gitRules(workspaceRoot, access),
	]
		.filter(Boolean)
		.join(", ");
}

export function permissionProfileDefinition({ access = "write", workspaceRoot } = {}) {
	if (access !== "read" && access !== "write") throw new Error(`Unsupported project access: ${access}`);
	return [
		"{",
		`description = "Research Pi project ${access} access boundary",`,
		workspaceRoot ? `workspace_roots = { ${JSON.stringify(workspaceRoot)} = true },` : undefined,
		"filesystem = {",
		`${filesystemBaseRules(workspaceRoot, access)},`,
		`":workspace_roots" = { ${workspaceRules(access)} }`,
		"},",
		'network = { enabled = true, allow_local_binding = true, domains = { "*" = "allow" } }',
		"}",
	]
		.filter(Boolean)
		.join(" ");
}

export function codexPermissionConfigArguments(mode, workspaceRoot, runtimeTmp, gitIdentity) {
	const advisor = mode === "advisor";
	const profile = advisor ? CODEX_ADVISOR_PROFILE : CODEX_EXECUTOR_PROFILE;
	const access = advisor ? "read" : "write";
	return [
		"-c",
		`default_permissions=${JSON.stringify(profile)}`,
		"-c",
		`permissions.${profile}=${permissionProfileDefinition({ access, workspaceRoot })}`,
		"-c",
		'shell_environment_policy.inherit="core"',
		"-c",
		"shell_environment_policy.ignore_default_excludes=false",
		...(runtimeTmp
			? [
					"-c",
					`shell_environment_policy.set={ TMPDIR=${JSON.stringify(runtimeTmp)}, TMP=${JSON.stringify(runtimeTmp)}, TEMP=${JSON.stringify(runtimeTmp)}, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1"${gitIdentity ? `, GIT_AUTHOR_NAME=${JSON.stringify(gitIdentity.name)}, GIT_AUTHOR_EMAIL=${JSON.stringify(gitIdentity.email)}, GIT_COMMITTER_NAME=${JSON.stringify(gitIdentity.name)}, GIT_COMMITTER_EMAIL=${JSON.stringify(gitIdentity.email)}` : ""} }`,
				]
			: []),
	];
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
			if (entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env."))) found.add(path);
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

export function buildSandboxRuntimeConfig(root, environment = process.env) {
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
		join(root, ".pi", "agent", "auth.json"),
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
			strictAllowlist: false,
			allowLocalBinding: true,
		},
		filesystem: {
			denyRead: [...deniedRegions, ...sensitive],
			allowRead: [root, ...macOSXcrunCachePaths()],
			allowWrite: [root, ...macOSXcrunCachePaths()],
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
