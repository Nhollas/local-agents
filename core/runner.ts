import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { eventBus, type RunEvent } from "./event-bus.ts";
import { logger } from "./logger.ts";
import { createJobQueue, type JobQueue } from "./queue.ts";
import { runEvents, runs } from "./schema.ts";

export type AgentJob = {
	name: string;
	issueKey: string;
	issueTitle: string;
	handler: (
		emitToolUse: (tool: string, target: string) => void,
	) => Promise<void>;
	onComplete?: () => Promise<void>;
};

type RunnerConfig = {
	db: Db;
	maxConcurrency?: number;
};

export type Runner = {
	enqueue(job: AgentJob): string;
	kill(runId: string): boolean;
	readonly queue: JobQueue;
};

export function createRunner(config: RunnerConfig): Runner {
	const { db } = config;
	const queue = createJobQueue({ maxConcurrency: config.maxConcurrency });
	const activeRuns = new Map<string, AbortController>();

	function kill(runId: string): boolean {
		const controller = activeRuns.get(runId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	function enqueue(job: AgentJob): string {
		const runId = randomUUID().slice(0, 8);
		const startedAt = new Date().toISOString();
		const controller = new AbortController();
		activeRuns.set(runId, controller);

		queue.enqueue(async () => {
			db.insert(runs)
				.values({
					id: runId,
					agentName: job.name,
					status: "running",
					issueKey: job.issueKey,
					issueTitle: job.issueTitle,
					startedAt,
				})
				.run();

			const startEvent: RunEvent = {
				type: "run:started",
				runId,
				agentName: job.name,
				data: { issueKey: job.issueKey, issueTitle: job.issueTitle },
				createdAt: startedAt,
			};
			persistEvent(runId, startEvent);
			eventBus.emit(startEvent);

			const emitToolUse = (tool: string, target: string) => {
				const toolEvent: RunEvent = {
					type: "run:tool_use",
					runId,
					agentName: job.name,
					data: { tool, target },
					createdAt: new Date().toISOString(),
				};
				persistEvent(runId, toolEvent);
				eventBus.emit(toolEvent);
			};

			const startTime = Date.now();

			try {
				const abortPromise = new Promise<never>((_, reject) => {
					controller.signal.addEventListener("abort", () => {
						reject(new Error("Run killed by user"));
					});
				});

				await Promise.race([job.handler(emitToolUse), abortPromise]);

				const completedAt = new Date().toISOString();
				const durationMs = Date.now() - startTime;

				db.update(runs)
					.set({ status: "completed", completedAt, durationMs })
					.where(eq(runs.id, runId))
					.run();

				const completeEvent: RunEvent = {
					type: "run:completed",
					runId,
					agentName: job.name,
					data: { durationMs },
					createdAt: completedAt,
				};
				persistEvent(runId, completeEvent);
				eventBus.emit(completeEvent);

				if (job.onComplete) {
					try {
						await job.onComplete();
					} catch (err) {
						logger.error(
							{
								agent: job.name,
								runId,
								err: err instanceof Error ? err.message : String(err),
							},
							"runner.on_complete_failed",
						);
					}
				}
			} catch (err) {
				const failedAt = new Date().toISOString();
				const durationMs = Date.now() - startTime;
				const error = err instanceof Error ? err.message : String(err);

				db.update(runs)
					.set({ status: "failed", completedAt: failedAt, durationMs, error })
					.where(eq(runs.id, runId))
					.run();

				const failEvent: RunEvent = {
					type: "run:failed",
					runId,
					agentName: job.name,
					data: { error, durationMs },
					createdAt: failedAt,
				};
				persistEvent(runId, failEvent);
				eventBus.emit(failEvent);

				logger.error(
					{ agent: job.name, err: error, runId },
					"runner.handler_failed",
				);
			} finally {
				activeRuns.delete(runId);
			}
		});

		return runId;
	}

	function persistEvent(runId: string, event: RunEvent): void {
		db.insert(runEvents)
			.values({
				id: randomUUID().slice(0, 8),
				runId,
				type: event.type,
				data: event.data,
				createdAt: event.createdAt,
			})
			.run();
	}

	const runner: Runner = { enqueue, kill, queue };
	return runner;
}
