import { serve } from "@hono/node-server";
import { createApi } from "./core/api.ts";
import { githubCodeHostAdapter } from "./core/code-hosts/github.ts";
import { loadConfig } from "./core/config.ts";
import { getDb } from "./core/db.ts";
import { loadEnv } from "./core/env.ts";
import { createGitHubClient } from "./core/gh.ts";
import { logger } from "./core/logger.ts";
import { migrate } from "./core/migrate.ts";
import { createOrchestrator } from "./core/orchestrator.ts";
import { createRunner } from "./core/runner.ts";
import { githubTrackerAdapter } from "./core/trackers/github.ts";
import { createWorkflowCache } from "./core/workflow-cache.ts";

const env = loadEnv();
const config = loadConfig(env.CONFIG_PATH);

// Initialize database
const db = getDb();
migrate(db);

// Create components
const github = createGitHubClient(env.GITHUB_TOKEN);
const tracker = githubTrackerAdapter(github);
const codeHost = githubCodeHostAdapter(github);

const runner = createRunner({
	db,
	maxConcurrency: config.defaults.max_concurrent,
});

// Fetch workflows from all repos, then start
const workflowCache = createWorkflowCache(codeHost, config.repos);
await workflowCache.refresh();

const orchestrator = createOrchestrator({
	db,
	tracker,
	codeHost,
	config,
	workflows: workflowCache.workflows,
	runner,
});

const app = createApi({
	runner,
	db,
	retryRun: orchestrator.retryRun,
});

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
