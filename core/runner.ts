import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createJobQueue, type JobQueue } from "./queue.ts";
import { eventBus, type RunEvent } from "./event-bus.ts";
import { getDb } from "./db.ts";
import { runs, runEvents } from "./schema.ts";
import type { AgentContext, AgentDefinition } from "./types.ts";

export type RunnerConfig = {
  maxConcurrency?: number;
};

export type Runner = {
  enqueue(agent: AgentDefinition, ctx: AgentContext): string;
  readonly queue: JobQueue;
};

/**
 * Create a runner that wraps the job queue with persistence and event emission.
 *
 * Each agent execution becomes a "run" that is:
 * - Tracked in SQLite (runs + run_events tables)
 * - Emitted via the event bus for SSE streaming
 */
export function createRunner(config: RunnerConfig = {}): Runner {
  const queue = createJobQueue({ maxConcurrency: config.maxConcurrency });

  function enqueue(agent: AgentDefinition, ctx: AgentContext): string {
    const runId = randomUUID().slice(0, 8);
    const startedAt = new Date().toISOString();
    const db = getDb();

    queue.enqueue(async () => {
      // Persist run as started
      db.insert(runs)
        .values({
          id: runId,
          agentName: agent.name,
          status: "running",
          startedAt,
        })
        .run();

      const startEvent: RunEvent = {
        type: "run:started",
        runId,
        agentName: agent.name,
        data: { repo: ctx.repo, prNumber: ctx.prNumber },
        createdAt: startedAt,
      };
      persistEvent(runId, startEvent);
      eventBus.emit(startEvent);

      const startTime = Date.now();

      try {
        await agent.handler(ctx);

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - startTime;

        db.update(runs)
          .set({ status: "completed", completedAt, durationMs })
          .where(eq(runs.id, runId))
          .run();

        const completeEvent: RunEvent = {
          type: "run:completed",
          runId,
          agentName: agent.name,
          data: { durationMs },
          createdAt: completedAt,
        };
        persistEvent(runId, completeEvent);
        eventBus.emit(completeEvent);
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
          agentName: agent.name,
          data: { error, durationMs },
          createdAt: failedAt,
        };
        persistEvent(runId, failEvent);
        eventBus.emit(failEvent);

        ctx.logger.error({ agent: agent.name, err: error, runId }, "runner.handler_failed");
      }
    });

    return runId;
  }

  return { enqueue, queue };
}

function persistEvent(runId: string, event: RunEvent): void {
  const db = getDb();
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
