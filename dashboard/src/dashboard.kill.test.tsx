import { http, HttpResponse } from "msw";
import { describe } from "vitest";
import { createRunEvent } from "../tests/support/contract";
import { test, expect } from "../tests/support/fixture";
import { browserWorker } from "../tests/support/msw";

describe("Dashboard - kill action", () => {
  test("sends kill request when kill button is clicked on a running run", async ({
    dashboardPage,
    sseStream,
  }) => {
    const killHandler = http.post("/runs/run-abc/kill", () => {
      return new HttpResponse(null, { status: 204 });
    });

    browserWorker.use(killHandler);

    const dashboard = await dashboardPage.mount();

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-abc",
        agentName: "pr-summary",
      }),
    );

    await dashboard.killRun("run-abc");

    await expect.poll(() => killHandler.isUsed).toBe(true);
  });

  test("kill button is not shown for completed runs", async ({
    dashboardPage,
    sseStream,
  }) => {
    const dashboard = await dashboardPage.mount();

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-abc",
        agentName: "pr-summary",
      }),
    );
    sseStream.emit(
      createRunEvent("run:completed", {
        runId: "run-abc",
        agentName: "pr-summary",
        data: { durationMs: 1000 },
      }),
    );

    const section = dashboard.getAgentSection("pr-summary");
    await expect.element(section).toHaveTextContent("completed");
    await expect
      .element(dashboard.getKillButton("run-abc"))
      .not.toBeInTheDocument();
  });
});
