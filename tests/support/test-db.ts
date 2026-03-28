import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../../core/db.ts";
import { migrate } from "../../core/migrate.ts";

export function createTestDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.pragma("journal_mode = WAL");
	const db = drizzle(sqlite);
	migrate(db);
	return db;
}
