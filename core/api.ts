import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Db } from "./db.ts";
import { eventBus, type RunEvent } from "./event-bus.ts";
import type { Runner } from "./runner.ts";
import { runEvents, runs } from "./schema.ts";

const runsQuerySchema = z.object({
	agent: z.string().optional(),
	status: z.enum(["running", "completed", "failed"]).optional(),
	limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const runParamSchema = z.object({
	id: z.string().min(1),
});

export function createApi({ runner, db }: { runner: Runner; db: Db }) {
	const app = new Hono();

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

	app.get("/runs", zValidator("query", runsQuerySchema), (c) => {
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
	});

	app.get("/runs/:id", zValidator("param", runParamSchema), (c) => {
		const { id } = c.req.valid("param");

		const run = db.select().from(runs).where(eq(runs.id, id)).get();
		if (!run) return c.json({ error: "Not found" }, 404);

		const events = db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, id))
			.orderBy(asc(runEvents.createdAt))
			.all();

		return c.json({ ...run, events });
	});

	app.post("/runs/:id/kill", zValidator("param", runParamSchema), (c) => {
		const { id } = c.req.valid("param");
		const killed = runner.kill(id);
		if (!killed) return c.json({ error: "Run not found or not running" }, 404);
		return c.json({ killed: true });
	});

	app.get("/health", (c) => c.text("OK"));

	return app;
}
