import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../../db/db.ts";
import { migrate } from "../../db/migrate.ts";
import { runEvents, runs } from "../../db/schema.ts";
import {
	type IssueKey,
	issueKey,
	type RunId,
	runId,
} from "../../types/brands.ts";

export function createTestDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.pragma("journal_mode = WAL");
	const db = drizzle(sqlite);
	migrate(db);
	return db;
}

type LooseRunInsert = Omit<
	Partial<typeof runs.$inferInsert>,
	"id" | "issueKey" | "parentRunId"
> & {
	id: string;
	issueKey?: string | null;
	parentRunId?: string | null;
};

export function seedRun(db: Db, overrides: LooseRunInsert) {
	const { id, issueKey: keyStr, parentRunId, ...rest } = overrides;
	db.insert(runs)
		.values({
			agentName: "test-agent",
			status: "completed",
			startedAt: new Date().toISOString(),
			...rest,
			id: runId(id),
			...(keyStr != null && { issueKey: issueKey(keyStr) as IssueKey | null }),
			...(parentRunId != null && {
				parentRunId: runId(parentRunId) as RunId | null,
			}),
		})
		.run();
}

type LooseEventInsert = Omit<
	Partial<typeof runEvents.$inferInsert>,
	"id" | "runId"
> & {
	id: string;
	runId: string;
};

export function seedEvent(db: Db, overrides: LooseEventInsert) {
	const { id, runId: runIdStr, ...rest } = overrides;
	db.insert(runEvents)
		.values({
			type: "run:started",
			data: {},
			createdAt: new Date().toISOString(),
			...rest,
			id,
			runId: runId(runIdStr),
		})
		.run();
}

export function getRun(
	db: Db,
	id: string,
): typeof runs.$inferSelect | undefined {
	return db
		.select()
		.from(runs)
		.where(eq(runs.id, runId(id)))
		.get();
}

export function getEvents(
	db: Db,
	id: string,
): (typeof runEvents.$inferSelect)[] {
	return db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId(id)))
		.all();
}
