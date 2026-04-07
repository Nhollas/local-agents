import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./db.ts";

export function migrate(db: Db) {
	drizzleMigrate(db, { migrationsFolder: "drizzle" });
}
