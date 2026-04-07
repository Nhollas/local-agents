import { delay, HttpResponse, http } from "msw";
import { describe } from "vitest";
import { createRunDetailFromApi, createRunEvent } from "./testing/contract";
import { expect, test } from "./testing/fixture";
import { browserWorker } from "./testing/msw";

describe("Dashboard - loading states", () => {
	test("shows loading indicator while run details are being fetched", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs/run-abc", async () => {
				await delay("infinite");
				return HttpResponse.json(
					createRunDetailFromApi({
						id: "run-abc",
						agentName: "pr-summary",
					}),
				);
			}),
		);

		const dashboard = await dashboardPage.mount();

		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-abc",
				agentName: "pr-summary",
			}),
		);

		await dashboard.selectRun("run-abc");
		await dashboard.expectLoading();
	});

	test("replaces loading indicator with events once loaded", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs/run-abc", () =>
				HttpResponse.json(
					createRunDetailFromApi({
						id: "run-abc",
						agentName: "pr-summary",
						events: [
							{
								id: "evt-1",
								runId: "run-abc",
								type: "run:started",
								data: {},
								createdAt: "2026-03-20T12:00:00.000Z",
							},
						],
					}),
				),
			),
		);

		const dashboard = await dashboardPage.mount();

		sseStream.emit(
			createRunEvent("run:started", {
				runId: "run-abc",
				agentName: "pr-summary",
			}),
		);

		await dashboard.selectRun("run-abc");
		await dashboard.expectEvents(1);
		await expect
			.element(dashboard.getLoadingIndicator())
			.not.toBeInTheDocument();
	});
});
