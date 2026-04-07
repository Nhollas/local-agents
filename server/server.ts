import { serve } from "@hono/node-server";
import { createApi } from "./api/api.ts";
import { githubCodeHostAdapter } from "./code-hosts/github.ts";
import { loadConfig } from "./config.ts";
import { getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { loadEnv } from "./env.ts";
import { createGitHubClient } from "./github-client.ts";
import { logger } from "./logger.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { createRunner } from "./runner/runner.ts";
import { githubTrackerAdapter } from "./trackers/github.ts";
import { createWorkflowCache } from "./workflow/workflow-cache.ts";

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
