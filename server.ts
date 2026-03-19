import { serve } from "@hono/node-server";
import { loadGatewayEnv } from "./core/env.ts";
import { loadRegistry } from "./core/registry.ts";
import { createGateway } from "./core/gateway.ts";
import { logger } from "./core/logger.ts";

const config = loadGatewayEnv();
const agents = await loadRegistry("./agents");

if (agents.length === 0) {
  logger.warn("No agents found in ./agents/ directory");
}

const app = createGateway({
  secret: config.GITHUB_WEBHOOK_SECRET,
  agents,
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info(
    { port: info.port, agents: agents.map((a) => a.name) },
    "gateway.started",
  );
});
