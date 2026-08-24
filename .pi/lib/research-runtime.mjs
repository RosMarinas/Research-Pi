import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexWorkspaceIdentity } from "./codex-jobs.mjs";
import { applyResearchStatePatch } from "./research-compact.mjs";
import { researchPiStateRoot } from "./runtime-paths.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(LIB_DIR, "../..");

export const RESEARCH_RUNTIME_VERSION = 1;
export const USER_ACTOR_ID = "user";
export const RESEARCH_LEADER_ACTOR_ID = "research-leader";
export const RUNTIME_MESSAGE_KIND = "research-runtime-message";
export const RUNTIME_EVENT_ENTRY_KIND = "research-runtime-event";
export const RUNTIME_SESSION_POLICY_ENTRY_KIND = "research-runtime-session-policy";
export const DEFAULT_RESEARCH_RUNTIME_ROOT = join(researchPiStateRoot(HARNESS_ROOT), "runtime", "projects");

export class RuntimeAttachmentChangedError extends Error {
	constructor(actorId) {
		super(`${actorId} attachment changed before the operation could be committed`);
		this.name = "RuntimeAttachmentChangedError";
		this.actorId = actorId;
	}
}

const ACTOR_ID_PATTERN = /^[a-z][a-z0-9._:-]{0,191}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MESSAGE_TYPES = new Set(["ask", "reply", "notify", "result", "steer"]);
const MESSAGE_STATES = new Set(["delivered", "consumed", "superseded"]);
const TERMINAL_MESSAGE_STATES = new Set(["consumed", "superseded"]);
const FINAL_ACTION_STATES = new Set(["completed", "failed", "cancelled"]);
const ROTATION_STATES = new Set(["completed", "cancelled"]);
const SESSION_INHERITANCE_POLICIES = new Set(["project", "clean", "analysis"]);
const SESSION_INHERITANCE_STATES = new Set(["applied", "cancelled"]);
const MAX_MESSAGE_LENGTH = 16_000;
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_WAIT_MS = 10;
const LEDGER_LOCK_ATTEMPTS = 500;
const PROJECT_REVISION_EVENT_TYPES = new Set([
	"project.state.committed",
	"project.state.amended",
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

export function analysisSessionActorId(sessionId) {
	return `analysis:${shortHash(String(sessionId ?? "unknown"), 24)}`;
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

async function repairRuntimeLedgerTail(runtime) {
	let handle;
	try {
		handle = await open(runtime.ledgerPath, "r+");
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.size) return;
		const lastByte = Buffer.allocUnsafe(1);
		await handle.read(lastByte, 0, 1, info.size - 1);
		if (lastByte[0] === 0x0a) return;

		const chunks = [];
		let cursor = info.size;
		let prefixBytes = 0;
		while (cursor > 0) {
			const length = Math.min(cursor, 64 * 1024);
			cursor -= length;
			const chunk = Buffer.allocUnsafe(length);
			await handle.read(chunk, 0, length, cursor);
			const newline = chunk.lastIndexOf(0x0a);
			if (newline >= 0) {
				prefixBytes = cursor + newline + 1;
				chunks.unshift(chunk.subarray(newline + 1));
				break;
			}
			chunks.unshift(chunk);
		}
		let validTail = true;
		try {
			JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			validTail = false;
		}
		if (validTail) await handle.write("\n", info.size, "utf8");
		else await handle.truncate(prefixBytes);
	} finally {
		await handle.close();
	}
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

function prepareRuntimeEvent(runtime, eventType, data = {}, options = {}) {
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
	return event;
}

async function writeRuntimeEvent(runtime, event) {
	await appendFile(runtime.ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function appendRuntimeEvent(runtime, eventType, data = {}, options = {}) {
	const event = prepareRuntimeEvent(runtime, eventType, data, options);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		if (options.id) {
			const current = (await readRuntimeEvents(runtime)).find((candidate) => candidate.id === event.id);
			if (current) return current;
		}
		await writeRuntimeEvent(runtime, event);
		return event;
	});
}

export function runtimeRevisionFromEvents(events) {
	return events.reduce((revision, event) => revision + (PROJECT_REVISION_EVENT_TYPES.has(event.type) ? 1 : 0), 0);
}

export async function appendRuntimeEventAtRevision(runtime, eventType, data, expectedRevision, options = {}) {
	if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("A non-negative expected Project revision is required");
	const event = prepareRuntimeEvent(runtime, eventType, data, options);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		const events = await readRuntimeEvents(runtime);
		const existing = events.find((candidate) => candidate.id === event.id);
		if (existing) return { status: "existing", event: existing, revision: runtimeRevisionFromEvents(events) };
		const revision = runtimeRevisionFromEvents(events);
		if (revision !== expectedRevision) return { status: "conflict", event: null, revision };
		await writeRuntimeEvent(runtime, event);
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
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			if (index === lines.length - 1 && !text.endsWith("\n")) break;
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
	const inheritanceRequests = new Map();
	const activations = new Map();
	const rejectedStates = [];
	let projectState = null;
	let revision = 0;
	const events = await readRuntimeEvents(runtime);
	for (const event of events) {
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
				if (
					current?.sessionId === data.sessionId
					&& (!data.attachmentEpoch || !current.epoch || current.epoch === data.attachmentEpoch)
				) attachments.delete(data.actorId);
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
					if (!TERMINAL_MESSAGE_STATES.has(current.status)) {
						messages.set(id, { ...current, ...data, id, status, [`${status}At`]: event.at });
					}
				}
				break;
			}
			case "action.upsert": {
				const current = actions.get(data.id) ?? {};
				const mayReconcileUnknown = current.status === "outcome_unknown" && FINAL_ACTION_STATES.has(data.status);
				if (!FINAL_ACTION_STATES.has(current.status) && (current.status !== "outcome_unknown" || mayReconcileUnknown)) {
					actions.set(data.id, { ...current, ...data, createdAt: current.createdAt ?? data.createdAt ?? event.at, updatedAt: event.at });
				}
				break;
			}
			case "actor.activation.started":
				activations.set(data.id, { ...data, status: "active", startedAt: event.at });
				break;
			case "actor.activation.settled": {
				const current = activations.get(data.activationId);
				if (current) activations.set(data.activationId, { ...current, ...data, id: data.activationId, status: "settled", settledAt: event.at });
				break;
			}
			case "project.state.committed":
				projectState = { ...data, committedAt: event.at, updatedAt: event.at, revision };
				break;
			case "project.state.amended":
				projectState = {
					...data,
					committedAt: projectState?.committedAt ?? event.at,
					amendedAt: event.at,
					updatedAt: event.at,
					revision,
				};
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
			case "session.inheritance.requested":
				inheritanceRequests.set(data.id, { ...data, status: "pending", requestedAt: event.at });
				break;
			case "session.inheritance.applied":
			case "session.inheritance.cancelled": {
				const current = inheritanceRequests.get(data.requestId);
				if (current?.status === "pending") {
					const status = event.type.slice("session.inheritance.".length);
					inheritanceRequests.set(data.requestId, {
						...current,
						...data,
						id: data.requestId,
						status,
						[`${status}At`]: event.at,
					});
				}
				break;
			}
		}
	}
	const rotationList = [...rotations.values()];
	const inheritanceRequestList = [...inheritanceRequests.values()];
	const activationList = [...activations.values()];
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
		inheritanceRequests: inheritanceRequestList,
		pendingInheritanceRequests: inheritanceRequestList.filter((request) => request.status === "pending"),
		activations: activationList,
		activeActivations: activationList.filter((activation) => activation.status === "active"),
		projectState,
		revision,
		ledgerEventCount: events.length,
	};
}

