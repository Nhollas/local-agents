import { useEffect, useRef, useCallback, useState } from "react";
import type { Run, RunEvent } from "./types.ts";

export function useEventStream(url: string) {
  const [runs, setRuns] = useState<Map<string, Run>>(new Map());
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const handleEvent = useCallback((event: RunEvent) => {
    setRuns((prev) => {
      const next = new Map(prev);

      switch (event.type) {
        case "run:started":
          next.set(event.runId, {
            id: event.runId,
            agentName: event.agentName,
            status: "running",
            startedAt: event.createdAt,
          });
          break;

        case "run:completed":
          {
            const existing = next.get(event.runId);
            if (existing) {
              next.set(event.runId, {
                ...existing,
                status: "completed",
                completedAt: event.createdAt,
                durationMs: event.data.durationMs as number | undefined,
              });
            }
          }
          break;

        case "run:failed":
          {
            const existing = next.get(event.runId);
            if (existing) {
              next.set(event.runId, {
                ...existing,
                status: "failed",
                completedAt: event.createdAt,
                error: event.data.error as string | undefined,
                durationMs: event.data.durationMs as number | undefined,
              });
            }
          }
          break;
      }

      return next;
    });
  }, []);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("run:started", (e) => {
      handleEvent(JSON.parse(e.data));
    });
    es.addEventListener("run:completed", (e) => {
      handleEvent(JSON.parse(e.data));
    });
    es.addEventListener("run:failed", (e) => {
      handleEvent(JSON.parse(e.data));
    });
    es.addEventListener("run:output", (e) => {
      handleEvent(JSON.parse(e.data));
    });

    es.addEventListener("heartbeat", () => {
      setConnected(true);
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url, handleEvent]);

  return { runs, connected };
}
