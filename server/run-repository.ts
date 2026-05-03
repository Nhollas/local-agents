import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import type { Db } from "./db/db.ts";
import {
	type RunEventType,
	type RunStatus,
	runEvents,
	runStepOutputs,
	runs,
} from "./db/schema.ts";
import type { IssueKey, RepoSlug, RunId } from "./types/brands.ts";
import { assertNever } from "./types/exhaustive.ts";

type RunRow = typeof runs.$inferSelect;

type RunBase = {
	id: RunId;
	agentName: string;
	repo: RepoSlug;
	issueKey: IssueKey | null;
	issueTitle: string | null;
	startedAt: string;
};

export type RunningRun = RunBase & { status: "running" };
export type CompletedRun = RunBase & {
	status: "completed";
	completedAt: string;
	durationMs: number;
};
export type FailedRun = RunBase & {
	status: "failed";
	completedAt: string;
	durationMs: number | null;
	error: string;
};

export type Run = RunningRun | CompletedRun | FailedRun;

export type RunEvent = typeof runEvents.$inferSelect;

function rowToRun(row: RunRow): Run {
	const base: RunBase = {
		id: row.id,
		agentName: row.agentName,
		repo: row.repo,
		issueKey: row.issueKey,
		issueTitle: row.issueTitle,
		startedAt: row.startedAt,
	};

	switch (row.status) {
		case "running":
			return { ...base, status: "running" };
		case "completed":
			if (row.completedAt == null || row.durationMs == null) {
				throw new Error(
					`Invariant: completed run ${row.id} missing completedAt or durationMs`,
				);
			}
			return {
				...base,
				status: "completed",
				completedAt: row.completedAt,
				durationMs: row.durationMs,
			};
		case "failed":
			if (row.completedAt == null || row.error == null) {
				throw new Error(
					`Invariant: failed run ${row.id} missing completedAt or error`,
				);
			}
			return {
				...base,
				status: "failed",
				completedAt: row.completedAt,
				durationMs: row.durationMs,
				error: row.error,
			};
		/* v8 ignore next 2 -- unreachable; RunStatus is exhaustively handled above */
		default:
			return assertNever(row.status);
	}
}

export type RunRepository = {
	insertRun(run: {
		id: RunId;
		agentName: string;
		repo: RepoSlug;
		issueKey: IssueKey;
		issueTitle: string;
		startedAt: string;
	}): void;
	completeRun(
		runId: RunId,
		params: { completedAt: string; durationMs: number },
	): void;
	failRun(
		runId: RunId,
		params: { error: string; completedAt: string; durationMs?: number },
	): void;
	insertEvent(event: {
		runId: RunId;
		type: RunEventType;
		data: Record<string, unknown>;
		createdAt: string;
	}): void;
	getRunningSnapshot(): { id: RunId; issueKey: IssueKey; repo: RepoSlug }[];
	getRunById(id: RunId): Run | undefined;
	getRuns(filters: {
		agent?: string | undefined;
		status?: RunStatus | undefined;
		limit: number;
	}): Run[];
	getRunEvents(runId: RunId): RunEvent[];
	writeStepOutput(runId: RunId, stepName: string, value: unknown): void;
};

export function createRunRepository(db: Db): RunRepository {
	return {
		insertRun(run) {
			db.insert(runs)
				.values({ ...run, status: "running" })
				.run();
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
				.select({ id: runs.id, issueKey: runs.issueKey, repo: runs.repo })
				.from(runs)
				.where(and(eq(runs.status, "running"), isNotNull(runs.issueKey)))
				.all()
				.filter(
					(row): row is { id: RunId; issueKey: IssueKey; repo: RepoSlug } =>
						row.issueKey != null,
				);
		},

		getRunById(id) {
			const row = db.select().from(runs).where(eq(runs.id, id)).get();
			return row ? rowToRun(row) : undefined;
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

			const rows =
				conditions.length > 0
					? query.where(and(...conditions)).all()
					: query.all();
			return rows.map(rowToRun);
		},

		getRunEvents(runId) {
			return db
				.select()
				.from(runEvents)
				.where(eq(runEvents.runId, runId))
				.orderBy(asc(runEvents.createdAt))
				.all();
		},

		writeStepOutput(runId, stepName, value) {
			const createdAt = new Date().toISOString();
			db.insert(runStepOutputs)
				.values({ runId, stepName, outputJson: value, createdAt })
				.onConflictDoUpdate({
					target: [runStepOutputs.runId, runStepOutputs.stepName],
					set: { outputJson: value, createdAt },
				})
				.run();
		},
	};
}
