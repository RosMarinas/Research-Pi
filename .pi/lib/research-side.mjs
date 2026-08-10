import { randomUUID } from "node:crypto";

export const RESEARCH_SIDE_KIND = "research-side";
export const RESEARCH_SIDE_PROMOTION_KIND = "research-side-promotion";

function compactTimestamp(date) {
	return date.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

export function createSideRecord({ question, answer, anchorEntryId, sessionId, model, usage, startedAt, completedAt }) {
	const completed = completedAt instanceof Date ? completedAt : new Date(completedAt ?? Date.now());
	const started = startedAt instanceof Date ? startedAt : new Date(startedAt ?? completed);
	return {
		id: `side-${compactTimestamp(completed)}-${randomUUID().slice(0, 8)}`,
		question: String(question ?? "").trim(),
		answer: String(answer ?? "").trim(),
		anchorEntryId: anchorEntryId || null,
		sessionId: String(sessionId ?? ""),
		model: {
			provider: String(model?.provider ?? "unknown"),
			id: String(model?.id ?? model?.modelId ?? "unknown"),
		},
		usage: usage
			? {
				input: Number(usage.input) || 0,
				output: Number(usage.output) || 0,
				cacheRead: Number(usage.cacheRead) || 0,
				cacheWrite: Number(usage.cacheWrite) || 0,
				reasoning: Number(usage.reasoning) || 0,
				totalTokens: Number(usage.totalTokens) || 0,
			}
			: undefined,
		startedAt: started.toISOString(),
		completedAt: completed.toISOString(),
		latencyMs: Math.max(0, completed.getTime() - started.getTime()),
	};
}

export function sideRecords(entries) {
	return entries
		.filter((entry) => entry?.type === "custom" && entry.customType === RESEARCH_SIDE_KIND && entry.data?.id)
		.map((entry) => ({ ...entry.data, sessionEntryId: entry.id }));
}

export function findSideRecord(entries, requestedId) {
	const needle = String(requestedId ?? "").trim();
	if (!needle) throw new Error("side id is required");
	const records = sideRecords(entries);
	const exact = records.find((record) => record.id === needle);
	if (exact) return exact;
	const matches = records.filter((record) => record.id.startsWith(needle) || record.id.endsWith(needle));
	if (!matches.length) throw new Error(`No side conversation matches ${needle}`);
	if (matches.length > 1) throw new Error(`Side id ${needle} is ambiguous; use more characters`);
	return matches[0];
}

export function buildSidePromotion(record) {
	return [
		`The user explicitly promoted a previously isolated side conversation into the main research context.`,
		`Side ID: ${record.id}`,
		`Question:`,
		record.question,
		``,
		`Side answer (fallible assistant synthesis; verify consequential claims):`,
		record.answer,
	].join("\n");
}

export function previewText(value, maxChars = 720) {
	const text = String(value ?? "").trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars).trimEnd()}…`;
}

export function sideUsageLine(record) {
	const usage = record?.usage;
	if (!usage) return "usage unavailable";
	const cacheInput = usage.input + usage.cacheRead;
	const cacheRatio = cacheInput > 0 ? `${((usage.cacheRead / cacheInput) * 100).toFixed(1)}% cache hit` : "cache n/a";
	return `${usage.input.toLocaleString()} input + ${usage.output.toLocaleString()} output · ${cacheRatio}`;
}
