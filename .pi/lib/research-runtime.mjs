import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexWorkspaceIdentity } from "./codex-jobs.mjs";
import { researchPiStateRoot } from "./runtime-paths.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(LIB_DIR, "../..");

export const RESEARCH_RUNTIME_VERSION = 1;
export const USER_ACTOR_ID = "user";
export const RESEARCH_LEADER_ACTOR_ID = "research-leader";
export const RUNTIME_MESSAGE_KIND = "research-runtime-message";
export const RUNTIME_EVENT_ENTRY_KIND = "research-runtime-event";
export const DEFAULT_RESEARCH_RUNTIME_ROOT = join(researchPiStateRoot(HARNESS_ROOT), "runtime", "projects");

const ACTOR_ID_PATTERN = /^[a-z][a-z0-9._:-]{0,191}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MESSAGE_TYPES = new Set(["ask", "reply", "notify", "result", "steer"]);
const MESSAGE_STATES = new Set(["delivered", "consumed", "superseded"]);
const ROTATION_STATES = new Set(["completed", "cancelled"]);
const MAX_MESSAGE_LENGTH = 16_000;
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_WAIT_MS = 10;
const LEDGER_LOCK_ATTEMPTS = 500;
const PROJECT_REVISION_EVENT_TYPES = new Set([
	"project.state.committed",
	"research.transition.recorded",
	"evidence.recorded",
]);

function now() {
	return new Date().toISOString();
}

