import { describe, expect } from "vitest";
import { createRun } from "./testing/contract.ts";
import { test } from "./testing/fixture.tsx";
import { recentRunsHandler } from "./testing/handlers.ts";
import { browserWorker } from "./testing/msw.ts";

describe("dashboard recent runs column", () => {
	test("renders Today / Yesterday day groups split on local-day boundary", async ({
		dashboardPage,
	}) => {
		const todayBoundary = new Date();
		todayBoundary.setHours(0, 0, 0, 0);
		const yesterdayBoundary = new Date(todayBoundary.getTime() - 86_400_000);

		browserWorker.use(
			recentRunsHandler([
				createRun({
					id: "today-1",
					status: "completed",
					issueTitle: "auth header dropped on retry",
					issueKey: "ACME-1283",
					repo: "acme/api",
					startedAt: new Date(
						todayBoundary.getTime() + 14 * 3600_000 + 18 * 60_000,
					).toISOString(),
					completedAt: new Date(
						todayBoundary.getTime() + 14 * 3600_000 + 27 * 60_000 + 12_000,
					).toISOString(),
					durationMs: 552_000,
					costUsd: 0.04,
					pr: {
						repo: "acme/api",
						number: 4419,
						url: "https://github.com/acme/api/pull/4419",
						kind: "opened",
					},
				}),
				createRun({
					id: "yesterday-1",
					status: "completed",
					issueTitle: "tidy run-repository tests",
					issueKey: "ACME-1271",
					repo: "acme/api",
					startedAt: new Date(
						yesterdayBoundary.getTime() + 17 * 3600_000 + 42 * 60_000,
					).toISOString(),
					completedAt: new Date(
						yesterdayBoundary.getTime() + 18 * 3600_000 + 1 * 60_000 + 8_000,
					).toISOString(),
					durationMs: 1_148_000,
					costUsd: 0.1,
					pr: {
						repo: "acme/api",
						number: 4404,
						url: "https://github.com/acme/api/pull/4404",
						kind: "opened",
					},
				}),
			]),
		);

		const page = await dashboardPage.mountAt(null);

		const column = page.getByTestId("recent-runs");
		await expect.element(column).toHaveTextContent("Recent runs");
		await expect.element(column).toHaveTextContent("Today");
		await expect.element(column).toHaveTextContent("Yesterday");

		const todayRow = page.getByTestId("recent-run-today-1");
		await expect
			.element(todayRow)
			.toHaveTextContent("auth header dropped on retry");
		await expect.element(todayRow).toHaveTextContent("ACME-1283");
		await expect.element(todayRow).toHaveTextContent("acme/api · #4419");
		await expect.element(todayRow).toHaveTextContent("9m 12s");
		await expect.element(todayRow).toHaveTextContent("$0.04");

		const yesterdayRow = page.getByTestId("recent-run-yesterday-1");
		await expect
			.element(yesterdayRow)
			.toHaveTextContent("tidy run-repository tests");
	});

	test("failed run renders failure tag with step name + error and no PR link", async ({
		dashboardPage,
	}) => {
		const today = new Date();
		today.setHours(13, 51, 0, 0);

		browserWorker.use(
			recentRunsHandler([
				createRun({
					id: "fail-1",
					status: "failed",
					issueTitle: "cover repo-resolver",
					issueKey: "ACME-1280",
					repo: "acme/api",
					startedAt: today.toISOString(),
					completedAt: new Date(today.getTime() + 401_000).toISOString(),
					durationMs: 401_000,
					costUsd: 0.03,
					error: "no commits made",
					failedStep: { index: 1, name: "implement" },
				}),
			]),
		);

		const page = await dashboardPage.mountAt(null);

		const row = page.getByTestId("recent-run-fail-1");
		await expect.element(row).toHaveTextContent("cover repo-resolver");
		await expect
			.element(row)
			.toHaveTextContent("step 1 · implement · no commits made");
		await expect.element(row).toHaveTextContent("6m 41s");
		await expect.element(row).toHaveTextContent("$0.03");
		await expect.element(row).not.toHaveTextContent("#");
	});

	test("finalize-failed run renders the phase + finalize error and no PR link", async ({
		dashboardPage,
	}) => {
		const today = new Date();
		today.setHours(14, 9, 0, 0);

		browserWorker.use(
			recentRunsHandler([
				createRun({
					id: "fail-finalize",
					status: "failed",
					issueTitle: "duplicate detection on feedback submission",
					issueKey: "ACME-9",
					repo: "acme/api",
					startedAt: today.toISOString(),
					completedAt: new Date(today.getTime() + 1_033_437).toISOString(),
					durationMs: 1_033_437,
					costUsd: 4.57,
					error: "push: Permission denied",
					finalizeFailure: {
						phase: "push",
						error: "Permission denied",
					},
				}),
			]),
		);

		const page = await dashboardPage.mountAt(null);

		const row = page.getByTestId("recent-run-fail-finalize");
		await expect.element(row).toHaveTextContent("push · Permission denied");
		await expect.element(row).not.toHaveTextContent("step 1");
		await expect.element(row).not.toHaveTextContent("#");
	});

	test("excludes running runs from the recent column", async ({
		dashboardPage,
	}) => {
		const today = new Date();
		today.setHours(14, 0, 0, 0);

		browserWorker.use(
			recentRunsHandler([
				createRun({
					id: "running-1",
					status: "running",
					issueTitle: "should not appear",
					issueKey: "ACME-RUNNING",
					startedAt: today.toISOString(),
				}),
				createRun({
					id: "completed-1",
					status: "completed",
					issueTitle: "should appear",
					issueKey: "ACME-DONE",
					startedAt: today.toISOString(),
					completedAt: new Date(today.getTime() + 60_000).toISOString(),
					durationMs: 60_000,
					costUsd: 0.01,
				}),
			]),
		);

		const page = await dashboardPage.mountAt(null);

		await expect
			.element(page.getByTestId("recent-run-completed-1"))
			.toBeInTheDocument();
		await expect
			.element(page.getByTestId("recent-runs"))
			.not.toHaveTextContent("should not appear");
	});
});
