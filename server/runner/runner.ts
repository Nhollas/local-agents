import { randomUUID } from "node:crypto";
import { eventBus, type RunEvent, type StepEvent } from "../event-bus.ts";
import type { RunRepository } from "../run-repository.ts";
import { type IssueKey, type RunId, runId } from "../types/brands.ts";
import { createJobQueue, type JobQueue } from "./queue.ts";

export const ABORT_ERROR = "Run killed by user";

export type RunContext = {
	runId: RunId;
	emitToolUse: (tool: string, target: string) => void;
	emitStepEvent: (event: StepEvent) => void;
	setSessionId: (id: string | null) => void;
	setStepIndex: (index: number) => void;
	signal: AbortSignal;
};

export type AgentJob = {
	name: string;
	issueKey: IssueKey;
	issueTitle: string;
	handler: (ctx: RunContext) => Promise<RunResult>;
	attempt?: number;
	parentRunId?: RunId;
};

export type RunResult =
	| { status: "completed"; durationMs: number }
	| { status: "failed"; error: string; durationMs: number };

export type RunHandle = {
	runId: RunId;
	/** Resolves when the handler completes. Never rejects — outcome is in the result. */
	done: Promise<RunResult>;
};

export type Runner = {
	enqueue(job: AgentJob): RunHandle;
	kill(runId: RunId): boolean;
	readonly queue: JobQueue;
};

type RunnerConfig = {
	repo: RunRepository;
	maxConcurrency?: number;
};

export function createRunner(config: RunnerConfig): Runner {
	const { repo } = config;
	const queue = createJobQueue(
		config.maxConcurrency != null
			? { maxConcurrency: config.maxConcurrency }
			: {},
	);
	const activeRuns = new Map<RunId, AbortController>();

	type EventPayload = {
		[E in RunEvent as E["type"]]: Pick<E, "type" | "data">;
	}[RunEvent["type"]];

	function emitEvent(
		id: RunId,
		agentName: string,
		event: EventPayload,
		createdAt = new Date().toISOString(),
	): void {
		// Post-narrowing: TS doesn't recombine the discriminated union through a spread.
		const fullEvent = {
			...event,
			runId: id,
			agentName,
			createdAt,
		} as RunEvent;
		repo.insertEvent({
			runId: id,
			type: event.type,
			data: event.data,
			createdAt,
		});
		eventBus.emit(fullEvent);
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
			agentName: job.name,
			issueKey: job.issueKey,
			issueTitle: job.issueTitle,
			startedAt,
			attempt: job.attempt ?? 1,
			parentRunId: job.parentRunId ?? null,
		});

		emitEvent(
			id,
			job.name,
			{
				type: "run:started",
				data: { issueKey: job.issueKey, issueTitle: job.issueTitle },
			},
			startedAt,
		);

		queue.enqueue(async () => {
			const executionStart = Date.now();

			const setSessionId = (sessionId: string | null) => {
				repo.setSessionId(id, sessionId);
			};

			const setStepIndex = (index: number) => {
				repo.setStepIndex(id, index);
			};

			const emitToolUse = (tool: string, target: string) => {
				emitEvent(id, job.name, {
					type: "run:tool_use",
					data: { tool, target },
				});
			};

			const emitStepEvent: RunContext["emitStepEvent"] = (event) => {
				emitEvent(id, job.name, event);
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

			const result = await Promise.race([
				job.handler({
					runId: id,
					emitToolUse,
					emitStepEvent,
					setSessionId,
					setStepIndex,
					signal: controller.signal,
				}),
				abortPromise,
			]);

			const completedAt = new Date().toISOString();

			if (result.status === "completed") {
				repo.completeRun(id, { completedAt, durationMs: result.durationMs });

				emitEvent(
					id,
					job.name,
					{ type: "run:completed", data: { durationMs: result.durationMs } },
					completedAt,
				);
			} else {
				repo.failRun(id, {
					error: result.error,
					completedAt,
					durationMs: result.durationMs,
				});

				emitEvent(
					id,
					job.name,
					{
						type: "run:failed",
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

	const runner: Runner = { enqueue, kill, queue };
	return runner;
}
