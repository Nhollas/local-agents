import { describe } from "vitest";
import { createRun, createRunDetail, createStep } from "./testing/contract.ts";
import { test } from "./testing/fixture.tsx";
import {
	runDetailHandler,
	runDetailNotFoundHandler,
} from "./testing/handlers.ts";
import { browserWorker } from "./testing/msw.ts";

describe("dashboard centre column", () => {
	test("renders banner and workflow stripe from /runs/:id", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runDetailHandler(
				"run_9f3b2e1c",
				createRunDetail({
					run: createRun({
						id: "run_9f3b2e1c",
						status: "running",
						repo: "acme/api",
						branch: "fix/ACME-1284-npm-install-hang",
						workspaceDir: "/tmp/lag/9f3b2e1",
						issueKey: "ACME-1284",
						issueTitle: "npm install hangs on linux runners",
						issueUrl: "https://acme.atlassian.net/browse/ACME-1284",
						startedAt: "2026-05-09T14:27:56Z",
						costUsd: 0.034,
						tokensInput: 9800,
						tokensOutput: 2600,
					}),
					steps: [
						createStep({
							index: 1,
							name: "implement",
							state: "running",
							startedAt: "2026-05-09T14:28:19Z",
						}),
						createStep({ index: 2, name: "review", state: "pending" }),
						createStep({ index: 3, name: "summarise", state: "pending" }),
					],
				}),
			),
		);

		const page = await dashboardPage.mountAt("run_9f3b2e1c");

		await page.expectTitle("npm install hangs on linux runners");
		await page.expectStatusTag("Running");
		await page.expectMetaContains("ACME-1284");
		await page.expectMetaContains("acme/api");
		await page.expectMetaContains("fix/ACME-1284-npm-install-hang");
		await page.expectMetaContains("$0.034");
		await page.expectMetaContains("12.4k tok");
		await page.expectMetaContains("/tmp/lag/9f3b2e1");

		await page.expectStepState(1, { name: "implement", klass: "now" });
		await page.expectStepState(2, { name: "review", klass: "" });
		await page.expectStepState(3, { name: "summarise", klass: "" });
	});

	test("renders done/failed cells for terminal states", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runDetailHandler(
				"run-failed",
				createRunDetail({
					run: createRun({
						id: "run-failed",
						status: "failed",
						issueTitle: "broken thing",
						completedAt: "2026-05-09T14:32:00Z",
						durationMs: 240_000,
						error: "step failed",
					}),
					steps: [
						createStep({
							index: 1,
							name: "implement",
							state: "completed",
							durationMs: 167_000,
						}),
						createStep({
							index: 2,
							name: "review",
							state: "failed",
							durationMs: 5_000,
							error: "boom",
						}),
					],
				}),
			),
		);

		const page = await dashboardPage.mountAt("run-failed");

		await page.expectStatusTag("Failed");
		await page.expectStepState(1, { name: "implement", klass: "done" });
		await page.expectStepState(2, { name: "review", klass: "failed" });
	});

	test("shows the empty placeholder when no run is selected", async ({
		dashboardPage,
	}) => {
		const page = await dashboardPage.mountAt(null);
		await page.expectPlaceholder(/no run selected/i);
	});

	test("shows the error placeholder when the run is unknown", async ({
		dashboardPage,
	}) => {
		browserWorker.use(runDetailNotFoundHandler("missing"));
		const page = await dashboardPage.mountAt("missing");
		await page.expectPlaceholder(/404|failed/i);
	});
});
