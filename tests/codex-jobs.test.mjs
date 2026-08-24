import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexDelegateExtension, {
	codexResultMarkdown,
	codexResultPreview,
	formatCodexJob,
	formatCodexJobsStatus,
	formatCodexStatus,
} from "../.pi/extensions/codex-delegate.ts";
import {
	DEFAULT_CODEX_ADVISOR_SCHEMA_PATH,
	DEFAULT_CODEX_MODEL,
	DEFAULT_CODEX_REASONING_EFFORT,
	buildDelegationPrompt,
	buildCodexContinuationNotice,
	cancelCodexJob,
	findReusableCodexJob,
	listCodexJobs,
	listCodexMissions,
	readCodexJob,
	reconcileCodexJobOutcome,
	respondToCodexJob,
	resumeCodexJob,
	sanitizeCodexEnvironment,
	startCodexJob,
	steerCodexJob,
	supersedePendingCodexRequests,
	waitForCodexJob,
} from "../.pi/lib/codex-jobs.mjs";
import { CODEX_ADVISOR_PROFILE, CODEX_EXECUTOR_PROFILE } from "../.pi/lib/project-boundary.mjs";
import {
	RESEARCH_LEADER_ACTOR_ID,
	attachRuntimeActor,
	initializeResearchRuntime,
} from "../.pi/lib/research-runtime.mjs";
import {
	createCapabilityGrant,
	prepareCapabilityRequest,
	resolveCapabilityContext,
} from "../.pi/lib/host-capabilities.mjs";

