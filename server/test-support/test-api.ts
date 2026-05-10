import { createApi, type HealthCheck } from "../api/api.ts";
import { readLast24hStats } from "../db/stats-query.ts";
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
	concurrencyMax?: number;
	clock?: () => Date;
}) {
	const db = createTestDb();
	const repo = createRunRepository(db);
	const runner = createRunner({
		repo,
		maxConcurrency: opts?.concurrencyMax ?? 2,
	});
	const queued = opts?.queued ?? [];
	const app = createApi({
		runner,
		repo,
		queue: { getQueueSnapshot: () => queued },
		readStats: (now) => readLast24hStats(db, now),
		checkHealth: opts?.checkHealth ?? healthyCheck,
		logger: testLogger,
		...(opts?.clock && { clock: opts.clock }),
	});
	return { app, db, runner };
}
