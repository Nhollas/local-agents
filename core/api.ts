import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, desc, and, type SQL } from "drizzle-orm";
import { eventBus, type RunEvent } from "./event-bus.ts";
import { getDb } from "./db.ts";
import { runs, runEvents } from "./schema.ts";
import type { Runner } from "./runner.ts";

export function createApi(runner: Runner) {
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

  const validStatuses = new Set(["running", "completed", "failed"]);

  app.get("/runs", (c) => {
    const db = getDb();
    const agentName = c.req.query("agent");
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

    const conditions: SQL[] = [];
    if (agentName) conditions.push(eq(runs.agentName, agentName));
    if (status && validStatuses.has(status)) {
      conditions.push(eq(runs.status, status as "running" | "completed" | "failed"));
    }

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

  app.get("/runs/:id", (c) => {
    const db = getDb();
    const id = c.req.param("id");

    const run = db.select().from(runs).where(eq(runs.id, id)).get();
    if (!run) return c.json({ error: "Not found" }, 404);

    const events = db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .all();

    return c.json({ ...run, events });
  });

  app.post("/runs/:id/kill", (c) => {
    const id = c.req.param("id");
    const killed = runner.kill(id);
    if (!killed) return c.json({ error: "Run not found or not running" }, 404);
    return c.json({ killed: true });
  });

  app.get("/health", (c) => c.text("OK"));

  return app;
}
