import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import { runEvents, runs } from "../db/schema.ts";
import { eventBus, type RunEvent } from "../event-bus.ts";
import { createJobQueue, type JobQueue } from "./queue.ts";

export const ABORT_ERROR = "Run killed by user";

export type RunContext = {
	runId: string;
	emitToolUse: (tool: string, target: string) => void;
	setSessionId: (id: string) => void;
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
	db: Db;
	maxConcurrency?: number;
};

export function createRunner(config: RunnerConfig): Runner {
	const { db } = config;
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
		db.insert(runEvents)
			.values({
				id: randomUUID().slice(0, 8),
				runId,
				type: event.type,
				data: event.data as Record<string, unknown>,
				createdAt,
			})
			.run();
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

		queue.enqueue(async () => {
			const startTime = Date.now();
			const startedAt = new Date(startTime).toISOString();

			db.insert(runs)
				.values({
					id: runId,
					agentName: job.name,
					status: "running",
					issueKey: job.issueKey,
					issueTitle: job.issueTitle,
					startedAt,
					attempt: job.attempt ?? 1,
					parentRunId: job.parentRunId ?? null,
				})
				.run();

			emitEvent(
				runId,
				job.name,
				{
					type: "run:started",
					data: { issueKey: job.issueKey, issueTitle: job.issueTitle },
				},
				startedAt,
			);

			let sessionCaptured = false;
			const setSessionId = (id: string) => {
				if (sessionCaptured) return;
				sessionCaptured = true;
				db.update(runs).set({ sessionId: id }).where(eq(runs.id, runId)).run();
			};

			const emitToolUse = (tool: string, target: string) => {
				emitEvent(runId, job.name, {
					type: "run:tool_use",
					data: { tool, target },
				});
			};

			const abortPromise = new Promise<RunResult>((resolve) => {
				controller.signal.addEventListener("abort", () => {
					resolve({
						status: "failed",
						error: ABORT_ERROR,
						durationMs: Date.now() - startTime,
					});
				});
			});

			const result = await Promise.race([
				job.handler({
					runId,
					emitToolUse,
					setSessionId,
					signal: controller.signal,
				}),
				abortPromise,
			]);

			const completedAt = new Date().toISOString();

			if (result.status === "completed") {
				db.update(runs)
					.set({
						status: "completed",
						completedAt,
						durationMs: result.durationMs,
					})
					.where(eq(runs.id, runId))
					.run();

				emitEvent(
					runId,
					job.name,
					{ type: "run:completed", data: { durationMs: result.durationMs } },
					completedAt,
				);
			} else {
				db.update(runs)
					.set({
						status: "failed",
						completedAt,
						durationMs: result.durationMs,
						error: result.error,
					})
					.where(eq(runs.id, runId))
					.run();

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
