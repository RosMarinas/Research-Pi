import assert from "node:assert/strict";
import test from "node:test";
import researchSideExtension, { SideOverlay } from "../.pi/extensions/research-side.ts";
import {
	buildSidePromotion,
	createSideRecord,
	findSideRecord,
	previewText,
	sideRecords,
} from "../.pi/lib/research-side.mjs";

test("side records remain isolated, addressable, and explicitly promotable", () => {
	const record = createSideRecord({
		question: "Could a contrasting oracle experiment distinguish the hypotheses?",
		answer: "Yes; compare the learned route with an oracle intervention.",
		anchorEntryId: "a1",
		sessionId: "s1",
		model: { provider: "deepseek", id: "deepseek-v4-flash" },
		usage: { input: 90, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1_000 },
		startedAt: new Date("2026-01-01T00:00:00Z"),
		completedAt: new Date("2026-01-01T00:00:01Z"),
	});
	const entries = [{ type: "custom", customType: "research-side", id: "entry-1", data: record }];
	assert.equal(sideRecords(entries).length, 1);
	assert.equal(findSideRecord(entries, record.id.slice(-8)).answer, record.answer);
	assert.match(buildSidePromotion(record), /explicitly promoted/);
	assert.match(buildSidePromotion(record), /oracle intervention/);
	assert.equal(previewText("abcdef", 4), "abcd…");
});

function plainTheme() {
	return {
		bg(_color, text) { return text; },
		fg(_color, text) { return text; },
		bold(text) { return text; },
	};
}

test("side cards advertise reversible expansion and /side collapse restores the compact transcript", async () => {
	let entryRenderer;
	let sideCommand;
	researchSideExtension({
		registerEntryRenderer(_kind, renderer) { entryRenderer = renderer; },
		registerMessageRenderer() {},
		registerCommand(name, command) {
			if (name === "side") sideCommand = command;
		},
	});
	const record = createSideRecord({
		question: "What distinguishes the two hypotheses?",
		answer: "A deliberately long answer that remains available in the dedicated overlay.",
		anchorEntryId: "a1",
		sessionId: "s1",
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
		startedAt: new Date("2026-01-01T00:00:00Z"),
		completedAt: new Date("2026-01-01T00:00:01Z"),
	});
	const expanded = entryRenderer({ data: record }, { expanded: true }, plainTheme()).render(100).join("\n");
	assert.match(expanded, /Ctrl\+O collapses/);

	let toolsExpanded = true;
	const notifications = [];
	await sideCommand.handler("collapse", {
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => [] },
		ui: {
			getToolsExpanded: () => toolsExpanded,
			setToolsExpanded(value) { toolsExpanded = value; },
			notify(message) { notifications.push(message); },
		},
	});
	assert.equal(toolsExpanded, false);
	assert.match(notifications.at(-1), /Collapsed/);
});

test("the full side overlay has an explicit close path", () => {
	let closed = false;
	const overlay = new SideOverlay(
		{ requestRender() {} },
		plainTheme(),
		() => { closed = true; },
		{
			id: "side-demo",
			question: "Question",
			answer: "Answer",
			sessionId: "s1",
			model: { provider: "deepseek", id: "deepseek-v4-pro" },
			startedAt: "2026-01-01T00:00:00Z",
			completedAt: "2026-01-01T00:00:01Z",
			latencyMs: 1000,
		},
	);
	overlay.handleInput("q");
	assert.equal(closed, true);
});
