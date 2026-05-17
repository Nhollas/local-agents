import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Fiber } from "effect";
import { eventBus } from "../event-bus.ts";
import type { RunEvent, RunEventKind, ToolBashData } from "../event-schema.ts";
import type { RunFinalizeFailure, RunRepository } from "../run-repository.ts";
import {
	type IssueKey,
	type RepoSlug,
	type RunId,
	runId,
} from "../types/brands.ts";
import { makeRunnerRuntime, type RunnerRuntime } from "./runtime.ts";

export const ABORT_ERROR = "Run killed by user";

export type EmitInput = {
	[K in RunEventKind]: {
		kind: K;
		stepName: string | null;
		data: Extract<RunEvent, { kind: K }>["data"];
	};
}[RunEventKind];

export type RunContext = {
	runId: RunId;
	emit(input: EmitInput, createdAt?: string): RunEvent;
	updateToolBashState(
		eventId: string,
		patch: Partial<Pick<ToolBashData, "state" | "exitCode">>,
	): RunEvent | undefined;
	signal: AbortSignal;
};

export type AgentJob = {
	repo: RepoSlug;
	repoUrl: string;
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
	/** Resolves with the final outcome. Never rejects — failures are in the result. */
	result: Promise<RunResult>;
};

export type Runner = {
	enqueue(job: AgentJob): RunHandle;
	kill(runId: RunId): boolean;
	waitForIdle(): Promise<void>;
	readonly maxConcurrency: number;
	dispose(): Promise<void>;
};

type RunnerConfig = {
	repo: RunRepository;
	maxConcurrency?: number;
};

type HandlerOutcome = {
	result: RunResult;
	interrupted: boolean;
};

const DEFAULT_MAX_CONCURRENCY = 5;

