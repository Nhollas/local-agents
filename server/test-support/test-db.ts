import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { runEvents, runs } from "../db/schema.ts";
import { issueKey, repoSlug, runId } from "../types/brands.ts";

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
			agentName: "test-agent",
			startedAt: now,
			completedAt,
			...variantDefaultsByStatus[status],
			...rest,
			status,
			id: runId(id),
			repo: repoSlug(repo ?? "test-owner/test-repo"),
			...(keyStr != null && { issueKey: issueKey(keyStr) }),
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
