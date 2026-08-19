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
		}
	}
});
