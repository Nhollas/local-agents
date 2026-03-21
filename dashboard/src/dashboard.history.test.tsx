import { http, HttpResponse } from "msw";
import { describe } from "vitest";
import { createRunEvent, createRunFromApi } from "../tests/support/contract";
import { test } from "../tests/support/fixture";
import { browserWorker } from "../tests/support/msw";

describe("Dashboard - history", () => {
  test("loads and displays historical runs on mount", async ({ dashboardPage}) => {
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

  test("merges live runs with historical runs", async ({ dashboardPage, sseStream }) => {
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
});
