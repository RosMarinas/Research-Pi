import assert from "node:assert/strict";
import test from "node:test";
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
