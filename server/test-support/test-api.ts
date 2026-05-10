import { createApi, type HealthCheck } from "../api/api.ts";
import type { QueuedItem } from "../orchestrator/orchestrator.ts";
import { createRunRepository } from "../run-repository.ts";
import { createRunner } from "../runner/runner.ts";
import { createTestDb } from "./test-db.ts";
import { testLogger } from "./test-logger.ts";

const healthyCheck: HealthCheck = () => ({
	status: "healthy",
	checks: { database: { status: "pass" } },
});

export function createTestApi(opts?: {
	checkHealth?: HealthCheck;
	queued?: QueuedItem[];
}) {
	const db = createTestDb();
	const repo = createRunRepository(db);
	const runner = createRunner({ repo, maxConcurrency: 2 });
	const queued = opts?.queued ?? [];
	const app = createApi({
		runner,
		repo,
		queue: { getQueueSnapshot: () => queued },
		checkHealth: opts?.checkHealth ?? healthyCheck,
		logger: testLogger,
	});
	return { app, db, runner };
}
