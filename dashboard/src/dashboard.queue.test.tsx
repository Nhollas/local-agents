import { describe, expect } from "vitest";
import {
	createActiveRun,
	createQueuedItem,
	createQueueSnapshot,
	createRun,
	createRunDetail,
} from "./testing/contract.ts";
import { test } from "./testing/fixture.tsx";
import {
	queueHandler,
	runDetailHandler,
	runEventsHandler,
} from "./testing/handlers.ts";
import { browserWorker } from "./testing/msw.ts";

describe("dashboard queue column", () => {
	test("renders Active rows with progress bar + step label and Queued rows", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runEventsHandler("run_9f3b2e1c"),
			runDetailHandler(
				"run_9f3b2e1c",
				createRunDetail({
					run: createRun({
						id: "run_9f3b2e1c",
						issueTitle: "npm install hangs on linux runners",
					}),
				}),
			),
			queueHandler(
				createQueueSnapshot({
					active: [
						createActiveRun({
							id: "run_9f3b2e1c",
							repo: "acme/api",
							issueKey: "ACME-1284",
							issueTitle: "npm install hangs on linux runners",
							currentStep: { name: "implement", index: 1, total: 3 },
							progressRatio: 0.17,
						}),
					],
					queued: [
						createQueuedItem({
							issueKey: "ACME-1285",
							issueTitle: "500 on /api/runs?limit=0",
							repo: "acme/api",
							pendingSince: "2026-05-09T14:31:42Z",
						}),
						createQueuedItem({
							issueKey: "WIDGETS-911",
							issueTitle: "cover branch-resolver edges",
							repo: "widgets/dashboard",
							pendingSince: "2026-05-09T14:31:55Z",
						}),
					],
				}),
			),
		);

		const page = await dashboardPage.mountAt("run_9f3b2e1c");

		const activeRow = page.getByTestId("queue-active-run_9f3b2e1c");
		await expect
			.element(activeRow)
			.toHaveTextContent("npm install hangs on linux runners");
		await expect.element(activeRow).toHaveTextContent("ACME-1284");
		await expect.element(activeRow).toHaveTextContent("acme/api");
		await expect.element(activeRow).toHaveTextContent("step 1 / 3 · implement");
		await expect.element(activeRow).toHaveClass(/\bactive\b/);

		const queuedFirst = page.getByTestId("queue-queued-ACME-1285");
		await expect
			.element(queuedFirst)
			.toHaveTextContent("500 on /api/runs?limit=0");
		await expect.element(queuedFirst).toHaveTextContent("ACME-1285");

		const queuedSecond = page.getByTestId("queue-queued-WIDGETS-911");
		await expect
			.element(queuedSecond)
			.toHaveTextContent("cover branch-resolver edges");
	});

	test("queued rows have no progress bar or step label", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			queueHandler(
				createQueueSnapshot({
					queued: [
						createQueuedItem({ issueKey: "ACME-9", issueTitle: "waiting" }),
					],
				}),
			),
		);

		const page = await dashboardPage.mountAt(null);

		const row = page.getByTestId("queue-queued-ACME-9");
		await expect.element(row).toHaveClass(/\bqueued\b/);
		await expect.element(row).not.toHaveTextContent(/step \d+ \/ \d+/);
	});
});