export function runtimeSessionInheritancePolicy(entries = [], snapshot = null, sessionId = null) {
	for (const entry of [...entries].reverse()) {
		if (entry?.type !== "custom" || entry.customType !== RUNTIME_SESSION_POLICY_ENTRY_KIND) continue;
		const policy = String(entry.data?.policy ?? "");
		if (SESSION_INHERITANCE_POLICIES.has(policy)) return policy;
	}
	if (snapshot && sessionId) {
		const applied = [...(snapshot.inheritanceRequests ?? [])].reverse().find((request) =>
			request.status === "applied" && request.toSessionId === String(sessionId),
		);
		if (SESSION_INHERITANCE_POLICIES.has(applied?.policy)) return applied.policy;
	}
	return "project";
}

export function runtimeResearchTrack(snapshot) {
	const transition = snapshot?.activeTransition;
	if (transition?.id) {
		return {
			ref: transition.trackRef ?? `transition:${transition.id}`,
			label: transition.to ?? "unnamed research track",
			transitionId: transition.id,
			fromTrackRef: transition.fromTrackRef ?? null,
			oldDisposition: transition.oldDisposition ?? null,
		};
	}
	return {
		ref: "project:initial",
		label: snapshot?.projectState?.state?.researchQuestion ?? "initial project track",
		transitionId: null,
		fromTrackRef: null,
		oldDisposition: null,
	};
}