function shortHash(value, length = 24) {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function validateActorId(actorId) {
	if (!ACTOR_ID_PATTERN.test(String(actorId ?? ""))) throw new Error(`Invalid Runtime actor id: ${actorId}`);
	return actorId;
}

function validateMessageId(messageId) {
	if (!MESSAGE_ID_PATTERN.test(String(messageId ?? ""))) throw new Error(`Invalid Runtime message id: ${messageId}`);
	return messageId;
}

function createEventId(prefix) {
	return `${prefix}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function createMessageId() {
	return createEventId("msg");
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withRuntimeLedgerLock(runtime, operation) {
	const lockPath = `${runtime.ledgerPath}.lock`;
	for (let attempt = 0; attempt < LEDGER_LOCK_ATTEMPTS; attempt++) {
		let handle;
		try {
			handle = await open(lockPath, "wx", 0o600);
			try {
				return await operation();
			} finally {
				await handle.close().catch(() => undefined);
				await unlink(lockPath).catch(() => undefined);
			}
		} catch (error) {
			if (handle) await handle.close().catch(() => undefined);
			if (error?.code !== "EEXIST") throw error;
			const age = await stat(lockPath).then((entry) => Date.now() - entry.mtimeMs).catch(() => 0);
			if (age > LEDGER_LOCK_STALE_MS) {
				await unlink(lockPath).catch(() => undefined);
				continue;
			}
			await delay(LEDGER_LOCK_WAIT_MS);
		}
	}
	throw new Error(`Timed out acquiring Research Runtime ledger lock: ${lockPath}`);
}

export function codexActorId({ missionKey, mission, jobId, mode } = {}) {
	const modeSuffix = mode ? `:${String(mode).toLowerCase()}` : "";
	if (missionKey) return validateActorId(`codex:${String(missionKey).toLowerCase()}${modeSuffix}`);
	const normalizedMission = String(mission ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
	if (normalizedMission) return `codex:mission-${shortHash(normalizedMission)}${modeSuffix}`;
	if (jobId) return validateActorId(`codex:${String(jobId).toLowerCase()}`);
	throw new Error("A Codex mission, mission key, or job id is required to derive an Actor id");
}

export function runtimeActorTarget(actor) {
	if (actor?.kind === "codex") return `codex:${shortHash(actor.id, 8)}`;
	return String(actor?.id ?? "");
}

export async function resolveResearchRuntime(cwd, options = {}) {
	const identity = await resolveCodexWorkspaceIdentity(cwd);
	const runtimeRoot = resolve(options.runtimeRoot ?? process.env.RESEARCH_PI_RUNTIME_DIR ?? DEFAULT_RESEARCH_RUNTIME_ROOT);
	const projectDir = join(runtimeRoot, identity.projectKey);
	return {
		...identity,
		runtimeRoot,
		projectDir,
		ledgerPath: join(projectDir, "events.jsonl"),
	};
}

export async function appendRuntimeEvent(runtime, eventType, data = {}, options = {}) {
	if (!runtime?.projectKey || !runtime?.ledgerPath) throw new Error("A resolved Research Runtime context is required");
	const event = {
		version: RESEARCH_RUNTIME_VERSION,
		id: options.id ?? createEventId("evt"),
		type: eventType,
		at: options.at ?? now(),
		projectKey: runtime.projectKey,
		data,
	};
	validateMessageId(event.id);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	if (!options.id) {
		await appendFile(runtime.ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		return event;
	}
	const findExisting = async () => (await readRuntimeEvents(runtime)).find((candidate) => candidate.id === event.id);
	const existing = await findExisting();
	if (existing) return existing;
	return await withRuntimeLedgerLock(runtime, async () => {
		const current = await findExisting();
		if (current) return current;
		await appendFile(runtime.ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		return event;
	});
}

export function runtimeRevisionFromEvents(events) {
	return events.reduce((revision, event) => revision + (PROJECT_REVISION_EVENT_TYPES.has(event.type) ? 1 : 0), 0);
}

export async function appendRuntimeEventAtRevision(runtime, eventType, data, expectedRevision, options = {}) {
	if (!runtime?.projectKey || !runtime?.ledgerPath) throw new Error("A resolved Research Runtime context is required");
	if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("A non-negative expected Project revision is required");
	const event = {
		version: RESEARCH_RUNTIME_VERSION,
		id: options.id ?? createEventId("evt"),
		type: eventType,
		at: options.at ?? now(),
		projectKey: runtime.projectKey,
		data,
	};
	validateMessageId(event.id);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		const events = await readRuntimeEvents(runtime);
		const existing = events.find((candidate) => candidate.id === event.id);
		if (existing) return { status: "existing", event: existing, revision: runtimeRevisionFromEvents(events) };
		const revision = runtimeRevisionFromEvents(events);
		if (revision !== expectedRevision) return { status: "conflict", event: null, revision };
		await appendFile(runtime.ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		return {
			status: "appended",
			event,
			revision: revision + (PROJECT_REVISION_EVENT_TYPES.has(eventType) ? 1 : 0),
		};
	});
}

export async function readRuntimeEvents(runtime) {
	let text;
	try {
		text = await readFile(runtime.ledgerPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const events = [];
	const seen = new Set();
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error(`Research Runtime ledger contains invalid JSON at line ${index + 1}`);
		}
		if (event.projectKey !== runtime.projectKey || seen.has(event.id)) continue;
		seen.add(event.id);
		events.push(event);
	}
	return events;
}

export async function readRuntimeSnapshot(runtime) {
	const actors = new Map();
	const attachments = new Map();
	const messages = new Map();
	const actions = new Map();
	const evidence = new Map();
	const transitions = [];
	const rotations = new Map();
	const rejectedStates = [];
	let projectState = null;
	let revision = 0;
	for (const event of await readRuntimeEvents(runtime)) {
		const data = event.data ?? {};
		if (PROJECT_REVISION_EVENT_TYPES.has(event.type)) revision += 1;
		switch (event.type) {
			case "actor.registered": {
				const current = actors.get(data.id) ?? {};
				actors.set(data.id, { ...current, ...data, createdAt: current.createdAt ?? data.createdAt ?? event.at, updatedAt: event.at });
				break;
			}
			case "actor.attached":
				attachments.set(data.actorId, { ...data, attachedAt: event.at });
				break;
			case "actor.detached": {
				const current = attachments.get(data.actorId);
				if (current?.sessionId === data.sessionId) attachments.delete(data.actorId);
				break;
			}
			case "message.queued":
				messages.set(data.id, { ...data, status: "queued", queuedAt: event.at });
				break;
			case "message.delivered":
			case "message.consumed":
			case "message.superseded": {
				const id = data.messageId;
				const current = messages.get(id);
				if (current) {
					const status = event.type.slice("message.".length);
					messages.set(id, { ...current, ...data, id, status, [`${status}At`]: event.at });
				}
				break;
			}
			case "action.upsert": {
				const current = actions.get(data.id) ?? {};
				actions.set(data.id, { ...current, ...data, createdAt: current.createdAt ?? data.createdAt ?? event.at, updatedAt: event.at });
				break;
			}
			case "project.state.committed":
				projectState = { ...data, committedAt: event.at, revision };
				break;
			case "project.state.rejected":
				rejectedStates.push({ ...data, rejectedAt: event.at });
				break;
			case "research.transition.recorded":
				transitions.push({ ...data, recordedAt: event.at, revision });
				break;
			case "evidence.recorded": {
				const current = evidence.get(data.id) ?? {};
				evidence.set(data.id, { ...current, ...data, recordedAt: event.at, revision });
				break;
			}
			case "session.rotation.requested":
				rotations.set(data.id, { ...data, status: "pending", requestedAt: event.at });
				break;
			case "session.rotation.completed":
			case "session.rotation.cancelled": {
				const id = data.rotationId;
				const current = rotations.get(id);
				if (current) {
					const status = event.type.slice("session.rotation.".length);
					rotations.set(id, { ...current, ...data, id, status, [`${status}At`]: event.at });
				}
				break;
			}
		}
	}
	const rotationList = [...rotations.values()];
	return {
		projectKey: runtime.projectKey,
		workspaceKey: runtime.workspaceKey,
		workspaceRoot: runtime.workspaceRoot,
		actors: [...actors.values()],
		attachments: [...attachments.values()],
		messages: [...messages.values()],
		actions: [...actions.values()],
		evidence: [...evidence.values()],
		transitions,
		activeTransition: transitions.at(-1) ?? null,
		rejectedStates,
		rotations: rotationList,
		pendingRotations: rotationList.filter((rotation) => rotation.status === "pending"),
		projectState,
		revision,
	};
}

export async function ensureRuntimeActor(runtime, actor) {
	validateActorId(actor.id);
	const snapshot = await readRuntimeSnapshot(runtime);
	const current = snapshot.actors.find((candidate) => candidate.id === actor.id);
	const next = {
		id: actor.id,
		kind: actor.kind ?? "agent",
		label: String(actor.label ?? actor.id).slice(0, 240),
		provider: actor.provider ?? null,
		metadata: actor.metadata ?? {},
	};
	if (
		current
		&& current.kind === next.kind
		&& current.label === next.label
		&& current.provider === next.provider
		&& JSON.stringify(current.metadata ?? {}) === JSON.stringify(next.metadata)
	) return current;
	await appendRuntimeEvent(runtime, "actor.registered", next, { id: `actor:${actor.id}:${shortHash(JSON.stringify(next), 16)}` });
	return { ...current, ...next };
}

export async function attachRuntimeActor(runtime, actorId, session) {
	validateActorId(actorId);
	const data = {
		actorId,
		sessionId: String(session.sessionId),
		branchAnchorId: session.branchAnchorId ?? null,
		workspaceKey: runtime.workspaceKey,
	};
	await appendRuntimeEvent(runtime, "actor.attached", data, {
		id: `attach:${actorId}:${shortHash(`${data.sessionId}:${data.branchAnchorId ?? ""}:${Date.now()}`, 20)}`,
	});
	return data;
}

export async function detachRuntimeActor(runtime, actorId, sessionId) {
	validateActorId(actorId);
	return await appendRuntimeEvent(runtime, "actor.detached", { actorId, sessionId: String(sessionId) });
}

export async function isRuntimeActorAttached(runtime, actorId, sessionId) {
	const snapshot = await readRuntimeSnapshot(runtime);
	return snapshot.attachments.some((attachment) => attachment.actorId === actorId && attachment.sessionId === sessionId);
}

export async function initializeResearchRuntime(cwd, session, options = {}) {
	const runtime = await resolveResearchRuntime(cwd, options);
	await ensureRuntimeActor(runtime, { id: USER_ACTOR_ID, kind: "user", label: "User" });
	await ensureRuntimeActor(runtime, {
		id: RESEARCH_LEADER_ACTOR_ID,
		kind: "leader",
		label: "Research Leader",
		provider: "pi",
	});
	await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, session);
	return runtime;
}

function boundedRuntimeText(value, max) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export async function recordRuntimeEvidence(runtime, record) {
	if (!record?.id) throw new Error("Project evidence id is required");
	const data = {
		id: String(record.id),
		timestamp: record.timestamp ?? now(),
		question: boundedRuntimeText(record.question, 1200),
		validityJudgment: ["valid", "invalid", "inconclusive"].includes(record.validityJudgment)
			? record.validityJudgment
			: "inconclusive",
		conclusion: boundedRuntimeText(record.conclusion, 2000),
		nextStep: boundedRuntimeText(record.nextStep, 1200),
		runId: boundedRuntimeText(record.runId, 300) || null,
		artifacts: Array.isArray(record.artifacts) ? record.artifacts.map((item) => boundedRuntimeText(item, 1000)).filter(Boolean).slice(0, 12) : [],
		source: {
			workspaceRoot: boundedRuntimeText(record.source?.workspaceRoot, 4000) || null,
			ledgerPath: boundedRuntimeText(record.source?.ledgerPath, 4000) || null,
			sessionId: boundedRuntimeText(record.source?.sessionId, 200) || null,
		},
	};
	return await appendRuntimeEvent(runtime, "evidence.recorded", data, { id: `evidence:${data.id}` });
}

export async function recordResearchTransition(runtime, transition) {
	const id = validateMessageId(transition.id ?? createEventId("transition"));
	const to = boundedRuntimeText(transition.to, 240);
	const reason = boundedRuntimeText(transition.reason, 3000);
	if (!to || !reason) throw new Error("Research transition requires the new active track and a reason");
	const authorityRefs = Array.isArray(transition.authorityRefs)
		? transition.authorityRefs.map((item) => boundedRuntimeText(item, 1000)).filter(Boolean).slice(0, 16)
		: [];
	if (!authorityRefs.length) throw new Error("Research transition requires at least one authority reference");
	const data = {
		id,
		from: boundedRuntimeText(transition.from, 240) || null,
		to,
		reason,
		oldDisposition: ["archived", "superseded", "parallel"].includes(transition.oldDisposition)
			? transition.oldDisposition
			: "superseded",
		nextDecision: boundedRuntimeText(transition.nextDecision, 2000) || null,
		authorityRefs,
		sessionId: transition.sessionId ?? null,
		workspaceRoot: transition.workspaceRoot ?? runtime.workspaceRoot,
		git: transition.git ? {
			root: boundedRuntimeText(transition.git.root, 4000) || null,
			branch: boundedRuntimeText(transition.git.branch, 500) || null,
			commit: boundedRuntimeText(transition.git.commit, 160) || null,
			dirty: transition.git.dirty ?? null,
		} : null,
	};
	await appendRuntimeEvent(runtime, "research.transition.recorded", data, { id: `research-transition:${id}` });
	return data;
}

export async function createRuntimeMessage(runtime, input) {
	const id = validateMessageId(input.id ?? createMessageId());
	const type = String(input.type ?? "");
	if (!MESSAGE_TYPES.has(type)) throw new Error(`Unsupported Runtime message type: ${type}`);
	const from = validateActorId(input.from);
	const to = validateActorId(input.to);
	const body = String(input.body ?? "").trim();
	if (!body) throw new Error("Runtime message body is required");
	if (body.length > MAX_MESSAGE_LENGTH) throw new Error(`Runtime message body must be at most ${MAX_MESSAGE_LENGTH} characters`);
	const message = {
		id,
		type,
		from,
		to,
		body,
		relatesTo: input.relatesTo ?? null,
		payloadRef: input.payloadRef ?? null,
		metadata: input.metadata ?? {},
	};
	const snapshot = await readRuntimeSnapshot(runtime);
	const existing = snapshot.messages.find((candidate) => candidate.id === id);
	if (existing) return existing;
	await appendRuntimeEvent(runtime, "message.queued", message, { id: `message:${id}:queued` });
	return { ...message, status: "queued" };
}

export async function settleRuntimeMessage(runtime, messageId, status, details = {}) {
	validateMessageId(messageId);
	if (!MESSAGE_STATES.has(status)) throw new Error(`Unsupported Runtime message state: ${status}`);
	await appendRuntimeEvent(runtime, `message.${status}`, { messageId, ...details }, {
		id: `message:${messageId}:${status}:${details.sessionId ?? details.actorId ?? "runtime"}`,
	});
	return { messageId, status, ...details };
}

export function pendingRuntimeMessages(snapshot, options = {}) {
	return snapshot.messages.filter((message) => {
		if (message.status !== "queued") return false;
		if (options.to && message.to !== options.to) return false;
		if (options.from && message.from !== options.from) return false;
		return true;
	});
}

export function unconsumedRuntimeMessages(snapshot, options = {}) {
	return snapshot.messages.filter((message) => {
		if (message.status !== "queued" && message.status !== "delivered") return false;
		if (options.to && message.to !== options.to) return false;
		if (options.from && message.from !== options.from) return false;
		if (options.forSessionId && message.status === "delivered" && message.sessionId === options.forSessionId) return false;
		return true;
	});
}

export async function requestRuntimeSessionRotation(runtime, input) {
	const fromSessionId = boundedRuntimeText(input.fromSessionId, 200);
	if (!fromSessionId) throw new Error("Runtime Session rotation requires a source Session id");
	const existing = (await readRuntimeSnapshot(runtime)).pendingRotations
		.find((rotation) => rotation.fromSessionId === fromSessionId);
	if (existing) return existing;
	const id = validateMessageId(input.id ?? createEventId("rotation"));
	const data = {
		id,
		fromSessionId,
		fromSessionFile: boundedRuntimeText(input.fromSessionFile, 4000) || null,
		projectRevision: Number.isInteger(input.projectRevision) ? input.projectRevision : 0,
		stateRevision: Number.isInteger(input.stateRevision) ? input.stateRevision : 0,
		projectViewFingerprint: boundedRuntimeText(input.projectViewFingerprint, 160) || null,
		projectViewFreshness: boundedRuntimeText(input.projectViewFreshness, 80) || null,
		reason: boundedRuntimeText(input.reason, 1200) || "manual Runtime rotation",
		activeActionIds: Array.isArray(input.activeActionIds) ? input.activeActionIds.map(String).slice(0, 32) : [],
		openMessageIds: Array.isArray(input.openMessageIds) ? input.openMessageIds.map(String).slice(0, 32) : [],
	};
	await appendRuntimeEvent(runtime, "session.rotation.requested", data, { id: `session-rotation:${id}:requested` });
	return { ...data, status: "pending" };
}

export async function settleRuntimeSessionRotation(runtime, rotationId, status, details = {}) {
	validateMessageId(rotationId);
	if (!ROTATION_STATES.has(status)) throw new Error(`Unsupported Runtime Session rotation state: ${status}`);
	const data = {
		rotationId,
		toSessionId: details.toSessionId ? String(details.toSessionId) : null,
		toSessionFile: boundedRuntimeText(details.toSessionFile, 4000) || null,
		projectRevision: Number.isInteger(details.projectRevision) ? details.projectRevision : null,
		projectViewFingerprint: boundedRuntimeText(details.projectViewFingerprint, 160) || null,
		projectViewFreshness: boundedRuntimeText(details.projectViewFreshness, 80) || null,
		reason: boundedRuntimeText(details.reason, 1200) || null,
	};
	await appendRuntimeEvent(runtime, `session.rotation.${status}`, data, {
		id: `session-rotation:${rotationId}:${status}`,
	});
	return { rotationId, status, ...data };
}

export async function upsertRuntimeAction(runtime, action) {
	if (!action?.id) throw new Error("Runtime Action id is required");
	const data = {
		id: String(action.id),
		kind: action.kind ?? "delegation",
		actorId: action.actorId ?? null,
		status: action.status ?? "queued",
		label: action.label ? String(action.label).slice(0, 240) : null,
		externalId: action.externalId ?? null,
		metadata: action.metadata ?? {},
	};
	await appendRuntimeEvent(runtime, "action.upsert", data, {
		id: `action:${data.id}:${data.status}:${shortHash(JSON.stringify(data), 12)}`,
	});
	return data;
}

export function resolveRuntimeActor(snapshot, rawTarget) {
	const target = String(rawTarget ?? "").trim().replace(/^@/, "").toLowerCase();
	if (!target) throw new Error("An Actor target is required");
	if (target === "leader" || target === "pi") return snapshot.actors.find((actor) => actor.id === RESEARCH_LEADER_ACTOR_ID);
	if (target === "me") return snapshot.actors.find((actor) => actor.id === USER_ACTOR_ID);
	const matches = snapshot.actors.filter((actor) => {
		if (actor.id.toLowerCase() === target) return true;
		if (runtimeActorTarget(actor).toLowerCase() === target) return true;
		if (String(actor.label ?? "").toLowerCase() === target) return true;
		const jobId = String(actor.metadata?.latestJobId ?? "").toLowerCase();
		return target.startsWith("codex:") && jobId.endsWith(target.slice("codex:".length));
	});
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Actor target @${target} is ambiguous; use the full Actor id from /actors`);
	throw new Error(`Unknown Actor @${target}; use /actors to inspect available targets`);
}

