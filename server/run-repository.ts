import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import type { Db } from "./db/db.ts";
import {
	type FinalizeFailurePhase,
	type PrKind,
	type RunStatus,
	runEvents,
	runStepOutputs,
	runSteps,
	runs,
} from "./db/schema.ts";
import {
	type RunEvent,
	type RunEventData,
	type RunEventKind,
	runEventSchema,
	type ToolBashData,
	toolBashDataSchema,
} from "./event-schema.ts";
import type { IssueKey, RepoSlug, RunId } from "./types/brands.ts";

export type RunPr = {
	repo: string;
	number: number;
	url: string;
	kind: PrKind;
};

type RunBase = {
	id: RunId;
	repo: RepoSlug;
	repoUrl: string | null;
	branch: string | null;
	workspaceDir: string | null;
	issueKey: IssueKey | null;
	issueTitle: string | null;
	issueUrl: string | null;
	startedAt: string;
	costUsd: number | null;
	tokensInput: number | null;
	tokensOutput: number | null;
	pr: RunPr | null;
	langfuseTraceUrl: string | null;
};

export type RunFailedStep = { index: number; name: string };

export type RunFinalizeFailure = {
	phase: FinalizeFailurePhase;
	error: string;
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
	failedStep: RunFailedStep | null;
	finalizeFailure: RunFinalizeFailure | null;
};

export type Run = RunningRun | CompletedRun | FailedRun;

export type RunStep = typeof runSteps.$inferSelect;

export type StepUsage = {
	costUsd: number;
	tokensInput: number;
	tokensOutput: number;
};

export type InsertEventInput = {
	runId: RunId;
	kind: RunEventKind;
	stepName: string | null;
	data: RunEventData;
	createdAt: string;
};