export function runtimeTrackStatus(snapshot, trackRef) {
	const current = runtimeResearchTrack(snapshot);
	const ref = trackRef ?? "project:initial";
	if (ref === current.ref) return "current";
	const liveTracks = new Set(["project:initial"]);
	let primaryTrack = "project:initial";
	for (const transition of snapshot?.transitions ?? []) {
		const fromTrackRef = transition.fromTrackRef ?? primaryTrack;
		if (transition.oldDisposition !== "parallel") liveTracks.delete(fromTrackRef);
		const nextTrackRef = transition.trackRef ?? `transition:${transition.id}`;
		liveTracks.add(nextTrackRef);
		primaryTrack = nextTrackRef;
	}
	if (liveTracks.has(ref)) return "parallel";
	return "retired";
}

function runtimeTrackLabel(snapshot, trackRef) {
	if (trackRef === "project:initial") return "initial project track";
	const transition = (snapshot?.transitions ?? []).find((item) =>
		(item.trackRef ?? `transition:${item.id}`) === trackRef,
	);
	return transition?.to ?? null;
}

export function resolveRuntimeResearchTrack(snapshot, requestedTrackRef) {
	const current = runtimeResearchTrack(snapshot);
	const trackRef = String(requestedTrackRef ?? "").trim() || current.ref;
	const trackLabel = trackRef === current.ref ? current.label : runtimeTrackLabel(snapshot, trackRef);
	if (!trackLabel) throw new Error(`Unknown research track provenance: ${trackRef}`);
	return {
		trackRef,
		trackLabel,
		status: runtimeTrackStatus(snapshot, trackRef),
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
	const result = await claimRuntimeActorAttachment(runtime, actorId, session, { force: true });
	return result.attachment;
}

export async function withRuntimeActorAttachment(runtime, actorId, expected, operation) {
	validateActorId(actorId);
	const sessionId = String(expected.sessionId);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		const snapshot = await readRuntimeSnapshot(runtime);
		const attachment = runtimeActorAttachment(snapshot, actorId, sessionId);
		if (!attachment || (expected.attachmentEpoch && attachment.epoch !== expected.attachmentEpoch)) {
			throw new RuntimeAttachmentChangedError(actorId);
		}
		return await operation({ snapshot, attachment });
	});
}

