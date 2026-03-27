import { serve } from "@hono/node-server";
import { loadEnv } from "./core/env.ts";
import { loadWorkflow } from "./core/workflow.ts";
import { getDb } from "./core/db.ts";
import { migrate } from "./core/migrate.ts";
import { createRunner } from "./core/runner.ts";
import { createGitHubTracker } from "./core/trackers/github.ts";
import { createOrchestrator } from "./core/orchestrator.ts";
import { createApi } from "./core/api.ts";
import { logger } from "./core/logger.ts";

const env = loadEnv();
const workflow = loadWorkflow(env.WORKFLOW_PATH);

// Initialize database
migrate(getDb());

// Create components
const tracker = createGitHubTracker(workflow.config.tracker.active_states);

const runner = createRunner({
  maxConcurrency: workflow.config.agent.max_concurrent,
});

const orchestrator = createOrchestrator({ tracker, workflow, runner });

runner.onComplete = (runId) => orchestrator.releaseClaim(runId);
const app = createApi(runner);

// Start polling + API server
orchestrator.start();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      repo: workflow.config.tracker.repo,
      label: workflow.config.tracker.label,
      interval: workflow.config.polling.interval_ms,
    },
    "orchestrator.started",
  );
});
