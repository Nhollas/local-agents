import { HttpResponse, http } from "msw";
import { describe } from "vitest";
import { createRunEvent } from "./testing/contract";
import { expect, test } from "./testing/fixture";
import { browserWorker } from "./testing/msw";

describe("Dashboard - retry action", () => {
	test("shows Retry button for failed runs", async ({
		dashboardPage,
		sseStream,
	}) => {
		const dashboard = await dashboardPage.mount();

		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-fail",
				agentName: "test-agent",
			}),
		);
		sseStream.emit(
			createRunEvent("run:failed", {
				runId: "run-fail",
				agentName: "test-agent",
				data: { error: "boom", durationMs: 500 },
			}),
		);

		await expect.element(dashboard.getRetryButton("run-fail")).toBeVisible();
	});

	test("does not show Retry button for running or completed runs", async ({
		dashboardPage,
		sseStream,
	}) => {
		const dashboard = await dashboardPage.mount();

		// Running run
		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-active",
				agentName: "agent-a",
			}),
		);

		// Completed run
		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-done",
				agentName: "agent-b",
			}),
		);
		sseStream.emit(
			createRunEvent("run:completed", {
				runId: "run-done",
				agentName: "agent-b",
				data: { durationMs: 1000 },
			}),
		);

		await expect
			.element(dashboard.getRetryButton("run-active"))
			.not.toBeInTheDocument();
		await expect
			.element(dashboard.getRetryButton("run-done"))
			.not.toBeInTheDocument();
	});

	test("sends retry request when Retry button is clicked", async ({
		dashboardPage,
		sseStream,
	}) => {
		const retryHandler = http.post("/runs/run-fail/retry", () => {
			return HttpResponse.json({ runId: "new-run-1" }, { status: 201 });
		});

		browserWorker.use(retryHandler);

		const dashboard = await dashboardPage.mount();

		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-fail",
				agentName: "test-agent",
			}),
		);
		sseStream.emit(
			createRunEvent("run:failed", {
				runId: "run-fail",
				agentName: "test-agent",
				data: { error: "boom", durationMs: 500 },
			}),
		);

		await dashboard.retryRun("run-fail");

		await expect.poll(() => retryHandler.isUsed).toBe(true);
	});
});
