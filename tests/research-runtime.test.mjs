import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import researchRuntimeExtension, {
	actorLines,
	codexRuntimeMessageMarkdown,
	codexRuntimeMessagePreview,
	formatRuntimeHealth,
	formatRuntimeStatus,
	runtimeHealth,
	runtimeActorSummary,
	runtimeRotationReadiness,
} from "../.pi/extensions/research-runtime.ts";
import {
	RESEARCH_LEADER_ACTOR_ID,
	RUNTIME_MESSAGE_KIND,
	RUNTIME_SESSION_POLICY_ENTRY_KIND,
	attachRuntimeActor,
	appendRuntimeEventAtRevision,
	claimRuntimeActorAttachment,
	codexActorId,
	consumeRuntimeMessageForAttachment,
	createRuntimeMessage,
	detachRuntimeActor,
	initializeResearchRuntime,
	pendingRuntimeMessages,
	readRuntimeSnapshot,
	recordResearchTransition,
	recordCodexRuntimeEvent,
	requestRuntimeSessionRotation,
	requestRuntimeSessionInheritance,
	resolveResearchRuntime,
	resolveRuntimeActor,
	runtimeActorAttachment,
	runtimeActorTarget,
	runtimeSessionInheritancePolicy,
	settleRuntimeMessage,
	settleRuntimeActorActivation,
	settleRuntimeSessionRotation,
	settleRuntimeSessionInheritance,
	startRuntimeActorActivation,
	upsertRuntimeAction,
	unconsumedRuntimeMessages,
	withRuntimeActorAttachment,
} from "../.pi/lib/research-runtime.mjs";

