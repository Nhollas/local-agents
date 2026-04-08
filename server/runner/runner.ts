import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import { runEvents, runs } from "../db/schema.ts";
import { eventBus, type RunEvent } from "../event-bus.ts";
import { logger } from "../logger.ts";
import { createJobQueue, type JobQueue } from "./queue.ts";

export type AgentJob = {
	name: string;
	issueKey: string;
	issueTitle: string;
	handler: (
		emitToolUse: (tool: string, target: string) => void,
		setSessionId: (id: string) => void,
	) => Promise<void>;
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
			const startedAt = new Date().toISOString();

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

			const emitToolUse = (tool: string, target: string) => {
				emitEvent(runId, job.name, {
					type: "run:tool_use",
					data: { tool, target },
				});
			};

			let sessionCaptured = false;
			const setSessionId = (id: string) => {
				if (sessionCaptured) return;
				sessionCaptured = true;
				db.update(runs).set({ sessionId: id }).where(eq(runs.id, runId)).run();
			};

			const startTime = Date.now();

			try {
				const abortPromise = new Promise<never>((_, reject) => {
					controller.signal.addEventListener("abort", () => {
						reject(new Error("Run killed by user"));
					});
				});

				await Promise.race([
					job.handler(emitToolUse, setSessionId),
					abortPromise,
				]);

				const durationMs = Date.now() - startTime;
				const completedAt = new Date().toISOString();

				db.update(runs)
					.set({ status: "completed", completedAt, durationMs })
					.where(eq(runs.id, runId))
					.run();

				emitEvent(
					runId,
					job.name,
					{ type: "run:completed", data: { durationMs } },
					completedAt,
				);
				resolveResult({ status: "completed", durationMs });
			} catch (err) {
				const durationMs = Date.now() - startTime;
				const error = err instanceof Error ? err.message : String(err);
				const failedAt = new Date().toISOString();

				db.update(runs)
					.set({ status: "failed", completedAt: failedAt, durationMs, error })
					.where(eq(runs.id, runId))
					.run();

				emitEvent(
					runId,
					job.name,
					{ type: "run:failed", data: { error, durationMs } },
					failedAt,
				);
				resolveResult({ status: "failed", error, durationMs });

				logger.error(
					{ agent: job.name, err: error, runId },
					"runner.handler_failed",
				);
			} finally {
				activeRuns.delete(runId);
			}
		});

		return { runId, done };
	}

	const runner: Runner = { enqueue, kill, queue };
	return runner;
}
