import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	readRuntimeSnapshot,
	recordRuntimeEvidence,
	resolveResearchRuntime,
	resolveRuntimeResearchTrack,
} from "../lib/research-runtime.mjs";

interface GitIdentity {
	root?: string;
	commit?: string;
	dirty?: boolean;
}

type PredictionStatus = "preregistered" | "recorded_before_observation" | "not_recorded" | "not_applicable" | "unspecified";
type EvidenceMode = "confirmatory" | "exploratory" | "diagnostic" | "validity_failure";

interface ExperimentRecord {
	id: string;
	timestamp: string;
	question: string;
	hypothesis: string;
	intervention: string;
	prediction: string;
	predictionStatus: PredictionStatus;
	evidenceMode: EvidenceMode;
	registrationRef?: string;
	validityChecks: string[];
	observation: string;
	validityJudgment: "valid" | "invalid" | "inconclusive";
	conclusion: string;
	nextStep: string;
	runId?: string;
	runGitCommit?: string;
	artifacts: string[];
	trackRef: string;
	trackLabel: string;
	idempotencyKeyHash: string;
	contentFingerprint: string;
	sessionId: string;
	sessionFile?: string;
	model?: string;
	recordedAtGit: GitIdentity;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function recordContent(value: Partial<ExperimentRecord>) {
	return {
		question: value.question ?? "",
		hypothesis: value.hypothesis ?? "",
		intervention: value.intervention ?? "",
		prediction: value.prediction ?? "",
		predictionStatus: value.predictionStatus ?? "not_recorded",
		evidenceMode: value.evidenceMode ?? "exploratory",
		registrationRef: value.registrationRef ?? "",
		validityChecks: value.validityChecks ?? [],
		observation: value.observation ?? "",
		validityJudgment: value.validityJudgment ?? "inconclusive",
		conclusion: value.conclusion ?? "",
		nextStep: value.nextStep ?? "",
		runId: value.runId ?? "",
		runGitCommit: value.runGitCommit ?? "",
		artifacts: value.artifacts ?? [],
		trackRef: value.trackRef ?? "project:initial",
		trackLabel: value.trackLabel ?? "initial project track",
	};
}

function contentFingerprint(value: Partial<ExperimentRecord>): string {
	return sha256(JSON.stringify(recordContent(value)));
}

async function readLedgerRecords(path: string): Promise<ExperimentRecord[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: ExperimentRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object" && typeof value.id === "string") records.push(value);
		} catch {
			// One malformed historical line must not block a new append-only record.
		}
	}
	return records;
}

