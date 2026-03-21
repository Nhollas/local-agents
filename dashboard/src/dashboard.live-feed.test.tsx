import { describe } from "vitest";
import { createRunEvent } from "../tests/support/contract";
import { test, expect } from "../tests/support/fixture";

describe("Dashboard - live feed", () => {
  test("displays a new run when a run:started event arrives", async ({
    dashboardPage,
    sseStream,
  }) => {
    const dashboard = await dashboardPage.mount();
    await dashboard.expectEmpty();

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-abc",
        agentName: "pr-summary",
      }),
    );

    await dashboard.expectAgentVisible("pr-summary");
    await dashboard.expectRunVisible("run-abc");
  });

  test("updates run status when run:completed event arrives", async ({
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

    await dashboard.expectRunVisible("run-abc");

    sseStream.emit(
      createRunEvent("run:completed", {
        runId: "run-abc",
        agentName: "pr-summary",
        data: { durationMs: 2500 },
      }),
    );

    const section = dashboard.getAgentSection("pr-summary");
    await expect.element(section).toHaveTextContent("completed");
  });

  test("updates run status when run:failed event arrives", async ({
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
      createRunEvent("run:failed", {
        runId: "run-abc",
        agentName: "pr-summary",
        data: { error: "Agent crashed", durationMs: 300 },
      }),
    );

    const section = dashboard.getAgentSection("pr-summary");
    await expect.element(section).toHaveTextContent("failed");
  });

  test("groups runs by agent name", async ({ dashboardPage, sseStream }) => {
    const dashboard = await dashboardPage.mount();

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-1",
        agentName: "pr-summary",
      }),
    );
    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-2",
        agentName: "pr-conventions",
      }),
    );

    await dashboard.expectAgentVisible("pr-summary");
    await dashboard.expectAgentVisible("pr-conventions");
    await dashboard.expectRunCount("pr-summary", 1);
    await dashboard.expectRunCount("pr-conventions", 1);
  });

  test("shows multiple runs under the same agent", async ({
    dashboardPage,
    sseStream,
  }) => {
    const dashboard = await dashboardPage.mount();

    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-1",
        agentName: "pr-summary",
      }),
    );
    sseStream.emit(
      createRunEvent("run:started", {
        runId: "run-2",
        agentName: "pr-summary",
      }),
    );

    await dashboard.expectRunCount("pr-summary", 2);
    await dashboard.expectRunVisible("run-1");
    await dashboard.expectRunVisible("run-2");
  });
});