export async function claimRuntimeActorAttachment(runtime, actorId, session, options = {}) {
	validateActorId(actorId);
	const data = {
		actorId,
		sessionId: String(session.sessionId),
		branchAnchorId: session.branchAnchorId ?? null,
		workspaceKey: runtime.workspaceKey,
		epoch: validateMessageId(session.epoch ?? createEventId("attachment")),
		reason: boundedRuntimeText(session.reason, 400) || null,
	};
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		const snapshot = await readRuntimeSnapshot(runtime);
		const current = runtimeActorAttachment(snapshot, actorId);
		if (
			current?.sessionId === data.sessionId
			&& current?.branchAnchorId === data.branchAnchorId
			&& current?.workspaceKey === data.workspaceKey
		) return { status: "current", attachment: current, activation: null };
		if (current && options.onlyIfUnattached) {
			return { status: "occupied", attachment: current, activation: null };
		}
		const activation = snapshot.activeActivations.find((item) =>
			item.actorId === actorId
			&& item.sessionId === current?.sessionId
			&& (!current?.epoch || item.attachmentEpoch === current.epoch),
		) ?? null;
		if (activation && !options.force) return { status: "busy", attachment: current ?? null, activation };
		const event = prepareRuntimeEvent(runtime, "actor.attached", data, { id: `actor-attachment:${data.epoch}` });
		await writeRuntimeEvent(runtime, event);
		return { status: "attached", attachment: data, activation: null, event };
	});
}

export async function detachRuntimeActor(runtime, actorId, sessionId, attachmentEpoch = null) {
	validateActorId(actorId);
	const normalizedSessionId = String(sessionId);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		const current = runtimeActorAttachment(await readRuntimeSnapshot(runtime), actorId);
		if (
			!current
			|| current.sessionId !== normalizedSessionId
			|| (attachmentEpoch && current.epoch !== attachmentEpoch)
		) return { actorId, sessionId: normalizedSessionId, status: "ignored" };
		const data = {
			actorId,
			sessionId: normalizedSessionId,
			attachmentEpoch: current.epoch ?? null,
		};
		const event = prepareRuntimeEvent(runtime, "actor.detached", data, {
			id: `actor-detachment:${current.epoch ?? createEventId("attachment")}`,
		});
		await writeRuntimeEvent(runtime, event);
		return event;
	});
}

export function runtimeActorAttachment(snapshot, actorId, sessionId) {
	return snapshot.attachments.find((attachment) =>
		attachment.actorId === actorId && (!sessionId || attachment.sessionId === sessionId),
	) ?? null;
}

export async function isRuntimeActorAttached(runtime, actorId, sessionId) {
	const snapshot = await readRuntimeSnapshot(runtime);
	return Boolean(runtimeActorAttachment(snapshot, actorId, sessionId));
}

export async function initializeResearchRuntime(cwd, session, options = {}) {
	const runtime = await resolveResearchRuntime(cwd, options);
	await ensureRuntimeActor(runtime, { id: USER_ACTOR_ID, kind: "user", label: "User" });
	await ensureRuntimeActor(runtime, {
		id: RESEARCH_LEADER_ACTOR_ID,
		kind: "leader",
		label: "Leader Session",
		provider: "pi",
	});
	if (options.attach !== false) await attachRuntimeActor(runtime, RESEARCH_LEADER_ACTOR_ID, session);
	return runtime;
}

export async function startRuntimeActorActivation(runtime, actorId, input) {
	validateActorId(actorId);
	const id = validateMessageId(input.id ?? createEventId("activation"));
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		const snapshot = await readRuntimeSnapshot(runtime);
		const existing = snapshot.activations.find((activation) => activation.id === id);
		if (existing) return existing;
		const attachment = runtimeActorAttachment(snapshot, actorId, input.sessionId);
		if (!attachment || (input.attachmentEpoch && attachment.epoch !== input.attachmentEpoch)) {
			throw new RuntimeAttachmentChangedError(actorId);
		}
		const data = {
			id,
			actorId,
			sessionId: String(input.sessionId),
			attachmentEpoch: attachment.epoch ?? null,
		};
		const event = prepareRuntimeEvent(runtime, "actor.activation.started", data, { id: `actor-activation:${id}:started` });
		await writeRuntimeEvent(runtime, event);
		return { ...data, status: "active" };
	});
}

