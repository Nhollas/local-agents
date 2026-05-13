import { serve } from "@hono/node-server";
import { createApi, type HealthCheck } from "./api/api.ts";
import { createCodeHost } from "./code-hosts/create-code-host.ts";
import { loadConfig } from "./config.ts";
import { closeDb, getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { readLast24hStats } from "./db/stats-query.ts";
import { env } from "./env.ts";
import { createLogger } from "./logger.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { createRunRepository } from "./run-repository.ts";
import { createRunner } from "./runner/runner.ts";
import { shutdownOtel } from "./telemetry/otel.ts";
import { createTracker } from "./trackers/create-tracker.ts";
import { loadWorkflow } from "./workflow/workflow-loader.ts";

const config = loadConfig(env.CONFIG_PATH);
const logger = createLogger(env.LOG_LEVEL);

const db = getDb();
migrate(db);

const tracker = createTracker(config.tracker, config.code_host.scopes, {
	jiraEmail: env.JIRA_EMAIL,
	jiraApiToken: env.JIRA_API_TOKEN,
});

const codeHost = createCodeHost(config.code_host, {
	gitlab: env.GITLAB_TOKEN,
	github: env.GITHUB_TOKEN,
});

const repo = createRunRepository(db);

const runner = createRunner({
	repo,
	maxConcurrency: config.defaults.max_concurrent,
});

const workflow = loadWorkflow();

const orchestrator = createOrchestrator({
	runRepo: repo,
	tracker,
	codeHost,
	config,
	workflow,
	runner,
	logger,
	langfuse: {
		publicKey: env.LANGFUSE_PUBLIC_KEY,
		secretKey: env.LANGFUSE_SECRET_KEY,
		host: env.LANGFUSE_HOST,
		baseUrl: env.LANGFUSE_BASE_URL,
		projectId: env.LANGFUSE_PROJECT_ID,
	},
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
	queue: orchestrator,
	readStats: (now) => readLast24hStats(db, now),
	checkHealth,
	logger,
});

orchestrator.start();

const DRAIN_TIMEOUT_MS = 30_000;

const httpServer = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
	logger.info(
		{
			port: info.port,
			codeHost: config.code_host.kind,
			scopes: config.code_host.scopes,
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
	httpServer.close();
	if ("closeAllConnections" in httpServer) {
		httpServer.closeAllConnections();
	}

	const drainResult = await Promise.race([
		orchestrator.settled().then(() => "drained" as const),
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS),
		),
	]);

	if (drainResult === "timeout") {
		logger.warn("shutdown.drain_timeout");
	}

	await shutdownOtel();
	closeDb();
	logger.info("shutdown.complete");
	process.exit(drainResult === "timeout" ? 1 : 0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
