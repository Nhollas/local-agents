import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { runEvents, runs } from "../db/schema.ts";
import { eventBus, type RunEvent } from "../event-bus.ts";
import type { Runner } from "../runner/runner.ts";
import {
	ProblemDetailsError,
	problemDetailsHandler,
	zodProblemHook,
} from "./problem-details.ts";

const runsQuerySchema = z.object({
	agent: z.string().optional(),
	status: z.enum(["running", "completed", "failed"]).optional(),
	limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const runParamSchema = z.object({
	id: z.string().min(1),
});

export type RetryFn = (
	failedRunId: string,
) => Promise<{ runId: string } | { error: string }>;

export function createApi({
	runner,
	db,
	retryRun,
}: {
	runner: Runner;
	db: Db;
	retryRun: RetryFn;
}) {
	const app = new Hono();
	app.onError(problemDetailsHandler);

	app.get("/events", (c) => {
		return streamSSE(c, async (stream) => {
			const handler = (event: RunEvent) => {
				stream
					.writeSSE({
						event: event.type,
						data: JSON.stringify(event),
					})
					.catch(() => {});
			};

			eventBus.on(handler);

			stream.onAbort(() => {
				eventBus.off(handler);
			});

			while (true) {
				await stream.writeSSE({ event: "heartbeat", data: "" });
				await stream.sleep(30_000);
			}
		});
	});

	app.get(
		"/runs",
		zValidator("query", runsQuerySchema, zodProblemHook),
		(c) => {
			const { agent, status, limit } = c.req.valid("query");

			const conditions: SQL[] = [];
			if (agent) conditions.push(eq(runs.agentName, agent));
			if (status) conditions.push(eq(runs.status, status));

			const query = db
				.select()
				.from(runs)
				.orderBy(desc(runs.startedAt))
				.limit(limit);

			const result =
				conditions.length > 0
					? query.where(and(...conditions)).all()
					: query.all();

			return c.json(result);
		},
	);

	app.get(
		"/runs/:id",
		zValidator("param", runParamSchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");

			const run = db.select().from(runs).where(eq(runs.id, id)).get();
			if (!run) throw new ProblemDetailsError(404, "Not found");

			const events = db
				.select()
				.from(runEvents)
				.where(eq(runEvents.runId, id))
				.orderBy(asc(runEvents.createdAt))
				.all();

			return c.json({ ...run, events });
		},
	);

	app.post(
		"/runs/:id/kill",
		zValidator("param", runParamSchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");
			const killed = runner.kill(id);
			if (!killed)
				throw new ProblemDetailsError(404, "Run not found or not running");
			return c.json({ killed: true });
		},
	);

	app.post(
		"/runs/:id/retry",
		zValidator("param", runParamSchema, zodProblemHook),
		async (c) => {
			const { id } = c.req.valid("param");
			const result = await retryRun(id);
			if ("error" in result) throw new ProblemDetailsError(400, result.error);
			return c.json({ runId: result.runId }, 201);
		},
	);

	app.get("/health", (c) => c.text("OK"));

	return app;
}