test("terminal Codex jobs supersede unresolved request records without changing resolved history", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-request-settlement-"));
	try {
		const jobRoot = join(root, "jobs");
		const jobId = "codex-2026-08-24T00-00-00-000Z-deadbeef";
		const requestDir = join(jobRoot, jobId, "requests");
		mkdirSync(requestDir, { recursive: true });
		writeFileSync(join(requestDir, "request-pending.json"), JSON.stringify({ id: "request-pending", status: "pending", question: "old ask" }));
		writeFileSync(join(requestDir, "request-resolved.json"), JSON.stringify({ id: "request-resolved", status: "resolved", resolvedAt: "2026-08-24T00:00:00.000Z" }));

		const settled = await supersedePendingCodexRequests(jobId, { jobRoot, terminalStatus: "completed" });
		assert.deepEqual(settled, ["request-pending"]);
		const pending = JSON.parse(readFileSync(join(requestDir, "request-pending.json"), "utf8"));
		const resolved = JSON.parse(readFileSync(join(requestDir, "request-resolved.json"), "utf8"));
		assert.equal(pending.status, "superseded");
		assert.equal(pending.resolutionReason, "codex_job_completed");
		assert.match(pending.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(resolved.status, "resolved");
		await assert.rejects(
			supersedePendingCodexRequests(jobId, { jobRoot, terminalStatus: "input_required" }),
			/non-terminal status/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi registers one Codex delegation tool instead of a family of noisy tools", () => {
	let registered;
	let command;
	codexDelegateExtension({
		registerTool(tool) {
			registered = tool;
		},
		registerCommand(name, definition) {
			command = { name, definition };
		},
		on() {},
	});
	assert.equal(registered.name, "codex_delegate");
	assert.equal(registered.executionMode, "sequential");
	assert.match(registered.description, /gpt-5\.6-sol\/max/);
	assert.match(registered.description, /collaborative research consultation/);
	assert.doesNotMatch(registered.description, /second opinion|independent proposal or critique/i);
	assert.match(registered.promptGuidelines.join("\n"), /research question is immature/);
	assert.match(registered.promptGuidelines.join("\n"), /executor delegation, state a concrete objective and observable success criteria/);
	assert.match(registered.promptGuidelines.join("\n"), /advisor consultation, start from the research uncertainty/);
	assert.match(registered.promptGuidelines.join("\n"), /continuation of inquiry, not an automatic review or approval gate/);
	assert.match(registered.promptGuidelines.join("\n"), /explicit critique, verdict, or adjudication language only/);
	assert.equal(command.name, "codex");
	assert.match(command.definition.description, /mission threads/);
});

test("Codex delegation exposes bounded running and terminal footer states", () => {
	const running = formatCodexStatus({
		id: "codex-2026-08-11-12345678",
		mode: "executor",
		status: "running",
		progress: "item.completed: command execution",
	});
	assert.equal(running, "⚙ Codex executor 12345678 · running · phase: item.completed: command execution");

	const runningAfterTool = formatCodexStatus({
		id: "codex-2026-08-11-9e62a4b5",
		mode: "executor",
		status: "running",
		progress: "Codex turn running",
		lastActivity: { summary: "research_pi_host · completed" },
	});
	assert.equal(runningAfterTool, "⚙ Codex executor 9e62a4b5 · running · last: research_pi_host · completed");

	const completed = formatCodexStatus({
		id: "codex-2026-08-11-abcdef12",
		mode: "advisor",
		status: "completed",
		progress: "completed",
	});
	assert.equal(completed, "✓ Codex advisor abcdef12 · completed · phase: completed");

	const partial = formatCodexStatus({
		id: "codex-2026-08-11-abcddcba",
		mode: "executor",
		status: "completed",
		progress: "completed",
		result: { outcome: "partial", goal_satisfied: false },
	});
	assert.equal(partial, "! Codex executor abcddcba · completed/partial · phase: completed");

	const parallel = formatCodexStatus({
		id: "codex-2026-08-11-feedbeef",
		mode: "executor",
		status: "running",
		progress: "child activity changed",
		activeActivityCount: 3,
		activeActivities: [
			{ id: "one", summary: "first child" },
			{ id: "two", summary: "second child" },
		],
	});
	assert.equal(parallel, "⚙ Codex executor feedbeef · running · 3 parallel activities · /watch");

	const aggregate = formatCodexJobsStatus([
		{ id: "codex-b", mode: "executor", status: "running", createdAt: "2026-08-11T00:00:02Z" },
		{ id: "codex-a", mode: "advisor", status: "input_required", createdAt: "2026-08-11T00:00:01Z" },
	]);
	assert.equal(aggregate, "? Codex 2 active · 1 waiting · details above editor");
});

test("a synchronous advisor ASK tells the Leader to resume the exact paused turn", () => {
	const text = formatCodexJob({
		id: "codex-2026-08-24T10-27-17-695Z-a19e1bec",
		mode: "advisor",
		status: "input_required",
		pendingRequest: {
			id: "request-a19e1bec-b1b04fb465a5",
			audience: "leader",
			question: "Which interpretation should remain live?",
			whyBlocking: "The answer changes the comparison surface.",
			options: ["H1", "H2"],
		},
	});
	assert.match(text, /paused for input; its worker and current turn remain alive/);
	assert.match(text, /action=respond/);
	assert.match(text, /jobId=codex-2026-08-24T10-27-17-695Z-a19e1bec/);
	assert.match(text, /requestId=request-a19e1bec-b1b04fb465a5/);
	assert.match(text, /Do not cancel, restart, or replace/);
});

test("Codex structured results render as readable sections instead of raw JSON", () => {
	const result = {
		outcome: "succeeded",
		goal_satisfied: true,
		completion_basis: "All delegated acceptance criteria passed.",
		summary: "Observation first.\n\n1. Preserve the numbered argument.\n2. Keep the second point.",
		evidence: ["Metric A passed", "Metric B remained uncertain"],
		actions_taken: ["Inspected the project"],
		changed_files: ["src/probe.py"],
		checks: [{ command: "uv run pytest", result: "12 passed" }],
		external_effects: [],
		uncertainties: ["One surface remains untested"],
		remaining_work: [],
		recommended_next_step: "Run the discriminating probe.",
	};
	const markdown = codexResultMarkdown(result);
	assert.match(markdown, /^## Delegation outcome/m);
	assert.match(markdown, /All delegated acceptance criteria passed/);
	assert.match(markdown, /^## Summary/m);
	assert.match(markdown, /1\. Preserve the numbered argument\./);
	assert.match(markdown, /^## Evidence/m);
	assert.match(markdown, /`uv run pytest`/);
	assert.match(markdown, /^## Recommended next step/m);
	assert.doesNotMatch(markdown, /"goal_satisfied"/);
	assert.equal(codexResultPreview(result), "Observation first. 1. Preserve the numbered argument. 2. Keep the second point.");
});

test("Codex advisor results render as a continuation surface instead of a review verdict", () => {
	const result = {
		status: "working_synthesis",
		shared_understanding: "The representation question is not yet mature enough for a verdict.",
		points_of_agreement: ["The intervention must be explicit"],
		candidate_explanations: ["The gain comes from memory", "The gain comes from evaluation leakage"],
		questions_to_resolve: ["Which observation separates the two explanations?"],
		evidence: ["The current pilot is inconclusive"],
		uncertainties: ["No oracle result yet"],
		working_synthesis: "Keep both explanations live and design one discriminating probe.",
		suggested_next_exchange: "Ask Research Pi which intervention is affordable first.",
	};
	const markdown = codexResultMarkdown(result);
	assert.match(markdown, /^## Shared understanding/m);
	assert.match(markdown, /^## Candidate explanations/m);
	assert.match(markdown, /^## Questions to resolve/m);
	assert.match(markdown, /^## Working synthesis/m);
	assert.match(markdown, /^## Suggested next exchange/m);
	assert.doesNotMatch(markdown, /review score|goal_satisfied/);
	assert.equal(codexResultPreview(result), "Keep both explanations live and design one discriminating probe.");
});

test("a stale Pi Session cannot start new Codex work after Leader ownership moves", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-stale-leader-"));
	const previousRuntimeRoot = process.env.RESEARCH_PI_RUNTIME_DIR;
	process.env.RESEARCH_PI_RUNTIME_DIR = join(root, "runtime");
	try {
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const runtime = await initializeResearchRuntime(workspace, { sessionId: "session-a", branchAnchorId: "leaf-a" });
		await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, { sessionId: "session-b", branchAnchorId: "leaf-b" });

		let registered;
		codexDelegateExtension({
			registerTool(tool) { registered = tool; },
			registerCommand() {},
			on() {},
			sendMessage() {},
		});
		const ctx = {
			cwd: workspace,
			hasUI: false,
			sessionManager: {
				getSessionId: () => "session-a",
				getLeafId: () => "leaf-a",
				getBranch: () => [],
			},
		};
		await assert.rejects(
			registered.execute("tool-call", { action: "start", task: "must not launch" }, new AbortController().signal, undefined, ctx),
			/no longer the Leader Session/,
		);
	} finally {
		if (previousRuntimeRoot === undefined) delete process.env.RESEARCH_PI_RUNTIME_DIR;
		else process.env.RESEARCH_PI_RUNTIME_DIR = previousRuntimeRoot;
		rmSync(root, { recursive: true, force: true });
	}
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
if (args.includes("sandbox")) {
  process.stdout.write("research-pi-codex-preflight=ok\\n");
  process.exit(0);
}
const configText = args.join(" ");
const sandbox = configText.includes("research_pi_executor") ? "${CODEX_EXECUTOR_PROFILE}" : configText.includes("research_pi_advisor") ? "${CODEX_ADVISOR_PROFILE}" : "unknown";
let model = "unknown";
let isResume = false;
let activeTurn = null;
let completionTimer;
let deltaNotificationsOptedOut = false;
let hostToolPresent = false;
let submissionToolPresent = false;
let turnOutputSchemaPresent = false;
let consultationField = "missing-consultation-field";
let isAdvisorSchema = false;
let pendingFinalPrompt = "";
process.stderr.write("fake app-server warning\\n");

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const complete = (prompt, leaderResponse = "") => {
  if (sandbox === "${CODEX_EXECUTOR_PROFILE}") {
    writeFileSync(join(process.cwd(), "codex-executed.txt"), "executor ran\\n", "utf8");
  }
  const evidence = [model, sandbox, prompt.includes("Research Pi") ? "role-present" : "role-missing", deltaNotificationsOptedOut ? "delta-opt-out" : "delta-not-opted-out", hostToolPresent ? "host-tool-present" : "host-tool-missing", submissionToolPresent ? "submission-tool-present" : "submission-tool-missing", turnOutputSchemaPresent ? "turn-schema-present" : "turn-schema-absent", consultationField, process.env.SSH_AUTH_SOCK ? "child-ssh-agent-present" : "child-ssh-agent-absent", leaderResponse].filter(Boolean);
  let result = isAdvisorSchema ? {
    status: "working_synthesis",
    shared_understanding: "The question is still being clarified.",
    points_of_agreement: ["Keep the research objective with Research Pi"],
    candidate_explanations: ["candidate A", "candidate B"],
    questions_to_resolve: ["Which observation would distinguish them?"],
    evidence,
    uncertainties: [],
    working_synthesis: isResume ? "resumed consultation" : "finished collaborative consultation",
    suggested_next_exchange: "Continue the same mission after answering the open question"
  } : {
    outcome: "succeeded",
    goal_satisfied: true,
    completion_basis: "The delegated fake objective and check completed.",
    summary: isResume ? "resumed" : "finished",
    evidence,
    actions_taken: ["fake action"],
    changed_files: sandbox === "${CODEX_EXECUTOR_PROFILE}" ? ["codex-executed.txt"] : [],
    checks: [{ command: "fake-check", result: "passed" }],
    external_effects: [],
    uncertainties: [],
    remaining_work: [],
    recommended_next_step: "inspect result"
  };
  if (!isAdvisorSchema && prompt.includes("legacy completed false")) {
    result = {
      status: "completed",
      goal_satisfied: false,
      summary: "legacy checkpoint",
      evidence: [],
      actions_taken: [],
      changed_files: [],
      checks: [],
      external_effects: [],
      uncertainties: [],
      recommended_next_step: "finish the delegated implementation"
    };
  }
  pendingFinalPrompt = prompt;
  send({ id: "server-submit-result-1", method: "item/tool/call", params: { threadId: "thread-fake-123", turnId: activeTurn, callId: "submit-call-1", tool: "submit_research_pi_result", arguments: result } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    deltaNotificationsOptedOut = message.params.capabilities?.optOutNotificationMethods?.includes("item/agentMessage/delta") ?? false;
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "test", codexHome: process.cwd() } });
  } else if (message.method === "thread/start") {
    model = message.params.model;
    hostToolPresent = message.params.dynamicTools?.some((tool) => tool.name === "research_pi_host") ?? false;
    const consultation = message.params.dynamicTools?.find((tool) => tool.name === "consult_research_pi");
    const submission = message.params.dynamicTools?.find((tool) => tool.name === "submit_research_pi_result");
    submissionToolPresent = Boolean(submission);
    isAdvisorSchema = submission?.inputSchema?.required?.includes("shared_understanding") ?? false;
    consultationField = consultation?.inputSchema?.required?.includes("why_it_matters") ? "why-it-matters" : consultation?.inputSchema?.required?.includes("why_blocking") ? "why-blocking" : "missing-consultation-field";
    send({ id: message.id, result: { thread: { id: "thread-fake-123", turns: [] } } });
    send({ method: "thread/started", params: { thread: { id: "thread-fake-123", turns: [] } } });
  } else if (message.method === "thread/resume") {
    model = message.params.model;
    hostToolPresent = message.params.dynamicTools?.some((tool) => tool.name === "research_pi_host") ?? false;
    const consultation = message.params.dynamicTools?.find((tool) => tool.name === "consult_research_pi");
    const submission = message.params.dynamicTools?.find((tool) => tool.name === "submit_research_pi_result");
    submissionToolPresent = Boolean(submission);
    isAdvisorSchema = submission?.inputSchema?.required?.includes("shared_understanding") ?? false;
    consultationField = consultation?.inputSchema?.required?.includes("why_it_matters") ? "why-it-matters" : consultation?.inputSchema?.required?.includes("why_blocking") ? "why-blocking" : "missing-consultation-field";
    isResume = true;
    send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
    send({ method: "thread/started", params: { thread: { id: message.params.threadId, turns: [] } } });
  } else if (message.method === "turn/start") {
    activeTurn = "turn-fake-456";
    turnOutputSchemaPresent = Boolean(message.params.outputSchema);
    const prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: activeTurn, status: "inProgress", items: [], error: null } } });
    send({ method: "turn/started", params: { threadId: "thread-fake-123", turn: { id: activeTurn, status: "inProgress", items: [], error: null } } });
	if (prompt.includes("crash after side effect barrier")) {
		setTimeout(() => process.exit(23), 10);
		return;
	}
    if (prompt.includes("delta storm")) {
      for (let index = 0; index < 1000; index += 1) {
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-fake-123", turnId: activeTurn, itemId: "message-1", delta: "x" } });
      }
    }
    if (prompt.includes("foreign thread completion")) {
      const foreignThread = "thread-memory-unrelated";
      const foreignTurn = "turn-memory-unrelated";
      const foreignResult = JSON.stringify({ status: "inconclusive", goal_satisfied: false, summary: "foreign memory inventory" });
      send({ method: "thread/started", params: { thread: { id: foreignThread, turns: [] } } });
      send({ method: "turn/started", params: { threadId: foreignThread, turn: { id: foreignTurn, status: "inProgress", items: [], error: null } } });
      send({ method: "item/completed", params: { threadId: foreignThread, turnId: foreignTurn, item: { id: "foreign-message", type: "agentMessage", phase: "final_answer", text: foreignResult } } });
      send({ method: "turn/completed", params: { threadId: foreignThread, turn: { id: foreignTurn, status: "completed", items: [], error: null } } });
    }
    if (prompt.includes("parallel objective activity")) {
      send({ method: "item/started", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "parallel-one", type: "commandExecution", status: "inProgress", command: "python3 probe-a.py", cwd: process.cwd() } } });
      send({ method: "item/started", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "parallel-two", type: "commandExecution", status: "inProgress", command: "python3 probe-b.py", cwd: process.cwd() } } });
    } else if (prompt.includes("objective activity")) {
      send({ method: "item/started", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "command-observed", type: "commandExecution", status: "inProgress", command: "python3 probe.py", commandActions: [], cwd: process.cwd(), durationMs: null, exitCode: null, aggregatedOutput: null } } });
      send({ method: "item/completed", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "command-observed", type: "commandExecution", status: "completed", command: "python3 probe.py", commandActions: [], cwd: process.cwd(), durationMs: 12, exitCode: 0, aggregatedOutput: "probe-ok" } } });
      send({ method: "item/completed", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "collab-observed", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", senderThreadId: "thread-fake-123", receiverThreadIds: ["thread-child-1"], agentsStates: { "thread-child-1": { status: "running", message: "checking probe" } }, model: "gpt-5.6-luna", reasoningEffort: "high", prompt: "Check the probe result" } } });
    }
    if (prompt.includes("ask the leader live")) {
      send({ id: "server-question-1", method: "item/tool/call", params: { threadId: "thread-fake-123", turnId: activeTurn, callId: "call-1", tool: "consult_research_pi", arguments: { audience: "leader", question: "Choose H1 or H2", why_blocking: "The experiment differs", options: ["H1", "H2"] } } });
    } else if (prompt.includes("HOST_READ_PATH=")) {
      const path = prompt.match(/HOST_READ_PATH=([^\\n<]+)/)?.[1]?.trim();
      send({ id: "server-host-read-1", method: "item/tool/call", params: { threadId: "thread-fake-123", turnId: activeTurn, callId: "host-call-1", tool: "research_pi_host", arguments: { action: "read", path } } });
    } else if (prompt.includes("HOST_COMMAND_PATH=")) {
      const path = prompt.match(/HOST_COMMAND_PATH=([^\\n<]+)/)?.[1]?.trim();
      const grantId = prompt.match(/HOST_COMMAND_GRANT=(grant-[A-Za-z0-9]{8})/)?.[1];
      send({ id: "server-host-command-1", method: "item/tool/call", params: { threadId: "thread-fake-123", turnId: activeTurn, callId: "host-command-1", tool: "research_pi_host", arguments: { action: "command", argv: [process.execPath, path, "from-codex"], ...(grantId ? { grantId } : { cwd: process.cwd() }) } } });
    } else {
      completionTimer = setTimeout(() => complete(prompt), ${delayMs});
    }
  } else if (message.id === "server-question-1") {
    const answer = message.result?.contentItems?.[0]?.text ?? "missing answer";
    complete("Research Pi", answer);
  } else if (message.id === "server-host-read-1") {
    const answer = message.result?.contentItems?.[0]?.text ?? message.error?.message ?? "missing host response";
    complete("Research Pi", answer);
  } else if (message.id === "server-host-command-1") {
    const answer = message.result?.contentItems?.[0]?.text ?? message.error?.message ?? "missing host response";
    complete("Research Pi", answer);
  } else if (message.id === "server-submit-result-1") {
    send({ method: "item/completed", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "message-1", type: "agentMessage", phase: "final_answer", text: "Structured handoff submitted." } } });
    if (pendingFinalPrompt.includes("late commentary after final")) {
      send({ method: "item/completed", params: { threadId: "thread-fake-123", turnId: activeTurn, item: { id: "message-commentary", type: "agentMessage", phase: "commentary", text: "late commentary must not replace the submitted result" } } });
    }
    send({ method: "turn/completed", params: { threadId: "thread-fake-123", turn: { id: activeTurn, status: "completed", items: [], error: null } } });
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