export function runtimeMessageText(message, actors = []) {
	const actor = actors.find((candidate) => candidate.id === message.from);
	const source = actor?.label ?? message.from;
	return [
		`[Research Runtime ${message.type} ${message.id} from ${source}]`,
		message.body,
		message.payloadRef ? `Payload: ${message.payloadRef}` : undefined,
	].filter(Boolean).join("\n");
}

export async function registerCodexRuntimeJob(runtime, job) {
	const actorId = job.actorId ?? codexActorId(job);
	await ensureRuntimeActor(runtime, {
		id: actorId,
		kind: "codex",
		label: job.mission ? `Codex · ${job.mission}` : `Codex · ${String(job.id).slice(-8)}`,
		provider: "codex",
		metadata: {
			mission: job.mission ?? null,
			missionKey: job.missionKey ?? null,
			mode: job.mode,
			model: job.model,
			threadId: job.threadId ?? null,
			latestJobId: job.id,
		},
	});
	await upsertRuntimeAction(runtime, {
		id: job.actionId ?? `action:${job.id}`,
		kind: "codex-delegation",
		actorId,
		status: job.status,
		label: job.mission ?? `${job.mode} ${String(job.id).slice(-8)}`,
		externalId: job.id,
		metadata: { threadId: job.threadId ?? null, mode: job.mode, model: job.model },
	});
	return actorId;
}

export async function recordCodexRuntimeEvent(runtime, job, content) {
	const actorId = await registerCodexRuntimeJob(runtime, job);
	const eventKey = job.status === "input_required" && job.pendingRequest?.id
		? `request:${job.pendingRequest.id}`
		: ["completed", "failed", "cancelled", "outcome_unknown"].includes(job.status)
			? `terminal:${job.status}`
			: null;
	if (!eventKey) return null;
	const messageId = `msg-codex-${shortHash(`${job.id}:${eventKey}`, 24)}`;
	return await createRuntimeMessage(runtime, {
		id: messageId,
		type: job.status === "input_required" ? "ask" : "result",
		from: actorId,
		to: RESEARCH_LEADER_ACTOR_ID,
		body: content,
		relatesTo: job.pendingRequest?.id ?? job.actionId ?? `action:${job.id}`,
		metadata: { jobId: job.id, status: job.status, requestId: job.pendingRequest?.id ?? null },
	});
}
