import { describe } from "vitest";
import { test } from "../tests/support/fixture";

describe("Dashboard - render", () => {
  test("shows empty state when no runs exist", async ({ dashboardPage }) => {
    await dashboardPage.expectEmpty();
  });

  test("shows connected status when SSE stream is open", async ({
    dashboardPage,
  }) => {
    await dashboardPage.expectConnected();
  });
});