export function createRunner(config: RunnerConfig): Runner {
	const { repo } = config;
	const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const runtime: RunnerRuntime = makeRunnerRuntime();
	const semaphore = Effect.unsafeMakeSemaphore(maxConcurrency);
	const inflightRuns = new Map<RunId, Fiber.RuntimeFiber<RunResult, never>>();
	const idleWaiters: Array<() => void> = [];

	function enqueue(job: AgentJob): RunHandle {
		const id = newRunId();
		recordRunStarted(id, job);
		const inflight = runtime.runFork(executeJob(id, job));
		inflightRuns.set(id, inflight);
		const result = new Promise<RunResult>((resolve) => {
			inflight.addObserver((exit) => {
				inflightRuns.delete(id);
				if (inflightRuns.size === 0) {
					for (const wake of idleWaiters.splice(0)) wake();
				}
				// executeJob never fails its channel; only a defect in finalize
				// could reach here. Surface as a failed result so awaiters never
				// see a rejection.
				resolve(exitToRunResult(exit, 0));
			});
		});
		return { runId: id, result };
	}

	function kill(id: RunId): boolean {
		const inflight = inflightRuns.get(id);
		if (!inflight) return false;
		runtime.runFork(Fiber.interrupt(inflight));
		return true;
	}

	function waitForIdle(): Promise<void> {
		if (inflightRuns.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			idleWaiters.push(resolve);
		});
	}

	function dispose(): Promise<void> {
		return runtime.dispose();
	}

	// --- internals ---

	// Finalize runs uninterruptibly so DB writes and run:completed/failed always
	// land, even when the fiber is killed mid-run.
	function executeJob(
		id: RunId,
		job: AgentJob,
	): Effect.Effect<RunResult, never> {
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const outcome = yield* invokeHandler(restore, id, job);
				yield* persistOutcome(id, outcome);
				return outcome.result;
			}),
		);
	}

	function invokeHandler(
		restore: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>,
		id: RunId,
		job: AgentJob,
	): Effect.Effect<HandlerOutcome, never> {
		return Effect.gen(function* () {
			const start = Date.now();
			const exit = yield* Effect.exit(
				restore(semaphore.withPermits(1)(callHandler(id, job, start))),
			);
			return {
				result: exitToRunResult(exit, start),
				interrupted:
					Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause),
			};
		});
	}

	function callHandler(
		id: RunId,
		job: AgentJob,
		start: number,
	): Effect.Effect<RunResult, RunResult> {
		return Effect.tryPromise({
			try: (signal) =>
				job.handler({
					runId: id,
					emit: (input, createdAt) => emit(id, input, createdAt),
					updateToolBashState: (eventId, patch) => {
						const updated = repo.updateToolBashState(eventId, patch);
						if (updated) eventBus.emit(updated);
						return updated;
					},
					signal,
				}),
			catch: (err): RunResult => ({
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - start,
			}),
		});
	}

	function persistOutcome(
		id: RunId,
		{ result, interrupted }: HandlerOutcome,
	): Effect.Effect<void> {
		return Effect.sync(() => {
			const completedAt = new Date().toISOString();
			flushInflightBash(id, interrupted ? "aborted" : "exited");
			if (result.status === "completed") {
				persistSuccess(id, result, completedAt);
			} else {
				persistFailure(id, result, completedAt);
			}
		});
	}

	function persistSuccess(
		id: RunId,
		result: Extract<RunResult, { status: "completed" }>,
		completedAt: string,
	): void {
		repo.completeRun(id, { completedAt, durationMs: result.durationMs });
		const run = repo.getRunById(id);
		emit(
			id,
			{
				kind: "run:completed",
				stepName: null,
				data: {
					durationMs: result.durationMs,
					costUsd: run?.costUsd ?? 0,
					tokens: { in: run?.tokensInput ?? 0, out: run?.tokensOutput ?? 0 },
				},
			},
			completedAt,
		);
	}

	function persistFailure(
		id: RunId,
		result: Extract<RunResult, { status: "failed" }>,
		completedAt: string,
	): void {
		repo.failRun(id, {
			error: result.error,
			completedAt,
			durationMs: result.durationMs,
			...(result.finalizeFailure != null && {
				finalizeFailure: result.finalizeFailure,
			}),
		});
		emit(
			id,
			{
				kind: "run:failed",
				stepName: null,
				data: { error: result.error, durationMs: result.durationMs },
			},
			completedAt,
		);
	}

	function recordRunStarted(id: RunId, job: AgentJob): void {
		// Done synchronously before forking so reconciliation sees the run
		// even when every semaphore permit is taken.
		const startedAt = new Date().toISOString();
		repo.insertRun({
			id,
			repo: job.repo,
			repoUrl: job.repoUrl,
			issueKey: job.issueKey,
			issueTitle: job.issueTitle,
			issueUrl: job.issueUrl,
			startedAt,
		});
		emit(
			id,
			{
				kind: "run:started",
				stepName: null,
				data: { issueKey: job.issueKey, issueTitle: job.issueTitle },
			},
			startedAt,
		);
	}

	function emit(
		id: RunId,
		input: EmitInput,
		createdAt = new Date().toISOString(),
	): RunEvent {
		const event = repo.insertEvent({
			runId: id,
			kind: input.kind,
			stepName: input.stepName,
			data: input.data,
			createdAt,
		});
		eventBus.emit(event);
		return event;
	}

	function flushInflightBash(id: RunId, finalState: "exited" | "aborted") {
		for (const event of repo.getInflightToolBash(id)) {
			const updated = repo.updateToolBashState(event.id, { state: finalState });
			if (updated) eventBus.emit(updated);
		}
	}

	return { enqueue, kill, waitForIdle, maxConcurrency, dispose };
}

function newRunId(): RunId {
	return runId(randomUUID().slice(0, 8));
}

function exitToRunResult(
	exit: Exit.Exit<RunResult, RunResult>,
	start: number,
): RunResult {
	if (Exit.isSuccess(exit)) return exit.value;
	const cause = exit.cause;
	if (Cause.isInterruptedOnly(cause)) {
		return {
			status: "failed",
			error: ABORT_ERROR,
			durationMs: Date.now() - start,
		};
	}
	const failure = Cause.failureOption(cause);
	if (failure._tag === "Some") return failure.value;
	return {
		status: "failed",
		error: Cause.pretty(cause),
		durationMs: Date.now() - start,
	};
}
