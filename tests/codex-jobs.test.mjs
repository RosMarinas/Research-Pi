import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexDelegateExtension from "../.pi/extensions/codex-delegate.ts";
import {
	DEFAULT_CODEX_MODEL,
	DEFAULT_CODEX_REASONING_EFFORT,
	buildDelegationPrompt,
	cancelCodexJob,
	resumeCodexJob,
	sanitizeCodexEnvironment,
	startCodexJob,
	waitForCodexJob,
} from "../.pi/lib/codex-jobs.mjs";

test("Pi registers one Codex delegation tool instead of a family of noisy tools", () => {
	let registered;
	codexDelegateExtension({
		registerTool(tool) {
			registered = tool;
		},
	});
	assert.equal(registered.name, "codex_delegate");
	assert.equal(registered.executionMode, "sequential");
	assert.match(registered.description, /gpt-5\.6-sol\/max/);
});

function makeFakeCodex(root, delayMs = 0) {
	const path = join(root, `fake-codex-${delayMs}.mjs`);
	writeFileSync(
		path,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => {
    const sandboxIndex = args.indexOf("-s");
    const modelIndex = args.indexOf("-m");
    const sandbox = sandboxIndex >= 0 ? args[sandboxIndex + 1] : "unknown";
    const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
    const isResume = args.includes("resume");
    if (sandbox === "danger-full-access") {
      writeFileSync(join(process.cwd(), "codex-executed.txt"), "executor ran\\n", "utf8");
    }
    const result = {
      status: "completed",
      goal_satisfied: true,
      summary: isResume ? "resumed" : "finished",
      evidence: [model, sandbox, prompt.includes("Research Pi") ? "role-present" : "role-missing"],
      actions_taken: ["fake action"],
      changed_files: sandbox === "danger-full-access" ? ["codex-executed.txt"] : [],
      checks: [{ command: "fake-check", result: "passed" }],
      external_effects: [],
      uncertainties: [],
      recommended_next_step: "inspect result"
    };
    console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fake-123" }));
    console.log(JSON.stringify({ type: "turn.started" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } }));
  }, ${delayMs});
});
`,
		{ encoding: "utf8", mode: 0o700 },
	);
	chmodSync(path, 0o700);
	return path;
}

test("delegation prompt encodes distinct advisor and full executor roles", () => {
	const advisor = buildDelegationPrompt({ mode: "advisor", task: "inspect", successCriteria: [], context: "" });
	assert.match(advisor, /read-only advisor/);
	assert.doesNotMatch(advisor, /committing or pushing Git changes/);

	const executor = buildDelegationPrompt({
		mode: "executor",
		task: "run the experiment",
		successCriteria: ["record the run id"],
		context: "hypothesis H1",
	});
	assert.match(executor, /deleting files/);
	assert.match(executor, /expensive experiments/);
	assert.match(executor, /record the run id/);
	assert.match(executor, /hypothesis H1/);
});

test("Codex environment removes the DeepSeek credential without dropping execution access", () => {
	const env = sanitizeCodexEnvironment({
		PATH: "/bin",
		HOME: "/tmp/example-home",
		SSH_AUTH_SOCK: "/tmp/ssh.sock",
		DEEPSEEK_API_KEY: "secret",
	});
	assert.equal(env.DEEPSEEK_API_KEY, undefined);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/tmp/example-home");
	assert.equal(env.SSH_AUTH_SOCK, "/tmp/ssh.sock");
});

test("advisor, executor, and explicit resume produce durable structured jobs", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root);

		const advisorStart = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: "inspect only",
		});
		const advisor = await waitForCodexJob(advisorStart.id, { jobRoot });
		assert.equal(advisor.status, "completed");
		assert.equal(advisor.model, DEFAULT_CODEX_MODEL);
		assert.equal(advisor.reasoningEffort, DEFAULT_CODEX_REASONING_EFFORT);
		assert.equal(advisor.sandbox, "read-only");
		assert.equal(advisor.result.goal_satisfied, true);
		assert.equal(advisor.threadId, "thread-fake-123");

		const executorStart = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "executor",
			task: "execute fully",
		});
		const executor = await waitForCodexJob(executorStart.id, { jobRoot });
		assert.equal(executor.status, "completed");
		assert.equal(executor.model, DEFAULT_CODEX_MODEL);
		assert.equal(executor.reasoningEffort, DEFAULT_CODEX_REASONING_EFFORT);
		assert.equal(executor.sandbox, "danger-full-access");
		assert.equal(readFileSync(join(workspace, "codex-executed.txt"), "utf8"), "executor ran\n");

		const resumedStart = await resumeCodexJob(executor.id, {
			jobRoot,
			codexBin,
			followUp: "continue the exact thread",
		});
		const resumed = await waitForCodexJob(resumedStart.id, { jobRoot });
		assert.equal(resumed.status, "completed");
		assert.equal(resumed.continuationOf, executor.id);
		assert.equal(resumed.result.summary, "resumed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a workspace has one writer lease and cancellation stops its durable job", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-lock-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root, 10000);
		const first = await startCodexJob({ cwd: workspace, jobRoot, codexBin, mode: "executor", task: "long job" });

		await assert.rejects(
			startCodexJob({ cwd: workspace, jobRoot, codexBin, mode: "executor", task: "conflicting job" }),
			/already writing/,
		);
		const cancelled = await cancelCodexJob(first.id, { jobRoot });
		assert.equal(cancelled.status, "cancelled");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
