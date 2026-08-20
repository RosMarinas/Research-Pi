import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	capabilityGrantSummary,
	createCapabilityGrant,
	executeGrantedCapability,
	hostBridgeEnvironment,
	isForbiddenCredentialRead,
	listCapabilityGrants,
	prepareCapabilityRequest,
	resolveCapabilityContext,
	revokeCapabilityGrant,
} from "../.pi/lib/host-capabilities.mjs";

function fixture(prefix) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	return { root, project, outside, stateRoot: join(root, "capability-state") };
}

test("one-shot external reads are exact, bounded, and consumed", async () => {
	const paths = fixture("research-pi-cap-read-");
	try {
		const context = await resolveCapabilityContext(paths.project, "session-read", { stateRoot: paths.stateRoot });
		const readable = join(paths.outside, "notes.txt");
		const sibling = join(paths.outside, "other.txt");
		writeFileSync(readable, "synthetic external note\n");
		writeFileSync(sibling, "must not leak\n");
		const request = await prepareCapabilityRequest(context, { kind: "external-read", path: readable });
		await createCapabilityGrant(context, request, "once");

		const result = await executeGrantedCapability(context, { kind: "external-read", path: readable });
		assert.equal(result.stdout, "synthetic external note\n");
		assert.equal((await listCapabilityGrants(context)).length, 0);
		await assert.rejects(
			executeGrantedCapability(context, { kind: "external-read", path: sibling }),
			/Missing approved external-read capability/,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("credential files cannot become model-readable capabilities", async () => {
	assert.equal(isForbiddenCredentialRead(join(homedir(), ".ssh", "config")), false);
	assert.equal(isForbiddenCredentialRead(join(homedir(), ".ssh", "known_hosts")), false);
	assert.equal(isForbiddenCredentialRead(join(homedir(), ".ssh", "id_ed25519")), true);
	assert.equal(isForbiddenCredentialRead(join(homedir(), ".aws", "credentials")), true);
	assert.equal(isForbiddenCredentialRead("/tmp/example.pem"), true);

	const paths = fixture("research-pi-cap-secret-");
	try {
		const context = await resolveCapabilityContext(paths.project, "session-secret", { stateRoot: paths.stateRoot });
		const key = join(paths.outside, "private.key");
		const disguisedKey = join(paths.outside, "notes.txt");
		writeFileSync(key, "synthetic-private-key");
		writeFileSync(disguisedKey, "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n");
		await assert.rejects(
			prepareCapabilityRequest(context, { kind: "external-read", path: key }),
			/Credential material cannot be made model-readable/,
		);
		await assert.rejects(
			prepareCapabilityRequest(context, { kind: "external-read", path: disguisedKey }),
			/Private-key content cannot be made model-readable/,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("SSH grants use opaque host credentials and exact targets", async () => {
	const paths = fixture("research-pi-cap-ssh-");
	try {
		const context = await resolveCapabilityContext(paths.project, "session-ssh", { stateRoot: paths.stateRoot });
		const fakeSsh = join(paths.root, "fake-ssh.mjs");
		writeFileSync(
			fakeSsh,
			`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  sshAgent: process.env.SSH_AUTH_SOCK ?? null,
  leakedApiKey: process.env.DEEPSEEK_API_KEY ?? null
}));
`,
			{ mode: 0o700 },
		);
		chmodSync(fakeSsh, 0o700);
		const request = await prepareCapabilityRequest(context, { kind: "ssh-target", target: "research@lab.example:2222" });
		await createCapabilityGrant(context, request, "session");
		const result = await executeGrantedCapability(
			context,
			{ kind: "ssh-target", target: "research@lab.example:2222", remoteCommand: "printf remote_ok" },
			{
				sshBin: fakeSsh,
				env: {
					PATH: process.env.PATH,
					HOME: paths.root,
					SSH_AUTH_SOCK: "/private/opaque-agent.sock",
					DEEPSEEK_API_KEY: "must-not-leak",
				},
			},
		);
		assert.equal(result.exitCode, 0);
		const observed = JSON.parse(result.stdout);
		assert.equal(observed.sshAgent, "/private/opaque-agent.sock");
		assert.equal(observed.leakedApiKey, null);
		assert.deepEqual(observed.argv.slice(-2), ["research@lab.example", "printf remote_ok"]);
		assert.ok(observed.argv.includes("2222"));
		await assert.rejects(
			executeGrantedCapability(context, { kind: "ssh-target", target: "other.example", remoteCommand: "true" }, { sshBin: fakeSsh }),
			/Missing approved ssh-target capability/,
		);
		const ledgerText = readFileSync(context.ledgerPath, "utf8");
		assert.doesNotMatch(ledgerText, /opaque-agent|must-not-leak/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("project-trusted SSH targets are reused automatically across Pi sessions", async () => {
	const paths = fixture("research-pi-cap-ssh-project-");
	try {
		const firstContext = await resolveCapabilityContext(paths.project, "session-first", { stateRoot: paths.stateRoot });
		const secondContext = await resolveCapabilityContext(paths.project, "session-second", { stateRoot: paths.stateRoot });
		const fakeSsh = join(paths.root, "fake-project-ssh.mjs");
		writeFileSync(fakeSsh, "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(-2).join(' '));\n", { mode: 0o700 });
		chmodSync(fakeSsh, 0o700);

		const request = await prepareCapabilityRequest(firstContext, { kind: "ssh-target", target: "lab.example" });
		const grant = await createCapabilityGrant(firstContext, request, "project");
		assert.equal(grant.scope, "project");
		assert.equal(readFileSync(firstContext.projectLedgerPath, "utf8").includes("session-first"), false);

		const result = await executeGrantedCapability(
			secondContext,
			{ kind: "ssh-target", target: "lab.example", remoteCommand: "hostname" },
			{ sshBin: fakeSsh, env: { PATH: process.env.PATH, HOME: paths.root } },
		);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /lab\.example hostname/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("project host-command prefixes support uv-style runners and non-executable scripts", async () => {
	const paths = fixture("research-pi-cap-command-");
	try {
		const firstContext = await resolveCapabilityContext(paths.project, "session-command-first", { stateRoot: paths.stateRoot });
		const secondContext = await resolveCapabilityContext(paths.project, "session-command-second", { stateRoot: paths.stateRoot });
		const fakeBin = join(paths.root, "bin");
		mkdirSync(fakeBin);
		const fakeUv = join(fakeBin, "uv");
		writeFileSync(
			fakeUv,
			"#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), secret: process.env.DEEPSEEK_API_KEY ?? null, uvCache: process.env.UV_CACHE_DIR ?? null }));\n",
			{ mode: 0o700 },
		);
		chmodSync(fakeUv, 0o700);
		writeFileSync(join(paths.project, "remote_run.py"), "print('not executed directly')\n", { mode: 0o600 });

		const request = await prepareCapabilityRequest(firstContext, {
			kind: "host-command",
			cwd: paths.project,
			argv: ["uv", "run", "remote_run.py", "bash", "experiment-a.sh"],
		});
		assert.deepEqual(request.suggestedPrefix, ["uv", "run", "remote_run.py"]);
		const grant = await createCapabilityGrant(firstContext, request, "project");
		assert.equal(grant.match, "prefix");
		assert.deepEqual(grant.argv, ["uv", "run", "remote_run.py"]);

		const result = await executeGrantedCapability(
			secondContext,
			{
				kind: "host-command",
				cwd: paths.project,
				argv: ["uv", "run", "remote_run.py", "bash", "experiment-b.sh"],
			},
			{
				env: {
					PATH: `${fakeBin}:${process.env.PATH}`,
					HOME: paths.root,
					UV_CACHE_DIR: join(paths.root, "uv-cache"),
					DEEPSEEK_API_KEY: "must-not-leak",
				},
			},
		);
		const observed = JSON.parse(result.stdout);
		assert.deepEqual(observed.argv, ["run", "remote_run.py", "bash", "experiment-b.sh"]);
		assert.equal(observed.secret, null);
		assert.equal(observed.uvCache, join(paths.root, "uv-cache"));

		await assert.rejects(
			executeGrantedCapability(secondContext, {
				kind: "host-command",
				cwd: paths.project,
				argv: ["uv", "run", "different.py"],
			}, { env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: paths.root } }),
			/Missing approved host-command capability/,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("project host-command grants restore their approved cwd by grant id or unique argv match", async () => {
	const paths = fixture("research-pi-cap-command-cwd-");
	try {
		const worktree = join(paths.project, ".worktrees", "experiment-a");
		mkdirSync(worktree, { recursive: true });
		const script = join(paths.project, "sync.sh");
		writeFileSync(script, "#!/bin/sh\nprintf '%s|%s' \"$PWD\" \"$1\"\n", { mode: 0o700 });
		chmodSync(script, 0o700);
		const firstContext = await resolveCapabilityContext(paths.project, "session-cwd-first", { stateRoot: paths.stateRoot });
		const secondContext = await resolveCapabilityContext(paths.project, "session-cwd-second", { stateRoot: paths.stateRoot });
		const request = await prepareCapabilityRequest(firstContext, {
			kind: "host-command",
			cwd: worktree,
			argv: [script, "--once"],
		});
		const grant = await createCapabilityGrant(firstContext, request, "project");
		assert.ok(capabilityGrantSummary(grant).includes(`cwd=${grant.cwd}`));

		const inferred = await executeGrantedCapability(secondContext, {
			kind: "host-command",
			argv: [script, "--dry-run"],
		});
		assert.equal(inferred.grantId, grant.id);
		assert.equal(inferred.stdout, `${grant.cwd}|--dry-run`);

		const explicit = await executeGrantedCapability(secondContext, {
			kind: "host-command",
			grantId: grant.id,
			argv: [script, "--once"],
		});
		assert.equal(explicit.grantId, grant.id);
		assert.equal(explicit.stdout, `${grant.cwd}|--once`);

		await assert.rejects(
			executeGrantedCapability(secondContext, {
				kind: "host-command",
				grantId: grant.id,
				cwd: paths.project,
				argv: [script, "--once"],
			}),
			/bound to cwd=/,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("omitted host-command cwd refuses to guess between worktree grants", async () => {
	const paths = fixture("research-pi-cap-command-ambiguous-");
	try {
		const worktreeA = join(paths.project, ".worktrees", "experiment-a");
		const worktreeB = join(paths.project, ".worktrees", "experiment-b");
		mkdirSync(worktreeA, { recursive: true });
		mkdirSync(worktreeB, { recursive: true });
		const script = join(paths.project, "sync.sh");
		writeFileSync(script, "#!/bin/sh\nprintf '%s' \"$PWD\"\n", { mode: 0o700 });
		chmodSync(script, 0o700);
		const context = await resolveCapabilityContext(paths.project, "session-cwd-ambiguous", { stateRoot: paths.stateRoot });
		const grantA = await createCapabilityGrant(
			context,
			await prepareCapabilityRequest(context, { kind: "host-command", cwd: worktreeA, argv: [script, "--once"] }),
			"project",
		);
		const grantB = await createCapabilityGrant(
			context,
			await prepareCapabilityRequest(context, { kind: "host-command", cwd: worktreeB, argv: [script, "--once"] }),
			"project",
		);

		await assert.rejects(
			executeGrantedCapability(context, { kind: "host-command", argv: [script, "--dry-run"] }),
			(error) => {
				assert.match(error.message, /Multiple approved host-command capabilities/);
				assert.match(error.message, new RegExp(grantA.id));
				assert.match(error.message, new RegExp(grantB.id));
				return true;
			},
		);
		const selected = await executeGrantedCapability(context, {
			kind: "host-command",
			grantId: grantB.id,
			argv: [script, "--dry-run"],
		});
		assert.equal(selected.stdout, grantB.cwd);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("code-string commands can be approved without granting a broader shell prefix", async () => {
	const paths = fixture("research-pi-cap-code-string-");
	try {
		const context = await resolveCapabilityContext(paths.project, "session-code-string", { stateRoot: paths.stateRoot });
		const argv = ["sh", "-c", "printf approved"];
		const request = await prepareCapabilityRequest(context, { kind: "host-command", cwd: paths.project, argv });
		assert.deepEqual(request.suggestedPrefix, argv);
		const pythonCode = ["python3", "-c", "print('approved')"];
		const pythonRequest = await prepareCapabilityRequest(context, {
			kind: "host-command",
			cwd: paths.project,
			argv: pythonCode,
		});
		assert.deepEqual(pythonRequest.suggestedPrefix, pythonCode);
		const grant = await createCapabilityGrant(context, request, "project");
		assert.deepEqual(grant.argv, argv);
		const result = await executeGrantedCapability(context, { kind: "host-command", cwd: paths.project, argv });
		assert.equal(result.stdout, "approved");
		await assert.rejects(
			executeGrantedCapability(context, {
				kind: "host-command",
				cwd: paths.project,
				argv: ["sh", "-c", "printf different"],
			}),
			/Missing approved host-command capability/,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("project-script grants pin both file hash and argv", async () => {
	const paths = fixture("research-pi-cap-script-");
	try {
		const context = await resolveCapabilityContext(paths.project, "session-script", { stateRoot: paths.stateRoot });
		const script = join(paths.project, "sync.sh");
		writeFileSync(script, "#!/bin/sh\nprintf 'sync:%s' \"$1\"\n", { mode: 0o700 });
		chmodSync(script, 0o700);
		const request = await prepareCapabilityRequest(context, { kind: "project-script", path: script, args: ["--once"] });
		assert.match(request.approvalPreview, /sync:/);
		const grant = await createCapabilityGrant(context, request, "session");
		assert.doesNotMatch(readFileSync(context.ledgerPath, "utf8"), /approvalPreview|printf 'sync/);
		const result = await executeGrantedCapability(context, { kind: "project-script", path: script, args: ["--once"] });
		assert.equal(result.stdout, "sync:--once");

		await assert.rejects(
			executeGrantedCapability(context, { kind: "project-script", path: script, args: ["--delete"] }),
			/Missing approved project-script capability/,
		);
		writeFileSync(script, "#!/bin/sh\nprintf changed\n", { mode: 0o700 });
		await assert.rejects(
			executeGrantedCapability(context, { kind: "project-script", path: script, args: ["--once"] }),
			/Missing approved project-script capability/,
		);
		assert.equal(await revokeCapabilityGrant(context, grant.id.slice(0, 14)), 1);
		assert.equal((await listCapabilityGrants(context)).length, 0);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("host bridge environment keeps only operational SSH state", () => {
	const env = hostBridgeEnvironment({
		PATH: "/bin",
		HOME: "/home/research",
		SSH_AUTH_SOCK: "/run/agent.sock",
		OPENAI_API_KEY: "secret",
		RUN_TOKEN: "secret-too",
		LC_ALL: "C.UTF-8",
	});
	assert.deepEqual(env, {
		PATH: "/bin",
		HOME: "/home/research",
		SSH_AUTH_SOCK: "/run/agent.sock",
		LC_ALL: "C.UTF-8",
	});
});
