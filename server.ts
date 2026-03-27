import { serve } from "@hono/node-server";
import { loadEnv } from "./core/env.ts";
import { loadConfig } from "./core/config.ts";
import { getDb } from "./core/db.ts";
import { migrate } from "./core/migrate.ts";
import { createRunner } from "./core/runner.ts";
import { createGitHubTracker } from "./core/trackers/github.ts";
import { createOrchestrator } from "./core/orchestrator.ts";
import { createApi } from "./core/api.ts";
import { logger } from "./core/logger.ts";

const env = loadEnv();
const config = loadConfig(env.CONFIG_PATH);

// Initialize database
migrate(getDb());

// Create components
const tracker = createGitHubTracker();

const runner = createRunner({
  maxConcurrency: config.defaults.max_concurrent,
});

// TODO: #13 will fetch workflow from repo via CodeHostAdapter
const repo = config.repos[0];
const workflow = {
  label: "agent",
  prompt: "",
  hooks: undefined,
};

const orchestrator = createOrchestrator({ tracker, config, repo, workflow, runner });

runner.onComplete = (runId) => orchestrator.releaseClaim(runId);
const app = createApi(runner);

// Start polling + API server
orchestrator.start();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      repos: config.repos,
      interval: config.defaults.polling_interval_ms,
    },
    "orchestrator.started",
  );
});
