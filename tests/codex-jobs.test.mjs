import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexDelegateExtension, { formatCodexStatus } from "../.pi/extensions/codex-delegate.ts";
import {
	DEFAULT_CODEX_MODEL,
	DEFAULT_CODEX_REASONING_EFFORT,
	buildDelegationPrompt,
	cancelCodexJob,
	listCodexJobs,
	respondToCodexJob,
	resumeCodexJob,
	sanitizeCodexEnvironment,
	startCodexJob,
	steerCodexJob,
	waitForCodexJob,
} from "../.pi/lib/codex-jobs.mjs";
import { CODEX_ADVISOR_PROFILE, CODEX_EXECUTOR_PROFILE } from "../.pi/lib/project-boundary.mjs";
import {
	createCapabilityGrant,
	prepareCapabilityRequest,
	resolveCapabilityContext,
} from "../.pi/lib/host-capabilities.mjs";

test("Pi registers one Codex delegation tool instead of a family of noisy tools", () => {
	let registered;
	codexDelegateExtension({
		registerTool(tool) {
			registered = tool;
		},
		on() {},
	});
	assert.equal(registered.name, "codex_delegate");
	assert.equal(registered.executionMode, "sequential");
	assert.match(registered.description, /gpt-5\.6-sol\/max/);
});

test("Codex delegation exposes bounded running and terminal footer states", () => {
	const running = formatCodexStatus({
		id: "codex-2026-08-11-12345678",
		mode: "executor",
		status: "running",
		progress: "item.completed: command execution",
	});
	assert.equal(running, "⚙ Codex executor 12345678 · running · item.completed: command execution");

	const completed = formatCodexStatus({
		id: "codex-2026-08-11-abcdef12",
		mode: "advisor",
		status: "completed",
		progress: "completed",
	});
	assert.equal(completed, "✓ Codex advisor abcdef12 · completed · completed");
});

