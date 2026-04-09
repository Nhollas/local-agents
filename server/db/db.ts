import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export type Db = ReturnType<typeof drizzle>;

let db: Db | undefined;
let sqlite: InstanceType<typeof Database> | undefined;

/**
 * Get or create the shared Drizzle database instance.
 * Uses SQLite via better-sqlite3 stored at DATA_DIR/gateway.db.
 */
export function getDb(dbPath?: string): Db {
	if (db) return db;
	const resolvedPath =
		dbPath ?? `${process.env["DATA_DIR"] ?? ".data"}/gateway.db`;
	mkdirSync(dirname(resolvedPath), { recursive: true });
	sqlite = new Database(resolvedPath);
	sqlite.pragma("journal_mode = WAL");
	db = drizzle(sqlite);
	return db;
}

export function closeDb(): void {
	sqlite?.close();
	sqlite = undefined;
	db = undefined;
}