export default function (pi: ExtensionAPI) {
	async function getGitIdentity(cwd: string, signal?: AbortSignal): Promise<GitIdentity> {
		const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 5000 });
		if (root.code !== 0) return {};

		const repoRoot = root.stdout.trim();
		const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, signal, timeout: 5000 });
		const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: repoRoot, signal, timeout: 5000 });
		return {
			root: repoRoot,
			commit: head.code === 0 ? head.stdout.trim() : undefined,
			dirty: status.code === 0 ? status.stdout.trim().length > 0 : undefined,
		};
	}

	pi.registerTool({
		name: "record_experiment",
		label: "Record Experiment",
		description: "Persist one canonical lightweight research memo when an observation changes a research judgment. This ledger entry replaces routine duplicate Markdown; it does not create or copy artifacts.",
		promptSnippet: "Record a decision-changing experiment result in the project research ledger",
		promptGuidelines: [
			"Use record_experiment only after a result materially changes a research judgment; choose evidenceMode honestly: confirmatory for an ex-ante prediction, exploratory for unplanned findings, diagnostic for a mechanism/failure-localization check, and validity_failure when the intended experiment cannot be interpreted.",
			"Treat this ledger entry as the default complete memo. Do not also create a Markdown report, run directory, activation note, one-pager, or artifact bundle unless the result freezes a protocol, formally settles a batch, or changes a claim/route for human review.",
			"artifacts are concise references to already-existing canonical evidence. Do not copy generated outputs into the repository or enumerate raw shards, checkpoints, rollouts, panels, or seed rows.",
			"Never reconstruct a hypothesis, prediction, validity check, registration, or next step to satisfy the tool. Confirmatory evidence needs a real observation-before prediction; preregistered needs registrationRef; valid needs an actual validity check.",
			"For an older route, provide its exact trackRef. Provide runGitCommit when known; recordedAtGit never substitutes for executed-code identity.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Research question or concrete design uncertainty" }),
			hypothesis: Type.Optional(Type.String({ description: "Hypothesis evaluated; required only for confirmatory evidence, otherwise omit rather than reconstructing one" })),
			intervention: Type.String({ description: "What was changed, compared, or inspected" }),
			prediction: Type.Optional(Type.String({ description: "Pre-observation distinguishing prediction, only if it was actually recorded; omit rather than reconstructing it post hoc" })),
			predictionStatus: Type.Optional(Type.Union([
				Type.Literal("preregistered"),
				Type.Literal("recorded_before_observation"),
				Type.Literal("not_recorded"),
				Type.Literal("not_applicable"),
				Type.Literal("unspecified"),
			], { description: "Provenance of the prediction; omitted prediction defaults to not_recorded" })),
			evidenceMode: Type.Optional(Type.Union([
				Type.Literal("confirmatory"),
				Type.Literal("exploratory"),
				Type.Literal("diagnostic"),
				Type.Literal("validity_failure"),
			], { description: "How this observation may update claims; inferred conservatively when omitted" })),
			registrationRef: Type.Optional(Type.String({ description: "Frozen registration or exact prior source of an ex-ante prediction; required for preregistered" })),
			validityChecks: Type.Optional(Type.Array(Type.String(), { description: "Checks actually performed to establish interpretability; required when validityJudgment=valid" })),
			observation: Type.String({ description: "Observed evidence, separated from interpretation" }),
			validityJudgment: Type.Union([Type.Literal("valid"), Type.Literal("invalid"), Type.Literal("inconclusive")], { description: "Whether the run can update the research hypothesis" }),
			conclusion: Type.String({ description: "How the observation updates the hypothesis or decision" }),
			nextStep: Type.Optional(Type.String({ description: "Next highest-information action, if one is actually known" })),
			runId: Type.Optional(Type.String({ description: "External training/evaluation run identifier, if any" })),
			runGitCommit: Type.Optional(Type.String({ description: "Git commit of the code that actually produced the run; do not substitute the record-time HEAD" })),
			artifacts: Type.Optional(Type.Array(Type.String(), { maxItems: 12, description: "At most 12 concise paths or URLs to already-existing canonical evidence; never enumerate raw files" })),
			trackRef: Type.Optional(Type.String({ description: "Exact Runtime research-track provenance when this result belongs to a non-current route" })),
			idempotencyKey: Type.Optional(Type.String({ description: "Stable caller key for safe retries; runId plus question is used when available" })),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const prediction = String(params.prediction ?? "").trim();
			let predictionStatus: PredictionStatus = params.predictionStatus ?? (prediction ? "unspecified" : "not_recorded");
			if (!prediction && predictionStatus === "unspecified") predictionStatus = "not_recorded";
			const hypothesis = String(params.hypothesis ?? "").trim();
			const registrationRef = String(params.registrationRef ?? "").trim() || undefined;
			const validityChecks = (params.validityChecks ?? []).map((item) => String(item).trim()).filter(Boolean);
			const nextStep = String(params.nextStep ?? "").trim();
			const runId = String(params.runId ?? "").trim() || undefined;
			const runGitCommit = String(params.runGitCommit ?? "").trim() || undefined;
			const artifacts = (params.artifacts ?? []).map((item) => String(item).trim()).filter(Boolean);
			const evidenceMode: EvidenceMode = params.evidenceMode
				?? (params.validityJudgment === "invalid"
					? "validity_failure"
					: prediction && ["preregistered", "recorded_before_observation"].includes(predictionStatus)
						? "confirmatory"
						: "exploratory");

			if (!prediction && ["preregistered", "recorded_before_observation"].includes(predictionStatus)) {
				throw new Error(`prediction is required when predictionStatus=${predictionStatus}`);
			}
			if (prediction && ["not_recorded", "not_applicable"].includes(predictionStatus)) {
				throw new Error(`prediction must be omitted when predictionStatus=${predictionStatus}`);
			}
			if (predictionStatus === "preregistered" && !registrationRef) {
				throw new Error("registrationRef is required when predictionStatus=preregistered");
			}
			if (evidenceMode === "confirmatory") {
				if (!hypothesis) throw new Error("hypothesis is required when evidenceMode=confirmatory");
				if (!prediction || !["preregistered", "recorded_before_observation"].includes(predictionStatus)) {
					throw new Error("confirmatory evidence requires an observation-before prediction and matching predictionStatus");
				}
			}
			if (evidenceMode === "validity_failure" && params.validityJudgment === "valid") {
				throw new Error("evidenceMode=validity_failure cannot have validityJudgment=valid");
			}
			if (params.validityJudgment === "valid" && !validityChecks.length) {
				throw new Error("at least one actual validity check is required when validityJudgment=valid");
			}

			const runtime = await resolveResearchRuntime(ctx.cwd);
			const route = resolveRuntimeResearchTrack(await readRuntimeSnapshot(runtime), params.trackRef);
			const ledgerDir = join(ctx.cwd, CONFIG_DIR_NAME, "research");
			const ledgerPath = join(ledgerDir, "experiments.jsonl");
			const sessionId = ctx.sessionManager.getSessionId();
			const baseRecord = {
				question: String(params.question).trim(),
				hypothesis,
				intervention: String(params.intervention).trim(),
				prediction,
				predictionStatus,
				evidenceMode,
				registrationRef,
				validityChecks,
				observation: String(params.observation).trim(),
				validityJudgment: params.validityJudgment,
				conclusion: String(params.conclusion).trim(),
				nextStep,
				runId,
				runGitCommit,
				artifacts,
				trackRef: route.trackRef,
				trackLabel: route.trackLabel,
			};
			const fingerprint = contentFingerprint(baseRecord);
			const explicitIdempotencyKey = String(params.idempotencyKey ?? "").trim();
			const idempotencySeed = explicitIdempotencyKey
				? `explicit:${explicitIdempotencyKey}`
				: runId
					? `run:${route.trackRef}:${runId}:${baseRecord.question}`
					: `tool:${sessionId}:${toolCallId}`;
			const idempotencyKeyHash = sha256(idempotencySeed);
			const id = `exp-${idempotencyKeyHash.slice(0, 24)}`;
			const existingRecords = await readLedgerRecords(ledgerPath);
			let existing = existingRecords.find((item) => item.id === id);
			if (!existing && !explicitIdempotencyKey && !runId) {
				existing = existingRecords.find((item) => item.contentFingerprint === fingerprint || (!item.contentFingerprint && contentFingerprint(item) === fingerprint));
			}
			if (existing) {
				const existingFingerprint = existing.contentFingerprint || contentFingerprint(existing);
				if (existingFingerprint !== fingerprint) {
					throw new Error(`record_experiment idempotency conflict for ${existing.id}; use a distinct idempotencyKey for a new scientific record`);
				}
				await recordRuntimeEvidence(runtime, {
					...existing,
					source: { workspaceRoot: ctx.cwd, ledgerPath, sessionId: existing.sessionId ?? sessionId },
				});
				return {
					content: [{ type: "text", text: `Experiment ${existing.id} was already recorded; no duplicate ledger or Session entry was created.` }],
					details: { ...existing, runtimeMirrored: true, duplicateSkipped: true },
				};
			}

			const recordedAtGit = await getGitIdentity(ctx.cwd, signal);
			const record: ExperimentRecord = {
				id,
				timestamp: new Date().toISOString(),
				...baseRecord,
				idempotencyKeyHash,
				contentFingerprint: fingerprint,
				sessionId,
				sessionFile: ctx.sessionManager.getSessionFile(),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				recordedAtGit,
			};

			await mkdir(ledgerDir, { recursive: true });
			await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
			pi.appendEntry<ExperimentRecord>("research-experiment", record);
			let runtimeWarning: string | undefined;
			try {
				await recordRuntimeEvidence(runtime, {
					...record,
					source: { workspaceRoot: ctx.cwd, ledgerPath, sessionId: record.sessionId },
				});
			} catch (error) {
				runtimeWarning = error instanceof Error ? error.message : String(error);
			}

			return {
				content: [{ type: "text", text: `Recorded ${id} in the canonical lightweight ledger ${join(CONFIG_DIR_NAME, "research", "experiments.jsonl")}; no duplicate Markdown or artifact copy is needed.${runtimeWarning ? ` Project Runtime mirror warning: ${runtimeWarning}` : ""}` }],
				details: { ...record, runtimeMirrored: !runtimeWarning, runtimeWarning, duplicateSkipped: false },
			};
		},
	});
}
