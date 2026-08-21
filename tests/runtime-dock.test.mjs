import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RuntimeDockComponent, runtimeDockVisible } from "../.pi/lib/runtime-dock-ui.mjs";

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

test("Runtime Dock is responsive and renders objective Codex progress", () => {
	const active = model({ counts: { active: 1 }, project: { freshness: "missing" } });
	const jobs = [{ id: "codex-demo-12345678", status: "running", mode: "advisor", progress: "reading preregistration", startedAt: new Date().toISOString() }];
	const dock = new RuntimeDockComponent(active, jobs, theme(), { density: "balanced" });
	for (const width of [12, 48, 80, 140]) {
		const lines = dock.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width >= 48) {
			assert.match(lines.join("\n"), /EmbeddingWorld/);
			assert.match(lines.join("\n"), /advisor/);
			assert.match(lines.join("\n"), /RUNNING/);
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
	assert.match(lines, /executor 9e62a4b5 · RUNNING/);
	assert.match(lines, /last: research_pi_host · completed/);
	assert.doesNotMatch(lines, /executor 9e62a4b5 · COMPLETED/);
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
