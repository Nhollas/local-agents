import { http, HttpResponse } from "msw";
import { describe } from "vitest";
import {
  createRunDetailFromApi,
  createRunEvent,
} from "../tests/support/contract";
import { test, expect } from "../tests/support/fixture";
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

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-abc",
        agentName: "pr-summary",
      }),
    );

    await dashboardPage.selectRun("run-abc");
    await dashboardPage.expectRunDetails("pr-summary");
  });

  test("shows error details for a failed run", async ({
    dashboardPage,
    sseStream,
  }) => {
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

    await dashboardPage.selectRun("run-abc");
    await dashboardPage.expectError("Agent timeout after 30s");
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

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-abc",
        agentName: "pr-summary",
      }),
    );

    await dashboardPage.selectRun("run-abc");
    await dashboardPage.expectEvents(2);
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

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-abc",
        agentName: "pr-summary",
      }),
    );

    await dashboardPage.selectRun("run-abc");
    await dashboardPage.expectRunDetails("pr-summary");

    await dashboardPage.goBack();
    await dashboardPage.expectAgentVisible("pr-summary");
  });
});
