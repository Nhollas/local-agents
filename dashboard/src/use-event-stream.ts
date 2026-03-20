import { useEffect, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Run, RunEvent } from "./types.ts";

export function useEventStream(url: string) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      queryClient.setQueryData<Run[]>(["runs"], (prev = []) => {
        const runs = [...prev];
        const idx = runs.findIndex((r) => r.id === event.runId);

        switch (event.type) {
          case "run:started": {
            const newRun: Run = {
              id: event.runId,
              agentName: event.agentName,
              status: "running",
              startedAt: event.createdAt,
            };
            if (idx >= 0) {
              runs[idx] = newRun;
            } else {
              runs.push(newRun);
            }
            break;
          }
          case "run:completed": {
            if (idx >= 0) {
              runs[idx] = {
                ...runs[idx],
                status: "completed",
                completedAt: event.createdAt,
                durationMs: event.data.durationMs as number | undefined,
              };
            }
            break;
          }
          case "run:failed": {
            if (idx >= 0) {
              runs[idx] = {
                ...runs[idx],
                status: "failed",
                completedAt: event.createdAt,
                error: event.data.error as string | undefined,
                durationMs: event.data.durationMs as number | undefined,
              };
            }
            break;
          }
        }

        return runs;
      });
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
