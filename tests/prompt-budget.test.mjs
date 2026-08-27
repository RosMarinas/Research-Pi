import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildDelegationPrompt } from "../.pi/lib/codex-jobs.mjs";
import {
	buildResearchCompactionPrompt,
	RESEARCH_COMPACTION_SYSTEM_PROMPT,
} from "../.pi/lib/research-compact.mjs";

test("stable Research Pi prompt surfaces stay within explicit budgets", () => {
	const operatingContract = readFileSync(new URL("../.pi/APPEND_SYSTEM.md", import.meta.url), "utf8");
	assert.ok(operatingContract.length <= 12_000, `operating contract grew to ${operatingContract.length} chars`);

	for (const mode of ["advisor", "executor"]) {
		const fresh = buildDelegationPrompt({ mode, task: "TASK", mission: "MISSION" });
		const continuation = buildDelegationPrompt({
			mode,
			task: "FOLLOW-UP",
			mission: "MISSION",
			continuation: true,
			continuationNotice: "FRESHNESS",
		});
		assert.ok(fresh.length <= 3_600, `${mode} fresh delegation grew to ${fresh.length} chars`);
		assert.ok(continuation.length <= 1_400, `${mode} continuation grew to ${continuation.length} chars`);
		assert.ok(continuation.length < fresh.length / 2, `${mode} continuation no longer isolates the task delta`);
		assert.ok(continuation.indexOf("<mission>") < continuation.indexOf("<task>"));
		const wslFresh = buildDelegationPrompt({ mode, task: "TASK", mission: "MISSION", wslVersion: "2" });
		assert.ok(wslFresh.length <= 3_600, `${mode} WSL delegation grew to ${wslFresh.length} chars`);
		assert.match(wslFresh, /WSL2.*host-command.*one-shot/s);
	}

	const dynamicCompaction = buildResearchCompactionPrompt({
		conversationText: "CONVERSATION",
		experiments: [],
		checkpoints: [],
		sourceCatalog: [],
	});
	assert.ok(RESEARCH_COMPACTION_SYSTEM_PROMPT.length <= 2_600);
	assert.ok(dynamicCompaction.length <= 1_200);
	assert.doesNotMatch(dynamicCompaction, /Required schema:/, "the tool schema is the single schema prompt");
});
