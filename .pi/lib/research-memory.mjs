import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_EXTRACTOR_VERSION = "research-pi-memory-v2";

const MAX_INDEXED_CHARS = 64_000;
const DEFAULT_RESULT_LIMIT = 6;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function scalar(value, maxChars = 2_000) {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\r\n/g, "\n").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

export function redactSensitiveText(value) {
	let text = String(value ?? "");
	text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]");
	text = text.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_API_KEY]");
	text = text.replace(
		/(\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*)[^\s,;]+/gi,
		"$1[REDACTED]",
	);
	return text;
}

function boundedIndexText(value) {
	const redacted = redactSensitiveText(value);
	if (redacted.length <= MAX_INDEXED_CHARS) return redacted;
	return `${redacted.slice(0, MAX_INDEXED_CHARS)}\n[INDEX_TRUNCATED]`;
}

function messageText(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function experimentText(record) {
	return [
		`Experiment ${scalar(record.id, 160)}`,
		`Question: ${scalar(record.question)}`,
		`Hypothesis: ${scalar(record.hypothesis)}`,
		`Intervention: ${scalar(record.intervention)}`,
		`Prediction: ${scalar(record.prediction)}`,
		`Validity checks: ${Array.isArray(record.validityChecks) ? record.validityChecks.map((v) => scalar(v, 500)).join("; ") : ""}`,
		`Observation: ${scalar(record.observation, 4_000)}`,
		`Validity: ${scalar(record.validityJudgment, 80)}`,
		`Conclusion: ${scalar(record.conclusion, 4_000)}`,
		`Next step: ${scalar(record.nextStep, 2_000)}`,
		`Run ID: ${scalar(record.runId, 300)}`,
		`Artifacts: ${Array.isArray(record.artifacts) ? record.artifacts.map((v) => scalar(v, 500)).join("; ") : ""}`,
	]
		.filter((line) => !line.endsWith(": "))
		.join("\n");
}

function checkpointText(record) {
	return [
		`Research checkpoint ${scalar(record.id, 160)}`,
		`Label: ${scalar(record.label, 500)}`,
		`Rationale: ${scalar(record.rationale, 2_000)}`,
		`Repository: ${scalar(record.repository, 1_000)}`,
		`Ref: ${scalar(record.ref, 1_000)}`,
		`Commit: ${scalar(record.commit, 160)}`,
	]
		.filter((line) => !line.endsWith(": "))
		.join("\n");
}

function sideText(record) {
	return [
		`Side conversation ${scalar(record.id, 160)}`,
		`Question: ${scalar(record.question, 4_000)}`,
		`Answer: ${scalar(record.answer, 12_000)}`,
		`Model: ${scalar(record.model?.provider, 160)}/${scalar(record.model?.id, 160)}`,
	]
		.filter((line) => !line.endsWith(": "))
		.join("\n");
}

function parseJsonLines(path) {
	const lines = readFileSync(path, "utf8").split("\n");
	const values = [];
	let invalidLines = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line));
		} catch {
			invalidLines += 1;
		}
	}
	return { values, invalidLines };
}

