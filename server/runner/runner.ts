import { randomUUID } from "node:crypto";
import { eventBus, type RunEvent } from "../event-bus.ts";
import type { RunRepository } from "../run-repository.ts";
import { createJobQueue, type JobQueue } from "./queue.ts";

export const ABORT_ERROR = "Run killed by user";

export type RunContext = {
	runId: string;
	emitToolUse: (tool: string, target: string) => void;
	emitPhaseEvent: (
		event:
			| {
					type: "phase.started";
					data: { name: string; index: number; total: number };
			  }
			| {
					type: "phase.completed";
					data: { name: string; index: number; durationMs: number };
			  }
			| {
					type: "phase.failed";
					data: { name: string; index: number; error: string };
			  },
	) => void;
	setSessionId: (id: string | null) => void;
	setPhaseIndex: (index: number) => void;
	signal: AbortSignal;
};

export type AgentJob = {
	name: string;
	issueKey: string;
	issueTitle: string;
	handler: (ctx: RunContext) => Promise<RunResult>;
	attempt?: number;
	parentRunId?: string;
};

export type RunResult =
	| { status: "completed"; durationMs: number }
	| { status: "failed"; error: string; durationMs: number };

export type RunHandle = {
	runId: string;
	/** Resolves when the handler completes. Never rejects — outcome is in the result. */
	done: Promise<RunResult>;
};

export type Runner = {
	enqueue(job: AgentJob): RunHandle;
	kill(runId: string): boolean;
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
	const activeRuns = new Map<string, AbortController>();

	type EventPayload = {
		[E in RunEvent as E["type"]]: Pick<E, "type" | "data">;
	}[RunEvent["type"]];

	function emitEvent(
		runId: string,
		agentName: string,
		event: EventPayload,
		createdAt = new Date().toISOString(),
	): void {
		const fullEvent = { ...event, runId, agentName, createdAt } as RunEvent;
		repo.insertEvent({
			runId,
			type: event.type,
			data: event.data,
			createdAt,
		});
		eventBus.emit(fullEvent);
	}

	function kill(runId: string): boolean {
		const controller = activeRuns.get(runId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	function enqueue(job: AgentJob): RunHandle {
		const runId = randomUUID().slice(0, 8);
		let resolveResult!: (result: RunResult) => void;
		const done = new Promise<RunResult>((resolve) => {
			resolveResult = resolve;
		});

		const controller = new AbortController();
		activeRuns.set(runId, controller);

		// Insert DB record and emit event immediately so reconciliation
		// sees the run even when the queue is at capacity.
		const startedAt = new Date().toISOString();

		repo.insertRun({
			id: runId,
			agentName: job.name,
			issueKey: job.issueKey,
			issueTitle: job.issueTitle,
			startedAt,
			attempt: job.attempt ?? 1,
			parentRunId: job.parentRunId ?? null,
		});

		emitEvent(
			runId,
			job.name,
			{
				type: "run:started",
				data: { issueKey: job.issueKey, issueTitle: job.issueTitle },
			},
			startedAt,
		);

		queue.enqueue(async () => {
			const executionStart = Date.now();

			const setSessionId = (id: string | null) => {
				repo.setSessionId(runId, id);
			};

			const setPhaseIndex = (index: number) => {
				repo.setPhaseIndex(runId, index);
			};

			const emitToolUse = (tool: string, target: string) => {
				emitEvent(runId, job.name, {
					type: "run:tool_use",
					data: { tool, target },
				});
			};

			const emitPhaseEvent: RunContext["emitPhaseEvent"] = (event) => {
				emitEvent(runId, job.name, event);
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
					runId,
					emitToolUse,
					emitPhaseEvent,
					setSessionId,
					setPhaseIndex,
					signal: controller.signal,
				}),
				abortPromise,
			]);

			const completedAt = new Date().toISOString();

			if (result.status === "completed") {
				repo.completeRun(runId, { completedAt, durationMs: result.durationMs });

				emitEvent(
					runId,
					job.name,
					{ type: "run:completed", data: { durationMs: result.durationMs } },
					completedAt,
				);
			} else {
				repo.failRun(runId, {
					error: result.error,
					completedAt,
					durationMs: result.durationMs,
				});

				emitEvent(
					runId,
					job.name,
					{
						type: "run:failed",
						data: { error: result.error, durationMs: result.durationMs },
					},
					completedAt,
				);
			}

			activeRuns.delete(runId);
			resolveResult(result);
		});

		return { runId, done };
	}

	const runner: Runner = { enqueue, kill, queue };
	return runner;
}