export async function settleRuntimeActorActivation(runtime, activationId, details = {}) {
	validateMessageId(activationId);
	const data = {
		activationId,
		reason: boundedRuntimeText(details.reason, 240) || "settled",
	};
	await appendRuntimeEvent(runtime, "actor.activation.settled", data, { id: `actor-activation:${activationId}:settled` });
	return { ...data, status: "settled" };
}

function boundedRuntimeText(value, max) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export async function recordRuntimeEvidence(runtime, record) {
	if (!record?.id) throw new Error("Project evidence id is required");
	const snapshot = await readRuntimeSnapshot(runtime);
	const resolvedTrack = resolveRuntimeResearchTrack(snapshot, record.trackRef);
	const trackRef = resolvedTrack.trackRef;
	const trackLabel = record.trackLabel ?? resolvedTrack.trackLabel;
	const data = {
		id: String(record.id),
		timestamp: record.timestamp ?? now(),
		question: boundedRuntimeText(record.question, 1200),
		hypothesis: boundedRuntimeText(record.hypothesis, 1200),
		intervention: boundedRuntimeText(record.intervention, 1200),
		prediction: boundedRuntimeText(record.prediction, 1200),
		predictionStatus: ["preregistered", "recorded_before_observation", "not_recorded", "not_applicable", "unspecified"].includes(record.predictionStatus)
			? record.predictionStatus
			: record.prediction ? "unspecified" : "not_recorded",
		evidenceMode: ["confirmatory", "exploratory", "diagnostic", "validity_failure"].includes(record.evidenceMode)
			? record.evidenceMode
			: "exploratory",
		registrationRef: boundedRuntimeText(record.registrationRef, 1000) || null,
		validityChecks: Array.isArray(record.validityChecks)
			? record.validityChecks.map((item) => boundedRuntimeText(item, 700)).filter(Boolean).slice(0, 20)
			: [],
		validityJudgment: ["valid", "invalid", "inconclusive"].includes(record.validityJudgment)
			? record.validityJudgment
			: "inconclusive",
		observation: boundedRuntimeText(record.observation, 2400),
		conclusion: boundedRuntimeText(record.conclusion, 2000),
		nextStep: boundedRuntimeText(record.nextStep, 1200),
		runId: boundedRuntimeText(record.runId, 300) || null,
		runGitCommit: boundedRuntimeText(record.runGitCommit, 160) || null,
		recordedAtGit: record.recordedAtGit ? {
			root: boundedRuntimeText(record.recordedAtGit.root, 4000) || null,
			commit: boundedRuntimeText(record.recordedAtGit.commit, 160) || null,
			dirty: record.recordedAtGit.dirty ?? null,
		} : null,
		artifacts: Array.isArray(record.artifacts) ? record.artifacts.map((item) => boundedRuntimeText(item, 1000)).filter(Boolean).slice(0, 12) : [],
		source: {
			workspaceRoot: boundedRuntimeText(record.source?.workspaceRoot, 4000) || null,
			ledgerPath: boundedRuntimeText(record.source?.ledgerPath, 4000) || null,
			sessionId: boundedRuntimeText(record.source?.sessionId, 200) || null,
		},
		projectRevision: snapshot.revision,
		trackRef,
		trackLabel,
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
	const snapshot = await readRuntimeSnapshot(runtime);
	const basedOnRevision = Number.isInteger(transition.basedOnRevision) ? transition.basedOnRevision : snapshot.revision;
	const previousTrack = runtimeResearchTrack(snapshot);
	const fromTrackRef = boundedRuntimeText(transition.fromTrackRef, 300) || previousTrack.ref;
	if (runtimeTrackStatus(snapshot, fromTrackRef) === "retired") {
		throw new Error(`Research transition source ${fromTrackRef} is not a current or parallel track`);
	}
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
		trackRef: `transition:${id}`,
		fromTrackRef,
		basedOnRevision,
		sessionId: transition.sessionId ?? null,
		workspaceRoot: transition.workspaceRoot ?? runtime.workspaceRoot,
		git: transition.git ? {
			root: boundedRuntimeText(transition.git.root, 4000) || null,
			branch: boundedRuntimeText(transition.git.branch, 500) || null,
			commit: boundedRuntimeText(transition.git.commit, 160) || null,
			dirty: transition.git.dirty ?? null,
		} : null,
	};
	const result = await appendRuntimeEventAtRevision(runtime, "research.transition.recorded", data, basedOnRevision, { id: `research-transition:${id}` });
	if (result.status === "conflict") {
		throw new Error(`Research transition was based on Project revision ${basedOnRevision}, but revision ${result.revision} is current; refresh ProjectView and record the intended route change again.`);
	}
	return { ...data, revision: result.revision };
}

