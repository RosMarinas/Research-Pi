import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
