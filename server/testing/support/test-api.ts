import { createApi, type HealthCheck } from "../../api/api.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import { createTestDb } from "./test-db.ts";

const healthyCheck: HealthCheck = () => ({
	status: "healthy",
	checks: { database: { status: "pass" } },
});

export function createTestApi(opts?: { checkHealth?: HealthCheck }) {
	const db = createTestDb();
	const repo = createRunRepository(db);
	const runner = createRunner({ repo, maxConcurrency: 2 });
	const app = createApi({
		runner,
		repo,
		checkHealth: opts?.checkHealth ?? healthyCheck,
	});
	return { app, db, runner };
}