export async function amendRuntimeProjectState(runtime, input) {
	const sessionId = boundedRuntimeText(input.sessionId, 200);
	if (!sessionId) throw new Error("Project State amendment requires the current Session id");
	if (!Number.isInteger(input.basedOnRevision) || input.basedOnRevision < 0) {
		throw new Error("Project State amendment requires a non-negative basedOnRevision copied from ProjectView");
	}
	const reason = boundedRuntimeText(input.reason, 3_000);
	if (!reason) throw new Error("Project State amendment requires a reason");
	const authorityRefs = Array.isArray(input.authorityRefs)
		? input.authorityRefs.map((item) => boundedRuntimeText(item, 1_000)).filter(Boolean).slice(0, 16)
		: [];
	if (!authorityRefs.length) throw new Error("Project State amendment requires at least one authority reference");
	const id = validateMessageId(input.id ?? createEventId("state-amendment"));

	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeActorAttachment(runtime, RESEARCH_LEADER_ACTOR_ID, {
		sessionId,
		attachmentEpoch: input.attachmentEpoch,
	}, async ({ snapshot, attachment }) => {
		if (snapshot.revision !== input.basedOnRevision) {
			throw new Error(`Project State amendment was based on Project revision ${input.basedOnRevision}, but revision ${snapshot.revision} is current; refresh ProjectView and apply the intended correction again.`);
		}
		if (!snapshot.projectState?.state) {
			throw new Error("No structured Project State exists yet; use /compact to establish one before applying a narrow amendment");
		}
		const previousSource = snapshot.projectState.source ?? {};
		const trackRef = previousSource.trackRef ?? "project:initial";
		const trackStatus = runtimeTrackStatus(snapshot, trackRef);
		if (trackStatus !== "current") {
			throw new Error(`The stored Project State belongs to a ${trackStatus} research track; use /compact on the active track instead of amending non-current state`);
		}
		const state = applyResearchStatePatch(snapshot.projectState.state, input.patch);
		const track = runtimeResearchTrack(snapshot);
		const source = {
			kind: "amendment",
			sessionId,
			entryId: id,
			contentHash: shortHash(JSON.stringify(state), 20),
			patchHash: shortHash(JSON.stringify(input.patch), 20),
			basedOnRevision: input.basedOnRevision,
			previousStateRevision: snapshot.projectState.revision ?? 0,
			reason,
			authorityRefs,
			trackRef,
			trackLabel: previousSource.trackLabel ?? (track.ref === trackRef ? track.label : runtimeTrackLabel(snapshot, trackRef)),
			git: input.git ? {
				root: boundedRuntimeText(input.git.root, 4_000) || null,
				branch: boundedRuntimeText(input.git.branch, 500) || null,
				commit: boundedRuntimeText(input.git.commit, 160) || null,
				dirty: input.git.dirty ?? null,
			} : previousSource.git ?? null,
		};
		const data = {
			state,
			source,
			amendment: {
				id,
				reason,
				authorityRefs,
				patchKeys: Object.keys(input.patch),
				previousStateRef: {
					revision: snapshot.projectState.revision ?? 0,
					sessionId: previousSource.sessionId ?? null,
					entryId: previousSource.entryId ?? null,
					contentHash: previousSource.contentHash ?? null,
				},
			},
		};
		const event = prepareRuntimeEvent(runtime, "project.state.amended", data, {
			id: `project-state-amendment:${id}`,
		});
		await writeRuntimeEvent(runtime, event);
		return {
			...data,
			attachmentEpoch: attachment.epoch ?? null,
			revision: snapshot.revision + 1,
			eventId: event.id,
		};
	});
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
	const snapshot = await readRuntimeSnapshot(runtime);
	const message = {
		id,
		type,
		from,
		to,
		body,
		relatesTo: input.relatesTo ?? null,
		payloadRef: input.payloadRef ?? null,
		metadata: input.metadata ?? {},
		projectRevision: Number.isInteger(input.projectRevision) ? input.projectRevision : snapshot.revision,
		trackRef: input.trackRef ?? runtimeResearchTrack(snapshot).ref,
	};
	const existing = snapshot.messages.find((candidate) => candidate.id === id);
	if (existing) return existing;
	await appendRuntimeEvent(runtime, "message.queued", message, { id: `message:${id}:queued` });
	return { ...message, status: "queued" };
}

