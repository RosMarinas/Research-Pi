import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	CODEX_ANALYSIS_ACTOR_ID,
	CODEX_ANALYSIS_HANDOFF_MAX_CHARS,
	normalizeCodexAnalysisHandoff,
	queueCodexAnalysisHandoff,
	readCodexAnalysisContext,
} from "../.pi/lib/research-analysis-bridge.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	createRuntimeMessage,
	readRuntimeSnapshot,
	resolveResearchRuntime,
} from "../.pi/lib/research-runtime.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-analysis-"));
	const workspace = join(root, "project");
	const runtimeRoot = join(root, "runtime");
	mkdirSync(workspace, { recursive: true });
	return { root, workspace, runtimeRoot };
}

const launcher = fileURLToPath(new URL("../bin/pi.mjs", import.meta.url));

test("Codex discussion handoffs stay concise and enter the existing Leader mailbox", async () => {
	const paths = fixture();
	try {
		assert.equal(normalizeCodexAnalysisHandoff(" 判断：A。  \n\n\n 建议：B。 "), "判断：A。\n\n建议：B。");
		assert.throws(
			() => normalizeCodexAnalysisHandoff("x".repeat(CODEX_ANALYSIS_HANDOFF_MAX_CHARS + 1)),
			/condense it.*transcript/,
		);

		const message = await queueCodexAnalysisHandoff(
			paths.workspace,
			"判断：当前解释仍有两个候选。\n依据：现有记录只区分了其中一项。\n建议：先做一次能区分两者的诊断。",
			{ runtimeRoot: paths.runtimeRoot },
		);
		const runtime = await resolveResearchRuntime(paths.workspace, { runtimeRoot: paths.runtimeRoot });
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(message.to, RESEARCH_LEADER_ACTOR_ID);
		assert.equal(message.from, CODEX_ANALYSIS_ACTOR_ID);
		assert.equal(message.metadata.kind, "analysis_handoff");
		assert.equal(snapshot.messages.find((item) => item.id === message.id)?.status, "queued");
		assert.ok(snapshot.actors.some((actor) => actor.id === CODEX_ANALYSIS_ACTOR_ID && actor.kind === "analysis"));
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("Codex discussion context exposes ProjectView but not the Leader mailbox body", async () => {
	const paths = fixture();
	try {
		const runtime = await resolveResearchRuntime(paths.workspace, { runtimeRoot: paths.runtimeRoot });
		await createRuntimeMessage(runtime, {
			id: "leader-private-message",
			type: "notify",
			from: "analysis:other",
			to: RESEARCH_LEADER_ACTOR_ID,
			body: "LEADER_PRIVATE_MAILBOX_BODY",
		});
		const context = await readCodexAnalysisContext(paths.workspace, { runtimeRoot: paths.runtimeRoot });
		assert.match(context, /Independent discussion context/);
		assert.match(context, /research_project_view/);
		assert.match(context, /pi analysis send/);
		assert.doesNotMatch(context, /LEADER_PRIVATE_MAILBOX_BODY/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("pi analysis context/send works as a standalone bridge beside a running Leader", async () => {
	const paths = fixture();
	try {
		const stateRoot = join(paths.root, "state");
		const environment = { ...process.env, RESEARCH_PI_STATE_DIR: stateRoot };
		delete environment.RESEARCH_PI_DEV_MODE;
		const context = spawnSync(process.execPath, [launcher, "analysis", "context"], {
			cwd: paths.workspace,
			env: environment,
			encoding: "utf8",
		});
		assert.equal(context.status, 0, context.stderr);
		assert.match(context.stdout, /research_pi_codex_analysis/);

		const send = spawnSync(process.execPath, [launcher, "analysis", "send"], {
			cwd: paths.workspace,
			env: environment,
			encoding: "utf8",
			input: "判断：值得继续讨论。\n依据：现有结果尚未区分两个解释。\n建议：先做诊断。\n",
		});
		assert.equal(send.status, 0, send.stderr);
		assert.match(send.stdout, /queued for the Research Pi Leader/);
		const runtime = await resolveResearchRuntime(paths.workspace, { runtimeRoot: join(stateRoot, "runtime", "projects") });
		const snapshot = await readRuntimeSnapshot(runtime);
		assert.equal(snapshot.messages.length, 1);
		assert.equal(snapshot.messages[0].metadata.source, "codex_discussion");
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});
