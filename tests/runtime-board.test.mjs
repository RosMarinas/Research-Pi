import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildRuntimeBoardModel } from "../.pi/lib/runtime-board.mjs";
import { RuntimeBoardOverlay } from "../.pi/lib/runtime-board-ui.mjs";

function fixture() {
	const snapshot = {
		actors: [
			{ id: "user", kind: "user", label: "User", metadata: {} },
			{ id: "research-leader", kind: "leader", label: "Research Leader", metadata: {} },
			{ id: "codex:active:executor", kind: "codex", label: "qualification executor", metadata: { threadId: "thread-active" } },
			{ id: "codex:review:advisor", kind: "codex", label: "architecture reviewer", metadata: { threadId: "thread-review" } },
		],
		attachments: [{ actorId: "research-leader", sessionId: "session-current-12345678", branchAnchorId: "leaf-current", attachedAt: "2026-08-19T10:00:00Z" }],
		actions: [
			{ id: "action-old", actorId: "codex:review:advisor", status: "completed", label: "review old route", externalId: "codex-old", updatedAt: "2026-08-19T09:00:00Z" },
			{ id: "action-live", actorId: "codex:active:executor", status: "running", label: "run discriminating probe", externalId: "codex-live", updatedAt: "2026-08-19T10:01:00Z" },
		],
		messages: [
			{ id: "msg-queued", type: "ask", status: "queued", from: "codex:active:executor", to: "research-leader", body: "Choose the validity check", queuedAt: "2026-08-19T10:02:00Z" },
			{ id: "msg-delivered", type: "notify", status: "delivered", from: "user", to: "research-leader", body: "The target changed", deliveredAt: "2026-08-19T10:03:00Z" },
			{ id: "msg-consumed", type: "result", status: "consumed", from: "codex:review:advisor", to: "research-leader", body: "Old result", consumedAt: "2026-08-19T09:30:00Z" },
		],
		rotations: [
			{ id: "rotation-old", status: "completed", fromSessionId: "session-old", toSessionId: "session-current-12345678", reason: "context pressure", completedAt: "2026-08-19T09:55:00Z" },
			{ id: "rotation-pending", status: "pending", fromSessionId: "session-current-12345678", reason: "manual handoff", requestedAt: "2026-08-19T10:04:00Z" },
		],
	};
	const view = {
		projectRevision: 5,
		stateRevision: 4,
		freshness: "stale",
		freshnessReasons: ["A research transition is newer than compacted state."],
		git: { branch: "codex/runtime-next", commit: "abcdef123456", dirty: true },
		state: {
			researchQuestion: "Does the old surface qualify?",
			currentClaim: "The old route may qualify.",
			nextExperiment: { question: "Repeat the old assay" },
		},
		activeTransition: {
			from: "old surface",
			to: "new mechanism surface",
			nextDecision: "Run the new discriminating probe",
		},
		transitionSupersedesState: true,
		experiments: [{ id: "E-7", validityJudgment: "valid", question: "Probe new surface", conclusion: "Intervention occurred" }],
	};
	const health = {
		active: 1,
		waiting: 0,
		unknown: 0,
		ready: false,
		blockers: ["1 Project revision has not reached structured state"],
		recommendation: "continue-then-compact",
		reason: "Let active work settle, then refresh state.",
		tokens: 120_000,
		contextWindow: 384_000,
		percent: 31.25,
		compactions: 1,
		memoryLag: 1,
	};
	return {
		runtime: { projectKey: "project-deadbeef", workspaceRoot: "/tmp/EmbeddingWorld" },
		snapshot,
		view,
		health,
		sessionId: "session-current-12345678",
	};
}

function plainTheme() {
	return {
		fg(_color, text) { return text; },
		bold(text) { return text; },
	};
}

