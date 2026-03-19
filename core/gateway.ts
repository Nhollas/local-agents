import { Hono } from "hono";
import { verifyGitHubWebhook, type WebhookVariables } from "./verify-github.ts";
import { route } from "./router.ts";
import { logger } from "./logger.ts";
import type { AgentDefinition, WebhookContext } from "./types.ts";

type GatewayConfig = {
  secret: string;
  agents: AgentDefinition[];
};

/**
 * Create a Hono app that acts as the webhook gateway.
 *
 * - Verifies webhook signatures
 * - Extracts event + action from headers/payload
 * - Routes to matching agents
 * - Returns 202 immediately; handlers run async
 */
export function createGateway(config: GatewayConfig) {
  const app = new Hono<{ Variables: WebhookVariables }>();

  app.post("/webhook", verifyGitHubWebhook(config.secret), async (c) => {
    const event = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "unknown";
    const payload = c.get("webhookPayload");
    const action = typeof payload.action === "string" ? payload.action : "";

    const log = logger.child({ event, action, deliveryId });
    const matched = route(event, action, config.agents);

    if (matched.length === 0) {
      log.debug("gateway.no_match");
      return c.text("No matching agents", 200);
    }

    log.info({ agents: matched.map((a) => a.name) }, "gateway.dispatching");

    const ctx: WebhookContext = { event, action, payload, logger: log };

    Promise.allSettled(
      matched.map((agent) =>
        agent.handler(ctx).catch((err) => {
          log.error({ agent: agent.name, err }, "gateway.handler_failed");
        }),
      ),
    );

    return c.text("Accepted", 202);
  });

  app.get("/health", (c) => c.text("OK"));

  return app;
}
