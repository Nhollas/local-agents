import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { eventBus, type RunEvent } from "../event-bus.ts";
import type { RunRepository } from "../run-repository.ts";
import type { Runner } from "../runner/runner.ts";
import { canonicalLogMiddleware } from "./canonical-log-middleware.ts";
import {
	ProblemDetailsError,
	problemDetailsHandler,
	zodProblemHook,
} from "./problem-details.ts";
import type { AppEnv } from "./types.ts";

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
	repo,
	retryRun,
}: {
	runner: Runner;
	repo: RunRepository;
	retryRun: RetryFn;
}) {
	const app = new Hono<AppEnv>();
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

	app.use(canonicalLogMiddleware);

	app.get(
		"/runs",
		zValidator("query", runsQuerySchema, zodProblemHook),
		(c) => {
			const { agent, status, limit } = c.req.valid("query");
			return c.json(repo.getRuns({ agent, status, limit }));
		},
	);

	app.get(
		"/runs/:id",
		zValidator("param", runParamSchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");

			const run = repo.getRunById(id);
			if (!run) throw new ProblemDetailsError(404, "Not found");

			const events = repo.getRunEvents(id);
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