test("Runtime Board is a bounded projection and does not revive superseded research state", () => {
	const input = fixture();
	const before = JSON.stringify(input);
	const model = buildRuntimeBoardModel(input);

	assert.equal(JSON.stringify(input), before);
	assert.equal(model.project.name, "EmbeddingWorld");
	assert.equal(model.project.freshness, "stale");
	assert.equal(model.research.question, "new mechanism surface");
	assert.equal(model.research.claim, "");
	assert.equal(model.research.previousClaim, "The old route may qualify.");
	assert.equal(model.research.nextStep, "Run the new discriminating probe");
	assert.match(model.actors[0].target, /^@codex:[a-f0-9]{8}$/);
	assert.equal(model.actors[0].label, "qualification executor");
	assert.equal(model.actors[0].state, "running");
	assert.deepEqual(model.openMessages.map((message) => message.id), ["msg-delivered", "msg-queued"]);
	assert.equal(model.counts.openMessages, 2);
	assert.equal(model.leader.isCurrentSessionAttached, true);
	assert.equal(model.leader.inheritancePolicy, "project");
	assert.deepEqual(model.rotations.map((rotation) => rotation.id), ["rotation-pending", "rotation-old"]);
});

test("Runtime Board makes clean Session isolation visible", () => {
	const model = buildRuntimeBoardModel({ ...fixture(), inheritancePolicy: "clean" });
	assert.equal(model.leader.inheritancePolicy, "clean");
	const overlay = new RuntimeBoardOverlay({ requestRender() {} }, plainTheme(), () => {}, model, async () => model);
	overlay.handleInput("4");
	assert.match(overlay.render(78).join("\n"), /clean context/);
});

test("Runtime Board renders within terminal width and exposes keyboard sections without polling", async () => {
	const model = buildRuntimeBoardModel(fixture());
	let renders = 0;
	let reloads = 0;
	let result;
	const tui = { requestRender() { renders += 1; } };
	const overlay = new RuntimeBoardOverlay(tui, plainTheme(), (value) => { result = value; }, model, async () => {
		reloads += 1;
		return { ...model, generatedAt: "2026-08-19T11:00:00Z" };
	});

	const overview = overlay.render(78);
	assert.ok(overview.every((line) => visibleWidth(line) <= 78));
	assert.match(overview.join("\n"), /Research Runtime \/ Project Board/);
	assert.match(overview.join("\n"), /new mechanism surface/);
	assert.equal(reloads, 0);
	const narrow = overlay.render(40);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 40));
	assert.ok(narrow.length < 30, "dashboard rows should stay bounded on a small terminal");
	for (const section of ["1", "2", "3", "4"]) {
		overlay.handleInput(section);
		assert.ok(overlay.render(78).length <= 22, `section ${section} must fit a 24-row terminal at 92% overlay height`);
	}

	overlay.handleInput("2");
	const actors = overlay.render(78).join("\n");
	assert.match(actors, /Stable Project Actors/);
	assert.match(actors, /qualification executor/);
	assert.ok(renders > 0);
	await overlay.refresh();
	assert.equal(reloads, 1);
	overlay.handleInput("v");
	assert.equal(result, "view");

	let watchResult;
	const watchOverlay = new RuntimeBoardOverlay(tui, plainTheme(), (value) => { watchResult = value; }, model, async () => model);
	watchOverlay.handleInput("2");
	watchOverlay.handleInput("\r");
	assert.deepEqual(watchResult, { action: "watch", selector: model.actors[0].target });
});

test("Runtime Board keeps mailbox counts exact while bounding visible rows", () => {
	const input = fixture();
	for (let index = 0; index < 9; index += 1) {
		input.snapshot.messages.push({
			id: `msg-extra-${index}`,
			type: "notify",
			status: "queued",
			from: "user",
			to: "research-leader",
			body: `extra ${index}`,
			queuedAt: "2026-08-19T10:05:00Z",
		});
		input.snapshot.rotations.push({
			id: `rotation-extra-${index}`,
			status: "completed",
			fromSessionId: `session-${index}`,
			toSessionId: `session-${index + 1}`,
			reason: `handoff ${index} with a deliberately descriptive reason`,
			completedAt: "2026-08-19T10:06:00Z",
		});
	}
	const model = buildRuntimeBoardModel(input);
	assert.equal(model.counts.openMessages, 11);
	assert.equal(model.openMessages.length, 8);

	const overlay = new RuntimeBoardOverlay({ requestRender() {} }, plainTheme(), () => {}, model, async () => model);
	overlay.handleInput("3");
	assert.match(overlay.render(78).join("\n"), /… 6 more · use \/inbox/);
	overlay.handleInput("4");
	const sessions = overlay.render(40);
	assert.ok(sessions.length <= 22, "Session history must fit the 92% overlay height on a 24-row terminal");
	assert.match(sessions.join("\n"), /earlier/);
});
