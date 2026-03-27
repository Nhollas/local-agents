import { HttpResponse, http } from "msw";
import { describe } from "vitest";
import {
	createRunDetailFromApi,
	createRunEvent,
} from "../tests/support/contract";
import { expect, test } from "../tests/support/fixture";
import { browserWorker } from "../tests/support/msw";

describe("Dashboard - run details", () => {
	test("navigates to run details when a run is clicked", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs/run-abc", () =>
				HttpResponse.json(
					createRunDetailFromApi({
						id: "run-abc",
						agentName: "pr-summary",
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
		await dashboard.expectRunDetails("pr-summary");
	});

	test("shows error details for a failed run", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs/run-abc", () =>
				HttpResponse.json(
					createRunDetailFromApi({
						id: "run-abc",
						agentName: "pr-summary",
						status: "failed",
						error: "Agent timeout after 30s",
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
		sseStream.emit(
			createRunEvent("run:failed", {
				runId: "run-abc",
				agentName: "pr-summary",
				data: { error: "Agent timeout after 30s", durationMs: 30000 },
			}),
		);

		await dashboard.selectRun("run-abc");
		await dashboard.expectError("Agent timeout after 30s");
	});

	test("displays the event timeline for a run", async ({
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
							{
								id: "evt-2",
								runId: "run-abc",
								type: "run:output",
								data: { message: "Processing PR #42" },
								createdAt: "2026-03-20T12:00:01.000Z",
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
		await dashboard.expectEvents(2);
	});

	test("navigates back to the feed when back button is clicked", async ({
		dashboardPage,
		sseStream,
	}) => {
		browserWorker.use(
			http.get("/runs/run-abc", () =>
				HttpResponse.json(
					createRunDetailFromApi({
						id: "run-abc",
						agentName: "pr-summary",
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
		await dashboard.expectRunDetails("pr-summary");

		await dashboard.goBack();
		await dashboard.expectAgentVisible("pr-summary");
	});
});
