import { createApi, type RetryFn } from "../../api/api.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import { createTestDb } from "./test-db.ts";

export function createTestApi(retryRun?: RetryFn) {
	const db = createTestDb();
	const repo = createRunRepository(db);
	const runner = createRunner({ repo, maxConcurrency: 2 });
	const app = createApi({
		runner,
		repo,
		retryRun: retryRun ?? (async () => ({ error: "not implemented" })),
	});
	return { app, db, runner };
}
