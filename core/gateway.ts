import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { verifyGitHubWebhook, type WebhookVariables } from "./verify-github.ts";
import { route } from "./router.ts";
import { createAgentContext } from "./context.ts";
import { createRunner, type Runner } from "./runner.ts";
import { eventBus, type RunEvent } from "./event-bus.ts";
import { logger } from "./logger.ts";
import type { AgentDefinition } from "./types.ts";

type GatewayConfig = {
  secret: string;
  model: string;
  agents: AgentDefinition[];
  maxConcurrency?: number;
};

/**
 * Create a Hono app that acts as the webhook gateway.
 *
 * - Verifies webhook signatures
 * - Extracts event + action from headers/payload
 * - Routes to matching agents
 * - Enqueues handlers via runner (job queue + persistence + event emission)
 * - Returns 202 immediately; handlers run async
 * - GET /events streams SSE to connected clients
 */
export function createGateway(config: GatewayConfig) {
  const runner = createRunner({ maxConcurrency: config.maxConcurrency });
  const app = new Hono<{ Variables: WebhookVariables }>();

  app.post("/webhook", verifyGitHubWebhook(config.secret), async (c) => {
    const event = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "unknown";
    const payload = c.get("webhookPayload");
    const action = typeof payload.action === "string" ? payload.action : "";

    const log = logger.child({ event, action, deliveryId });
    const matched = route(event, action, config.agents, payload);

    if (matched.length === 0) {
      log.debug("gateway.no_match");
      return c.text("No matching agents", 200);
    }

    log.info({ agents: matched.map((a) => a.name) }, "gateway.dispatching");

    const ctx = createAgentContext({ event, action, payload, logger: log, model: config.model });

    for (const agent of matched) {
      runner.enqueue(agent, ctx);
    }

    return c.text("Accepted", 202);
  });

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

      // Keep stream alive until client disconnects
      stream.onAbort(() => {
        eventBus.off(handler);
      });

      // Send a heartbeat to keep the connection alive
      while (true) {
        await stream.writeSSE({ event: "heartbeat", data: "" });
        await stream.sleep(30_000);
      }
    });
  });

  app.get("/health", (c) => c.text("OK"));

  return { app, runner };
}
