import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	CODEX_SQLITE_LOG_TRIGGER,
	codexSqliteLogMode,
	configureCodexSqliteLogs,
	resolveCodexLogDatabase,
} from "../.pi/lib/codex-sqlite-logs.mjs";

function createLogDatabase(path) {
	const database = new DatabaseSync(path);
	database.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, feedback_log_body TEXT);");
	database.close();
}

function insertAndCount(path, body) {
	const database = new DatabaseSync(path);
	database.prepare("INSERT INTO logs (feedback_log_body) VALUES (?)").run(body);
	const count = database.prepare("SELECT COUNT(*) AS count FROM logs").get().count;
	database.close();
	return count;
}

test("Research Pi suppresses only the newest Codex internal log database and can restore diagnostics", () => {
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-sqlite-"));
	try {
		const oldDatabase = join(root, "logs_1.sqlite");
		const activeDatabase = join(root, "logs_2.sqlite");
		createLogDatabase(oldDatabase);
		createLogDatabase(activeDatabase);

		assert.equal(resolveCodexLogDatabase(root), activeDatabase);
		assert.equal(configureCodexSqliteLogs(root, { mode: "suppress" }).databasePath, activeDatabase);
		assert.equal(insertAndCount(activeDatabase, "token delta"), 0);
		assert.equal(insertAndCount(oldDatabase, "historical log"), 1);

		const database = new DatabaseSync(activeDatabase);
		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?").get(CODEX_SQLITE_LOG_TRIGGER).count,
			1,
		);
		database.close();

		configureCodexSqliteLogs(root, { mode: "preserve" });
		assert.equal(insertAndCount(activeDatabase, "explicit diagnostics"), 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex SQLite logs are suppressed by default and require an explicit diagnostic opt-in", () => {
	assert.equal(codexSqliteLogMode({}), "suppress");
	assert.equal(codexSqliteLogMode({ PI_CODEX_SQLITE_LOGS: "1" }), "preserve");
	const root = mkdtempSync(join(tmpdir(), "research-pi-codex-sqlite-empty-"));
	try {
		mkdirSync(root, { recursive: true });
		assert.deepEqual(configureCodexSqliteLogs(root), { mode: "unavailable", databasePath: null });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
