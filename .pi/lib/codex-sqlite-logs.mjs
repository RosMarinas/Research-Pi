import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CODEX_SQLITE_LOG_ENV = "PI_CODEX_SQLITE_LOGS";
export const CODEX_SQLITE_LOG_TRIGGER = "research_pi_suppress_codex_internal_logs";

function logDatabaseVersion(name) {
	return Number(/^logs_(\d+)\.sqlite$/.exec(name)?.[1] ?? -1);
}

export function resolveCodexLogDatabase(sqliteHome) {
	const candidates = readdirSync(sqliteHome, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /^logs_\d+\.sqlite$/.test(entry.name))
		.sort((left, right) => logDatabaseVersion(right.name) - logDatabaseVersion(left.name));
	return candidates[0] ? join(sqliteHome, candidates[0].name) : null;
}

export function codexSqliteLogMode(environment = process.env) {
	return environment[CODEX_SQLITE_LOG_ENV] === "1" ? "preserve" : "suppress";
}

export function configureCodexSqliteLogs(sqliteHome, options = {}) {
	const mode = options.mode ?? codexSqliteLogMode(options.environment);
	if (!new Set(["suppress", "preserve"]).has(mode)) throw new Error(`Unsupported Codex SQLite log mode: ${mode}`);
	const databasePath = resolveCodexLogDatabase(sqliteHome);
	if (!databasePath) return { mode: "unavailable", databasePath: null };

	const database = new DatabaseSync(databasePath);
	try {
		database.exec("PRAGMA busy_timeout=5000;");
		if (mode === "preserve") {
			database.exec(`DROP TRIGGER IF EXISTS ${CODEX_SQLITE_LOG_TRIGGER};`);
		} else {
			database.exec(
				`CREATE TRIGGER IF NOT EXISTS ${CODEX_SQLITE_LOG_TRIGGER} `
				+ "BEFORE INSERT ON logs BEGIN SELECT RAISE(IGNORE); END;",
			);
		}
	} finally {
		database.close();
	}
	return { mode, databasePath };
}
