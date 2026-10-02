import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collaborateWithCodexPeers, formatPeerMessage, readCodexPeerMessages } from "../.pi/lib/codex-collaboration.mjs";
import { resolveCodexWorkspaceIdentity } from "../.pi/lib/codex-jobs.mjs";
import { readRuntimeSnapshot, resolveResearchRuntime } from "../.pi/lib/research-runtime.mjs";
import { listCodexExternalRuns, registerCodexExternalRun, releaseCodexResources, reserveCodexResources, settleCodexExternalRun } from "../.pi/lib/codex-resources.mjs";

const id = (suffix) => `codex-2026-10-02T00-00-00-000Z-${suffix}`;
function save(jobRoot, job) {
	mkdirSync(join(jobRoot, job.id), { recursive: true });
	writeFileSync(join(jobRoot, job.id, "job.json"), JSON.stringify(job));
}

test("peer messages are directed, bounded, attributed by the host, and distinguish queueing from delivery", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-peers-"));
	try {
		const cwd = join(root, "project"); mkdirSync(cwd);
		const jobRoot = join(root, "jobs");
		const base = { ...await resolveCodexWorkspaceIdentity(cwd), mode: "executor", status: "running", workerPid: process.pid,
			createdAt: new Date().toISOString(), leaderActorId: "leader", researchTrackRef: "track:one", dynamicToolProtocolVersion: 2 };
		const source = { ...base, id: id("aaaaaaaa"), mission: "implementation", writeScope: ["src"] };
		const target = { ...base, id: id("bbbbbbbb"), mission: "tests", writeScope: ["tests"] };
		save(jobRoot, source); save(jobRoot, target);
		const peers = await collaborateWithCodexPeers(source.id, { action: "peers" }, { jobRoot });
		assert.deepEqual(peers.map((peer) => peer.jobId), [target.id]);
		const receipt = await collaborateWithCodexPeers(source.id, { action: "send", targetJobId: target.id, message: "Input is an array; output is a score." }, { jobRoot });
		assert.equal(receipt.status, "queued");
		const incoming = (await readCodexPeerMessages(target.id, { jobRoot })).incoming;
		assert.equal(incoming[0].fromJobId, source.id);
		assert.match(formatPeerMessage(incoming[0]), /not a Leader instruction/);
		assert.equal(incoming[0].status, "pending");
		const runtime = await resolveResearchRuntime(cwd, { runtimeRoot: join(jobRoot, "runtime") });
		const snapshot = await readRuntimeSnapshot(runtime);
		const message = snapshot.messages.find((item) => item.id === receipt.messageId);
		assert.equal(message.status, "queued");
		assert.equal(message.metadata.transport, "codex_peer");
		assert.equal(snapshot.actors.find((actor) => actor.id === message.from).metadata.latestJobId, source.id);
		assert.equal(snapshot.actors.find((actor) => actor.id === message.to).metadata.latestJobId, target.id);
		await assert.rejects(collaborateWithCodexPeers(source.id, { action: "send", targetJobId: target.id, message: "x".repeat(2001) }, { jobRoot }), /1–2000/);
		await assert.rejects(collaborateWithCodexPeers(source.id, { action: "send", targetJobId: source.id, message: "self" }, { jobRoot }), /another executor/);
		save(jobRoot, { ...target, status: "completed" });
		assert.equal((await readCodexPeerMessages(source.id, { jobRoot })).outgoing[0].status, "undelivered");
		await assert.rejects(collaborateWithCodexPeers(source.id, { action: "send", targetJobId: target.id, message: "late" }, { jobRoot }), /no longer active/);
		assert.deepEqual(readdirSync(cwd), [], "collaboration must not create project documents");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("peer communication cannot cross workspace, track, ownership, or read-only roles", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-peer-scope-"));
	try {
		const cwd = join(root, "project"); mkdirSync(cwd);
		const other = join(root, "other"); mkdirSync(other);
		const jobRoot = join(root, "jobs");
		const base = { ...await resolveCodexWorkspaceIdentity(cwd), mode: "executor", status: "running", workerPid: process.pid,
			createdAt: new Date().toISOString(), leaderActorId: "leader", researchTrackRef: "track:one", dynamicToolProtocolVersion: 2 };
		const source = { ...base, id: id("aaaaaaaa") }; save(jobRoot, source);
		for (const patch of [{ researchTrackRef: "track:two" }, { leaderActorId: "other" }, { mode: "advisor" }, await resolveCodexWorkspaceIdentity(other), { dynamicToolProtocolVersion: 1 }]) {
			const target = { ...base, id: id("bbbbbbbb"), ...patch }; save(jobRoot, target);
			await assert.rejects(collaborateWithCodexPeers(source.id, { action: "send", targetJobId: target.id, message: "hello" }, { jobRoot }), /same workspace|another workspace|older protocol/);
		}
		save(jobRoot, { ...source, mode: "advisor" });
		await assert.rejects(collaborateWithCodexPeers(source.id, { action: "peers" }, { jobRoot }), /active executor/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("resource admission is serialized across workspaces and remote runs retain claims after worker completion", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-resources-"));
	try {
		const jobRoot = join(root, "jobs");
		const a = id("aaaaaaaa"), b = id("bbbbbbbb");
		save(jobRoot, { id: a, status: "running", cwd: "project-a" });
		save(jobRoot, { id: b, status: "running", cwd: "project-b" });
		const claims = await Promise.allSettled([a, b].map((job) => reserveCodexResources(jobRoot, job, ["gpu:host-a:0"])));
		assert.equal(claims.filter((item) => item.status === "fulfilled").length, 1);
		const owner = claims[0].status === "fulfilled" ? a : b;
		const other = owner === a ? b : a;
		const run = await registerCodexExternalRun(jobRoot, owner, { externalId: "scheduler-42", target: "host-a", evidenceRefs: ["/runs/42/manifest.json"] });
		save(jobRoot, { id: owner, status: "completed" });
		await releaseCodexResources(jobRoot, owner);
		assert.equal((await listCodexExternalRuns(jobRoot, owner))[0].status, "running");
		await assert.rejects(reserveCodexResources(jobRoot, other, ["gpu:host-a:0"]), /Resource conflict/);
		await assert.rejects(settleCodexExternalRun(jobRoot, other, run.id, { status: "completed", note: "done" }), /does not belong/);
		await assert.rejects(settleCodexExternalRun(jobRoot, owner, run.id, { status: "completed" }), /evidence note/);
		await settleCodexExternalRun(jobRoot, owner, run.id, { status: "completed", note: "Inspected scheduler exit=0 and final manifest at /runs/42/manifest.json" });
		await reserveCodexResources(jobRoot, other, ["gpu:host-a:0"]);
		await assert.rejects(settleCodexExternalRun(jobRoot, owner, run.id, { status: "failed", note: "rewrite" }), /not overwritten/);
		const state = JSON.parse(readFileSync(join(root, "execution-resources.json"), "utf8"));
		assert.equal(state.runs[0].externalId, "scheduler-42");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown outcomes retain resources and external registrations cannot enlarge a reservation", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-unknown-resource-"));
	try {
		const jobRoot = join(root, "jobs"), a = id("aaaaaaaa"), b = id("bbbbbbbb");
		save(jobRoot, { id: a, status: "running" });
		await reserveCodexResources(jobRoot, a, ["gpu:host-a:0"]);
		await assert.rejects(registerCodexExternalRun(jobRoot, a, { externalId: "42", target: "host-a", evidenceRefs: ["run.log"], resources: ["gpu:host-a:1"] }), /undeclared resources/);
		save(jobRoot, { id: a, status: "outcome_unknown" });
		await releaseCodexResources(jobRoot, a);
		await assert.rejects(reserveCodexResources(jobRoot, b, ["gpu:host-a:0"]), /Resource conflict/);
		save(jobRoot, { id: a, status: "failed" });
		await releaseCodexResources(jobRoot, a);
		await reserveCodexResources(jobRoot, b, ["gpu:host-a:0"]);
		save(jobRoot, { id: b, status: "cancelled", sideEffect: { startedAt: new Date().toISOString(), state: "settled" } });
		await releaseCodexResources(jobRoot, b);
		await assert.rejects(reserveCodexResources(jobRoot, a, ["gpu:host-a:0"]), /Resource conflict/);
		await releaseCodexResources(jobRoot, b, { note: "Inspected host-a: no remaining process owns this GPU" });
		await reserveCodexResources(jobRoot, a, ["gpu:host-a:0"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
