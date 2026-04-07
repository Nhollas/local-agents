import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../../core/db/db.ts";
import { migrate } from "../../core/db/migrate.ts";
import { runEvents, runs } from "../../core/db/schema.ts";

export function createTestDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.pragma("journal_mode = WAL");
	const db = drizzle(sqlite);
	migrate(db);
	return db;
}

export function seedRun(
	db: Db,
	overrides: Partial<typeof runs.$inferInsert> & { id: string },
) {
	db.insert(runs)
		.values({
			agentName: "test-agent",
			status: "completed",
			startedAt: new Date().toISOString(),
			...overrides,
		})
		.run();
}

export function seedEvent(
	db: Db,
	overrides: Partial<typeof runEvents.$inferInsert> & {
		id: string;
		runId: string;
	},
) {
	db.insert(runEvents)
		.values({
			type: "run:started",
			data: {},
			createdAt: new Date().toISOString(),
			...overrides,
		})
		.run();
}
