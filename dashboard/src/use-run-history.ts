import { useState, useEffect, useCallback } from "react";
import type { Run } from "./types.ts";

type RunFromApi = {
  id: string;
  agentName: string;
  status: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
};

function mapApiRun(r: RunFromApi): Run {
  return {
    id: r.id,
    agentName: r.agentName,
    status: r.status as Run["status"],
    error: r.error ?? undefined,
    startedAt: r.startedAt,
    completedAt: r.completedAt ?? undefined,
    durationMs: r.durationMs ?? undefined,
  };
}

export function useRunHistory() {
  const [history, setHistory] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/runs");
      const data: RunFromApi[] = await res.json();
      setHistory(data.map(mapApiRun));
    } catch {
      // Silently fail — dashboard is observational
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { history, loading, refresh };
}
