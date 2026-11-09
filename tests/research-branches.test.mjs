import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
 initializeResearchRuntime, resolveResearchRuntime, createRuntimeResearchBranch, listResearchBranches,
 readRuntimeSnapshot, readRuntimeEvents, appendRuntimeEvent, appendRuntimeEventAtRevision,
 claimRuntimeActorAttachment, registerSubagentRuntimeJob, createRuntimeMessage,
 recordRuntimeEvidence, runtimeActorAttachment, runtimeScopeOptions, RESEARCH_LEADER_ACTOR_ID,
} from "../.pi/lib/research-runtime.mjs";
import { subagentBelongsToWorkspace, selectRuntimeSubagent } from "../.pi/lib/runtime-subagents.mjs";
import { assertCodexJobLeader, listCodexJobs } from "../.pi/lib/codex-jobs.mjs";
import { openMemoryIndex, syncMemoryIndex, searchMemory, readMemory } from "../.pi/lib/research-memory.mjs";
import { buildProjectView } from "../.pi/lib/project-view.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), "research-pi-branches-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const repo = join(root, "repo"), worktree = join(root, "other"), runtimeRoot = join(root, "runtime");
 await mkdir(repo); git(repo, "init", "-b", "main");
 git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
 git(repo, "worktree", "add", "-b", "other", worktree);
 return { root, repo, worktree, runtimeRoot };
}

test("linked worktrees have independent Leaders, revisions, evidence, actors and mailboxes", async t => {
 const { repo, worktree, runtimeRoot } = await fixture(t);
 const [a, b] = await Promise.all([
  initializeResearchRuntime(repo, { sessionId: "leader-a" }, { runtimeRoot }),
  initializeResearchRuntime(worktree, { sessionId: "leader-b" }, { runtimeRoot }),
 ]);
 assert.equal(a.projectKey, b.projectKey); assert.notEqual(a.branchId, b.branchId);
 assert.notEqual(a.ledgerPath, b.ledgerPath); assert.notEqual(a.scopeDir, b.scopeDir);
 await Promise.all([a,b].map((runtime, i) => registerSubagentRuntimeJob(runtime, {
  id: `job-${i}`, actorId: "pi:same-mission", backend: "pi", status: "running",
  branchId: runtime.branchId, projectKey: runtime.projectKey, workspaceKey: runtime.workspaceKey,
 })));
 await createRuntimeMessage(a, { from: "user", to: "research-leader", type: "notify", body: "a only" });
 await Promise.all([a,b].map((runtime, i) => recordRuntimeEvidence(runtime, {
  id: "same-experiment-id", question: `branch ${i}`, observation: "x".repeat(3500),
  contentFingerprint: `fingerprint-${i}`, source: { sessionId: `leader-${i ? "b" : "a"}` },
 })));
 const [sa, sb] = await Promise.all([readRuntimeSnapshot(a), readRuntimeSnapshot(b)]);
 assert.equal(runtimeActorAttachment(sa, RESEARCH_LEADER_ACTOR_ID).sessionId, "leader-a");
 assert.equal(runtimeActorAttachment(sb, RESEARCH_LEADER_ACTOR_ID).sessionId, "leader-b");
 assert.equal(sa.messages.length, 1); assert.equal(sb.messages.length, 0);
 assert.equal(sa.evidence[0].question, "branch 0"); assert.equal(sb.evidence[0].question, "branch 1");
 assert.equal(sa.evidence[0].observation.length, 3500);
 assert.equal(sa.revision, 1); assert.equal(sb.revision, 1);
 const result = await appendRuntimeEventAtRevision(a, "project.state.committed", { state: { researchQuestion: "a" } }, 1);
 assert.equal(result.status, "appended"); assert.equal((await readRuntimeSnapshot(b)).revision, 1);
 assert.equal((await listResearchBranches(a)).length, 2);
});

test("ordinary input cannot replace an idle Leader; explicit takeover fences stale writers", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const a = await initializeResearchRuntime(repo, { sessionId: "first" }, { runtimeRoot });
 const attachment = runtimeActorAttachment(await readRuntimeSnapshot(a), RESEARCH_LEADER_ACTOR_ID);
 assert.equal((await claimRuntimeActorAttachment(a, RESEARCH_LEADER_ACTOR_ID, { sessionId: "second" })).status, "occupied");
 await initializeResearchRuntime(repo, { sessionId: "second" }, { runtimeRoot });
 assert.equal(runtimeActorAttachment(await readRuntimeSnapshot(a), RESEARCH_LEADER_ACTOR_ID).sessionId, "first");
 await claimRuntimeActorAttachment(a, RESEARCH_LEADER_ACTOR_ID, { sessionId: "second" }, { force: true });
 const result = await appendRuntimeEventAtRevision(a, "project.state.committed", {}, 0,
  { expectedAttachment: { actorId: RESEARCH_LEADER_ACTOR_ID, sessionId: "first", attachmentEpoch: attachment.epoch } });
 assert.equal(result.status, "stale_attachment");
});

