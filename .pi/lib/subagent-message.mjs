import { redactSensitiveText } from "./sensitive-text.mjs";

export const SUBAGENT_RESULT_SECTIONS = [
	"summary",
	"request",
	"scope",
	"evidence",
	"checks",
	"effects",
	"changes",
	"analysis",
	"uncertainties",
	"remaining",
	"runs",
];

function block(value) {
	return redactSensitiveText(value)
		.replace(/\r\n/g, "\n")
		.replace(/[\t ]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function line(value) {
	return block(value).replace(/\s+/g, " ");
}

function items(value) {
	return Array.isArray(value) ? value.map((item) => block(item)).filter(Boolean) : [];
}

function addSelected(lines, title, values, count = null, retrieval = "Inspect the exact Runtime record for the remaining items.") {
	const all = items(values);
	if (!all.length) return;
	const selected = count === null ? all : all.slice(0, count);
	lines.push(all.length === selected.length ? `${title}:` : `${title} (showing ${selected.length} of ${all.length}):`);
	for (const item of selected) lines.push(`- ${item}`);
	if (all.length > selected.length) lines.push(`- ${all.length - selected.length} more. ${retrieval}`);
}

function traceLines(job, messageId) {
	return [
		messageId ? `Message: ${messageId}.` : undefined,
		`Job: ${line(job?.id) || "unknown"}.`,
		job?.actionId ? `Action: ${line(job.actionId)}.` : undefined,
		job?.mission ? `Mission: ${line(job.mission)}.` : undefined,
	].filter(Boolean);
}

function detailSections(result, job) {
	const sections = [];
	if (job?.pendingRequest) sections.push("request");
	if (items(job?.writeScope).length || items(job?.resourceClaims ?? job?.heldResources).length) sections.push("scope");
	if (items(result?.evidence).length) sections.push("evidence");
	if (Array.isArray(result?.checks) && result.checks.length) sections.push("checks");
	if (Array.isArray(result?.external_effects) && result.external_effects.length) sections.push("effects");
	if (items(result?.changed_files).length) sections.push("changes");
	if (
		items(result?.points_of_agreement).length
		|| items(result?.candidate_explanations).length
		|| items(result?.questions_to_resolve).length
	) sections.push("analysis");
	if (items(result?.uncertainties).length || items(result?.unverified_edge_cases_and_warnings).length) sections.push("uncertainties");
	if (items(result?.remaining_work ?? result?.questions_to_resolve).length) sections.push("remaining");
	if (Array.isArray(job?.externalRuns) && job.externalRuns.length) sections.push("runs");
	return sections;
}

function resultCard(job, messageId) {
	const result = job?.result && typeof job.result === "object" ? job.result : {};
	const fullSummary = block(result.summary ?? result.working_synthesis ?? result.shared_understanding);
	const summary = fullSummary.length <= 1_200 ? fullSummary : "";
	const next = block(result.recommended_next_step ?? result.suggested_next_exchange);
	const lines = [
		"RUNTIME RESULT",
		...traceLines(job, messageId),
		`State: ${line(job?.status) || "terminal"}.`,
		result.outcome ? `Outcome: ${line(result.outcome)}.` : undefined,
		typeof result.goal_satisfied === "boolean" ? `Goal satisfied: ${result.goal_satisfied ? "yes" : "no"}.` : undefined,
		summary ? `Result: ${summary}` : undefined,
		fullSummary && !summary ? "Result: The full summary is in Runtime. It was not copied because it does not satisfy the concise-message contract." : undefined,
	].filter(Boolean);
	addSelected(lines, "Decision evidence", result.evidence, 3, "Read resultSection=evidence for the remaining items.");
	addSelected(lines, "Remaining work", result.remaining_work ?? result.questions_to_resolve, 2, "Read resultSection=remaining for the remaining items.");
	if (next) lines.push(`Next action: ${next}`);
	const error = block(job?.error);
	if (error && !summary) {
		lines.push(error.length <= 1_200
			? `Error: ${error}`
			: "Error: The complete diagnostic is in the job record. It was not copied because it does not satisfy the concise-message contract.");
	}
	if (Array.isArray(job?.externalRuns) && job.externalRuns.length) {
		lines.push(`External runs: ${job.externalRuns.length}. External runs are independent of worker completion and scientific validity.`);
	}
	const sections = detailSections(result, job);
	if (fullSummary && !summary) sections.unshift("summary");
	if (sections.length) {
		lines.push(`Available detail: ${sections.join(", ")}.`);
		lines.push(`To read one detail section, call subagent with action=result, jobId=${line(job.id)}, and resultSection=<section>.`);
	}
	return lines.join("\n");
}

function requestCard(job, messageId) {
	const pending = job?.pendingRequest && typeof job.pendingRequest === "object" ? job.pendingRequest : {};
	const requestId = line(pending.id) || "unknown";
	const lines = [
		"RUNTIME REQUEST",
		...traceLines(job, messageId),
		`Request: ${requestId}.`,
		`Type: ${line(pending.kind) || "decision"}.`,
		pending.question ? `Question: ${block(pending.question)}` : undefined,
		pending.whyBlocking ? `Reason: ${block(pending.whyBlocking)}` : undefined,
	].filter(Boolean);
	addSelected(lines, "Options", pending.options, 6, "Read resultSection=request for the complete request.");
	if (pending.secret) {
		lines.push("Required action: Configure the secret outside Research Pi. Do not put the secret in a message.");
		lines.push(`After configuration, send only a confirmation with subagent action=respond, jobId=${line(job.id)}, and requestId=${requestId}.`);
	} else if (pending.kind === "host_capability") {
		lines.push("Required action: Use the host approval dialog in the attached TUI.");
	} else if (pending.audience === "user") {
		lines.push("Required action: Ask the user for this decision. Do not choose for the user.");
		lines.push(`Then call subagent with action=respond, jobId=${line(job.id)}, and requestId=${requestId}.`);
	} else {
		lines.push(`Required action: Call subagent with action=respond, jobId=${line(job.id)}, and requestId=${requestId}.`);
	}
	if (Array.isArray(pending.questions) && pending.questions.length) {
		lines.push("Available detail: request.");
		lines.push(`To read the complete structured request, call subagent with action=result, jobId=${line(job.id)}, and resultSection=request.`);
	}
	return lines.join("\n");
}

function unknownOutcomeCard(job, messageId) {
	const lines = [
		"RUNTIME RECONCILIATION",
		...traceLines(job, messageId),
		"State: outcome_unknown.",
		"Risk: Executor side effects can exist.",
	];
	addSelected(lines, "Write scope", job?.writeScope, 8, "Read resultSection=scope for the complete scope.");
	if (job?.sideEffect?.state) lines.push(`Side-effect state: ${line(job.sideEffect.state)}.`);
	if (Array.isArray(job?.externalRuns) && job.externalRuns.length) {
		const selectedRuns = job.externalRuns.slice(0, 4);
		lines.push(selectedRuns.length === job.externalRuns.length
			? "Known external runs:"
			: `Known external runs (showing ${selectedRuns.length} of ${job.externalRuns.length}):`);
		for (const run of selectedRuns) {
			lines.push(`- ${line(run.id)} [${line(run.status)}] target=${line(run.target)} external=${line(run.externalId)}`);
		}
		if (selectedRuns.length < job.externalRuns.length) lines.push("- Read the runs detail section for the remaining runs.");
	}
	lines.push("Required action: Inspect the scoped Git state, files, and external runs.");
	lines.push(`Then call subagent with action=reconcile and jobId=${line(job?.id)}. Include the observed outcome and evidence.`);
	lines.push("Do not start overlapping work before reconciliation.");
	const sections = ["scope", ...(Array.isArray(job?.externalRuns) && job.externalRuns.length ? ["runs"] : [])];
	lines.push(`Available detail: ${sections.join(", ")}.`);
	lines.push(`To read one detail section, call subagent with action=result, jobId=${line(job?.id)}, and resultSection=<section>.`);
	return lines.join("\n");
}

function statusCard(job, messageId) {
	return [
		"RUNTIME STATUS",
		...traceLines(job, messageId),
		`State: ${line(job?.status) || "unknown"}.`,
		job?.progress ? `Progress: ${line(job.progress)}.` : undefined,
		"Runtime will deliver the next blocking or terminal event.",
		"Continue other useful work. Do not poll the job.",
	].filter(Boolean).join("\n");
}

export function subagentModelCard(job, options = {}) {
	if (job?.status === "input_required") return requestCard(job, options.messageId);
	if (job?.status === "outcome_unknown") return unknownOutcomeCard(job, options.messageId);
	if (["completed", "failed", "cancelled"].includes(job?.status)) return resultCard(job, options.messageId);
	return statusCard(job, options.messageId);
}

function sectionHeader(job, section) {
	return [
		`SUBAGENT ${section.toUpperCase()}`,
		`Job: ${line(job?.id) || "unknown"}.`,
		`State: ${line(job?.status) || "unknown"}.`,
	];
}

function renderSectionItems(lines, values, emptyText) {
	const all = items(values);
	if (!all.length) lines.push(emptyText);
	else for (const item of all) lines.push(`- ${item}`);
}

export function subagentResultSection(job, section = "summary") {
	if (!SUBAGENT_RESULT_SECTIONS.includes(section)) throw new Error(`Unsupported subagent result section: ${section}`);
	const result = job?.result && typeof job.result === "object" ? job.result : {};
	const lines = sectionHeader(job, section);
	if (section === "summary") {
		const summary = block(result.summary ?? result.working_synthesis ?? result.shared_understanding);
		lines.push(summary ? `Result: ${summary}` : "No result summary was recorded.");
		const next = block(result.recommended_next_step ?? result.suggested_next_exchange);
		if (next) lines.push(`Next action: ${next}`);
	}
	if (section === "request") {
		const pending = job?.pendingRequest && typeof job.pendingRequest === "object" ? job.pendingRequest : null;
		if (!pending) lines.push("No pending request was recorded.");
		else {
			lines.push(`Request: ${line(pending.id) || "unknown"}.`);
			lines.push(`Type: ${line(pending.kind) || "decision"}.`);
			if (pending.question) lines.push(`Question: ${block(pending.question)}`);
			if (pending.whyBlocking) lines.push(`Reason: ${block(pending.whyBlocking)}`);
			lines.push("Options:");
			renderSectionItems(lines, pending.options, "No option was recorded.");
			if (Array.isArray(pending.questions) && pending.questions.length) {
				lines.push("Structured questions:");
				for (const question of pending.questions) {
					lines.push(`- ${line(question?.header ?? question?.id) || "Question"}: ${block(question?.question) || "not recorded"}`);
					const options = Array.isArray(question?.options) ? question.options : [];
					for (const option of options) lines.push(`  - ${block(option?.label ?? option)}`);
				}
			}
		}
	}
	if (section === "scope") {
		lines.push("Write scope:");
		renderSectionItems(lines, job?.writeScope, "No write scope was recorded.");
		const resources = items(job?.resourceClaims ?? job?.heldResources);
		if (resources.length) {
			lines.push("Resource claims:");
			for (const resource of resources) lines.push(`- ${resource}`);
		}
	}
	if (section === "evidence") renderSectionItems(lines, result.evidence, "No decision evidence was recorded.");
	if (section === "changes") renderSectionItems(lines, result.changed_files, "No changed file was recorded.");
	if (section === "uncertainties") renderSectionItems(lines, [...new Set([...items(result.uncertainties), ...items(result.unverified_edge_cases_and_warnings)])], "No notes were recorded.");
	if (section === "remaining") renderSectionItems(lines, result.remaining_work ?? result.questions_to_resolve, "No remaining work was recorded.");
	if (section === "analysis") {
		for (const [title, values] of [
			["Points of agreement", result.points_of_agreement],
			["Candidate explanations", result.candidate_explanations],
			["Questions to resolve", result.questions_to_resolve],
		]) addSelected(lines, title, values);
		if (lines.length === 3) lines.push("No analysis detail was recorded.");
	}
	if (section === "checks") {
		const checks = Array.isArray(result.checks) ? result.checks : [];
		if (!checks.length) lines.push("No check was recorded.");
		for (const check of checks) {
			lines.push(`- Command: ${line(check?.command) || "not recorded"}.`);
			lines.push(`  Result: ${block(check?.result) || "not recorded"}`);
		}
	}
	if (section === "effects") {
		const effects = Array.isArray(result.external_effects) ? result.external_effects : [];
		if (!effects.length) lines.push("No external effect was recorded.");
		for (const effect of effects) {
			lines.push(`- Kind: ${line(effect?.kind) || "unknown"}. Target: ${line(effect?.target) || "unknown"}. Identifier: ${line(effect?.identifier) || "unknown"}.`);
			if (effect?.detail) lines.push(`  Detail: ${block(effect.detail)}`);
		}
	}
	if (section === "runs") {
		const runs = Array.isArray(job?.externalRuns) ? job.externalRuns : [];
		if (!runs.length) lines.push("No external run was recorded.");
		for (const run of runs) lines.push(`- ${line(run.id)} [${line(run.status)}] target=${line(run.target)} external=${line(run.externalId)}`);
	}
	return lines.join("\n");
}

export function runtimeDirectedMessageCard(message, actors = []) {
	const actor = actors.find((candidate) => candidate?.id === message?.from);
	const source = line(actor?.label ?? message?.from) || "unknown";
	const metadata = message?.metadata && typeof message.metadata === "object" ? message.metadata : {};
	return [
		"RUNTIME MESSAGE",
		`Message: ${line(message?.id) || "unknown"}.`,
		`Type: ${line(message?.type) || "notify"}.`,
		`From: ${source}.`,
		metadata.jobId ? `Job: ${line(metadata.jobId)}.` : undefined,
		metadata.requestId ? `Request: ${line(metadata.requestId)}.` : undefined,
		metadata.kind ? `Purpose: ${line(metadata.kind)}.` : undefined,
		metadata.kind === "research_discussion" ? `Audience: ${line(metadata.audience) || "leader"}. Reply to ${line(message.from)} through the subagent mailbox; the sender may still be working.` : undefined,
		message?.payloadRef ? `Payload: ${line(message.payloadRef)}.` : undefined,
		"Content:",
		block(message?.body),
	].filter(Boolean).join("\n");
}

export function legacyRuntimeMessageCard(message) {
	const jobId = line(message?.metadata?.jobId) || "unknown";
	const messageId = line(message?.id) || "unknown";
	if (message?.type === "ask") {
		return [
			"RUNTIME REQUEST",
			`Message: ${messageId}.`,
			`Job: ${jobId}.`,
			`Request: ${line(message?.metadata?.requestId ?? message?.relatesTo) || "unknown"}.`,
			"This legacy request has no structured model card.",
			`Required action: Call subagent with action=status and jobId=${jobId}. Read the current request before you respond.`,
		].join("\n");
	}
	if (message?.metadata?.status === "outcome_unknown") {
		return [
			"RUNTIME RECONCILIATION",
			`Message: ${messageId}.`,
			`Job: ${jobId}.`,
			"State: outcome_unknown.",
			"Required action: Inspect external state. Then reconcile this job with evidence.",
			"Do not start overlapping work before reconciliation.",
		].join("\n");
	}
	if (message?.type === "result") {
		return [
			"RUNTIME RESULT",
			`Message: ${messageId}.`,
			`Job: ${jobId}.`,
			`State: ${line(message?.metadata?.status) || "terminal"}.`,
			`Required action: Call subagent with action=result and jobId=${jobId} to read the structured result.`,
		].join("\n");
	}
	return runtimeDirectedMessageCard(message);
}
