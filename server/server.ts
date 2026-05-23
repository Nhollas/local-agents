import { createServer } from "node:http";
import { HttpApp, HttpServer } from "@effect/platform";
import {
	NodeFileSystem,
	NodeHttpServer,
	NodeRuntime,
} from "@effect/platform-node";
import { Effect, Fiber, Layer } from "effect";
import { createApi, type HealthCheck } from "./api/api.ts";
import { createCodeHost } from "./code-hosts/create-code-host.ts";
import { AppConfig } from "./config/app-config.ts";
import { processEnv } from "./config/env.ts";
import { closeDb, getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { readLast24hStats } from "./db/stats-query.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { createRunRepository } from "./run-repository.ts";
import { createRunner, type Runner } from "./runner/runner.ts";
import { makeServerRuntime } from "./runtime.ts";
import { createTracker } from "./trackers/create-tracker.ts";
import { loadWorkflow } from "./workflow/loader.ts";

const DRAIN_TIMEOUT_MS = 30_000;

const program = Effect.gen(function* () {
	const env = yield* processEnv;

	const config = yield* AppConfig.pipe(
		Effect.provide(AppConfig.Default),
		Effect.provide(NodeFileSystem.layer),
	);
	const AppConfigStatic = Layer.succeed(AppConfig, config);

	const db = yield* Effect.acquireRelease(
		Effect.sync(() => {
			const d = getDb();
			migrate(d);
			return d;
		}),
		() => Effect.sync(() => closeDb()),
	);

	const runtime = yield* Effect.acquireRelease(
		Effect.sync(() => makeServerRuntime()),
		(rt) => Effect.promise(() => rt.dispose()),
	);

	const tracker = yield* Effect.promise(() =>
		runtime.runPromise(createTracker.pipe(Effect.provide(AppConfigStatic))),
	);
	const codeHost = yield* Effect.promise(() =>
		runtime.runPromise(createCodeHost.pipe(Effect.provide(AppConfigStatic))),
	);
	const workflow = yield* Effect.promise(() =>
		runtime.runPromise(loadWorkflow()),
	);

	const repo = createRunRepository(db);

	const runner = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createRunner({ repo, maxConcurrency: config.defaults.max_concurrent }),
		),
		(r) => Effect.promise(() => drainAndDispose(r)),
	);

	const orchestrator = yield* Effect.promise(() =>
		runtime.runPromise(
			createOrchestrator({
				runRepo: repo,
				tracker,
				runtime,
				codeHost,
				config,
				workflow,
				runner,
				langfuse: {
					host: env.langfuse.host,
					projectId: env.langfuse.projectId,
				},
			}),
		),
	);

	yield* Effect.acquireRelease(
		Effect.promise(() => runtime.runPromise(orchestrator.start)),
		(fiber) => Effect.promise(() => runtime.runPromise(Fiber.interrupt(fiber))),
	);

	const checkHealth: HealthCheck = () => {
		const checks: Record<
			string,
			{ status: "pass" | "fail"; message?: string }
		> = {};
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
	});

	yield* Effect.logInfo("orchestrator.started").pipe(
		Effect.annotateLogs({
			port: env.port,
			codeHost: config.code_host.kind,
			scopes: config.code_host.scopes,
			interval: config.defaults.polling_interval_ms,
		}),
	);

	yield* Layer.launch(
		HttpServer.serve(
			HttpApp.fromWebHandler(async (req) => app.fetch(req)),
		).pipe(
			Layer.provide(
				NodeHttpServer.layer(() => createServer(), { port: env.port }),
			),
		),
	);
});

async function drainAndDispose(runner: Runner): Promise<void> {
	const drained = await Promise.race([
		runner.waitForIdle().then(() => "drained" as const),
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS),
		),
	]);
	if (drained === "timeout") console.warn("shutdown.drain_timeout");
	await runner.dispose();
}

NodeRuntime.runMain(Effect.scoped(program));
