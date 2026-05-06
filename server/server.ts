import { serve } from "@hono/node-server";
import { createApi, type HealthCheck } from "./api/api.ts";
import { createCodeHost } from "./code-hosts/create-code-host.ts";
import { loadConfig } from "./config.ts";
import { closeDb, getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { loadEnv } from "./env.ts";
import { createJiraClient } from "./jira-client.ts";
import { logger } from "./logger.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { createRunRepository } from "./run-repository.ts";
import { createRunner } from "./runner/runner.ts";
import { jiraTrackerAdapter } from "./trackers/jira.ts";
import { loadWorkflow } from "./workflow/workflow-loader.ts";

const baseEnv = loadEnv();
const config = loadConfig(baseEnv.CONFIG_PATH);
const env = loadEnv(config);

if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
	throw new Error("JIRA_EMAIL and JIRA_API_TOKEN are required for Jira");
}

const db = getDb();
migrate(db);

const jira = createJiraClient({
	baseUrl: config.tracker.base_url,
	email: env.JIRA_EMAIL,
	apiToken: env.JIRA_API_TOKEN,
});
const tracker = jiraTrackerAdapter(jira, {
	project: config.tracker.project,
	scopes: config.code_host.scopes,
	baseUrl: config.tracker.base_url,
	statuses: config.tracker.statuses,
	triggerLabel: config.tracker.trigger_label,
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
	checkHealth,
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

	closeDb();
	logger.info("shutdown.complete");
	process.exit(drainResult === "timeout" ? 1 : 0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