test("persisted identity survives broken/repaired Git metadata and branch renaming", async t => {
 const { repo, worktree, runtimeRoot } = await fixture(t);
 const a = await initializeResearchRuntime(worktree, { sessionId: "one" }, { runtimeRoot });
 const gitFile = join(worktree, ".git"), original = await readFile(gitFile, "utf8");
 await writeFile(gitFile, "gitdir: /nonexistent/research-pi-test\n");
 const broken = await resolveResearchRuntime(worktree, { runtimeRoot });
 assert.equal(broken.branchId, a.branchId); assert.equal(broken.projectKey, a.projectKey);
 await writeFile(gitFile, original); git(worktree, "branch", "-m", "renamed");
 const repaired = await resolveResearchRuntime(worktree, { runtimeRoot });
 assert.equal(repaired.branchId, a.branchId); assert.equal(repaired.projectKey, a.projectKey);
 assert.equal((await listResearchBranches(repaired))[0].branchId, a.branchId);
 assert.ok(git(repo, "branch", "--list", "renamed"));
});

test("concurrent initialization publishes one durable branch binding", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const runtimes = await Promise.all(Array.from({ length: 8 }, () => initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot })));
 assert.equal(new Set(runtimes.map(runtime => runtime.branchId)).size, 1);
 assert.equal((await listResearchBranches(runtimes[0])).length, 1);
 assert.equal((await readRuntimeSnapshot(runtimes[0])).attachments.length, 1);
});

test("legacy history stays in place; a fresh linked worktree can opt into isolation", async t => {
 const { repo, worktree, runtimeRoot } = await fixture(t);
 const legacy = await resolveResearchRuntime(repo, { runtimeRoot });
 await appendRuntimeEvent(legacy, "actor.attached", { actorId: "research-leader", sessionId: "legacy", workspaceKey: legacy.workspaceKey });
 const bytes = await readFile(legacy.ledgerPath, "utf8");
 const resumed = await initializeResearchRuntime(repo, { sessionId: "observer" }, { runtimeRoot });
 assert.equal(resumed.branchId, null);
 await assert.rejects(createRuntimeResearchBranch(repo, { runtimeRoot, name: "new" }), /legacy Runtime history/);
 // The two idempotent Actor registrations are allowed, ownership/history stay.
 assert.equal(runtimeActorAttachment(await readRuntimeSnapshot(resumed), RESEARCH_LEADER_ACTOR_ID).sessionId, "legacy");
 const before = await readFile(legacy.ledgerPath, "utf8");
 const other = await createRuntimeResearchBranch(worktree, { runtimeRoot, name: "independent" });
 assert.ok(other.branchId); assert.equal(await readFile(legacy.ledgerPath, "utf8"), before);
 assert.ok(before.startsWith(bytes));
 const pinned = await resolveResearchRuntime(worktree, runtimeScopeOptions({ runtimeRoot, projectKey: legacy.projectKey }));
 assert.equal(pinned.branchId, null); assert.equal(pinned.ledgerPath, legacy.ledgerPath);
});

test("branch envelopes and cache keys reject events from other branches", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const a = await initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot });
 await appendFile(a.ledgerPath, JSON.stringify({ id: "foreign", projectKey: a.projectKey, branchId: "branch-other", type: "evidence.recorded", data: { id: "bad" } }) + "\n");
 assert.equal((await readRuntimeSnapshot(a)).evidence.length, 0);
 assert.deepEqual(await readRuntimeEvents({ ...a, branchId: "branch-other" }), [
  { id: "foreign", projectKey: a.projectKey, branchId: "branch-other", type: "evidence.recorded", data: { id: "bad" } },
 ]);
 assert.equal((await readRuntimeSnapshot(a)).evidence.length, 0);
});

test("task registration, mission reuse and Codex control reject a different branch", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const a = await initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot });
 const job = { id: "job", actorId: "pi:mission", backend: "pi", role: "advisor", mission: "same",
  status: "completed", projectKey: a.projectKey, branchId: "branch-other", workspaceKey: a.workspaceKey };
 assert.equal(subagentBelongsToWorkspace(job, a), false);
 assert.equal(selectRuntimeSubagent([job], { runtime: a, backend: "pi", role: "advisor", mission: "same" }), null);
 await assert.rejects(registerSubagentRuntimeJob(a, job), /another research branch/);
 assert.throws(() => assertCodexJobLeader(job, { expectedResearchBranchId: a.branchId }), /another research branch/);
 assert.throws(() => assertCodexJobLeader({ ...job, branchId: null }, { expectedResearchBranchId: a.branchId }), /another research branch/);
});

