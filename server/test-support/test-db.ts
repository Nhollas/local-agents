import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { runEvents, runSteps, runs } from "../db/schema.ts";
export function createTestDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.pragma("journal_mode = WAL");
	const db = drizzle(sqlite);
	migrate(db);
	return db;
}

type LooseRunInsert = Omit<
	Partial<typeof runs.$inferInsert>,
	"id" | "repo" | "issueKey"
> & {
	id: string;
	repo?: string;
	issueKey?: string | null;
};

const variantDefaultsByStatus = {
	running: {},
	completed: { durationMs: 0 },
	failed: { durationMs: 0, error: "test error" },
} as const;

export function seedRun(db: Db, overrides: LooseRunInsert) {
	const { id, repo, issueKey: keyStr, ...rest } = overrides;
	const status = rest.status ?? "completed";
	const now = new Date().toISOString();
	const completedAt = status === "running" ? null : now;

	db.insert(runs)
		.values({
			startedAt: now,
			completedAt,
			...variantDefaultsByStatus[status],
			...rest,
			status,
			id: id,
			repo: repo ?? "test-owner/test-repo",
			...(keyStr != null && { issueKey: keyStr }),
		})
		.run();
}

type LooseStepInsert = Omit<Partial<typeof runSteps.$inferInsert>, "runId"> & {
	runId: string;
	index: number;
	name: string;
};

export function seedStep(db: Db, overrides: LooseStepInsert) {
	const { runId: runIdStr, ...rest } = overrides;
	db.insert(runSteps)
		.values({
			state: "pending",
			...rest,
			runId: runIdStr,
		})
		.run();
}

export function getRun(
	db: Db,
	id: string,
): typeof runs.$inferSelect | undefined {
	return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function getEvents(
	db: Db,
	id: string,
): (typeof runEvents.$inferSelect)[] {
	return db.select().from(runEvents).where(eq(runEvents.runId, id)).all();
}
