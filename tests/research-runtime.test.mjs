import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import researchRuntimeExtension, {
	actorLines,
	formatRuntimeStatus,
	runtimeHealth,
	runtimeActorSummary,
	runtimeRotationReadiness,
} from "../.pi/extensions/research-runtime.ts";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_MESSAGE_KIND,
	attachRuntimeActor,
	appendRuntimeEventAtRevision,
	codexActorId,
	createRuntimeMessage,
	detachRuntimeActor,
	initializeResearchRuntime,
	pendingRuntimeMessages,
	readRuntimeSnapshot,
	recordCodexRuntimeEvent,
	requestRuntimeSessionRotation,
	resolveResearchRuntime,
	resolveRuntimeActor,
	runtimeActorTarget,
	settleRuntimeMessage,
	settleRuntimeSessionRotation,
	unconsumedRuntimeMessages,
} from "../.pi/lib/research-runtime.mjs";

test("Runtime status reports live activation instead of historical Actor count", () => {
	const codexActors = Array.from({ length: 16 }, (_, index) => ({
		id: `codex:mission-${String(index).padStart(2, "0")}:executor`,
		kind: "codex",
		label: `mission-${index}`,
		metadata: { threadId: `thread-${index}` },
	}));
	const snapshot = {
		projectKey: "project-42beebda",
		actors: [
			{ id: "user", kind: "user", label: "User", metadata: {} },
			{ id: "research-leader", kind: "leader", label: "Research Leader", metadata: {} },
			...codexActors,
		],
		attachments: [],
		messages: [],
		actions: codexActors.map((actor, index) => ({
			id: `action-${index}`,
			actorId: actor.id,
			status: index === 0 ? "running" : "completed",
		})),
	};

	assert.deepEqual(runtimeActorSummary(snapshot), { active: 1, waiting: 0, registered: 18 });
	assert.equal(formatRuntimeStatus(snapshot.projectKey, snapshot), "Runtime 42beebda · 1 active");
	assert.doesNotMatch(formatRuntimeStatus(snapshot.projectKey, snapshot), /18 actors/);
	assert.match(actorLines(snapshot), /mission-0 · codex · active \(running\)/);
	assert.doesNotMatch(actorLines(snapshot), /mission-1/);
	assert.match(actorLines(snapshot, false), /18 registered/);
	assert.match(actorLines(snapshot, false), /mission-1 · codex · suspended \(completed\)/);
});

test("lifecycle health is observe-only and prioritizes ambiguous side effects", () => {
	const snapshot = {
		projectState: { state: {}, source: {} },
		actors: [],
		attachments: [],
		messages: [],
		actions: [{ id: "unknown", actorId: "codex:fixture", status: "outcome_unknown" }],
	};
	const health = runtimeHealth(snapshot, { tokens: 300_000, contextWindow: 1_000_000, percent: 30 }, [{ type: "compaction" }]);
	assert.equal(health.recommendation, "reconcile");
	assert.match(health.reason, /unknown/);
	assert.equal(snapshot.actions[0].status, "outcome_unknown");
});

test("lifecycle health exposes Project evidence that has not reached structured state", () => {
	const snapshot = {
		projectState: { revision: 1, state: {}, source: {} },
		revision: 2,
		actors: [],
		attachments: [],
		messages: [],
		actions: [],
	};
	const health = runtimeHealth(snapshot, { tokens: 10_000, contextWindow: 1_000_000, percent: 1 }, []);
	assert.equal(health.memoryLag, 1);
	assert.equal(health.recommendation, "compact");
	assert.match(health.reason, /newer than structured state/);
});