function makeFakeCodex(root, delayMs = 0) {
	const path = join(root, `fake-codex-${delayMs}.mjs`);
	writeFileSync(
		path,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const configText = args.join(" ");
const sandbox = configText.includes("research_pi_executor") ? "${CODEX_EXECUTOR_PROFILE}" : configText.includes("research_pi_advisor") ? "${CODEX_ADVISOR_PROFILE}" : "unknown";
let model = "unknown";
let isResume = false;
let activeTurn = null;
let completionTimer;
let deltaNotificationsOptedOut = false;
let hostToolPresent = false;
process.stderr.write("fake app-server warning\\n");

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const complete = (prompt, leaderResponse = "") => {
  if (sandbox === "${CODEX_EXECUTOR_PROFILE}") {
    writeFileSync(join(process.cwd(), "codex-executed.txt"), "executor ran\\n", "utf8");
  }
  const result = {
    status: "completed",
    goal_satisfied: true,
    summary: isResume ? "resumed" : "finished",
    evidence: [model, sandbox, prompt.includes("Research Pi") ? "role-present" : "role-missing", deltaNotificationsOptedOut ? "delta-opt-out" : "delta-not-opted-out", hostToolPresent ? "host-tool-present" : "host-tool-missing", process.env.SSH_AUTH_SOCK ? "child-ssh-agent-present" : "child-ssh-agent-absent", leaderResponse].filter(Boolean),
    actions_taken: ["fake action"],
    changed_files: sandbox === "${CODEX_EXECUTOR_PROFILE}" ? ["codex-executed.txt"] : [],
    checks: [{ command: "fake-check", result: "passed" }],
    external_effects: [],
    uncertainties: [],
    recommended_next_step: "inspect result"
  };
  send({ method: "item/completed", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "message-1", type: "agentMessage", phase: "final_answer", text: JSON.stringify(result) } } });
  send({ method: "turn/completed", params: { threadId: "thread-fake-123", turn: { id: activeTurn, status: "completed", items: [], error: null } } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    deltaNotificationsOptedOut = message.params.capabilities?.optOutNotificationMethods?.includes("item/agentMessage/delta") ?? false;
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "test", codexHome: process.cwd() } });
  } else if (message.method === "thread/start") {
    model = message.params.model;
    hostToolPresent = message.params.dynamicTools?.some((tool) => tool.name === "research_pi_host") ?? false;
    send({ id: message.id, result: { thread: { id: "thread-fake-123", turns: [] } } });
    send({ method: "thread/started", params: { thread: { id: "thread-fake-123", turns: [] } } });
  } else if (message.method === "thread/resume") {
    model = message.params.model;
    hostToolPresent = message.params.dynamicTools?.some((tool) => tool.name === "research_pi_host") ?? false;
    isResume = true;
    send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
    send({ method: "thread/started", params: { thread: { id: message.params.threadId, turns: [] } } });
  } else if (message.method === "turn/start") {
    activeTurn = "turn-fake-456";
    const prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: activeTurn, status: "inProgress", items: [], error: null } } });
    send({ method: "turn/started", params: { threadId: "thread-fake-123", turn: { id: activeTurn, status: "inProgress", items: [], error: null } } });
    if (prompt.includes("delta storm")) {
      for (let index = 0; index < 1000; index += 1) {
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-fake-123", turnId: activeTurn, itemId: "message-1", delta: "x" } });
      }
    }
    if (prompt.includes("ask the leader live")) {
      send({ id: "server-question-1", method: "item/tool/call", params: { threadId: "thread-fake-123", turnId: activeTurn, callId: "call-1", tool: "consult_research_pi", arguments: { audience: "leader", question: "Choose H1 or H2", why_blocking: "The experiment differs", options: ["H1", "H2"] } } });
    } else if (prompt.includes("HOST_READ_PATH=")) {
      const path = prompt.match(/HOST_READ_PATH=([^\\n<]+)/)?.[1]?.trim();
      send({ id: "server-host-read-1", method: "item/tool/call", params: { threadId: "thread-fake-123", turnId: activeTurn, callId: "host-call-1", tool: "research_pi_host", arguments: { action: "read", path } } });
    } else {
      completionTimer = setTimeout(() => complete(prompt), ${delayMs});
    }
  } else if (message.id === "server-question-1") {
    const answer = message.result?.contentItems?.[0]?.text ?? "missing answer";
    complete("Research Pi", answer);
  } else if (message.id === "server-host-read-1") {
    const answer = message.result?.contentItems?.[0]?.text ?? message.error?.message ?? "missing host response";
    complete("Research Pi", answer);
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: activeTurn } });
  } else if (message.method === "turn/interrupt") {
    clearTimeout(completionTimer);
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "thread-fake-123", turn: { id: activeTurn, status: "interrupted", items: [], error: null } } });
  }
});
`,
		{ encoding: "utf8", mode: 0o700 },
	);
	chmodSync(path, 0o700);
	return path;
}

test("delegation prompt encodes distinct advisor and project-bounded executor roles", () => {
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
	assert.match(executor, /hard authority boundary/);
	assert.match(executor, /research_pi_host/);
	assert.match(executor, /credential contents never enter/);
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

		const previousAgentSocket = process.env.SSH_AUTH_SOCK;
		process.env.SSH_AUTH_SOCK = "/private/synthetic-agent.sock";
		let advisorStart;
		try {
			advisorStart = await startCodexJob({
				cwd: workspace,
				jobRoot,
				codexBin,
				mode: "advisor",
				task: "inspect only",
			});
		} finally {
			if (previousAgentSocket === undefined) delete process.env.SSH_AUTH_SOCK;
			else process.env.SSH_AUTH_SOCK = previousAgentSocket;
		}
		const advisor = await waitForCodexJob(advisorStart.id, { jobRoot });
		assert.equal(advisor.status, "completed");
		assert.equal(advisor.model, DEFAULT_CODEX_MODEL);
		assert.equal(advisor.reasoningEffort, DEFAULT_CODEX_REASONING_EFFORT);
		assert.equal(advisor.sandbox, CODEX_ADVISOR_PROFILE);
		assert.equal(advisor.result.goal_satisfied, true);
		assert.equal(advisor.threadId, "thread-fake-123");
		assert.match(advisor.result.evidence.join("\n"), /child-ssh-agent-absent/);

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
		assert.equal(executor.sandbox, CODEX_EXECUTOR_PROFILE);
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

test("app-server delegation supports live leader requests and durable session reattachment", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-live-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: "ask the leader live",
			leaderSessionId: "pi-session-live",
		});
		assert.equal(started.leaderSessionId, "pi-session-live");
		assert.equal((await listCodexJobs({ jobRoot })).length, 1);

		let waiting;
		let observed;
		for (let attempt = 0; attempt < 200; attempt++) {
			const [job] = await listCodexJobs({ jobRoot, leaderSessionId: "pi-session-live", cwd: workspace });
			if (job) observed = job;
			if (job?.status === "input_required") {
				waiting = job;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(waiting?.pendingRequest?.question, "Choose H1 or H2", JSON.stringify(observed));
		assert.equal(waiting?.activeTurnId, "turn-fake-456");

		const steering = await steerCodexJob(started.id, {
			jobRoot,
			message: "Treat this as a protocol smoke, not a research conclusion.",
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			const command = JSON.parse(
				readFileSync(join(jobRoot, started.id, "commands", `${steering.command.id}.json`), "utf8"),
			);
			if (command.status === "applied") break;
			if (command.status === "failed") assert.fail(command.error);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(
			JSON.parse(readFileSync(join(jobRoot, started.id, "commands", `${steering.command.id}.json`), "utf8")).status,
			"applied",
		);
		await respondToCodexJob(started.id, {
			jobRoot,
			requestId: waiting.pendingRequest.id,
			response: "Use H2 because it distinguishes the hypotheses.",
		});
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.match(completed.result.evidence.join("\n"), /Use H2/);

		const commandName = readdirSync(join(jobRoot, started.id, "commands")).find((name) =>
			readFileSync(join(jobRoot, started.id, "commands", name), "utf8").includes('"type": "respond"'),
		);
		const persistedCommand = readFileSync(join(jobRoot, started.id, "commands", commandName), "utf8");
		assert.doesNotMatch(persistedCommand, /Use H2/);
		assert.match(persistedCommand, /responseSha256/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("token delta storms do not amplify job-state or default audit-log writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-io-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: "run a delta storm protocol smoke",
		});
		const completed = await waitForCodexJob(started.id, { jobRoot });
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(completed.status, "completed");
		assert.match(completed.result.evidence.join("\n"), /delta-opt-out/);
		assert.equal(completed.workerIo.deltaNotificationsSeen, 1000);
		assert.ok(completed.workerIo.jobStateWrites <= 7, JSON.stringify(completed.workerIo));
		assert.ok(completed.workerIo.progressUpdatesPersisted <= 1, JSON.stringify(completed.workerIo));

		const jobDir = join(jobRoot, started.id);
		const events = readFileSync(join(jobDir, "events.jsonl"), "utf8");
		assert.doesNotMatch(events, /item\/agentMessage\/delta/);
		assert.ok(events.trim().split("\n").length < 20, events);
		assert.ok(readdirSync(jobDir).includes("stderr.log"));
		assert.ok(!readdirSync(jobDir).includes("stderr-tail.log"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex uses the same opaque session host-capability ledger", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-host-"));
	try {
		const workspace = join(root, "workspace");
		const outside = join(root, "outside-note.txt");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(join(workspace, ".git"), { recursive: true });
		writeFileSync(outside, "host capability reached\n");
		const hostCapabilityContext = await resolveCapabilityContext(workspace, "pi-session-host", {
			stateRoot: join(root, "capabilities"),
		});
		const request = await prepareCapabilityRequest(hostCapabilityContext, { kind: "external-read", path: outside });
		await createCapabilityGrant(hostCapabilityContext, request, "session");
		const codexBin = makeFakeCodex(root);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: `Use the approved host read. HOST_READ_PATH=${outside}`,
			leaderSessionId: "pi-session-host",
			hostCapabilityContext,
		});
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.match(completed.result.evidence.join("\n"), /host-tool-present/);
		assert.match(completed.result.evidence.join("\n"), /host capability reached/);
		const persistedRequest = readFileSync(join(jobRoot, started.id, "request.json"), "utf8");
		assert.match(persistedRequest, /hostCapabilityContext/);
		assert.doesNotMatch(persistedRequest, /SSH_AUTH_SOCK|PRIVATE KEY|API_KEY/);
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
