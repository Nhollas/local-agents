import { createApi, type RetryFn } from "../../api/api.ts";
import { createRunner } from "../../runner/runner.ts";
import { createTestDb } from "./test-db.ts";

export function createTestApi(retryRun?: RetryFn) {
	const db = createTestDb();
	const runner = createRunner({ db, maxConcurrency: 2 });
	const app = createApi({
		runner,
		db,
		retryRun: retryRun ?? (async () => ({ error: "not implemented" })),
	});
	return { app, db, runner };
}