test("Session rotation readiness requires recoverable Project and Action state", () => {
	const ready = runtimeRotationReadiness({
		projectState: { revision: 3, state: {}, source: {} },
		revision: 3,
		actions: [{ id: "job-a", status: "running", externalId: "codex-a" }],
		messages: [{ id: "message-a", status: "delivered", to: RESEARCH_LEADER_ACTOR_ID }],
	});
	assert.equal(ready.ready, true);
	assert.deepEqual(ready.activeActionIds, ["job-a"]);
	assert.deepEqual(ready.openMessageIds, ["message-a"]);

	const blocked = runtimeRotationReadiness({
		projectState: { revision: 2, state: {}, source: {} },
		revision: 3,
		actions: [
			{ id: "unknown", status: "outcome_unknown", externalId: "codex-unknown" },
			{ id: "untracked", status: "running", externalId: null },
		],
		messages: [],
	});
	assert.equal(blocked.ready, false);
	assert.match(blocked.blockers.join(" "), /have not reached structured state/);
	assert.match(blocked.blockers.join(" "), /unknown/);
	assert.match(blocked.blockers.join(" "), /external identity/);
});

test("Project Runtime keeps Actor identity across session attachment and message settlement", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-"));
	try {
		const workspace = join(root, "workspace");
		const runtimeRoot = join(root, "runtime");
		mkdirSync(workspace, { recursive: true });
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a", branchAnchorId: "leaf-a" }, { runtimeRoot });
		let snapshot = await readRuntimeSnapshot(runtime);
		assert.deepEqual(snapshot.actors.map((actor) => actor.id).sort(), [RESEARCH_LEADER_ACTOR_ID, "user"]);
		assert.equal(snapshot.attachments.find((attachment) => attachment.actorId === RESEARCH_LEADER_ACTOR_ID)?.sessionId, "session-a");

		await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: "session-b", branchAnchorId: "leaf-b" });
		await detachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, "session-a");
		snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.attachments.find((attachment) => attachment.actorId === RESEARCH_LEADER_ACTOR_ID)?.sessionId, "session-b");

		const message = await createRuntimeMessage(runtime, {
			type: "ask",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "Which observation distinguishes H1 from H2?",
		});
		assert.equal(pendingRuntimeMessages(await readRuntimeSnapshot(runtime)).length, 1);
		await settleRuntimeMessage(runtime, message.id, "delivered", { actorId: RESEARCH_LEADER_ACTOR_ID, sessionId: "session-b" });
		await settleRuntimeMessage(runtime, message.id, "consumed", { actorId: RESEARCH_LEADER_ACTOR_ID, sessionId: "session-b" });
		snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.messages.find((candidate) => candidate.id === message.id)?.status, "consumed");
		assert.equal(pendingRuntimeMessages(snapshot).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("delivered but unconsumed messages remain recoverable across Leader Session rotation", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-redelivery-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const message = await createRuntimeMessage(runtime, {
			type: "result",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "Result awaiting a settled Leader turn",
		});
		await settleRuntimeMessage(runtime, message.id, "delivered", { sessionId: "session-a" });
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(pendingRuntimeMessages(snapshot).length, 0);
		assert.deepEqual(unconsumedRuntimeMessages(snapshot).map((item) => item.id), [message.id]);
		assert.equal(unconsumedRuntimeMessages(snapshot, { forSessionId: "session-a" }).length, 0);
		assert.deepEqual(unconsumedRuntimeMessages(snapshot, { forSessionId: "session-b" }).map((item) => item.id), [message.id]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Runtime Session rotation is durably requested and settled", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-rotation-ledger-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const rotation = await requestRuntimeSessionRotation(runtime, {
			fromSessionId: "session-a",
			fromSessionFile: join(root, "session-a.jsonl"),
			projectRevision: 4,
			stateRevision: 4,
			projectViewFingerprint: "view-a",
			projectViewFreshness: "current",
		});
		assert.equal((await readRuntimeSnapshot(runtime)).pendingRotations[0].id, rotation.id);
		await settleRuntimeSessionRotation(runtime, rotation.id, "completed", {
			toSessionId: "session-b",
			toSessionFile: join(root, "session-b.jsonl"),
			projectRevision: 4,
			projectViewFingerprint: "view-b",
			projectViewFreshness: "current",
		});
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.pendingRotations.length, 0);
		assert.equal(snapshot.rotations[0].status, "completed");
		assert.equal(snapshot.rotations[0].toSessionId, "session-b");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex mission and mode define stable Actors while job events remain idempotent", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-codex-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const executorActor = codexActorId({ mission: "R2 qualification", mode: "executor" });
		assert.equal(executorActor, codexActorId({ mission: "  R2   qualification ", mode: "executor" }));
		assert.notEqual(executorActor, codexActorId({ mission: "R2 qualification", mode: "advisor" }));

		const job = {
			id: "codex-2026-08-15-00000000",
			actorId: executorActor,
			actionId: "action:codex-2026-08-15-00000000",
			status: "input_required",
			mode: "executor",
			model: "gpt-5.6-sol",
			mission: "R2 qualification",
			missionKey: "mission-fixture",
			threadId: "thread-fixture",
			pendingRequest: { id: "request-fixture" },
		};
		const [first, second] = await Promise.all([
			recordCodexRuntimeEvent(runtime, job, "Choose the validity check."),
			recordCodexRuntimeEvent(runtime, job, "Choose the validity check."),
		]);
		assert.equal(first.id, second.id);
		const persistedEvents = readFileSync(runtime.ledgerPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
		assert.equal(persistedEvents.length, new Set(persistedEvents.map((event) => event.id)).size);
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.messages.filter((message) => message.id === first.id).length, 1);
		assert.equal(snapshot.actions.find((action) => action.externalId === job.id)?.status, "input_required");
		const actor = snapshot.actors.find((candidate) => candidate.id === executorActor);
		assert.equal(actor?.metadata.threadId, "thread-fixture");
		const stableTarget = runtimeActorTarget(actor);
		assert.match(stableTarget, /^codex:[a-f0-9]{8}$/);
		assert.equal(resolveRuntimeActor(snapshot, `@${stableTarget}`).id, executorActor);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Runtime steer is non-preemptive by default and leaves context after one settled run", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-extension-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const handlers = new Map();
		const commands = new Map();
		const sent = [];
		let aborts = 0;
		let idle = false;
		const pi = {
			on(name, handler) {
				handlers.set(name, handler);
			},
			registerCommand(name, command) {
				commands.set(name, command);
			},
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage(message, options) {
				sent.push({ message, options });
			},
			appendEntry() {},
		};
		researchRuntimeExtension(pi);
		const ctx = {
			cwd: workspace,
			hasUI: true,
			ui: { setStatus() {}, notify() {} },
			sessionManager: {
				getSessionId: () => "session-extension",
				getLeafId: () => "leaf-extension",
				getBranch: () => [],
			},
			getContextUsage: () => null,
			isIdle: () => idle,
			abort: () => {
				aborts += 1;
			},
		};

		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("steer").handler("@research-leader correct the current interpretation", ctx);
		assert.equal(aborts, 0);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "followUp");
		assert.equal(sent[0].message.customType, RUNTIME_MESSAGE_KIND);

		const agentMessage = { role: "custom", ...sent[0].message, timestamp: Date.now() };
		const firstContext = await handlers.get("context")({ type: "context", messages: [agentMessage] }, ctx);
		assert.equal(firstContext.messages.filter((message) => message.customType === RUNTIME_MESSAGE_KIND).length, 1);
		await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
		const laterContext = await handlers.get("context")({ type: "context", messages: [agentMessage] }, ctx);
		assert.equal(laterContext.messages.filter((message) => message.customType === RUNTIME_MESSAGE_KIND).length, 0);

		await commands.get("steer").handler("--preempt @research-leader urgent correction", ctx);
		assert.equal(aborts, 1);
		assert.equal(sent.at(-1).options.deliverAs, "followUp");
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("/runtime rotate creates a fresh Session and records a ProjectView receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-rotate-command-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		const oldSessionFile = join(root, "session-old.jsonl");
		const newSessionFile = join(root, "session-new.jsonl");
		mkdirSync(workspace, { recursive: true });
		const handlers = new Map();
		const commands = new Map();
		const notices = [];
		const sent = [];
		let replacementOptions;
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, command) { commands.set(name, command); },
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage(message, options) { sent.push({ message, options }); },
			appendEntry() {},
		};
		researchRuntimeExtension(pi);
		const baseContext = (sessionId, sessionFile) => ({
			cwd: workspace,
			hasUI: true,
			ui: { setStatus() {}, notify(message) { notices.push(message); } },
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => sessionFile,
				getLeafId: () => `leaf-${sessionId}`,
				getBranch: () => [],
			},
			getContextUsage: () => ({ tokens: 40_000, contextWindow: 384_000, percent: 10.4 }),
			isIdle: () => true,
			abort() {},
			waitForIdle: async () => {},
			newSession: async (options) => {
				replacementOptions = options;
				return { cancelled: false };
			},
		});
		const oldContext = baseContext("session-old", oldSessionFile);
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, oldContext);
		const runtime = await resolveResearchRuntime(workspace);
		await appendRuntimeEventAtRevision(runtime, "project.state.committed", {
			state: { researchIntent: "test durable Session rotation" },
			source: { sessionId: "session-old", entryId: "compact-old" },
		}, 0, { id: "project-state:rotation-test" });
		const openMessage = await createRuntimeMessage(runtime, {
			type: "notify",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "carry this unconsumed message into the replacement Session",
		});
		await settleRuntimeMessage(runtime, openMessage.id, "delivered", { sessionId: "session-old" });

		await commands.get("runtime").handler("rotate switch after compact", oldContext);
		assert.equal(replacementOptions.parentSession, oldSessionFile);
		let snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.pendingRotations.length, 1);
		assert.equal(snapshot.pendingRotations[0].reason, "switch after compact");

		await handlers.get("session_shutdown")({ type: "session_shutdown" }, oldContext);
		const newContext = baseContext("session-new", newSessionFile);
		await handlers.get("session_start")({ type: "session_start", reason: "new", previousSessionFile: oldSessionFile }, newContext);
		snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.pendingRotations.length, 0);
		assert.equal(snapshot.rotations[0].status, "completed");
		assert.equal(snapshot.rotations[0].toSessionId, "session-new");
		assert.match(snapshot.rotations[0].projectViewFingerprint, /^[a-f0-9]{20}$/);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.details.messageId, openMessage.id);
		assert.ok(notices.some((message) => /ProjectView r1 \(current\) is ready/.test(message)));
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("opening the Runtime Board does not steal the Leader attachment from another Session", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-board-observe-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const handlers = new Map();
		const commands = new Map();
		let customCalls = 0;
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, command) { commands.set(name, command); },
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage() {},
			appendEntry() {},
		};
		researchRuntimeExtension(pi);
		const ctx = {
			cwd: workspace,
			hasUI: true,
			ui: {
				setStatus() {},
				notify() {},
				setEditorText() {},
				async custom() {
					customCalls += 1;
					return "close";
				},
			},
			sessionManager: {
				getSessionId: () => "session-a",
				getLeafId: () => "leaf-a",
				getBranch: () => [],
			},
			getContextUsage: () => ({ tokens: 0, contextWindow: 384_000, percent: 0 }),
			isIdle: () => true,
			abort() {},
		};

		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const runtime = await resolveResearchRuntime(workspace);
		await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: "session-b", branchAnchorId: "leaf-b" });
		assert.equal((await readRuntimeSnapshot(runtime)).attachments.find((item) => item.actorId === RESEARCH_LEADER_ACTOR_ID)?.sessionId, "session-b");

		await commands.get("runtime").handler("", ctx);
		assert.equal(customCalls, 1);
		assert.equal((await readRuntimeSnapshot(runtime)).attachments.find((item) => item.actorId === RESEARCH_LEADER_ACTOR_ID)?.sessionId, "session-b");
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
