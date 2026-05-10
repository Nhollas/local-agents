import { randomUUID } from "node:crypto";
import type { RunEventData, RunEventKind, ToolBashData } from "../db/schema.ts";
import { eventBus, type RunEvent } from "../event-bus.ts";
import type { RunFinalizeFailure, RunRepository } from "../run-repository.ts";
import {
	type IssueKey,
	type RepoSlug,
	type RunId,
	runId,
} from "../types/brands.ts";
import { createJobQueue, type JobQueue } from "./queue.ts";

export const ABORT_ERROR = "Run killed by user";

export type EmitInput<K extends RunEventKind = RunEventKind> = {
	kind: K;
	stepName: string | null;
	data: Extract<RunEvent, { kind: K }>["data"];
};

export type RunContext = {
	runId: RunId;
	emit<K extends RunEventKind>(
		input: EmitInput<K>,
		createdAt?: string,
	): Extract<RunEvent, { kind: K }>;
	updateToolBashState(
		eventId: string,
		patch: Partial<Pick<ToolBashData, "state" | "exitCode">>,
	): RunEvent | undefined;
	signal: AbortSignal;
};

export type AgentJob = {
	repo: RepoSlug;
	issueKey: IssueKey;
	issueTitle: string;
	issueUrl: string | null;
	handler: (ctx: RunContext) => Promise<RunResult>;
};

export type RunResult =
	| { status: "completed"; durationMs: number }
	| {
			status: "failed";
			error: string;
			durationMs: number;
			finalizeFailure?: RunFinalizeFailure;
	  };

export type RunHandle = {
	runId: RunId;
	/** Resolves when the handler completes. Never rejects — outcome is in the result. */
	done: Promise<RunResult>;
};

export type Runner = {
	enqueue(job: AgentJob): RunHandle;
	kill(runId: RunId): boolean;
	readonly queue: JobQueue;
	readonly maxConcurrency: number;
};

type RunnerConfig = {
	repo: RunRepository;
	maxConcurrency?: number;
};

const DEFAULT_MAX_CONCURRENCY = 5;

export function createRunner(config: RunnerConfig): Runner {
	const { repo } = config;
	const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const queue = createJobQueue({ maxConcurrency });
	const activeRuns = new Map<RunId, AbortController>();

	function emitFor<K extends RunEventKind>(
		id: RunId,
		input: EmitInput<K>,
		createdAt = new Date().toISOString(),
	): Extract<RunEvent, { kind: K }> {
		const event = repo.insertEvent({
			runId: id,
			kind: input.kind,
			stepName: input.stepName,
			data: input.data as RunEventData,
			createdAt,
		}) as Extract<RunEvent, { kind: K }>;
		eventBus.emit(event);
		return event;
	}

	function flushInflightBash(id: RunId, finalState: "exited" | "aborted") {
		for (const event of repo.getInflightToolBash(id)) {
			const updated = repo.updateToolBashState(event.id, {
				state: finalState,
			});
			if (updated) eventBus.emit(updated);
		}
	}

	function kill(id: RunId): boolean {
		const controller = activeRuns.get(id);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	function enqueue(job: AgentJob): RunHandle {
		const id = runId(randomUUID().slice(0, 8));
		let resolveResult!: (result: RunResult) => void;
		const done = new Promise<RunResult>((resolve) => {
			resolveResult = resolve;
		});

		const controller = new AbortController();
		activeRuns.set(id, controller);

		// Insert DB record and emit event immediately so reconciliation
		// sees the run even when the queue is at capacity.
		const startedAt = new Date().toISOString();

		repo.insertRun({
			id,
			repo: job.repo,
			issueKey: job.issueKey,
			issueTitle: job.issueTitle,
			issueUrl: job.issueUrl,
			startedAt,
		});

		emitFor(
			id,
			{
				kind: "run:started",
				stepName: null,
				data: { issueKey: job.issueKey, issueTitle: job.issueTitle },
			},
			startedAt,
		);

		queue.enqueue(async () => {
			const executionStart = Date.now();

			const ctx: RunContext = {
				runId: id,
				emit: (input, createdAt) => emitFor(id, input, createdAt),
				updateToolBashState: (eventId, patch) => {
					const updated = repo.updateToolBashState(eventId, patch);
					if (updated) eventBus.emit(updated);
					return updated;
				},
				signal: controller.signal,
			};

			const abortPromise = new Promise<RunResult>((resolve) => {
				controller.signal.addEventListener("abort", () => {
					resolve({
						status: "failed",
						error: ABORT_ERROR,
						durationMs: Date.now() - executionStart,
					});
				});
			});

			const result = await Promise.race([job.handler(ctx), abortPromise]);

			const completedAt = new Date().toISOString();
			const aborted = controller.signal.aborted;
			flushInflightBash(id, aborted ? "aborted" : "exited");

			if (result.status === "completed") {
				repo.completeRun(id, { completedAt, durationMs: result.durationMs });

				const run = repo.getRunById(id);
				emitFor(
					id,
					{
						kind: "run:completed",
						stepName: null,
						data: {
							durationMs: result.durationMs,
							costUsd: run?.costUsd ?? 0,
							tokens: {
								in: run?.tokensInput ?? 0,
								out: run?.tokensOutput ?? 0,
							},
						},
					},
					completedAt,
				);
			} else {
				repo.failRun(id, {
					error: result.error,
					completedAt,
					durationMs: result.durationMs,
					...(result.finalizeFailure != null && {
						finalizeFailure: result.finalizeFailure,
					}),
				});

				emitFor(
					id,
					{
						kind: "run:failed",
						stepName: null,
						data: { error: result.error, durationMs: result.durationMs },
					},
					completedAt,
				);
			}

			activeRuns.delete(id);
			resolveResult(result);
		});

		return { runId: id, done };
	}

	const runner: Runner = { enqueue, kill, queue, maxConcurrency };
	return runner;
}
