import { describe, expect } from "vitest";
import { createRun, createRunDetail, createStep } from "./testing/contract.ts";
import { test } from "./testing/fixture.tsx";
import {
	runDetailHandler,
	runDetailNotFoundHandler,
	runEventsHandler,
} from "./testing/handlers.ts";
import { browserWorker } from "./testing/msw.ts";

describe("dashboard centre column", () => {
	test("renders banner and workflow stripe from /runs/:id", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runEventsHandler("run_9f3b2e1c"),
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

		await expect
			.element(page.getRunTitle())
			.toHaveTextContent("npm install hangs on linux runners");
		await expect.element(page.getStatusTag()).toHaveTextContent("Running");
		await expect.element(page.getMeta()).toHaveTextContent("ACME-1284");
		await expect.element(page.getMeta()).toHaveTextContent("acme/api");
		await expect
			.element(page.getMeta())
			.toHaveTextContent("fix/ACME-1284-npm-install-hang");
		await expect.element(page.getMeta()).toHaveTextContent("$0.034");
		await expect.element(page.getMeta()).toHaveTextContent("12.4k tok");
		await expect.element(page.getMeta()).toHaveTextContent("/tmp/lag/9f3b2e1");

		await expect.element(page.getStepCell(1)).toHaveTextContent("implement");
		await expect.element(page.getStepCell(1)).toHaveClass(/\bnow\b/);
		await expect.element(page.getStepCell(2)).toHaveTextContent("review");
		await expect.element(page.getStepCell(3)).toHaveTextContent("summarise");
	});

	test("renders done/failed cells for terminal states", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runEventsHandler("run-failed"),
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

		await expect.element(page.getStatusTag()).toHaveTextContent("Failed");
		await expect.element(page.getStepCell(1)).toHaveTextContent("implement");
		await expect.element(page.getStepCell(1)).toHaveClass(/\bdone\b/);
		await expect.element(page.getStepCell(2)).toHaveTextContent("review");
		await expect.element(page.getStepCell(2)).toHaveClass(/\bfailed\b/);
	});

	test("shows the empty placeholder when no run is selected", async ({
		dashboardPage,
	}) => {
		const page = await dashboardPage.mountAt(null);
		await expect
			.element(page.getPlaceholder())
			.toHaveTextContent(/no run selected/i);
	});

	test("shows the error placeholder when the run is unknown", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runEventsHandler("missing"),
			runDetailNotFoundHandler("missing"),
		);
		const page = await dashboardPage.mountAt("missing");
		await expect
			.element(page.getPlaceholder())
			.toHaveTextContent(/404|failed/i);
	});
});
