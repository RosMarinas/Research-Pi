import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createRuntimeHeartbeatClock,
	formatRuntimeHeartbeat,
	RUNTIME_HEARTBEAT_MS,
	RuntimeDockComponent,
	runtimeHeartbeatNeeded,
	runtimeDockVisible,
} from "../.pi/lib/runtime-dock-ui.mjs";

function theme() {
	return {
		fg(_color, text) { return text; },
		bold(text) { return text; },
	};
}

function model(overrides = {}) {
	return {
		project: { name: "EmbeddingWorld", freshness: "current", git: { branch: "main" }, ...overrides.project },
		research: { activeTrack: "H1-Q0", question: "", ...overrides.research },
		leader: { inheritancePolicy: "project", isCurrentSessionAttached: true, ...overrides.leader },
		counts: { active: 0, waiting: 0, unknown: 0, openMessages: 0, ...overrides.counts },
	};
}

test("Runtime Dock auto-hides healthy idle state and surfaces actionable state", () => {
	assert.equal(runtimeDockVisible(model(), "auto"), false);
	assert.equal(runtimeDockVisible(model({ project: { freshness: "missing" } }), "auto"), true);
	assert.equal(runtimeDockVisible(model(), "always"), true);
	assert.equal(runtimeDockVisible(model({ counts: { active: 1 } }), "off"), false);
});

test("Runtime heartbeat ticks once per second only while a worker can be active", () => {
	let callback;
	let scheduled = 0;
	let cancelled = 0;
	let ticks = 0;
	const handle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
	const clock = createRuntimeHeartbeatClock(() => { ticks += 1; }, {
		setInterval(next, intervalMs) {
			callback = next;
			scheduled += 1;
			assert.equal(intervalMs, RUNTIME_HEARTBEAT_MS);
			return handle;
		},
		clearInterval(value) {
			assert.equal(value, handle);
			cancelled += 1;
		},
	});

	assert.equal(runtimeHeartbeatNeeded([]), false);
	assert.equal(runtimeHeartbeatNeeded([{ status: "completed" }]), false);
	assert.equal(runtimeHeartbeatNeeded([{ status: "running" }]), true);
	assert.equal(runtimeHeartbeatNeeded([{ status: "input_required" }]), false);
	clock.setActive(true);
	clock.setActive(true);
	assert.equal(scheduled, 1, "repeated state refreshes must not create timer storms");
	assert.equal(handle.unrefCalled, true);
	callback();
	assert.equal(ticks, 1);
	clock.setActive(false);
	assert.equal(cancelled, 1);
	assert.equal(clock.isActive(), false);
});

test("Runtime heartbeat reports worker liveness instead of elapsed wall time", () => {
	const now = Date.parse("2026-10-08T08:00:20.000Z");
	const live = [{
		status: "running",
		workerAlive: true,
		workerHeartbeatAt: "2026-10-08T08:00:19.000Z",
		lastActivityAt: "2026-10-08T08:00:12.000Z",
	}];
	assert.equal(formatRuntimeHeartbeat(live, { currentTime: now, frame: 0 }), "◐ live · event 8s");
	assert.equal(formatRuntimeHeartbeat([{ status: "input_required" }], { currentTime: now }), "");
	assert.equal(formatRuntimeHeartbeat([{
		status: "running",
		workerHeartbeatAt: "2026-10-08T08:00:03.000Z",
	}], { currentTime: now }), "! heartbeat 17s stale");
});

test("Runtime Dock remains byte-stable across footer heartbeat frames", () => {
	const now = Date.parse("2026-10-08T08:00:20.000Z");
	const active = model({ counts: { active: 1 } });
	const jobs = [{
		id: "codex-demo-12345678",
		backend: "codex",
		status: "running",
		role: "advisor",
		model: "gpt-6-astra",
		thinking: "high",
		progress: "reading evidence",
		startedAt: "2026-10-08T07:53:00.000Z",
	}];
	const dock = new RuntimeDockComponent(active, jobs, theme(), { currentTime: now });
	const first = dock.render(120);
	assert.equal(dock.update(active, jobs, { currentTime: now + 30_000 }), false);
	assert.deepEqual(dock.render(120), first);
	assert.equal(dock.update(active, [{ ...jobs[0], progress: "checking result" }], { currentTime: now + 30_000 }), true);
	assert.notDeepEqual(dock.render(120), first);
});

test("Runtime Dock is responsive and renders objective Codex progress", () => {
	const active = model({ counts: { active: 1 }, project: { freshness: "missing" } });
	const jobs = [{ id: "codex-demo-12345678", backend: "codex", status: "running", role: "advisor", model: "gpt-6-astra", thinking: "max", progress: "reading preregistration", startedAt: new Date().toISOString() }];
	const dock = new RuntimeDockComponent(active, jobs, theme(), { density: "balanced" });
	for (const width of [12, 48, 80, 140]) {
		const lines = dock.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width >= 48) {
			assert.match(lines.join("\n"), /EmbeddingWorld/);
			assert.match(lines.join("\n"), /advisor/);
			assert.match(lines.join("\n"), /RUNNING/);
			if (width >= 80) assert.match(lines.join("\n"), /gpt-6-astra\/max/);
		}
	}
});

test("Runtime Dock never presents a completed leaf tool as a completed executor", () => {
	const active = model({ counts: { active: 1 } });
	const jobs = [{
		id: "codex-demo-9e62a4b5",
		status: "running",
		mode: "executor",
		progress: "research_pi_host · completed",
		lastActivity: {
			id: "tool-1",
			category: "tool",
			status: "completed",
			summary: "research_pi_host · completed",
			at: new Date().toISOString(),
		},
		startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
	}];
	const lines = new RuntimeDockComponent(active, jobs, theme(), { density: "balanced" }).render(160).join("\n");
	assert.match(lines, /codex\/executor 9e62a4b5 · RUNNING · inherit\/inherit/);
	assert.match(lines, /last: research_pi_host · completed/);
	assert.doesNotMatch(lines, /codex\/executor 9e62a4b5 · COMPLETED/);
});

test("Runtime Dock gives concurrent Codex work stable multi-line rows", () => {
	const active = model({ counts: { active: 2 } });
	const jobs = [
		{
			id: "codex-demo-bbbbbbbb",
			status: "running",
			mode: "executor",
			createdAt: "2026-08-21T00:00:02.000Z",
			activeActivityCount: 2,
			activeActivities: [
				{ id: "two", threadId: "thread-child-2", category: "command", summary: "run probe B" },
				{ id: "three", threadId: "thread-child-3", category: "subagent", summary: "review evidence" },
			],
		},
		{
			id: "codex-demo-aaaaaaaa",
			status: "running",
			mode: "advisor",
			createdAt: "2026-08-21T00:00:01.000Z",
			currentActivity: { id: "one", category: "search", summary: "checking docs" },
		},
	];
	const forward = new RuntimeDockComponent(active, jobs, theme(), { density: "balanced" }).render(120);
	const reversed = new RuntimeDockComponent(active, [...jobs].reverse(), theme(), { density: "balanced" }).render(120);
	const text = forward.join("\n");
	assert.ok(text.indexOf("advisor aaaaaaaa") < text.indexOf("executor bbbbbbbb"));
	assert.match(text, /parallel: 2 active activities/);
	assert.match(text, /command hild-2 · run probe B/);
	assert.match(text, /subagent hild-3 · review evidence/);
	assert.deepEqual(forward, reversed, "poll completion order must not reorder Codex rows");
	assert.ok(forward.every((line) => visibleWidth(line) <= 120));
});