export async function settleRuntimeMessage(runtime, messageId, status, details = {}) {
	validateMessageId(messageId);
	if (!MESSAGE_STATES.has(status)) throw new Error(`Unsupported Runtime message state: ${status}`);
	await appendRuntimeEvent(runtime, `message.${status}`, { messageId, ...details }, {
		id: `message:${messageId}:${status}:${details.attachmentEpoch ?? details.sessionId ?? details.actorId ?? "runtime"}`,
	});
	return { messageId, status, ...details };
}

export async function consumeRuntimeMessageForAttachment(runtime, messageId, details) {
	validateMessageId(messageId);
	validateActorId(details.actorId);
	const sessionId = String(details.sessionId);
	await mkdir(runtime.projectDir, { recursive: true, mode: 0o700 });
	return await withRuntimeLedgerLock(runtime, async () => {
		await repairRuntimeLedgerTail(runtime);
		const snapshot = await readRuntimeSnapshot(runtime);
		const attachment = runtimeActorAttachment(snapshot, details.actorId, sessionId);
		if (!attachment || (details.attachmentEpoch && attachment.epoch !== details.attachmentEpoch)) {
			return { messageId, status: "stale_attachment", sessionId, attachmentEpoch: details.attachmentEpoch ?? null };
		}
		const message = snapshot.messages.find((candidate) => candidate.id === messageId);
		if (!message || TERMINAL_MESSAGE_STATES.has(message.status)) {
			return { messageId, status: message?.status ?? "missing", sessionId, attachmentEpoch: attachment.epoch ?? null };
		}
		const data = {
			messageId,
			sessionId,
			actorId: details.actorId,
			attachmentEpoch: attachment.epoch ?? null,
		};
		const event = prepareRuntimeEvent(runtime, "message.consumed", data, {
			id: `message:${messageId}:consumed:${attachment.epoch ?? sessionId}`,
		});
		await writeRuntimeEvent(runtime, event);
		return { ...data, status: "consumed" };
	});
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

export async function reconcileCodexRuntimeAsks(runtime, job) {
	const jobId = String(job?.id ?? "");
	if (!jobId) return [];
	const activeRequestId = job.status === "input_required" ? String(job.pendingRequest?.id ?? "") : "";
	const snapshot = await readRuntimeSnapshot(runtime);
	const superseded = [];
	for (const message of snapshot.messages) {
		if (
			message.type !== "ask"
			|| message.metadata?.jobId !== jobId
			|| (message.status !== "queued" && message.status !== "delivered")
		) continue;
		const requestId = String(message.metadata?.requestId ?? message.relatesTo ?? "");
		if (activeRequestId && requestId === activeRequestId) continue;
		await settleRuntimeMessage(runtime, message.id, "superseded", {
			jobId,
			requestId: requestId || null,
			reason: activeRequestId ? "codex_request_replaced" : `codex_job_${String(job.status ?? "not_waiting")}`,
		});
		superseded.push(message.id);
	}
	return superseded;
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

export async function requestRuntimeSessionInheritance(runtime, input) {
	const policy = String(input.policy ?? "");
	if (!SESSION_INHERITANCE_POLICIES.has(policy)) throw new Error(`Unsupported Runtime Session inheritance policy: ${policy}`);
	const fromSessionId = boundedRuntimeText(input.fromSessionId, 200);
	if (!fromSessionId) throw new Error("Runtime Session inheritance request requires a source Session id");
	const snapshot = await readRuntimeSnapshot(runtime);
	const existing = snapshot.pendingInheritanceRequests.find((request) =>
		request.fromSessionId === fromSessionId && request.policy === policy,
	);
	if (existing) return existing;
	const id = validateMessageId(input.id ?? createEventId("inheritance"));
	const data = {
		id,
		policy,
		fromSessionId,
		fromSessionFile: boundedRuntimeText(input.fromSessionFile, 4000) || null,
		reason: boundedRuntimeText(input.reason, 1200) || `${policy} Session replacement`,
		projectRevision: snapshot.revision,
	};
	await appendRuntimeEvent(runtime, "session.inheritance.requested", data, {
		id: `session-inheritance:${id}:requested`,
	});
	return { ...data, status: "pending" };
}

export async function settleRuntimeSessionInheritance(runtime, requestId, status, details = {}) {
	validateMessageId(requestId);
	if (!SESSION_INHERITANCE_STATES.has(status)) throw new Error(`Unsupported Runtime Session inheritance state: ${status}`);
	const data = {
		requestId,
		toSessionId: details.toSessionId ? String(details.toSessionId) : null,
		toSessionFile: boundedRuntimeText(details.toSessionFile, 4000) || null,
		reason: boundedRuntimeText(details.reason, 1200) || null,
	};
	await appendRuntimeEvent(runtime, `session.inheritance.${status}`, data, {
		id: `session-inheritance:${requestId}:${status}`,
	});
	return { requestId, status, ...data };
}

export async function upsertRuntimeAction(runtime, action) {
	if (!action?.id) throw new Error("Runtime Action id is required");
	const snapshot = await readRuntimeSnapshot(runtime);
	const track = runtimeResearchTrack(snapshot);
	const data = {
		id: String(action.id),
		kind: action.kind ?? "delegation",
		actorId: action.actorId ?? null,
		status: action.status ?? "queued",
		label: action.label ? String(action.label).slice(0, 240) : null,
		externalId: action.externalId ?? null,
		metadata: action.metadata ?? {},
		projectRevision: Number.isInteger(action.projectRevision) ? action.projectRevision : snapshot.revision,
		trackRef: action.trackRef ?? track.ref,
		trackLabel: action.trackLabel ?? track.label,
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
	const snapshot = await readRuntimeSnapshot(runtime);
	const currentTrack = runtimeResearchTrack(snapshot);
	const trackRef = job.researchTrackRef ?? currentTrack.ref;
	const trackLabel = job.researchTrackLabel ?? currentTrack.label;
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
			researchTrackRef: trackRef,
			researchTrackLabel: trackLabel,
		},
	});
	await upsertRuntimeAction(runtime, {
		id: job.actionId ?? `action:${job.id}`,
		kind: "codex-delegation",
		actorId,
		status: job.status,
		label: job.mission ?? `${job.mode} ${String(job.id).slice(-8)}`,
		externalId: job.id,
		metadata: {
			threadId: job.threadId ?? null,
			mode: job.mode,
			model: job.model,
			outcome: job.result?.outcome ?? null,
			goalSatisfied: job.result?.goal_satisfied ?? null,
		},
		projectRevision: Number.isInteger(job.projectRevision) ? job.projectRevision : snapshot.revision,
		trackRef,
		trackLabel,
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
		projectRevision: job.projectRevision,
		trackRef: job.researchTrackRef,
	});
}