export type RunRepository = {
	insertRun(run: {
		id: RunId;
		repo: RepoSlug;
		repoUrl: string;
		issueKey: IssueKey;
		issueTitle: string;
		issueUrl: string | null;
		startedAt: string;
	}): void;
	completeRun(
		runId: RunId,
		params: { completedAt: string; durationMs: number },
	): void;
	failRun(
		runId: RunId,
		params: {
			error: string;
			completedAt: string;
			durationMs?: number;
			finalizeFailure?: RunFinalizeFailure;
		},
	): void;
	setRunBranch(runId: RunId, branch: string): void;
	setRunWorkspaceDir(runId: RunId, workspaceDir: string): void;
	setRunPr(runId: RunId, pr: RunPr): void;
	setRunLangfuseTraceUrl(runId: RunId, url: string): void;
	addRunUsage(runId: RunId, usage: StepUsage): void;
	insertEvent(event: InsertEventInput): RunEvent;
	updateToolBashState(
		eventId: string,
		patch: Partial<Pick<ToolBashData, "state" | "exitCode">>,
	): RunEvent | undefined;
	getRunningSnapshot(): { id: RunId; issueKey: IssueKey; repo: RepoSlug }[];
	countRunning(): number;
	getRunById(id: RunId): Run | undefined;
	getRuns(filters: {
		status?: RunStatus | undefined;
		repo?: RepoSlug | undefined;
		limit: number;
	}): Run[];
	getRunEvents(runId: RunId): RunEvent[];
	getRunEventsAfterSeq(runId: RunId, sinceSeq: number): RunEvent[];
	getAllEventsAfterSeq(sinceSeq: number): RunEvent[];
	getEventSeqById(id: string): number | undefined;
	getInflightToolBash(runId: RunId): RunEvent[];
	insertSteps(
		runId: RunId,
		steps: ReadonlyArray<{ index: number; name: string }>,
	): void;
	startStep(
		runId: RunId,
		stepIndex: number,
		params: { startedAt: string },
	): void;
	completeStep(
		runId: RunId,
		stepIndex: number,
		params: { completedAt: string; durationMs: number },
	): void;
	failStep(
		runId: RunId,
		stepIndex: number,
		params: { completedAt: string; durationMs: number; error: string },
	): void;
	getRunSteps(runId: RunId): RunStep[];
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
			const { durationMs, finalizeFailure, ...rest } = params;
			db.update(runs)
				.set({
					status: "failed",
					...rest,
					...(durationMs != null && { durationMs }),
					...(finalizeFailure != null && {
						finalizeFailurePhase: finalizeFailure.phase,
						finalizeFailureError: finalizeFailure.error,
					}),
				})
				.where(eq(runs.id, runId))
				.run();
		},

		setRunBranch(runId, branch) {
			db.update(runs).set({ branch }).where(eq(runs.id, runId)).run();
		},

		setRunWorkspaceDir(runId, workspaceDir) {
			db.update(runs).set({ workspaceDir }).where(eq(runs.id, runId)).run();
		},

		setRunPr(runId, pr) {
			db.update(runs)
				.set({
					prRepo: pr.repo,
					prNumber: pr.number,
					prUrl: pr.url,
					prKind: pr.kind,
				})
				.where(eq(runs.id, runId))
				.run();
		},

		setRunLangfuseTraceUrl(runId, url) {
			db.update(runs)
				.set({ langfuseTraceUrl: url })
				.where(eq(runs.id, runId))
				.run();
		},

		addRunUsage(runId, usage) {
			db.update(runs)
				.set({
					costUsd: sql`COALESCE(${runs.costUsd}, 0) + ${usage.costUsd}`,
					tokensInput: sql`COALESCE(${runs.tokensInput}, 0) + ${usage.tokensInput}`,
					tokensOutput: sql`COALESCE(${runs.tokensOutput}, 0) + ${usage.tokensOutput}`,
				})
				.where(eq(runs.id, runId))
				.run();
		},

		insertEvent(event) {
			const id = randomUUID();
			const row = db
				.insert(runEvents)
				.values({ id, ...event })
				.returning()
				.get();
			return rowToEvent(row);
		},

		updateToolBashState(eventId, patch) {
			const row = db
				.select()
				.from(runEvents)
				.where(eq(runEvents.id, eventId))
				.get();
			if (!row || row.kind !== "tool:bash") return undefined;
			const merged: ToolBashData = {
				...toolBashDataSchema.parse(row.data),
				...patch,
			};
			db.update(runEvents)
				.set({ data: merged })
				.where(eq(runEvents.id, eventId))
				.run();
			return rowToEvent({ ...row, data: merged });
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

		countRunning() {
			const row = db
				.select({ n: sql<number>`count(*)` })
				.from(runs)
				.where(eq(runs.status, "running"))
				.get();
			return row?.n ?? 0;
		},

		getRunById(id) {
			const row = db.select().from(runs).where(eq(runs.id, id)).get();
			if (!row) return undefined;
			const failedStep =
				row.status === "failed"
					? (findFailedSteps(db, [row.id]).get(row.id) ?? null)
					: null;
			return rowToRun(row, failedStep);
		},

		getRuns(filters) {
			const conditions = [];
			if (filters.status) conditions.push(eq(runs.status, filters.status));
			if (filters.repo) conditions.push(eq(runs.repo, filters.repo));

			const query = db
				.select()
				.from(runs)
				.orderBy(desc(runs.startedAt))
				.limit(filters.limit);

			const rows =
				conditions.length > 0
					? query.where(and(...conditions)).all()
					: query.all();

			const failedIds = rows
				.filter((r) => r.status === "failed")
				.map((r) => r.id);
			const failedSteps =
				failedIds.length === 0 ? new Map() : findFailedSteps(db, failedIds);
			return rows.map((row) =>
				rowToRun(
					row,
					row.status === "failed" ? (failedSteps.get(row.id) ?? null) : null,
				),
			);
		},

		getRunEvents(runId) {
			return db
				.select()
				.from(runEvents)
				.where(eq(runEvents.runId, runId))
				.orderBy(asc(runEvents.seq))
				.all()
				.map(rowToEvent);
		},

		getRunEventsAfterSeq(runId, sinceSeq) {
			return db
				.select()
				.from(runEvents)
				.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, sinceSeq)))
				.orderBy(asc(runEvents.seq))
				.all()
				.map(rowToEvent);
		},

		getAllEventsAfterSeq(sinceSeq) {
			return db
				.select()
				.from(runEvents)
				.where(gt(runEvents.seq, sinceSeq))
				.orderBy(asc(runEvents.seq))
				.all()
				.map(rowToEvent);
		},

		getEventSeqById(id) {
			const row = db
				.select({ seq: runEvents.seq })
				.from(runEvents)
				.where(eq(runEvents.id, id))
				.get();
			return row?.seq;
		},

		getInflightToolBash(runId) {
			return db
				.select()
				.from(runEvents)
				.where(and(eq(runEvents.runId, runId), eq(runEvents.kind, "tool:bash")))
				.all()
				.map(rowToEvent)
				.filter(
					(event): event is Extract<RunEvent, { kind: "tool:bash" }> =>
						event.kind === "tool:bash" && event.data.state === "running",
				);
		},

		insertSteps(runId, steps) {
			if (steps.length === 0) return;
			db.insert(runSteps)
				.values(
					steps.map((s) => ({
						runId,
						index: s.index,
						name: s.name,
						state: "pending" as const,
					})),
				)
				.run();
		},

		startStep(runId, stepIndex, params) {
			db.update(runSteps)
				.set({ state: "running", startedAt: params.startedAt })
				.where(and(eq(runSteps.runId, runId), eq(runSteps.index, stepIndex)))
				.run();
		},

		completeStep(runId, stepIndex, params) {
			db.update(runSteps)
				.set({
					state: "completed",
					completedAt: params.completedAt,
					durationMs: params.durationMs,
				})
				.where(and(eq(runSteps.runId, runId), eq(runSteps.index, stepIndex)))
				.run();
		},

		failStep(runId, stepIndex, params) {
			db.update(runSteps)
				.set({
					state: "failed",
					completedAt: params.completedAt,
					durationMs: params.durationMs,
					error: params.error,
				})
				.where(and(eq(runSteps.runId, runId), eq(runSteps.index, stepIndex)))
				.run();
		},

		getRunSteps(runId) {
			return db
				.select()
				.from(runSteps)
				.where(eq(runSteps.runId, runId))
				.orderBy(asc(runSteps.index))
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

type RunRow = typeof runs.$inferSelect;
type RunEventRow = typeof runEvents.$inferSelect;

function findFailedSteps(db: Db, ids: RunId[]): Map<RunId, RunFailedStep> {
	const rows = db
		.select({
			runId: runSteps.runId,
			index: runSteps.index,
			name: runSteps.name,
		})
		.from(runSteps)
		.where(and(inArray(runSteps.runId, ids), eq(runSteps.state, "failed")))
		.all();
	return new Map(rows.map((r) => [r.runId, { index: r.index, name: r.name }]));
}

function rowToRun(row: RunRow, failedStep: RunFailedStep | null): Run {
	const pr =
		row.prRepo != null &&
		row.prNumber != null &&
		row.prUrl != null &&
		row.prKind != null
			? {
					repo: row.prRepo,
					number: row.prNumber,
					url: row.prUrl,
					kind: row.prKind,
				}
			: null;

	const base: RunBase = {
		id: row.id,
		repo: row.repo,
		repoUrl: row.repoUrl,
		branch: row.branch,
		workspaceDir: row.workspaceDir,
		issueKey: row.issueKey,
		issueTitle: row.issueTitle,
		issueUrl: row.issueUrl,
		startedAt: row.startedAt,
		costUsd: row.costUsd,
		tokensInput: row.tokensInput,
		tokensOutput: row.tokensOutput,
		pr,
		langfuseTraceUrl: row.langfuseTraceUrl,
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
				failedStep,
				finalizeFailure:
					row.finalizeFailurePhase != null && row.finalizeFailureError != null
						? {
								phase: row.finalizeFailurePhase,
								error: row.finalizeFailureError,
							}
						: null,
			};
	}
}

function rowToEvent(row: RunEventRow): RunEvent {
	return runEventSchema.parse(row);
}