test("listing branch tasks never reconciles or mutates another branch's jobs", async t => {
 const { root, repo, runtimeRoot } = await fixture(t);
 const runtime = await initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot });
 const jobRoot = join(root, "jobs"), id = "codex-2026-11-08T00-00-00-000Z-12345678";
 await mkdir(join(jobRoot, id), { recursive: true });
 const path = join(jobRoot, id, "job.json");
 const foreign = JSON.stringify({ id, status: "running", cwd: repo, projectKey: runtime.projectKey,
  branchId: "branch-other", workspaceKey: runtime.workspaceKey, workerPid: 2147483647, createdAt: "2020-01-01T00:00:00Z" });
 await writeFile(path, foreign);
 assert.deepEqual(await listCodexJobs({ jobRoot, cwd: repo, projectKey: runtime.projectKey, branchId: runtime.branchId }), []);
 assert.equal(await readFile(path, "utf8"), foreign);
});

test("branch evidence is idempotent, complete and requires its current Leader", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const a = await initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot });
 const evidence = { id: "experiment", question: "q", contentFingerprint: "same", source: { sessionId: "one" } };
 await recordRuntimeEvidence(a, evidence);
 assert.equal((await recordRuntimeEvidence(a, evidence)).duplicate, true);
 await assert.rejects(recordRuntimeEvidence(a, { ...evidence, contentFingerprint: "different" }), /idempotency conflict/);
 await assert.rejects(recordRuntimeEvidence(a, { ...evidence, source: { sessionId: "other" } }), /attachment changed/);
 assert.equal((await readRuntimeSnapshot(a)).revision, 1);
});

test("record_experiment uses one branch ledger and supports retries after Leader handoff", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const prior = process.env.RESEARCH_PI_RUNTIME_DIR;
 process.env.RESEARCH_PI_RUNTIME_DIR = runtimeRoot;
 t.after(() => { if (prior === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR; else process.env.RESEARCH_PI_RUNTIME_DIR = prior; });
 const a = await initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot });
 const { default: extension } = await import("../.pi/extensions/record-experiment.ts");
 let tool; const entries = [];
 extension({ registerTool: value => { tool = value; }, appendEntry: (...entry) => entries.push(entry),
  exec: async (_command, args, options) => ({ code: 0, stdout: git(options.cwd, ...args), stderr: "" }) });
 let currentSession = "one";
 const ctx = { cwd: repo, sessionManager: { getSessionId: () => currentSession, getSessionFile: () => undefined } };
 const params = { question: "Does the intervention help?", intervention: "A small comparison", observation: "No change",
  validityJudgment: "inconclusive", conclusion: "No update yet", idempotencyKey: "retry" };
 await tool.execute("call", params, undefined, undefined, ctx);
 assert.equal(entries.length, 1); assert.equal((await readRuntimeSnapshot(a)).evidence.length, 1);
 await assert.rejects(readFile(join(repo, ".pi", "research", "experiments.jsonl")), { code: "ENOENT" });
 await claimRuntimeActorAttachment(a, RESEARCH_LEADER_ACTOR_ID, { sessionId: "two" }, { force: true });
 currentSession = "two";
 assert.equal((await tool.execute("retry", params, undefined, undefined, ctx)).details.duplicateSkipped, true);
 assert.equal(entries.length, 1); assert.equal((await readRuntimeSnapshot(a)).revision, 1);
});

test("Session startup persists branch provenance and ordinary input leaves another Leader attached", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const prior = process.env.RESEARCH_PI_RUNTIME_DIR;
 process.env.RESEARCH_PI_RUNTIME_DIR = runtimeRoot;
 t.after(() => { if (prior === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR; else process.env.RESEARCH_PI_RUNTIME_DIR = prior; });
 const runtime = await initializeResearchRuntime(repo, { sessionId: "owner" }, { runtimeRoot });
 const { default: extension } = await import("../.pi/extensions/research-runtime.ts");
 const handlers = new Map(), entries = [];
 extension({ on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerCommand() {},
  registerMessageRenderer() {}, registerEntryRenderer() {}, appendEntry: (customType, data) => entries.push({ type: "custom", id: String(entries.length), customType, data }) });
 const ctx = { cwd: repo, hasUI: false, sessionManager: { getSessionId: () => "observer", getLeafId: () => null, getBranch: () => entries } };
 await handlers.get("session_start")({ reason: "resume" }, ctx);
 const binding = entries.find(entry => entry.customType === "research-runtime-branch");
 assert.equal(binding.data.branchId, runtime.branchId);
 assert.equal((await handlers.get("input")({ source: "interactive", text: "hello" }, ctx)).action, "handled");
 assert.equal(runtimeActorAttachment(await readRuntimeSnapshot(runtime), RESEARCH_LEADER_ACTOR_ID).sessionId, "owner");
 await handlers.get("session_shutdown")({}, ctx);
});

