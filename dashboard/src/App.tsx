import { useMemo, useState } from "react";
import { useEventStream } from "./use-event-stream.ts";
import { useRunHistory } from "./use-run-history.ts";
import { AgentFeed } from "./AgentFeed.tsx";
import { RunDetails } from "./RunDetails.tsx";
import type { Run } from "./types.ts";

export function App() {
  const { connected } = useEventStream("/events");
  const { data: runs = [] } = useRunHistory();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const sortedAgents = useMemo(() => {
    const agentRuns = new Map<string, Run[]>();
    for (const run of runs) {
      const existing = agentRuns.get(run.agentName) ?? [];
      existing.push(run);
      agentRuns.set(run.agentName, existing);
    }

    return Array.from(agentRuns.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, agentRunList]) => ({
        name,
        runs: agentRunList.sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        ),
      }));
  }, [runs]);

  const selectedRun = selectedRunId
    ? runs.find((r) => r.id === selectedRunId)
    : null;

  return (
    <div className="min-h-screen bg-surface-0 text-text-primary">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agent Dashboard</h1>
        <div role="status" className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-connected" : "bg-disconnected"}`}
          />
          <span className="text-text-secondary">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {selectedRun ? (
          <RunDetails
            run={selectedRun}
            onBack={() => setSelectedRunId(null)}
          />
        ) : sortedAgents.length === 0 ? (
          <p className="text-text-muted text-center py-12">
            No agent activity yet. Waiting for events...
          </p>
        ) : (
          <div className="space-y-6">
            {sortedAgents.map((agent) => (
              <AgentFeed
                key={agent.name}
                name={agent.name}
                runs={agent.runs}
                onSelectRun={setSelectedRunId}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
