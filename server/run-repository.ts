import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import type { Db } from "./db/db.ts";
import {
	type RunEventType,
	type RunStatus,
	runEvents,
	runs,
} from "./db/schema.ts";

export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;

export type RunRepository = {
	insertRun(run: {
		id: string;
		agentName: string;
		issueKey: string;
		issueTitle: string;
		startedAt: string;
		attempt: number;
		parentRunId: string | null;
	}): void;
	setSessionId(runId: string, sessionId: string): void;
	completeRun(
		runId: string,
		params: { completedAt: string; durationMs: number },
	): void;
	failRun(
		runId: string,
		params: { error: string; completedAt: string; durationMs?: number },
	): void;
	insertEvent(event: {
		runId: string;
		type: RunEventType;
		data: Record<string, unknown>;
		createdAt: string;
	}): void;
	getRunningSnapshot(): { id: string; issueKey: string }[];
	getRunById(id: string): Run | undefined;
	getRuns(filters: {
		agent?: string | undefined;
		status?: RunStatus | undefined;
		limit: number;
	}): Run[];
	getRunEvents(runId: string): RunEvent[];
};

export function createRunRepository(db: Db): RunRepository {
	return {
		insertRun(run) {
			db.insert(runs)
				.values({ ...run, status: "running" })
				.run();
		},

		setSessionId(runId, sessionId) {
			db.update(runs).set({ sessionId }).where(eq(runs.id, runId)).run();
		},

		completeRun(runId, params) {
			db.update(runs)
				.set({ status: "completed", ...params })
				.where(eq(runs.id, runId))
				.run();
		},

		failRun(runId, params) {
			const { durationMs, ...rest } = params;
			db.update(runs)
				.set({
					status: "failed",
					...rest,
					...(durationMs != null && { durationMs }),
				})
				.where(eq(runs.id, runId))
				.run();
		},

		insertEvent(event) {
			db.insert(runEvents)
				.values({ id: randomUUID(), ...event })
				.run();
		},

		getRunningSnapshot() {
			return db
				.select({ id: runs.id, issueKey: runs.issueKey })
				.from(runs)
				.where(and(eq(runs.status, "running"), isNotNull(runs.issueKey)))
				.all() as { id: string; issueKey: string }[];
		},

		getRunById(id) {
			return db.select().from(runs).where(eq(runs.id, id)).get();
		},

		getRuns(filters) {
			const conditions = [];
			if (filters.agent) conditions.push(eq(runs.agentName, filters.agent));
			if (filters.status) conditions.push(eq(runs.status, filters.status));

			const query = db
				.select()
				.from(runs)
				.orderBy(desc(runs.startedAt))
				.limit(filters.limit);

			return conditions.length > 0
				? query.where(and(...conditions)).all()
				: query.all();
		},

		getRunEvents(runId) {
			return db
				.select()
				.from(runEvents)
				.where(eq(runEvents.runId, runId))
				.orderBy(asc(runEvents.createdAt))
				.all();
		},
	};
}