test("Session resume rejects another branch binding before writing any Runtime event", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const prior = process.env.RESEARCH_PI_RUNTIME_DIR;
 process.env.RESEARCH_PI_RUNTIME_DIR = runtimeRoot;
 t.after(() => { if (prior === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR; else process.env.RESEARCH_PI_RUNTIME_DIR = prior; });
 const runtime = await initializeResearchRuntime(repo, { sessionId: "owner" }, { runtimeRoot });
 const before = await readFile(runtime.ledgerPath, "utf8");
 const { default: extension } = await import("../.pi/extensions/research-runtime.ts");
 const handlers = new Map();
 extension({ on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerCommand() {},
  registerMessageRenderer() {}, registerEntryRenderer() {} });
 const ctx = { cwd: repo, hasUI: false, sessionManager: { getSessionId: () => "historical", getBranch: () => [
  { type: "custom", customType: "research-runtime-branch", data: { projectKey: runtime.projectKey, branchId: "branch-other" } },
 ] } };
 await assert.rejects(handlers.get("session_start")({ reason: "resume" }, ctx), /another research branch/);
 assert.equal(await readFile(runtime.ledgerPath, "utf8"), before);
});

test("Memory filters branch ownership before ranking and preserves explicit cross-branch provenance", async t => {
 const { root } = await fixture(t);
 const sessionDir = join(root, "sessions"); await mkdir(sessionDir);
 const session = (id, branchId, text) => [
  { type: "session", id, cwd: root },
  { type: "custom", id: "binding", customType: "research-runtime-branch", data: { projectKey: "project-test", branchId } },
  { type: "message", id: "entry", parentId: "binding", timestamp: "2026-11-08", message: { role: "user", content: text } },
 ].map(value => JSON.stringify(value)).join("\n") + "\n";
 await writeFile(join(sessionDir, "a.jsonl"), session("a", "branch-a", "marker observation in a"));
 await writeFile(join(sessionDir, "b.jsonl"), session("b", "branch-b", "marker observation in b"));
 await writeFile(join(sessionDir, "old.jsonl"), session("old", null, "marker legacy"));
 const db = openMemoryIndex(join(root, "memory.sqlite")); t.after(() => db.close());
 syncMemoryIndex(db, { sessionDir });
 const query = { query: "marker", currentCwd: root, currentProjectKey: "project-test", currentBranchId: "branch-a" };
 const hits = searchMemory(db, query);
 assert.equal(hits.length, 1); assert.equal(hits[0].sessionId, "a"); assert.equal(hits[0].projectKey, "project-test");
 assert.match(hits[0].ref, /B:branch-a/);
 assert.equal(searchMemory(db, { ...query, scope: "project" }).length, 3);
 assert.equal(readMemory(db, { projectKey: "project-test", branchId: "branch-a", sessionId: "b", entryId: "entry" }), undefined);
 const exact = readMemory(db, { projectKey: "project-test", branchId: "branch-b", sessionId: "b", entryId: "entry" });
 assert.equal(exact.branchId, "branch-b"); assert.match(exact.entries[0].text, /in b/);
});

test("branch views ignore copied worktree experiment ledgers", async t => {
 const { repo, runtimeRoot } = await fixture(t);
 const a = await initializeResearchRuntime(repo, { sessionId: "one" }, { runtimeRoot });
 const snapshot = await readRuntimeSnapshot(a);
 const view = buildProjectView({ runtime: a, snapshot, experiments: [{ id: "legacy", question: "copied record" }] });
 assert.equal(view.experiments.length, 0); assert.equal(view.branchId, a.branchId);
});

test("branch CLI reads and initializes only the requested temporary state", async t => {
 const { root, repo, worktree } = await fixture(t);
 const cli = fileURLToPath(new URL("../bin/pi.mjs", import.meta.url));
 const env = { ...process.env, RESEARCH_PI_STATE_DIR: join(root, "state"), RESEARCH_PI_RUNTIME_DIR: join(root, "state", "runtime", "projects") };
 const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, "branch", ...args, "--json"], { cwd: repo, env, encoding: "utf8" }));
 const before = run("status"); assert.equal(before.branchId, null);
 const a = run("init", "main-research");
 const b = run("init", "alternative", "--workspace", worktree);
 assert.equal(a.projectKey, b.projectKey); assert.notEqual(a.branchId, b.branchId);
 const overview = run("list"); assert.equal(overview.branches.length, 2);
 assert.equal(overview.branches.filter(branch => branch.current).length, 1);
});