function activeBranchIds(entries) {
	const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
	const active = new Set();
	let cursor = entries.at(-1);
	while (cursor?.id && !active.has(cursor.id)) {
		active.add(cursor.id);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return active;
}

function makeUnit({ sourcePath, sourceKind, sessionId, projectCwd, sessionName, entry, kind, role, text, active }) {
	const original = String(text ?? "");
	if (!original.trim()) return undefined;
	return {
		sourcePath,
		sourceKind,
		sessionId,
		projectCwd,
		sessionName,
		entryId: String(entry.id),
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		timestamp: scalar(entry.timestamp, 80),
		kind,
		role: role || null,
		activeBranch: active ? 1 : 0,
		text: boundedIndexText(original),
		contentHash: sha256(original),
	};
}

export function extractSessionUnits(path) {
	const sourcePath = resolve(path);
	const { values, invalidLines } = parseJsonLines(sourcePath);
	const header = values.find((entry) => entry?.type === "session");
	const entries = values.filter((entry) => entry?.type !== "session" && entry?.id);
	const active = activeBranchIds(entries);
	const sessionId = scalar(header?.id, 200) || sourcePath.split("/").at(-1)?.replace(/\.jsonl$/, "") || "unknown";
	const projectCwd = scalar(header?.cwd, 4_000);
	const sessionName = [...entries]
		.reverse()
		.find((entry) => entry.type === "session_info" && typeof entry.name === "string")?.name;
	const units = [];

	for (const entry of entries) {
		let unit;
		if (entry.type === "message") {
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			unit = makeUnit({
				sourcePath,
				sourceKind: "session",
				sessionId,
				projectCwd,
				sessionName,
				entry,
				kind: role === "user" ? "user" : "assistant",
				role,
				text: messageText(entry.message),
				active: active.has(entry.id),
			});
		} else if (entry.type === "compaction") {
			unit = makeUnit({
				sourcePath,
				sourceKind: "session",
				sessionId,
				projectCwd,
				sessionName,
				entry,
				kind: "compaction",
				text: entry.summary,
				active: active.has(entry.id),
			});
		} else if (entry.type === "branch_summary") {
			unit = makeUnit({
				sourcePath,
				sourceKind: "session",
				sessionId,
				projectCwd,
				sessionName,
				entry,
				kind: "branch_summary",
				text: entry.summary,
				active: active.has(entry.id),
			});
		} else if (entry.type === "custom" && entry.customType === "research-experiment") {
			unit = makeUnit({
				sourcePath,
				sourceKind: "session",
				sessionId,
				projectCwd,
				sessionName,
				entry,
				kind: "experiment",
				text: experimentText(entry.data ?? {}),
				active: active.has(entry.id),
			});
		} else if (entry.type === "custom" && entry.customType === "research-checkpoint") {
			unit = makeUnit({
				sourcePath,
				sourceKind: "session",
				sessionId,
				projectCwd,
				sessionName,
				entry,
				kind: "checkpoint",
				text: checkpointText(entry.data ?? {}),
				active: active.has(entry.id),
			});
		} else if (entry.type === "custom" && entry.customType === "research-side") {
			unit = makeUnit({
				sourcePath,
				sourceKind: "session",
				sessionId,
				projectCwd,
				sessionName,
				entry,
				kind: "side",
				text: sideText(entry.data ?? {}),
				active: active.has(entry.id),
			});
		}
		if (unit) units.push(unit);
	}

	return { units, invalidLines, sessionId, projectCwd };
}

export function extractExperimentLedgerUnits(path) {
	const sourcePath = resolve(path);
	const { values, invalidLines } = parseJsonLines(sourcePath);
	const projectCwd = dirname(dirname(dirname(sourcePath)));
	const units = values
		.filter((record) => record && typeof record.id === "string")
		.map((record) =>
			makeUnit({
				sourcePath,
				sourceKind: "experiment-ledger",
				sessionId: scalar(record.sessionId, 200) || "ledger",
				projectCwd,
				sessionName: "experiment ledger",
				entry: {
					id: record.id,
					parentId: null,
					timestamp: record.timestamp,
				},
				kind: "experiment",
				text: experimentText(record),
				active: true,
			}),
		)
		.filter(Boolean);
	return { units, invalidLines };
}

export function openMemoryIndex(dbPath) {
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS memory_sources (
			path TEXT PRIMARY KEY,
			source_kind TEXT NOT NULL,
			size INTEGER NOT NULL,
			mtime_ms INTEGER NOT NULL,
			extractor_version TEXT NOT NULL,
			indexed_at TEXT NOT NULL,
			invalid_lines INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS memory_units (
			id INTEGER PRIMARY KEY,
			source_path TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project_cwd TEXT NOT NULL,
			session_name TEXT,
			entry_id TEXT NOT NULL,
			parent_id TEXT,
			timestamp TEXT,
			kind TEXT NOT NULL,
			role TEXT,
			active_branch INTEGER NOT NULL,
			text TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			UNIQUE(source_path, entry_id, kind)
		);
		CREATE INDEX IF NOT EXISTS memory_units_session_entry ON memory_units(session_id, entry_id);
		CREATE INDEX IF NOT EXISTS memory_units_project_time ON memory_units(project_cwd, timestamp);
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_units_fts USING fts5(
			text,
			content='memory_units',
			content_rowid='id',
			tokenize='trigram'
		);
		CREATE TRIGGER IF NOT EXISTS memory_units_ai AFTER INSERT ON memory_units BEGIN
			INSERT INTO memory_units_fts(rowid, text) VALUES (new.id, new.text);
		END;
		CREATE TRIGGER IF NOT EXISTS memory_units_ad AFTER DELETE ON memory_units BEGIN
			INSERT INTO memory_units_fts(memory_units_fts, rowid, text) VALUES ('delete', old.id, old.text);
		END;
		CREATE TRIGGER IF NOT EXISTS memory_units_au AFTER UPDATE ON memory_units BEGIN
			INSERT INTO memory_units_fts(memory_units_fts, rowid, text) VALUES ('delete', old.id, old.text);
			INSERT INTO memory_units_fts(rowid, text) VALUES (new.id, new.text);
		END;
	`);

	const version = db.prepare("SELECT value FROM memory_meta WHERE key = 'extractor_version'").get()?.value;
	if (version !== MEMORY_EXTRACTOR_VERSION) {
		db.exec("BEGIN IMMEDIATE; DELETE FROM memory_units; DELETE FROM memory_sources;");
		db.prepare("INSERT OR REPLACE INTO memory_meta(key, value) VALUES ('extractor_version', ?)").run(
			MEMORY_EXTRACTOR_VERSION,
		);
		db.prepare("INSERT OR REPLACE INTO memory_meta(key, value) VALUES ('schema_version', ?)").run(
			String(MEMORY_SCHEMA_VERSION),
		);
		db.exec("COMMIT;");
	}
	return db;
}

function sourceFiles(sessionDir, experimentLedgerPaths = []) {
	const files = [];
	if (existsSync(sessionDir)) {
		for (const name of readdirSync(sessionDir)) {
			if (name.endsWith(".jsonl")) files.push({ path: resolve(join(sessionDir, name)), kind: "session" });
		}
	}
	for (const ledgerPath of experimentLedgerPaths) {
		if (existsSync(ledgerPath)) files.push({ path: resolve(ledgerPath), kind: "experiment-ledger" });
	}
	return files;
}

function replaceSource(db, source, stat, extracted) {
	const insert = db.prepare(`
		INSERT INTO memory_units(
			source_path, source_kind, session_id, project_cwd, session_name, entry_id, parent_id,
			timestamp, kind, role, active_branch, text, content_hash
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	db.exec("BEGIN IMMEDIATE;");
	try {
		db.prepare("DELETE FROM memory_units WHERE source_path = ?").run(source.path);
		for (const unit of extracted.units) {
			insert.run(
				unit.sourcePath,
				unit.sourceKind,
				unit.sessionId,
				unit.projectCwd,
				unit.sessionName ?? null,
				unit.entryId,
				unit.parentId,
				unit.timestamp || null,
				unit.kind,
				unit.role,
				unit.activeBranch,
				unit.text,
				unit.contentHash,
			);
		}
		db.prepare(`
			INSERT OR REPLACE INTO memory_sources(
				path, source_kind, size, mtime_ms, extractor_version, indexed_at, invalid_lines
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			source.path,
			source.kind,
			stat.size,
			Math.trunc(stat.mtimeMs),
			MEMORY_EXTRACTOR_VERSION,
			new Date().toISOString(),
			extracted.invalidLines,
		);
		db.exec("COMMIT;");
	} catch (error) {
		db.exec("ROLLBACK;");
		throw error;
	}
}

export function syncMemoryIndex(db, { sessionDir, experimentLedgerPaths = [] }) {
	const files = sourceFiles(sessionDir, experimentLedgerPaths);
	let rebuiltSources = 0;
	let indexedUnits = 0;
	let invalidLines = 0;
	for (const source of files) {
		const stat = statSync(source.path);
		const prior = db.prepare("SELECT size, mtime_ms, extractor_version FROM memory_sources WHERE path = ?").get(source.path);
		if (
			prior &&
			Number(prior.size) === stat.size &&
			Number(prior.mtime_ms) === Math.trunc(stat.mtimeMs) &&
			prior.extractor_version === MEMORY_EXTRACTOR_VERSION
		) {
			continue;
		}
		const extracted =
			source.kind === "session" ? extractSessionUnits(source.path) : extractExperimentLedgerUnits(source.path);
		replaceSource(db, source, stat, extracted);
		rebuiltSources += 1;
		indexedUnits += extracted.units.length;
		invalidLines += extracted.invalidLines;
	}

	const sessionPrefix = `${resolve(sessionDir)}/`;
	const liveSessions = new Set(files.filter((source) => source.kind === "session").map((source) => source.path));
	const stale = db
		.prepare("SELECT path FROM memory_sources WHERE source_kind = 'session' AND substr(path, 1, ?) = ?")
		.all(sessionPrefix.length, sessionPrefix)
		.filter((row) => !liveSessions.has(row.path));
	if (stale.length) {
		db.exec("BEGIN IMMEDIATE;");
		try {
			for (const row of stale) {
				db.prepare("DELETE FROM memory_units WHERE source_path = ?").run(row.path);
				db.prepare("DELETE FROM memory_sources WHERE path = ?").run(row.path);
			}
			db.exec("COMMIT;");
		} catch (error) {
			db.exec("ROLLBACK;");
			throw error;
		}
	}

	return { scannedSources: files.length, rebuiltSources, indexedUnits, invalidLines, prunedSources: stale.length };
}

function queryTokens(query) {
	return query.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
}

function codePointLength(value) {
	return [...value].length;
}

function quoteFts(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

function buildFilters(options, alias = "u") {
	const clauses = [];
	const params = [];
	if (options.scope !== "all") {
		const projectRoot = resolve(options.currentProjectRoot || options.currentCwd);
		const projectPrefix = `${projectRoot}/`;
		clauses.push(`(${alias}.project_cwd = ? OR substr(${alias}.project_cwd, 1, ?) = ?)`);
		params.push(projectRoot, projectPrefix.length, projectPrefix);
	}
	if (!options.includeAbandonedBranches) clauses.push(`${alias}.active_branch = 1`);
	if (!options.includeCurrentSession && options.currentSessionId) {
		clauses.push(`${alias}.session_id <> ?`);
		params.push(options.currentSessionId);
	}
	if (options.kinds?.length) {
		clauses.push(`${alias}.kind IN (${options.kinds.map(() => "?").join(", ")})`);
		params.push(...options.kinds);
	}
	if (options.after) {
		clauses.push(`${alias}.timestamp >= ?`);
		params.push(options.after);
	}
	if (options.before) {
		clauses.push(`${alias}.timestamp <= ?`);
		params.push(options.before);
	}
	return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function candidateKey(row) {
	return `${row.source_path}\u0000${row.entry_id}\u0000${row.kind}`;
}

function snippetFor(text, query, tokens, maxChars = 420) {
	const lower = text.toLocaleLowerCase();
	const needles = [query, ...tokens].map((value) => value.toLocaleLowerCase()).filter(Boolean);
	let at = -1;
	for (const needle of needles) {
		const found = lower.indexOf(needle);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	if (at < 0) at = 0;
	const start = Math.max(0, at - Math.floor(maxChars / 3));
	const end = Math.min(text.length, start + maxChars);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function reliability(kind) {
	if (kind === "experiment") return "recorded-evidence";
	if (kind === "checkpoint") return "recorded-state";
	if (kind === "user") return "user-statement";
	if (kind === "compaction" || kind === "branch_summary") return "derived-summary";
	return "assistant-synthesis";
}

export function searchMemory(db, options) {
	const query = scalar(options.query, 500);
	if (!query) throw new Error("query must not be empty");
	const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_RESULT_LIMIT, 20));
	const tokens = queryTokens(query);
	const ftsTerms = [...new Set(tokens.filter((token) => codePointLength(token) >= 3))].slice(0, 12);
	const shortTerms = [...new Set(tokens.filter((token) => codePointLength(token) < 3))].slice(0, 6);
	const candidates = new Map();
	const filters = buildFilters(options);

	if (ftsTerms.length) {
		const expression = ftsTerms.map(quoteFts).join(" OR ");
		const rows = db
			.prepare(`
				SELECT u.*, bm25(memory_units_fts) AS fts_rank
				FROM memory_units_fts
				JOIN memory_units u ON u.id = memory_units_fts.rowid
				WHERE memory_units_fts MATCH ?${filters.sql}
				ORDER BY bm25(memory_units_fts)
				LIMIT 200
			`)
			.all(expression, ...filters.params);
		for (const row of rows) candidates.set(candidateKey(row), row);
	}

	for (const term of shortTerms) {
		const rows = db
			.prepare(`
				SELECT u.*, 0 AS fts_rank FROM memory_units u
				WHERE instr(lower(u.text), lower(?)) > 0${filters.sql}
				ORDER BY u.timestamp DESC
				LIMIT 100
			`)
			.all(term, ...filters.params);
		for (const row of rows) candidates.set(candidateKey(row), row);
	}

	if (!candidates.size) {
		const rows = db
			.prepare(`
				SELECT u.*, 0 AS fts_rank FROM memory_units u
				WHERE instr(lower(u.text), lower(?)) > 0${filters.sql}
				ORDER BY u.timestamp DESC
				LIMIT 100
			`)
			.all(query, ...filters.params);
		for (const row of rows) candidates.set(candidateKey(row), row);
	}

	const queryLower = query.toLocaleLowerCase();
	const tokenLowers = tokens.map((token) => token.toLocaleLowerCase());
	const kindWeights = {
		experiment: 45,
		checkpoint: 28,
		user: 18,
		side: 8,
		assistant: 8,
		compaction: 4,
		branch_summary: 2,
	};
	const scored = [...candidates.values()].map((row) => {
		const lower = row.text.toLocaleLowerCase();
		const coverage = tokenLowers.filter((token) => lower.includes(token)).length;
		const exact = lower.includes(queryLower) ? 60 : 0;
		const branchBoost = row.active_branch ? 8 : 0;
		const rankBoost = Number.isFinite(Number(row.fts_rank)) ? Math.max(-20, -Number(row.fts_rank)) : 0;
		const score = exact + coverage * 12 + (kindWeights[row.kind] ?? 0) + branchBoost + rankBoost;
		return { row, score };
	});
	scored.sort((a, b) => b.score - a.score || String(b.row.timestamp).localeCompare(String(a.row.timestamp)));

	const seenHashes = new Set();
	const results = [];
	for (const { row, score } of scored) {
		if (seenHashes.has(row.content_hash)) continue;
		seenHashes.add(row.content_hash);
		results.push({
			ref: `S:${row.session_id}/E:${row.entry_id}`,
			sessionId: row.session_id,
			entryId: row.entry_id,
			parentId: row.parent_id,
			projectCwd: row.project_cwd,
			sessionName: row.session_name ?? undefined,
			timestamp: row.timestamp,
			kind: row.kind,
			reliability: reliability(row.kind),
			activeBranch: Boolean(row.active_branch),
			snippet: snippetFor(row.text, query, tokens),
			contentHash: row.content_hash,
			score: Math.round(score * 100) / 100,
		});
		if (results.length >= limit) break;
	}
	return results;
}

export function readMemory(db, { sessionId, entryId, radius = 1, maxChars = 12_000 }) {
	const boundedRadius = Math.max(0, Math.min(Number(radius) || 0, 10));
	const boundedChars = Math.max(500, Math.min(Number(maxChars) || 12_000, 40_000));
	const center = db
		.prepare("SELECT * FROM memory_units WHERE session_id = ? AND entry_id = ? ORDER BY source_kind = 'experiment-ledger' DESC LIMIT 1")
		.get(sessionId, entryId);
	if (!center) return undefined;
	const rows = db
		.prepare(`
			SELECT * FROM memory_units
			WHERE source_path = ? AND id BETWEEN ? AND ?
			ORDER BY id
		`)
		.all(center.source_path, center.id - boundedRadius, center.id + boundedRadius);
	let remaining = boundedChars;
	const entries = [];
	for (const row of rows) {
		if (remaining <= 0) break;
		const text = row.text.length <= remaining ? row.text : `${row.text.slice(0, remaining)}\n[READ_TRUNCATED]`;
		remaining -= text.length;
		entries.push({
			ref: `S:${row.session_id}/E:${row.entry_id}`,
			entryId: row.entry_id,
			parentId: row.parent_id,
			timestamp: row.timestamp,
			kind: row.kind,
			reliability: reliability(row.kind),
			activeBranch: Boolean(row.active_branch),
			contentHash: row.content_hash,
			text,
		});
	}
	return {
		sessionId: center.session_id,
		projectCwd: center.project_cwd,
		sessionName: center.session_name ?? undefined,
		sourcePath: center.source_path,
		entries,
	};
}
