import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { sse } from "msw"
import { test as base } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { App } from "../../src/App"
import type { RunEvent } from "../../src/types"
import { dashboardPageObject } from "./page-object"
import { browserWorker } from "./msw"
import { Providers } from "../../src/Providers"

export const test = base
  .extend("sseStream", { auto: true }, async () => {
    let client: { send(payload: Record<string, unknown>): void } | null = null
    let resolveConnected: (() => void) | null = null
    const connected = new Promise<void>((r) => {
      resolveConnected = r
    })

    browserWorker.use(
      sse("/events", ({ client: c }) => {
        client = c
        resolveConnected?.()
      }),
    )

    return {
      emit(event: RunEvent) {
        if (!client) {
          throw new Error(
            "SSE client not connected — call waitForConnection() or use the dashboardPage fixture first",
          )
        }
        client.send({
          event: event.type,
          data: JSON.stringify(event),
        })
      },
      emitHeartbeat() {
        if (!client) {
          throw new Error(
            "SSE client not connected — call waitForConnection() first",
          )
        }
        client.send({ event: "heartbeat", data: "" })
      },
      async waitForConnection() {
        await connected
      },
    }
  })
  .extend("dashboardPage", async ({ sseStream }) => {
    return {
      async mount() {
        await render(
          <Providers>
            <App />
          </Providers>,
        )
        await sseStream.waitForConnection()
        return dashboardPageObject(page)
      },
    }
  })

export { expect } from "vitest"