test("delegation prompt makes advisor collaborative while preserving executor authority", () => {
	const advisor = buildDelegationPrompt({ mode: "advisor", task: "inspect", successCriteria: [], context: "" });
	assert.match(advisor, /read-only research advisor collaborating with Research Pi/);
	assert.match(advisor, /question may be incomplete/);
	assert.match(advisor, /jointly expand substantively different candidate explanations/);
	assert.match(advisor, /do not need to wait until progress is completely blocked/);
	assert.match(advisor, /continuation surface, not a verdict or review score/);
	assert.doesNotMatch(advisor, /challenge weak assumptions|return a concrete proposal|independent critique/);
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
	assert.match(executor, /phase=commentary/);
	assert.match(executor, /phase=final_answer/);
	assert.match(executor, /never encode a plan, preamble, checkpoint/);
	assert.match(executor, /hypothesis H1/);
});

test("continuation notice detects stale Git state without copying filenames", () => {
	const previous = {
		id: "codex-2026-08-11-00000000",
		threadId: "thread-1",
		gitAfter: {
			branch: "main",
			commit: "a".repeat(40),
			dirty: true,
			status: " M secret-looking-filename.txt",
		},
	};
	const notice = buildCodexContinuationNotice(previous, {
		branch: "experiment",
		commit: "b".repeat(40),
		dirty: false,
		status: "",
	});
	assert.match(notice, /workspace changed/);
	assert.match(notice, /Treat prior file observations as stale/);
	assert.doesNotMatch(notice, /secret-looking-filename/);
});

