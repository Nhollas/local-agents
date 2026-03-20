import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse, sse } from "msw";
import { test as base } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { App } from "../../src/App";
import type { RunEvent } from "../../src/types";
import {
  type DashboardPageObject,
  dashboardPageObject,
} from "./page-object";
import { browserWorker } from "./msw";

interface SSEClient {
  send(payload: Record<string, unknown>): void;
}

export interface DashboardFixtures {
  dashboardPage: DashboardPageObject;
  sseStream: {
    emit: (event: RunEvent) => void;
    emitHeartbeat: () => void;
    waitForConnection: () => Promise<void>;
  };
}

export const test = base.extend<DashboardFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures require destructuring
  sseStream: [async ({}, use) => {
    let client: SSEClient | null = null;
    let resolveConnected: (() => void) | null = null;
    const connected = new Promise<void>((r) => {
      resolveConnected = r;
    });

    browserWorker.use(
      sse("/events", ({ client: c }) => {
        client = c;
        resolveConnected?.();
      }),
    );

    await use({
      emit(event: RunEvent) {
        if (!client) {
          throw new Error(
            "SSE client not connected — call waitForConnection() or use the dashboardPage fixture first",
          );
        }
        client.send({
          event: event.type,
          data: JSON.stringify(event),
        });
      },
      emitHeartbeat() {
        if (!client) {
          throw new Error(
            "SSE client not connected — call waitForConnection() first",
          );
        }
        client.send({ event: "heartbeat", data: "" });
      },
      async waitForConnection() {
        await connected;
      },
    });
  }, { auto: true }],
  dashboardPage: async ({ sseStream }, use) => {
    browserWorker.use(
      http.get("/runs", () => HttpResponse.json([])),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });

    // Pre-populate so fetchRuns won't race with SSE events
    // (staleTime: Infinity means useQuery won't call queryFn when data exists)
    queryClient.setQueryData(["runs"], []);

    await render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
    await sseStream.waitForConnection();
    await use(dashboardPageObject(page));
  },
});

export { expect } from "vitest";
