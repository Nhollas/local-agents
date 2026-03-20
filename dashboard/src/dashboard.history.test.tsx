import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { App } from "./App";
import { createRunEvent, createRunFromApi } from "../tests/support/contract";
import { dashboardPageObject } from "../tests/support/page-object";
import { browserWorker } from "../tests/support/msw";
import { test } from "../tests/support/fixture";

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("Dashboard - history", () => {
  test("loads and displays historical runs on mount", async () => {
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

    await renderApp();
    const dashboard = dashboardPageObject(page);

    await dashboard.expectAgentVisible("pr-summary");
    await dashboard.expectAgentVisible("pr-conventions");
    await dashboard.expectRunVisible("run-old-1");
    await dashboard.expectRunVisible("run-old-2");
  });

  test("merges live runs with historical runs", async ({ sseStream }) => {
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

    await renderApp();
    const dashboard = dashboardPageObject(page);

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
