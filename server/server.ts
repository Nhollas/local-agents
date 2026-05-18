import { NodeFileSystem } from "@effect/platform-node";
import { serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { createApi, type HealthCheck } from "./api/api.ts";
import { createCodeHost } from "./code-hosts/create-code-host.ts";
import { makeCodeHostRuntime } from "./code-hosts/runtime.ts";
import { AppConfig, AppConfigLive } from "./config/app-config.ts";
import { processEnv } from "./config/env.ts";
import { closeDb, getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { readLast24hStats } from "./db/stats-query.ts";
import { createLogger } from "./logger.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { makeOrchestratorRuntime } from "./orchestrator/runtime.ts";
import { createRunRepository } from "./run-repository.ts";
import { createRunner } from "./runner/runner.ts";
import { initOtel, shutdownOtel } from "./telemetry/otel.ts";
import { createTracker } from "./trackers/create-tracker.ts";
import { makeTrackerRuntime } from "./trackers/runtime.ts";
import { makeWorkflowRuntime } from "./workflow/runtime.ts";
import { loadWorkflow } from "./workflow/workflow-loader.ts";

const env = await Effect.runPromise(processEnv);
initOtel(env.langfuse);

const config = await Effect.runPromise(
	AppConfig.pipe(
		Effect.provide(AppConfigLive),
		Effect.provide(NodeFileSystem.layer),
	),
);
const AppConfigStatic = Layer.succeed(AppConfig, config);
const logger = createLogger(env.logLevel);

const db = getDb();
migrate(db);

const trackerRuntime = makeTrackerRuntime();

const tracker = await trackerRuntime.runPromise(
	createTracker.pipe(Effect.provide(AppConfigStatic)),
);

const codeHostRuntime = makeCodeHostRuntime();

const codeHost = await codeHostRuntime.runPromise(
	createCodeHost.pipe(Effect.provide(AppConfigStatic)),
);

const repo = createRunRepository(db);

const runner = createRunner({
	repo,
	maxConcurrency: config.defaults.max_concurrent,
});

const workflowRuntime = makeWorkflowRuntime();

const workflow = await workflowRuntime.runPromise(loadWorkflow());

const orchestratorRuntime = makeOrchestratorRuntime();

const orchestrator = createOrchestrator({
	runRepo: repo,
	tracker,
	trackerRuntime,
	codeHost,
	codeHostRuntime,
	workflowRuntime,
	orchestratorRuntime,
	config,
	workflow,
	runner,
	logger,
	langfuse: {
		host: env.langfuse.host,
		projectId: env.langfuse.projectId,
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

const httpServer = serve({ fetch: app.fetch, port: env.port }, (info) => {
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
	await Promise.all([
		runner.dispose(),
		trackerRuntime.dispose(),
		codeHostRuntime.dispose(),
		workflowRuntime.dispose(),
		orchestratorRuntime.dispose(),
	]);
	closeDb();
	logger.info("shutdown.complete");
	process.exit(drainResult === "timeout" ? 1 : 0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
