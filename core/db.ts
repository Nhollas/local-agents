import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

let db: ReturnType<typeof drizzle> | undefined;

/**
 * Get or create the shared Drizzle database instance.
 * Uses SQLite via better-sqlite3 stored at DATA_DIR/gateway.db.
 */
export function getDb(dbPath?: string) {
  if (db) return db;
  const resolvedPath = dbPath ?? `${process.env.DATA_DIR ?? ".data"}/gateway.db`;
  const sqlite = new Database(resolvedPath);
  sqlite.pragma("journal_mode = WAL");
  db = drizzle(sqlite);
  return db;
}

/** Create a fresh database connection (for testing). */
export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite);
}

/** Reset the singleton (for testing). */
export function resetDb() {
  db = undefined;
}
