import { useEffect, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunDetailFromApi } from "./api.ts";
import type { Run, RunEvent } from "./types.ts";

export function useEventStream(url: string) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      // Update run status in the runs list cache
      switch (event.type) {
        case "run:started":
          queryClient.setQueryData<Run[]>(["runs"], (prev = []) => {
            const newRun: Run = {
              id: event.runId,
              agentName: event.agentName,
              status: "running",
              startedAt: event.createdAt,
            };
            const idx = prev.findIndex((r) => r.id === event.runId);
            if (idx >= 0) {
              const runs = [...prev];
              runs[idx] = newRun;
              return runs;
            }
            return [...prev, newRun];
          });
          break;
        case "run:completed":
        case "run:failed":
          queryClient.setQueryData<Run[]>(["runs"], (prev = []) => {
            const idx = prev.findIndex((r) => r.id === event.runId);
            if (idx < 0) return prev;
            const runs = [...prev];
            runs[idx] = {
              ...runs[idx],
              status: event.type === "run:completed" ? "completed" : "failed",
              completedAt: event.createdAt,
              error: event.data.error as string | undefined,
              durationMs: event.data.durationMs as number | undefined,
            };
            return runs;
          });
          break;
      }

      // Append every event to the run detail cache (if open)
      queryClient.setQueryData<RunDetailFromApi>(
        ["runs", event.runId],
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            events: [
              ...prev.events,
              {
                id: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                runId: event.runId,
                type: event.type,
                data: event.data,
                createdAt: event.createdAt,
              },
            ],
          };
        },
      );
    },
    [queryClient],
  );

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function connect() {
      while (!cancelled) {
        try {
          const response = await fetch(url, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            throw new Error(`SSE connection failed: ${response.status}`);
          }

          setConnected(true);

          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += value;

            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              let eventType = "message";
              let data = "";

              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                  data = line.slice(5).trim();
                }
              }

              if (eventType === "heartbeat") {
                setConnected(true);
                continue;
              }

              if (data) {
                handleEvent(JSON.parse(data));
              }
            }
          }
        } catch {
          if (cancelled) return;
          setConnected(false);
        }

        if (!cancelled) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, handleEvent]);

  return { connected };
}