test("Codex Runtime result cards preserve Markdown structure when expanded", () => {
	const content = [
		"[Research Runtime result msg-1 from codex:mission-demo:advisor]",
		"Codex delegation codex-demo completed.",
		"Mode/model: advisor · gpt-5.6-sol · max",
		"Mission: review-design",
		"Summary: 总判断暂不冻结。",
		"",
		"1. 第一条论证。",
		"2. 第二条论证。",
		"Evidence:",
		"- observation A",
		"- observation B",
		"Uncertainties:",
		"- limitation C",
		"Recommended next step: run probe D",
		"Use codex_delegate action=result with jobId=codex-demo if the full structured result is needed.",
	].join("\n");
	assert.equal(codexRuntimeMessagePreview(content), "总判断暂不冻结。 1. 第一条论证。 2. 第二条论证。");
	const markdown = codexRuntimeMessageMarkdown(content);
	assert.match(markdown, /^## Summary/m);
	assert.match(markdown, /\n1\. 第一条论证。\n2\. 第二条论证。/);
	assert.match(markdown, /^## Evidence/m);
	assert.match(markdown, /^## Uncertainties/m);
	assert.match(markdown, /^## Recommended next step/m);
	assert.match(markdown, /^> Use codex_delegate/m);
});

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
	assert.equal(health.memoryStatus, "stale");
	assert.equal(health.recommendation, "compact");
	assert.match(health.reason, /newer than structured state/);
});

test("lifecycle health never labels absent Project State as current memory", () => {
	const snapshot = { revision: 0, actors: [], attachments: [], messages: [], actions: [] };
	const health = runtimeHealth(snapshot, { tokens: 10_000, contextWindow: 1_000_000, percent: 1 }, []);
	assert.equal(health.memoryStatus, "missing");
	assert.match(formatRuntimeHealth(health), /Project memory: missing/);
});

test("clean Session health does not recommend an incompatible Project rotation", () => {
	const health = runtimeHealth({
		projectState: { revision: 1, state: {}, source: {} },
		revision: 1,
		actors: [],
		attachments: [],
		messages: [],
		actions: [],
	}, { tokens: 10_000, contextWindow: 384_000, percent: 2.6 }, [], "clean");
	assert.equal(health.ready, false);
	assert.match(health.blockers[0], /clean context/);
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

test("Runtime message and Action terminal states cannot regress under delayed cross-session events", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-monotonic-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const message = await createRuntimeMessage(runtime, {
			id: "message-monotonic",
			type: "notify",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "one delivery only",
		});
		await settleRuntimeMessage(runtime, message.id, "delivered", { sessionId: "session-a" });
		await settleRuntimeMessage(runtime, message.id, "consumed", { sessionId: "session-a" });
		await settleRuntimeMessage(runtime, message.id, "delivered", { sessionId: "session-b" });

		await upsertRuntimeAction(runtime, { id: "action-terminal", status: "running" });
		await upsertRuntimeAction(runtime, { id: "action-terminal", status: "completed" });
		await upsertRuntimeAction(runtime, { id: "action-terminal", status: "running" });
		await upsertRuntimeAction(runtime, { id: "action-unknown", status: "outcome_unknown" });
		await upsertRuntimeAction(runtime, { id: "action-unknown", status: "completed" });

		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.messages.find((item) => item.id === message.id)?.status, "consumed");
		assert.equal(snapshot.actions.find((item) => item.id === "action-terminal")?.status, "completed");
		assert.equal(snapshot.actions.find((item) => item.id === "action-unknown")?.status, "completed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Runtime repairs only a partial final ledger record and keeps prior semantic events", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-tail-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const eventsBefore = (await readRuntimeSnapshot(runtime)).actors.length;
		appendFileSync(runtime.ledgerPath, "{\"partial\":", "utf8");
		assert.equal((await readRuntimeSnapshot(runtime)).actors.length, eventsBefore);
		await createRuntimeMessage(runtime, {
			id: "message-after-tail-repair",
			type: "notify",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "ledger remains writable",
		});
		const text = readFileSync(runtime.ledgerPath, "utf8");
		assert.doesNotMatch(text, /\{"partial":/);
		assert.equal((await readRuntimeSnapshot(runtime)).messages.at(-1)?.id, "message-after-tail-repair");

		appendFileSync(runtime.ledgerPath, JSON.stringify({
			version: 1,
			id: "valid-unterminated-tail",
			type: "diagnostic.fixture",
			at: new Date().toISOString(),
			projectKey: runtime.projectKey,
			data: {},
		}), "utf8");
		await createRuntimeMessage(runtime, {
			id: "message-after-valid-tail",
			type: "notify",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "valid final JSON is preserved and newline-normalized",
		});
		const normalizedLines = readFileSync(runtime.ledgerPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
		assert.ok(normalizedLines.some((event) => event.id === "valid-unterminated-tail"));
		assert.ok(normalizedLines.some((event) => event.data?.id === "message-after-valid-tail"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Actor attachment and activation events are idempotent and carry an ownership epoch", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-activation-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a", branchAnchorId: "leaf-a" }, { runtimeRoot: join(root, "runtime") });
		const first = (await readRuntimeSnapshot(runtime)).attachments[0];
		const linesBefore = readFileSync(runtime.ledgerPath, "utf8").trim().split(/\r?\n/).length;
		const repeated = await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: "session-a", branchAnchorId: "leaf-a" });
		await detachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, "another-session");
		assert.equal(repeated.epoch, first.epoch);
		assert.equal(readFileSync(runtime.ledgerPath, "utf8").trim().split(/\r?\n/).length, linesBefore);
		const replaced = await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: "session-a", branchAnchorId: "leaf-new" });
		await detachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, "session-a", first.epoch);
		assert.equal(runtimeActorAttachment(await readRuntimeSnapshot(runtime), RESEARCH_LEADER_ACTOR_ID)?.epoch, replaced.epoch);

		const activation = await startRuntimeActorActivation(runtime, RESEARCH_LEADER_ACTOR_ID, {
			sessionId: "session-a",
			attachmentEpoch: replaced.epoch,
		});
		assert.equal((await readRuntimeSnapshot(runtime)).activeActivations[0].attachmentEpoch, replaced.epoch);
		await settleRuntimeActorActivation(runtime, activation.id);
		assert.equal((await readRuntimeSnapshot(runtime)).activeActivations.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Leader activation and attachment claim serialize into one valid owner", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-claim-race-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a", branchAnchorId: "leaf-a" }, { runtimeRoot: join(root, "runtime") });
		const attachmentA = (await readRuntimeSnapshot(runtime)).attachments[0];
		const [activationResult, claimResult] = await Promise.allSettled([
			startRuntimeActorActivation(runtime, RESEARCH_LEADER_ACTOR_ID, {
				id: "activation-race-a",
				sessionId: "session-a",
				attachmentEpoch: attachmentA.epoch,
			}),
			claimRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, {
				sessionId: "session-b",
				branchAnchorId: "leaf-b",
			}, { force: false }),
		]);
		const snapshot = await readRuntimeSnapshot(runtime);
		const current = runtimeActorAttachment(snapshot, RESEARCH_LEADER_ACTOR_ID);
		const activeForCurrent = snapshot.activeActivations.filter((activation) =>
			activation.sessionId === current.sessionId
			&& activation.attachmentEpoch === current.epoch,
		);
		assert.ok(
			(activationResult.status === "fulfilled" && claimResult.status === "fulfilled" && claimResult.value.status === "busy" && current.sessionId === "session-a" && activeForCurrent.length === 1)
			|| (activationResult.status === "rejected" && claimResult.status === "fulfilled" && claimResult.value.status === "attached" && current.sessionId === "session-b" && activeForCurrent.length === 0),
			JSON.stringify({ activationResult, claimResult, current, activeForCurrent }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

test("Runtime Session inheritance receipts are durable and terminal", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-inheritance-ledger-"));
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a" }, { runtimeRoot: join(root, "runtime") });
		const request = await requestRuntimeSessionInheritance(runtime, {
			id: "inheritance-clean-test",
			policy: "clean",
			fromSessionId: "session-a",
			fromSessionFile: join(root, "session-a.jsonl"),
			reason: "test clean replacement",
		});
		await settleRuntimeSessionInheritance(runtime, request.id, "applied", { toSessionId: "session-b" });
		await settleRuntimeSessionInheritance(runtime, request.id, "cancelled", { reason: "late stale cancellation" });
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.inheritanceRequests[0].status, "applied");
		assert.equal(runtimeSessionInheritancePolicy([], snapshot, "session-b"), "clean");
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

test("/runtime new clean starts without transcript, ProjectView, mailbox, or Project State writes until explicit inherit", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-clean-session-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		const oldSessionFile = join(root, "session-old.jsonl");
		const newSessionFile = join(root, "session-clean.jsonl");
		mkdirSync(workspace, { recursive: true });
		const handlers = new Map();
		const commands = new Map();
		const notices = [];
		const sent = [];
		const newBranch = [];
		let replacementOptions;
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, command) { commands.set(name, command); },
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage(message, options) { sent.push({ message, options }); },
			appendEntry(customType, data) {
				newBranch.push({ type: "custom", id: `entry-${newBranch.length}`, customType, data });
			},
		};
		researchRuntimeExtension(pi);
		const baseContext = (sessionId, sessionFile, branch, allowNewSession = false) => ({
			cwd: workspace,
			hasUI: true,
			ui: { setStatus() {}, notify(message) { notices.push(message); }, setEditorText() {} },
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => sessionFile,
				getLeafId: () => `leaf-${sessionId}`,
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 8_000, contextWindow: 384_000, percent: 2.1 }),
			isIdle: () => true,
			abort() {},
			waitForIdle: async () => {},
			...(allowNewSession ? {
				newSession: async (options) => {
					replacementOptions = options;
					return { cancelled: false };
				},
			} : {}),
		});

		const oldContext = baseContext("session-old", oldSessionFile, [], true);
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, oldContext);
		const runtime = await resolveResearchRuntime(workspace);
		await appendRuntimeEventAtRevision(runtime, "project.state.committed", {
			state: {
				researchQuestion: "Project question must stay outside clean context",
				currentClaim: "Project claim",
				hypotheses: [], observations: [], decisions: [], unresolvedConfounders: [], openQuestions: [],
				nextExperiment: { question: "Project experiment", intervention: "Project intervention", distinguishingOutcomes: [], validityChecks: [] },
				criticalContext: [],
			},
			source: { sessionId: "session-old", entryId: "compact-old", trackRef: "project:initial" },
		}, 0, { id: "project-state:clean-session-test" });

		await commands.get("runtime").handler("new clean challenge the project framing independently", oldContext);
		assert.equal(replacementOptions.parentSession, undefined, "clean Session must not fork the old transcript");
		let snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.pendingInheritanceRequests.length, 1);
		assert.equal(snapshot.pendingInheritanceRequests[0].policy, "clean");

		await handlers.get("session_shutdown")({ type: "session_shutdown" }, oldContext);
		const mailbox = await createRuntimeMessage(runtime, {
			id: "message-held-during-clean-session",
			type: "notify",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "This must remain queued until Project inheritance returns.",
		});
		const cleanContext = baseContext("session-clean", newSessionFile, newBranch);
		await handlers.get("session_start")({ type: "session_start", reason: "new", previousSessionFile: oldSessionFile }, cleanContext);
		snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.pendingInheritanceRequests.length, 0);
		assert.equal(snapshot.inheritanceRequests[0].status, "applied");
		assert.equal(runtimeSessionInheritancePolicy([], snapshot, "session-clean"), "clean");
		assert.equal(sent.length, 0, "clean Session startup must not deliver Runtime mailbox messages");
		assert.ok(notices.some((message) => /Clean Runtime Session/.test(message)));

		const isolated = await handlers.get("context")({
			type: "context",
			messages: [
				{ role: "custom", customType: "research-project-view", content: "stale ProjectView" },
				{ role: "custom", customType: RUNTIME_MESSAGE_KIND, content: "stale Runtime message" },
				{ role: "user", content: "independent question" },
			],
		}, cleanContext);
		assert.deepEqual(isolated.messages, [{ role: "user", content: "independent question" }]);
		await handlers.get("session_compact")({ type: "session_compact", compactionEntry: { type: "compaction", id: "clean-compact" } }, cleanContext);
		assert.equal((await readRuntimeSnapshot(runtime)).revision, 1, "clean Session compaction must not replace Project State");

		await replacementOptions.setup({
			appendCustomEntry(customType, data) {
				newBranch.push({ type: "custom", id: `entry-${newBranch.length}`, customType, data });
			},
		});
		assert.equal(runtimeSessionInheritancePolicy(newBranch), "clean");
		await commands.get("runtime").handler("inherit accept current project memory", cleanContext);
		assert.equal(runtimeSessionInheritancePolicy(newBranch), "project");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.details.messageId, mailbox.id);
		assert.equal(sent[0].options.triggerTurn, false);
		const inherited = await handlers.get("context")({ type: "context", messages: [{ role: "user", content: "continue" }] }, cleanContext);
		assert.match(String(inherited.messages.find((message) => message.customType === "research-project-view")?.content), /Project question must stay outside clean context/);
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
		await commands.get("runtime").handler("health", ctx);
		await commands.get("runtime").handler("recommend", ctx);
		await commands.get("runtime").handler("view", ctx);
		await commands.get("actors").handler("all", ctx);
		await commands.get("inbox").handler("all", ctx);
		assert.equal(customCalls, 1);
		assert.equal((await readRuntimeSnapshot(runtime)).attachments.find((item) => item.actorId === RESEARCH_LEADER_ACTOR_ID)?.sessionId, "session-b");
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("an active Leader Session blocks silent takeover but explicit takeover advances the attachment epoch", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-takeover-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a", branchAnchorId: "leaf-a" });
		const attachmentA = (await readRuntimeSnapshot(runtime)).attachments[0];
		const message = await createRuntimeMessage(runtime, {
			id: "message-takeover-redelivery",
			type: "notify",
			from: "user",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "must follow the current attachment",
		});
		await settleRuntimeMessage(runtime, message.id, "delivered", {
			sessionId: "session-a",
			actorId: RESEARCH_LEADER_ACTOR_ID,
			attachmentEpoch: attachmentA.epoch,
		});
		await startRuntimeActorActivation(runtime, RESEARCH_LEADER_ACTOR_ID, {
			sessionId: "session-a",
			attachmentEpoch: attachmentA.epoch,
		});

		const handlers = new Map();
		const commands = new Map();
		const notices = [];
		const sent = [];
		let restoredEditor = "";
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, command) { commands.set(name, command); },
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage(payload) { sent.push(payload); },
			appendEntry() {},
		};
		researchRuntimeExtension(pi);
		const ctx = {
			cwd: workspace,
			hasUI: true,
			ui: {
				setStatus() {},
				notify(message) { notices.push(message); },
				setEditorText(text) { restoredEditor = text; },
			},
			sessionManager: {
				getSessionId: () => "session-b",
				getLeafId: () => "leaf-b",
				getBranch: () => [],
			},
			getContextUsage: () => ({ tokens: 0, contextWindow: 384_000, percent: 0 }),
			isIdle: () => true,
			abort() {},
		};

		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		assert.equal((await readRuntimeSnapshot(runtime)).attachments[0].sessionId, "session-a");
		const blocked = await handlers.get("input")({ type: "input", text: "do not lose this prompt", source: "interactive" }, ctx);
		assert.deepEqual(blocked, { action: "handled" });
		assert.equal(restoredEditor, "do not lose this prompt");
		assert.match(notices.at(-1), /active in Session/);

		await commands.get("runtime").handler("takeover explicit user takeover for a stalled Session", ctx);
		const attachmentB = (await readRuntimeSnapshot(runtime)).attachments[0];
		assert.equal(attachmentB.sessionId, "session-b");
		assert.notEqual(attachmentB.epoch, attachmentA.epoch);
		assert.ok(sent.some((payload) => payload.details?.messageId === message.id));
		assert.equal((await readRuntimeSnapshot(runtime)).messages.find((item) => item.id === message.id)?.attachmentEpoch, attachmentB.epoch);
		assert.equal((await consumeRuntimeMessageForAttachment(runtime, message.id, {
			sessionId: "session-a",
			actorId: RESEARCH_LEADER_ACTOR_ID,
			attachmentEpoch: attachmentA.epoch,
		})).status, "stale_attachment");
		assert.equal((await readRuntimeSnapshot(runtime)).messages.find((item) => item.id === message.id)?.status, "delivered");
		await assert.rejects(
			withRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, {
				sessionId: "session-a",
				attachmentEpoch: attachmentA.epoch,
			}, async () => "must not run"),
			/attachment changed/,
		);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a cross-session research transition refreshes ProjectView at the next model boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-runtime-boundary-refresh-"));
	const previousRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const handlers = new Map();
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage() {},
			appendEntry() {},
		};
		researchRuntimeExtension(pi);
		const ctx = {
			cwd: workspace,
			hasUI: true,
			ui: { setStatus() {}, notify() {} },
			sessionManager: {
				getSessionId: () => "session-a",
				getLeafId: () => "leaf-a",
				getBranch: () => [],
			},
			getContextUsage: () => null,
			isIdle: () => false,
			abort() {},
		};
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const runtime = await resolveResearchRuntime(workspace);
		await recordResearchTransition(runtime, {
			id: "transition-safe-boundary",
			from: "route A",
			to: "route B",
			reason: "another Session changed the accepted research direction",
			oldDisposition: "superseded",
			authorityRefs: ["user-decision:safe-boundary"],
		});
		const result = await handlers.get("context")({ type: "context", messages: [{ role: "user", content: "continue" }] }, ctx);
		const projectView = result.messages.find((message) => message.customType === "research-project-view");
		assert.match(String(projectView?.content), /Active research track: route B/);

		await upsertRuntimeAction(runtime, {
			id: "cross-session-action",
			actorId: "research-leader",
			status: "running",
			label: "route B diagnostic",
		});
		const activityResult = await handlers.get("context")({ type: "context", messages: [{ role: "user", content: "continue again" }] }, ctx);
		const refreshedView = activityResult.messages.find((message) => message.customType === "research-project-view");
		assert.match(String(refreshedView?.content), /cross-session-action \[running\]/);
	} finally {
		if (previousRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
