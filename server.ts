import { serve } from "@hono/node-server";
import { createApi } from "./core/api.ts";
import { createGitHubCodeHost } from "./core/code-hosts/github.ts";
import { loadConfig } from "./core/config.ts";
import { getDb } from "./core/db.ts";
import { loadEnv } from "./core/env.ts";
import { logger } from "./core/logger.ts";
import { migrate } from "./core/migrate.ts";
import { createOrchestrator } from "./core/orchestrator.ts";
import { createRunner } from "./core/runner.ts";
import { createGitHubTracker } from "./core/trackers/github.ts";
import { createWorkflowCache } from "./core/workflow-cache.ts";

const env = loadEnv();
const config = loadConfig(env.CONFIG_PATH);

// Initialize database
migrate(getDb());

// Create components
const tracker = createGitHubTracker();
const codeHost = createGitHubCodeHost();

const runner = createRunner({
	maxConcurrency: config.defaults.max_concurrent,
});

// Fetch workflows from all repos, then start
const workflowCache = createWorkflowCache(codeHost, config.repos);
await workflowCache.refresh();

const orchestrator = createOrchestrator({
	tracker,
	codeHost,
	config,
	workflows: workflowCache.workflows,
	runner,
});

runner.onComplete = (runId) => orchestrator.releaseClaim(runId);
const app = createApi(runner);

// Start polling + workflow refresh
workflowCache.start();
orchestrator.start();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
	logger.info(
		{
			port: info.port,
			repos: config.repos,
			activeRepos: [...workflowCache.workflows.keys()],
			interval: config.defaults.polling_interval_ms,
		},
		"orchestrator.started",
	);
});
