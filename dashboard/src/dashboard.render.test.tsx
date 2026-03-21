import { describe } from "vitest";
import { test } from "../tests/support/fixture";

describe("Dashboard - render", () => {
  test("shows empty state when no runs exist", async ({ dashboardPage }) => {
    const dashboard = await dashboardPage.mount();
    await dashboard.expectEmpty();
  });

  test("shows connected status when SSE stream is open", async ({
    dashboardPage,
  }) => {
    const dashboard = await dashboardPage.mount();
    await dashboard.expectConnected();
  });
});
