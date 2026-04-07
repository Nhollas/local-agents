import { HttpResponse, http } from "msw";
import { describe } from "vitest";
import { createRunEvent, createRunFromApi } from "./testing/contract";
import { expect, test } from "./testing/fixture";
import { browserWorker } from "./testing/msw";

describe("Dashboard - history", () => {
	test("loads and displays historical runs on mount", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			http.get("/runs", () =>
				HttpResponse.json([
					createRunFromApi({
						id: "run-old-1",
						agentName: "pr-summary",
						status: "completed",
					}),
					createRunFromApi({
						id: "run-old-2",
						agentName: "pr-conventions",
						status: "failed",
						error: "Timed out",
					}),
				]),
			),
		);

		const dashboard = await dashboardPage.mount();

		await dashboard.expectAgentVisible("pr-summary");
		await dashboard.expectAgentVisible("pr-conventions");
		await dashboard.expectRunVisible("run-old-1");
		await dashboard.expectRunVisible("run-old-2");
	});

	test("merges live runs with historical runs", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs", () =>
				HttpResponse.json([
					createRunFromApi({
						id: "run-old",
						agentName: "pr-summary",
						status: "completed",
					}),
				]),
			),
		);

		const dashboard = await dashboardPage.mount();

		await dashboard.expectRunVisible("run-old");

		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-live",
				agentName: "pr-summary",
			}),
		);

		await dashboard.expectRunVisible("run-live");
		await dashboard.expectRunCount("pr-summary", 2);
	});

	test("displays issue key and title for historical runs", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			http.get("/runs", () =>
				HttpResponse.json([
					createRunFromApi({
						id: "run-1",
						agentName: "pr-summary",
						issueKey: "PROJ-42",
						issueTitle: "Fix login timeout bug",
					}),
					createRunFromApi({
						id: "run-2",
						agentName: "pr-conventions",
						issueKey: null,
						issueTitle: "Add linting rules",
					}),
				]),
			),
		);

		const dashboard = await dashboardPage.mount();

		const summarySection = dashboard.getAgentSection("pr-summary");
		await expect
			.element(summarySection)
			.toHaveTextContent("PROJ-42: Fix login timeout bug");

		const conventionsSection = dashboard.getAgentSection("pr-conventions");
		await expect
			.element(conventionsSection)
			.toHaveTextContent("Add linting rules");
	});

	test("updates historical run status when a live completion event arrives", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs", () =>
				HttpResponse.json([
					createRunFromApi({
						id: "run-1",
						agentName: "pr-summary",
						status: "running",
						completedAt: null,
						durationMs: null,
					}),
				]),
			),
		);

		const dashboard = await dashboardPage.mount();

		const section = dashboard.getAgentSection("pr-summary");
		await expect.element(section).toHaveTextContent("running");

		sseStream.emit(
			createRunEvent("run:completed", {
				runId: "run-1",
				agentName: "pr-summary",
				data: { durationMs: 5000 },
			}),
		);

		await expect.element(section).toHaveTextContent("completed");
	});
});