test("Codex environment removes provider credentials without dropping execution access", () => {
	const env = sanitizeCodexEnvironment({
		PATH: "/bin",
		HOME: "/tmp/example-home",
		SSH_AUTH_SOCK: "/tmp/ssh.sock",
		DEEPSEEK_API_KEY: "secret",
		OPENCODE_API_KEY: "secret-too",
	});
	assert.equal(env.DEEPSEEK_API_KEY, undefined);
	assert.equal(env.OPENCODE_API_KEY, undefined);
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
		assert.equal(advisor.result.status, "working_synthesis");
		assert.equal(advisor.result.working_synthesis, "finished collaborative consultation");
		assert.equal(advisor.threadId, "thread-fake-123");
		assert.match(advisor.result.evidence.join("\n"), /child-ssh-agent-absent/);
		assert.match(advisor.result.evidence.join("\n"), /why-it-matters/);
		assert.equal(
			JSON.parse(readFileSync(join(jobRoot, advisorStart.id, "request.json"), "utf8")).schemaPath,
			DEFAULT_CODEX_ADVISOR_SCHEMA_PATH,
		);

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
		assert.equal(executor.result.outcome, "succeeded");
		assert.equal(executor.result.goal_satisfied, true);
		assert.equal(executor.result.status, undefined);
		assert.deepEqual(executor.result.remaining_work, []);
		assert.equal(executor.resultSource, "submit_research_pi_result");
		assert.match(executor.result.evidence.join("\n"), /why-blocking/);
		assert.match(executor.result.evidence.join("\n"), /submission-tool-present/);
		assert.match(executor.result.evidence.join("\n"), /turn-schema-absent/);
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

test("submitted executor result cannot be replaced by a later commentary item", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-phase-result-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const completed = await waitForCodexJob((await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin: makeFakeCodex(root),
			mode: "executor",
			task: "late commentary after final protocol smoke",
		})).id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.equal(completed.result.outcome, "succeeded");
		assert.equal(completed.result.goal_satisfied, true);
		assert.equal(completed.result.summary, "finished");
		assert.doesNotMatch(completed.result.summary, /late commentary/);
		assert.equal(completed.resultSource, "submit_research_pi_result");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy completed plus goal_satisfied false normalizes to a partial outcome", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-legacy-outcome-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const completed = await waitForCodexJob((await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin: makeFakeCodex(root),
			mode: "executor",
			task: "legacy completed false protocol smoke",
		})).id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.equal(completed.result.status, undefined);
		assert.equal(completed.result.outcome, "partial");
		assert.equal(completed.result.goal_satisfied, false);
		assert.deepEqual(completed.result.remaining_work, ["finish the delegated implementation"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("executor crash after the durable side-effect barrier requires explicit reconciliation", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-unknown-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "executor",
			task: "crash after side effect barrier",
		});
		const unknown = await waitForCodexJob(started.id, { jobRoot, pollMs: 20 });
		assert.equal(unknown.status, "outcome_unknown");
		assert.equal(unknown.sideEffect.state, "unknown");
		await assert.rejects(
			startCodexJob({ cwd: workspace, jobRoot, codexBin, mode: "executor", task: "must not overlap an unknown writer" }),
			/outcome is unknown/,
		);

		const advisor = await waitForCodexJob((await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: "inspect the ambiguous executor state",
		})).id, { jobRoot });
		assert.equal(advisor.status, "completed");

		const reconciled = await reconcileCodexJobOutcome(started.id, {
			jobRoot,
			outcome: "failed",
			note: "Inspected Git status and the expected output marker; no intended change was completed.",
		});
		assert.equal(reconciled.status, "failed");
		assert.equal(reconciled.sideEffect.state, "settled");
		assert.match(reconciled.sideEffect.reconciliationNote, /Inspected Git status/);

		const retry = await waitForCodexJob((await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "executor",
			task: "retry after evidence-based reconciliation",
		})).id, { jobRoot });
		assert.equal(retry.status, "completed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unrelated app-server threads cannot replace or complete the owned Codex turn", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-thread-scope-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root, 40);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: "foreign thread completion protocol smoke",
		});
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.equal(completed.threadId, "thread-fake-123");
		assert.equal(completed.result.status, "working_synthesis");
		assert.equal(completed.result.working_synthesis, "finished collaborative consultation");
		assert.ok(completed.workerIo.foreignMessagesIgnored >= 4, JSON.stringify(completed.workerIo));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("mission routing reuses only the same mode and workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-mission-"));
	try {
		const workspace = join(root, "workspace");
		const otherWorkspace = join(root, "other-workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(otherWorkspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const firstStart = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "executor",
			mission: "R2a qualification",
			task: "implement the first probe",
		});
		const first = await waitForCodexJob(firstStart.id, { jobRoot });
		assert.equal(first.mission, "R2a qualification");
		assert.match(first.projectKey, /^project-/);
		assert.match(first.workspaceKey, /^workspace-/);

		const reusable = await findReusableCodexJob({
			cwd: workspace,
			jobRoot,
			mode: "executor",
			mission: "  R2a   qualification  ",
		});
		assert.equal(reusable.id, first.id);
		assert.equal(
			await findReusableCodexJob({ cwd: workspace, jobRoot, mode: "advisor", mission: "R2a qualification" }),
			null,
		);
		assert.equal(
			await findReusableCodexJob({ cwd: otherWorkspace, jobRoot, mode: "executor", mission: "R2a qualification" }),
			null,
		);

		const resumedStart = await resumeCodexJob(first.id, {
			cwd: workspace,
			expectedCwd: workspace,
			jobRoot,
			codexBin,
			followUp: "debug the same qualification mission",
		});
		const resumed = await waitForCodexJob(resumedStart.id, { jobRoot, expectedCwd: workspace });
		assert.equal(resumed.continuationOf, first.id);
		assert.equal(resumed.mission, "R2a qualification");
		assert.equal(resumed.threadId, first.threadId);
		const persistedRequest = readFileSync(join(jobRoot, resumed.id, "request.json"), "utf8");
		assert.match(persistedRequest, /continues Codex thread/);

		const missions = await listCodexMissions({ cwd: workspace, jobRoot });
		assert.equal(missions.length, 1);
		assert.equal(missions[0].mission, "R2a qualification");
		assert.equal(missions[0].jobCount, 2);
		assert.equal(missions[0].latestJobId, resumed.id);

		await assert.rejects(
			readCodexJob(first.id, { jobRoot, expectedCwd: otherWorkspace }),
			/belongs to another workspace/,
		);
		await assert.rejects(
			resumeCodexJob(first.id, {
				jobRoot,
				codexBin,
				expectedCwd: otherWorkspace,
				followUp: "wrong workspace",
			}),
			/belongs to another workspace/,
		);
		await assert.rejects(
			resumeCodexJob(first.id, {
				jobRoot,
				codexBin,
				expectedCwd: workspace,
				mission: "different mission",
				followUp: "silently reclassify",
			}),
			/belongs to mission/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("automatic Codex reuse stays on one research route while explicit continuation crosses with a warning", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-route-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const firstStart = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			mission: "compare world-model objectives",
			task: "inspect route A",
			projectRevision: 4,
			researchTrackRef: "transition:route-a",
			researchTrackLabel: "route A",
		});
		const first = await waitForCodexJob(firstStart.id, { jobRoot });
		assert.equal((await findReusableCodexJob({
			cwd: workspace,
			jobRoot,
			mode: "advisor",
			mission: "compare world-model objectives",
			researchTrackRef: "transition:route-a",
		})).id, first.id);
		assert.equal(await findReusableCodexJob({
			cwd: workspace,
			jobRoot,
			mode: "advisor",
			mission: "compare world-model objectives",
			researchTrackRef: "transition:route-b",
		}), null);

		const resumedStart = await resumeCodexJob(first.id, {
			cwd: workspace,
			expectedCwd: workspace,
			jobRoot,
			codexBin,
			followUp: "re-evaluate under route B",
			projectRevision: 5,
			researchTrackRef: "transition:route-b",
			researchTrackLabel: "route B",
		});
		const resumed = await waitForCodexJob(resumedStart.id, { jobRoot, expectedCwd: workspace });
		assert.equal(resumed.researchTrackRef, "transition:route-b");
		assert.equal(resumed.projectRevision, 5);
		assert.match(readFileSync(join(jobRoot, resumed.id, "request.json"), "utf8"), /RESEARCH ROUTE CHANGED from transition:route-a to transition:route-b/);

		const missions = await listCodexMissions({ cwd: workspace, jobRoot });
		assert.equal(missions.length, 2);
		assert.deepEqual(new Set(missions.map((item) => item.researchTrackRef)), new Set([
			"transition:route-a",
			"transition:route-b",
		]));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sibling branches in one Pi session cannot observe or reuse each other's Codex jobs", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-branch-owner-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const sessionId = "pi-session-shared-tree";
		const branchA = new Set(["root-entry", "branch-a-user"]);
		const branchB = new Set(["root-entry", "branch-b-user"]);

		const startA = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			mission: "shared-mission-name",
			task: "analyze branch A",
			leaderSessionId: sessionId,
			leaderBranchAnchorId: "branch-a-user",
		});
		const jobA = await waitForCodexJob(startA.id, { jobRoot });
		const startB = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			mission: "shared-mission-name",
			task: "analyze branch B",
			leaderSessionId: sessionId,
			leaderBranchAnchorId: "branch-b-user",
		});
		const jobB = await waitForCodexJob(startB.id, { jobRoot });
		await waitForCodexJob((await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			mission: "legacy-ownerless",
			task: "legacy compatibility fixture",
			leaderSessionId: sessionId,
		})).id, { jobRoot });

		const jobsA = await listCodexJobs({
			jobRoot,
			cwd: workspace,
			leaderSessionId: sessionId,
			branchEntryIds: branchA,
		});
		const jobsB = await listCodexJobs({
			jobRoot,
			cwd: workspace,
			leaderSessionId: sessionId,
			branchEntryIds: branchB,
		});
		assert.deepEqual(jobsA.map((job) => job.id), [jobA.id]);
		assert.deepEqual(jobsB.map((job) => job.id), [jobB.id]);

		const reusableA = await findReusableCodexJob({
			cwd: workspace,
			jobRoot,
			mode: "advisor",
			mission: "shared-mission-name",
			leaderSessionId: sessionId,
			branchEntryIds: branchA,
		});
		assert.equal(reusableA.id, jobA.id);
		assert.equal((await listCodexMissions({
			cwd: workspace,
			jobRoot,
			leaderSessionId: sessionId,
			branchEntryIds: branchA,
		}))[0].latestJobId, jobA.id);

		await assert.rejects(
			readCodexJob(jobB.id, {
				jobRoot,
				expectedCwd: workspace,
				expectedLeaderSessionId: sessionId,
				expectedBranchEntryIds: branchA,
			}),
			/belongs to another branch/,
		);
		await assert.rejects(
			readCodexJob(jobA.id, {
				jobRoot,
				expectedCwd: workspace,
				expectedLeaderSessionId: "another-session",
				expectedBranchEntryIds: branchA,
			}),
			/belongs to another Pi session/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project Actor ownership survives Pi session rotation without crossing workspaces", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-project-actor-"));
	try {
		const workspace = join(root, "workspace");
		const otherWorkspace = join(root, "other-workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(otherWorkspace, { recursive: true });
		const codexBin = makeFakeCodex(root);
		const leaderActorId = "research-leader";
		const actorId = "codex:mission-project-runtime:advisor";
		const firstStart = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			mission: "project runtime handoff",
			task: "inspect the project runtime boundary",
			leaderSessionId: "pi-session-a",
			leaderBranchAnchorId: "branch-a",
			leaderActorId,
			actorId,
		});
		const first = await waitForCodexJob(firstStart.id, { jobRoot });
		const actorScope = {
			expectedCwd: workspace,
			expectedProjectKey: first.projectKey,
			expectedLeaderActorId: leaderActorId,
		};

		const seenFromSessionB = await readCodexJob(first.id, { jobRoot, ...actorScope });
		assert.equal(seenFromSessionB.leaderSessionId, "pi-session-a");
		assert.equal(seenFromSessionB.leaderActorId, leaderActorId);
		assert.equal(seenFromSessionB.actorId, actorId);
		const reusable = await findReusableCodexJob({
			cwd: workspace,
			jobRoot,
			mode: "advisor",
			mission: "project runtime handoff",
			projectKey: first.projectKey,
			leaderActorId,
			actorId,
		});
		assert.equal(reusable.id, first.id);

		const resumedStart = await resumeCodexJob(first.id, {
			jobRoot,
			codexBin,
			followUp: "continue from Pi session B",
			leaderSessionId: "pi-session-b",
			leaderBranchAnchorId: "branch-b",
			leaderActorId,
			actorId,
			...actorScope,
		});
		const resumed = await waitForCodexJob(resumedStart.id, { jobRoot, ...actorScope });
		assert.equal(resumed.status, "completed");
		assert.equal(resumed.leaderSessionId, "pi-session-b");
		assert.equal(resumed.leaderActorId, leaderActorId);
		assert.equal(resumed.actorId, actorId);
		assert.equal(resumed.threadId, first.threadId);
		assert.equal(resumed.continuationOf, first.id);

		await assert.rejects(
			readCodexJob(first.id, { jobRoot, expectedCwd: otherWorkspace, expectedProjectKey: first.projectKey, expectedLeaderActorId: leaderActorId }),
			/belongs to another workspace/,
		);
		await assert.rejects(
			readCodexJob(first.id, { jobRoot, expectedCwd: workspace, expectedProjectKey: first.projectKey, expectedLeaderActorId: "another-leader" }),
			/belongs to another Runtime leader Actor/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an active Codex Actor accepts cross-session steer and cancellation through project ownership", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-project-steer-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root, 10_000);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			mission: "live project actor",
			task: "stay active for steering",
			leaderSessionId: "pi-session-a",
			leaderBranchAnchorId: "branch-a",
			leaderActorId: "research-leader",
			actorId: "codex:mission-live-project-actor:advisor",
		});
		let running;
		for (let attempt = 0; attempt < 200; attempt++) {
			running = await readCodexJob(started.id, { jobRoot });
			if (running.activeTurnId) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(running.activeTurnId, JSON.stringify(running));
		const actorScope = {
			expectedCwd: workspace,
			expectedProjectKey: running.projectKey,
			expectedLeaderActorId: "research-leader",
		};
		const steering = await steerCodexJob(started.id, {
			jobRoot,
			message: "Use the corrected validity criterion.",
			...actorScope,
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			const command = JSON.parse(readFileSync(join(jobRoot, started.id, "commands", `${steering.command.id}.json`), "utf8"));
			if (command.status === "applied") break;
			if (command.status === "failed") assert.fail(command.error);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(
			JSON.parse(readFileSync(join(jobRoot, started.id, "commands", `${steering.command.id}.json`), "utf8")).status,
			"applied",
		);
		const cancelled = await cancelCodexJob(started.id, { jobRoot, ...actorScope });
		assert.equal(cancelled.status, "cancelled");
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

		const waiting = await waitForCodexJob(started.id, {
			jobRoot,
			returnOnInputRequired: (job) => job.pendingRequest?.kind === "leader_consultation",
		});
		assert.equal(waiting.status, "input_required");
		assert.equal(waiting.pendingRequest?.question, "Choose H1 or H2", JSON.stringify(waiting));
		assert.equal(waiting?.activeTurnId, "turn-fake-456");
		const pausedWorkerPid = waiting.workerPid;
		const pausedThreadId = waiting.threadId;

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
		assert.equal(completed.workerPid, pausedWorkerPid, "Leader response must continue the same Codex worker");
		assert.equal(completed.threadId, pausedThreadId, "Leader response must continue the same Codex thread");
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

test("App Server objective command and subagent events reach the bounded audit projection", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-observe-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const codexBin = makeFakeCodex(root, 500);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "advisor",
			task: "emit objective activity for the TUI",
		});
		let active;
		for (let attempt = 0; attempt < 100; attempt++) {
			const current = await readCodexJob(started.id, { jobRoot });
			if (current.lastActivity?.category === "subagent") {
				active = current;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(active?.status, "running", JSON.stringify(active));
		assert.equal(active?.progress, "Codex turn running");
		assert.equal(active?.currentActivity, null);
		assert.equal(active?.lastActivity?.status, "completed");
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.status, "completed");
		const events = readFileSync(join(jobRoot, started.id, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const command = events.find((event) => event.category === "command" && event.phase === "completed");
		assert.equal(command.exitCode, 0);
		assert.equal(command.outputTail, "probe-ok");
		const subagent = events.find((event) => event.category === "subagent");
		assert.deepEqual(subagent.receiverThreadIds, ["thread-child-1"]);
		assert.equal(subagent.model, "gpt-5.6-luna");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parallel objective activities remain separately visible in live job state", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-parallel-ui-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(workspace, { recursive: true });
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin: makeFakeCodex(root, 500),
			mode: "advisor",
			task: "emit parallel objective activity for the TUI",
		});
		let active;
		for (let attempt = 0; attempt < 100; attempt++) {
			const current = await readCodexJob(started.id, { jobRoot });
			if (current.activeActivityCount === 2) {
				active = current;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(active?.status, "running", JSON.stringify(active));
		assert.equal(active?.activeActivityCount, 2);
		assert.deepEqual(active?.activeActivities.map((activity) => activity.id), ["parallel-one", "parallel-two"]);
		assert.ok(active?.activeActivities.every((activity) => activity.threadId === "thread-fake-123"));
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.activeActivityCount, 0);
		assert.deepEqual(completed.activeActivities, []);
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

test("Codex executor reuses a project-trusted host-command prefix", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-host-command-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(join(workspace, ".git"), { recursive: true });
		const worktree = join(workspace, ".worktrees", "experiment-a");
		mkdirSync(worktree, { recursive: true });
		const commandScript = join(workspace, "host-command.mjs");
		writeFileSync(commandScript, "process.stdout.write(`host-command:${process.argv[2]}:cwd=${process.cwd()}`);\n", { mode: 0o600 });
		const hostCapabilityContext = await resolveCapabilityContext(workspace, "pi-session-host-command", {
			stateRoot: join(root, "capabilities"),
		});
		const request = await prepareCapabilityRequest(hostCapabilityContext, {
			kind: "host-command",
			cwd: worktree,
			argv: [process.execPath, commandScript, "seed"],
		});
		const grant = await createCapabilityGrant(hostCapabilityContext, request, "project");
		const codexBin = makeFakeCodex(root);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "executor",
			task: `Execute the trusted project command. HOST_COMMAND_PATH=${commandScript}\nHOST_COMMAND_GRANT=${grant.id}`,
			leaderSessionId: "pi-session-host-command",
			hostCapabilityContext,
		});
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.match(completed.result.evidence.join("\n"), /host-command:from-codex/);
		assert.match(completed.result.evidence.join("\n"), new RegExp(`cwd=${grant.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing Codex host grant becomes structured input and resumes the same tool call after approval", async () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-host-approval-"));
	try {
		const workspace = join(root, "workspace");
		const jobRoot = join(root, "codex", "jobs");
		mkdirSync(join(workspace, ".git"), { recursive: true });
		const commandScript = join(workspace, "host-command.mjs");
		writeFileSync(commandScript, "process.stdout.write(`approved-host-command:${process.argv[2]}:cwd=${process.cwd()}`);\n", { mode: 0o600 });
		const hostCapabilityContext = await resolveCapabilityContext(workspace, "pi-session-host-approval", {
			stateRoot: join(root, "capabilities"),
		});
		const codexBin = makeFakeCodex(root);
		const started = await startCodexJob({
			cwd: workspace,
			jobRoot,
			codexBin,
			mode: "executor",
			task: `Request a new host command. HOST_COMMAND_PATH=${commandScript}`,
			leaderSessionId: "pi-session-host-approval",
			hostCapabilityContext,
		});

		let waiting;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const current = await readCodexJob(started.id, { jobRoot });
			if (current.status === "input_required") {
				waiting = current;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(waiting?.pendingRequest?.kind, "host_capability", JSON.stringify(waiting));
		assert.equal(waiting?.pendingRequest?.audience, "user");
		assert.deepEqual(waiting?.pendingRequest?.capability?.input?.argv, [process.execPath, commandScript, "from-codex"]);
		assert.equal(waiting?.pendingRequest?.capability?.input?.cwd, realpathSync(workspace));

		const approvalRequest = await prepareCapabilityRequest(
			hostCapabilityContext,
			waiting.pendingRequest.capability.input,
		);
		const grant = await createCapabilityGrant(hostCapabilityContext, approvalRequest, "project");
		await respondToCodexJob(started.id, {
			jobRoot,
			requestId: waiting.pendingRequest.id,
			response: `Approved ${grant.id}`,
		});
		const completed = await waitForCodexJob(started.id, { jobRoot });
		assert.equal(completed.status, "completed");
		assert.match(completed.result.evidence.join("\n"), /approved-host-command:from-codex/);
		const requestRecord = JSON.parse(readFileSync(
			join(jobRoot, started.id, "requests", `${waiting.pendingRequest.id}.json`),
			"utf8",
		));
		assert.equal(requestRecord.status, "resolved");
		assert.equal(requestRecord.responseSha256.length, 64);
		assert.equal(completed.pendingRequest, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a workspace has one writer lease and cancellation preserves the side-effect boundary", async () => {
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
		assert.ok(["cancelled", "outcome_unknown"].includes(cancelled.status), JSON.stringify(cancelled));
		if (cancelled.status === "outcome_unknown") assert.equal(cancelled.sideEffect.state, "unknown");
		else assert.ok(["intent_recorded", "settled"].includes(cancelled.sideEffect.state));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
