import { serve } from "@hono/node-server";
import { createApi, type HealthCheck } from "./api/api.ts";
import { githubCodeHostAdapter } from "./code-hosts/github.ts";
import { loadConfig } from "./config.ts";
import { closeDb, getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { loadEnv } from "./env.ts";
import { createGitHubClient } from "./github-client.ts";
import { logger } from "./logger.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { createRunRepository } from "./run-repository.ts";
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
const repo = createRunRepository(db);

const runner = createRunner({
	repo,
	maxConcurrency: config.defaults.max_concurrent,
});

// Fetch workflows from all repos, then start
const workflowCache = createWorkflowCache(codeHost, config.repos);
await workflowCache.refresh();

const orchestrator = createOrchestrator({
	runRepo: repo,
	tracker,
	codeHost,
	config,
	workflows: workflowCache.workflows,
	runner,
});

const checkHealth: HealthCheck = () => {
	const checks: Record<string, { status: "pass" | "fail"; message?: string }> =
		{};

	try {
		repo.getRuns({ limit: 1 });
		checks["database"] = { status: "pass" };
	} catch (err) {
		checks["database"] = {
			status: "fail",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	const allHealthy = Object.values(checks).every((c) => c.status === "pass");
	return { status: allHealthy ? "healthy" : "unhealthy", checks };
};

const app = createApi({
	runner,
	repo,
	retryRun: orchestrator.retryRun,
	checkHealth,
});

// Start polling + workflow refresh
workflowCache.start();
orchestrator.start();

const DRAIN_TIMEOUT_MS = 30_000;

const httpServer = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
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

let shuttingDown = false;

async function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, "shutdown.start");

	orchestrator.stop();
	workflowCache.stop();
	httpServer.close();

	// Drain in-flight runs with a timeout
	const drainResult = await Promise.race([
		orchestrator.settled().then(() => "drained" as const),
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS),
		),
	]);

	if (drainResult === "timeout") {
		logger.warn("shutdown.drain_timeout");
	}

	closeDb();
	logger.info("shutdown.complete");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
